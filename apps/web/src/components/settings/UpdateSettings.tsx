import { createSignal, Show } from 'solid-js'
import { actOnUpdate, appUpdate, updatePresentation } from '../../lib/store/app-update.ts'
import { config, replaceConfig } from './configStore.ts'

const MODES = {
  installed: '安装版',
  'source-desktop': '源码版',
  'source-web': '源码版',
  manual: '手动更新',
}

export function UpdateSettings() {
  const [notes, showNotes] = createSignal(false)
  const preferences = () => config()?.updates ?? { autoCheck: true, autoDownload: true }
  const toggle = (field: 'autoCheck' | 'autoDownload', value: boolean) =>
    void replaceConfig((cur) => ({
      ...cur,
      updates: { autoCheck: true, autoDownload: true, ...cur.updates, [field]: value },
    }))
  return (
    <Show when={appUpdate()}>
      {(value) => {
        const view = () => updatePresentation(value())
        return (
          <section class="settings-block app-update-section" aria-label="更新">
            <div class="settings-block-head app-update-heading">
              <h3>更新</h3>
              <div class="app-update-version" title="当前版本与运行方式">
                <span>{value().currentVersion}</span>
                <span>{MODES[value().mode]}</span>
              </div>
            </div>
            <Show
              when={value().mode !== 'manual'}
              fallback={
                <a
                  class="app-update-notes-link"
                  href="https://github.com/qingxueyanshang/qywork-qingyan-harness/releases/latest"
                >
                  下载新版本
                </a>
              }
            >
              <div class="setting-rows">
                <label class="setting-row">
                  <span class="setting-row-label">自动检查更新</span>
                  <input
                    class="app-update-switch"
                    type="checkbox"
                    role="switch"
                    aria-checked={preferences().autoCheck}
                    checked={preferences().autoCheck}
                    disabled={!config()}
                    onChange={(e) => toggle('autoCheck', e.currentTarget.checked)}
                  />
                </label>
                <label class="setting-row">
                  <span class="setting-row-label">自动下载更新</span>
                  <input
                    class="app-update-switch"
                    type="checkbox"
                    role="switch"
                    aria-checked={preferences().autoDownload}
                    checked={preferences().autoDownload}
                    disabled={!config()}
                    onChange={(e) => toggle('autoDownload', e.currentTarget.checked)}
                  />
                </label>
              </div>
              <div class="app-update-status-row">
                <span
                  class="app-update-status"
                  classList={{ bad: value().stage === 'error' }}
                  title={view().text}
                  aria-live="polite"
                >
                  {view().text}
                </span>
                <Show when={value().notes && ['available', 'ready'].includes(value().stage)}>
                  <button
                    class="app-update-notes-link"
                    type="button"
                    onClick={() => showNotes(true)}
                  >
                    更新说明
                  </button>
                </Show>
                <Show when={value().stage === 'downloading' && value().progress !== null}>
                  <progress
                    class="app-update-progress"
                    max="100"
                    value={value().progress ?? 0}
                    aria-label="更新下载进度"
                  />
                </Show>
                <button
                  class="app-update-action"
                  classList={{ primary: ['available', 'ready'].includes(value().stage) }}
                  type="button"
                  disabled={view().disabled}
                  onClick={() => void actOnUpdate(view().action)}
                >
                  {view().label}
                </button>
              </div>
            </Show>
            <Show when={notes()}>
              <div
                class="app-update-notes"
                role="dialog"
                aria-label="更新说明"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    showNotes(false)
                  }
                }}
              >
                <div class="app-update-notes-heading">
                  <h3>{value().version} 更新说明</h3>
                  <button
                    class="app-update-action"
                    type="button"
                    ref={(element) => queueMicrotask(() => element.focus())}
                    onClick={() => showNotes(false)}
                  >
                    返回
                  </button>
                </div>
                <pre>{value().notes}</pre>
              </div>
            </Show>
          </section>
        )
      }}
    </Show>
  )
}
