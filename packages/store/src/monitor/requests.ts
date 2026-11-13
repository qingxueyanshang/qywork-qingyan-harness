/**
 * 会话级逐请求序列：本会话全部主请求的精简行、压缩记录、各工具的调用计数与逐请求明细。只读。
 *
 * 范围只含本会话自身轮次的主请求：摘要请求不发送会话上下文，子会话各是一个会话，均不计入。
 * 分组占用的对账、缓存未命中归因、工具耗时与金额都在读取时计算，不落盘。
 * 序列与明细分两个响应，按请求 id 对应，两者截取 `after` 的方式相同。
 */

import type {
  ContextBreakdown,
  ConversationId,
  ConversationRequestDetailsResponse,
  ConversationRequestsResponse,
  MonitorCompaction,
  MonitorRequestDetail,
  ProviderRequest,
  ProviderRequestId,
  RunUsage,
  StepPayload,
} from '@qywork/core'
import { attributeCacheMisses, reconcileBreakdown } from '@qywork/core'
import type { Store } from '../db.ts'
import { readJson } from '../db.ts'
import { rowToProviderRequest } from '../repos.ts'
import type { ProviderRequestRow, RunRow } from '../schema.ts'
import { conversationToolTotals, requestToolDurations } from './tool-usage.ts'

/** 一条压缩记录：压缩步骤的 payload 与该步骤的创建时刻。 */
export type CompactionRecord = Extract<StepPayload, { kind: 'compaction' }> & { createdAt: number }

/**
 * 一次主请求对账后的分组占用。逐请求序列、消息条目重建与界面各处都取本函数的结果，不各自对账。
 *
 * 有用量时总数为「输入 + 命中 + 写入」，即该请求实际发送的输入量；没有用量时取发出时的运行中读数
 * （`occupancyTokens`，迁移前的旧行取本地测得值），并标为估算。
 */
export function requestBreakdown(
  r: Pick<
    ProviderRequest,
    | 'providerInputTokens'
    | 'providerCachedTokens'
    | 'providerCacheWriteTokens'
    | 'occupancyTokens'
    | 'measuredInputTokens'
    | 'sentCategories'
  >,
): { breakdown: ContextBreakdown; estimated: boolean } {
  if (r.providerInputTokens === null) {
    return {
      breakdown: reconcileBreakdown(r.sentCategories, r.occupancyTokens ?? r.measuredInputTokens),
      estimated: true,
    }
  }
  const total =
    r.providerInputTokens + (r.providerCachedTokens ?? 0) + (r.providerCacheWriteTokens ?? 0)
  return { breakdown: reconcileBreakdown(r.sentCategories, total), estimated: false }
}

/** 本会话的全部压缩记录，含未改写 manifest 的记录，按创建时刻排列。 */
export function compactionRecords(
  store: Store,
  conversationId: ConversationId,
): CompactionRecord[] {
  return store.db
    .query<{ createdAt: number; payload: string | null }, [string]>(
      `SELECT s.created_at AS createdAt, s.payload AS payload
       FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE r.conversation_id = ? AND s.kind = 'compaction'
       ORDER BY s.created_at, s.id`,
    )
    .all(conversationId)
    .flatMap((row) => {
      const payload = readJson<StepPayload | null>(row.payload, null)
      return payload?.kind === 'compaction' ? [{ ...payload, createdAt: row.createdAt }] : []
    })
}

/**
 * 本会话的全部主请求，按创建顺序排列（请求 id 的字典序即生成顺序），及 `after` 之后第一行的下标。
 * `after` 不是本会话的主请求时返回 null。
 */
function mainRequests(
  store: Store,
  conversationId: ConversationId,
  after: ProviderRequestId | null,
): { requests: ProviderRequest[]; start: number } | null {
  const requests = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.purpose = 'turn'
       ORDER BY pr.id`,
    )
    .all(conversationId)
    .map(rowToProviderRequest)
  const start = after === null ? 0 : requests.findIndex((r) => r.id === after) + 1
  return after !== null && start === 0 ? null : { requests, start }
}

/**
 * 本会话的主请求序列。`after` 为 null 时返回整段；否则返回该请求之后的部分，
 * `after` 不是本会话的主请求时返回 null。
 *
 * 归因始终按整段计算后再截取：它要用到 `after` 之前最近一条带用量的请求与其间的压缩记录。
 */
export function conversationRequests(
  store: Store,
  conversationId: ConversationId,
  after: ProviderRequestId | null,
): ConversationRequestsResponse | null {
  const found = mainRequests(store, conversationId, after)
  if (!found) return null
  const { requests, start } = found
  const since = requests[start - 1]?.createdAt ?? null
  const compactions = compactionRecords(store, conversationId)
  const cacheMiss = attributeCacheMisses(requests, compactions)

  return {
    requests: requests.slice(start).map((r, i) => ({
      id: r.id,
      runId: r.runId,
      turnIndex: r.turnIndex,
      retryIndex: r.retryIndex,
      status: r.status,
      createdAt: r.createdAt,
      ...requestBreakdown(r),
      compactAt: r.configuration?.compactAt ?? null,
      cacheMiss: cacheMiss[start + i] ?? null,
    })),
    compactions: compactions
      .filter((c) => c.manifestRevision > 0 && (since === null || c.createdAt > since))
      .map(
        (c): MonitorCompaction => ({
          createdAt: c.createdAt,
          trigger: c.trigger ?? null,
          summarized: c.summarized === true,
          occupancy: c.occupancy ?? null,
          occupancyAfter: c.occupancyAfter ?? null,
        }),
      ),
    tools: conversationToolTotals(store, conversationId),
  }
}

/**
 * 主请求的金额，取自该轮用量账中同一请求编号、同一输入与输出量的最后一条记录。
 *
 * 计价发生在取得用量之后，请求行上没有金额。同一请求编号下，取得部分用量后失败的尝试与重发各有一条记录，
 * 因此按用量逐项匹配，不只按编号匹配。
 */
function costOf(
  r: ProviderRequest,
  usage: Pick<RunUsage, 'currency' | 'turns'> | undefined,
): MonitorRequestDetail['cost'] {
  if (r.status !== 'received' || r.providerInputTokens === null || !usage) return null
  const turn = usage.turns.findLast(
    (t) =>
      t.turnIndex === r.turnIndex &&
      t.input === r.providerInputTokens &&
      t.output === r.providerOutputTokens,
  )
  return turn ? { amount: turn.costUsd, currency: usage.currency } : null
}

/** 本会话主请求的明细，行与 `conversationRequests` 的序列逐条对应，`after` 的含义相同。 */
export function conversationRequestDetails(
  store: Store,
  conversationId: ConversationId,
  after: ProviderRequestId | null,
): ConversationRequestDetailsResponse | null {
  const found = mainRequests(store, conversationId, after)
  if (!found) return null
  const toolMs = requestToolDurations(store, conversationId)
  const usageByRun = new Map(
    store.db
      .query<Pick<RunRow, 'id' | 'currency' | 'usage_turns'>, [string]>(
        'SELECT id, currency, usage_turns FROM runs WHERE conversation_id = ?',
      )
      .all(conversationId)
      .map((row) => [
        row.id,
        { currency: row.currency, turns: readJson<RunUsage['turns']>(row.usage_turns, []) },
      ]),
  )

  return {
    details: found.requests.slice(found.start).map(
      (r): MonitorRequestDetail => ({
        id: r.id,
        sentAt: r.sentAt,
        headersAt: r.headersAt,
        firstContentAt: r.firstContentAt,
        completedAt: r.completedAt,
        // 输入与输出由 `settleProviderRequest` 从同一份用量一并写入，两者同为空或同不为空。
        usage:
          r.providerInputTokens === null || r.providerOutputTokens === null
            ? null
            : {
                input: r.providerInputTokens,
                output: r.providerOutputTokens,
                cached: r.providerCachedTokens,
                cacheWrite: r.providerCacheWriteTokens,
                cacheWrite1h: r.providerCacheWrite1hTokens,
              },
        omitted: r.omittedCategories,
        toolMs: toolMs.get(r.id) ?? null,
        cost: costOf(r, usageByRun.get(r.runId)),
      }),
    ),
  }
}
