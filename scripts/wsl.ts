#!/usr/bin/env bun
/**
 * 在本机 WSL 里跑 Linux 全量门禁与真窗口命令。从 Windows 调用。
 *
 *   bun run scripts/wsl.ts gate [ref]
 *   bun run scripts/wsl.ts run [ref] -- <cmd...>
 *
 * 两个子命令共用 WSL 文件系统上的同一份检出，缺省为 `~/qywork-wsl`，环境变量 `QYWORK_WSL_DIR`
 * 可另指（相对路径以 WSL 的 `$HOME` 为基准）：从本仓库的 git 对象库取 `ref`（缺省为本检出的
 * HEAD），检出到本地分支 `wsl`，再 `bun install --frozen-lockfile`。同时跑两份的调用方各用一个
 * 目录：共用检出时后一次 `git checkout --force` 会改掉前一次正在编译与测试的文件。
 * 只带已提交的内容，工作区里未提交的改动不在其中。检出不放在 `/mnt/c` 下：那里走 9p，I/O 慢，
 * 大小写与权限语义也与 Linux 文件系统不同。
 *
 * `run` 在新建的 Xvfb 显示与 `dbus-run-session` 会话里先启动 openbox，再执行命令，AT-SPI 总线
 * 由会话总线上的 `org.a11y.Bus` 按需激活。不用 WSLg：它的显示与会话总线由所有 WSL 进程共用，
 * 窗口出现在 Windows 桌面上，AT-SPI 注册表里也列着别的进程的应用。窗口管理器每次都启动：
 * 没有它就没有 EWMH 的窗口清单、层叠序与活动窗口，窗口也不带边框，与任何真实桌面都不同。
 *
 * 工具链需事先装进 WSL：`.github/actions/setup-build/action.yml` 的 apt 清单，加 pkg-config、
 * xvfb、xauth、x11-utils、openbox，rustup 的 stable，`~/.bun` 下与 `packageManager` 同版本的
 * Linux 版 bun。另装 nodejs 与 python-is-python3：CI 的 runner 镜像自带 `node` 与 `python`，
 * 测试依赖二者。
 *
 * Windows PowerShell 5.1 调用原生命令时会删掉参数里的裸 `--`，在那里要写成 `'--'`。
 */

import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const DISTRO = 'Ubuntu'
const USAGE = '用法：bun run scripts/wsl.ts gate [ref] | run [ref] -- <cmd...>'

/** WSL 里的检出目录。`QYWORK_WSL_DIR` 缺席或为空时取缺省目录。 */
export function checkoutDir(env: Record<string, string | undefined>): string {
  return env.QYWORK_WSL_DIR || 'qywork-wsl'
}

export type Command = { kind: 'gate'; ref: string } | { kind: 'run'; ref: string; argv: string[] }

/** `run` 必须带 `--`：没有分隔符时无法区分 ref 与命令的第一个词。 */
export function parseArgs(args: string[]): Command {
  const [kind, ...rest] = args
  if (kind === 'gate' && rest.length <= 1) {
    return { kind, ref: rest[0] ?? 'HEAD' }
  }
  if (kind === 'run') {
    const sep = rest.indexOf('--')
    const argv = rest.slice(sep + 1)
    if ((sep === 0 || sep === 1) && argv.length > 0) {
      return { kind, ref: sep === 1 ? (rest[0] ?? 'HEAD') : 'HEAD', argv }
    }
  }
  throw new Error(USAGE)
}

/**
 * WSL 里执行的前置步骤，`$1` 为 git 对象库的 Windows 路径，`$2` 为提交号，`$3` 为检出目录，
 * 其余参数原样 `exec`。
 *
 * PATH 整条替换：WSL 默认把 Windows 的 PATH 追加在后面，其中的 `bun` 是 npm 的 shell 垫片，
 * 按名字找到它会以 Windows 版执行。
 *
 * 取的是 git 对象库而不是检出目录：worktree 的 `.git` 文件里写的是 Windows 路径，Linux 的 git
 * 解析不了。按提交号 fetch 依赖协议 v2，v2 的 upload-pack 接受任意对象的 want。
 *
 * 不读 WSL 用户级的 git 配置：CI 的 runner 上没有这一层，测试结果不能随它变化。
 *
 * 不要改成分离头检出：CI 的检出在分支上，以仓库自身为工作目录的测试在分离头下取不到当前分支，
 * 结果与 CI 不同。
 *
 * `git clean` 不带 `-x`：`node_modules` 与 `.tmp` 下的 Cargo 产物要跨次保留，否则每次都是冷编译。
 */
const PREPARE = [
  'set -e',
  'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
  'export GIT_CONFIG_GLOBAL=/dev/null',
  'src=$(wslpath -u "$1"); sha=$2; dir=$3; shift 3',
  'git init -q "$dir"',
  'cd "$dir"',
  'git fetch -q --no-tags "$src" "$sha"',
  'git checkout -q --force -B wsl "$sha"',
  'git clean -q -fd',
  'echo "$dir: $(git log -1 --format=\'%h %s\')"',
  'bun install --frozen-lockfile',
  'exec "$@"',
].join('\n')

/**
 * 真窗口会话，`$1` 为会话内的前置步骤（`DESKTOP`），其余参数为要执行的命令。
 *
 * `XDG_RUNTIME_DIR` 换成新建的空目录：WSL 的缺省目录里有 WSLg 的 `wayland-0`，libwayland 在
 * `WAYLAND_DISPLAY` 未设置时按这个名字连接，GTK 窗口会落在 WSLg 上而不是 Xvfb 上。
 * AT-SPI 总线的套接字也建在这个目录下，与 WSL 自己的会话互不相干。
 *
 * Xvfb 的屏幕参数必须显式给出：`xvfb-run` 缺省是 `1280x1024x8`，8 位色深下取图得不到真彩色像素。
 */
const GUI = [
  'desktop=$1; shift',
  'unset WAYLAND_DISPLAY',
  'rt=$(mktemp -d)',
  'trap \'rm -rf "$rt"\' EXIT',
  'XDG_RUNTIME_DIR=$rt xvfb-run -a -s "-screen 0 1920x1080x24" dbus-run-session -- sh -c "$desktop" sh "$@"',
].join('\n')

/**
 * 会话内先启动 openbox，等它在根窗口上登记 `_NET_SUPPORTING_WM_CHECK` 再执行命令；命令结束后
 * 结束 openbox，退出码取命令的。10 秒内等不到登记即以失败退出。
 */
const DESKTOP = [
  'openbox --sm-disable >/dev/null 2>&1 &',
  'wm=$!',
  'i=0',
  "until xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; do",
  '  i=$((i + 1))',
  '  if [ $i -gt 200 ]; then echo "openbox 没有起来" >&2; exit 1; fi',
  '  sleep 0.05',
  'done',
  '"$@"',
  'code=$?',
  'kill $wm 2>/dev/null',
  'exit $code',
].join('\n')

function git(args: string[]): string {
  const proc = Bun.spawnSync(['git', ...args], { cwd: ROOT, stderr: 'inherit' })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(' ')} 失败`)
  return proc.stdout.toString().trim()
}

async function main(args: string[]): Promise<number> {
  let command: Command
  try {
    command = parseArgs(args)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 2
  }
  const sha = git(['rev-parse', '--verify', '--end-of-options', `${command.ref}^{commit}`])
  const store = git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  // bun test 在 CI=true 下拒绝 `test.only` 且不新建快照，与 ci.yml 的设置保持一致。
  const tail =
    command.kind === 'gate'
      ? ['env', 'CI=true', 'bun', 'run', 'gate']
      : ['sh', '-c', GUI, 'sh', DESKTOP, ...command.argv]
  const proc = Bun.spawn(
    [
      'wsl.exe',
      '-d',
      DISTRO,
      '--cd',
      '~',
      '--exec',
      'sh',
      '-c',
      PREPARE,
      'sh',
      store,
      sha,
      checkoutDir(process.env),
      ...tail,
    ],
    { stdio: ['inherit', 'inherit', 'inherit'] },
  )
  return await proc.exited
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
