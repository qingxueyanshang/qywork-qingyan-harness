/**
 * 输入区的斜杠命令表。
 *
 * 此处只放输入过程中需要使用的动作：新对话、压缩上下文、设定目标与创建角色。
 * 设置与面板各有可见入口，不为它们另建搜索导航。
 */

import { ROLE_COMMAND } from '@qywork/core'
import type { JSX } from 'solid-js'
import { IconNewChat, IconSpinner, IconTarget, IconUsers } from '../components/Icons.tsx'
import { slashQuery } from './slash.ts'
import { compactContext, newConversation, sendMessage, setGoal, state } from './store/index.ts'

export interface Command {
  id: string
  label: string
  /** 输入框中使用的斜杠命令名。 */
  slash: string
  /** 用一句话说明代价或结果去向。 */
  hint?: string
  icon: (p: { size?: number }) => JSX.Element
  /**
   * 该命令需要参数。选中时只把 `/名字 ` 填入草稿，由用户输入参数后回车提交。
   */
  arg?: { placeholder: string }
  run(arg?: string): void
}

export function buildCommands(): Command[] {
  return [
    {
      id: 'new',
      label: '新对话',
      slash: 'new',
      hint: '当前对话保留在列表中',
      icon: IconNewChat,
      run: () => void newConversation(),
    },
    {
      id: 'compact',
      // 标题显示当前占用：用户依据该数值决定是否压缩，放在别处会迫使用户另行查询。
      label: state.context ? `压缩上下文（当前 ${state.context.percent}%）` : '压缩上下文',
      slash: 'compact',
      hint: '早期轮次压缩为摘要，模型不再读取原文',
      icon: IconSpinner,
      run: compactContext,
    },
    {
      id: 'goal',
      label: '设定目标',
      slash: 'goal',
      // 边界：该命令会自动逐轮执行。
      hint: '逐轮自动执行，直到完成或点击停止',
      arg: { placeholder: '描述要达成的目标' },
      icon: IconTarget,
      run: (objective) => setGoal(objective ?? ''),
    },
    {
      id: 'role',
      label: '创建角色',
      slash: ROLE_COMMAND.slice(1),
      hint: '写入当前项目的 Agent Team，之后可通过 @ 调用',
      arg: { placeholder: '描述角色的职责与工作方式' },
      icon: IconUsers,
      // 原文作为用户消息进入当前会话；提示词依据该前缀将其识别为明确的创建角色请求。
      // 角色是持久定义，不是本次任务的子 agent。
      run: (description) => sendMessage(`${ROLE_COMMAND} ${description ?? ''}`.trimEnd()),
    },
  ]
}

export function matchSlash(draft: string): Command[] {
  const q = slashQuery(draft)
  if (q === null) return []
  return buildCommands().filter((c) => c.slash.startsWith(q))
}
