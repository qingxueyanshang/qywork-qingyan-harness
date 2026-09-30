/** 请求发送与回执完成后发布同一把上下文读数，避免最后一轮停在发送前估算。 */

import { videoBlocksOf } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import { reconcileBreakdown } from '@qywork/core'
import { softLimit } from './request.ts'
import type { LoopHost, RunState, TurnState } from './run-state.ts'

/**
 * `sending`：这份读数描述的是正要发出的 `turn.req`。其中的视频不在估算里（`estimateContent`），
 * 真值回来之前如实标出几段未计；回执之后视频已随下一次请求摘掉，不再标。
 */
export function contextEvent(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
  fallback: number,
  sending = false,
): AgentEvent {
  const limit = run.adapter.spec.contextWindow
  const reading = run.meter(fallback)
  const unmeasured = sending ? videoBlocksOf(turn.req.messages) : 0
  return {
    type: 'context',
    runId: run.input.runId,
    tokens: reading.tokens,
    limit,
    percent: limit ? Math.round((reading.tokens / limit) * 1000) / 10 : 0,
    source: reading.source,
    compactAt: softLimit(run.adapter.spec),
    breakdown: reconcileBreakdown(turn.breakdown, reading.tokens),
    omitted: host.lastOmitted(),
    ...(unmeasured ? { unmeasuredVideos: unmeasured } : {}),
  }
}
