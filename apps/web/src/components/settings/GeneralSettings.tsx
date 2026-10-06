import { createSignal, For, Show } from 'solid-js'
import {
  client,
  type FollowUpMode,
  followUpMode,
  setFollowUpMode,
  setTheme,
  state,
  type ThemePref,
  theme,
  workspace,
} from '../../lib/store/index.ts'
import PairPanel from '../PairPanel.tsx'
import { ConfigStatus } from './ConfigStatus.tsx'
import { config, configError, configPath, ensureConfig, reloadConfig } from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { PathRow, Row } from './Row.tsx'
import { UpdateSettings } from './UpdateSettings.tsx'

const THEMES: { id: ThemePref; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]

const FOLLOWUP_MODES: { id: FollowUpMode; label: string }[] = [
  { id: 'queue', label: '加入队列' },
  { id: 'steer', label: '调整方向' },
]

/**
 * 运行环境：qywork 需要调用的外部程序是否已安装。
 *
 * 状态分为三种：已安装 / 需要安装 / 未安装（可选）。「未安装（可选）」这一档不能省略：缺少 rg 只会使搜索变慢
 * （由内置遍历替代），node 只在安装插件时使用；若把它们也标为「需要安装」，用户首次打开设置页看到的
 * 是大片红色警告，真正缺失的依赖被淹没其中。
 *
 * 已安装时只显示路径，不显示用途。缺失的后果只在缺失时才需要阅读。依赖齐全的机器上本节应为
 * 四行路径，而不是四段说明（B7：删除这句后用户是否仍能使用？能 → 删除）。
 *
 * 按钮只在服务端声明可以安装时出现（`canInstall` = Windows + 有 winget + 已知包 id），
 * 不提供点击即报错的按钮（B5）。
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
      {/* 使用行式布局，不使用 `stack`。按钮是宽度有限的控件，应在右缘对齐：
          四行按钮各自换行排在左侧，会使本节高度增加一倍，而浏览时视线
          只需扫过右缘（`Row.tsx` 的判据）。路径虽长，但它是说明而不是控件，
          在左栏中被截断优于挤占按钮的位置。 */}
      <For each={deps()}>
        {(d) => (
          <div class="setting-row" classList={{ warn: d.path === null && d.required }}>
            <div class="setting-row-text">
              <span class="setting-row-label">
                {d.label}
                {d.path === null ? (d.required ? ' · 需要安装' : ' · 未安装（可选）') : ' · 已安装'}
              </span>
              {/* 已安装时只显示路径：排查同一条命令在终端中能运行而在应用中不能运行的问题时，
                  唯一有用的信息是当前使用的是哪一个可执行文件。 */}
              <span class="setting-row-hint">{d.path ?? d.hint}</span>
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
 * 通用。
 *
 * 本页最容易变成无法归类内容的集合。归入本页的判据是
 * 修改的对象是应用本身，而不是 agent 的某个模块：外观、本机是否缺少依赖、
 * 配置和会话的存储位置、其他设备如何接入。
 *
 * 手机接入按此判据归入本页：它涉及应用的访问方式，与主题、安装位置同类，
 * 而不是 agent 的一项能力；后者全部位于「模块」页。
 *
 * 模型和命令边界各自独立成页：它们条目多，每次修改都需要阅读说明，放在本页会使
 * 上述各项被淹没。
 */
export function GeneralSettings() {
  ensureConfig()

  return (
    <>
      <UpdateSettings />
      <section class="settings-block">
        <h3 class="settings-block-head">外观</h3>
        <div class="setting-rows">
          {/* 使用三态而不是深色开关：开关关闭后，系统切换为深色时应用是否跟随，
              界面上无法区分。`system` 必须单独作为一项。 */}
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
          {/* 会话运行中发出的消息默认采用的处理方式。
              放在设置中而不是输入框旁：它很少修改；若常驻主界面，run 每次启动和停止
              都会增减一个控件，相邻的主按钮随之移位。单条消息需要使用另一种方式时按
              `Ctrl+Enter`，或在发出后点击卡片上的方式名称。 */}
          <Row label="跟进处理方式">
            <div class="seg">
              <For each={FOLLOWUP_MODES}>
                {(m) => (
                  <button
                    class="seg-item"
                    classList={{ active: followUpMode() === m.id }}
                    type="button"
                    onClick={() => setFollowUpMode(m.id)}
                  >
                    {m.label}
                  </button>
                )}
              </For>
            </div>
          </Row>
        </div>
      </section>

      {/* 不嵌套在 `config()` 内部。配置无法读取时本节仍须显示：
          模型为何没有 run_command 与配置能否加载是两件事，
          两者绑定时，配置一旦出错，用户将无法看到原因。 */}
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
                /* 会话按工作区分表存储：用户在两个客户端看到不同的会话列表时，
                   唯一可供自行诊断的线索就是这一行。 */
                <PathRow label="当前工作区" value={w().root} />
              )}
            </Show>
          </div>
        </section>
      </Show>

      <section class="settings-block">
        <h3 class="settings-block-head">手机接入</h3>
        <PairPanel />
      </section>

      <Show when={config()}>
        <ConfigStatus />
      </Show>
    </>
  )
}
