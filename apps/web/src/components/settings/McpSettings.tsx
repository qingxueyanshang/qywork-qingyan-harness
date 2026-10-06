import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  extensionsRevision,
  importMcp,
  isDesktopShell,
  loadMcp,
  pickFiles,
  type Scope,
  workspace,
} from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'
import { ScopeTabs } from './Scope.tsx'
import { newMcpPrompt } from './ScopePrompts.ts'

/**
 * MCP。
 *
 * 标签页选择层级，列表随之过滤。若不按层过滤，用户会在「项目」标签页中看到全局配置的 server，而该标签页
 * 显示的路径指向另一个文件。
 *
 * 失败与成功一并列出。连接失败的 server 是用户最需要看到的部分。更隐蔽的一种情况是握手成功但没有任何
 * 工具：只提供 prompts 的 server 能够连接，`tools/list` 返回空列表，不报告任何
 * 错误，用户看到的是已配置但没有任何效果。因此 `unsupported` 也必须显示。
 *
 * 无法确定所属层级的失败（如整个文件解析失败）在两层都显示：它没有可归属的层级，
 * 只显示在另一个标签页中等于未报告。
 *
 * 本页只显示连接结果，不编辑配置。server 的配置格式按 transport 分为两种（stdio 需要
 * command/args/env/cwd，http 需要 url 和 headers），还需要了解对应包的命令行写法，
 * 用户无法在界面上判断这些字段应填写的内容。
 * 因此「新增」把当前标签页的作用域一并交给模型（`askInChat`），由专用工具写入对应层的 `mcp.json`；
 * 「导入」合并一份现有配置。本页只显示哪些 server 已连接、哪些未连接。
 */

export default function McpSettings() {
  const [data, { refetch }] = createResource(() => [workspace()?.id, extensionsRevision()], loadMcp)
  const [scope, setScope] = createSignal<Scope>('project')
  const [error, setError] = createSignal<string | null>(null)

  /**
   * 从本机的现有配置文件合并。通常是从其他 MCP 客户端完整复制的配置。
   *
   * 只取选中的第一个文件：合并两份配置需要先解决它们之间的同名冲突，不在本功能范围内。
   */
  const browse = async () => {
    if (!isDesktopShell()) return
    setError(null)
    try {
      const picked = (await pickFiles())[0]
      // 取消不是错误。
      if (!picked) return
      const result = await importMcp(scope(), picked)
      if (!result.activation.connected)
        setError(
          `配置已保存，连接失败：${result.activation.failures.map((f) => f.reason).join('；')}`,
        )
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 「新增」/「导入」。区段标题与空状态框共用同一份定义：两处分别编写时容易只修改一处，
   * 而列表为空时用户看到的是空状态框中的那一份。
   */
  const AddButton = () => (
    <>
      {/* 导入只在桌面外壳中提供：网页中没有系统文件选择器，
          保留一个点击无响应的按钮比不提供更差（B5）。 */}
      <Show when={isDesktopShell()}>
        <button class="btn-ghost sm" type="button" onClick={() => void browse()}>
          导入
        </button>
      </Show>
      <button class="btn-ghost sm" type="button" onClick={() => askInChat(newMcpPrompt(scope()))}>
        新增
      </button>
    </>
  )

  const servers = () => (loaded(data)?.servers ?? []).filter((s) => s.scope === scope())

  /** 本次已配置但未连接的 server：配置中存在而 servers 中不存在的项。 */
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
            <Switch fallback={<EmptyBox label="该层没有已连接的服务" actions={<AddButton />} />}>
              <Match when={servers().length > 0}>
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
                        {/* server 声明而本仓库未实现的能力。不显示时，已连接却没有工具
                          将成为无法查明原因的现象。 */}
                        <Show when={s.unsupported.length > 0}>
                          <div class="entry-extra bad">
                            该 server 还声明了 {s.unsupported.join(' / ')}，qywork 未实现，
                            这些能力不会生效
                          </div>
                        </Show>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Match>
            </Switch>
            {/* 导入失败显示在带「导入」按钮的区段中。 */}
            <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
          </Section>

          <Show when={missing().length > 0 || failures().length > 0}>
            <Section title="未连接">
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
  )
}
