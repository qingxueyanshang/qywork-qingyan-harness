/**
 * 路径相对于根目录清单的位置。命令裁决（`policy.ts`）与文件工具的路径解析（tools 的 `resolveInWorkspace`）
 * 共用这一份判定，两侧对同一路径给出相同的结论。
 *
 * 同时识别 POSIX 与 Windows 两种写法，不依据 process.platform：盘符开头的路径按 Windows 写法解析，
 * `/` 或 `\` 开头的路径按 POSIX 写法解析，相对路径沿用当前目录的写法。命令可能在一台机器上裁决、
 * 在另一台机器上执行（见 `policy.ts` 文件头）。
 *
 * 只依赖 node 内置模块：测试预载 `scripts/rm-guard.ts` 直接导入本文件，不经过包入口。
 */

import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/**
 * - `root`：工作区或额外目录内；
 * - `home-or-system`：不在根目录内，且位于家目录或系统目录（`/etc`、`<盘符>:\Windows`）中，
 *   或包含家目录（家目录的上级）；
 * - `other`：其余位置。
 */
export type PathPlace = 'root' | 'home-or-system' | 'other'

export interface PlacedPath {
  /** 解析后的绝对路径，`.` 与 `..` 已消去。 */
  path: string
  place: PathPlace
}

type PathStyle = typeof posix

function slashed(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 绝对路径的写法；相对路径返回 null。参数的分隔符已统一为 `/`。 */
function styleOf(p: string): PathStyle | null {
  if (/^[A-Za-z]:\//.test(p)) return win32
  if (p.startsWith('/')) return posix
  return null
}

/** POSIX 或 Windows 写法的绝对路径：以 `/`、`\` 或盘符加分隔符开头。与平台无关。 */
export function isAbsolutePath(p: string): boolean {
  return styleOf(slashed(p)) !== null
}

/**
 * `relative(root, target)` 的结果是否表示 `target` 不在 `root` 之内。
 *
 * 只有完整的 `..` 段表示上一级：`..cache` 是名称以两个点开头的子项，不要改成 `rel.startsWith('..')`。
 * 跨盘符时 `relative` 返回绝对路径，同样表示不在其内。两种分隔符都识别，与平台无关。
 */
export function isOutsideRelative(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolutePath(rel)
}

function absolute(cwd: string, path: string): string {
  const p = slashed(path)
  const base = slashed(cwd)
  return (styleOf(p) ?? styleOf(base) ?? posix).resolve(base, p)
}

/**
 * Windows 写法的路径不区分大小写；POSIX 写法在 Windows 与 macOS 上不区分，在其他平台上区分
 * （Linux 上 `/ETC` 不是 `/etc`）。
 */
function fold(p: string, style: PathStyle): string {
  const insensitive =
    style === win32 || process.platform === 'win32' || process.platform === 'darwin'
  return insensitive ? p.toLowerCase() : p
}

/** `target` 是否为 `root` 本身或位于其下。两者都是 `absolute` 的结果；写法不同时不相互包含。 */
function within(root: string, target: string): boolean {
  const style = styleOf(slashed(root))
  if (style === null || style !== styleOf(slashed(target))) return false
  return !isOutsideRelative(style.relative(fold(root, style), fold(target, style)))
}

/** 与 `abs` 写法相同的系统目录：POSIX 写法为 `/etc`，Windows 写法为 `abs` 所在盘的 `Windows` 目录。 */
function systemDirOf(abs: string): string {
  return styleOf(slashed(abs)) === win32 ? `${abs.slice(0, 2)}\\Windows` : '/etc'
}

/**
 * 判定 `path` 的位置。相对路径以 `cwd` 为基准，`cwd` 必须是绝对路径。先消去 `.` 与 `..`，再与 `roots`
 * （工作区根与额外目录，绝对路径）比较。根目录先于家目录判定：工作区通常位于家目录中。
 *
 * 家目录按两个方向判定：位于其中，或包含它。只判定前一个方向时，`rm -rf C:/Users`
 * 与家目录上级中的 `rm -rf *` 被判为 `other`，而删除上级目录即删除家目录本身。
 * 系统目录只判定「位于其中」：系统目录按任一盘符判定，包含方向会使任一盘符根目录被拒绝，
 * `cp x.txt D:/` 随之误拒；`/` 与盘符根目录的递归删除由 `policy.ts` 的硬拒绝规则处理。
 * 只包含根目录、不包含家目录与系统目录的位置仍是 `other`：根目录本身与其同级目录都可写。
 *
 * `home` 缺省为 `os.homedir()`。`path` 已展开符号链接时传入家目录的真实路径，否则家目录经链接
 * 指向别处时，其中的路径被判为 `other`。
 */
export function placePath(
  cwd: string,
  path: string,
  roots: readonly string[],
  home: string = homedir(),
): PlacedPath {
  const abs = absolute(cwd, path)
  if (roots.some((r) => r !== '' && within(absolute(cwd, r), abs))) {
    return { path: abs, place: 'root' }
  }
  const homeAbs = home === '' ? null : absolute(cwd, home)
  const touchesHome = homeAbs !== null && (within(homeAbs, abs) || within(abs, homeAbs))
  const inSystem = within(systemDirOf(abs), abs)
  return { path: abs, place: touchesHome || inSystem ? 'home-or-system' : 'other' }
}
