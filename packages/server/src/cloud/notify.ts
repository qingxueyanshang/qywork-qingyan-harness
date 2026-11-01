/**
 * 一轮结束时经隧道上送通知，云端据此推送到手机。
 *
 * - 只为顶层会话上送：子 agent 的一轮同样产生 `run.finished`，否则一次带子 agent 的任务会产生多条通知。
 * - 每轮至多一条：轮内出错时依次产生 `run.error` 与 `run.finished`（failed），只上送前者；
 *   开始之前被拒绝时只有 `run.error`（`runId` 为空），同样上送。用户主动停止的一轮不上送。
 */

import type { ConversationId, TunnelNotifyEvent } from '@qywork/core'
import { getConversation, type Store } from '@qywork/store'
import type { EventBus } from '../bus.ts'

export type NotifySink = (event: TunnelNotifyEvent, conversationId: string, title: string) => void

export function watchRunEnds(bus: EventBus, store: Store, send: NotifySink): () => void {
  const errored = new Set<string>()
  const report = (event: TunnelNotifyEvent, id: ConversationId) => {
    const conversation = getConversation(store, id)
    if (!conversation || conversation.parentConversationId) return
    send(event, id, conversation.title || '新对话')
  }
  return bus.subscribe({
    id: `run-notify-${crypto.randomUUID()}`,
    origin: 'cli',
    conversations: null,
    send(frame) {
      const event = frame.event
      const id = frame.conversationId
      if (!id) return
      if (event.type === 'run.error') {
        if (event.runId) errored.add(event.runId)
        report('run.error', id)
        return
      }
      if (event.type !== 'run.finished' || errored.delete(event.runId)) return
      if (event.status === 'done') report('run.finished', id)
      else if (event.status === 'failed') report('run.error', id)
    },
  })
}
