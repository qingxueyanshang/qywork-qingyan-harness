/**
 * 宿主机的外部程序依赖：**探测它们在不在，以及在 Windows 上一键装上**。
 *
 * **表里为什么只有这几条。** 入表门槛是**代码里真的有一处 `Bun.spawn` 调它**，逐个核过：
 *
 * | | 调用点 | 缺了会怎样 |
 * |---|---|---|
 * | bash | `tools/sandbox.ts` 的 `commandShell()` | **只是换语法**，落到 PowerShell；三档全空才是 `run_command` 不注册 |
 * | git | `server/git.ts` 的 `git()` | 版本面板读不到状态与差异 |
 * | rg | `tools/search.ts` 的 `runRipgrep()` | **只是慢**，内置遍历顶上（那条路已经写好了） |
 * | node | `plugins/runtime.ts` 的 `probeNode()` | 插件跑不了 |
 * | Python | `tools/office.ts` 起 worker、`runtime/office.ts` 探测 | Office 工具不注册 |
 * | Office 文档库 | worker 导入 | `office` 工具不注册；按清单用 pip 装，不经 winget |
 * | 视频解码库 | worker 的 `frames` 动作 | 不支持原生视频的模型读不了视频；同一份清单、同一条 pip 路线 |
 *
 * 「装了更好」「同类工具都列一下」不进表。那种清单的后果是用户第一次点开设置页
 * 看到一片红，而真正坏掉的那条淹在里面。同理 `required` 必须分档：
 * rg 和 node 缺了不影响主线，标成「需要安装」就是假警报——bash 自批 4 起也归这一档，
 * 但它的档位随机器变，见 `resolveBashRow`。
 *
 * 沙箱（bwrap / seatbelt）**不在这里**：它已经在权限页报了，报两处就是两本账。
 *
 * **安装那条路的三条边界**：
 * 1. **参数只用来查表，从不进命令。** 请求体只有一个 `id`，拿它在下面这张常量表里
 *    查 argv；查不到回 400。命令串里没有任何一个字节来自请求——这与
 *    「跑一条用户给的命令」是两件事，后者是 `run_command`，它受裁决层管。
 * 2. **不自己下载安装包。** 程序交给 winget：签名校验、来源、回滚都是系统包管理器的事。
 *    自己下 exe 再执行 = 从网上取一个可执行文件然后跑它，CLAUDE.md E 明令不做。
 *    文档库交给 pip，按产品附带的固定版本清单装，同样不经本进程下载。
 * 3. **起一个可见的终端窗口，不后台静默。** UAC 抬权、下载进度、失败原因都得让
 *    用户自己看见；本项目没有 PTY，闷在管道里的安装过程就是一个转不完的圈。
 *
 * 「应用内装依赖」本身是一条额外的执行入口，由用户明确要求才有——不要往这里追加别的软件。
 */

import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import type { EnvDependency } from '@qywork/core'
import { findPython, type OfficeHost, officeDir, type QyConfig } from '@qywork/runtime'
import type { CommandShell } from '@qywork/tools'
import { commandShell, probeBash } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

/**
 * 一次探测要读的外部状态：Python 按配置找（`officePython` 或 PATH），
 * 文档库缺项取 Office 宿主最近一次探测的结果。
 */
export interface EnvProbeContext {
  config: QyConfig
  office?: OfficeHost
}

/**
 * 一条依赖随这台机器变的那三格。
 *
 * `required` 也在里面而不是写死在 `DepSpec` 上：bash 缺了算不算硬伤，
 * 取决于本机是否还存在其他 shell（`resolveBashRow`）。其余三条是常量，
 * 照样从这里出——两种写法并存的话，读表的人得先分辨哪条是哪种。
 */
interface DepState {
  /** 找到的可执行文件；`null` = 没装。 */
  path: string | null
  /** 缺了就有功能不能用。前端只在 `path` 为 `null` 时消费它（标红 + 「需要安装」）。 */
  required: boolean
  /** 没装时缺了会怎样，一句话。装了是空串。 */
  hint: string
}

/**
 * 一条依赖的定义。`probe` 返回它在这台机器上的当前状态。
 *
 * `winget` 为 `null` = 本仓没有收录它的包 id，界面上就没有按钮（B5：
 * 能力不存在就不显示入口）。
 */
interface DepSpec {
  id: string
  label: string
  /** winget 包 id。null = 不经 winget 装。 */
  winget: string | null
  /** 用选定的 Python 按产品附带的依赖清单装（`office/requirements.txt`）。 */
  pip?: true
  probe: (ctx: EnvProbeContext) => DepState
}

/**
 * PATH 上的可执行文件。`Bun.which` 在编译出的单文件二进制里同样可用
 * （`plugins/runtime.ts` 已实测）。
 *
 * **探测方式必须和调用方式一致。** 上面三条（git / rg / node）的调用方都是
 * `Bun.spawn(['git', …])` 这种交给 Bun 解析 PATH 的写法，所以用 `Bun.which` 探
 * 恰好一致：Bun 找不到的，那些调用点同样启动不了，报「未安装」是对的。
 * winget 使用执行别名探测，见 `resolveWinget()`。
 */
function onPath(cmd: string): string | null {
  return Bun.which(cmd)
}

/** 应用执行别名必须通过 cmd 实际运行，不能用文件存在性或 Bun.which 判定。 */
function probeWinget(executable: string): boolean {
  try {
    return (
      Bun.spawnSync(['cmd.exe', '/d', '/c', executable, '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
      }).exitCode === 0
    )
  } catch {
    return false
  }
}

/** 探测结果同时用于能力上报和安装，WindowsApps 不在 PATH 时仍可使用执行别名。 */
export function resolveWinget(
  deps: {
    platform: string
    localAppData: string | undefined
    probe: (executable: string) => boolean
  } = { platform: process.platform, localAppData: process.env.LOCALAPPDATA, probe: probeWinget },
): string | null {
  if (deps.platform !== 'win32') return null
  const candidates = ['winget']
  if (deps.localAppData) {
    candidates.push(win32.join(deps.localAppData, 'Microsoft', 'WindowsApps', 'winget.exe'))
  }
  return candidates.find(deps.probe) ?? null
}

/**
 * bash 那一行的当前状态。**「装没装」与「缺了算不算硬伤」在这一行是两个问题。**
 *
 * 批 4 之前它们是同一个：没有 bash 就没有 `run_command`，所以 `required` 恒为真。
 * 批 4 之后 `commandShell()` 按 bash → pwsh 7 → PowerShell 5.1 三档落，
 * **三档任一命中模型就跑得了命令**——再恒标必需的话，只有 PowerShell 的机器上
 * 设置页会报一条必需依赖缺失，而模型手里有 `run_command`，
 * 用户因此去装一个他并不需要的依赖。
 *
 * 三格各自的判据：
 *
 * - `path` 仍然是 **bash 自己**的路径。这一行的标签写着 bash，把 powershell.exe
 *   填进去只是把一句谎换成另一句；而「装了 bash」与「只有 PowerShell」是两种状态，
 *   不能显示成同一种（前者 POSIX，后者不是）。
 * - `required` 只在**一个 shell 都没有**时为真——那时 `run_command` 真的不注册
 *   （Alpine 这类不带 bash 的镜像会走到），标红是对的。
 * - `hint` 只说命令改由 PowerShell 执行，这是用户需要知道的能力边界。语法差异由
 *   `run_command` 的工具描述交给模型（`tools/shell.ts` 拼入的 `shell.hint`），不在设置页重复。
 *
 * 注入是为了能测另外两档：本机只可能命中其中一档，而这一批要修的失败形状
 * （没 bash、有 PowerShell）不在开发机上。判据同 `sandbox.ts` 的 `resolveCommandShell`。
 */
export function resolveBashRow(deps: {
  bash: () => { path: string | null; reason: string }
  shell: () => CommandShell | null
}): DepState {
  const bash = deps.bash()
  // 装了就没有「缺了会怎样」这个问题：它自己就是第一档，`commandShell()` 必然命中它。
  if (bash.path !== null) return { path: bash.path, required: false, hint: '' }

  const shell = deps.shell()
  if (shell === null) {
    // 下一步照 bash 那一档说：三档里只有它给得出可操作的下一步（另外两档是
    // 「这台机器上就是没有」）。判据与 `spawnGuarded` 抛的那句一致。
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
    winget: 'Git.Git',
    // bash **不查 PATH**，理由见 `tools/sandbox.ts` 的 `findGitBash`：
    // 这台机器上 PATH 第一条是 WSL 启动器，命令会跑进另一个文件系统。
    probe: () => resolveBashRow({ bash: probeBash, shell: commandShell }),
  },
  {
    id: 'git',
    label: 'git',
    winget: 'Git.Git',
    probe: () => ({
      path: onPath('git'),
      required: true,
      hint: '版本面板无法显示分支、改动与差异。',
    }),
  },
  {
    id: 'ripgrep',
    label: 'ripgrep',
    winget: 'BurntSushi.ripgrep.MSVC',
    probe: () => ({
      path: onPath('rg'),
      required: false,
      hint: '搜索使用内置实现，大型仓库较慢。',
    }),
  },
  {
    id: 'node',
    label: 'Node.js',
    winget: 'OpenJS.NodeJS.LTS',
    // 出网限制的版本要求不写在这里：插件页按实际版本报「出网闸 有 / 无」与原因。
    probe: () => ({
      path: onPath('node'),
      required: false,
      hint: '插件无法运行。',
    }),
  },
  {
    id: 'python',
    label: 'Python',
    winget: 'Python.Python.3.12',
    // 与 `office` 起 worker 用的是同一个解释器（`findPython`）。
    probe: ({ config }) => ({
      path: findPython(config),
      required: false,
      hint: 'Office 文档工具不可用。',
    }),
  },
  {
    id: 'office-libs',
    label: 'Office 文档库',
    winget: null,
    pip: true,
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
    winget: null,
    // 与 Office 文档库同一份依赖清单、同一个解释器，一键装走同一条 pip 路线。
    pip: true,
    probe: ({ config, office }) => {
      const python = findPython(config)
      if (!python) return { path: null, required: false, hint: '需要先安装 Python。' }
      if (!office?.status().videoDecoder) {
        return { path: null, required: false, hint: '不支持原生视频的模型读不了视频。' }
      }
      return { path: python, required: false, hint: '' }
    },
  },
]

/**
 * 这台机器上「一键装」是否可行。**握手与安装路由用同一个判据。**
 *
 * 分开算的表现是界面上有个按钮、点下去回 409——而 B5 的原话就是
 * 「能力在某端不存在时，握手里声明 false、界面不显示入口，
 * 而不是显示一个点了报错的按钮」。
 */
function canInstall(dep: DepSpec, ctx: EnvProbeContext): boolean {
  if (process.platform !== 'win32') return false
  if (dep.pip) return pipTarget(ctx) !== null
  return dep.winget !== null && resolveWinget() !== null
}

/** 装文档库所需的解释器与清单所在目录；缺任一项就不给按钮。 */
function pipTarget(ctx: EnvProbeContext): { python: string; dir: string } | null {
  const python = findPython(ctx.config)
  const dir = officeDir()
  return python && dir ? { python, dir } : null
}

/**
 * 全部依赖的当前状态。**每次调用重新探测，不缓存**——装完之后重连一下就该变，
 * 而不是让用户重启整个服务（他不会知道要重启）。四条探测是 `which` 与 `existsSync`；
 * winget 那次 `cmd /c winget --version` 只在**有依赖缺失**时才会跑到（实测命中 82ms）。
 */
export function probeEnvironment(ctx: EnvProbeContext): EnvDependency[] {
  return DEPS.map((d) => {
    const { path, required, hint } = d.probe(ctx)
    return {
      id: d.id,
      label: d.label,
      path,
      required,
      hint: path === null ? hint : '',
      canInstall: path === null && canInstall(d, ctx),
    }
  })
}

/**
 * 装文档库的 argv：用选定的解释器按清单安装。系统解释器装到用户目录（`--user`，不需要管理员权限）；
 * 虚拟环境（解释器旁或上一级有 `pyvenv.cfg`）装进环境本身，那里 pip 拒绝 `--user`。
 * 与 winget 那条同样开一个留着的控制台窗口，失败时输出留给用户看。
 *
 * 清单用相对路径，调用方把工作目录设为清单所在目录。不要改成绝对路径：
 * 解释器与清单路径都含空格时命令行有四个引号，`cmd /k` 会去掉首尾两个，命令被拆开。
 */
export function pipInstallArgv(python: string): string[] {
  const dir = dirname(python)
  const venv = existsSync(join(dir, 'pyvenv.cfg')) || existsSync(join(dir, '..', 'pyvenv.cfg'))
  return [
    'cmd.exe',
    '/d',
    '/c',
    'start',
    'Install Office libraries',
    'cmd',
    '/d',
    '/k',
    python,
    '-m',
    'pip',
    'install',
    ...(venv ? [] : ['--user']),
    '-r',
    'requirements.txt',
  ]
}

/**
 * 装一个依赖的 argv。**逐段拆开，不拼字符串**：拼字符串就得自己处理引号，
 * 而 `start` 后面那个带空格的标题需要引号——交给 spawn 去引更可靠。
 *
 * 标题只用 ASCII：本机控制台代码页是 GBK，中文标题会以乱码显示。
 * `start` 开一个新控制台窗口，`cmd /k` 让它在 winget 跑完后**留着**——
 * 装失败时那几行输出是用户唯一的线索。
 */
export function installArgv(executable: string, wingetId: string): string[] {
  return [
    'cmd.exe',
    '/d',
    '/c',
    'start',
    `Install ${wingetId}`,
    'cmd',
    '/d',
    '/k',
    executable,
    'install',
    '--id',
    wingetId,
    '-e',
    '--source',
    'winget',
  ]
}

export const handleHostApi: ApiHandler = async (url, req, d) => {
  const ctx: EnvProbeContext = { config: d.config, ...(d.office ? { office: d.office } : {}) }
  if (url.pathname === '/api/host/environment' && req.method === 'GET') {
    // 文档库那一行读 Office 宿主的探测结果，装完再查时先重新探测一次。
    await d.office?.refresh()
    return json({ environment: probeEnvironment(ctx) })
  }

  if (url.pathname !== '/api/host/install' || req.method !== 'POST') return null

  const body = (await req.json().catch(() => null)) as { id?: string } | null
  const dep = DEPS.find((x) => x.id === body?.id)
  // 查不到就是查不到——不猜、不模糊匹配。id 由服务端下发，对不上说明前后端不同版本。
  if (!dep) return json({ error: 'bad request', message: `没有名为 "${body?.id}" 的依赖` }, 400)

  if (dep.pip) return installPip(dep, ctx)
  if (dep.winget === null) {
    return json({ error: 'unsupported', message: `${dep.label} 不支持一键安装。` }, 409)
  }
  if (process.platform !== 'win32') {
    return json(
      {
        error: 'unsupported',
        message: `一键安装仅支持 Windows，请使用系统包管理器安装 ${dep.label}。`,
      },
      409,
    )
  }
  const winget = resolveWinget()
  if (winget === null) {
    return json({ error: 'no winget', message: `无法调用 winget，请手动安装 ${dep.label}。` }, 409)
  }

  // 起进程本身失败（连 cmd.exe 都没有）也要如实回报，不能让按钮看起来点成功了。
  try {
    Bun.spawn(installArgv(winget, dep.winget), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
  } catch (e) {
    return json({ error: 'spawn failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }

  return json({
    started: true,
    command: `"${winget}" install --id ${dep.winget} -e --source winget`,
    // 必须提示重启：本进程的 PATH 取自启动时，不重启则新装的程序探测不到。
    note: '安装窗口已打开，完成后重启 qywork 生效。',
  })
}

function installPip(dep: DepSpec, ctx: EnvProbeContext): Response {
  if (process.platform !== 'win32') {
    return json(
      { error: 'unsupported', message: `一键安装仅支持 Windows，请用 pip 安装 ${dep.label}。` },
      409,
    )
  }
  const target = pipTarget(ctx)
  if (!target) {
    return json({ error: 'no python', message: '需要先安装 Python。' }, 409)
  }
  const argv = pipInstallArgv(target.python)
  try {
    Bun.spawn(argv, {
      cwd: target.dir,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
  } catch (e) {
    return json({ error: 'spawn failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }
  return json({
    started: true,
    command: `"${target.python}" ${argv.slice(argv.indexOf('-m')).join(' ')}`,
    // 文档库装进解释器自己的目录，不改 PATH；重新检测即可生效。
    note: '安装窗口已打开，完成后重新检测即可。',
  })
}
