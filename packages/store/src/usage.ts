/**
 * 用量账本。
 *
 * `runs` 上的 usage 回答的是「这一轮花了多少」；账本回答的是
 * 「这个月花了多少」「哪个模型最贵」「这个工作区烧了多少」。
 * 后者没法从 `runs` 查出来，因为**删会话是正常操作，而账目不该跟着消失**。
 *
 * 所以账本不设外键：`run_id` / `conversation_id` 只是线索，指向的行没了不影响账目成立。
 */

import type { Currency, UsageBucket, UsageKind, UsageLedgerRow, UsageTotals } from '@qywork/core'
import { newUsageId } from '@qywork/core'
import type { Store } from './db.ts'

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
  cost: number
  /** 上面那个数字的币种。省略即 USD。**不换算**，各币种分开合计。 */
  currency?: Currency
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
            reasoning_tokens, cost, currency, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        entry.cost,
        entry.currency ?? 'USD',
        entry.occurredAt ?? Date.now(),
      )
    return true
  } catch (err) {
    // **这个 catch 只吞一种错：唯一索引冲突 = 这笔已经记过了**
    // （收尾逻辑被走两遍时不该让账目翻倍）。
    //
    // 写成 `catch {}` 会把**所有**错误一起吞掉，因此有一类很难查的故障：给 kind 加新值
    // （如 `classifier`）而 schema 上的 CHECK 约束没跟着改，插入直接抛——
    // 而这里静默 return false。
    // 现象是分类器正常工作、命令正常放行、账本里一行都没有，任何地方都不报错。
    //
    // 所以只吞那一种，其余一律说出来。
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
  /**
   * 只看这一条会话。**它包含这条会话引发的全部开销**，不只是对话轮次——
   * 压缩摘要那次调用同样带着会话 id 落账（`makeSummarizer`），
   * 「这条会话花了多少」要的就是这个口径。
   */
  conversationId?: string
  kind?: UsageKind
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
  if (q.conversationId) {
    parts.push('conversation_id = ?')
    args.push(q.conversationId)
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
  cache_write_tokens: number | null
  cache_write_reports: number
  reasoning_tokens: number | null
}

const TOTAL_COLS = `COUNT(*) AS n,
   SUM(input_tokens) AS input_tokens,
   SUM(output_tokens) AS output_tokens,
   SUM(cached_tokens) AS cached_tokens,
   COUNT(cached_tokens) AS cached_reports,
   SUM(cache_write_tokens) AS cache_write_tokens,
   COUNT(cache_write_tokens) AS cache_write_reports,
   SUM(reasoning_tokens) AS reasoning_tokens`

function shape(r: RawTotals): UsageTotals {
  return {
    entries: r.n,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    // SUM 会把全 NULL 也算成 NULL，但「有几笔回报过」要单独数——
    // 一笔都没回报时必须是 null，否则界面上会显示「缓存命中 0」，
    // 而那是个具体但错误的结论。
    cachedTokens: r.cached_reports > 0 ? (r.cached_tokens ?? 0) : null,
    // 同上：一笔都没回报过时是 null，不是 0。缓存写入按「建缓存付了多少」计价，
    // 和命中是两笔，界面上分开显示。
    cacheWriteTokens: r.cache_write_reports > 0 ? (r.cache_write_tokens ?? 0) : null,
    reasoningTokens: r.reasoning_tokens ?? 0,
    // 金额单独查（见 `costsOf`）：一行 SUM 出不来「按币种分开」。
    cost: {},
  }
}

/**
 * 这段区间里各币种各花了多少。
 *
 * 单独一条 `GROUP BY currency` 而不是塞进 `TOTAL_COLS`：一次 SUM 只能得到
 * 一个数字，而把两种货币加起来的那个数字没有意义。
 */
function costsOf(store: Store, where: string, args: (string | number)[]): Record<string, number> {
  const rows = store.db
    .query<{ currency: string; total: number | null }, (string | number)[]>(
      `SELECT currency, SUM(cost) AS total FROM usage_ledger ${where} GROUP BY currency`,
    )
    .all(...args)
  const out: Record<string, number> = {}
  for (const r of rows) {
    if (r.total) out[r.currency] = r.total
  }
  return out
}

export function usageTotals(store: Store, q: UsageQuery = {}): UsageTotals {
  const w = where(q)
  const row = store.db
    .query<RawTotals, (string | number)[]>(`SELECT ${TOTAL_COLS} FROM usage_ledger ${w.sql}`)
    .get(...w.args)
  return {
    ...shape(row ?? ({ n: 0, cached_reports: 0, cache_write_reports: 0 } as RawTotals)),
    cost: costsOf(store, w.sql, w.args),
  }
}

export type GroupBy = 'model' | 'day' | 'workspace' | 'kind' | 'currency'

const GROUP_EXPR: Record<GroupBy, string> = {
  model: 'model',
  // 按**本地日**分组。用 SQLite 的 localtime 而不是 UTC：用户问「今天花了多少」
  // 问的是自己那天，UTC 分组会让晚上八点之后的花费算到「明天」。
  day: "strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', 'localtime')",
  workspace: "COALESCE(workspace_id, '(无)')",
  kind: 'kind',
  currency: 'currency',
}

/**
 * 分组统计。
 *
 * 按**笔数**倒序，不按金额：多币种下「最贵的排前面」没有唯一解
 * （¥100 和 $20 谁在前？要汇率才知道）。笔数无量纲、跨币种可比，
 * 而且「哪个模型用得最多」本身也是这张表要回答的问题之一。
 * 金额仍在每行里按币种分开列出。
 */
export function usageBy(store: Store, by: GroupBy, q: UsageQuery = {}): UsageBucket[] {
  const w = where(q)
  const expr = GROUP_EXPR[by]
  const rows = store.db
    .query<RawTotals & { key: string }, (string | number)[]>(
      `SELECT ${expr} AS key, ${TOTAL_COLS} FROM usage_ledger ${w.sql}
       GROUP BY key ORDER BY n DESC, key ASC`,
    )
    .all(...w.args)

  // 金额按 (分组键, 币种) 再查一遍。同一个分组里出现两种币种是可能的
  // ——`--by day` 就是典型：同一天用了 Claude 也用了 GLM。
  const costRows = store.db
    .query<{ key: string; currency: string; total: number | null }, (string | number)[]>(
      `SELECT ${expr} AS key, currency, SUM(cost) AS total FROM usage_ledger ${w.sql}
       GROUP BY key, currency`,
    )
    .all(...w.args)
  const costs = new Map<string, Record<string, number>>()
  for (const r of costRows) {
    if (!r.total) continue
    const bucket = costs.get(r.key) ?? {}
    bucket[r.currency] = r.total
    costs.set(r.key, bucket)
  }

  return rows.map((r) => ({ key: r.key, ...shape(r), cost: costs.get(r.key) ?? {} }))
}

/**
 * 逐笔列出账目。**分组统计答不了「这一笔是什么时候发生的」**，而「这条会话花在哪」
 * 要按时间把每一笔摆出来：哪一轮、以及夹在轮次之间的那次压缩摘要。
 *
 * 只给界面真要用的列。请求体、指纹这类排查用的数据不在账本里，它们在
 * `provider_requests`。
 */
export function usageEntries(store: Store, q: UsageQuery = {}): UsageLedgerRow[] {
  const w = where(q)
  return store.db
    .query<RawEntry, (string | number)[]>(
      `SELECT id, kind, run_id, model, input_tokens, output_tokens, cached_tokens,
              cache_write_tokens, cost, currency, occurred_at
         FROM usage_ledger ${w.sql} ORDER BY occurred_at DESC, id DESC`,
    )
    .all(...w.args)
    .map((r) => ({
      id: r.id,
      kind: r.kind as UsageKind,
      runId: r.run_id,
      model: r.model,
      inputTokens: r.input_tokens ?? 0,
      outputTokens: r.output_tokens ?? 0,
      cachedTokens: r.cached_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      cost: r.cost ?? 0,
      currency: (r.currency ?? 'USD') as Currency,
      occurredAt: r.occurred_at,
    }))
}

interface RawEntry {
  id: string
  kind: string
  run_id: string | null
  model: string
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  cache_write_tokens: number | null
  cost: number | null
  currency: string | null
  occurred_at: number
}

/** 删掉某个时间点之前的账目。用户要清账时用，不是自动 GC。 */
export function pruneUsage(store: Store, before: number): number {
  const r = store.db.query('DELETE FROM usage_ledger WHERE occurred_at < ?').run(before)
  return Number(r.changes ?? 0)
}

/**
 * 摘要调用**实际写了多长**的分位数（输出 token）。
 *
 * 压缩的摘要预算取「装得下多少」与「实际需要多少」的较小者，这个函数回答后半句：
 * 该留多长由分布决定，不由拍一个上限决定。取 p95 而不是极大值——硬上界另有
 * `headroom` 一层，这里只需要覆盖常态；写超了的那次会被「截断作废」闸捕获，
 * 并作为一个更大的样本进入下一次的分布。
 *
 * 一笔观测都没有时返回 null（冷启动），调用方退回纯 headroom。
 */
export function summaryOutputPercentile(
  store: Store,
  workspaceId: string,
  percentile: number,
): number | null {
  const rows = store.db
    .query<{ output_tokens: number }, [string]>(
      `SELECT output_tokens FROM usage_ledger
        WHERE kind = 'summary' AND workspace_id = ? AND output_tokens > 0
        ORDER BY output_tokens ASC`,
    )
    .all(workspaceId)
  if (rows.length === 0) return null
  const index = Math.min(rows.length - 1, Math.floor(rows.length * percentile))
  return rows[index]!.output_tokens
}
