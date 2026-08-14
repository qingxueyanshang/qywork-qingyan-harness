/**
 * 宿主机的外部程序依赖：**探测它们在不在，以及在 Windows 上一键装上**。
 *
 * ## 表里为什么只有这四条
 *
 * 入表门槛是**代码里真的有一处 `Bun.spawn` 调它**，逐个核过：
 *
 * | | 调用点 | 缺了会怎样 |
 * |---|---|---|
 * | bash | `tools/sandbox.ts` 的 `commandShell()` | `run_command` 整个不注册 |
 * | git | `server/git.ts:77` | 版本面板读不到状态与差异 |
 * | rg | `tools/search.ts:164` | **只是慢**，内置遍历顶上（那条路已经写好了） |
 * | node | `plugins/runtime.ts` 的 `probeNode()` | 插件跑不了 |
 *
 * 「装了更好」「同类工具都列一下」不进表。那种清单的后果是用户第一次点开设置页
 * 看到一片红，而真正坏掉的那条淹在里面。同理 `required` 必须分档：
 * rg 和 node 缺了不影响主线，标成「需要安装」就是假警报。
 *
 * 沙箱（bwrap / seatbelt）**不在这里**：它已经在权限页报了，报两处就是两本账。
 *
 * ## 安装那条路的三条边界
 *
 * 1. **参数只用来查表，从不进命令。** 请求体只有一个 `id`，拿它在下面这张常量表里
 *    查 argv；查不到回 400。命令串里没有任何一个字节来自请求——这与
 *    「跑一条用户给的命令」是两件事，后者是 `run_command`，它受裁决层管。
 * 2. **不自己下载安装包。** 交给 winget：签名校验、来源、回滚都是系统包管理器的事。
 *    自己下 exe 再执行 = 从网上取一个可执行文件然后跑它，CLAUDE.md E 明令不做。
 * 3. **起一个可见的终端窗口，不后台静默。** UAC 抬权、下载进度、失败原因都得让
 *    用户自己看见；本项目没有 PTY，闷在管道里的安装过程就是一个转不完的圈。
 *
 * 四个参照实现（cc-haha / deepseek-harness / pi / prime-agent）**都没有**应用内
 * 装依赖这条路——它们的答案是报错文案里写一句「请安装」。所以这是本项目自己承担的
 * 一条执行入口，由用户明确要求（`docs/plans/2026-08-14-bash-能力检测与安装引导.md`）。
 */

import type { EnvDependency } from '@qywork/core'
import { BASH_PATH_ENV, probeBash } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

/**
 * 一条依赖的定义。`probe` 返回路径与「没装时说什么」。
 *
 * `winget` 为 `null` = 我们不知道它的包 id，界面上就没有按钮（B5：
 * 能力不存在就不显示入口）。
 */
interface DepSpec {
  id: string
  label: string
  impact: string
  required: boolean
  /** winget 包 id。null = 不提供一键装。 */
  winget: string | null
  probe: () => { path: string | null; hint: string }
}

/** `Bun.which` 在编译出的单文件二进制里同样可用（`plugins/runtime.ts` 已实测）。 */
function onPath(cmd: string): string | null {
  return Bun.which(cmd)
}

const DEPS: DepSpec[] = [
  {
    id: 'bash',
    label: 'bash',
    impact: '模型执行命令（构建、测试、git 操作）',
    required: true,
    winget: 'Git.Git',
    // bash **不查 PATH**，理由见 `tools/sandbox.ts` 的 `findGitBash`：
    // 这台机器上 PATH 第一条是 WSL 启动器，命令会跑进另一个文件系统。
    probe: () => {
      const r = probeBash()
      return { path: r.path, hint: r.reason }
    },
  },
  {
    id: 'git',
    label: 'git',
    impact: '版本面板：分支、改动、差异',
    required: true,
    winget: 'Git.Git',
    probe: () => ({
      path: onPath('git'),
      hint: '装上之后版本面板才读得到状态；Git for Windows 同时带上面那个 bash。',
    }),
  },
  {
    id: 'ripgrep',
    label: 'ripgrep',
    impact: '全文搜索加速',
    required: false,
    winget: 'BurntSushi.ripgrep.MSVC',
    probe: () => ({
      path: onPath('rg'),
      hint: '不装也能搜——内置遍历顶上，大仓库慢一些。',
    }),
  },
  {
    id: 'node',
    label: 'Node.js',
    impact: '插件运行时',
    required: false,
    winget: 'OpenJS.NodeJS.LTS',
    probe: () => ({
      path: onPath('node'),
      hint: '只有装插件时才需要；出网闸要 Node 22.15 / 23.5 以上。',
    }),
  },
]

/**
 * 这台机器上「一键装」到底可不可行。**握手与安装路由用同一个判据。**
 *
 * 分开算的表现是界面上有个按钮、点下去回 409——而 B5 的原话就是
 * 「能力在某端不存在时，握手里声明 false、界面不显示入口，
 * 而不是显示一个点了报错的按钮」。
 */
function canInstall(dep: DepSpec): boolean {
  return dep.winget !== null && process.platform === 'win32' && Bun.which('winget') !== null
}

/**
 * 全部依赖的当前状态。**每次调用重新探测，不缓存**——装完之后重连一下就该变，
 * 而不是让用户重启整个服务（他不会知道要重启）。探测是几次 `which` 与 `existsSync`。
 */
export function probeEnvironment(): EnvDependency[] {
  return DEPS.map((d) => {
    const { path, hint } = d.probe()
    return {
      id: d.id,
      label: d.label,
      path,
      impact: d.impact,
      required: d.required,
      hint: path === null ? hint : '',
      canInstall: path === null && canInstall(d),
    }
  })
}

/**
 * 装一个依赖的 argv。**逐段拆开，不拼字符串**：拼字符串就得自己处理引号，
 * 而 `start` 后面那个带空格的标题恰恰需要引号——交给 spawn 去引更可靠。
 *
 * 标题只用 ASCII：本机控制台代码页是 GBK，中文标题会以乱码显示（踩过）。
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
  // 查不到就是查不到——不猜、不模糊匹配。id 是我们自己下发的，对不上说明前后端不同版本。
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
  if (Bun.which('winget') === null) {
    return json(
      {
        error: 'no winget',
        message:
          '这台机器上没有 winget（Windows 10 1809 之前没有它）。请手动安装；' +
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
    // 新装的东西不在里面——不重启的话探测照样找不到，而那个失败形状最迷惑人。
    note: '安装窗口已经打开。装完请重启 qywork——当前进程的 PATH 是启动时的快照，看不到新装的程序。',
  })
}
