import { createSignal, For, Show } from 'solid-js'
import { client, setTheme, state, type ThemePref, theme, workspace } from '../../lib/store/index.ts'
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
 * 系统设置。
 *
 * 这一页最容易长成一个杂物间——什么都不好归类就丢进来。这里的判据是
 * **打开应用第一天就想改的那几样**：长什么样、新会话默认怎么跑、配置和会话存在哪。
 *
 * 模型和路径边界各自成页：它们条目多、改一次要读一段说明，混在这里会把
 * 上面这三样淹掉。
 */
/**
 * 命令跑哪个 shell，以及没有时怎么装上。
 *
 * **`path` 有值时只是一行只读路径**，没有按钮也没有说明——它是「一切正常」的样子。
 * 有值还写一段解释，就是在给不需要读的人制造阅读量（B7）。
 *
 * 没有时那一格才展开：为什么没有（服务端给的 `reason`，它说得出下一步）、
 * `run_command` 已经不在工具表里、以及能装的话那个按钮。
 * 按钮**只在服务端说能装时出现**（`canInstall`），不做一个点了报错的按钮（B5）。
 */
function CommandShellRows() {
  const shell = () => state.capabilities?.commandShell ?? null
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal('')

  async function install() {
    setBusy(true)
    setResult('')
    try {
      const r = await client.api<{ note: string }>('/api/host/install-shell', { method: 'POST' })
      setResult(r.note)
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={shell()}>
      {(sh) => (
        <Show
          when={sh().path === null}
          fallback={<PathRow label="命令 shell" value={sh().path ?? ''} />}
        >
          <div class="setting-row stack warn">
            <span class="setting-row-label">未检测到 bash · run_command 已停用</span>
            <span class="setting-row-hint">{sh().reason}</span>
            <Show when={sh().canInstall}>
              <div class="setting-row-control">
                <button
                  class="btn-primary"
                  type="button"
                  disabled={busy()}
                  onClick={() => void install()}
                >
                  {busy() ? '正在打开安装窗口…' : '安装 Git for Windows'}
                </button>
              </div>
              {/* 装完要重启——这句是能力边界不是解释，不许折叠（B7）：
                  当前进程的 PATH 是启动时的快照，新装的 git 不在里面。 */}
              <span class="setting-row-hint">
                会开一个终端窗口跑 winget install --id Git.Git；装完请重启 qywork。
              </span>
            </Show>
            <Show when={result()}>{(r) => <span class="setting-row-hint">{r()}</span>}</Show>
          </div>
        </Show>
      )}
    </Show>
  )
}

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
            <CommandShellRows />
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
