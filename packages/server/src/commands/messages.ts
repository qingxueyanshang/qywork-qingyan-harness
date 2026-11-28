/** 发送消息与跟进队列：发起轮次、修改排队消息的去向、删除排队消息。 */

import { viewingOf, workspaceOf } from '@qywork/store'
import { startRun, submitMessage } from '../run-control.ts'
import { handlers } from './handler.ts'
import { reject, rejectChildConversation } from './reject.ts'

export const messageCommands = handlers({
  'message.send': {
    async handle(cmd, deps) {
      /*
       * 会话运行中时不拒绝，该消息进入队列，去向由 `steer` 决定：
       * 注入当前轮次，或在当前轮次收尾后作为下一轮发起。
       *
       * 忙碌判定与发起轮次在 `submitMessage` 中完成，子 agent 的回执使用同一个函数：
       * 该段必须是同一个同步块（理由见该函数的注释与 `runs.ts` 的 `reserve`）。
       */
      if (rejectChildConversation(deps, cmd.type, cmd.conversationId, cmd.clientRequestId)) return
      // 最近查看的文件由服务端按工作区记录（任一客户端的面板显示画布或文件时更新），不由发送端附带：
      // 手机上的面板覆盖全屏，打字时已收起，发送端附带时手机发出的消息不带电脑上打开的画布。
      const ws = workspaceOf(deps.store, cmd.conversationId)
      const viewing = ws ? viewingOf(deps.store, ws.id) : null
      // 附件随消息一同转发。协议、存储与模型侧均已支持，遗漏 `cmd.attachments`
      // 会使整条链路只有类型而没有数据。
      await submitMessage(
        cmd.conversationId,
        {
          id: cmd.clientRequestId,
          content: cmd.content,
          ...(cmd.attachments?.length ? { attachments: cmd.attachments } : {}),
          steer: cmd.steer === true,
          ...(viewing ? { viewing } : {}),
        },
        deps,
        cmd.model,
      )
    },
  },

  'followup.steer': {
    async handle(cmd, deps) {
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
      if (rejectChildConversation(deps, cmd.type, cmd.conversationId)) return
      const item = deps.runs.queueOf(cmd.conversationId).find((f) => f.id === cmd.id)
      if (!item || !deps.runs.removeFollowUp(cmd.conversationId, cmd.id, true)) {
        reject(deps.ws, cmd.type, 'conflict', '该跟进消息已不在队列中')
        return
      }
      /*
       * 直接发起一轮，不要改为 `submitMessage`：它对带来源的条目检查父轮终态，父轮出错或被停止时
       * 把回执放回队列，用户点击「发送」后条目原样留在队列中。点击是用户的操作，不受该检查约束。
       * 该消息若是子 agent 的回执，来源须一并写入消息行。
       */
      await startRun(
        cmd.conversationId,
        item.content,
        undefined,
        deps,
        item.attachments,
        item.origin ? { kind: 'receipt', origin: item.origin } : undefined,
        item.viewing,
      )
    },
  },

  'followup.drop': {
    handle(cmd, deps) {
      // 删除失败只有一种可能：该消息已被注入或已发出。必须如实拒绝，不得静默返回成功：
      // 否则「删除后卡片仍在」与「服务端未收到」在界面上无法区分。
      if (!deps.runs.removeFollowUp(cmd.conversationId, cmd.id)) {
        reject(deps.ws, cmd.type, 'conflict', '该跟进消息已不在队列中')
      }
    },
  },
})
