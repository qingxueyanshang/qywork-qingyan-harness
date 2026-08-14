import { For, type JSX } from 'solid-js'
import { type SettingsPage, setSettingsPage, settingsPage } from '../../lib/store/index.ts'
import {
  IconBrain,
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
 * 设置的类目导航。**它是弹窗里的左边一栏**，不带出口——关闭在弹窗头部那个 ×，
 * 一个浮层只该有一条关法。
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
    { id: 'general', label: '系统设置', icon: IconSettings },
    { id: 'models', label: '模型', icon: IconPackage },
    { id: 'access', label: '权限与沙箱', icon: IconShield },
    { id: 'tools', label: '工具', icon: IconTerminal },
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
