/**
 * 客户端指令的分发与拒绝回执。
 *
 * 未实现的分支必须明确拒绝，不得静默 return：客户端发送后得不到任何反馈，
 * 在界面上与「服务端正在处理」无法区分。
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
  if (deps.runs.updating && cmd.type !== 'subscribe' && cmd.type !== 'conversation.interrupt') {
    reject(
      deps.ws,
      cmd.type,
      'conflict',
      '应用正在更新，请稍后重试',
      'clientRequestId' in cmd ? cmd.clientRequestId : undefined,
    )
    return
  }

  switch (cmd.type) {
    case 'subscribe':
      deps.bus.setSubscription(deps.ws.data.id, cmd.conversationIds)
      return

    case 'conversation.interrupt': {
      /*
       * 停止该会话正在执行的任务：当前轮次，以及已派发但未返回的子 agent。两者均无法停止时
       * 必须回复。
       *
       * 不回复时客户端得不到任何反馈，无法区分「服务端正在处理」与「指令无人处理」。
       * 已实测的情形：注册表中已没有该会话的 run（收尾已执行完毕，或仍停在 reserve 尚未
       * register），而账本中该行仍为 running，界面持续显示运行中，只能重启应用恢复。
       */
      const stoppedRun = deps.runs.interruptConversation(cmd.conversationId)
      const stoppedSubagents = deps.subagents.interruptConversation(cmd.conversationId)
      if (!stoppedRun && !stoppedSubagents) {
        reject(deps.ws, cmd.type, 'conflict', '本轮已结束')
        return
      }
      /*
       * 图中尚未派发的节点一并写入终态。否则这些节点会一直等待：approve 无法通过
       * （上游回执不全），revise 也无法通过（指定的节点没有终态），该图无法结束。
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
       * 会话运行中时不拒绝，该消息进入队列，去向由 `steer` 决定：
       * 注入当前轮次，或在当前轮次收尾后作为下一轮发起。
       *
       * 忙碌判定与发起轮次在 `submitMessage` 中完成，子 agent 的回执使用同一个函数：
       * 该段必须是同一个同步块（理由见该函数的注释与 `runs.ts` 的 `reserve`）。
       */
      // 子会话只由创建它的图管理：直接发送消息会绕过 workflow 的回执与续接，图的投影
      // 无法得知该轮次。界面没有此入口，配对端使用同一条指令，因此边界在此处检查。
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
      // 附件随消息一同转发。协议、存储与模型侧均已支持，遗漏 `cmd.attachments`
      // 会使整条链路只有类型而没有数据。
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
       * 忙碌 → 修改该消息的去向；空闲 → 队列中已没有可注入的轮次，取出该消息并立即发起一轮。
       * 两种状态在同一个同步块中判定，理由同 `message.send`：客户端持有的忙闲状态是上一次
       * 事件留下的值，点击时可能已经不成立。
       */
      if (deps.runs.hasRun(cmd.conversationId)) {
        if (!deps.runs.setSteer(cmd.conversationId, cmd.id, cmd.steer)) {
          reject(deps.ws, cmd.type, 'conflict', '该跟进消息已不在队列中')
        }
        return
      }
      const item = deps.runs.queueOf(cmd.conversationId).find((f) => f.id === cmd.id)
      if (!item || !deps.runs.removeFollowUp(cmd.conversationId, cmd.id)) {
        reject(deps.ws, cmd.type, 'conflict', '该跟进消息已不在队列中')
        return
      }
      // 使用同一个函数：该消息若是子 agent 的回执，发起轮次时来源须一并写入消息行。
      await submitMessage(cmd.conversationId, item, deps)
      return
    }

    case 'followup.drop': {
      // 删除失败只有一种可能：该消息已被注入或已发出。必须如实拒绝，不得静默返回成功：
      // 否则「删除后卡片仍在」与「服务端未收到」在界面上无法区分。
      if (!deps.runs.removeFollowUp(cmd.conversationId, cmd.id)) {
        reject(deps.ws, cmd.type, 'conflict', '该跟进消息已不在队列中')
      }
      return
    }

    case 'conversation.setModel': {
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
          updatedAt: updated.updatedAt,
        },
        cmd.conversationId,
      )
      return
    }

    case 'goal.set': {
      // 设立目标的唯一入口：模型没有 create_goal 工具。空正文等校验在账本中执行，
      // 此处只将拒绝理由原样返回。
      const result = setGoal(cmd.conversationId, cmd.objective, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
      return
    }

    case 'goal.resume': {
      // 重新运行已停止的目标，并立即发起一轮：不能等待其他 run 收尾。
      // 没有对应的 pause 指令：运行之后停止目标的方式是中断该会话（`conversation.interrupt`），
      // run 收尾时会将目标置回 paused。
      const result = resumeGoal(cmd.conversationId, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
      return
    }

    case 'conversation.compact': {
      // 手动压缩与自动触发使用同一个 `compaction.run()`，区别只在于判据为用户的
      // 显式意图：不要在此另建压缩路径。
      // 忙碌检查使用 `isBusy`：子 agent 的回执随时可能发起一轮，而压缩修改的正是该轮要读取的历史。
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
      // 协议中不存在的 type。来源是版本高于服务端的客户端或伪造流量，两种情况都必须回执；
      // 静默丢弃会使前者的功能时而生效时而无效，后者则完全得不到反馈。
      const unknown = cmd as { type?: unknown }
      reject(
        deps.ws,
        String(unknown.type ?? '(missing)'),
        'unknown_command',
        '服务端无法识别该指令',
      )
      return
    }
  }
}

/** 指令回执只发送给发起方：其他客户端未发送该指令，无需收到回执。 */
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
