/**
 * 用什么进程跑插件，以及能不能真的把它关起来。
 *
 * **为什么不能用 `process.execPath`。** 之前插件宿主默认拿 `process.execPath` 当运行时。开发时那是
 * `bun`，一切正常；**而发布产物是 Bun 编译出来的单文件二进制，`process.execPath` 就是 `qy.exe` 本
 * 身**。拿它去跑 `qy <插件入口>` 的结果是「未知命令」+ 用法说明，插件启动即退出。
 *
 * 后果是：插件在开发机上正常，装了包的用户那里**一个都起不来**，
 * 而这条路径在本机怎么测都测不出来。和「打包之后工作区落在 Program Files」
 * 是同一类：只在真实产物里才存在的失效。
 *
 * 所以运行时必须显式解析：配置指定 > PATH 上的 node > PATH 上的 bun >
 * 宿主自己（仅当它确实是个 JS 运行时）。都没有就明确报错，
 * 不要交给一个不会执行 JS 的可执行文件去试。
 *
 * **沙箱：能做到多少就说多少。** Node 的权限模型（`--permission`，20/22 上叫
 * `--experimental-permission`）能把文件系统、子进程、worker、原生插件关起来。实测：
 *
 * | 能力 | `--permission --allow-fs-read=<工作区>` 之后 |
 * |---|---|
 * | 读工作区 | 允许（递归） |
 * | 读用户主目录 | **拒绝** |
 * | 写任何位置 | **拒绝**（除非另给 --allow-fs-write） |
 * | child_process | **拒绝**（除非另给 --allow-child-process） |
 * | **网络** | **权限模型不管，由出网闸另外挡**（见 `netguard.ts`） |
 *
 * 网络那一面由 `netguard.ts` 单独补，但它是**进程内的拆除不是内核边界**，
 * 而且能不能装上取决于 node 版本——所以 `netGuarded` 与 `sandboxed`
 * **分开上报**，不合并成一个含糊的「有沙箱」。
 *
 * bun 没有等价的权限模型，也没有 `module.registerHooks`，
 * 所以用 bun 跑插件时两样都没有——这件事要如实报出来。
 */

import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginPermission } from './manifest.ts'
import { ensureNetGuardScript, netGuardDir, supportsNetGuard } from './netguard.ts'

export interface PluginRuntime {
  command: string
  /** 沙箱参数，插件入口之前。空 = 没有强制隔离。 */
  args: string[]
  /** 强制隔离是否真的生效。**如实报**，含糊比没有更糟。 */
  sandboxed: boolean
  /**
   * 出网闸是否真的装上了，**且**没有被 `process:exec` 架空。
   *
   * 与 `sandboxed` 分开是必须的：两者的成立条件不同（版本要求不同、
   * bun 上一个都没有），合并成一个布尔值会让「有沙箱」在不同机器上
   * 含义不一样——那正是这个项目在插件隔离上已经犯过一次的错。
   */
  netGuarded: boolean
  /** 没沙箱时的原因，或沙箱的已知缺口。给日志和 UI 用。 */
  note: string
}

export interface RuntimeRequest {
  /** 用户显式指定的运行时可执行文件。指定了就用它，不再猜。 */
  override?: string
  workspaceRoot: string
  pluginDir: string
  permissions: PluginPermission[]
}

/** `node --version` 的结果只探一次：每个插件探一遍是白花几十毫秒。 */
let nodeProbe: { path: string; major: number; minor: number } | null | undefined

function which(cmd: string): string | null {
  // Bun.which 在编译出的单文件二进制里同样可用。
  const found = (globalThis as { Bun?: { which(c: string): string | null } }).Bun?.which(cmd)
  return found ?? null
}

function probeNode(): { path: string; major: number; minor: number } | null {
  if (nodeProbe !== undefined) return nodeProbe
  const path = which('node')
  if (!path) {
    nodeProbe = null
    return null
  }
  try {
    const out = Bun.spawnSync([path, '--version']).stdout.toString().trim()
    // 次版本号也要取：`module.registerHooks` 是 22.15 / 23.5 才有的，
    // 只看主版本会在 22.0 上装一个半截的出网闸——那比不装更糟。
    const m = /^v(\d+)\.(\d+)/.exec(out)
    nodeProbe = { path, major: Number(m?.[1] ?? 0), minor: Number(m?.[2] ?? 0) }
  } catch {
    nodeProbe = null
  }
  return nodeProbe
}

/** 仅供测试重置探测缓存。 */
export function resetRuntimeProbe(): void {
  nodeProbe = undefined
}

/** 权限标志的旗名在 Node 23 改过。给错版本的旗子会让进程直接起不来。 */
function permissionFlag(major: number): string | null {
  if (major >= 23) return '--permission'
  if (major >= 20) return '--experimental-permission'
  return null
}

export function sandboxArgs(
  major: number,
  req: RuntimeRequest,
  minor = 0,
): { args: string[]; note: string; netGuarded: boolean } | null {
  const flag = permissionFlag(major)
  if (!flag) return null

  const args = [flag]
  // 插件必须能读自己的目录，否则连入口文件都加载不了。
  // 这不是「权限」，是运行的前提。
  args.push(`--allow-fs-read=${req.pluginDir}`)

  const has = (p: PluginPermission) => req.permissions.includes(p)
  if (has('workspace:read')) args.push(`--allow-fs-read=${req.workspaceRoot}`)
  if (has('workspace:write')) args.push(`--allow-fs-write=${req.workspaceRoot}`)
  if (has('process:exec')) args.push('--allow-child-process')

  // 刻意**不给** --allow-worker 和 --allow-addons：
  // 两者都能绕开权限模型本身（worker 可以另起一套、原生插件直接进内核态调用），
  // 而插件没有任何正当理由需要它们。
  //
  // 网络不在这个模型的覆盖范围内，由出网闸另外挡。

  // ── 出网闸 ──
  //
  // 装它需要两个条件：node 版本够（`module.registerHooks`），
  // 以及引导脚本写得下去。任一不满足就**不装**——装个半截的闸
  // （只删全局 fetch 而模块照样 require）比不装更糟：
  // 上报说「已拦截」，实际一 `require('net')` 就出去了。
  const versionOk = supportsNetGuard(major, minor)
  const guardPath = versionOk ? ensureNetGuardScript() : null
  let netGuarded = false
  if (guardPath) {
    // 引导脚本本身也在权限模型底下，它所在的目录要单独放行，
    // 否则 `--import` 那一步因权限被拒，插件直接起不来。
    //
    // 路径必须转成 `file://` URL：**Windows 上 `--import` 不接受裸盘符路径**，
    // 报的是 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`——
    // 它把 `C:` 当成了协议名。在类 Unix 上传绝对路径能过，所以这条
    // 只在 Windows 上炸，而且炸的表现是「插件启动即退出」，
    // 跟出网闸本身看不出任何关系。
    args.push(`--allow-fs-read=${netGuardDir()}`, '--import', pathToFileURL(guardPath).href)
    netGuarded = true
  }

  // `process:exec` 等价于放开网络：能起子进程就能跑 curl。
  // 这不是漏洞是定义——授予执行权就是授予「做任何本机能做的事」。
  // 所以这时候 `netGuarded` **如实报 false**，不能因为闸装上了就说挡住了。
  const execEscape = has('process:exec')
  if (execEscape) netGuarded = false

  const note = !versionOk
    ? `文件系统与子进程已强制隔离；出网闸需要 node 22.15 / 23.5 以上（当前 ${major}.${minor}），未启用`
    : !guardPath
      ? '文件系统与子进程已强制隔离；出网闸引导脚本写入失败，未启用'
      : execEscape
        ? '文件系统与子进程已强制隔离；出网闸已注入，但插件持有 process:exec —— 起个子进程就能出网，不视为已拦截'
        : '文件系统与子进程已强制隔离；直接出网通道已拆除，出网只能走 host.net.fetch'

  return { args, note, netGuarded }
}

export function resolvePluginRuntime(req: RuntimeRequest): PluginRuntime {
  // 1. 用户指定的最优先。指定了还去猜就等于忽略配置。
  if (req.override) {
    return {
      command: req.override,
      args: [],
      sandboxed: false,
      netGuarded: false,
      note: '使用指定的运行时，未启用强制隔离',
    }
  }

  // 2. node：唯一能提供强制隔离的一个。
  const node = probeNode()
  if (node) {
    const sandbox = sandboxArgs(node.major, req, node.minor)
    if (sandbox) {
      return {
        command: node.path,
        args: sandbox.args,
        sandboxed: true,
        netGuarded: sandbox.netGuarded,
        note: sandbox.note,
      }
    }
    return {
      command: node.path,
      args: [],
      sandboxed: false,
      netGuarded: false,
      note: `node ${node.major} 不支持权限模型（需要 20 以上），未启用强制隔离`,
    }
  }

  // 3. bun：能跑，但没有权限模型，也没有 module.registerHooks。
  const bun = which('bun')
  if (bun) {
    return {
      command: bun,
      args: [],
      sandboxed: false,
      netGuarded: false,
      note: 'bun 既没有权限模型也没有出网闸所需的 module.registerHooks；装一个 node 22.15+ 两样都能有',
    }
  }

  // 4. 宿主自己——**只有它确实是个 JS 运行时时**。
  //    编译后的单文件二进制里 execPath 是 qy 自己，拿它跑插件只会打出用法说明。
  const self = basename(process.execPath).toLowerCase()
  if (self.startsWith('node') || self.startsWith('bun')) {
    return {
      command: process.execPath,
      args: [],
      sandboxed: false,
      netGuarded: false,
      note: '用宿主运行时启动插件，未启用强制隔离',
    }
  }

  throw new Error(
    '找不到可用的 JS 运行时（需要 node 或 bun 在 PATH 上）。插件跑在独立进程里，宿主自身的二进制不能当运行时。',
  )
}
