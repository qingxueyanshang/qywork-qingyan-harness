/**
 * 网络访问限制：使 `host.net.fetch` 成为插件进程内唯一无需绕过即可使用的网络通道。
 *
 * Node 的权限模型（`--permission`）覆盖文件系统、子进程、worker 与原生插件，不覆盖网络。
 * 沙箱把插件可读取的范围从主目录收窄到工作区，但没有封闭外发通道：插件仍可把读取的内容发送出去。
 * 本模块补充的是这一层。
 *
 * 本限制在进程内移除网络 API，不是内核边界：联网从默认可用变为必须主动绕过，
 * 不保证插件无法联网。内核级边界需要操作系统支持（Windows AppContainer / Linux netns 或 seccomp）。
 *
 * 存在一处定义上的缺口：取得 `process:exec` 权限的插件能启动子进程，
 * 进而运行 `curl`。授予执行权即授予本机的全部操作能力。
 * 因此存在 `process:exec` 时 `netGuarded` 上报 false；上报 true 会使权限清单显得比实际严格。
 *
 * 实测约束（Node 24 + `--permission`）：
 * 1. 必须使用同步的 `module.registerHooks()`，不能使用 `module.register()`。
 *    后者需要启动 worker，而 `--allow-worker` 一律不授予：授予后
 *    插件可在 worker 中绕过整个权限模型。实测 `register()` 直接报
 *    `ERR_ACCESS_DENIED: WorkerThreads`。
 * 2. `node:module` 必须一并拦截。`registerHooks` 后注册的钩子先执行，
 *    插件可注册一个 `shortCircuit: true` 的 resolve 直接返回 `node:net`，
 *    本文件的钩子不会被调用。ESM 命名空间的属性不可重定义
 *    （`Cannot redefine property`），无法封闭 `registerHooks` 本身。
 * 3. 引导脚本必须放在沙箱可读取的位置，并授予对应的 `--allow-fs-read`，
 *    否则 `--import` 因权限被拒绝，插件无法启动。
 * 4. bun 上无法实现：bun 没有 `module.registerHooks`。因此 `netGuarded`
 *    必须与 `sandboxed` 分开上报，不能合并为一个「有沙箱」。
 *
 * 实测已拦截的路径：
 * | 网络访问路径 | 手段 |
 * |---|---|
 * | `require('net')` 等 | 同步 resolve 钩子 |
 * | `import 'node:net'` 等 | 同一个钩子（同时覆盖 ESM 与 CJS） |
 * | `globalThis.fetch` / `WebSocket` / `EventSource` | 移除 |
 * | `process.binding('tcp_wrap')` | 由 `--permission` 拦截 |
 * | `process.getBuiltinModule('node:net')` | 绕过模块加载器，单独覆盖 |
 * | 插件自行调用 `registerHooks` 短路本文件的钩子 | 把 `node:module` 一并列入黑名单 |
 * | `data:` URL 中的嵌套 import | 内层 import 仍经由 resolve |
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 拦截的模块。
 *
 * 只限制网络，不重复权限模型已覆盖的范围。`child_process` 与 `worker_threads` 有意不列入：
 * 它们由 `--permission` 管理，未声明 `process:exec` 就无法取得 `--allow-child-process`，
 * `--allow-worker` 一律不授予。若列入，被明确授予 `process:exec` 的插件会取得
 * `--allow-child-process` 参数，却在模块层被拒绝：两套机制对同一件事给出相反结论，
 * 比缺少一层防护更难排查。
 *
 * `inspector` 列入是因为它会打开端口，构成一条网络通道。
 *
 * `node:module` 列入不是因为它能联网，而是因为不拦截它时，
 * 插件可以注册短路钩子放行以上全部条目（约束 2）。精简黑名单时不要删除这一条。
 */
export const BLOCKED_MODULES = [
  'net',
  'tls',
  'http',
  'https',
  'http2',
  'dgram',
  'dns',
  'dns/promises',
  'inspector',
  'inspector/promises',
  'module',
] as const

/**
 * 引导脚本源码。
 *
 * 写成字符串常量而不是单独的 .ts 文件：发布产物是单文件二进制，
 * 其中没有可供 `--import` 使用的磁盘路径。插件运行时解析有同类约束
 * （`process.execPath` 在二进制中指向 qy 自身），见 `runtime.ts` 头注释。
 *
 * 脚本必须是纯 CommonJS 且不 import 任何模块：它运行在权限模型下，
 * 每多一个依赖就多一条可能被拒绝的读取路径。
 */
export function netGuardSource(): string {
  const blocked = JSON.stringify(BLOCKED_MODULES)
  return `'use strict'
// qywork 网络访问限制。由宿主生成，在插件进程启动时注入。
const BLOCKED = new Set(${blocked})

function bare(spec) {
  if (typeof spec !== 'string') return null
  const s = spec.startsWith('node:') ? spec.slice(5) : spec
  return BLOCKED.has(s) ? s : null
}

function deny(name) {
  const e = new Error(
    '[qywork] 插件不能直接使用 ' + name + '：网络访问请使用 host.net.fetch（经过 SSRF 防护与权限校验）'
  )
  e.code = 'ERR_QYWORK_NET_BLOCKED'
  return e
}

// 1) 模块加载器。同步钩子，同时覆盖 ESM 与 CJS。
//    使用 registerHooks 而不是 register：后者需要启动 worker，而 --allow-worker 不授予。
const mod = process.getBuiltinModule
  ? process.getBuiltinModule('node:module')
  : require('node:module')

if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({
    resolve(spec, ctx, next) {
      const hit = bare(spec)
      if (hit) throw deny(hit)
      return next(spec, ctx)
    },
  })
}

// 2) process.getBuiltinModule 绕过模块加载器，必须单独覆盖。
if (typeof process.getBuiltinModule === 'function') {
  const orig = process.getBuiltinModule.bind(process)
  Object.defineProperty(process, 'getBuiltinModule', {
    configurable: false,
    writable: false,
    value: (spec) => {
      const hit = bare(spec)
      if (hit) throw deny(hit)
      return orig(spec)
    },
  })
}

// 3) 全局网络 API。移除而不是改写：可被 delete 恢复的桩不起拦截作用。
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'navigator']) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      get() {
        throw deny(name)
      },
    })
  } catch {
    // 部分运行时上这些属性不可重定义，此时改用 delete 删除。
    // 两种方式都失败时也不要阻止插件启动：拦截失败应如实体现在上报中，
    // 不应使已安装的插件无法打开。
    try {
      delete globalThis[name]
    } catch {}
  }
}
`
}

/** 引导脚本的落盘位置：临时目录，不写入工作区与插件目录。 */
export function netGuardDir(): string {
  return join(tmpdir(), 'qywork-netguard')
}

export function netGuardPath(): string {
  return join(netGuardDir(), 'netguard.cjs')
}

/**
 * 把引导脚本写入磁盘，返回路径。
 *
 * 每次启动都重写：脚本内容随版本变化，保留旧版本的脚本会使「已升级但网络访问限制未更新」
 * 这类问题难以发现。写入失败时返回 null 而不是抛错：网络访问限制无法安装只意味着
 * 少一层防护，不应升级为插件无法启动。
 */
export function ensureNetGuardScript(): string | null {
  try {
    mkdirSync(netGuardDir(), { recursive: true })
    const path = netGuardPath()
    writeFileSync(path, netGuardSource(), 'utf8')
    return path
  } catch {
    return null
  }
}

/**
 * 当前 node 版本能否安装网络访问限制。
 *
 * `module.registerHooks` 自 Node 22.15 / 23.5 起提供。版本不足时
 * 不要安装不完整的网络访问限制：只删除全局 fetch 而模块仍可 require，
 * 比不安装更糟：上报为「已拦截」，实际调用 `require('net')` 即可联网。
 */
export function supportsNetGuard(major: number, minor: number): boolean {
  if (major >= 24) return true
  if (major === 23) return minor >= 5
  if (major === 22) return minor >= 15
  return false
}
