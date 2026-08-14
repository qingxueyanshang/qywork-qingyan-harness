/**
 * 宿主机依赖的安装引导。目前只有一件事：**没有 bash 时把 Git for Windows 装上**。
 *
 * ## 为什么这条路存在
 *
 * `run_command` 只跑 bash（`tools/sandbox.ts`），没有 bash 就整个不注册这个工具。
 * 用户在设置页看到「未检测到」之后，下一步不该是「自己去翻官网」——
 * 这台机器上装什么、怎么装，我们比他清楚。
 *
 * 四个参照实现（cc-haha / deepseek-harness / pi / prime-agent）**都没有**这条路：
 * 它们的答案是报错文案里写一句「请安装」。所以这是本项目自己承担的一条新执行入口，
 * 由用户明确要求（见 `docs/plans/2026-08-14-bash-能力检测与安装引导.md` §3 第 5 问）。
 *
 * ## 三条边界
 *
 * 1. **不接受任何参数。** 命令是常量，请求体一个字都不读——没有参数就没有注入面。
 *    这与「起一个用户给的命令」是完全不同的东西，后者已经有 `run_command` 且受裁决。
 * 2. **不自己下载安装包。** 交给 winget：签名校验、来源、回滚都是系统包管理器的事。
 *    自己下 exe 再执行 = 从网上取一个可执行文件然后跑它，那是 CLAUDE.md E 明令不做的形状。
 * 3. **起一个可见的终端窗口，不后台静默。** UAC 抬权弹窗、下载进度、失败原因
 *    都得让用户自己看见；本项目没有 PTY，闷在管道里的安装过程等于一个转不完的圈。
 */

import { probeBash } from '@qywork/tools'
import { type ApiHandler, json } from './types.ts'

/**
 * 装 Git for Windows 的命令。**常量，不拼接任何外部输入。**
 *
 * 逐段拆开而不是拼成一个字符串：拼字符串就得自己处理引号，而
 * `start` 后面那个带空格的标题恰恰需要引号——交给 spawn 去引，比自己拼可靠。
 * 标题只用 ASCII：本机控制台代码页是 GBK，中文标题会以乱码显示（那是本机踩过的坑）。
 *
 * `start` 开一个新控制台窗口，`cmd /k` 让它在 winget 跑完后**留着**——
 * 装失败时那几行输出是用户唯一的线索。
 */
const INSTALL_ARGV = [
  'cmd.exe',
  '/c',
  'start',
  'Install Git for Windows',
  'cmd',
  '/k',
  'winget',
  'install',
  '--id',
  'Git.Git',
  '-e',
  '--source',
  'winget',
] as const

/** 给用户看的那一行——和真正跑的是同一份 argv，不另写一遍。 */
const INSTALL_DISPLAY = 'winget install --id Git.Git -e --source winget'

/**
 * 这台机器上「一键装」到底可不可行。**握手和这条路由用同一个判据。**
 *
 * 分开算的话，表现是界面上有个按钮、点下去回 409——而 B5 的原话就是
 * 「能力在某端不存在时，握手里声明 false、界面不显示入口，
 * 而不是显示一个点了报错的按钮」。
 */
export function canInstallShell(): boolean {
  return process.platform === 'win32' && Bun.which('winget') !== null
}

export const handleHostApi: ApiHandler = async (url, req) => {
  if (url.pathname !== '/api/host/install-shell' || req.method !== 'POST') return null

  if (process.platform !== 'win32') {
    return json(
      {
        error: 'unsupported',
        message: `这个按钮只在 Windows 上有用。当前系统请用自己的包管理器装 bash（如 apt install bash、brew install bash）。${probeBash().reason}`,
      },
      409,
    )
  }

  if (Bun.which('winget') === null) {
    return json(
      {
        error: 'no winget',
        message:
          '这台机器上没有 winget（Windows 10 1809 之前的版本自带的是旧版应用安装程序）。' +
          '请手动装 Git for Windows，或者装好后用 QYWORK_BASH_PATH 指向已有的 bash.exe。',
      },
      409,
    )
  }

  // 起进程本身失败（cmd.exe 都没有）也要如实回报，不能让按钮看起来点成功了。
  try {
    Bun.spawn(INSTALL_ARGV as unknown as string[], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    }).unref()
  } catch (e) {
    return json({ error: 'spawn failed', message: e instanceof Error ? e.message : String(e) }, 500)
  }

  return json({
    started: true,
    command: INSTALL_DISPLAY,
    // **这句必须回给前端显示。** 装完之后 PATH 是这个进程启动时的快照，
    // 新装的 git 不在里面——不重启的话探测照样找不到，而那个失败形状最迷惑人。
    note: '安装窗口已经打开。装完请重启 qywork——当前进程的 PATH 是启动时的快照，看不到新装的 git。',
  })
}
