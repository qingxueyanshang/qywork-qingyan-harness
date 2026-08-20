import { createEffect, lazy, Match, onCleanup, Suspense, Switch } from 'solid-js'
import { closeSettings, settingsPage } from '../../lib/store/index.ts'
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
 * 类目栏直接通到弹窗顶部。**弹窗的名字就是当前类目的名字**——横一条「设置」
 * 在最上面等于把同一件事说两遍，还把类目栏往下压了一格。
 *
 * **标题也不在这里画。** 标题、页级说明、右上角的动作按钮是同一块（`PageHead`），
 * 由每一页自己给：拆成「固定的标题 + 跟着滚的动作按钮」时，两者会在滚动之后
 * 错开一整段，而它们本来是一行。
 *
 * ## 尺寸写死
 *
 * 见 `settings.css` 里 `.settings-dialog` 那段：切类目不许改变对话框尺寸。
 */
export function SettingsDialog() {
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

            {/* 滚动条只在内容上，不在对话框上——外层滚起来的话标题和类目栏会跟着走，
                而类目栏是用来来回切的。 */}
            <div class="settings-scroll">
              <div class="settings-inner">
                {/*
                 * **内容区自带 Suspense，边界不许再往外借。**
                 *
                 * 每一页都靠 `createResource` 取数，而 Solid 的 Suspense 对子树里
                 * 任何一个在飞的 resource 一视同仁。不在这里画边界的话，最近的
                 * 边界是 `App.tsx` 那个给 `lazy()` 用的——切一次类目，整个弹窗
                 * 连同遮罩的模糊层一起被摘出 DOM 再挂回来。
                 *
                 * 没有 fallback 是有意的：内容区空一下即可，摆一句「读取中…」
                 * 反而会闪一下就没。
                 */}
                <Suspense>
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
                </Suspense>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
