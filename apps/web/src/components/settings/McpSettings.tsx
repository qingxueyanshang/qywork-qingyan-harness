import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  importMcp,
  isDesktopShell,
  loadMcp,
  pickFiles,
  type Scope,
} from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'
import { ScopeTabs } from './Scope.tsx'

/**
 * MCP。
 *
 * ## 标签页选层，列表跟着过滤
 *
 * 不按层过滤的话，用户会在「项目」这一栏里看到全局配的那些，而这一栏的路径
 * 指的是另一个文件。
 *
 * ## 失败和成功一起列
 *
 * 连不上的那个是用户最需要看到的部分。而更隐蔽的一种是**握手成功但一个工具
 * 都没有**——一个只提供 prompts 的 server 会连上、`tools/list` 返回空、不报任何
 * 错，用户看到「配了但什么都没发生」。所以 `unsupported` 也要显示出来。
 *
 * 认不出属于哪一层的失败（整份文件解析失败之类）**两层都显示**：它没有层可归，
 * 藏在另一栏里等于没报。
 *
 * ## 这一页只报结果，不编辑配置
 *
 * server 的形状按 transport 分两种（stdio 要 command/args/env/cwd，http 要 url 和
 * headers），还要知道那个包的命令行怎么写——这几格填什么，用户在界面上判断不了。
 * 所以「新增」把话头递给模型（`askInChat`）由它写 `.agents/mcp.json`，「导入」并一份
 * 现成的进来；这一页只回答：连上了哪些、没连上哪些。
 */

/** 「新增」递给模型的话头。不自动发送——用户可以改了再发。 */
const NEW_SERVER =
  '我们一起来接一个 MCP 服务吧。先说明 MCP 服务在 qywork 里怎么配置、连接，配置写在哪个文件；然后问我要接哪一个、走本机命令还是 HTTP。'

export default function McpSettings() {
  const [data, { refetch }] = createResource(loadMcp)
  const [scope, setScope] = createSignal<Scope>('project')
  const [error, setError] = createSignal<string | null>(null)

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
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 「新增」/「导入」。**区头和空态框共用同一份**——两处各写一遍的话迟早只改一处，
   * 而空的时候用户看到的是空态框里那一份。
   */
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
                setError(null)
              }}
              dirs={d().files.map((f) => ({ scope: f.scope, dir: f.path }))}
              actions={<AddButton />}
            />

            <Show when={d().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>

            <Section>
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
                        {/* 声明了、本仓未实现的能力。不写的话「连上了却没有工具」
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
              {/* 导入失败挂在带「导入」按钮的这一段上。 */}
              <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
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
          </>
        )}
      </Show>
    </>
  )
}
