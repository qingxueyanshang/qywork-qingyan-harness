/** 当前目标：设立与重新运行。 */

import { resumeGoal, setGoal } from '../run-control.ts'
import { handlers } from './handler.ts'
import { reject, rejectChildConversation } from './reject.ts'

export const goalCommands = handlers({
  'goal.set': {
    handle(cmd, deps) {
      // 设立目标的唯一入口：模型没有 create_goal 工具。空正文等校验在账本中执行，
      // 此处只将拒绝理由原样返回。
      if (rejectChildConversation(deps, cmd.type, cmd.conversationId)) return
      const result = setGoal(cmd.conversationId, cmd.objective, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
    },
  },

  'goal.resume': {
    handle(cmd, deps) {
      // 重新运行已停止的目标，并立即发起一轮：不能等待其他 run 收尾。
      // 没有对应的 pause 指令：运行之后停止目标的方式是中断该会话（`conversation.interrupt`），
      // run 收尾时会将目标置回 paused。
      if (rejectChildConversation(deps, cmd.type, cmd.conversationId)) return
      const result = resumeGoal(cmd.conversationId, deps)
      if (!result.ok) reject(deps.ws, cmd.type, 'conflict', result.message)
    },
  },
})
