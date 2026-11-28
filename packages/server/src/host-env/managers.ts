/**
 * 运行环境的一键安装：各平台的包管理器与打开终端窗口的方式（`api/host.ts` 的安装路由使用）。
 *
 * - 包管理器按平台列出、按优先顺序查找，取第一个本机存在且该依赖有包名的条目。命令中只有表中的常量与包名，
 *   没有来自请求的字节。
 * - 安装在可见的终端窗口中执行，执行完毕后窗口保留：提权（UAC、sudo 密码）、下载进度与失败原因都由用户在窗口中看到。
 * - Linux 的终端按表中的顺序取第一个存在的程序，各自传入命令的参数写法不同，写在表中。
 */

import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export type ManagerId = 'winget' | 'brew' | 'xcode' | 'apt' | 'dnf' | 'pacman' | 'zypper'

/** 一条依赖在各包管理器中的包名。 */
export type Packages = Partial<Record<ManagerId, readonly string[]>>

interface PackageManager {
  id: ManagerId
  /** 本机的可执行文件；没有时为 `null`。 */
  find(): string | null
  /** 安装命令（argv）。 */
  command(executable: string, packages: readonly string[]): string[]
}

const firstFile = (paths: readonly string[]) => paths.find((p) => existsSync(p)) ?? null

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

/** winget 的位置：PATH 中可用时优先，WindowsApps 不在 PATH 时使用执行别名。 */
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

const sudo =
  (tool: string, args: readonly string[]) => (_: string, packages: readonly string[]) => [
    'sudo',
    tool,
    ...args,
    ...packages,
  ]

/** 各平台的包管理器，按优先顺序。 */
const MANAGERS: Record<string, readonly PackageManager[]> = {
  win32: [
    {
      id: 'winget',
      find: () => resolveWinget(),
      // winget 一次只安装一个包 id。
      command: (exe, [id]) => [exe, 'install', '--id', id ?? '', '-e', '--source', 'winget'],
    },
  ],
  darwin: [
    {
      id: 'brew',
      find: () => firstFile(['/opt/homebrew/bin/brew', '/usr/local/bin/brew']),
      command: (exe, packages) => [exe, 'install', ...packages],
    },
    {
      // 没有 Homebrew 时 git 与 python3 由命令行工具提供，`--install` 打开系统的安装窗口。
      id: 'xcode',
      find: () => firstFile(['/usr/bin/xcode-select']),
      command: (exe) => [exe, '--install'],
    },
  ],
  linux: [
    {
      id: 'apt',
      find: () => firstFile(['/usr/bin/apt-get']),
      command: sudo('apt-get', ['install', '-y']),
    },
    { id: 'dnf', find: () => firstFile(['/usr/bin/dnf']), command: sudo('dnf', ['install', '-y']) },
    {
      id: 'pacman',
      find: () => firstFile(['/usr/bin/pacman']),
      command: sudo('pacman', ['-S', '--needed', '--noconfirm']),
    },
    {
      id: 'zypper',
      find: () => firstFile(['/usr/bin/zypper']),
      command: sudo('zypper', ['--non-interactive', 'install']),
    },
  ],
}

/** 本机安装该依赖的命令；没有可用的包管理器或包名时为 `null`（界面不显示安装按钮）。 */
export function installCommand(
  packages: Packages,
  platform: string = process.platform,
): { argv: string[]; display: string } | null {
  for (const manager of MANAGERS[platform] ?? []) {
    const names = packages[manager.id]
    if (!names) continue
    const exe = manager.find()
    if (!exe) continue
    const argv = manager.command(exe, names)
    return { argv, display: argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') }
  }
  return null
}

/** POSIX shell 的单引号转义。 */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/** 终端中的命令执行完毕后保留窗口，等待用户按回车。 */
const HOLD = `echo; printf '%s' '安装命令已结束，按回车键关闭窗口。'; read _`

/** Linux 的终端程序与传入命令的参数写法，按优先顺序。 */
const LINUX_TERMINALS: readonly { exe: string; args: (script: string) => string[] }[] = [
  { exe: '/usr/bin/x-terminal-emulator', args: (script) => ['-e', 'sh', '-c', script] },
  { exe: '/usr/bin/gnome-terminal', args: (script) => ['--', 'sh', '-c', script] },
  { exe: '/usr/bin/konsole', args: (script) => ['-e', 'sh', '-c', script] },
  { exe: '/usr/bin/xfce4-terminal', args: (script) => ['-x', 'sh', '-c', script] },
  { exe: '/usr/bin/xterm', args: (script) => ['-e', 'sh', '-c', script] },
]

/** 本机能否打开终端窗口。没有时界面不显示安装按钮。 */
export function canOpenTerminal(platform: string = process.platform): boolean {
  if (platform === 'linux') return LINUX_TERMINALS.some((t) => existsSync(t.exe))
  return platform === 'win32' || platform === 'darwin'
}

/**
 * 在新的终端窗口中执行 `argv`（工作目录 `cwd`），返回启动终端的 argv。`title` 只在 Windows 上使用，只用 ASCII：
 * 本机控制台代码页是 GBK，中文标题显示为乱码。
 *
 * Windows：`start` 打开新的控制台窗口，`cmd /k` 使窗口在命令结束后保留，`/wait` 使发起进程在窗口关闭后才退出，
 * 安装路由据此判定窗口是否仍打开。逐段交给 spawn，不拼接字符串：`start` 之后带空格的标题需要引号，由 spawn 处理更可靠。
 * macOS：经 AppleScript 让「终端」执行一段 shell 命令。Linux：见 `LINUX_TERMINALS`。
 */
export function terminalArgv(
  title: string,
  argv: readonly string[],
  cwd: string | null,
  platform: string = process.platform,
): string[] | null {
  if (platform === 'win32') {
    return ['cmd.exe', '/d', '/c', 'start', title, '/wait', 'cmd', '/d', '/k', ...argv]
  }
  const script = `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}${argv.map(shellQuote).join(' ')}; ${HOLD}`
  if (platform === 'darwin') {
    const quoted = script.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
    return [
      'osascript',
      '-e',
      `tell application "Terminal" to do script "${quoted}"`,
      '-e',
      'tell application "Terminal" to activate',
    ]
  }
  const terminal = LINUX_TERMINALS.find((t) => existsSync(t.exe))
  return terminal ? [terminal.exe, ...terminal.args(script)] : null
}
