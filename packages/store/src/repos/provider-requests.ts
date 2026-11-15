/**
 * `provider_requests` 表（逐请求账）的读写，以及按模型统计的请求完成率。
 */

import {
  type ContextBreakdown,
  type ContextOmitted,
  type ConversationId,
  emptyBreakdown,
  emptyOmitted,
  newProviderRequestId,
  type ProviderHedge,
  type ProviderKind,
  type ProviderRequest,
  type ProviderRequestConfiguration,
  type ProviderRequestContentKind,
  type ProviderRequestDiagnostic,
  type ProviderRequestId,
  type ProviderRequestPurpose,
  type ProviderRequestStatus,
  type RunId,
} from '@qywork/core'
import { readJson, type Store, writeJson } from '../db.ts'
import type { ProviderRequestRow } from '../rows.ts'

/**
 * 记录一次即将发出的模型请求。
 *
 * 在装配完成之后、实际发出之前调用，因此状态为 `pending`：此时请求内容
 * 已经确定（分组占用、指纹均可计算），provider 是否接收仍未知。
 * 两者分开记录，使「已发出但无响应」与「未发出」在账本中
 * 可以区分：二者对上下文占用的含义完全不同。
 */
export function openProviderRequest(
  store: Store,
  input: {
    runId: RunId
    turnIndex: number
    retryIndex: number
    /** 缺省为主请求；摘要请求由主循环标记为 summary。 */
    purpose?: ProviderRequestPurpose
    providerName?: string
    providerKind?: ProviderKind
    model: string
    measuredInputTokens: number
    /** 摘要请求不提供。 */
    occupancyTokens?: number
    configuration?: ProviderRequestConfiguration
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
    requestBytes?: number
    cacheRouteFingerprint?: string | null
  },
): ProviderRequest {
  const row: ProviderRequest = {
    id: newProviderRequestId(),
    runId: input.runId,
    turnIndex: input.turnIndex,
    retryIndex: input.retryIndex,
    purpose: input.purpose ?? 'turn',
    providerName: input.providerName ?? null,
    providerKind: input.providerKind ?? null,
    model: input.model,
    status: 'pending',
    measuredInputTokens: input.measuredInputTokens,
    occupancyTokens: input.occupancyTokens ?? null,
    providerInputTokens: null,
    providerOutputTokens: null,
    providerCachedTokens: null,
    providerCacheWriteTokens: null,
    providerCacheWrite1hTokens: null,
    finishReason: '',
    sentCategories: input.sentCategories,
    omittedCategories: input.omittedCategories,
    errorCode: null,
    errorMessage: null,
    diagnostic: null,
    configuration: input.configuration ?? null,
    payloadHash: input.payloadHash,
    requestBytes: input.requestBytes ?? null,
    cacheRouteFingerprint: input.cacheRouteFingerprint ?? null,
    sentAt: null,
    headersAt: null,
    cloudRequestId: null,
    hedge: null,
    firstEventAt: null,
    firstContentAt: null,
    lastContentAt: null,
    lastContentKind: null,
    lastVisibleAt: null,
    completedAt: null,
    createdAt: Date.now(),
  }
  store.db
    .query(
      `INSERT INTO provider_requests
       (id, run_id, turn_index, retry_index, purpose, provider_name, provider_kind, model, status,
        measured_input_tokens, occupancy_tokens, provider_input_tokens, provider_output_tokens, provider_cached_tokens,
        provider_cache_write_tokens, sent_categories, omitted_categories, error_code, payload_hash,
        request_bytes, cache_route_fingerprint, sent_at, headers_at, first_event_at, first_content_at,
        completed_at, created_at, configuration)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,NULL,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    )
    .run(
      row.id,
      row.runId,
      row.turnIndex,
      row.retryIndex,
      row.purpose,
      row.providerName,
      row.providerKind,
      row.model,
      row.status,
      row.measuredInputTokens,
      row.occupancyTokens,
      writeJson(row.sentCategories),
      writeJson(row.omittedCategories),
      row.payloadHash,
      row.requestBytes,
      row.cacheRouteFingerprint,
      row.createdAt,
      row.configuration === null ? null : writeJson(row.configuration),
    )
  return row
}

/** 请求已实际发出。`sent_at` 只在此处写入，面板据此选取最近一次已发送的请求。 */
export function markProviderRequestSent(store: Store, id: ProviderRequestId): void {
  store.db
    .query("UPDATE provider_requests SET status = 'in_flight', sent_at = ? WHERE id = ?")
    .run(Date.now(), id)
}

/**
 * 响应头到达的时刻与其中云端模型网关的请求号。`at` 由传输层观测，不要在此处取当前时刻：
 * 事件从适配器传到此处已延迟若干毫秒，而该列的用途正是与 `sent_at`
 * 相减得出首包等待时间。重复调用时两列都保留首次的值。
 */
export function markProviderRequestHeaders(
  store: Store,
  id: ProviderRequestId,
  at: number,
  cloudRequestId: string | null = null,
): void {
  store.db
    .query(
      `UPDATE provider_requests SET headers_at = COALESCE(headers_at, ?),
         cloud_request_id = COALESCE(cloud_request_id, ?) WHERE id = ?`,
    )
    .run(at, cloudRequestId, id)
}

/** 响应头之前补发的第二份请求。`hedge` 来自传输层读数：成功时经 `response_started`，失败时经诊断中的传输读数。 */
export function markProviderRequestHedge(
  store: Store,
  id: ProviderRequestId,
  hedge: ProviderHedge,
): void {
  store.db
    .query('UPDATE provider_requests SET hedge_sent_at = ?, hedge_won = ? WHERE id = ?')
    .run(hedge.sentAt, hedge.won ? 1 : 0, id)
}

/** provider 的第一个实际流事件。重复调用时保留首次的值，不被后续事件覆盖。 */
export function markProviderRequestFirstEvent(store: Store, id: ProviderRequestId): void {
  store.db
    .query('UPDATE provider_requests SET first_event_at = COALESCE(first_event_at, ?) WHERE id = ?')
    .run(Date.now(), id)
}

/**
 * 一段非空思考、正文或新增工具参数到达。
 *
 * 每一段都调用，`at` 由适配器在解析该段时观测，不要在此处取当前时刻：
 * 事件传到此处已延迟若干毫秒，而 `last_content_at` 的用途正是计算当前已静默多久。
 * 首值由 `COALESCE` 保留在 `first_content_at`，末值每次覆盖 `last_content_at`，
 * 两列在一次更新中写入：分成两条语句时，中途失败会使两列不一致。
 */
export function markProviderRequestContent(
  store: Store,
  id: ProviderRequestId,
  at: number,
  kind: ProviderRequestContentKind | null = null,
  visible = false,
): void {
  store.db
    .query(
      `UPDATE provider_requests SET
       first_content_at = COALESCE(first_content_at, ?), last_content_at = ?,
       last_content_kind = ?, last_visible_at = CASE WHEN ? THEN ? ELSE last_visible_at END
       WHERE id = ?`,
    )
    .run(at, at, kind, visible ? 1 : 0, at, id)
}

/**
 * 请求终态。
 *
 * `usage` 为 null 表示 provider 未回报，各字段保持 null，不要填 0。
 * 第三方接口缺失 usage 很常见，记为 0 会使上下文锚点误判为该请求未占用任何上下文。
 * `cacheWrite1hTokens` 缺失表示上游未回报缓存写入的分档，同样写入 null。
 */
export function settleProviderRequest(
  store: Store,
  id: ProviderRequestId,
  status: Exclude<ProviderRequestStatus, 'pending' | 'in_flight'>,
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number | null
    cacheWriteTokens: number | null
    cacheWrite1hTokens?: number
  } | null,
  errorCode: string | null = null,
  finishReason = '',
  errorMessage: string | null = null,
  anchored = false,
): void {
  store.db
    .query(
      `UPDATE provider_requests
       SET status = ?, provider_input_tokens = ?, provider_output_tokens = ?,
           provider_cached_tokens = ?, provider_cache_write_tokens = ?,
           provider_cache_write_1h_tokens = ?, error_code = ?,
           finish_reason = ?, error_message = ?, completed_at = ?, anchored = ?
       WHERE id = ?`,
    )
    .run(
      status,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.cachedTokens ?? null,
      usage?.cacheWriteTokens ?? null,
      usage?.cacheWrite1hTokens ?? null,
      errorCode,
      finishReason,
      errorMessage,
      Date.now(),
      anchored ? 1 : 0,
      id,
    )
}

/** 失败诊断与重试裁决写回同一请求行；不另建重试状态。 */
export function recordProviderRequestDiagnostic(
  store: Store,
  id: ProviderRequestId,
  diagnostic: ProviderRequestDiagnostic,
): void {
  store.db
    .query('UPDATE provider_requests SET diagnostic = ? WHERE id = ?')
    .run(writeJson(diagnostic), id)
}

/**
 * 本会话最近一次已发送的主请求。面板的分组明细取自本函数。
 *
 * 只取主请求，`latestAnchoredProviderRequest` 相同：摘要请求发送的是摘要提示词，
 * 其输入量与会话占用无关，用作依据会把面板读数变成摘要请求的大小。
 */
export function latestSentProviderRequest(
  store: Store,
  conversationId: ConversationId,
): ProviderRequest | null {
  const row = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr
       JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.purpose = 'turn' AND pr.sent_at IS NOT NULL
       ORDER BY pr.sent_at DESC, pr.id DESC
       LIMIT 1`,
    )
    .get(conversationId)
  return row ? rowToProviderRequest(row) : null
}

/**
 * 本会话最近一次作为占用锚点的请求。
 *
 * 判据只有 `anchored` 一列，由 loop 收尾时写入（`agent` 的 `settleResponse`）：全零 usage、输入量超出上限的回执
 * 都不作为锚点。不要在此另写判据：两处各自判定时，同一条回执在运行中与刷新后的读数可能不同。
 */
export function latestAnchoredProviderRequest(
  store: Store,
  conversationId: ConversationId,
): ProviderRequest | null {
  const row = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr
       JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.anchored = 1
       ORDER BY pr.sent_at DESC, pr.id DESC
       LIMIT 1`,
    )
    .get(conversationId)
  return row ? rowToProviderRequest(row) : null
}

export function listProviderRequests(store: Store, runId: RunId): ProviderRequest[] {
  return store.db
    .query<ProviderRequestRow, [string]>(
      'SELECT * FROM provider_requests WHERE run_id = ? ORDER BY turn_index ASC, retry_index ASC',
    )
    .all(runId)
    .map(rowToProviderRequest)
}

/** 只在包内使用：`monitor/` 的只读查询按同一份映射读取请求行。 */
export function rowToProviderRequest(r: ProviderRequestRow): ProviderRequest {
  return {
    id: r.id,
    runId: r.run_id,
    turnIndex: r.turn_index,
    retryIndex: r.retry_index,
    purpose: r.purpose as ProviderRequestPurpose,
    providerName: r.provider_name,
    providerKind: r.provider_kind,
    model: r.model,
    status: r.status,
    measuredInputTokens: r.measured_input_tokens,
    occupancyTokens: r.occupancy_tokens,
    providerInputTokens: r.provider_input_tokens,
    providerOutputTokens: r.provider_output_tokens,
    providerCachedTokens: r.provider_cached_tokens,
    providerCacheWriteTokens: r.provider_cache_write_tokens,
    providerCacheWrite1hTokens: r.provider_cache_write_1h_tokens,
    sentCategories: {
      ...emptyBreakdown(),
      ...readJson(r.sent_categories, {}, 'provider_requests.sent_categories'),
    },
    omittedCategories: {
      ...emptyOmitted(),
      ...readJson(r.omitted_categories, {}, 'provider_requests.omitted_categories'),
    },
    errorCode: r.error_code,
    errorMessage: r.error_message,
    diagnostic: readJson(r.diagnostic, null, 'provider_requests.diagnostic'),
    configuration: readJson(r.configuration, null, 'provider_requests.configuration'),
    payloadHash: r.payload_hash,
    requestBytes: r.request_bytes,
    finishReason: r.finish_reason ?? '',
    cacheRouteFingerprint: r.cache_route_fingerprint,
    sentAt: r.sent_at,
    headersAt: r.headers_at,
    cloudRequestId: r.cloud_request_id,
    hedge: r.hedge_sent_at === null ? null : { sentAt: r.hedge_sent_at, won: r.hedge_won === 1 },
    firstEventAt: r.first_event_at,
    firstContentAt: r.first_content_at,
    lastContentAt: r.last_content_at,
    lastContentKind: r.last_content_kind,
    lastVisibleAt: r.last_visible_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
  }
}

/** 一个模型在一段时间内的请求结束情况。分母是该时段内为它创建的全部账本行。 */
export interface ModelFinishRate {
  model: string
  total: number
  /** 流按协议正常结束的次数。 */
  received: number
  /** 连接层失败，是否送达、是否计费均无法确定。 */
  uncertain: number
  /** provider 返回状态码明确拒绝。 */
  rejected: number
  /** 该时段内出现次数最多的错误码；没有错误时为 null。 */
  topErrorCode: string | null
}

/**
 * 按模型统计请求的结束情况。
 *
 * 用途：判断某个端点在本机是否稳定。账本已逐行记录每次请求的结果，
 * 无需反复试验。
 *
 * 边界：样本随会话一并删除（`provider_requests.run_id` 是 ON DELETE CASCADE），
 * 因此统计范围是现存会话，不是全部历史。
 */
export function providerFinishRates(store: Store, since: number): ModelFinishRate[] {
  return store.db
    .query<
      {
        model: string
        total: number
        received: number
        uncertain: number
        rejected: number
        top_error: string | null
      },
      [number, number]
    >(
      `SELECT model,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'received'  THEN 1 ELSE 0 END) AS received,
              SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
              SUM(CASE WHEN status = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
              (SELECT p2.error_code FROM provider_requests p2
                WHERE p2.model = p1.model AND p2.created_at >= ? AND p2.error_code IS NOT NULL
                GROUP BY p2.error_code ORDER BY COUNT(*) DESC LIMIT 1) AS top_error
         FROM provider_requests p1
        WHERE p1.created_at >= ?
        GROUP BY model
        ORDER BY total DESC`,
    )
    .all(since, since)
    .map((r) => ({
      model: r.model,
      total: r.total,
      received: r.received,
      uncertain: r.uncertain,
      rejected: r.rejected,
      topErrorCode: r.top_error,
    }))
}
