import { createResource, createSignal, For, Show } from 'solid-js'
import {
  client,
  installPlugin,
  isDesktopShell,
  pickWorkspace,
  uninstallPlugin,
} from '../lib/store.ts'
import { IconX } from './Icons.tsx'

interface PluginTool {
  name: string
  description: string
}
interface PluginEntry {
  id: string
  name: string
  version: string
  permissions: string[]
  tools: PluginTool[]
  process: 'declarative' | 'running' | 'unknown'
  sandboxed?: boolean
  netGuarded?: boolean
  note?: string
}
interface PluginsPayload {
  dir: string
  plugins: PluginEntry[]
  failures: { dir: string; reason: string }[]
  mcpServers: string[]
  mcpFailures: { server: string; reason: string }[]
}

/**
 * 插件。
 *
 * ## 为什么不叫「插件市场」
 *
 * 这个项目没有中心 registry，也不该现造一个。一个叫「市场」而里面没有任何
 * 可安装内容的页面，就是把这次删掉的空壳换个名字再造一遍。所以这里只做
 * **已安装**——它有真实数据源，而「市场」没有。
 *
 * ## 与 `qy plugins` 同源
 *
 * 走的是同一个 `loadExtensions`，所以命令行与界面对「装了什么、隔离到什么程度」
 * 不会给出两种答案。两套读法迟早分叉，而分叉的那一刻没有人会发现。
 *
 * ## 失败的也要列
 *
 * 装失败的插件恰恰是最需要被看到的：只列成功的，会让「我明明放进去了怎么没有」
 * 完全无从查起。
 */
export function PluginsPanel() {
  const [data, { refetch }] = createResource(() => client.api<PluginsPayload>('/api/plugins'))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [okMsg, setOkMsg] = createSignal<string | null>(null)
  const [manual, setManual] = createSignal('')

  const act = async (key: string, fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(key)
    setError(null)
    setOkMsg(null)
    try {
      const r = (await fn()) as never
      setOkMsg(ok(r))
      // 装完 / 卸完立刻重拉：列表不刷新的话用户会以为没生效，然后再点一次。
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const install = (path: string) =>
    act(
      'install',
      () => installPlugin(path),
      (r: { id: string }) =>
        // 说清「装好了但还没生效」：插件在服务启动时加载，不是热插拔。
        // 不写这句的话，装完发现工具列表没变，会被当成安装失败。
        `已装入 ${r.id}。插件在服务启动时加载，重启后生效。`,
    )

  const browse = async () => {
    if (!isDesktopShell()) return
    try {
      const picked = await pickWorkspace()
      if (picked) await install(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div class="plugins-panel">
      <Show when={data()} fallback={<div class="settings-loading">读取插件…</div>}>
        {(d) => (
          <>
            <Show
              when={d().plugins.length || d().failures.length}
              fallback={
                <div class="plugins-empty">
                  <p>没有装任何插件。</p>
                  <p class="field-hint">
                    插件放在 <code>{d().dir}</code> 下，目录里要有 <code>qywork.plugin.json</code>{' '}
                    和清单里 main 指向的入口。
                  </p>
                </div>
              }
            >
              <For each={d().plugins}>
                {(p) => (
                  <div class="plugin-card">
                    <div class="plugin-head">
                      <span class="plugin-id">{p.id}</span>
                      <span class="plugin-version">{p.version}</span>
                      <button
                        class="icon-btn"
                        type="button"
                        aria-label={`卸载 ${p.id}`}
                        title="卸载"
                        disabled={busy() === p.id}
                        onClick={() =>
                          void act(
                            p.id,
                            () => uninstallPlugin(p.id),
                            () => `已卸载 ${p.id}，重启后生效。`,
                          )
                        }
                      >
                        <IconX size={13} />
                      </button>
                    </div>
                    <div class="field-hint">
                      {p.name} · {p.tools.length} 个工具 · 权限{' '}
                      {p.permissions.length ? p.permissions.join('、') : '（无）'}
                    </div>

                    {/* 隔离状态分三种，不能合并显示。
                        「纯声明式插件没有进程」和「有进程但没隔离」是完全不同的事，
                        显示成同一个「无」会让人以为出了安全问题。 */}
                    <div class="plugin-isolation">
                      <Show when={p.process === 'declarative'}>
                        <span class="field-hint">纯声明式插件，没有代码进程</span>
                      </Show>
                      <Show when={p.process === 'unknown'}>
                        <span class="field-hint">进程未启动，隔离状态未知</span>
                      </Show>
                      <Show when={p.process === 'running'}>
                        <span class="iso-flag" classList={{ off: !p.sandboxed }}>
                          沙箱 {p.sandboxed ? '有' : '无'}
                        </span>
                        <span class="iso-flag" classList={{ off: !p.netGuarded }}>
                          出网闸 {p.netGuarded ? '有' : '无'}
                        </span>
                        <Show when={p.note}>
                          <span class="field-hint">{p.note}</span>
                        </Show>
                      </Show>
                    </div>

                    <Show when={p.tools.length}>
                      <ul class="plugin-tools">
                        <For each={p.tools}>
                          {(t) => (
                            <li>
                              <code>{t.name}</code>
                              <span class="field-hint">{t.description}</span>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>
                )}
              </For>

              <For each={d().failures}>
                {(f) => (
                  <div class="plugin-card failed">
                    <div class="plugin-head">
                      <span class="plugin-id">{f.dir}</span>
                    </div>
                    <div class="field-hint bad">{f.reason}</div>
                  </div>
                )}
              </For>
            </Show>

            <Show when={d().mcpServers.length || d().mcpFailures.length}>
              <div class="plugins-section-head">MCP</div>
              <For each={d().mcpServers}>
                {(s) => (
                  <div class="plugin-card">
                    <span class="plugin-id">{s}</span>
                  </div>
                )}
              </For>
              <For each={d().mcpFailures}>
                {(f) => (
                  <div class="plugin-card failed">
                    <span class="plugin-id">{f.server}</span>
                    <div class="field-hint bad">{f.reason}</div>
                  </div>
                )}
              </For>
            </Show>

            {/* 安装入口。
                只接受**本机已存在的目录**：没有 registry，所以没有「从市场安装」；
                也刻意不做 git clone 任意 URL——那等于从网上取一段代码，下次加载就跑它。 */}
            <div class="plugins-section-head">安装</div>
            <div class="install-box">
              <Show when={isDesktopShell()}>
                <button
                  class="btn-primary"
                  type="button"
                  disabled={busy() === 'install'}
                  onClick={() => void browse()}
                >
                  {busy() === 'install' ? '安装中…' : '选择插件目录…'}
                </button>
              </Show>
              <div class="field">
                <input
                  type="text"
                  placeholder="或直接填插件目录的绝对路径"
                  value={manual()}
                  onInput={(e) => setManual(e.currentTarget.value)}
                />
                <span class="field-hint">
                  目录里要有 <code>qywork.plugin.json</code>；清单不合法会被拒绝，不会装进去一半。
                </span>
              </div>
              <button
                class="btn-ghost"
                type="button"
                disabled={!manual().trim() || busy() === 'install'}
                onClick={() => void install(manual().trim())}
              >
                安装
              </button>

              <Show when={okMsg()}>{(m) => <div class="field-hint">{m()}</div>}</Show>
              <Show when={error()}>{(e) => <div class="settings-notices bad">{e()}</div>}</Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
