/**
 * 新开会话端口（`ConversationPort`）的实现：在本会话所在的工作区新建一条用户会话，广播 `conversation.created`
 * 使它出现在会话列表中，再把第一条消息交给 `send` 投递。
 *
 * 新会话的接口、模型与权限模式取本会话的当前值。不要把权限模式改为配置中的默认值：「自动审批」会话中的模型
 * 可借此开出「完全访问」的会话并向其发送任意指令，本会话的权限边界随之失效。
 *
 * `send` 由装配方传入（`run-control.ts` 以 `submitMessage` 投递，与用户发送消息同一路径）；
 * 不在此处导入 run-control，否则两个模块互相导入。
 */

import { type ConversationId, conversationSummary } from '@qywork/core'
import { createConversation, getConversation, type Store } from '@qywork/store'
import type { ConversationPort } from '@qywork/tools'
import type { EventBus } from '../bus.ts'

export function conversationPortOf(
  deps: { store: Store; bus: EventBus },
  from: ConversationId,
  send: (to: ConversationId, content: string) => Promise<void>,
): ConversationPort {
  return {
    async open({ title, message }) {
      const origin = getConversation(deps.store, from)
      if (!origin) throw new Error('本会话已不存在')
      const conversation = createConversation(deps.store, {
        workspaceId: origin.workspaceId,
        provider: origin.provider,
        model: origin.model,
        ...(title ? { title } : {}),
        mode: origin.mode,
      })
      deps.bus.publish({
        type: 'conversation.created',
        conversation: conversationSummary(conversation),
      })
      await send(conversation.id, message)
      return { id: conversation.id, title: conversation.title }
    },
  }
}
