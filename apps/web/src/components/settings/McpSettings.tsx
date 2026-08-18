import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { loadMcp, loadMcpRaw, type Scope, saveMcpRaw } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { ScopeBar, ScopeTag } from './ScopeBar.tsx'

/**
 * MCP。
 *
 * ## 失败和成功一起列
 *
 * 连不上的那个恰恰是用户最需要看到的部分。而更隐蔽的一种是**握手成功但一个工具
 * 都没有**——一个只提供 prompts 的 server 会连上、`tools/list` 返回空、不报任何
 * 错，用户看到「配了但什么都没发生」。所以 `unsupported` 也要显示出来。
 *
 * ## 原文编辑而不是表单
 *
 * server 的形状按 transport 分好几种（stdio 要 command/args/env，http 要 url 和
 * headers）。做成表单要么盖不全，要么长成一个通用 JSON 编辑器的劣化版。
 * 这里给原文、存原文，解析结果在上面单独列。
 */
export default function McpSettings() {
  const [data, { refetch }] = createResource(loadMcp)
  const [scope, setScope] = createSignal<Scope>('user')
  const [raw, { refetch: refetchRaw }] = createResource(scope, loadMcpRaw)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  /**
   * 编辑框里的原文。草稿优先，没有草稿就取服务端那份。
   *
   * **只认 `ready`，不认 `refreshing`**，所以这里不用 `loaded()`：`raw` 的 source
   * 是 scope，切层重取的是另一个文件。留住上一份等于把上一层的正文摆在这一层名下，
   * 而这一页失焦即存——点进去再点出来就把用户级的内容存进了全局。
   */
  const text = () => draft() ?? (raw.state === 'ready' ? (raw.latest?.raw ?? '') : '')

  /**
   * 失焦即存，和这个应用里其他每一格一样。
   *
   * **先本地解析一次**：这一份要整体合法，不合法就只报错、不发请求。
   * 这是「随改随生效」在 JSON 编辑框上成立的唯一条件——没有这道闸，
   * 敲到一半失焦就是一次必然的 422。
   */
  const commit = async () => {
    const body = draft()
    if (body === null) return
    try {
      JSON.parse(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    try {
      await saveMcpRaw(scope(), body)
      setError(null)
      // 两个都要重取：`data` 是解析出来的 server 列表，`raw` 是编辑框回落的那份原文。
      // **草稿要等重取完再清**——先清的话编辑框会瞬间回落到重取前的旧原文，
      // 看起来像这次保存把内容改回去了。
      await Promise.all([refetch(), refetchRaw()])
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  /** 这一轮配了但没连上的：配置里有、servers 里没有。它们不能凭空消失。 */
  const missing = () =>
    (loaded(data)?.configured ?? []).filter(
      (c) => !loaded(data)?.servers.some((s) => s.name === c.name),
    )

  return (
    <Show
      when={loaded(data)}
      fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
    >
      {(d) => (
        <>
          {/* 这条是**能力边界**，不折叠也不降对比度：用户据它决定要不要在这里加
              server（B7 的例外条款）。 */}
          <p class="settings-page-note">
            mcp.json 决定模型拿到哪些工具。所以 agent 不能用 shell 写它——那等于自我提权，
            只能由你在这里改。
          </p>

          <Show when={d().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>

          <Show when={d().servers.length > 0}>
            <section class="settings-block">
              <div class="settings-block-head">
                <h3>已连上 {d().servers.length} 个</h3>
              </div>
              <div class="model-list">
                <For each={d().servers}>
                  {(s) => (
                    <div class="model-row">
                      <div class="model-row-main">
                        <span class="model-id">{s.name}</span>
                        <ScopeTag scope={s.scope} />
                        <span class="probe-line">
                          {s.tools.length} 个工具 · MCP {s.protocolVersion}
                        </span>
                      </div>
                      <Show when={s.tools.length > 0}>
                        <div class="probe-line">
                          <For each={s.tools}>{(t) => <code>{t.name}</code>}</For>
                        </div>
                      </Show>
                      {/* 声明了、我们没实现的能力。不写的话「连上了却没有工具」
                          就是一个查不出原因的现象。 */}
                      <Show when={s.unsupported.length > 0}>
                        <div class="probe-line bad">
                          这个 server 还声明了 {s.unsupported.join(' / ')}，qywork 没有实现，
                          它们不会生效
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Show when={missing().length > 0 || d().failures.length > 0}>
            <section class="settings-block">
              <div class="settings-block-head">
                <h3>没连上</h3>
              </div>
              <div class="model-list">
                <For each={missing()}>
                  {(c) => (
                    <div class="model-row">
                      <div class="model-row-main">
                        <span class="model-id">{c.name}</span>
                        <ScopeTag scope={c.scope} />
                      </div>
                    </div>
                  )}
                </For>
                <For each={d().failures}>
                  {(f) => (
                    <div class="model-row">
                      <div class="model-row-main">
                        <span class="model-id">{f.server}</span>
                      </div>
                      <div class="probe-line bad">{f.reason}</div>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <section class="settings-block">
            <div class="settings-block-head">
              <h3>配置</h3>
            </div>
            <ScopeBar
              value={scope()}
              onChange={(s) => {
                setScope(s)
                // 切层等于换一个文件，草稿不能跟过去——跟过去就是把 A 的内容存进 B。
                setDraft(null)
                setError(null)
              }}
              dirs={d().files.map((f) => ({ scope: f.scope, dir: f.path }))}
            />
            <textarea
              class="code-area"
              rows={12}
              value={text()}
              placeholder={'{\n  "mcpServers": {}\n}'}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => void commit()}
            />
            {/* 「重启后生效」是边界不是解释——不写的话用户会以为改完就连上了。
                它常驻，不挂在某一次保存上：那条边界一直成立。 */}
            <div class="row-actions">
              <span class="save-msg">重启应用后重新连接</span>
              <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
            </div>
          </section>
        </>
      )}
    </Show>
  )
}
