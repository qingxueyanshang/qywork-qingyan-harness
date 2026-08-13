import { For, type JSX } from 'solid-js'
import {
  closeSettings,
  type SettingsPage,
  setSettingsPage,
  settingsPage,
} from '../../lib/store/index.ts'
import {
  IconBrain,
  IconChevron,
  IconClock,
  IconFile,
  IconPackage,
  IconPhone,
  IconPlug,
  IconSettings,
  IconShield,
  IconTerminal,
  IconUsers,
} from '../Icons.tsx'

/**
 * 设置的类目导航。**它占的是左栏的位置**，会话列表在看设置时整个让出去。
 *
 * 分两组，中间一条分隔线，判据是「改的是谁」：
 * 上组是这台机器怎么跑（外观、模型、能碰哪些路径），下组是 agent 带着什么
 * （团队、记忆、插件、定时、手机）。上一版把下组那五项平铺在左栏底部，
 * 和「设置」并排——它们其实是设置的子项，不是它的兄弟。
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
    { id: 'access', label: '权限与沙箱', icon: IconShield },
  ],
  [
    { id: 'team', label: '智能体', icon: IconUsers },
    { id: 'memory', label: '记忆', icon: IconBrain },
    { id: 'skills', label: '技能', icon: IconFile },
    { id: 'mcp', label: 'MCP', icon: IconTerminal },
    { id: 'plugins', label: '插件', icon: IconPlug },
    { id: 'schedules', label: '定时任务', icon: IconClock },
    { id: 'mobile', label: '手机接入', icon: IconPhone },
  ],
]

export function SettingsNav() {
  return (
    <nav class="sidebar settings-nav">
      {/* 返回和类目之间空一格：它不是第一个类目，是出口。
          放在头部那一行（和会话列表的品牌位同高）保证两个场景切换时这一格不跳。 */}
      <header class="sidebar-head">
        <button class="back-item" type="button" onClick={closeSettings}>
          <IconChevron size={13} dir="left" />
          返回
        </button>
      </header>

      <div class="sidebar-scroll">
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
      </div>
    </nav>
  )
}
