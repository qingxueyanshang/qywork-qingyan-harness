/**
 * 客户端指令的分发与拒绝回执。
 *
 * **未实现的分支必须明确拒绝**，绝不静默 return：客户端发完等不到任何反馈，
 * 表现和「服务端正在处理」在界面上无法区分。
 */

import type { ClientCommand, CommandRejectedFrame, CommandRejectReason } from '@qywork/core'
import {
  getConversation,
  interruptRunningNodes,
  listRuns,
  setConversationModel,
} from '@qywork/store'
import type { ServerWebSocket } from 'bun'
import type { CommandDeps, SocketData } from './deps.ts'
import { compactConversation, resumeGoal, setGoal, submitMessage } from './run-control.ts'

export async function handleCommand(cmd: ClientCommand, deps: CommandDeps): Promise<void> {
  if (!deps.ws.data.authed) return

  switch (cmd.type) {
    case 'subscribe':
      deps.bus.setSubscription(deps.ws.data.id, cmd.conversationIds)
      return

    case 'conversation.interrupt': {
      /*
       * 停这条会话手上的活：这一轮，以及派出去还没回来的子 agent。两样都停不到时
       * **必须答回去**。
       *
       * 丢掉那个返回值的现象就是本文件头那句话说的形状，而且是最难查的一种：用户点了停止，
       * 按钮没反应、转圈还在转、一条日志都没有——他无法区分「服务端在处理」和
       * 「这条指令没人接」。实测形状：注册表里已经没有这条会话的 run（收尾跑完了
       * 或者还停在 reserve 没 register），而账本那行还挂着 running，因此界面一直
       * 显示在跑，用户唯一的出路是重启应用。
       */
      const stoppedRun = deps.runs.interruptConversation(cmd.conversationId)
      const stoppedSubagents = deps.subagents.interruptConversation(cmd.conversationId)
      if (!stoppedRun && !stoppedSubagents) {
        reject(deps.ws, cmd.type, 'conflict', '这一轮已经不在跑了')
        return
      }
      /*
       * 图上还没派出去的格跟着落终态。不落的话它永远等在那里：approve 过不去
       * （上游回执不齐），revise 也过不去（点名的格没有终态），那张图再没有出口。
       */
      for (const run of listRuns(deps.store, cmd.conversationId)) {
        for (const changed of interruptRunningNodes(deps.store, run.id)) {
          deps.bus.publish(
            {
              type: 'team.member',
              runId: run.id,
              stepId: changed.stepId,
              nodeId: changed.nodeId,
              state: changed.state,
            },
            cmd.conversationId,
          )
        }
      }
      return
    }

    case 'message.send': {
      /*
       * 会话在跑时**不再回绝**，这一条排进队列，去向由 `steer` 决定：
       * 注入当前这一轮，或者等这一轮收尾后作为下一轮发起。
       *
       * 判忙与起轮在 `submitMessage` 里，子 agent 的回执走的是同一个函数：
       * 那一段必须是同一个同步块（理由见它那段注释与 `runs.ts` 的 `reserve`）。
       */
      // 子会话只归建立它的那张图管：直接发消息会绕过 workflow 的回执与续接，图的投影
      // 不知道这一轮发生过。界面没有这个入口，配对端走同一条指令，边界在这里补齐。
      if (getConversation(deps.store, cmd.conversationId)?.source) {
        reject(
          deps.ws,
          cmd.type,
          'conflict',
          '子会话只能由父会话的 workflow 续发',
          cmd.clientRequestId,
        )
        return
      }
      // 附件随消息一起转发。协议、存储、模型侧都支持，漏掉 `cmd.attachments`
      // 这一手的话，整条链路就是有类型没数据。
      await submitMessage(
        cmd.conversationId,
        {
          id: cmd.clientRequestId,
          content: cmd.content,
          ...(cmd.attachments?.length ? { attachments: cmd.attachments } : {}),
          steer: cmd.steer === true,
        },
        deps,
        cmd.model,
      )
      return
    }

    case 'followup.steer': {
      /*
       * 忙 → 改这一条的去向；闲 → 队列里已经没有可注入的那一轮，取走它当场起一轮。
       * 两态在同一个同步块里裁决，理由同 `message.send`：客户端手里的忙闲是上一次
       * 事件留下的值，它点下去那一刻可能已经不成立。
       */
      if (deps.runs.hasRun(cmd.conversationId)) {
        if (!deps.runs.setSteer(cmd.conversationId, cmd.id, cmd.steer)) {
          reject(deps.ws, cmd.type, 'conflict', '这条跟进消息已经不在队列里')
        }
        return
      }
      const item = deps.runs.queueOf(cmd.conversationId).find((f) => f.id === cmd.id)
      if (!item || !deps.runs.removeFollowUp(cmd.conversationId, cmd.id)) {
        reject(deps.ws, cmd.type, 'conflict', '这条跟进消息已经不在队列里')
        return
      }
      // 走同一个函数：那一条如果是子 agent 的回执，起轮时来源要跟着落到消息行上。
      await submitMessage(cmd.conversationId, item, deps)
      return
    }

    case 'followup.drop': {
      // 删不掉只有一种可能：它已经被注入或火发掉了。如实回绝，不静默成功——
      // 「点了删除、卡片还在」和「服务端没收到」在界面上无法区分。
      if (!deps.runs.removeFollowUp(cmd.conversationId, cmd.id)) {
        reject(deps.ws, cmd.type, 'conflict', '这条跟进消息已经不在队列里')
      }
      return
    }

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
      // 没有对应的 pause 指令：跑起来之后要停它就是中断这条会话（`conversation.interrupt`），
      // run 收尾时会把目标置回 paused。
      const result = resumeGoal(cmd.conversationId, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
      return
    }

    case 'conversation.compact': {
      // 手动压缩走的是与自动触发同一个 `compaction.run()`，只是判据换成用户的
      // 显式意图——不要在这里另起一条压缩路径。
      // 闸认 `isBusy`：子 agent 的回执随时会起一轮，而压缩改的正是那一轮要读的历史。
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
