/**
 * 用量账本。
 *
 * `runs` 上的 usage 回答的是「这一轮花了多少」；账本回答的是
 * 「这个月花了多少」「哪个模型最贵」「这个工作区烧了多少」。
 * 后者没法从 `runs` 查出来，因为**删会话是正常操作，而账目不该跟着消失**。
 *
 * 所以账本不设外键：`run_id` / `conversation_id` 只是线索，指向的行没了不影响账目成立。
 */

import { newUsageId } from '@qywork/core'
import type { Store } from './db.ts'

/**
 * 花钱的种类。
 *
 * 每一条都是**独立于 run 的一笔开销**，不加进来就意味着那笔钱在界面上不存在。
 * `summary`（压缩时的摘要调用）就吃过这个亏：它在账本出现之前完全看不见，
 * 压缩越频繁账单和界面差得越多。
 *
 * `classifier` 是权限裁决的那次小模型调用。它按**每条待判命令**计费，
 * 频次可能比 run 本身高一个量级，所以必须能单独查——
 * `qy usage --by kind` 才答得出「裁决占了多少」，以及要不要换个更小的模型。
 */
export type UsageKind = 'run' | 'summary' | 'team' | 'classifier'

export interface UsageEntry {
  kind: UsageKind
  /** 有 run 的记 run；摘要调用没有 run，留空。 */
  runId?: string | null
  conversationId?: string | null
  workspaceId?: string | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  /** null = provider 未回报，与真实 0 命中是两回事。 */
  cachedTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number
  costUsd: number
  occurredAt?: number
}

/**
 * 记一笔。
 *
 * 同一个 run 重复记会被唯一索引挡住——这里**吞掉那个冲突**而不是抛：
 * 账本是旁路记账，它不该让一次已经跑完的 run 在收尾时失败。
 * 但也不能静默到毫无痕迹，所以返回是否真的写进去了。
 */
export function recordUsage(store: Store, entry: UsageEntry): boolean {
  try {
    store.db
      .query(
        `INSERT INTO usage_ledger
           (id, kind, run_id, conversation_id, workspace_id, model, provider,
            input_tokens, output_tokens, cached_tokens, cache_write_tokens,
            reasoning_tokens, cost_usd, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newUsageId(),
        entry.kind,
        entry.runId ?? null,
        entry.conversationId ?? null,
        entry.workspaceId ?? null,
        entry.model,
        entry.provider,
        entry.inputTokens,
        entry.outputTokens,
        entry.cachedTokens ?? null,
        entry.cacheWriteTokens ?? null,
        entry.reasoningTokens ?? 0,
        entry.costUsd,
        entry.occurredAt ?? Date.now(),
      )
    return true
  } catch (err) {
    // 这个 catch 原本写的是 `catch {}`，意图只有一条：**唯一索引冲突 = 这笔已经记过了**
    // （收尾逻辑被走两遍时不该让账目翻倍）。
    //
    // 但它把**所有**错误一起吞了，于是踩过一次很难查的事：给 kind 加了新值
    // `classifier`，忘了 schema 上有 CHECK 约束，插入直接抛——而这里静默 return false。
    // 现象是分类器正常工作、命令正常放行、账本里一行都没有，任何地方都不报错。
    //
    // 所以现在只吞它本来要吞的那一种，其余一律说出来。
    // **仍然不抛**：账本是旁路记账，不该让一次已经跑完的 run 在收尾时失败——
    // 但「不失败」不等于「不吭声」。
    const msg = err instanceof Error ? err.message : String(err)
    if (!/UNIQUE constraint failed/i.test(msg)) {
      process.stderr.write(`[qy] 记账失败（kind=${entry.kind}）：${msg}\n`)
    }
    return false
  }
}

export interface UsageQuery {
  /** 起始时间（含）。不传 = 从头。 */
  since?: number
  /** 结束时间（不含）。不传 = 到现在。 */
  until?: number
  workspaceId?: string
  kind?: UsageKind
}

export interface UsageTotals {
  entries: number
  inputTokens: number
  outputTokens: number
  /** null = 这段区间里没有任何一笔回报过缓存。不要显示成 0。 */
  cachedTokens: number | null
  reasoningTokens: number
  costUsd: number
}

export interface UsageBucket extends UsageTotals {
  /** 分组键：模型名 / 日期 / 工作区 id。 */
  key: string
}

function where(q: UsageQuery): { sql: string; args: (string | number)[] } {
  const parts: string[] = []
  const args: (string | number)[] = []
  if (q.since !== undefined) {
    parts.push('occurred_at >= ?')
    args.push(q.since)
  }
  if (q.until !== undefined) {
    parts.push('occurred_at < ?')
    args.push(q.until)
  }
  if (q.workspaceId) {
    parts.push('workspace_id = ?')
    args.push(q.workspaceId)
  }
  if (q.kind) {
    parts.push('kind = ?')
    args.push(q.kind)
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args }
}

interface RawTotals {
  n: number
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  cached_reports: number
  reasoning_tokens: number | null
  cost_usd: number | null
}

const TOTAL_COLS = `COUNT(*) AS n,
   SUM(input_tokens) AS input_tokens,
   SUM(output_tokens) AS output_tokens,
   SUM(cached_tokens) AS cached_tokens,
   COUNT(cached_tokens) AS cached_reports,
   SUM(reasoning_tokens) AS reasoning_tokens,
   SUM(cost_usd) AS cost_usd`

function shape(r: RawTotals): UsageTotals {
  return {
    entries: r.n,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    // SUM 会把全 NULL 也算成 NULL，但「有几笔回报过」要单独数——
    // 一笔都没回报时必须是 null，否则界面上会显示「缓存命中 0」，
    // 而那是个具体但错误的结论。
    cachedTokens: r.cached_reports > 0 ? (r.cached_tokens ?? 0) : null,
    reasoningTokens: r.reasoning_tokens ?? 0,
    costUsd: r.cost_usd ?? 0,
  }
}

export function usageTotals(store: Store, q: UsageQuery = {}): UsageTotals {
  const w = where(q)
  const row = store.db
    .query<RawTotals, (string | number)[]>(`SELECT ${TOTAL_COLS} FROM usage_ledger ${w.sql}`)
    .get(...w.args)
  return shape(row ?? ({ n: 0, cached_reports: 0 } as RawTotals))
}

export type GroupBy = 'model' | 'day' | 'workspace' | 'kind'

const GROUP_EXPR: Record<GroupBy, string> = {
  model: 'model',
  // 按**本地日**分组。用 SQLite 的 localtime 而不是 UTC：用户问「今天花了多少」
  // 问的是自己那天，UTC 分组会让晚上八点之后的花费算到「明天」。
  day: "strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', 'localtime')",
  workspace: "COALESCE(workspace_id, '(无)')",
  kind: 'kind',
}

export function usageBy(store: Store, by: GroupBy, q: UsageQuery = {}): UsageBucket[] {
  const w = where(q)
  const expr = GROUP_EXPR[by]
  const rows = store.db
    .query<RawTotals & { key: string }, (string | number)[]>(
      `SELECT ${expr} AS key, ${TOTAL_COLS} FROM usage_ledger ${w.sql}
       GROUP BY key ORDER BY cost_usd DESC, key ASC`,
    )
    .all(...w.args)
  return rows.map((r) => ({ key: r.key, ...shape(r) }))
}

/** 删掉某个时间点之前的账目。用户要清账时用，不是自动 GC。 */
export function pruneUsage(store: Store, before: number): number {
  const r = store.db.query('DELETE FROM usage_ledger WHERE occurred_at < ?').run(before)
  return Number(r.changes ?? 0)
}
