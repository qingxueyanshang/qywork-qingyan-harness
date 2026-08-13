import { For, Show } from 'solid-js'
import { setTheme, type ThemePref, theme, workspace } from '../../lib/store/index.ts'
import { ConfigStatus } from './ConfigStatus.tsx'
import { config, configError, configPath, ensureConfig, reloadConfig } from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { PathRow, Row } from './Row.tsx'

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]

/**
 * 通用。
 *
 * 「通用」页最容易长成一个杂物间——什么都不好归类就丢进来。这里的判据是
 * **打开应用第一天就想改的那几样**：长什么样、新会话默认怎么跑、配置和会话存在哪。
 *
 * 模型和路径边界各自成页：它们条目多、改一次要读一段说明，混在通用里会把
 * 上面这三样淹掉。
 */
export function GeneralSettings() {
  ensureConfig()

  return (
    <>
      <section class="settings-block">
        <h3 class="settings-block-head">外观</h3>
        <div class="setting-rows">
          {/* 三态而不是「深色开关」：开关关掉之后，系统切深色时应用跟不跟，
              界面上分不出来。`system` 必须自己占一格。 */}
          <Row label="主题">
            <div class="seg">
              <For each={THEMES}>
                {(t) => (
                  <button
                    class="seg-item"
                    classList={{ active: theme() === t.id }}
                    type="button"
                    onClick={() => setTheme(t.id)}
                  >
                    {t.label}
                  </button>
                )}
              </For>
            </div>
          </Row>
        </div>
      </section>

      <Show
        when={config()}
        fallback={<LoadState error={configError()} onRetry={() => void reloadConfig()} />}
      >
        <section class="settings-block">
          <h3 class="settings-block-head">位置</h3>
          <div class="setting-rows">
            <PathRow label="配置文件" value={configPath()} />
            <Show when={workspace()}>
              {(w) => (
                /* 会话按工作区分表——用户在两个客户端看到两份会话时，
                   唯一能自己诊断出来的线索就是这一句。 */
                <PathRow label="当前工作区" value={w().root} hint="会话按工作区分开存放" />
              )}
            </Show>
          </div>
        </section>
      </Show>

      <Show when={config()}>
        <ConfigStatus />
      </Show>
    </>
  )
}
