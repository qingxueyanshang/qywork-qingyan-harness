/**
 * 遍历目录的工具（list_dir、glob、grep）共用的上限、遍历与截断说明。
 *
 * 读取范围不限于根目录，起点可以是家目录或整个盘。三个工具在任意大的目录上都必须在有界的时间与内存内返回：
 * - glob 与 grep 的遍历（`walkFiles`）：条数达到上限即停止，不遍历完再截断；超过时限即停止，返回已得结果；
 *   每读取一个目录、每处理一个条目之前检查停止信号；无法读取的目录跳过，不使整次调用失败。
 * - grep 的 rg 子进程使用同一个时限（`Scan.remainingMs`），输出足够时即终止。
 * - list_dir 只读取一个目录，返回量不超过 `SCAN_LIMITS.entries`。
 * 结果不完整时回执写明原因与缩小范围的方法（`truncationNote`），并按投递额度裁剪（`fitBudget`）。
 */

import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  chargeBatchBudget,
  deliveredTokens,
  recordBatchSpent,
  type ToolContext,
} from '@qywork/agent'

export const SCAN_LIMITS = {
  /** glob 与 grep 返回的最多条数。 */
  results: 200,
  /** list_dir 返回的最多条目数。工作区中的目录通常远少于该数，系统目录可达数万项。 */
  entries: 1000,
  /**
   * 一次调用遍历目录的时限（毫秒），远大于工作区内一次搜索的耗时。实测（2026-11-15）：rg 搜索本机家目录约
   * 1.2 秒；`Bun.Glob.scan` 遍历同一目录 15 至 38 秒；逐个读取文件的内置遍历超过 120 秒仍未结束。
   */
  timeMs: 30_000,
} as const

/** 遍历提前停止的原因：条数达到上限，或超过时限。 */
export type ScanStop = 'limit' | 'time'

/** 一次调用的遍历状态。每次调用开始时由 `startScan` 建立，rg 与内置遍历共用同一个时限。 */
export interface Scan {
  readonly signal: AbortSignal
  /** 遍历停止的原因；完整遍历时为 null。 */
  readonly stopped: ScanStop | null
  /** 处理下一个条目之前调用。停止信号已触发时抛出；已停止或超过时限时返回 false。 */
  next(): boolean
  /** 记录停止原因。先记录的原因保留。 */
  stop(reason: ScanStop): void
  /** 距时限的剩余毫秒数，不小于 0。交给子进程作为其总时限。 */
  remainingMs(): number
}

export function startScan(signal: AbortSignal, now: () => number = () => performance.now()): Scan {
  const deadline = now() + SCAN_LIMITS.timeMs
  let stopped: ScanStop | null = null
  return {
    signal,
    get stopped() {
      return stopped
    },
    next() {
      signal.throwIfAborted()
      if (stopped === null && now() >= deadline) stopped = 'time'
      return stopped === null
    },
    stop(reason) {
      stopped ??= reason
    },
    remainingMs: () => Math.max(0, deadline - now()),
  }
}

/** 遍历使用的目录读取，与 `readdir(dir, { withFileTypes: true })` 的结果形状相同。 */
export type ReadDir = (
  dir: string,
) => Promise<readonly Pick<Dirent, 'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>[]>

const readEntries: ReadDir = (dir) => readdir(dir, { withFileTypes: true })

export interface ScanEntry {
  abs: string
  /** 相对遍历起点、以 / 分隔的路径。 */
  rel: string
  name: string
  /** 相对遍历起点的层数，起点之下的条目为 1。 */
  depth: number
  /** 符号链接或目录联接。遍历不进入链接指向的目录。 */
  link: boolean
}

/**
 * 深度优先遍历 `start` 之下的文件与链接，按目录读取的顺序产出。`descend(name, depth)` 决定是否进入子目录。
 *
 * 不要改用 `Bun.Glob.scan` 或递归的 `readdir`：前者遇到一个无法读取的目录即整体抛出，且在产出下一项之前
 * 无法中止，没有匹配项时会一直遍历到结束；后者同样只能在全部读取完成后返回。
 */
export async function* walkFiles(
  start: string,
  scan: Scan,
  descend: (name: string, depth: number) => boolean,
  readDir: ReadDir = readEntries,
): AsyncGenerator<ScanEntry> {
  yield* walkDir(start, '', 0, scan, descend, readDir)
}

async function* walkDir(
  dir: string,
  rel: string,
  depth: number,
  scan: Scan,
  descend: (name: string, depth: number) => boolean,
  readDir: ReadDir,
): AsyncGenerator<ScanEntry> {
  if (!scan.next()) return
  const entries = await readDir(dir).catch(() => null)
  if (entries === null) return
  for (const e of entries) {
    if (!scan.next()) return
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (descend(e.name, depth + 1)) {
        yield* walkDir(abs, childRel, depth + 1, scan, descend, readDir)
      }
      continue
    }
    if (e.isFile() || e.isSymbolicLink()) {
      yield { abs, rel: childRel, name: e.name, depth: depth + 1, link: e.isSymbolicLink() }
    }
  }
}

/**
 * 结果不完整时回执末尾的说明：原因与缩小范围的方法（`narrow`）。结果完整时为空串。
 * `cap` 是该工具的条数上限。
 */
export function truncationNote(
  stopped: ScanStop | null,
  trimmed: boolean,
  cap: number,
  narrow: string,
): string {
  const reason =
    stopped === 'time'
      ? `遍历超过 ${SCAN_LIMITS.timeMs / 1000} 秒时限后停止，只返回已找到的部分`
      : stopped === 'limit'
        ? `结果超过 ${cap} 条上限，只返回其中一部分`
        : trimmed
          ? '已按上下文剩余空间截断'
          : null
  return reason === null ? '' : `，${reason}；${narrow}`
}

/**
 * 按本次决策的剩余额度裁剪结果列表，并记录实际用量。
 *
 * 三个工具都是 `parallelSafe`：一次决策中多个调用不记录用量时，同一决策中的后续读取会按虚高的余额准入。
 * 裁剪而不是拒绝：少返回几条与条数上限属于同一种截断，改为失败会使模型只能推测并换用更窄的范围重试。
 */
export function fitBudget(
  ctx: ToolContext,
  items: string[],
): { items: string[]; trimmed: boolean } {
  const total = deliveredTokens(items.join('\n'), ctx.density)
  const charged = chargeBatchBudget(ctx, total)
  if (charged.ok) return { items, trimmed: false }

  const room = charged.cap
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    // +1 是行分隔符：不计入时，条数较多时的累计误差会导致超出预算。
    const n = deliveredTokens(item, ctx.density) + 1
    // 第一条超出余量时也返回：不返回任何条目等于告知模型没有结果。
    if (kept.length > 0 && used + n > room) break
    kept.push(item)
    used += n
  }
  if (!chargeBatchBudget(ctx, used).ok) recordBatchSpent(ctx, used)
  return { items: kept, trimmed: kept.length < items.length }
}
