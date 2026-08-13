import { lazy, Match, Show, Switch } from 'solid-js'
import { type SettingsPage as Page, settingsPage } from '../../lib/store/index.ts'
import { AccessSettings } from './AccessSettings.tsx'
import { GeneralSettings } from './GeneralSettings.tsx'
import { ModelSettings } from './ModelSettings.tsx'

// 内容类目各自带着自己的请求和列表，进设置才下载。
// 只想换个主题的用户不该为「定时任务」付首屏成本。
const AgentsSettings = lazy(() => import('./AgentsSettings.tsx'))
const MemorySettings = lazy(() => import('./MemorySettings.tsx'))
const SkillsSettings = lazy(() => import('./SkillsSettings.tsx'))
const McpSettings = lazy(() => import('./McpSettings.tsx'))
const PluginsPanel = lazy(() =>
  import('../PluginsPanel.tsx').then((m) => ({ default: m.PluginsPanel })),
)
const SchedulesPanel = lazy(() =>
  import('../SchedulesPanel.tsx').then((m) => ({ default: m.SchedulesPanel })),
)
const PairPanel = lazy(() => import('../PairPanel.tsx'))

/**
 * 每一页的标题与边界说明。
 *
 * `note` 只在**不写就会做错事**时才有。「按角色分工不是远程协作」「手机和桌面同一套协议」
 * 这类是介绍不是边界，删掉用户照样会用——按 B7 一律删掉。剩下两条是真边界，
 * 就在下面：填 key 前要知道它不出服务端，找审批模式的人要知道该去哪找。
 * （这两句一度只写在源码注释里，`note` 一条都没填——界面上等于没说。）
 */
const META: Record<Page, { title: string; note?: string }> = {
  general: { title: '通用' },
  models: {
    title: '模型',
    note: 'API Key 只存在服务端，界面上没有任何一条路能把它读回来——删掉即不可恢复。',
  },
  access: {
    title: '权限与沙箱',
    note: '自动审批 / 完全访问的开关不在这里，在输入区那个盾牌 chip 上。',
  },
  team: { title: '智能体' },
  memory: { title: '记忆' },
  skills: { title: '技能' },
  mcp: { title: 'MCP' },
  plugins: { title: '插件' },
  schedules: { title: '定时任务' },
  mobile: { title: '手机接入' },
}

/**
 * 设置整页。占的是会话区的位置，顶栏和窗口按钮照旧。
 *
 * 内容区自己滚，不让整页滚——和 `.transcript` 同一条：外层滚起来的话
 * 顶栏会跟着走，而顶栏上有窗口按钮。
 */
export function SettingsPage() {
  const meta = () => META[settingsPage() ?? 'general']

  return (
    <div class="settings-page">
      <div class="settings-scroll">
        <div class="settings-inner">
          <header class="settings-page-head">
            <h2 class="settings-page-title">{meta().title}</h2>
            <Show when={meta().note}>{(n) => <p class="settings-page-note">{n()}</p>}</Show>
          </header>

          <Switch>
            <Match when={settingsPage() === 'general'}>
              <GeneralSettings />
            </Match>
            <Match when={settingsPage() === 'models'}>
              <ModelSettings />
            </Match>
            <Match when={settingsPage() === 'access'}>
              <AccessSettings />
            </Match>
            <Match when={settingsPage() === 'team'}>
              <AgentsSettings />
            </Match>
            <Match when={settingsPage() === 'memory'}>
              <MemorySettings />
            </Match>
            <Match when={settingsPage() === 'skills'}>
              <SkillsSettings />
            </Match>
            <Match when={settingsPage() === 'mcp'}>
              <McpSettings />
            </Match>
            <Match when={settingsPage() === 'plugins'}>
              <PluginsPanel />
            </Match>
            <Match when={settingsPage() === 'schedules'}>
              <SchedulesPanel />
            </Match>
            <Match when={settingsPage() === 'mobile'}>
              <PairPanel />
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}
