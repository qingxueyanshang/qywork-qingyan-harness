/**
 * 客户端指令的分发与拒绝回执。
 *
 * **未实现的分支必须明确拒绝**，绝不静默 return：客户端发完等不到任何反馈，
 * 表现和「服务端正在处理」在界面上无法区分。
 */

import type { ClientCommand, CommandRejectedFrame, CommandRejectReason } from '@qywork/core'
import { getConversation, setConversationModel } from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { CommandDeps, SocketData } from './deps.ts'
import { compactConversation, resumeGoal, retryRun, setGoal, startRun } from './run-control.ts'
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
      /*
       * `interrupt` 找不到那条 run 时返回 false，**这个返回值必须答回去**。
       *
       * 丢掉它的表现就是本文件头那句话说的形状，而且是最难查的一种：用户点了停止，
       * 按钮没反应、转圈还在转、一条日志都没有——他无法区分「服务端在处理」和
       * 「这条指令根本没人接」。实测撞到过：注册表里已经没有这条 run（收尾跑完了
       * 或者还停在 reserve 没 register），而账本那行还挂着 running，于是界面一直
       * 显示在跑，用户唯一的出路是重启应用。
       */
      if (!deps.runs.interrupt(cmd.runId)) {
        reject(deps.ws, cmd.type, 'conflict', '这一轮已经不在跑了')
      }
      return

    case 'message.send':
      // 附件随消息一起转发。协议、存储、模型侧都支持，漏掉 `cmd.attachments`
      // 这一手的话，整条链路就是有类型没数据。
      await startRun(cmd.conversationId, cmd.content, cmd.model, deps, undefined, cmd.attachments)
      return

    case 'conversation.setModel': {
      // 接口必须在配置里真的存在。放行一个不存在的接口名，会话就指向了一个
      // 发不出请求的地方，而报错要等到下一轮才出现。
      if (!deps.config.providers[cmd.provider]) {
        reject(deps.ws, cmd.type, 'invalid_payload', `配置里没有名为 "${cmd.provider}" 的接口`)
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
      // 广播而不是只回发起方：手机和桌面可能同时开着这个会话。
      deps.bus.publish(
        {
          type: 'conversation.updated',
          conversationId: updated.id,
          provider: updated.provider,
          model: updated.model,
          title: updated.title,
          updatedAt: updated.updatedAt,
        },
        cmd.conversationId,
      )
      return
    }

    case 'goal.set': {
      // 立目标的唯一入口——模型手里没有 create_goal。空正文之类的校验在账本里，
      // 这里只把回绝理由原样端回去。
      const result = setGoal(cmd.conversationId, cmd.objective, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
      return
    }

    case 'goal.resume': {
      // 停下来的目标重新跑起来，并**当场**发起一轮——不能等下一次别的 run 收尾。
      // 没有对应的 pause 指令：跑起来之后要停它就是中断这一轮（`run.interrupt`），
      // run 收尾时会把目标置回 paused。
      const result = resumeGoal(cmd.conversationId, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
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
      // 手动压缩走的是与自动触发同一个 `compaction.run()`，只是判据换成用户的
      // 显式意图——不要在这里另起一条压缩路径。
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
