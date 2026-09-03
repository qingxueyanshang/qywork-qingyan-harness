/**
 * 输入区的斜杠命令表。
 *
 * 这里只放「在打字途中会想用」的动作：新对话、压缩与立目标。设置和面板都有
 * 自己的可见入口，不再为它们维护一套搜索导航。
 */

import { ROLE_COMMAND } from '@qywork/core'
import type { JSX } from 'solid-js'
import { IconNewChat, IconSpinner, IconTarget, IconUsers } from '../components/Icons.tsx'
import { slashQuery } from './slash.ts'
import { compactContext, newConversation, sendMessage, setGoal, state } from './store/index.ts'

export interface Command {
  id: string
  label: string
  /** 输入框里使用的斜杠名。 */
  slash: string
  /** 一句话说清代价或去处。 */
  hint?: string
  icon: (p: { size?: number }) => JSX.Element
  /**
   * 这条命令后面要跟一段话。选中时只把 `/名字 ` 填进草稿，等用户打完再回车。
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
      hint: '当前对话留在列表里',
      icon: IconNewChat,
      run: () => void newConversation(),
    },
    {
      id: 'compact',
      // 标题带上当前占用：这个数决定按不按，藏在别处等于让用户先去查一次。
      label: state.context ? `压缩上下文（当前 ${state.context.percent}%）` : '压缩上下文',
      slash: 'compact',
      hint: '早期轮次折成摘要，原文模型看不到',
      icon: IconSpinner,
      run: compactContext,
    },
    {
      id: 'goal',
      label: '立目标',
      slash: 'goal',
      // 边界：它会自己一轮轮跑下去。
      hint: '一轮接一轮做下去，直到做完或你按停止',
      arg: { placeholder: '要做到什么' },
      icon: IconTarget,
      run: (objective) => setGoal(objective ?? ''),
    },
    {
      id: 'role',
      label: '创建角色',
      slash: ROLE_COMMAND.slice(1),
      hint: '写入当前项目 Agent Team，之后可用 @ 点名',
      arg: { placeholder: '描述角色的职责与工作方式' },
      icon: IconUsers,
      // 原文作为用户消息进入同一条会话；提示词按这个前缀说明这是一次明确的建角色要求。
      // 角色是持久定义，不是这次任务的子 agent。
      run: (description) => sendMessage(`${ROLE_COMMAND} ${description ?? ''}`.trimEnd()),
    },
  ]
}

export function matchSlash(draft: string): Command[] {
  const q = slashQuery(draft)
  if (q === null) return []
  return buildCommands().filter((c) => c.slash.startsWith(q))
}
