import { createEffect, lazy, Match, onCleanup, Show, Switch } from 'solid-js'
import { closeSettings, type SettingsPage as Page, settingsPage } from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { AccessSettings } from './AccessSettings.tsx'
import { GeneralSettings } from './GeneralSettings.tsx'
import { ModelSettings } from './ModelSettings.tsx'
import { SettingsNav } from './SettingsNav.tsx'

// 内容类目各自带着自己的请求和列表，进设置才下载。
// 只想换个主题的用户不该为「定时任务」付首屏成本。
const ModulesSettings = lazy(() =>
  import('./ModulesSettings.tsx').then((m) => ({ default: m.ModulesSettings })),
)
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

/**
 * 每一页的标题与边界说明。
 *
 * `note` 只在**不写就会做错事**时才有。「按角色分工不是远程协作」「手机和桌面同一套协议」
 * 这类是介绍不是边界，删掉用户照样会用——按 B7 一律删掉。剩下两条是真边界，
 * 就在下面：填 key 前要知道它不出服务端，找审批模式的人要知道该去哪找。
 * 这两句必须写进 `note`——只写在源码注释里等于界面上没说。
 */
const META: Record<Page, { title: string; note?: string }> = {
  general: { title: '通用' },
  models: {
    title: '模型',
    note: 'API Key 只存在服务端，界面上没有任何一条路能把它读回来——删掉即不可恢复。',
  },
  modules: {
    title: '模块',
    note: '带 * 的是必填参数。MCP server 起不来，它的工具就不在这里。',
  },
  access: {
    title: '命令与进程',
    note: '自动审批 / 完全访问的开关不在这里，在输入区那个盾牌 chip 上。',
  },
  team: { title: '智能体' },
  memory: { title: '记忆' },
  skills: { title: '技能' },
  mcp: { title: 'MCP' },
  plugins: { title: '插件' },
  schedules: { title: '定时任务' },
}

/**
 * 系统设置弹窗。左边类目、右边内容，盖在会话上面。
 *
 * ## 为什么类目导航在弹窗里，不在左栏
 *
 * 做成整页（左栏换成类目、主区换成内容、会话整个让出去）的代价是「改一格就走」
 * 被做成一次场景切换——顶栏的搜索和面板开关得跟着藏起来，回来还要点一次「返回」。
 * 类目导航塞得进弹窗，左边那一栏就是。
 *
 * ## 没有横贯整条的标题栏
 *
 * 类目栏直接通到弹窗顶部，标题和关闭都在右边内容区那一行。**弹窗的名字就是
 * 当前类目的名字**——横一条「设置」在最上面，等于把同一件事说两遍，
 * 还把类目栏往下压了一格。
 *
 * ## 尺寸写死
 *
 * 见 `settings.css` 里 `.settings-dialog` 那段：切类目不许改变对话框尺寸。
 */
export function SettingsDialog() {
  const meta = () => META[settingsPage() ?? 'general']

  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSettings()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      {/* 关闭遮罩是对话框的**兄弟节点**，不是父节点——理由见 overlays.css 里那段。 */}
      <button class="backdrop-close" type="button" aria-label="关闭设置" onClick={closeSettings} />
      <div class="sheet-backdrop pass-through">
        <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
          <SettingsNav />

          <div class="settings-pane">
            {/* 关闭钉在右上角，不跟标题排在同一行——它是整个弹窗的出口，
                不是这一页的一个动作。位置跟着内容区走：宽屏时内容区就顶到
                弹窗顶边，窄屏时类目栏横在上面，它跟着落到类目栏下面那一行。 */}
            <button
              class="icon-btn settings-close"
              type="button"
              aria-label="关闭"
              onClick={closeSettings}
            >
              <IconX size={15} />
            </button>

            {/* 标题这一行不进滚动区：那句边界说明（「明文 key 不出服务端」）
                滚走了等于没写，而它正是用户据以决定要不要在这一页填东西的事实。 */}
            <header class="settings-pane-head">
              <h2 class="settings-page-title">{meta().title}</h2>
              <Show when={meta().note}>{(n) => <p class="settings-page-note">{n()}</p>}</Show>
            </header>

            {/* 滚动条只在内容上，不在对话框上——外层滚起来的话标题和类目栏会跟着走，
                而类目栏是用来来回切的。 */}
            <div class="settings-scroll">
              <div class="settings-inner">
                <Switch>
                  <Match when={settingsPage() === 'general'}>
                    <GeneralSettings />
                  </Match>
                  <Match when={settingsPage() === 'models'}>
                    <ModelSettings />
                  </Match>
                  <Match when={settingsPage() === 'modules'}>
                    <ModulesSettings />
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
                </Switch>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
