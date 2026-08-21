import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  importMcp,
  isDesktopShell,
  loadMcp,
  loadMcpRaw,
  pickFiles,
  type Scope,
  saveMcpRaw,
} from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'
import { ScopeTabs } from './Scope.tsx'

/**
 * MCP。
 *
 * ## 标签页选层，整页跟着走
 *
 * 上面的 server 列表和下面的配置原文是同一层的两个视图。列表不按层过滤的话，
 * 用户会在「项目」这一栏里看到全局配的那些，然后去下面的编辑框里找它们——找不到。
 *
 * ## 失败和成功一起列
 *
 * 连不上的那个恰恰是用户最需要看到的部分。而更隐蔽的一种是**握手成功但一个工具
 * 都没有**——一个只提供 prompts 的 server 会连上、`tools/list` 返回空、不报任何
 * 错，用户看到「配了但什么都没发生」。所以 `unsupported` 也要显示出来。
 *
 * 认不出属于哪一层的失败（整份文件解析失败之类）**两层都显示**：它没有层可归，
 * 藏在另一栏里等于没报。
 *
 * ## 面板里只有原文，新增交给模型
 *
 * server 的形状按 transport 分两种（stdio 要 command/args/env/cwd，http 要 url 和
 * headers），还要知道那个包的命令行怎么写。面板表单只盖得住最表层几格，剩下的
 * 仍然得来这份原文里补。所以「新增」把话头递给模型（`askInChat`），由它写进
 * `.agents/mcp.json`；这一页负责给出结果：连上了哪些、没连上哪些、原文长什么样。
 */

/** 「新增」递给模型的话头。不自动发送——用户可以改了再发。 */
const NEW_SERVER =
  '我们一起来接一个 MCP 服务吧。先说明 MCP 服务在 qywork 里怎么配置、连接，配置写在哪个文件；然后问我要接哪一个、走本机命令还是 HTTP。'

export default function McpSettings() {
  const [data, { refetch }] = createResource(loadMcp)
  const [scope, setScope] = createSignal<Scope>('project')
  const [raw, { refetch: refetchRaw }] = createResource(scope, loadMcpRaw)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  /**
   * 编辑框里的原文。草稿优先，没有草稿就取服务端那份。
   *
   * **只认 `ready`，不认 `refreshing`**，所以这里不用 `loaded()`：`raw` 的 source
   * 是 scope，切层重取的是另一个文件。留住上一份等于把上一层的正文摆在这一层名下，
   * 而这一页失焦即存——点进去再点出来就把项目层的内容存进了全局。
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

  /**
   * 「添加」按钮。**区头和空态框共用同一份。**
   *
   * 挂在第一段（「已连上」）的区头上，全页只此一颗：三段说的是同一批 server，
   * 挂在「配置」那一段的话，列表一长它就被推到屏幕外，用户得往下滚才找得到。
   * 空态框里再放一颗——那一刻用户正盯着空框，与其余几页同一个做法。
   */
  /**
   * 从本机一份现成的配置里并进来。多半是从别的 MCP 客户端整段拷来的那一份。
   *
   * 只取选中的第一个：并两份配置要先解决它们之间的同名冲突，那是另一件事。
   */
  const browse = async () => {
    if (!isDesktopShell()) return
    setError(null)
    try {
      const picked = (await pickFiles())[0]
      // 取消不是错误。
      if (!picked) return
      await importMcp(scope(), picked)
      await Promise.all([refetch(), refetchRaw()])
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const AddButton = () => (
    <>
      {/* 导入只有桌面外壳有：网页里没有系统文件选择器，
          留一个点了没反应的按钮比不给更糟（B5）。 */}
      <Show when={isDesktopShell()}>
        <button class="btn-ghost sm" type="button" onClick={() => void browse()}>
          导入
        </button>
      </Show>
      <button class="btn-ghost sm" type="button" onClick={() => askInChat(NEW_SERVER)}>
        新增
      </button>
    </>
  )

  const servers = () => (loaded(data)?.servers ?? []).filter((s) => s.scope === scope())
  /** 这一轮配了但没连上的：配置里有、servers 里没有。它们不能凭空消失。 */
  const missing = () =>
    (loaded(data)?.configured ?? []).filter(
      (c) => c.scope === scope() && !loaded(data)?.servers.some((s) => s.name === c.name),
    )
  const failures = () =>
    (loaded(data)?.failures ?? []).filter((f) => {
      const owner = loaded(data)?.configured.find((c) => c.name === f.server)
      return owner === undefined || owner.scope === scope()
    })

  return (
    <>
      {/* 页头在 `Show` 外面：连一批 server 要几秒，这几秒里这一页也该有名字。 */}
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            <ScopeTabs
              value={scope()}
              onChange={(s) => {
                setScope(s)
                // 切层等于换一个文件，草稿不能跟过去——跟过去就是把 A 的内容存进 B。
                setDraft(null)
                setError(null)
              }}
              dirs={d().files.map((f) => ({ scope: f.scope, dir: f.path }))}
            />

            <Show when={d().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>

            <Section title="已连上" actions={<AddButton />}>
              <Show
                when={servers().length > 0}
                fallback={<EmptyBox label="这一层没有连上的服务" actions={<AddButton />} />}
              >
                <div class="entry-list">
                  <For each={servers()}>
                    {(s) => (
                      <EntryCard
                        name={s.name}
                        desc={`${s.tools.length} 个工具 · MCP ${s.protocolVersion}`}
                      >
                        <Show when={s.tools.length > 0}>
                          <div class="entry-extra">
                            <For each={s.tools}>{(t) => <code>{t.name}</code>}</For>
                          </div>
                        </Show>
                        {/* 声明了、我们没实现的能力。不写的话「连上了却没有工具」
                          就是一个查不出原因的现象。 */}
                        <Show when={s.unsupported.length > 0}>
                          <div class="entry-extra bad">
                            这个 server 还声明了 {s.unsupported.join(' / ')}，qywork 没有实现，
                            它们不会生效
                          </div>
                        </Show>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={missing().length > 0 || failures().length > 0}>
              <Section title="没连上">
                <div class="entry-list">
                  <For each={missing()}>{(c) => <EntryCard name={c.name} />}</For>
                  <For each={failures()}>
                    {(f) => (
                      <EntryCard name={f.server}>
                        <div class="entry-extra bad">{f.reason}</div>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Section>
            </Show>

            <Section title="配置">
              <textarea
                class="code-area"
                rows={12}
                value={text()}
                placeholder={'{\n  "mcpServers": {}\n}'}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onBlur={() => void commit()}
              />
              <Show when={error()}>
                {(e) => (
                  <div class="row-actions">
                    <span class="save-msg bad">{e()}</span>
                  </div>
                )}
              </Show>
            </Section>
          </>
        )}
      </Show>
    </>
  )
}
