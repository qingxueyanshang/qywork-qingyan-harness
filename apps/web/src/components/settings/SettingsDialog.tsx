import { createEffect, lazy, Match, onCleanup, Suspense, Switch } from 'solid-js'
import { closeSettings, holdOverlay, settingsPage } from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { AccessSettings } from './AccessSettings.tsx'
import { GeneralSettings } from './GeneralSettings.tsx'
import { ModelSettings } from './ModelSettings.tsx'
import { PageHead } from './Page.tsx'
import { pageMeta, SettingsNav } from './SettingsNav.tsx'

// 各内容类目自带请求与列表，打开设置后才加载。
// 只切换主题时不应加载「定时任务」等页面的代码。
const ModulesSettings = lazy(() =>
  import('./ModulesSettings.tsx').then((m) => ({ default: m.ModulesSettings })),
)
const UsageSettings = lazy(() => import('./UsageSettings.tsx'))
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
 * 系统设置弹窗：左侧为类目，右侧为内容，覆盖在会话之上。
 *
 * 类目导航放在弹窗内而不放在左栏：做成整页（左栏换成类目、主区换成内容、会话完全隐藏）时，
 * 修改单个设置项也要切换整个页面，顶栏的会话导出与面板开关须随之隐藏，返回时还要点击「返回」。
 * 弹窗左侧一栏即可容纳类目导航。
 *
 * 不设通栏标题栏：类目栏直达弹窗顶部，弹窗标题即当前类目名称。顶部再放一条「设置」
 * 会重复显示同一信息，并使类目栏下移一行。
 *
 * 标题在此处渲染，且位于滚动区之外。放入滚动区时，滚动条轨道会从对话框顶边
 * 延伸到标题旁，而标题本身不随滚动移动。
 * 名称与说明取自导航表（`pageMeta`），各页面组件不另行渲染。
 *
 * 尺寸固定，见 `settings.css` 中的 `.settings-dialog`：切换类目时不得改变对话框尺寸。
 */
export function SettingsDialog() {
  // 内置浏览器页面是原生子视图，渲染在所有 DOM 之上；弹窗打开期间登记为浮层，使原生子视图移出可视区。
  holdOverlay(() => true)

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
      {/* 关闭遮罩是对话框的兄弟节点而非父节点，原因见 overlays.css 中的说明。 */}
      <button class="backdrop-close" type="button" aria-label="关闭设置" onClick={closeSettings} />
      <div class="sheet-backdrop pass-through">
        <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="设置">
          <SettingsNav />

          <div class="settings-pane">
            {/* 关闭按钮固定在右上角，不与标题同行：它是整个弹窗的出口，
                不是当前页面的动作。位置随内容区变化：宽屏时内容区位于
                弹窗顶边，窄屏时类目栏横排在上方，关闭按钮位于类目栏下方一行。 */}
            <button
              class="icon-btn settings-close"
              type="button"
              aria-label="关闭"
              onClick={closeSettings}
            >
              <IconX size={15} />
            </button>

            <PageHead title={pageMeta(settingsPage()).label} desc={pageMeta(settingsPage()).desc} />

            {/* 滚动条只作用于内容区，原因见 `settings.css` 的 `.settings-scroll`。 */}
            <div class="settings-scroll">
              <div class="settings-inner">
                {/*
                 * 内容区自带 Suspense 边界，不要依赖外层边界。
                 *
                 * 每一页都通过 `createResource` 取数，而 Solid 的 Suspense 对子树中
                 * 任何一个未完成的 resource 都会生效。此处不设边界时，最近的
                 * 边界是 `App.tsx` 中供 `lazy()` 使用的边界：每次切换类目，整个弹窗
                 * 连同遮罩的模糊层都会被移出 DOM 再重新挂载。
                 *
                 * 有意不设 fallback：内容区短暂留空即可，显示「读取中…」
                 * 只会一闪而过。
                 */}
                <Suspense>
                  <Switch>
                    <Match when={settingsPage() === 'general'}>
                      <GeneralSettings />
                    </Match>
                    <Match when={settingsPage() === 'models'}>
                      <ModelSettings />
                    </Match>
                    <Match when={settingsPage() === 'usage'}>
                      <UsageSettings />
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
                </Suspense>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
