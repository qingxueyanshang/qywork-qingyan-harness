/**
 * 用量账本。
 *
 * `runs` 上的 usage 记录单轮花费；账本统计本月花费、各模型花费、
 * 各工作区花费。后者无法从 `runs` 查询，因为**删除会话是正常操作，而账目不应随之消失**。
 *
 * 因此账本不设外键：`run_id` / `conversation_id` 只是线索，所指向的行被删除不影响账目成立。
 */

import type { Currency, UsageBucket, UsageKind, UsageLedgerRow, UsageTotals } from '@qywork/core'
import { log, newUsageId } from '@qywork/core'
import type { Store } from './db.ts'

export interface UsageEntry {
  kind: UsageKind
  /** 所属轮次；历史独立摘要与媒体等非轮次账目允许为空。 */
  runId?: string | null
  conversationId?: string | null
  workspaceId?: string | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  /** null 表示 provider 未回报，与实际命中为 0 含义不同。 */
  cachedTokens?: number | null
  cacheWriteTokens?: number | null
  reasoningTokens?: number
  cost: number
  /** `cost` 的币种。省略即 USD。**不换算**，各币种分开合计。 */
  currency?: Currency
  occurredAt?: number
}

/**
 * 记录一笔账目。
 *
 * 同一个 run 重复记账会被唯一索引拦截；此处**忽略该冲突**而不是抛错：
 * 账本是旁路记账，不应使一个已执行完毕的 run 在收尾时失败。
 * 但结果必须可见，因此返回是否实际写入。
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
    // 此 catch 只忽略一种错误：唯一索引冲突，即该笔已记录
    // （收尾逻辑执行两次时不应使账目翻倍）。
    //
    // 写成 `catch {}` 会忽略**所有**错误：为 kind 新增值
    // 而 schema 上的 CHECK 约束未同步修改时，插入直接抛错，此处 return false 且不报告，
    // 结果是开销照常发生、账本中没有任何记录，且任何地方都不报错。
    //
    // 因此只忽略这一种，其余一律报告。
    // 仍然不抛错：账本是旁路记账，不应使一个已执行完毕的 run 在收尾时失败；
    // 不抛错不等于不报告。
    const msg = err instanceof Error ? err.message : String(err)
    if (!/UNIQUE constraint failed/i.test(msg)) {
      log.error('usage', `记账失败：${msg}`, { kind: entry.kind })
    }
    return false
  }
}

export interface UsageQuery {
  /** 起始时间（含）。不传时从最早的记录开始。 */
  since?: number
  /** 结束时间（不含）。不传时截至当前。 */
  until?: number
  workspaceId?: string
  /**
   * 只统计该会话。**包含该会话引发的全部开销**：对话轮次、压缩摘要调用
   * （自动与手动摘要都归入所属轮次），以及其派发的子会话。
   * 外部 CLI 的花费记在其他服务商的账上，此处无法取得。
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
    // 子会话的账目记在其自身的 conversation_id 下，父会话按 parent_conversation_id 汇总。
    // 子会话已被删除时其账本行保留但不再匹配：按设计，账目的生命周期长于业务数据，
    // 而会话花费统计的是当前仍归属于该会话的记录。
    parts.push(
      '(conversation_id = ? OR conversation_id IN (SELECT id FROM conversations WHERE parent_conversation_id = ?))',
    )
    args.push(q.conversationId, q.conversationId)
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
    // 全部为 NULL 时 SUM 的结果为 NULL，但已回报的笔数需要单独统计：
    // 没有任何一笔回报时必须为 null，否则界面上会显示「缓存命中 0」，
    // 这是一个具体但错误的结论。
    cachedTokens: r.cached_reports > 0 ? (r.cached_tokens ?? 0) : null,
    // 同上：没有任何一笔回报时为 null，不是 0。缓存写入按创建缓存的费用计价，
    // 与命中是两项，界面上分开显示。
    cacheWriteTokens: r.cache_write_reports > 0 ? (r.cache_write_tokens ?? 0) : null,
    reasoningTokens: r.reasoning_tokens ?? 0,
    // 金额单独查询（见 `costsOf`）：单个 SUM 无法按币种分开统计。
    cost: {},
  }
}

/**
 * 区间内各币种的花费。
 *
 * 使用单独的 `GROUP BY currency` 查询而不是放入 `TOTAL_COLS`：一次 SUM 只能得到
 * 一个数字，而两种货币相加得到的数字没有意义。
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
  // 按**本地日期**分组。使用 SQLite 的 localtime 而不是 UTC：用户查询当天花费时
  // 指的是本地日期，按 UTC 分组会使东八区晚上八点之后的花费计入次日。
  day: "strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch', 'localtime')",
  workspace: "COALESCE(workspace_id, '(无)')",
  kind: 'kind',
  currency: 'currency',
}

/**
 * 分组统计。
 *
 * 按**笔数**倒序，不按金额：多币种下按金额倒序没有唯一解
 * （¥100 与 $20 的先后取决于汇率）。笔数无量纲，可跨币种比较，
 * 且各模型的使用次数本身也是该统计要回答的问题之一。
 * 金额仍在每行中按币种分开列出。
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

  // 金额按 (分组键, 币种) 再查询一次。同一分组中可能出现两种币种，
  // `--by day` 是典型情况：同一天既使用了 Claude 也使用了 GLM。
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
 * 逐笔列出账目。**分组统计无法给出每笔的发生时间**，而会话花费明细
 * 需要按时间列出每一笔：所属轮次，以及轮次之间的压缩摘要。
 *
 * 只返回界面实际使用的列。请求体、指纹等排查用数据不在账本中，而在
 * `provider_requests` 中。
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

/** 删除某个时间点之前的账目。供用户手动清理账目，不是自动 GC。 */
export function pruneUsage(store: Store, before: number): number {
  const r = store.db.query('DELETE FROM usage_ledger WHERE occurred_at < ?').run(before)
  return Number(r.changes ?? 0)
}

/**
 * 摘要调用**实际输出长度**的分位数（输出 token）。
 *
 * 压缩的摘要预算取可容纳长度与实际所需长度的较小者，本函数给出后者：
 * 预留长度由分布决定，不由人为设定的上限决定。取 p95 而不是最大值：硬上限另有
 * `headroom` 一层，此处只需覆盖常见情况；超出预算的那次会被截断作废检查捕获，
 * 并作为一个更大的样本进入下一次的分布。
 *
 * 没有任何观测时返回 null（冷启动），调用方退回仅使用 headroom。
 */
export function summaryOutputPercentile(
  store: Store,
  workspaceId: string,
  percentile: number,
): number | null {
  // 当前摘要统一来自 provider_requests；历史独立摘要只在账本中。
  // 当前轮次费用记为 kind=run，不会与历史摘要样本重复。
  const rows = store.db
    .query<{ output_tokens: number }, [string, string]>(
      `SELECT output_tokens FROM (
         SELECT pr.provider_output_tokens AS output_tokens
           FROM provider_requests pr JOIN runs r ON r.id = pr.run_id
          WHERE pr.purpose = 'summary' AND r.workspace_id = ? AND pr.provider_output_tokens > 0
         UNION ALL
         SELECT output_tokens FROM usage_ledger
          WHERE kind = 'summary' AND workspace_id = ? AND output_tokens > 0)
        ORDER BY output_tokens ASC`,
    )
    .all(workspaceId, workspaceId)
  if (rows.length === 0) return null
  const index = Math.min(rows.length - 1, Math.floor(rows.length * percentile))
  return rows[index]!.output_tokens
}
