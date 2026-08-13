/**
 * 命令表——**命令面板与输入区斜杠命令共用的那一份**。
 *
 * 两个入口，一份清单。分成两份的代价是必然漂移：加一条命令时只想得起改一处，
 * 于是「Ctrl-K 搜得到、打 `/` 搜不到」这种问题会长期存在，而且没人会觉得
 * 它是 bug——两边都「有」，只是不一样。
 *
 * ## 每一条都必须真的产生可观察的变化
 *
 * 这份清单曾经有三条空函数（`browser` / `terminal` / `新对话`）。
 * 命令面板里的死命令比按钮更隐蔽：用户搜到了、回车、什么都没发生，
 * 还以为是自己搜错了。加新条目前先确认那个动作真的存在。
 *
 * ## 斜杠名只给「在打字途中会想用」的那几条
 *
 * 不是每条命令都配 `slash`。设置、插件这类是「我要去哪」，用 Ctrl-K 更顺手；
 * 斜杠是**手已经在输入框里**时的快捷方式，只有压缩、清空这种和当前这轮
 * 直接相关的才值得占一个斜杠名。参照物（青研魔盒）的 `/compact` `/clear`
 * 也正是这两条。
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
  IconUsers,
} from '../components/Icons.tsx'
import { slashQuery } from './slash.ts'
import { compactContext, newConversation, openPanel, openSettings, state } from './store/index.ts'

export interface Command {
  id: string
  label: string
  /** 斜杠名。省略 = 只在命令面板里出现，不占斜杠。 */
  slash?: string
  /** 一句话说清代价或去处。斜杠弹层里显示，命令面板里也显示。 */
  hint?: string
  icon: (p: { size?: number }) => JSX.Element
  run(): void
}

export function buildCommands(): Command[] {
  return [
    {
      id: 'new',
      label: '新对话',
      slash: 'clear',
      hint: '开一轮新的，当前这轮留在列表里',
      icon: IconNewChat,
      run: () => void newConversation(),
    },
    {
      id: 'compact',
      // 文案说清代价：压缩不可见地改变模型能看到的东西，
      // 只写「压缩上下文」的话用户不知道自己按下去会发生什么。
      label: state.context ? `压缩上下文（当前 ${state.context.percent}%）` : '压缩上下文',
      slash: 'compact',
      hint: '把早期轮次折成摘要，腾出上下文；折过的原文模型就看不到了',
      icon: IconSpinner,
      run: compactContext,
    },
    { id: 'review', label: '审阅改动', icon: IconEye, run: () => openPanel('git') },
    { id: 'files', label: '文件', icon: IconFile, run: () => openPanel('files') },
    { id: 'team', label: 'Agent 团队', icon: IconUsers, run: () => openPanel('team') },
    // 这三条现在是设置里的类目，命令面板直接跳到那一页——
    // 让用户「先进设置再自己找」等于把命令面板的价值抵消掉。
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
