/** 停止与压缩：停止会话的执行、停止一条后台命令、手动压缩。 */

import { getConversation, interruptRunningNodes, listRuns } from '@qywork/store'
import { compactConversation } from '../run-control.ts'
import { handlers } from './handler.ts'
import { reject } from './reject.ts'

export const controlCommands = handlers({
  'conversation.interrupt': {
    handle(cmd, deps) {
      /*
       * 停止该会话正在执行的任务：占用该会话的执行（运行中或尚在准备阶段的轮次、手动压缩），
       * 以及已派发但未返回的子 agent。两者均无法停止时必须回复。
       *
       * 不回复时客户端得不到任何反馈，无法区分「服务端正在处理」与「指令无人处理」。
       * 已实测的情形：注册表中已没有该会话的占用（收尾已执行完毕），而账本中该行仍为 running，
       * 界面持续显示运行中，只能重启应用恢复。
       */
      const stoppedRun = deps.runs.interruptConversation(cmd.conversationId)
      const stopping = new Set(
        deps.subagents.listOf(cmd.conversationId).map((entry) => entry.subagentId),
      )
      const stoppedSubagents = deps.subagents.interruptConversation(cmd.conversationId)
      if (!stoppedRun && !stoppedSubagents) {
        reject(deps.ws, cmd.type, 'conflict', '本轮已结束')
        return
      }
      /*
       * 图中尚未派发的节点一并写入终态。否则这些节点会一直等待：approve 无法通过
       * （上游回执不全），revise 也无法通过（指定的节点没有终态），该图无法结束。
       * 刚停止的子 agent 所在节点除外，其终态由完成回调写入。
       */
      for (const run of listRuns(deps.store, cmd.conversationId)) {
        for (const changed of interruptRunningNodes(deps.store, run.id, stopping)) {
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
    },
  },

  'command.stop': {
    handle(cmd, deps) {
      // 只停止这一条后台命令，会话中的其他执行不受影响。不在表中只有一种可能：该命令已结束。
      if (!deps.commands?.stop(cmd.conversationId, cmd.id)) {
        reject(deps.ws, cmd.type, 'conflict', '该命令已结束')
      }
    },
  },

  'conversation.compact': {
    async handle(cmd, deps) {
      // 手动压缩与自动触发使用同一个 `compaction.run()`，区别只在于判据为用户的
      // 显式意图：不要在此另建压缩路径。会话被占用时由 `compactConversation` 的占位拒绝。
      const conv = getConversation(deps.store, cmd.conversationId)
      if (!conv) {
        reject(deps.ws, cmd.type, 'invalid_payload', '会话不存在')
        return
      }
      const result = await compactConversation(cmd.conversationId, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
    },
  },
})
