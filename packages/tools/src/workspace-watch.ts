/**
 * 观察执行期间工作区中被改动的文件。供没有精确改动明细的执行器使用：shell、外部 CLI。
 *
 * 三个来源合并后才完整：
 * - `fs.watch`（递归）收集路径。通知不保证覆盖每次文件操作，被合并或丢失的事件由收尾扫描补充。
 *   删除只能由事件或调用方的已报告路径判定，文件不存在时扫描无法发现。
 * - 收尾时扫描一遍工作区，`mtime` 位于窗口内的文件即为已改动。扫描需要 stat 每个文件；
 *   超过 `MAX_WALK_ENTRIES` 即停止，此时结果标记为 `incomplete`。
 * - 调用方传入的 `reported`：本轮之前已报告过的路径，收尾时逐个 stat 核对。
 *   整个目录被删除时，前两个来源都无法给出其中的文件：递归 watch 只为目录产生一条事件
 *   （Windows 实测 `rm -rf d`：`d/a.txt` 与 `d` 有事件，`d/sub/b.txt` 没有），
 *   而扫描无法发现已不存在的文件。不核对时，这些文件停留在最后一次观察到的状态。
 *
 * 每个工作区根只打开一个 `fs.watch`，窗口按打开顺序排队；同一时刻有多个窗口打开时，
 * 事件与扫描结果都归属最早打开的窗口，后续窗口从前一个窗口收尾时起才开始拥有事件与扫描结果。
 * 因此并行执行时的归属是估算。
 *
 * **工作区根先取 realpath，watch、共享键、标记路径、扫描与 stat 都使用该路径。** FSEvents 按真实路径
 * 报告事件，watch 的路径经过符号链接时前缀不一致，收不到任何事件，收尾的屏障只能等待到上限。
 * 因此同一目录的不同写法共用一个 watcher。结果中的路径相对工作区根，与调用方使用的写法无关。
 * 必须使用 `realpathSync.native`：Windows 上非 native 版本保留调用方传入的大小写，仅大小写不同的两种写法
 * 会各打开一个 watcher。
 *
 * **收尾时先等待在途事件全部交付，再移交归属。** 事件从发生到进入回调存在延迟（macOS 的 FSEvents 每 50 ms
 * 合批交付一次），收尾时直接关闭 watcher 或把事件改归下一个窗口，此前发生、尚未交付的事件会丢失或归入错误的窗口。
 * 排在最前的窗口收尾时在 `<root>/.tmp` 下写入一个唯一命名的标记文件，收到该文件的事件后才移交归属：
 * FSEvents、inotify、ReadDirectoryChangesW 对同一个 watcher 都按发生顺序交付，标记之前的事件
 * 此时都已进入回调。标记无法写入，或到 `BARRIER_TIMEOUT_MS` 仍未收到时，结果标记为 `incomplete`。
 * `.tmp` 必须在创建 watcher 之前创建：Linux 的递归 watch 由读线程为之后出现的目录追加监视，
 * 追加之前写入的标记不产生事件。
 * 标记每次使用唯一名称，避免同一路径的重复事件被运行时合并。
 *
 * 无法取得改动前的内容，因此修改与删除的文件不带行数；新建的文本文件按写入磁盘的内容计算行数，
 * 计算方式与文件工具相同（`countDiff` 对空的旧内容：新内容按 `\n` 分割的段数）。
 * `changeType` 按收尾时的磁盘状态判定：不存在 = deleted；创建时间不早于窗口起点 = created；其余为 modified。
 * **窗口起点与文件时间戳取自同一个时钟。** 新建 watcher 时等待文件时间戳越过当前刻度，以越过后的值为
 * 起点（`stampTick`）：打开前写入的文件时间戳都小于起点，打开后写入的都不小于起点。调用方必须在
 * 窗口打开之后才开始写入；因此打开操作最多多阻塞一个刻度（Linux 按 HZ 为 1–10 ms）。排队的窗口以前一个
 * 窗口收尾时的 `Date.now()` 为起点，文件时间戳比它落后至多一个刻度，此后一个刻度内新建的文件判定为 modified。
 * 临时文件（窗口内创建、收尾前删除）不进入结果，前提是观察器在它消失之前 stat 过它：存在时间短于
 * 事件交付延迟的临时文件判定为 deleted。原子保存（写入临时文件再改名）判定为 created。
 * 结果中只有文件：仍在磁盘上的按 `stat` 判定，已不存在的按同一批中是否有路径以它为父段判定。
 *
 * **不报告哪些路径由 Git 裁决，事件收集与收尾扫描共用同一策略。**
 * 任一路径段为 `.git`（版本库元数据）或 `.tmp`（本项目的临时产物目录）的路径一律不报告；
 * 其余候选在窗口收尾时一次性交给 `git check-ignore --stdin -z`（在仓库根执行），
 * 命中忽略规则的丢弃。**不要另写一层「该文件是否已跟踪」的判断**：`check-ignore`
 * 默认查询索引，已跟踪的路径即使命中忽略模式也不会被它输出，加 `--no-index` 才会输出。
 * 非 Git 目录没有忽略规则可依据，运行产物目录清单 `IGNORED_DIRS` 是唯一依据，
 * 其余路径（包括点路径）照常报告。
 *
 * **Git 仓库中的 `IGNORED_DIRS` 目录只经索引观察，其中未跟踪的文件不报告。**
 * 剪枝是性能手段：收尾扫描进入 `node_modules` 需要 stat 其中全部文件，本仓库实测约 470 ms，剪枝后约 15 ms；
 * 覆盖范围由索引补齐：收尾时对被剪枝的目录执行一次 `git ls-files -z`，取回其中已跟踪的文件，
 * `mtime` 位于窗口内的列为候选。**被剪枝目录中的删除不报告**：该处没有事件可依据，
 * 索引中的残留项（文件已删除、未执行 `git rm`）无法归属任何窗口，报告后每个窗口都会出现一条虚假删除。
 *
 * **不要按文件名前缀推断用途。** 以点开头的路径既有浏览器 profile 与缓存，也有
 * `.github/workflows`、`.gitignore`、`.editorconfig` 和用户自建的点目录，
 * 按前缀排除会一并丢弃项目文件。
 */

import {
  type Dirent,
  existsSync,
  type FSWatcher,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import type { FileChange } from '@qywork/core'
import { IGNORED_DIRS } from './paths.ts'
import { collectProcess } from './sandbox.ts'

/** 一个执行窗口观察到的工作区变更。 */
export interface ObservedChanges {
  changes: FileChange[]
  /**
   * 观察范围不完整：收尾时未等到在途事件全部交付、Git 判定未执行成功，或收尾扫描达到上限后停止。
   *
   * 调用方必须把它告知上游：不告知时，一次未执行完的过滤与一次确无改动
   * 在结果中完全相同。
   */
  incomplete: boolean
}

export interface ChangeWindow {
  /** 收尾：停止归集，按此刻的磁盘状态判定每个路径的变更类型。 */
  close(): Promise<ObservedChanges>
}

export interface ChangeWindowOptions {
  /**
   * 本轮之前各窗口报告为 created / modified 的工作区相对路径。
   *
   * 调用方自行维护该累计集合：报告过的路径加入，报告为 deleted 的路径移除。
   * 只放入文件路径：目录从不进入结果，因此该来源不会报告目录的删除。
   */
  reported?: ReadonlySet<string>
}

/**
 * 按种类计数的 git 子进程数，只增不减。
 *
 * 供测试断言一个窗口收尾时最多启动两个进程，且该数不随 fs 事件次数增加；生产代码不读取它。
 */
export const gitProcessCount = { checkIgnore: 0, lsFiles: 0 }

const MAX_WALK_ENTRIES = 50_000
/** 只对不超过此大小的文件计算行数：更大的文件通常是产物或数据，行数对其没有意义。 */
const MAX_COUNT_BYTES = 4 * 1024 * 1024
/** 文件时间戳允许超前本机时钟的量；超出此量的文件时钟有误，不能每次都判定为已修改。 */
const CLOCK_SLACK_MS = 1_000
/** 单次 git 查询的时长上限。超时后终止进程树，结果按判定未执行成功处理。 */
const GIT_TIMEOUT_MS = 15_000
/**
 * 等待标记事件的上限。正常交付在毫秒级，macOS 上最多增加一个 50 ms 的合批周期；
 * 超时仍未收到时按未等到处理。
 */
const BARRIER_TIMEOUT_MS = 5_000
/**
 * 等待文件时间戳前进一个刻度的上限。刻度在 Linux 上按 HZ 为 1–10 ms，Windows 的时钟中断默认为
 * 15.6 ms；超时仍未前进的是秒级精度的文件系统（FAT、HFS+ 等）。
 */
const STAMP_TICK_LIMIT_MS = 20
const NO_STDIN = new Uint8Array(0)
let markerSeq = 0

/** 路径首次被报告时的磁盘状态。null = 首次报告时已不存在。 */
interface FirstSeen {
  bornInWindow: boolean
}

interface Window {
  /**
   * 本窗口开始拥有事件与扫描结果的时刻。新建 watcher 的窗口取 `stampTick` 的返回值，
   * 与文件时间戳取自同一个时钟；排队的窗口取前一个窗口收尾时的 `Date.now()`。
   */
  startedAt: number
  paths: Map<string, Promise<FirstSeen | null>>
  /** 事件命中运行产物目录而被剪枝时记录的目录，收尾时交由索引补齐。 */
  prunedDirs: Set<string>
}

interface Shared {
  watcher: FSWatcher
  windows: Window[]
  /** 包含工作区根的 Git 仓库根；null = 不在仓库中。 */
  repoRoot: string | null
  /** 工作区根相对仓库根的路径，使用 posix 分隔符；工作区即仓库根时为空串。 */
  prefix: string
  /** 等待中的事件屏障：标记文件的工作区相对路径 → 收到其事件（true）或 watcher 报错（false）。 */
  barriers: Map<string, (arrived: boolean) => void>
}

const shared = new Map<string, Shared>()

/**
 * 包含 `root` 的 Git 仓库根；不在仓库中时返回 null。
 *
 * 向上查找 `.git`，而不是启动 `git rev-parse`：判定仓库不应启动进程，进程只在收尾时启动。
 * 上界与 git 自身的发现规则取自同一来源 `GIT_CEILING_DIRECTORIES`，
 * 到达其中列出的目录即停止向上查找。`root` 是 realpath，条目也先取 realpath 再比较；
 * 不存在的条目不起作用，与 git 相同。
 */
function repoRootOf(root: string): string | null {
  const ceilings = new Set(
    (process.env.GIT_CEILING_DIRECTORIES ?? '')
      .split(delimiter)
      .filter((p) => p && existsSync(p))
      .map((p) => realpathSync.native(p)),
  )
  let dir = resolve(root)
  for (;;) {
    if (ceilings.has(dir)) return null
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * 路径段的处理方式。
 *
 * `hard` = 一律不报告也不补齐：版本库元数据与本项目的临时产物目录。
 * `pruned` = 不处理事件也不进入扫描，但记录目录名，在 Git 仓库中由索引补齐其中已跟踪的文件。
 * `.git` 同样在 `IGNORED_DIRS` 中，必须先判定 `hard`：交给索引补齐会把整个版本库报告为改动。
 */
function classifySegment(segment: string): 'hard' | 'pruned' | 'none' {
  if (segment === '.git' || segment === '.tmp') return 'hard'
  return IGNORED_DIRS.has(segment) ? 'pruned' : 'none'
}

/** 启动一个 git 子进程并收集其输出。返回 null = 进程未能启动。 */
async function runGit(
  repoRoot: string,
  args: string[],
  stdin: Uint8Array,
): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const proc = Bun.spawn(['git', '--no-optional-locks', ...args], {
      cwd: repoRoot,
      stdin,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    })
    const got = await collectProcess(proc, { timeoutMs: GIT_TIMEOUT_MS })
    return { exitCode: got.exitCode, stdout: got.stdout }
  } catch {
    // 本机未安装 git：`Bun.spawn` 未找到可执行文件时同步抛出异常。
    return null
  }
}

/** 把 NUL 分隔的仓库根相对路径转换为工作区相对路径。 */
function stripPrefix(stdout: string, prefix: string): string[] {
  const out: string[] = []
  for (const path of stdout.split('\0')) {
    if (path) out.push(prefix ? path.slice(prefix.length + 1) : path)
  }
  return out
}

/**
 * 候选中被 Git 忽略的路径（工作区相对）。返回 null = 判定未执行成功。
 *
 * `--no-optional-locks`：该查询会一并刷新索引，不加此参数时会争用 `index.lock`，
 * 用户同时在终端中执行的 `git commit` 会随机失败。
 */
async function gitIgnored(
  repoRoot: string,
  prefix: string,
  rels: string[],
): Promise<Set<string> | null> {
  gitProcessCount.checkIgnore++
  const payload = rels.map((rel) => (prefix ? `${prefix}/${rel}` : rel)).join('\0')
  // `-z` 使输入输出都按 NUL 分隔，路径原样传递：含空格、中文、换行的文件名
  // 在默认的按行分隔加引号格式下无法还原。
  const got = await runGit(
    repoRoot,
    ['check-ignore', '--stdin', '-z'],
    new TextEncoder().encode(`${payload}\0`),
  )
  // 0 = 有候选命中忽略规则，1 = 没有候选命中。其余退出码表示命令自身执行失败。
  if (got === null || (got.exitCode !== 0 && got.exitCode !== 1)) return null
  return new Set(stripPrefix(got.stdout, prefix))
}

/**
 * 被剪枝目录中已跟踪且 `mtime` 位于窗口内的文件。返回 null = 查询未执行成功。
 *
 * **磁盘上已不存在的一律丢弃，不要改为报告 deleted。** 索引中的残留项在此后每次收尾时
 * 都会被取回，且无法归属任何窗口，报告后每条命令都会向账本写入一条虚假删除。
 */
async function trackedInPruned(
  repoRoot: string,
  prefix: string,
  root: string,
  dirs: string[],
  since: number,
  until: number,
): Promise<string[] | null> {
  gitProcessCount.lsFiles++
  const paths = dirs.map((dir) => (prefix ? `${prefix}/${dir}` : dir))
  const got = await runGit(repoRoot, ['ls-files', '-z', '--', ...paths], NO_STDIN)
  if (got === null || got.exitCode !== 0) return null
  const touched: string[] = []
  await Promise.all(
    stripPrefix(got.stdout, prefix).map(async (rel) => {
      const s = await stat(join(root, rel)).catch(() => null)
      if (s && s.mtimeMs >= since && s.mtimeMs <= until) touched.push(rel)
    }),
  )
  return touched
}

/**
 * 新建的文本文件按内容计算行数；二进制文件（前 8 KiB 中含 NUL）或过大的文件不计算。
 * 返回 null = 不带行数。
 */
async function countCreated(abs: string, size: number): Promise<number | null> {
  if (size > MAX_COUNT_BYTES) return null
  const bytes = await readFile(abs)
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return null
  return bytes.length === 0 ? 0 : bytes.toString('utf8').split('\n').length
}

/** 收尾时该路径的变更；目录不计入。 */
async function describe(root: string, rel: string, since: number): Promise<FileChange | null> {
  const abs = join(root, rel)
  const s = await stat(abs)
  if (s.isDirectory()) return null
  // FSEvents 可能延迟投递窗口打开前的事件；ctime 用于保留修改后又恢复 mtime 的实际变更。
  if (Math.max(s.mtimeMs, s.ctimeMs) < since) return null
  if (s.birthtimeMs < since) return { path: rel, changeType: 'modified' }
  const lines = await countCreated(abs, s.size)
  return lines === null
    ? { path: rel, changeType: 'created' }
    : { path: rel, changeType: 'created', additions: lines, deletions: 0 }
}

async function firstSeen(root: string, rel: string, since: number): Promise<FirstSeen | null> {
  try {
    const s = await stat(join(root, rel))
    return { bornInWindow: s.birthtimeMs >= since }
  } catch {
    return null
  }
}

interface Walked {
  paths: string[]
  /** 命中运行产物目录清单、未进入遍历的目录。 */
  pruned: Set<string>
  /** 达到上限后停止，其余目录未扫描。 */
  truncated: boolean
}

/** 工作区中 mtime 位于 [since, until] 内的文件，路径为工作区相对、使用 posix 分隔符。 */
async function touchedSince(root: string, since: number, until: number): Promise<Walked> {
  const out: string[] = []
  const pruned = new Set<string>()
  const queue: string[] = ['']
  let seen = 0
  while (queue.length) {
    const rel = queue.pop() as string
    let entries: Dirent[]
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    const checks: Promise<void>[] = []
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) return { paths: out, pruned, truncated: true }
      const child = rel ? `${rel}/${entry.name}` : entry.name
      const skip = classifySegment(entry.name)
      if (entry.isDirectory()) {
        if (skip === 'pruned') pruned.add(child)
        else if (skip === 'none') queue.push(child)
        continue
      }
      if (!entry.isFile() || skip !== 'none') continue
      checks.push(
        stat(join(root, child)).then(
          (s) => {
            if (s.mtimeMs >= since && s.mtimeMs <= until) out.push(child)
          },
          () => {},
        ),
      )
    }
    await Promise.all(checks)
  }
  return { paths: out, pruned, truncated: false }
}

/**
 * 该批变更中出现过的父段。
 *
 * 用于判定目录：路径不存在时 stat 无法区分文件与目录，而删除整个目录时递归 watch
 * 会产生目录本身的事件，报告后结果中会多出一个已删除的虚假文件。
 * 文件不可能是另一路径的父段，因此同一批中作为父段出现的路径都是目录。
 */
function parentsOf(changes: FileChange[]): Set<string> {
  const out = new Set<string>()
  for (const c of changes) {
    for (let i = c.path.indexOf('/'); i > 0; i = c.path.indexOf('/', i + 1)) {
      out.add(c.path.slice(0, i))
    }
  }
  return out
}

/** `reported` 中此刻已不在磁盘上、且本窗口未观察到的路径，即本次被删除的文件。 */
async function goneFrom(
  root: string,
  reported: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Promise<string[]> {
  const out: string[] = []
  await Promise.all(
    [...reported].map(async (rel) => {
      if (seen.has(rel)) return
      const s = await stat(join(root, rel)).catch(() => null)
      if (!s) out.push(rel)
    }),
  )
  return out
}

/**
 * 文件时间戳越过当前刻度之后的第一个值，作为新建 watcher 的窗口起点。
 *
 * 在 `.tmp` 下反复改写同一个探针文件，直到其 mtime 大于首次写入时的值：此前写入的文件
 * 时间戳都不大于首次的值，此后写入的都不小于返回值，窗口两侧的写入不会处于同一个刻度。
 * 不要换成 `Date.now()`：文件时间戳按刻度取值，比它落后至多一个刻度，打开后同一刻度内新建的文件
 * 会判定为 modified；它又按毫秒取整，打开前同一毫秒内写入的文件会判定为窗口内新建。
 *
 * 在创建 watcher 之前调用，避免探针写入进入观察范围。探针无法写入时返回
 * `Date.now()`，收尾的屏障同样无法写入标记，结果标记为 `incomplete`；`STAMP_TICK_LIMIT_MS`
 * 内时间戳未前进时同样返回 `Date.now()`。
 */
function stampTick(root: string): number {
  const probe = join(root, '.tmp', `qywork-watch-${process.pid}-${++markerSeq}`)
  const deadline = Date.now() + STAMP_TICK_LIMIT_MS
  let stamp: number | null = null
  try {
    writeFileSync(probe, '')
    const first = statSync(probe).mtimeMs
    while (stamp === null && Date.now() < deadline) {
      writeFileSync(probe, '0')
      const now = statSync(probe).mtimeMs
      if (now > first) stamp = now
    }
    rmSync(probe, { force: true })
  } catch {
    // 无法写入时回退到 `Date.now()`；无法删除的探针留在 `.tmp` 中，该目录一律不报告。
  }
  return stamp ?? Date.now()
}

/**
 * 写入一个标记文件，等待 watcher 交付其事件。返回 false = 未等到：标记无法写入、watcher 已报错，
 * 或达到上限。`onSettled` 在等到或放弃时同步调用，排在标记之后交付的事件不再归属调用方。
 *
 * 标记放在 `.tmp` 下：该目录一律不报告，标记自身的事件不进入任何窗口。
 */
function barrier(root: string, owner: Shared, onSettled: () => void = () => {}): Promise<boolean> {
  if (shared.get(root) !== owner) {
    onSettled()
    return Promise.resolve(false)
  }
  const rel = `.tmp/qywork-watch-${process.pid}-${++markerSeq}`
  const abs = join(root, rel)
  return new Promise((resolve) => {
    const settle = (arrived: boolean) => {
      if (!owner.barriers.delete(rel)) return
      clearTimeout(timer)
      onSettled()
      void rm(abs, { force: true })
        .catch(() => {})
        .then(() => resolve(arrived))
    }
    const timer = setTimeout(() => settle(false), BARRIER_TIMEOUT_MS)
    owner.barriers.set(rel, settle)
    mkdir(join(root, '.tmp'), { recursive: true })
      .then(() => writeFile(abs, ''))
      .catch(() => settle(false))
  })
}

/**
 * 等待 `workspaceRoot` 上的 watcher 交付此刻之前发生的全部事件，并等待这些路径首次报告时的 stat 完成。
 * 返回 false = 没有打开的窗口，或未等到。
 *
 * 供测试在窗口打开期间建立「观察器已观察到某路径」这一前提；生产代码只经由 `close()` 使用该屏障。
 */
export async function settleEvents(workspaceRoot: string): Promise<boolean> {
  const root = realpathSync.native(workspaceRoot)
  const owner = shared.get(root)
  if (!owner) return false
  const arrived = await barrier(root, owner)
  await Promise.all(owner.windows.flatMap((w) => [...w.paths.values()]))
  return arrived
}

export function openChangeWindow(
  workspaceRoot: string,
  opts: ChangeWindowOptions = {},
): ChangeWindow {
  const root = realpathSync.native(workspaceRoot)
  const window: Window = { startedAt: Date.now(), paths: new Map(), prunedDirs: new Set() }
  let entry = shared.get(root)
  if (!entry) {
    const repoRoot = repoRootOf(root)
    const created: Shared = {
      windows: [],
      watcher: null as unknown as FSWatcher,
      repoRoot,
      prefix: repoRoot === null ? '' : relative(repoRoot, resolve(root)).replaceAll('\\', '/'),
      barriers: new Map(),
    }
    try {
      mkdirSync(join(root, '.tmp'), { recursive: true })
    } catch {
      // 创建失败时屏障无法写入标记，收尾结果标记为 incomplete。
    }
    // 排队的窗口不调用：它从前一个窗口收尾时才开始拥有事件，起点在移交时改写。
    window.startedAt = stampTick(root)
    created.watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (typeof filename !== 'string' || !filename) return
      const rel = filename.replaceAll('\\', '/')
      created.barriers.get(rel)?.(true)
      const owner = created.windows[0]
      if (!owner) return
      const segments = rel.split('/')
      let prunedAt: string | null = null
      for (const [i, segment] of segments.entries()) {
        const skip = classifySegment(segment)
        if (skip === 'hard') return
        if (skip === 'pruned' && prunedAt === null) prunedAt = segments.slice(0, i + 1).join('/')
      }
      if (prunedAt !== null) {
        owner.prunedDirs.add(prunedAt)
        return
      }
      if (owner.paths.has(rel)) return
      owner.paths.set(rel, firstSeen(root, rel, owner.startedAt))
    })
    created.watcher.on('error', () => {
      created.watcher.close()
      if (shared.get(root) === created) shared.delete(root)
      for (const settle of [...created.barriers.values()]) settle(false)
    })
    shared.set(root, created)
    entry = created
  }
  const owner = entry
  owner.windows.push(window)

  return {
    async close() {
      const closedAt = Date.now()
      const handOff = () => {
        owner.windows.splice(owner.windows.indexOf(window), 1)
        const next = owner.windows[0]
        if (next) next.startedAt = Math.max(next.startedAt, closedAt)
        else {
          owner.watcher.close()
          if (shared.get(root) === owner) shared.delete(root)
        }
      }
      // 事件只进入排在最前的窗口，只有该窗口需要等待在途事件。
      let settled = true
      if (owner.windows[0] === window) settled = await barrier(root, owner, handOff)
      else handOff()

      const until = closedAt + CLOCK_SLACK_MS
      const walked = await touchedSince(root, window.startedAt, until)
      const walkOnly = walked.paths.filter((rel) => !window.paths.has(rel))
      const prunedDirs = [...new Set([...window.prunedDirs, ...walked.pruned])]

      let incomplete = walked.truncated || !settled
      let tracked: string[] = []
      if (owner.repoRoot !== null && prunedDirs.length > 0) {
        const got = await trackedInPruned(
          owner.repoRoot,
          owner.prefix,
          root,
          prunedDirs,
          window.startedAt,
          until,
        )
        if (got === null) incomplete = true
        else tracked = got
      }

      const candidates = [...window.paths.keys(), ...walkOnly, ...tracked]
      const ignored =
        owner.repoRoot === null || candidates.length === 0
          ? new Set<string>()
          : await gitIgnored(owner.repoRoot, owner.prefix, candidates)
      if (ignored === null) incomplete = true
      const skip = ignored ?? new Set<string>()

      const changes: FileChange[] = []
      for (const [rel, seen] of window.paths) {
        const first = await seen
        if (skip.has(rel)) continue
        try {
          const change = await describe(root, rel, window.startedAt)
          if (change) changes.push(change)
        } catch {
          // 窗口内出现、收尾前消失：属于临时文件，而不是用户文件被删除。
          if (first?.bornInWindow) continue
          changes.push({ path: rel, changeType: 'deleted' })
        }
      }
      for (const rel of [...walkOnly, ...tracked]) {
        if (skip.has(rel)) continue
        const change = await describe(root, rel, window.startedAt).catch(() => null)
        if (change) changes.push(change)
      }
      if (opts.reported) {
        // 本轮报告过、本窗口两个来源都未观察到的路径按磁盘状态核对。这些路径上次报告时
        // 已经过忽略判定，不再重复判定。
        const seen = new Set([...window.paths.keys(), ...walkOnly, ...tracked])
        for (const rel of await goneFrom(root, opts.reported, seen)) {
          changes.push({ path: rel, changeType: 'deleted' })
        }
      }
      // 只对删除判定：仍在磁盘上的路径已由 `describe` 按 `stat` 排除了目录。
      const dirs = parentsOf(changes)
      return {
        changes: changes.filter((c) => c.changeType !== 'deleted' || !dirs.has(c.path)),
        incomplete,
      }
    },
  }
}
