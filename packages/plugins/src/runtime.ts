/**
 * 插件的运行进程选择，以及对其强制隔离。
 *
 * 插件只由 node 20 以上运行：只有 Node 的权限模型（`--permission`，20/22 上为
 * `--experimental-permission`）能限制插件进程的文件系统、子进程、worker 与原生插件。
 * PATH 中没有 node 或版本低于 20 时报错，插件不加载。不要加回 bun 或宿主自身作为备选：
 * 两者没有权限模型，用它们运行等于插件不受隔离，而 auto 下模型可以自行安装插件。
 *
 * 不能使用 `process.execPath`：发布产物是 Bun 编译的单文件二进制，该路径是 `qy.exe` 本身，
 * 运行 `qy <插件入口>` 只输出「未知命令」与用法说明。
 *
 * 实测：
 *
 * | 能力 | `--permission --allow-fs-read=<工作区>` 之后 |
 * |---|---|
 * | 读工作区 | 允许（递归） |
 * | 读用户主目录 | 拒绝 |
 * | 写任何位置 | 拒绝（除非另外授予 --allow-fs-write） |
 * | child_process | 拒绝（除非另外授予 --allow-child-process） |
 * | 网络 | 权限模型不覆盖，由网络访问限制另行拦截（见 `netguard.ts`） |
 *
 * 网络访问限制是进程内的移除而不是内核边界，且需要 node 22.15 / 23.5 以上，
 * 因此 `netGuarded` 单独上报。
 */

import { pathToFileURL } from 'node:url'
import type { PluginPermission } from './manifest.ts'
import { ensureNetGuardScript, netGuardDir, supportsNetGuard } from './netguard.ts'

export interface PluginRuntime {
  command: string
  /** 权限模型参数，位于插件入口之前。 */
  args: string[]
  /**
   * 网络访问限制是否已安装，且未因 `process:exec` 而失效。
   * 它的版本要求高于权限模型，因此 node 20–22.14 上文件系统已隔离而网络未限制。
   */
  netGuarded: boolean
  /** 隔离的已知缺口。供日志与界面使用。 */
  note: string
}

export interface RuntimeRequest {
  workspaceRoot: string
  pluginDir: string
  permissions: PluginPermission[]
}

/** `node --version` 只探测一次：每个插件各探测一次会额外耗费数十毫秒。 */
let nodeProbe: { path: string; major: number; minor: number } | null | undefined

function which(cmd: string): string | null {
  // Bun.which 在编译后的单文件二进制中同样可用。
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
    // 必须同时读取次版本号：`module.registerHooks` 自 22.15 / 23.5 起提供，
    // 只看主版本会在 22.0 上安装不完整的网络访问限制，比不安装更糟。
    const m = /^v(\d+)\.(\d+)/.exec(out)
    nodeProbe = { path, major: Number(m?.[1] ?? 0), minor: Number(m?.[2] ?? 0) }
  } catch {
    nodeProbe = null
  }
  return nodeProbe
}

/** 权限标志名在 Node 23 有变化。使用与版本不符的标志会使进程无法启动。 */
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
  // 插件必须能读取自身目录，否则无法加载入口文件。
  // 这是运行的前提，不属于权限。
  args.push(`--allow-fs-read=${req.pluginDir}`)

  const has = (p: PluginPermission) => req.permissions.includes(p)
  if (has('workspace:read')) args.push(`--allow-fs-read=${req.workspaceRoot}`)
  if (has('workspace:write')) args.push(`--allow-fs-write=${req.workspaceRoot}`)
  if (has('process:exec')) args.push('--allow-child-process')

  // 有意不授予 --allow-worker 与 --allow-addons：
  // 两者都能绕过权限模型本身（worker 可另起一套运行环境，原生插件可直接发起系统调用），
  // 而插件没有正当理由需要它们。
  //
  // 网络不在权限模型的覆盖范围内，由网络访问限制另行拦截。

  // ── 网络访问限制 ──
  //
  // 安装需要两个条件：node 版本满足（`module.registerHooks`），
  // 且引导脚本可以写入。任一条件不满足时不安装：不完整的网络访问限制
  // （只删除全局 fetch 而模块仍可 require）比不安装更糟：
  // 上报为「已拦截」，实际调用 `require('net')` 即可联网。
  const versionOk = supportsNetGuard(major, minor)
  const guardPath = versionOk ? ensureNetGuardScript() : null
  let netGuarded = false
  if (guardPath) {
    // 引导脚本同样受权限模型约束，其所在目录必须单独放行，
    // 否则 `--import` 因权限被拒绝，插件无法启动。
    //
    // 路径必须转为 `file://` URL：Windows 上 `--import` 不接受裸盘符路径，
    // 报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'c:'`，
    // 即把 `C:` 当作协议名。类 Unix 系统接受绝对路径，因此该错误
    // 只出现在 Windows 上，现象是插件启动即退出，
    // 与网络访问限制没有可见的关联。
    args.push(`--allow-fs-read=${netGuardDir()}`, '--import', pathToFileURL(guardPath).href)
    netGuarded = true
  }

  // `process:exec` 等价于开放网络：能启动子进程即可运行 curl。
  // 这是定义而不是漏洞：授予执行权即授予本机的全部操作能力。
  // 因此此时 `netGuarded` 上报 false，不能因限制脚本已注入就上报已拦截。
  const execEscape = has('process:exec')
  if (execEscape) netGuarded = false

  const note = !versionOk
    ? `文件系统与子进程已强制隔离；网络访问限制需要 node 22.15 / 23.5 以上（当前 ${major}.${minor}），未启用`
    : !guardPath
      ? '文件系统与子进程已强制隔离；网络访问限制的引导脚本写入失败，未启用'
      : execEscape
        ? '文件系统与子进程已强制隔离；网络访问限制已注入，但插件持有 process:exec，可经由子进程访问网络，不视为已拦截'
        : '文件系统与子进程已强制隔离；直接网络访问已移除，只能经由 host.net.fetch 访问网络'

  return { args, note, netGuarded }
}

export function resolvePluginRuntime(req: RuntimeRequest): PluginRuntime {
  const node = probeNode()
  if (!node) throw new Error('插件需要 node 20 以上版本，PATH 中未找到 node。')
  const sandbox = sandboxArgs(node.major, req, node.minor)
  if (!sandbox) {
    throw new Error(`插件需要 node 20 以上版本，当前为 ${node.major}.${node.minor}。`)
  }
  return {
    command: node.path,
    args: sandbox.args,
    netGuarded: sandbox.netGuarded,
    note: sandbox.note,
  }
}
