/** 请求发送与回执完成后发布同一把上下文读数，避免最后一轮停在发送前估算。 */

import type { AgentEvent } from '@qywork/core'
import { reconcileBreakdown } from '@qywork/core'
import { softLimit } from './request.ts'
import type { LoopHost, RunState, TurnState } from './run-state.ts'

/** 读数里还没有真值的视频如实标出段数（`RunState.unmeasuredVideos`）。 */
export function contextEvent(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
  fallback: number,
): AgentEvent {
  const limit = run.adapter.spec.contextWindow
  const reading = run.meter(fallback)
  const unmeasured = run.unmeasuredVideos(turn.req)
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
