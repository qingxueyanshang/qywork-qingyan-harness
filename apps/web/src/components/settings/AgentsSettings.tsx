import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { loadTeam, loadTeamRaw, saveTeamRaw } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, PageHead, PathLine, Section } from './Page.tsx'

const TEMPLATE = `{
  "backends": {},
  "roles": [],
  "plan": []
}
`

/**
 * Agent Team。
 *
 * ## 角色在前，原文在后
 *
 * 整页只放一个 `team.json` 编辑框的话，**「有哪些角色」这个问题的答案就藏在了
 * 一段 JSON 里**，而服务端本来就把角色解析好、回的是结构化的 `roles`
 * （`api/team.ts` 的 `/api/team`）。
 *
 * 所以：角色卡列表在上，原文编辑降到底部的「高级」。原文不删——
 * 后端和编排图确实只有 JSON 表达得了，做成表单是把一个通用结构塞进固定几格。
 *
 * ## 不分层，所以没有作用域标签页
 *
 * 编排跟着仓库走：角色、后端、编排图全是项目属性，跟到别的仓库去只会派错人。
 * 所以它留在工作区的 `.qy/team.json`，没有全局那一层。
 */
export default function AgentsSettings() {
  const [team, { refetch: refetchTeam }] = createResource(loadTeam)
  const [file, { refetch: refetchRaw }] = createResource(loadTeamRaw)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  // `loaded()` 而不是 `file()`：存一次要把两个 resource 都重取，重取期间留住上一份，
  // 编辑框才不会闪空。
  const text = () => draft() ?? loaded(file)?.raw ?? ''

  /**
   * 失焦即存。**先本地解析一次**：这一份要整体合法，不合法就只报错、不发请求
   * ——没有这道闸，敲到一半失焦就是一次必然的 422。
   * 本地解析同时能指出出错的位置，往返一次只会得到一句话。
   */
  const commit = async () => {
    const body = draft()
    if (body === null || !body.trim()) return
    try {
      JSON.parse(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    }
    try {
      await saveTeamRaw(body)
      setError(null)
      // **草稿要等重取完再清**：先清的话编辑框会瞬间回落到重取前的旧原文，
      // 看起来像这次保存把内容改回去了。
      await Promise.all([refetchRaw(), refetchTeam()])
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。 */}
      <PageHead
        title="Agent Team"
        desc="按角色分工的编排，只属于当前项目。角色可以跑在本进程里，也可以是本机上另一个 CLI。"
      />
      <Show
        when={loaded(team)}
        fallback={<LoadState error={team.error} onRetry={() => void refetchTeam()} />}
      >
        {(t) => (
          <>
            {/* 配置坏了要说出来，不能静默当作「没配 team」——那会让用户以为
              这个功能不存在。 */}
            <Show when={t().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>

            <Section title="角色">
              <Show when={t().roles.length > 0} fallback={<EmptyBox label="还没有配角色" />}>
                <div class="entry-list">
                  <For each={t().roles}>
                    {(r) => (
                      <EntryCard name={r.name} desc={r.description}>
                        {/* 后端是 builtin 还是某个外部 CLI，是这一行最要紧的事实：
                          外部 CLI 的那些跑在本机另一个进程里，凭证和沙箱都是另一套。 */}
                        <div class="entry-extra">
                          <code>{r.backend}</code>
                        </div>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={t().plan.length > 0}>
              <Section title="编排">
                <div class="entry-list">
                  <For each={t().plan}>
                    {(n) => (
                      <EntryCard name={n.roleId} desc={n.task}>
                        <Show when={n.needs?.length}>
                          <div class="entry-extra">依赖 {n.needs!.join(' / ')}</div>
                        </Show>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Section>
            </Show>

            <Show
              when={loaded(file)}
              fallback={<LoadState error={file.error} onRetry={() => void refetchRaw()} />}
            >
              {(f) => (
                <Section title="高级：直接改 team.json">
                  <PathLine path={f().path} />
                  <textarea
                    class="code-area"
                    rows={14}
                    spellcheck={false}
                    value={text()}
                    onInput={(e) => setDraft(e.currentTarget.value)}
                    onBlur={() => void commit()}
                  />
                  <div class="row-actions">
                    <Show when={!f().exists && draft() === null}>
                      <button class="btn-ghost" type="button" onClick={() => setDraft(TEMPLATE)}>
                        插入空模板
                      </button>
                    </Show>
                    <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
                  </div>
                </Section>
              )}
            </Show>
          </>
        )}
      </Show>
    </>
  )
}
