/**
 * 出网闸：把 `host.net.fetch` 变成插件**唯一**顺手能走的出网通道。
 *
 * ## 为什么需要它
 *
 * Node 的权限模型（`--permission`）覆盖文件系统、子进程、worker、原生插件，
 * **唯独不管网络**。所以沙箱把「插件能读到什么」从整个主目录缩到了一个工作区，
 * 却没有堵住外发通道——它照样可以把读到的东西发出去。
 * 那道墙缺的就是这一面。
 *
 * ## 说清楚这道闸是什么、不是什么
 *
 * 它是**进程内的拆除**，不是内核边界。准确的说法是
 * **「把顺手联网变成了必须刻意绕」**，不是「插件绝对上不了网」。
 * 真正的边界要 OS 级（Windows AppContainer / Linux netns 或 seccomp）。
 *
 * 而且有一条**定义上**的缺口：拿到 `process:exec` 权限的插件能起子进程，
 * 能起子进程就能跑 `curl`。授予执行权就是授予「做任何本机能做的事」。
 * 所以 `netGuarded` 在 `process:exec` 存在时**如实报 false**——
 * 报 true 会让权限清单看起来比实际严，那正是这个项目已经犯过一次的错。
 *
 * ## 实测出来的四条约束（Node 24 + `--permission`）
 *
 * 1. **必须用同步的 `module.registerHooks()`，不能用 `module.register()`。**
 *    后者要起 worker，而 `--allow-worker` 恰恰是我们不给的旗子——给了它，
 *    插件可以在 worker 里绕开整个权限模型。实测 `register()` 直接
 *    `ERR_ACCESS_DENIED: WorkerThreads`。
 * 2. **`node:module` 必须一起挡。** `registerHooks` 后注册的先执行，
 *    插件可以注册一个 `shortCircuit: true` 的 resolve 直接返回 `node:net`，
 *    我们的钩子根本不会被调到。而 ESM 命名空间的属性**不能重定义**
 *    （`Cannot redefine property`），封不住 `registerHooks` 本身。
 * 3. **引导脚本要放在沙箱读得到的地方**，并给对应的 `--allow-fs-read`，
 *    否则 `--import` 那一步因权限被拒，插件直接起不来。
 * 4. **bun 上做不了**：它没有 `module.registerHooks`。所以 `netGuarded`
 *    必须与 `sandboxed` 分开如实上报，不能合并成一个「有沙箱」。
 *
 * ## 实测挡住的路径
 *
 * | 出网路径 | 手段 |
 * |---|---|
 * | `require('net')` 等 | 同步 resolve 钩子 |
 * | `import 'node:net'` 等 | 同一个钩子（同时覆盖 ESM 与 CJS） |
 * | `globalThis.fetch` / `WebSocket` / `EventSource` | 删掉 |
 * | `process.binding('tcp_wrap')` | `--permission` 自己就挡了 |
 * | `process.getBuiltinModule('node:net')` | 绕过模块加载器，单独覆盖 |
 * | 插件自己 `registerHooks` 短路掉我们的 | 把 `node:module` 一并列入黑名单 |
 * | `data:` URL 里再 import | 内层 import 仍走 resolve |
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 挡掉的模块。
 *
 * ## 只管网络，不重复权限模型已经管的事
 *
 * `child_process` 和 `worker_threads` **刻意不在这张表里**。它们由
 * `--permission` 管：没声明 `process:exec` 就拿不到 `--allow-child-process`，
 * 而 `--allow-worker` 我们从不给。把它们也写进这里的话，
 * 一个**被明确授予** `process:exec` 的插件会拿到 `--allow-child-process` 旗子、
 * 却在模块层被挡掉——两套机制对同一件事给出相反的答案，
 * 那种自相矛盾比缺一层防护更难查。
 *
 * `inspector` 在表里是因为它**真的会开端口**，那是一条网络通道。
 *
 * `node:module` 在表里**不是**因为它能联网，是因为不挡它，
 * 插件可以自己注册一个短路钩子把上面所有条目全部放行（约束 2）。
 * 这一条最容易在「精简黑名单」时被顺手删掉，所以单独说明。
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
 * 写成一个字符串常量而不是单独的 .ts 文件：发布产物是**单文件二进制**，
 * 里面没有可供 `--import` 的磁盘路径。同一类坑在插件运行时解析上踩过一次
 * （`process.execPath` 在二进制里是 qy 自己），见 `runtime.ts` 头注释。
 *
 * 脚本本身必须是纯 CommonJS 且不 import 任何东西——它跑在权限模型下，
 * 多一个依赖就多一条可能被拒的读路径。
 */
export function netGuardSource(): string {
  const blocked = JSON.stringify(BLOCKED_MODULES)
  return `'use strict'
// qywork 出网闸。由宿主生成，随插件进程启动注入。
const BLOCKED = new Set(${blocked})

function bare(spec) {
  if (typeof spec !== 'string') return null
  const s = spec.startsWith('node:') ? spec.slice(5) : spec
  return BLOCKED.has(s) ? s : null
}

function deny(name) {
  const e = new Error(
    '[qywork] 插件不能直接使用 ' + name + '：出网请用 host.net.fetch（它过 SSRF 与权限校验）'
  )
  e.code = 'ERR_QYWORK_NET_BLOCKED'
  return e
}

// 1) 模块加载器。同步钩子，同时覆盖 ESM 与 CJS。
//    用 registerHooks 而不是 register：后者要起 worker，而 --allow-worker 不给。
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

// 3) 全局出网 API。删掉而不是改写——留一个能被 delete 恢复的桩没有意义。
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'navigator']) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      get() {
        throw deny(name)
      },
    })
  } catch {
    // 某些运行时上这些属性不可重定义。删不掉就退一步删引用；
    // 两条都失败也不要让插件起不来——挡不住要如实体现在上报里，
    // 而不是让一个装好的插件突然打不开。
    try {
      delete globalThis[name]
    } catch {}
  }
}
`
}

/** 引导脚本的落盘位置。放临时目录，不污染工作区也不污染插件目录。 */
export function netGuardDir(): string {
  return join(tmpdir(), 'qywork-netguard')
}

export function netGuardPath(): string {
  return join(netGuardDir(), 'netguard.cjs')
}

/**
 * 把引导脚本写到磁盘，返回路径。
 *
 * 每次启动都重写：内容随版本变，留一份旧的在那儿会让「升级了但闸没变」
 * 这种问题极难发现。写失败**返回 null 而不是抛**——出网闸装不上是
 * 「少一层防护」，不该升级成「插件起不来」。
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
 * 这个 node 版本能不能装出网闸。
 *
 * `module.registerHooks` 是 Node 22.15 / 23.5 才有的。版本不够时
 * **不要装个半截的闸**——只删全局 fetch 而模块照样能 require，
 * 那比不装更糟：上报说「已拦截」，实际一 `require('net')` 就出去了。
 */
export function supportsNetGuard(major: number, minor: number): boolean {
  if (major >= 24) return true
  if (major === 23) return minor >= 5
  if (major === 22) return minor >= 15
  return false
}
