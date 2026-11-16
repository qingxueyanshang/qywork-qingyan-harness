/** 生成花费的记账。 */

import type { AgentEvent, ConversationId, MediaSpend, RunId } from '@qywork/core'
import { appendRunMedia, recordUsage } from '@qywork/store'
import type { SessionState } from './types.ts'

/**
 * 记录一次生成花费：立即记入账本并追加到该轮的 `runs.media_usage`。画布生成在本轮停止后照常完成，
 * 花费可能在轮次结束之后到达，因此记账不放在轮次收尾，也不依赖 `mediaSpends`。
 * 轮次仍在运行时另补发一次 usage 事件，使读数条与面板即时显示；事件中的模型用量取本轮最近一次的值，生成花费由 `ask` 统一附加。
 */
export function recordMediaSpend(
  session: Pick<SessionState, 'opts' | 'workspaceId' | 'mediaSpends' | 'modelUsage'>,
  runId: RunId,
  conversationId: ConversationId,
  spend: MediaSpend,
  emit: (e: AgentEvent) => void,
): void {
  const store = session.opts.store
  recordUsage(store, {
    kind: 'media',
    runId,
    conversationId,
    workspaceId: session.workspaceId,
    model: spend.model,
    provider: spend.kind,
    inputTokens: 0,
    outputTokens: 0,
    cost: spend.cost,
    currency: spend.currency,
    occurredAt: spend.at,
  })
  appendRunMedia(store, runId, spend)
  const spends = session.mediaSpends.get(runId)
  if (!spends) return
  session.mediaSpends.set(runId, [...spends, spend])
  const usage = session.modelUsage.get(runId)
  if (usage) emit({ type: 'usage', runId, usage })
}
