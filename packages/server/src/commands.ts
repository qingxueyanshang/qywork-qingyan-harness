/**
 * 客户端指令的分发与拒绝回执。
 *
 * **未实现的分支必须明确拒绝**，绝不静默 return：客户端发完等不到任何反馈，
 * 表现和「服务端正在处理」在界面上无法区分。
 */

import type { ClientCommand, CommandRejectedFrame, CommandRejectReason } from '@qywork/core'
import { EFFORT_ORDER } from '@qywork/core'
import { getConversation, setConversationEffort, setConversationModel } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { CommandDeps, SocketData } from './deps.ts'
import { compactConversation, retryRun, startRun } from './run-control.ts'
import { runTeam } from './team-run.ts'

export async function handleCommand(cmd: ClientCommand, deps: CommandDeps): Promise<void> {
  if (!deps.ws.data.authed) return

  switch (cmd.type) {
    case 'subscribe':
      deps.bus.setSubscription(deps.ws.data.id, cmd.conversationIds)
      return

    case 'permission.resolve': {
      const by = deps.ws.data.origin === 'mobile' ? 'mobile' : 'desktop'
      deps.runs.resolvePermission(cmd.requestId, cmd.granted, by, cmd.scopeId)
      return
    }

    case 'run.interrupt':
      deps.runs.interrupt(cmd.runId)
      return

    case 'message.send':
      // 附件随消息一起转发。协议、存储、模型侧本来就都支持，缺的只是这一手传递
      // ——之前这里把 `cmd.attachments` 丢在地上，于是整条链路有类型没数据。
      await startRun(cmd.conversationId, cmd.content, cmd.model, deps, undefined, cmd.attachments)
      return

    case 'conversation.setModel': {
      const updated = setConversationModel(deps.store, cmd.conversationId, cmd.model)
      if (!updated) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      // 广播而不是只回发起方：手机和桌面可能同时开着这个会话。
      deps.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: updated.id,
          model: updated.model,
          effort: updated.effort,
          title: updated.title,
        },
        cmd.conversationId,
      )
      return
    }

    case 'conversation.setEffort': {
      // 档位在这里校验，不是在界面上。界面按当前模型的 effortLevels 出选项，
      // 但指令可以从任何客户端来——落盘一个不在词表里的值，下一轮就会被
      // 原样发给 provider，然后是一个 400。
      if (cmd.effort !== null && !EFFORT_ORDER.includes(cmd.effort)) {
        reject(deps.ws, cmd.type, 'invalid_payload', `不认识的思考强度：${cmd.effort}`)
        return
      }
      const updated = setConversationEffort(deps.store, cmd.conversationId, cmd.effort)
      if (!updated) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      deps.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: updated.id,
          model: updated.model,
          effort: updated.effort,
          title: updated.title,
        },
        cmd.conversationId,
      )
      return
    }

    case 'run.retry': {
      await retryRun(cmd.runId, cmd.clientRequestId, deps)
      return
    }

    case 'team.run': {
      await runTeam(cmd.conversationId, cmd.goal, cmd.clientRequestId, deps)
      return
    }

    case 'conversation.compact': {
      // 手动压缩是与「provider 拒绝驱动」并列的第二条入口。原版文件名就写着
      // `Rejection-driven / manual`——手动那条没有 provider 拒绝可依据，
      // 由用户的显式意图代替判据。
      if (deps.runs.isBusy(cmd.conversationId)) {
        reject(deps.ws, cmd.type, 'conflict', '该会话正在执行，请先中断再压缩')
        return
      }
      const conv = getConversation(deps.store, cmd.conversationId)
      if (!conv) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      await compactConversation(cmd.conversationId, deps)
      return
    }

    default: {
      // 协议里没有的 type。客户端比服务端新，或者是伪造流量——两种都必须回执，
      // 静默吞掉会让前者表现为「功能时灵时不灵」，让后者完全无声无息。
      const unknown = cmd as { type?: unknown }
      reject(deps.ws, String(unknown.type ?? '(missing)'), 'unknown_command', '服务端不认识该指令')
      return
    }
  }
}

/** 指令回执只回给发起方——别的客户端没发过这条指令，收到只会困惑。 */
export function reject(
  ws: ServerWebSocket<SocketData>,
  command: string,
  reason: CommandRejectReason,
  message: string,
  clientRequestId?: string,
): void {
  const frame: CommandRejectedFrame = {
    type: 'command.rejected',
    command,
    reason,
    message,
    ...(clientRequestId ? { clientRequestId } : {}),
  }
  ws.send(JSON.stringify(frame))
}
