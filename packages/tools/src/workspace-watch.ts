/**
 * 执行期间工作区里改了哪些文件。给没有精确明细的执行器用：shell、外部 CLI。
 *
 * 两条来源合起来才完整：
 * - `fs.watch`（递归）收路径。**它会丢事件**：实测 Bun 在 Windows 上，同一批通知里「修改」
 *   后面紧跟「删除 / 改名」时前一条不见了，而 `sed -i`、原子保存正是这种写法。
 *   删除只有它看得见——文件没了，扫描扫不到。
 * - 收尾时扫一遍工作区，`mtime` 落在窗口内的就是改过的。扫描要 stat 每个文件，本仓
 *   （约六千个文件，跳过噪音目录）实测约 200 ms；超过 `MAX_WALK_ENTRIES` 停止，
 *   之后只剩事件那份，结果可能不全。
 *
 * 一个工作区根只开一个 `fs.watch`，窗口按打开先后排队；同一时刻有几个窗口开着时，
 * 事件与扫描结果都归最早打开的那个，后面的窗口从前一个收尾那一刻起才算自己的。
 * 并行执行时的归属因此是估算。
 *
 * 拿不到改动前的内容，所以改过的与删掉的不带行数；新建的文本文件按落盘内容数行，
 * 口径与文件工具相同（`countDiff` 对空的旧内容：新内容按 `\n` 切开的段数）。
 * `changeType` 按收尾时的磁盘状态判：不存在 = deleted；创建时间在窗口内 = created；其余 modified。
 * 临时文件（窗口内建、收尾前删）不进结果；原子保存（写临时文件再改名）会被判成 created。
 *
 * 跳过 `IGNORED_DIRS` 与任何以点开头的路径段：构建期间 dist / node_modules 会报成千上万条；
 * 点开头的是工具与运行时的状态（浏览器 profile、缓存、虚拟环境、脚本的临时标记），一条命令
 * 起个 headless chrome 就往 `.chk/` 写几千个文件，它们不是项目改动。
 * 工具直接写的隐藏路径（记忆、技能、`.env`）由工具自己带精确明细，不经这里。
 */

import { type Dirent, type FSWatcher, watch } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'
import { IGNORED_DIRS } from './paths.ts'

export interface ChangeWindow {
  /** 收尾：停止归集，按此刻磁盘状态判每个路径的变更类型。 */
  close(): Promise<FileChange[]>
}

const MAX_WALK_ENTRIES = 50_000
/** 数行只读这么大以内的文件：更大的通常是产物或数据，行数对它没有意义。 */
const MAX_COUNT_BYTES = 4 * 1024 * 1024
/** 文件时间戳允许比本机时钟快这么多；再往后的是时钟不对的文件，不能每次都算成改过。 */
const CLOCK_SLACK_MS = 1_000

/** 一个路径第一次被报上来时的磁盘状态。null = 那一刻已不存在。 */
interface FirstSeen {
  bornInWindow: boolean
}

interface Window {
  /** 本窗口开始拥有事件与扫描结果的时刻：排在最前时是打开时刻，否则是前一个窗口收尾的时刻。 */
  startedAt: number
  paths: Map<string, Promise<FirstSeen | null>>
}

interface Shared {
  watcher: FSWatcher
  windows: Window[]
}

const shared = new Map<string, Shared>()

/** 任一段命中噪音清单或以点开头就跳过。 */
function ignored(rel: string): boolean {
  return rel.split('/').some((segment) => IGNORED_DIRS.has(segment) || segment.startsWith('.'))
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

/** 工作区里 mtime 落在 [since, until] 内的文件，工作区相对、posix 分隔符。 */
async function touchedSince(root: string, since: number, until: number): Promise<string[]> {
  const out: string[] = []
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
      if (++seen > MAX_WALK_ENTRIES) return out
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(child)
        continue
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue
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
  return out
}

export function openChangeWindow(root: string): ChangeWindow {
  const window: Window = { startedAt: Date.now(), paths: new Map() }
  let entry = shared.get(root)
  if (!entry) {
    const created: Shared = { windows: [], watcher: null as unknown as FSWatcher }
    created.watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (typeof filename !== 'string' || !filename) return
      const rel = filename.replaceAll('\\', '/')
      if (ignored(rel)) return
      const owner = created.windows[0]
      if (!owner || owner.paths.has(rel)) return
      owner.paths.set(rel, firstSeen(root, rel, owner.startedAt))
    })
    created.watcher.on('error', () => {
      created.watcher.close()
      if (shared.get(root) === created) shared.delete(root)
    })
    shared.set(root, created)
    entry = created
  }
  const owner = entry
  owner.windows.push(window)

  return {
    async close() {
      const closedAt = Date.now()
      owner.windows.splice(owner.windows.indexOf(window), 1)
      const next = owner.windows[0]
      if (next) next.startedAt = Math.max(next.startedAt, closedAt)
      else {
        owner.watcher.close()
        if (shared.get(root) === owner) shared.delete(root)
      }

      const out: FileChange[] = []
      const done = new Set<string>()
      for (const [rel, seen] of window.paths) {
        const first = await seen
        done.add(rel)
        try {
          const change = await describe(root, rel, window.startedAt)
          if (change) out.push(change)
        } catch {
          // 窗口内才出现、收尾前又没了：临时文件，不是用户的文件被删。
          if (first?.bornInWindow) continue
          out.push({ path: rel, changeType: 'deleted' })
        }
      }
      for (const rel of await touchedSince(root, window.startedAt, closedAt + CLOCK_SLACK_MS)) {
        if (done.has(rel)) continue
        const change = await describe(root, rel, window.startedAt).catch(() => null)
        if (change) out.push(change)
      }
      return out
    },
  }
}
