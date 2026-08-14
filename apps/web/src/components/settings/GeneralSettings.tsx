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
 * 运行环境：qywork 要调的那几个外部程序在不在。
 *
 * ## 三态，不是两态
 *
 * 已拥有 / 需要安装 / 未安装（可选）。**中间那档不能省**：rg 缺了只是搜索慢一点
 * （内置遍历顶上），node 只有装插件才用——把它们也标成「需要安装」，
 * 用户第一次点开设置页看到的就是一片红，而真正坏掉的那条淹在里面。
 *
 * ## 装了就只显示路径，不显示用途
 *
 * 「缺了会怎样」只有在缺的时候才需要读。装齐的机器上这一节应该是四行安安静静的
 * 路径，而不是四段说明（B7：删掉这句用户还能不能用？能 → 删）。
 *
 * 按钮**只在服务端说能装时出现**（`canInstall` = Windows + 有 winget + 知道包 id），
 * 不做一个点了报错的按钮（B5）。
 */
function EnvironmentRows() {
  const deps = () => state.capabilities?.environment ?? []
  const [busy, setBusy] = createSignal('')
  const [result, setResult] = createSignal('')

  async function install(id: string) {
    setBusy(id)
    setResult('')
    try {
      const r = await client.api<{ note: string }>('/api/host/install', {
        method: 'POST',
        body: JSON.stringify({ id }),
      })
      setResult(r.note)
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <>
      <For each={deps()}>
        {(d) => (
          <div class="setting-row stack" classList={{ warn: d.path === null && d.required }}>
            <div class="setting-row-text">
              <span class="setting-row-label">
                {d.label}
                {d.path === null ? (d.required ? ' · 需要安装' : ' · 未安装（可选）') : ' · 已拥有'}
              </span>
              {/* 装了就只报路径——排查「同一条命令在终端能跑、在这里不行」时，
                  唯一有用的信息就是它到底用的哪一个。 */}
              <span class="setting-row-hint">{d.path ?? `${d.impact} · ${d.hint}`}</span>
            </div>
            <Show when={d.canInstall}>
              <div class="setting-row-control">
                <button
                  class="btn-primary"
                  type="button"
                  disabled={busy() !== ''}
                  onClick={() => void install(d.id)}
                >
                  {busy() === d.id ? '正在打开安装窗口…' : '安装'}
                </button>
              </div>
            </Show>
          </div>
        )}
      </For>
      {/* 装完要重启——这句是能力边界不是解释，不许折叠（B7）：
          当前进程的 PATH 是启动时的快照，新装的程序不在里面。
          只在真有东西可装时才出现，装齐的机器上不该看到它。 */}
      <Show when={deps().some((d) => d.canInstall)}>
        <div class="setting-row stack">
          <span class="setting-row-hint">安装会开一个终端窗口跑 winget；装完请重启 qywork。</span>
        </div>
      </Show>
      <Show when={result()}>
        {(r) => (
          <div class="setting-row stack">
            <span class="setting-row-hint">{r()}</span>
          </div>
        )}
      </Show>
    </>
  )
}

/**
 * 系统设置。
 *
 * 这一页最容易长成一个杂物间——什么都不好归类就丢进来。这里的判据是
 * **打开应用第一天就想改的那几样**：长什么样、这台机器缺不缺东西、
 * 配置和会话存在哪。
 *
 * 模型和路径边界各自成页：它们条目多、改一次要读一段说明，混在这里会把
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

      {/* **不挂在 `config()` 里面。** 配置读不出来时这一格照样要显示：
          「模型手里为什么没有 run_command」和配置能不能加载是两件事，
          绑在一起的后果是配置一出错，用户连原因都看不到。 */}
      <section class="settings-block">
        <h3 class="settings-block-head">运行环境</h3>
        <div class="setting-rows">
          <EnvironmentRows />
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
