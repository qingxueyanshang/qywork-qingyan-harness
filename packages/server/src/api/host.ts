/**
 * 宿主机的外部程序依赖：探测是否已安装，并提供一键安装（包管理器与终端见 `host-env/managers.ts`）。
 *
 * 入表条件：代码中存在一处通过 `Bun.spawn` 调用该程序的位置。逐项核对如下：
 *
 * | | 调用点 | 缺失的影响 |
 * |---|---|---|
 * | bash | `tools/process/command-shell.ts` 的 `commandShell()` | 只改变命令语法，回退到 PowerShell；三档均缺失时 `run_command` 不注册 |
 * | git | `server/git.ts` 的 `git()` | 版本面板无法读取状态与差异 |
 * | rg | `tools/search.ts` 的 `runRipgrep()` | 只影响速度，由内置遍历替代 |
 * | node | `plugins/runtime.ts` 的 `probeNode()` | 插件无法运行 |
 * | Python | `tools/office.ts` 启动 worker、`runtime/office.ts` 探测 | Office 工具不注册 |
 * | Office 文档库 | worker 导入 | `office` 工具不注册；按清单用 pip 安装，不经包管理器 |
 * | 视频解码库 | worker 的 `frames` 动作 | 不支持原生视频的模型无法读取视频；使用同一份清单与同一条 pip 安装路径 |
 * | 内置浏览器（macOS、Linux） | 宿主启动的专用 Chromium（`host-env/chromium.ts`） | 网页在单独的浏览器窗口中打开 |
 *
 * 仅属于「安装后更好」或「同类工具一并列出」的程序不入表：这类清单使设置页首次打开时
 * 显示大量红色条目，真正缺失的一项难以辨认。同理 `required` 必须分档：
 * rg 与 node 缺失不影响主要功能，标为「需要安装」属于误报；bash 在本机存在其他 shell 时
 * 同属这一档，其档位随机器变化，见 `resolveBashRow`。
 *
 * 沙箱（bwrap / seatbelt）不在此处：权限页已报告该项，两处报告即形成两本账。
 *
 * 安装路径的三条边界：
 * 1. **参数只用于查表，不进入命令。** 请求体只有一个 `id`，用于在下方常量表中
 *    查询命令；未查到时返回 400。命令串中没有任何字节来自请求；执行用户给出的命令
 *    是另一件事，由 `run_command` 负责并受裁决层约束。
 * 2. **程序交给系统的包管理器。** 签名校验、来源、回滚由包管理器负责（winget、Homebrew、apt 等）；文档库交给 pip，
 *    按产品附带的固定版本清单安装。唯一由本进程下载的是内置浏览器：版本与 SHA-256 写在代码中，校验不一致时不使用，
 *    可信程度与安装包本身相同；它不是用户日常使用的浏览器，包管理器安装的 Chrome 不满足「始终可以安装」的要求。
 * 3. **打开可见的终端窗口，不在后台静默执行。** 提权、下载进度、失败原因都必须对
 *    用户可见；本项目没有 PTY，在管道中执行时安装过程在界面上只显示为一个不会结束的加载状态。
 *    内置浏览器的下载由本进程执行，进度在该行显示。
 *
 * 应用内安装依赖本身是一条额外的执行入口，因用户明确要求而存在；不要在此追加其他软件。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EnvDependency } from '@qywork/core'
import { findPython, type OfficeHost, officeDir, officeVenv, type QyConfig } from '@qywork/runtime'
import type { CommandShell } from '@qywork/tools'
import { commandShell, probeBash } from '@qywork/tools'
import {
  chromiumBuild,
  chromiumInstallState,
  installChromium,
  installedChromium,
} from '../host-env/chromium.ts'
import {
  canOpenTerminal,
  installCommand,
  type Packages,
  terminalArgv,
} from '../host-env/managers.ts'
import { type ApiHandler, json } from './types.ts'

/**
 * 一次探测读取的外部状态：Python 按配置查找（`officePython`、QyWork 的虚拟环境或 PATH），
 * 文档库缺项取自 Office 宿主最近一次探测的结果；`restartBrowser` 在内置浏览器安装完成后请求宿主换用它，
 * 没有浏览器宿主时为 `null`（不提供内置浏览器的安装）。
 */
export interface EnvProbeContext {
  config: QyConfig
  office?: OfficeHost
  restartBrowser?: (() => Promise<void>) | null
}

/**
 * 一条依赖随机器变化的三个字段。
 *
 * `required` 同样在此给出，而不是固定在 `DepSpec` 上：bash 缺失是否属于必需项，
 * 取决于本机是否存在其他 shell（`resolveBashRow`）。其余条目的 `required` 是常量，
 * 也由此处给出：两种写法并存时，读表的人必须先分辨每个条目属于哪一种。
 */
interface DepState {
  /** 找到的可执行文件；`null` 表示未安装。 */
  path: string | null
  /** 缺失时有功能不可用。前端只在 `path` 为 `null` 时读取该字段（标红并显示「需要安装」）。 */
  required: boolean
  /** 未安装时的影响，一句话；已安装时为空串。 */
  hint: string
}

/**
 * 一条依赖的定义。`probe` 返回它在本机上的当前状态。
 *
 * `via` 是安装方式：`packages` 经包管理器（`packages` 中没有本机包管理器的包名时不显示安装按钮，B5）；
 * `pip` 用选定的 Python 按产品附带的依赖清单安装（`office/requirements.txt`）；`chromium` 下载专用 Chromium。
 * `platforms` 给出时，只在这些平台上列出。
 */
interface DepSpec {
  id: string
  label: string
  via: 'packages' | 'pip' | 'chromium'
  packages?: Packages
  platforms?: readonly string[]
  probe: (ctx: EnvProbeContext) => DepState
}

/**
 * PATH 上的可执行文件。`Bun.which` 在编译出的单文件二进制中同样可用
 * （`plugins/runtime.ts` 已实测）。
 *
 * 探测方式必须与调用方式一致。git / rg / node 的调用方均使用
 * `Bun.spawn(['git', …])`，由 Bun 解析 PATH，因此用 `Bun.which` 探测的结果与调用一致：
 * Bun 未找到的程序，这些调用点同样无法启动，报告「未安装」是正确的。
 */
function onPath(cmd: string): string | null {
  return Bun.which(cmd)
}

/**
 * bash 一行的当前状态。是否已安装与缺失时是否属于必需项，在这一行是两个独立的问题。
 *
 * `commandShell()` 按 bash → pwsh 7 → PowerShell 5.1 三档回退，任一档命中，模型即可执行命令。
 * 若 bash 缺失时恒标为必需，只有 PowerShell 的机器上设置页会报告一条必需依赖缺失，
 * 而模型实际可以使用 `run_command`，这是误报。
 *
 * 三个字段各自的判据：
 *
 * - `path` 只填 bash 本身的路径。该行的标签是 bash，填入 powershell.exe 同样是错误信息；
 *   已安装 bash 与只有 PowerShell 是两种状态，不能显示为同一种（前者兼容 POSIX，后者不兼容）。
 * - `required` 只在没有任何 shell 时为真：此时 `run_command` 不注册
 *   （Alpine 等不带 bash 的镜像会出现该情形），标红是正确的。
 * - `hint` 只说明命令改由 PowerShell 执行，这是用户需要知道的能力边界。语法差异由
 *   `run_command` 的工具描述告知模型（`tools/shell.ts` 拼入的 `shell.hint`），不在设置页重复。
 *
 * 依赖以参数注入，以便测试另外两档：本机只可能命中其中一档，而需要覆盖的失败形状
 * （没有 bash、有 PowerShell）不出现在开发机上。判据同 `tools/process/command-shell.ts` 的 `resolveCommandShell`。
 */
export function resolveBashRow(deps: {
  bash: () => { path: string | null; reason: string }
  shell: () => CommandShell | null
}): DepState {
  const bash = deps.bash()
  // 已安装时不存在缺失影响：bash 是第一档，`commandShell()` 必然命中它。
  if (bash.path !== null) return { path: bash.path, required: false, hint: '' }

  const shell = deps.shell()
  if (shell === null) {
    // 下一步按 bash 一档给出：三档中只有 bash 能给出可操作的下一步（另外两档在本机上
    // 不存在）。判据与 `spawnGuarded` 抛出的错误信息一致。
    return {
      path: null,
      required: true,
      hint: `模型无法执行命令。${bash.reason}`,
    }
  }
  return { path: null, required: false, hint: '命令当前由 PowerShell 执行，安装后改用 bash。' }
}

const DEPS: DepSpec[] = [
  {
    id: 'bash',
    label: 'bash',
    via: 'packages',
    packages: { winget: ['Git.Git'] },
    // bash 不查 PATH，理由见 `tools/process/command-shell.ts` 的 `findGitBash`：
    // 本机 PATH 的第一项是 WSL 启动器，命令会在另一个文件系统中执行。
    probe: () => resolveBashRow({ bash: probeBash, shell: commandShell }),
  },
  {
    id: 'git',
    label: 'git',
    via: 'packages',
    packages: {
      winget: ['Git.Git'],
      brew: ['git'],
      xcode: [],
      apt: ['git'],
      dnf: ['git'],
      pacman: ['git'],
      zypper: ['git'],
    },
    probe: () => ({
      path: onPath('git'),
      required: true,
      hint: '版本面板无法显示分支、改动与差异。',
    }),
  },
  {
    id: 'ripgrep',
    label: 'ripgrep',
    via: 'packages',
    packages: {
      winget: ['BurntSushi.ripgrep.MSVC'],
      brew: ['ripgrep'],
      apt: ['ripgrep'],
      dnf: ['ripgrep'],
      pacman: ['ripgrep'],
      zypper: ['ripgrep'],
    },
    probe: () => ({
      path: onPath('rg'),
      required: false,
      hint: '搜索使用内置实现，大型仓库较慢。',
    }),
  },
  {
    id: 'node',
    label: 'Node.js',
    via: 'packages',
    packages: {
      winget: ['OpenJS.NodeJS.LTS'],
      brew: ['node'],
      apt: ['nodejs'],
      dnf: ['nodejs'],
      pacman: ['nodejs'],
    },
    // 网络访问限制的版本要求不写在此处：插件页按实际版本报告网络访问限制的有无及原因。
    probe: () => ({
      path: onPath('node'),
      required: false,
      hint: '插件无法运行。',
    }),
  },
  {
    id: 'python',
    label: 'Python',
    via: 'packages',
    packages: {
      winget: ['Python.Python.3.12'],
      brew: ['python@3.12'],
      xcode: [],
      // 文档库安装在 QyWork 的虚拟环境中（`pipCommand`），Debian 系另需 venv 模块。
      apt: ['python3', 'python3-venv', 'python3-pip'],
      dnf: ['python3', 'python3-pip'],
      pacman: ['python', 'python-pip'],
      zypper: ['python3', 'python3-pip'],
    },
    // 与 `office` 启动 worker 时使用同一个解释器（`findPython`）。
    probe: ({ config }) => ({
      path: findPython(config),
      required: false,
      hint: 'Office 文档工具不可用。',
    }),
  },
  {
    id: 'office-libs',
    label: 'Office 文档库',
    via: 'pip',
    probe: ({ config, office }) => {
      const python = findPython(config)
      const missing = office?.status().missing ?? []
      if (!python) return { path: null, required: false, hint: '需要先安装 Python。' }
      if (missing.length) {
        return { path: null, required: false, hint: `缺少 ${missing.join('、')}。` }
      }
      return { path: python, required: false, hint: '' }
    },
  },
  {
    id: 'video-decoder',
    label: '视频解码库',
    // 与 Office 文档库使用同一份依赖清单与同一个解释器，一键安装经由同一条 pip 安装路径。
    via: 'pip',
    probe: ({ config, office }) => {
      const python = findPython(config)
      if (!python) return { path: null, required: false, hint: '需要先安装 Python。' }
      if (!office?.status().videoDecoder) {
        return { path: null, required: false, hint: '不支持原生视频的模型无法读取视频。' }
      }
      return { path: python, required: false, hint: '' }
    },
  },
  {
    id: 'browser',
    label: '内置浏览器',
    via: 'chromium',
    platforms: ['darwin', 'linux'],
    probe: () => {
      const failed = chromiumInstallState()
      return {
        path: installedChromium(),
        required: false,
        hint:
          failed && 'failed' in failed
            ? `安装失败：${failed.failed}`
            : '网页在单独的浏览器窗口中打开。',
      }
    },
  },
]

/**
 * 本机能否一键安装。握手与安装路由使用同一个判据。
 *
 * 分开计算时，界面会显示一个点击后返回 409 的按钮；B5 规定：
 * 「能力在某端不存在时，握手中声明 false、界面不显示入口，
 * 而不是显示一个点击即报错的按钮」。
 */
function canInstall(dep: DepSpec, ctx: EnvProbeContext): boolean {
  switch (dep.via) {
    case 'pip':
      return pipTarget(ctx) !== null && canOpenTerminal()
    case 'packages':
      return installCommand(dep.packages ?? {}) !== null && canOpenTerminal()
    case 'chromium': {
      const state = chromiumInstallState()
      return (
        chromiumBuild() !== null && Boolean(ctx.restartBrowser) && !(state && 'progress' in state)
      )
    }
  }
}

/** 安装文档库所需的解释器与清单所在目录；缺少任一项时不提供安装按钮。 */
function pipTarget(ctx: EnvProbeContext): { python: string; dir: string } | null {
  const python = findPython(ctx.config)
  const dir = officeDir()
  return python && dir ? { python, dir } : null
}

/**
 * 全部依赖的当前状态。每次调用重新探测，不缓存：安装完成后重新连接即应更新，
 * 不要求用户重启整个服务（用户无从得知需要重启）。探测是 `which` 与 `existsSync`；
 * winget 的 `cmd /c winget --version` 只在有依赖缺失时执行（实测找到 winget 时耗时 82ms）。
 */
export function probeEnvironment(ctx: EnvProbeContext): EnvDependency[] {
  return DEPS.filter((d) => !d.platforms || d.platforms.includes(process.platform)).map((d) => {
    const { path, required, hint } = d.probe(ctx)
    const install = d.via === 'chromium' ? chromiumInstallState() : null
    return {
      id: d.id,
      label: d.label,
      path,
      required,
      hint: path === null ? hint : '',
      canInstall: path === null && canInstall(d, ctx),
      ...(install && 'progress' in install ? { progress: install.progress } : {}),
    }
  })
}

/**
 * 安装文档库的命令：用选定的解释器按清单安装。在清单所在目录中执行。
 *
 * - Windows：系统解释器安装到用户目录（`--user`，无需管理员权限）；虚拟环境（解释器所在目录或上一级目录有
 *   `pyvenv.cfg`）安装到环境本身，虚拟环境中 pip 拒绝 `--user`。清单使用相对路径：解释器与清单路径都含空格时
 *   命令行有四个引号，`cmd /k` 会去掉首尾两个，命令被拆开。
 * - macOS 与 Linux：先建立 QyWork 的虚拟环境（`officeVenv`）再安装到其中，`findPython` 随后取用它；
 *   已在虚拟环境中的解释器直接安装。系统 Python 标记为外部管理时 `pip install --user` 被拒绝。
 */
export function pipCommand(python: string, platform: string = process.platform): string[] {
  const dir = dirname(python)
  const venv = existsSync(join(dir, 'pyvenv.cfg')) || existsSync(join(dir, '..', 'pyvenv.cfg'))
  if (platform === 'win32') {
    return [python, '-m', 'pip', 'install', ...(venv ? [] : ['--user']), '-r', 'requirements.txt']
  }
  if (venv) return [python, '-m', 'pip', 'install', '-r', 'requirements.txt']
  const env = officeVenv()
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  return [
    'sh',
    '-c',
    `${q(python)} -m venv ${q(env)} && ${q(join(env, 'bin', 'python3'))} -m pip install -r requirements.txt`,
  ]
}

/** 启动安装窗口；启动失败（例如没有终端程序）同样如实返回，不能让按钮显示为操作成功。 */
function launch(title: string, argv: string[], cwd: string | null): Response | null {
  const terminal = terminalArgv(title, argv, cwd)
  if (!terminal) return json({ error: 'no terminal', message: '没有可用的终端程序。' }, 409)
  try {
    Bun.spawn(terminal, {
      ...(cwd ? { cwd } : {}),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
  } catch (e) {
    return json({ error: 'spawn failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }
  return null
}

export const handleHostApi: ApiHandler = async (url, req, d) => {
  const ctx: EnvProbeContext = {
    config: d.config,
    ...(d.office ? { office: d.office } : {}),
    restartBrowser: d.restartBrowser ?? null,
  }
  if (url.pathname === '/api/host/environment' && req.method === 'GET') {
    // 文档库一行读取 Office 宿主的探测结果，安装后再次查询时先重新探测。
    await d.office?.refresh()
    return json({ environment: probeEnvironment(ctx) })
  }

  if (url.pathname !== '/api/host/install' || req.method !== 'POST') return null

  const body = (await req.json().catch(() => null)) as { id?: string } | null
  const dep = DEPS.find((x) => x.id === body?.id)
  // 未查到即返回错误，不推测、不模糊匹配。id 由服务端下发，不一致说明前后端版本不同。
  if (!dep) return json({ error: 'bad request', message: `没有名为 "${body?.id}" 的依赖` }, 400)

  if (dep.via === 'chromium') {
    const restart = ctx.restartBrowser
    if (!restart || !chromiumBuild()) {
      return json({ error: 'unsupported', message: `${dep.label} 不支持在本机安装。` }, 409)
    }
    void installChromium(restart)
    return json({ started: true, note: '正在下载，完成后自动启用。' })
  }

  if (dep.via === 'pip') {
    const target = pipTarget(ctx)
    if (!target) return json({ error: 'no python', message: '需要先安装 Python。' }, 409)
    const argv = pipCommand(target.python)
    const failed = launch('Install Office libraries', argv, target.dir)
    if (failed) return failed
    return json({
      started: true,
      command: argv.join(' '),
      // 文档库安装到解释器自身或 QyWork 的虚拟环境，不修改 PATH；重新检测即可生效。
      note: '安装窗口已打开。安装完成后重新打开本页即显示结果。',
    })
  }

  const command = installCommand(dep.packages ?? {})
  if (!command) {
    return json(
      { error: 'unsupported', message: `本机没有可用的包管理器，请手动安装 ${dep.label}。` },
      409,
    )
  }
  const failed = launch(`Install ${dep.label}`, command.argv, null)
  if (failed) return failed
  return json({
    started: true,
    command: command.display,
    // 必须提示重启：本进程的 PATH 取自启动时，不重启则无法探测到新安装的程序。
    note: '安装窗口已打开，完成后重启 QyWork 生效。',
  })
}
