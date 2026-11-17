/** 会话的订阅、模型与权限模式。 */

import { setConversationMode, setConversationModel } from '@qywork/store'
import { handlers } from './handler.ts'
import { reject } from './reject.ts'

export const conversationCommands = handlers({
  subscribe: {
    handle(cmd, deps) {
      deps.bus.setSubscription(deps.ws.data.id, cmd.conversationIds)
    },
  },

  'conversation.setModel': {
    handle(cmd, deps) {
      // 接口必须在配置中实际存在。放行不存在的接口名会使会话指向
      // 无法发送请求的接口，且报错要到下一轮才出现。
      if (!deps.config.providers[cmd.provider]) {
        reject(deps.ws, cmd.type, 'invalid_payload', `配置中没有名为 "${cmd.provider}" 的接口`)
        return
      }
      const updated = setConversationModel(deps.store, cmd.conversationId, {
        provider: cmd.provider,
        model: cmd.model,
      })
      if (!updated) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      // 广播而不是只回复发起方：手机端与桌面端可能同时打开该会话。
      deps.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: updated.id,
          provider: updated.provider,
          model: updated.model,
          title: updated.title,
          mode: updated.mode,
          updatedAt: updated.updatedAt,
        },
        cmd.conversationId,
      )
    },
  },

  'conversation.setMode': {
    handle(cmd, deps) {
      // 取值在写入前校验：账本列的 CHECK 约束会使非法值在 UPDATE 时抛出，指令没有回执。
      if (cmd.mode !== 'auto' && cmd.mode !== 'full') {
        reject(deps.ws, cmd.type, 'invalid_payload', `未知的权限模式 "${String(cmd.mode)}"`)
        return
      }
      const updated = setConversationMode(deps.store, cmd.conversationId, cmd.mode)
      if (!updated) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      deps.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: updated.id,
          provider: updated.provider,
          model: updated.model,
          title: updated.title,
          mode: updated.mode,
          updatedAt: updated.updatedAt,
        },
        cmd.conversationId,
      )
    },
  },
})
