/**
 * 执行期间工作区里改了哪些文件。给没有精确明细的执行器用：shell、外部 CLI。
 *
 * 三条来源合起来才完整：
 * - `fs.watch`（递归）收路径。**它会丢事件**：实测 Bun 在 Windows 上，同一批通知里「修改」
 *   后面紧跟「删除 / 改名」时前一条不见了，而 `sed -i`、原子保存正是这种写法。
 *   删除只有它看得见——文件没了，扫描扫不到。
 * - 收尾时扫一遍工作区，`mtime` 落在窗口内的就是改过的。扫描要 stat 每个文件；
 *   超过 `MAX_WALK_ENTRIES` 就停，此时结果按 `incomplete` 交出去。
 * - 调用方给的 `reported`：本轮之前已经报过的路径，收尾时逐个 stat 对账。
 *   整个目录被删时前两条都给不出其中的文件——递归 watch 只给目录一条事件
 *   （Windows 实测 `rm -rf d`：`d/a.txt` 与 `d` 有事件，`d/sub/b.txt` 没有），
 *   而扫描扫不到已经不存在的文件。不对账的话，这些文件停在最后一次看见的状态。
 *
 * 一个工作区根只开一个 `fs.watch`，窗口按打开先后排队；同一时刻有几个窗口开着时，
 * 事件与扫描结果都归最早打开的那个，后面的窗口从前一个收尾那一刻起才算自己的。
 * 并行执行时的归属因此是估算。
 *
 * **工作区根先取 realpath，watch、共享键、标记路径、扫描与 stat 都用它。** FSEvents 按真实路径
 * 报事件，watch 的路径经过符号链接时前缀对不上，一条事件都收不到，收尾的屏障只能等到上限。
 * 同一个目录的不同写法因此共用一个 watcher。结果里的路径相对工作区根，与调用方用哪种写法无关。
 * 必须用 `realpathSync.native`：Windows 上非 native 版保留调用方给的大小写，只差大小写的两种写法
 * 会各开一个 watcher。
 *
 * **收尾先等在途事件交齐，再交出归属。** 事件从发生到进回调有延迟（macOS 的 FSEvents 按 50 ms
 * 合批交付），收尾时直接关 watcher 或把事件改归下一个窗口，此前发生、尚未交付的事件就丢失或记错窗口。
 * 排在最前的窗口收尾时在 `<root>/.tmp` 下写一个唯一命名的标记文件，收到它的事件才交出归属：
 * FSEvents、inotify、ReadDirectoryChangesW 对同一个 watcher 都按发生顺序交付，标记之前的事件
 * 此时都已进回调。标记写不进去或到 `BARRIER_TIMEOUT_MS` 仍未收到，结果按 `incomplete` 交出。
 * `.tmp` 必须在建 watcher 之前建好：Linux 的递归 watch 由读线程给之后才出现的目录补挂监视，
 * 补挂之前写进去的标记没有事件。
 *
 * 拿不到改动前的内容，所以改过的与删掉的不带行数；新建的文本文件按落盘内容数行，
 * 口径与文件工具相同（`countDiff` 对空的旧内容：新内容按 `\n` 切开的段数）。
 * `changeType` 按收尾时的磁盘状态判：不存在 = deleted；创建时间在窗口内 = created；其余 modified。
 * 创建时间与窗口起点的比较受时间戳精度限制：Linux 的文件时间戳按内核时钟节拍取值，比 `Date.now()`
 * 落后至多一个节拍（WSL2 实测最多 5.3 ms，2026-09-25），窗口打开后一个节拍内新建的文件判为 modified。
 * 不要把窗口起点前移来抵消：连续两条命令之间只隔几毫秒，前移后上一条新建的文件在下一个窗口里判为 created。
 * 临时文件（窗口内建、收尾前删）不进结果，前提是观察器在它消失之前 stat 到过它：存在时间短于
 * 事件交付延迟的临时文件判为 deleted。原子保存（写临时文件再改名）会被判成 created。
 * 结果里只有文件：仍在磁盘上的按 `stat` 判，已经不在的按同一批里有没有路径以它为父段判。
 *
 * **哪些路径不报告由 Git 裁决，事件收集与收尾扫描共用这一条策略。**
 * 任何路径段是 `.git`（版本库元数据）或 `.tmp`（本项目的临时产物目录）的一律不报；
 * 其余候选在窗口收尾时一次性交给 `git check-ignore --stdin -z`（按仓库根执行），
 * 命中忽略规则的丢掉。**不要另写一层「这个文件跟踪了没有」的判断**：`check-ignore`
 * 默认查索引，已跟踪的路径即使命中忽略模式也不报告，加 `--no-index` 才会。
 * 非 Git 目录没有忽略规则可依，`IGNORED_DIRS` 这份运行产物目录清单就是全部依据，
 * 其余路径包括点路径照报。
 *
 * **`IGNORED_DIRS` 目录在 Git 仓库里只经索引观察，其中未跟踪的文件不报告。**
 * 剪枝是性能手段——收尾扫描进 `node_modules` 要 stat 全仓，本仓实测约 470 ms 对约 15 ms；
 * 覆盖由索引补齐：收尾时对被剪掉的目录起一次 `git ls-files -z`，取回其中已跟踪的文件，
 * `mtime` 落在窗口内的进候选。**被剪目录里的删除不报告**：那里没有事件可依，
 * 索引里的残留项（文件已删、没跑过 `git rm`）归不到任何一个窗口，报出来就是每个窗口一条假删除。
 *
 * **不要按文件名前缀推断用途。** 点开头的既有浏览器 profile 与缓存，也有
 * `.github/workflows`、`.gitignore`、`.editorconfig` 和用户自己的点目录，
 * 按前缀排除会把项目文件一并丢掉。
 */

import { type Dirent, existsSync, type FSWatcher, mkdirSync, realpathSync, watch } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import type { FileChange } from '@qywork/core'
import { IGNORED_DIRS } from './paths.ts'
import { collectProcess } from './sandbox.ts'

/** 一个执行窗口看到的工作区变更。 */
export interface ObservedChanges {
  changes: FileChange[]
  /**
   * 观察范围不完整：收尾时没等到在途事件交齐，Git 判定没跑成，或收尾扫描到界停止。
   *
   * 调用方**必须**把它说给上游——不说的话，一次没跑完的过滤与一次真的没有改动
   * 在结果里长得一模一样。
   */
  incomplete: boolean
}

export interface ChangeWindow {
  /** 收尾：停止归集，按此刻磁盘状态判每个路径的变更类型。 */
  close(): Promise<ObservedChanges>
}

export interface ChangeWindowOptions {
  /**
   * 本轮之前各窗口报过 created / modified 的工作区相对路径。
   *
   * 调用方自己维护这份累计集合：报过的加进去、报成 deleted 的移出来。
   * 只放文件路径——目录从来不进结果，也就不会从这条来源报出删除。
   */
  reported?: ReadonlySet<string>
}

/**
 * 按种类计的 git 子进程数。只增不减。
 *
 * 供测试断言一个窗口收尾最多起两个进程，且多少次 fs 事件都不增加；生产代码不读它。
 */
export const gitProcessCount = { checkIgnore: 0, lsFiles: 0 }

const MAX_WALK_ENTRIES = 50_000
/** 数行只读这么大以内的文件：更大的通常是产物或数据，行数对它没有意义。 */
const MAX_COUNT_BYTES = 4 * 1024 * 1024
/** 文件时间戳允许比本机时钟快这么多；再往后的是时钟不对的文件，不能每次都算成改过。 */
const CLOCK_SLACK_MS = 1_000
/** 单次 git 查询的时长上限。到点树杀，结果按判定没跑成处理。 */
const GIT_TIMEOUT_MS = 15_000
/**
 * 等标记事件的上限。正常交付在毫秒级，macOS 上多出至多一个 50 ms 合批周期；
 * 到点仍未收到按没等到处理。
 */
const BARRIER_TIMEOUT_MS = 5_000
const NO_STDIN = new Uint8Array(0)
let markerSeq = 0

/** 一个路径第一次被报上来时的磁盘状态。null = 那一刻已不存在。 */
interface FirstSeen {
  bornInWindow: boolean
}

interface Window {
  /** 本窗口开始拥有事件与扫描结果的时刻：排在最前时是打开时刻，否则是前一个窗口收尾的时刻。 */
  startedAt: number
  paths: Map<string, Promise<FirstSeen | null>>
  /** 事件命中运行产物目录而被剪掉时记下的目录，收尾时交给索引补齐。 */
  prunedDirs: Set<string>
}

interface Shared {
  watcher: FSWatcher
  windows: Window[]
  /** 含工作区根的 Git 仓库根；null = 不在仓库里。 */
  repoRoot: string | null
  /** 工作区根相对仓库根的位置，posix 分隔符；工作区就是仓库根时为空串。 */
  prefix: string
  /** 在等的事件屏障：标记文件的工作区相对路径 → 收到它的事件（true）或 watcher 报错（false）。 */
  barriers: Map<string, (arrived: boolean) => void>
}

const shared = new Map<string, Shared>()

/**
 * 含 `root` 的 Git 仓库根；不在仓库里回 null。
 *
 * 向上找 `.git` 而不是起 `git rev-parse`：判仓库不该起进程，进程只在收尾时起。
 * 上界与 git 自己的发现规则取同一个来源 `GIT_CEILING_DIRECTORIES`，
 * 列在里面的目录不再往上走。`root` 是 realpath，条目也取 realpath 再比较；
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
 * 这一段路径怎么处理。
 *
 * `hard` = 一律不报也不补：版本库元数据与本项目的临时产物目录。
 * `pruned` = 不走事件也不进扫描，但目录名记下来，Git 仓库里由索引补齐其中已跟踪的文件。
 * `.git` 同在 `IGNORED_DIRS` 里，必须先判 `hard`——把它交给索引补齐等于把整个版本库报成改动。
 */
function classifySegment(segment: string): 'hard' | 'pruned' | 'none' {
  if (segment === '.git' || segment === '.tmp') return 'hard'
  return IGNORED_DIRS.has(segment) ? 'pruned' : 'none'
}

/** 起一个 git 子进程并收回它写的字节。返回 null = 它没跑起来。 */
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
    // 这台机器上没装 git：`Bun.spawn` 找不到可执行文件是同步抛。
    return null
  }
}

/** NUL 分隔的仓库根相对路径，转回工作区相对。 */
function stripPrefix(stdout: string, prefix: string): string[] {
  const out: string[] = []
  for (const path of stdout.split('\0')) {
    if (path) out.push(prefix ? path.slice(prefix.length + 1) : path)
  }
  return out
}

/**
 * 候选里被 Git 忽略的那些，工作区相对路径。返回 null = 判定没跑成。
 *
 * `--no-optional-locks`：这条查询会一并刷新索引，不加就会去抢 `index.lock`，
 * 用户同时在终端里 `git commit` 会随机失败。
 */
async function gitIgnored(
  repoRoot: string,
  prefix: string,
  rels: string[],
): Promise<Set<string> | null> {
  gitProcessCount.checkIgnore++
  const payload = rels.map((rel) => (prefix ? `${prefix}/${rel}` : rel)).join('\0')
  // `-z` 让输入输出都按 NUL 分隔，路径原样进出：带空格、中文、换行的文件名
  // 在默认的行分隔加引号格式下解析不回来。
  const got = await runGit(
    repoRoot,
    ['check-ignore', '--stdin', '-z'],
    new TextEncoder().encode(`${payload}\0`),
  )
  // 0 = 有候选命中忽略规则，1 = 一条都没命中。其余是它自己没跑成。
  if (got === null || (got.exitCode !== 0 && got.exitCode !== 1)) return null
  return new Set(stripPrefix(got.stdout, prefix))
}

/**
 * 被剪掉的目录里已跟踪、且 `mtime` 落在窗口内的文件。返回 null = 查询没跑成。
 *
 * **磁盘上已经不在的一律丢掉，不要改成报 deleted。** 索引里的残留项在此后每一次收尾
 * 都会被取回来，而它归不到任何一个窗口，报出来就是每条命令往账本灌一条假删除。
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
 * 新建的文本文件按内容数行；二进制（前 8 KiB 里有 NUL）或过大的不数。
 * 返回 null = 不带行数。
 */
async function countCreated(abs: string, size: number): Promise<number | null> {
  if (size > MAX_COUNT_BYTES) return null
  const bytes = await readFile(abs)
  const head = bytes.subarray(0, 8192)
  if (head.includes(0)) return null
  return bytes.length === 0 ? 0 : bytes.toString('utf8').split('\n').length
}

/** 收尾时这个路径的变更事实；目录不算。 */
async function describe(root: string, rel: string, since: number): Promise<FileChange | null> {
  const abs = join(root, rel)
  const s = await stat(abs)
  if (s.isDirectory()) return null
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
  /** 命中运行产物目录清单、没有走进去的目录。 */
  pruned: Set<string>
  /** 到界停止，剩下的目录没扫。 */
  truncated: boolean
}

/** 工作区里 mtime 落在 [since, until] 内的文件，工作区相对、posix 分隔符。 */
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
 * 这批变更里出现过的父段。
 *
 * 判目录用的：路径不存在时 stat 问不出它是文件还是目录，而删掉整个目录时递归 watch
 * 会给出目录本身那一条事件，报出去就是一行「已删除」的假文件。
 * 文件不可能是另一个路径的父段，所以同一批里被当成父段的那些是目录。
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

/** `reported` 里此刻已经不在磁盘上、而本窗口又没见到的那些：这次被删的。 */
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
 * 写一个标记文件，等 watcher 交出它的事件。返回 false = 没等到：标记写不进去、watcher 已报错，
 * 或到了上限。`onSettled` 在等到或放弃的那一刻同步调用，排在标记之后交付的事件已不归调用方。
 *
 * 标记放在 `.tmp` 下：这一段一律不报，标记自己的事件不进任何窗口。
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
 * 等 `workspaceRoot` 上的 watcher 交齐此刻之前发生的事件，并等这些路径第一次被报上来时的 stat 做完。
 * 返回 false = 没有开着的窗口，或没等到。
 *
 * 供测试在窗口中途建立「观察器已见过某个路径」这一前提；生产代码只经 `close()` 用这道屏障。
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
      // 建不成时屏障写不进标记，收尾按 incomplete 交出。
    }
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
      // 事件只进排在最前的窗口，只有它要等在途事件。
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
          // 窗口内才出现、收尾前又没了：临时文件，不是用户的文件被删。
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
        // 本轮报过、本窗口两条来源都没见到的路径按磁盘对账。这些路径上一次报出时
        // 已经过了忽略判定，不再判一次。
        const seen = new Set([...window.paths.keys(), ...walkOnly, ...tracked])
        for (const rel of await goneFrom(root, opts.reported, seen)) {
          changes.push({ path: rel, changeType: 'deleted' })
        }
      }
      // 只对删除判一次：还在磁盘上的那些，`describe` 已经按 `stat` 把目录挡掉了。
      const dirs = parentsOf(changes)
      return {
        changes: changes.filter((c) => c.changeType !== 'deleted' || !dirs.has(c.path)),
        incomplete,
      }
    },
  }
}
