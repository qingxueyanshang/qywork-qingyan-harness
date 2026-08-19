import { For, type JSX } from 'solid-js'
import { type SettingsPage, setSettingsPage, settingsPage } from '../../lib/store/index.ts'
import {
  IconBrain,
  IconCanvas,
  IconClock,
  IconFile,
  IconPackage,
  IconPlug,
  IconSettings,
  IconShield,
  IconTerminal,
  IconUsers,
} from '../Icons.tsx'

/**
 * 设置的类目导航。**它是弹窗里的左边一栏**，不带出口——关闭在弹窗头部那个 ×，
 * 一个浮层只该有一条关法。
 *
 * 分两组，中间一条分隔线，判据是**说明书还是操作台**：
 * 上组三项回答「这个 agent 是什么」——长什么样、用哪个模型、由哪些模块组成；
 * 「模块」那一页只读，全部读数与说明都在里面。下组每一项是一个模块的操作台，
 * 都有真实的表单。
 *
 * 上一版的判据是「这台机器怎么跑 / agent 带着什么」，**分不开**：
 * 「权限与沙箱」两边都算，而「工具」在上组、同样产出工具的 MCP 与插件在下组。
 * 「手机接入」现在并进「通用」——它是应用怎么被访问，不是 agent 的能力模块。
 */
interface Item {
  id: SettingsPage
  label: string
  icon: (p: { size?: number }) => JSX.Element
}

const GROUPS: Item[][] = [
  [
    { id: 'general', label: '通用', icon: IconSettings },
    { id: 'models', label: '模型', icon: IconPackage },
    { id: 'modules', label: '模块', icon: IconCanvas },
  ],
  [
    { id: 'access', label: '权限', icon: IconShield },
    { id: 'memory', label: '记忆', icon: IconBrain },
    { id: 'skills', label: '技能', icon: IconFile },
    { id: 'team', label: '智能体', icon: IconUsers },
    { id: 'mcp', label: 'MCP', icon: IconTerminal },
    { id: 'plugins', label: '插件', icon: IconPlug },
    { id: 'schedules', label: '定时任务', icon: IconClock },
  ],
]

export function SettingsNav() {
  return (
    <nav class="settings-nav">
      <For each={GROUPS}>
        {(group, i) => (
          <ul class="nav-list" classList={{ 'nav-group-split': i() > 0 }}>
            <For each={group}>
              {(item) => (
                <li>
                  <button
                    class="nav-item"
                    classList={{ active: settingsPage() === item.id }}
                    type="button"
                    onClick={() => setSettingsPage(item.id)}
                  >
                    <item.icon size={15} />
                    {item.label}
                  </button>
                </li>
              )}
            </For>
          </ul>
        )}
      </For>
    </nav>
  )
}
