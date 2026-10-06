/**
 * 插件的运行进程选择，以及能否对其强制隔离。
 *
 * 不能默认使用 `process.execPath`：开发时它是 `bun`，运行正常；发布产物是 Bun 编译的
 * 单文件二进制，此时 `process.execPath` 是 `qy.exe` 本身，运行 `qy <插件入口>` 只输出
 * 「未知命令」与用法说明，插件启动即退出。
 *
 * 该失效使安装发布包的用户机器上所有插件都无法启动，且只存在于发布产物中，
 * 在开发机上无论如何测试都无法发现。
 *
 * 因此运行时必须显式解析：配置指定 > PATH 上的 node > PATH 上的 bun >
 * 宿主自身（仅当它是 JS 运行时）。均不满足时明确报错，
 * 不要交给不能执行 JS 的可执行文件尝试。
 *
 * 沙箱按实际能力上报。Node 的权限模型（`--permission`，20/22 上为
 * `--experimental-permission`）可限制文件系统、子进程、worker 与原生插件。实测：
 *
 * | 能力 | `--permission --allow-fs-read=<工作区>` 之后 |
 * |---|---|
 * | 读工作区 | 允许（递归） |
 * | 读用户主目录 | 拒绝 |
 * | 写任何位置 | 拒绝（除非另外授予 --allow-fs-write） |
 * | child_process | 拒绝（除非另外授予 --allow-child-process） |
 * | 网络 | 权限模型不覆盖，由网络访问限制另行拦截（见 `netguard.ts`） |
 *
 * 网络访问限制由 `netguard.ts` 单独提供，但它是进程内的移除而不是内核边界，
 * 且能否安装取决于 node 版本，因此 `netGuarded` 与 `sandboxed`
 * 分开上报，不合并为一个含义模糊的「有沙箱」。
 *
 * bun 没有等价的权限模型，也没有 `module.registerHooks`，
 * 因此用 bun 运行插件时两者均不具备，须如实上报。
 */

import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PluginPermission } from './manifest.ts'
import { ensureNetGuardScript, netGuardDir, supportsNetGuard } from './netguard.ts'

export interface PluginRuntime {
  command: string
  /** 沙箱参数，位于插件入口之前。为空表示没有强制隔离。 */
  args: string[]
  /** 强制隔离是否实际生效。必须如实上报：含糊的上报比不上报更糟。 */
  sandboxed: boolean
  /**
   * 网络访问限制是否已安装，且未因 `process:exec` 而失效。
   *
   * 必须与 `sandboxed` 分开：两者的成立条件不同（版本要求不同，
   * bun 上两者均不具备），合并为一个布尔值会使「有沙箱」在不同机器上含义不同。
   */
  netGuarded: boolean
  /** 没有沙箱时的原因，或沙箱的已知缺口。供日志与界面使用。 */
  note: string
}

export interface RuntimeRequest {
  /** 用户显式指定的运行时可执行文件。指定后直接使用，不再推测。 */
  override?: string
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
  // 1. 用户指定的运行时优先。已指定仍推测等于忽略配置。
  if (req.override) {
    return {
      command: req.override,
      args: [],
      sandboxed: false,
      netGuarded: false,
      note: '使用指定的运行时，未启用强制隔离',
    }
  }

  // 2. node：唯一能提供强制隔离的运行时。
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

  // 3. bun：可以运行，但没有权限模型，也没有 module.registerHooks。
  const bun = which('bun')
  if (bun) {
    return {
      command: bun,
      args: [],
      sandboxed: false,
      netGuarded: false,
      note: 'bun 既没有权限模型，也没有网络访问限制所需的 module.registerHooks；安装 node 22.15 以上版本可同时具备两者',
    }
  }

  // 4. 宿主自身，仅当它是 JS 运行时。
  //    编译后的单文件二进制中 execPath 是 qy 本身，用它运行插件只会输出用法说明。
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
    '未找到可用的 JS 运行时（需要 PATH 中存在 node 或 bun）。插件运行在独立进程中，宿主自身的二进制不能作为运行时。',
  )
}
