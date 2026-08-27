/**
 * 宿主机的外部程序依赖：**探测它们在不在，以及在 Windows 上一键装上**。
 *
 * **表里为什么只有这四条。** 入表门槛是**代码里真的有一处 `Bun.spawn` 调它**，逐个核过：
 *
 * | | 调用点 | 缺了会怎样 |
 * |---|---|---|
 * | bash | `tools/sandbox.ts` 的 `commandShell()` | **只是换语法**，落到 PowerShell；三档全空才是 `run_command` 不注册 |
 * | git | `server/git.ts` 的 `git()` | 版本面板读不到状态与差异 |
 * | rg | `tools/search.ts` 的 `runRipgrep()` | **只是慢**，内置遍历顶上（那条路已经写好了） |
 * | node | `plugins/runtime.ts` 的 `probeNode()` | 插件跑不了 |
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
 * 2. **不自己下载安装包。** 交给 winget：签名校验、来源、回滚都是系统包管理器的事。
 *    自己下 exe 再执行 = 从网上取一个可执行文件然后跑它，CLAUDE.md E 明令不做。
 * 3. **起一个可见的终端窗口，不后台静默。** UAC 抬权、下载进度、失败原因都得让
 *    用户自己看见；本项目没有 PTY，闷在管道里的安装过程就是一个转不完的圈。
 *
 * 「应用内装依赖」本身是一条额外的执行入口，由用户明确要求才有——不要往这里追加别的软件。
 */

import type { EnvDependency } from '@qywork/core'
import type { CommandShell } from '@qywork/tools'
import { BASH_PATH_ENV, commandShell, probeBash } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

/**
 * 一条依赖随这台机器变的那三格。
 *
 * `required` 也在里面而不是写死在 `DepSpec` 上：bash 缺了算不算硬伤，
 * 取决于这台机器还有没有别的 shell（`resolveBashRow`）。其余三条是常量，
 * 照样从这里出——两种写法并存的话，读表的人得先分辨哪条是哪种。
 */
interface DepState {
  /** 找到的可执行文件；`null` = 没装。 */
  path: string | null
  /** 缺了就有功能不能用。前端只在 `path` 为 `null` 时消费它（标红 + 「需要安装」）。 */
  required: boolean
  /** 没装时的下一步。装了是空串。 */
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
  impact: string
  /** winget 包 id。null = 不提供一键装。 */
  winget: string | null
  probe: () => DepState
}

/**
 * PATH 上的可执行文件。`Bun.which` 在编译出的单文件二进制里同样可用
 * （`plugins/runtime.ts` 已实测）。
 *
 * **探测方式必须和调用方式一致。** 上面三条（git / rg / node）的调用方都是
 * `Bun.spawn(['git', …])` 这种交给 Bun 解析 PATH 的写法，所以用 `Bun.which` 探
 * 恰好一致：Bun 找不到的，那些调用点同样启动不了，报「未安装」是对的。
 * winget 不一样，见 `wingetUsable()`。
 */
function onPath(cmd: string): string | null {
  return Bun.which(cmd)
}

/**
 * winget 能不能用。**必须经 `cmd.exe` 探，不能用 `Bun.which`。**
 *
 * `WindowsApps` 下那个 winget.exe 是**应用执行别名**（APPEXECLINK 重解析点），不是
 * 真文件：`stat` 认不出这个标签，因此所有基于 `existsSync` 的查找一律说没有
 * （`Bun.which` 返回 null、`Bun.spawnSync` 直接抛），而 `CreateProcess` 解析得了它，
 * `cmd /c winget --version` 是 exit 0。**Win10/11 上 winget 一律是这个形状**——照
 * `Bun.which` 判的话一键装按钮在任何机器上都不出现，而这个缺陷只有真起一次服务才撞得到。
 *
 * 判据仍然是本仓一贯的那条（`sandbox.ts` 的 `detectSandbox`）：
 * **「装了」不等于「能用」，所以真跑一次**。而且跑的是**和安装时同一条路**——
 * 装是 `cmd /c start … winget …`，探也走 cmd，两边一致才有意义。
 *
 * 不缓存：命中 82ms、落空 9ms（实测），而且只在有依赖缺失时才会问到它。
 */
export function wingetUsable(): boolean {
  try {
    return (
      Bun.spawnSync(['cmd.exe', '/c', 'winget', '--version'], {
        stdout: 'ignore',
        stderr: 'ignore',
        stdin: 'ignore',
      }).exitCode === 0
    )
  } catch {
    return false
  }
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
 * - `hint` 把差别说全：现在真正在跑的是哪个可执行文件、语法差在哪
 *   （B7 的例外——能力边界声明必须留全，不能只说一句「装了更好」）。
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
      hint: `bash、pwsh、powershell 都没有，模型手里根本没有 run_command：${bash.reason}`,
    }
  }
  return {
    path: null,
    required: false,
    hint:
      `命令照样跑得了，但语法换了：现在交给 ${shell.path}，模型按 PowerShell 写而不是 POSIX` +
      '（2>/dev/null 要写成 2>$null）；落在 Windows PowerShell 5.1（System32 里那个）时，' +
      '&& 与 || 更是解析错误，只能用 ; 与 if ($?) { }。装上 bash 就切回 POSIX。',
  }
}

const DEPS: DepSpec[] = [
  {
    id: 'bash',
    label: 'bash',
    impact: '模型执行命令（构建、测试、git 操作）：有 bash 才是 POSIX 语法',
    winget: 'Git.Git',
    // bash **不查 PATH**，理由见 `tools/sandbox.ts` 的 `findGitBash`：
    // 这台机器上 PATH 第一条是 WSL 启动器，命令会跑进另一个文件系统。
    probe: () => resolveBashRow({ bash: probeBash, shell: commandShell }),
  },
  {
    id: 'git',
    label: 'git',
    impact: '版本面板：分支、改动、差异',
    winget: 'Git.Git',
    probe: () => ({
      path: onPath('git'),
      required: true,
      hint: '装上之后版本面板才读得到状态；Git for Windows 同时带上面那个 bash。',
    }),
  },
  {
    id: 'ripgrep',
    label: 'ripgrep',
    impact: '全文搜索加速',
    winget: 'BurntSushi.ripgrep.MSVC',
    probe: () => ({
      path: onPath('rg'),
      required: false,
      hint: '不装也能搜——内置遍历顶上，大仓库慢一些。',
    }),
  },
  {
    id: 'node',
    label: 'Node.js',
    impact: '插件运行时',
    winget: 'OpenJS.NodeJS.LTS',
    probe: () => ({
      path: onPath('node'),
      required: false,
      hint: '只有装插件时才需要；出网闸要 Node 22.15 / 23.5 以上。',
    }),
  },
]

/**
 * 这台机器上「一键装」是否可行。**握手与安装路由用同一个判据。**
 *
 * 分开算的表现是界面上有个按钮、点下去回 409——而 B5 的原话就是
 * 「能力在某端不存在时，握手里声明 false、界面不显示入口，
 * 而不是显示一个点了报错的按钮」。
 */
function canInstall(dep: DepSpec): boolean {
  return dep.winget !== null && process.platform === 'win32' && wingetUsable()
}

/**
 * 全部依赖的当前状态。**每次调用重新探测，不缓存**——装完之后重连一下就该变，
 * 而不是让用户重启整个服务（他不会知道要重启）。四条探测是 `which` 与 `existsSync`；
 * winget 那次 `cmd /c winget --version` 只在**有依赖缺失**时才会跑到（实测命中 82ms）。
 */
export function probeEnvironment(): EnvDependency[] {
  return DEPS.map((d) => {
    const { path, required, hint } = d.probe()
    return {
      id: d.id,
      label: d.label,
      path,
      impact: d.impact,
      required,
      hint: path === null ? hint : '',
      canInstall: path === null && canInstall(d),
    }
  })
}

/**
 * 装一个依赖的 argv。**逐段拆开，不拼字符串**：拼字符串就得自己处理引号，
 * 而 `start` 后面那个带空格的标题需要引号——交给 spawn 去引更可靠。
 *
 * 标题只用 ASCII：本机控制台代码页是 GBK，中文标题会以乱码显示。
 * `start` 开一个新控制台窗口，`cmd /k` 让它在 winget 跑完后**留着**——
 * 装失败时那几行输出是用户唯一的线索。
 */
function installArgv(wingetId: string): string[] {
  return [
    'cmd.exe',
    '/c',
    'start',
    `Install ${wingetId}`,
    'cmd',
    '/k',
    'winget',
    'install',
    '--id',
    wingetId,
    '-e',
    '--source',
    'winget',
  ]
}

export const handleHostApi: ApiHandler = async (url, req) => {
  if (url.pathname === '/api/host/environment' && req.method === 'GET') {
    return json({ environment: probeEnvironment() })
  }

  if (url.pathname !== '/api/host/install' || req.method !== 'POST') return null

  const body = (await req.json().catch(() => null)) as { id?: string } | null
  const dep = DEPS.find((d) => d.id === body?.id)
  // 查不到就是查不到——不猜、不模糊匹配。id 由服务端下发，对不上说明前后端不同版本。
  if (!dep) return json({ error: 'bad request', message: `没有名为 "${body?.id}" 的依赖` }, 400)

  if (dep.winget === null) {
    return json({ error: 'unsupported', message: `${dep.label} 没有可用的一键安装` }, 409)
  }
  if (process.platform !== 'win32') {
    return json(
      {
        error: 'unsupported',
        message: `一键安装只在 Windows 上有。当前系统请用自己的包管理器装 ${dep.label}。`,
      },
      409,
    )
  }
  if (!wingetUsable()) {
    return json(
      {
        error: 'no winget',
        message:
          '本机没有 winget（Windows 10 1809 之前没有它）。请手动安装；' +
          `bash 装在非常规位置时可以用 ${BASH_PATH_ENV} 指过去。`,
      },
      409,
    )
  }

  // 起进程本身失败（连 cmd.exe 都没有）也要如实回报，不能让按钮看起来点成功了。
  try {
    Bun.spawn(installArgv(dep.winget), {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
  } catch (e) {
    return json({ error: 'spawn failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }

  return json({
    started: true,
    command: `winget install --id ${dep.winget} -e --source winget`,
    // **这句必须回给前端显示。** 装完之后 PATH 是这个进程启动时的快照，
    // 新装的依赖不在里面——不重启的话探测照样找不到，而那个失败形状最难判断。
    note: '安装窗口已经打开。装完请重启 qywork——当前进程的 PATH 是启动时的快照，看不到新装的程序。',
  })
}
