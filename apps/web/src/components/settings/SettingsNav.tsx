import { For, type JSX } from 'solid-js'
import { type SettingsPage, setSettingsPage, settingsPage } from '../../lib/store/index.ts'
import {
  IconActivity,
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
 * 上组回答「这个 agent 是什么、花了多少」——长什么样、用哪个模型、由哪些模块组成、
 * 账记了多少；「模块」与「用量」那两页只读。下组每一项是一个模块的操作台，
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
  /** 页头那句边界（B7：只写别处看不到的事）。没有就不写。 */
  desc?: string
}

const GROUPS: Item[][] = [
  [
    { id: 'general', label: '通用', icon: IconSettings },
    { id: 'models', label: '模型', icon: IconPackage },
    // 用量紧挨模型：先看用哪个，再看它花了多少。
    {
      id: 'usage',
      label: '用量',
      icon: IconActivity,
      desc: '含压缩摘要、权限裁决与协作成员的花费，会话删除后记录保留',
    },
    { id: 'modules', label: '模块', icon: IconCanvas },
  ],
  [
    { id: 'access', label: '权限', icon: IconShield },
    { id: 'memory', label: '记忆', icon: IconBrain, desc: '索引随每轮请求发送，正文按需读取' },
    {
      id: 'skills',
      label: '技能',
      icon: IconFile,
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
      desc: '为模型贡献工具，全局安装对所有项目生效，重启后加载',
    },
    { id: 'schedules', label: '定时任务', icon: IconClock },
    { id: 'team', label: 'Agent Team', icon: IconUsers, desc: '多角色编排，作用域为当前项目' },
  ],
]

/**
 * 这一页的名字和那句边界。**导航与页头共用这一张表**——抄成两份，改名字时必漏一处。
 * 没有说明的页返回空串，页头那边按假值处理，不会画出一个空的说明位。
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
