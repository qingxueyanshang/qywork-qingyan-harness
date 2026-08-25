/**
 * 命令表——**命令面板与输入区斜杠命令共用的那一份**。
 *
 * 两个入口，一份清单。分成两份的代价是必然漂移：加一条命令时只想得起改一处，
 * 因此「Ctrl-K 搜得到、打 `/` 搜不到」这种问题会长期存在，而且没人会觉得
 * 它是 bug——两边都「有」，只是不一样。
 *
 * **每一条都必须真的产生可观察的变化。** 命令面板里的死命令比死按钮更隐蔽：用户搜到了、回车、什么都
 * 没发生，且没有任何反馈。加新条目前先确认那个动作真的存在，别留空函数。
 *
 * **斜杠名只给「在打字途中会想用」的那几条。** 不是每条命令都配 `slash`。设置、插件这类是导航，用
 * Ctrl-K 更合适；斜杠是**手已经在输入框里**时的快捷方式，只有压缩、清空这种和当前这轮直接相关的才
 * 值得占一个斜杠名。
 */

import type { JSX } from 'solid-js'
import {
  IconClock,
  IconEye,
  IconFile,
  IconNewChat,
  IconPlug,
  IconSettings,
  IconSpinner,
  IconTarget,
  IconUsers,
} from '../components/Icons.tsx'
import { slashQuery } from './slash.ts'
import {
  compactContext,
  newConversation,
  openPanel,
  openSettings,
  setGoal,
  state,
} from './store/index.ts'

export interface Command {
  id: string
  label: string
  /** 斜杠名。省略 = 只在命令面板里出现，不占斜杠。 */
  slash?: string
  /** 一句话说清代价或去处。斜杠弹层里显示，命令面板里也显示。 */
  hint?: string
  icon: (p: { size?: number }) => JSX.Element
  /**
   * 这条命令后面要跟一段话。给了它的命令**不能从面板直接执行**——
   * 在面板里选中只把 `/名字 ` 填进草稿，等用户把话打完再回车。
   * 没有它的命令点一下就跑。
   */
  arg?: { placeholder: string }
  run(arg?: string): void
}

export function buildCommands(): Command[] {
  return [
    {
      id: 'new',
      label: '新对话',
      slash: 'clear',
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
    { id: 'review', label: '审阅改动', icon: IconEye, run: () => openPanel('changes') },
    { id: 'files', label: '文件', icon: IconFile, run: () => openPanel('files') },
    // 这四条现在是设置里的类目，命令面板直接跳到那一页——
    // 让用户「先进设置再自己找」等于把命令面板的价值抵消掉。
    { id: 'team', label: 'Agent Team', icon: IconUsers, run: () => openSettings('team') },
    { id: 'schedules', label: '定时任务', icon: IconClock, run: () => openSettings('schedules') },
    { id: 'plugins', label: '插件', icon: IconPlug, run: () => openSettings('plugins') },
    { id: 'settings', label: '设置', icon: IconSettings, run: () => openSettings() },
  ]
}

export function matchSlash(draft: string): Command[] {
  const q = slashQuery(draft)
  if (q === null) return []
  return buildCommands().filter((c) => c.slash?.startsWith(q))
}
