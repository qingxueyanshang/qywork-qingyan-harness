import { For, type JSX } from 'solid-js'
import { type SettingsPage, setSettingsPage, settingsPage } from '../../lib/store/index.ts'
import {
  IconActivity,
  IconBrain,
  IconCanvas,
  IconClock,
  IconPackage,
  IconPlug,
  IconSettings,
  IconShield,
  IconSkillSolid,
  IconTerminal,
  IconUsers,
} from '../Icons.tsx'

/**
 * 设置的类目导航，即弹窗左侧一栏。它不提供关闭入口：关闭由弹窗右上角的 × 负责，
 * 一个浮层只应有一个关闭按钮。
 *
 * 分两组，以分隔线隔开，判据是该页用于查看还是用于配置：
 * 上组回答「这个 agent 是什么、花费多少」：外观、使用的模型、由哪些模块组成、
 * 累计用量；「用量」页只读。下组每一项是一个模块的设置页，
 * 均包含实际可用的表单。
 *
 * 不要按「这台机器如何运行 / agent 具备什么」分类，该界线无法区分：
 * 「权限与沙箱」同时属于两类，而上组的「模块」与下组的 MCP、插件都提供工具。
 * 「手机接入」归入「通用」：它涉及应用的访问方式，不是 agent 的能力模块。
 */
interface Item {
  id: SettingsPage
  label: string
  icon: (p: { size?: number; class?: string }) => JSX.Element
  /** 只有同一语义跨界面复用、且必须锁定同一明度时才填。 */
  iconClass?: string
  /** 页头的边界说明（B7：只写界面上别处没有的内容）。没有时省略。 */
  desc?: string
}

const GROUPS: Item[][] = [
  [
    { id: 'general', label: '通用', icon: IconSettings },
    { id: 'models', label: '模型', icon: IconPackage },
    // 用量紧随模型：先选择模型，再查看其花费。
    { id: 'usage', label: '用量', icon: IconActivity },
    { id: 'modules', label: '模块', icon: IconCanvas },
  ],
  [
    {
      id: 'access',
      label: '权限',
      icon: IconShield,
      // 只说明目录：凭证剥离与模式无关，两种模式行为相同（CLAUDE.md E）。
      desc: '「完全访问」模式不限制目录',
    },
    { id: 'memory', label: '记忆', icon: IconBrain, desc: '索引随每轮请求发送，正文按需读取' },
    {
      id: 'skills',
      label: '技能',
      icon: IconSkillSolid,
      iconClass: 'settings-nav-skill-icon',
      desc: '按需加载的操作步骤：索引随每轮请求发送，正文按需读取',
    },
    {
      id: 'mcp',
      label: 'MCP',
      icon: IconTerminal,
      desc: '为模型接入外部工具，修改后需重启应用生效',
    },
    {
      id: 'plugins',
      label: '插件',
      icon: IconPlug,
      desc: '为模型提供工具，全局安装对所有项目生效，重启后加载',
    },
    { id: 'schedules', label: '定时任务', icon: IconClock },
    { id: 'team', label: 'Agent Team', icon: IconUsers, desc: '多角色编排，作用域为当前项目' },
  ],
]

/**
 * 页面的名称与边界说明。导航与页头共用这张表：复制为两份时，改名时必然遗漏一处。
 * 没有说明的页面返回空串，页头将其视为假值，不渲染空的说明区域。
 */
export function pageMeta(id: SettingsPage | null): { label: string; desc: string } {
  const hit = GROUPS.flat().find((i) => i.id === id)
  return { label: hit?.label ?? '', desc: hit?.desc ?? '' }
}

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
                    <item.icon
                      size={15}
                      class={`settings-nav-icon settings-nav-icon-${item.id}${item.iconClass ? ` ${item.iconClass}` : ''}`}
                    />
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
