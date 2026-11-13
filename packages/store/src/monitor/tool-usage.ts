/**
 * 工具调用统计：按会话汇总各工具的调用次数与执行时长，按请求合并其所产生批次的工具执行时长。只读。
 *
 * 数据只来自 `steps` 中的工具步骤。工具步骤的工具名、批次（产生该调用的请求 id）与波次序号
 * 在建行时一并写入（runtime 的 `openToolStep`），三列均不为空。
 * 范围只含本会话自身的轮次：子代理与编排成员各是一个会话，不计入。
 */

import type { ConversationId, ProviderRequestId } from '@qywork/core'
import type { Store } from '../db.ts'

export interface ToolCallTotal {
  toolName: string
  /** 调用次数，含运行中与被中断的调用。 */
  calls: number
  /** 已记录时长的调用的执行时长之和（毫秒）。运行中与被中断的调用没有时长，不计入本项。 */
  durationMs: number
}

/** 本会话各工具的调用次数与累计执行时长，按工具名排序。 */
export function conversationToolTotals(
  store: Store,
  conversationId: ConversationId,
): ToolCallTotal[] {
  return store.db
    .query<ToolCallTotal, [string]>(
      `SELECT s.tool_name AS toolName, count(*) AS calls,
              coalesce(sum(s.duration_ms), 0) AS durationMs
       FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE r.conversation_id = ? AND s.kind = 'tool_action'
       GROUP BY s.tool_name
       ORDER BY s.tool_name`,
    )
    .all(conversationId)
}

/**
 * 一个批次的工具执行时长（毫秒）：同一波次的调用并行执行，取其中最长一次；波次之间依次执行，
 * 各波次相加。波次的划分与执行顺序由 agent 的 `executeCalls` 决定。没有调用时为 0。
 */
export function batchToolDuration(
  calls: readonly { waveIndex: number; durationMs: number }[],
): number {
  const longest = new Map<number, number>()
  for (const c of calls) {
    longest.set(c.waveIndex, Math.max(longest.get(c.waveIndex) ?? 0, c.durationMs))
  }
  let total = 0
  for (const ms of longest.values()) total += ms
  return total
}

/**
 * 本会话各请求所产生批次的工具执行时长，键为请求 id，值按 `batchToolDuration` 合并。
 *
 * 只合并已记录时长的调用。没有工具调用的请求、全部调用都没有时长的请求不在结果中；
 * 工具仍在执行的请求取已完成调用的合并值。
 */
export function requestToolDurations(
  store: Store,
  conversationId: ConversationId,
): Map<ProviderRequestId, number> {
  const rows = store.db
    .query<{ batch: ProviderRequestId; wave: number; ms: number }, [string]>(
      `SELECT s.provider_batch_id AS batch, s.execution_wave_index AS wave, s.duration_ms AS ms
       FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE r.conversation_id = ? AND s.kind = 'tool_action' AND s.duration_ms IS NOT NULL`,
    )
    .all(conversationId)
  const byBatch = new Map<ProviderRequestId, { waveIndex: number; durationMs: number }[]>()
  for (const r of rows) {
    const calls = byBatch.get(r.batch) ?? []
    calls.push({ waveIndex: r.wave, durationMs: r.ms })
    byBatch.set(r.batch, calls)
  }
  return new Map([...byBatch].map(([batch, calls]) => [batch, batchToolDuration(calls)]))
}
