import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { loadTeam, loadTeamRaw, saveTeamRaw } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'

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
 * ## 不分层
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
    <Show
      when={loaded(team)}
      fallback={<LoadState error={team.error} onRetry={() => void refetchTeam()} />}
    >
      {(t) => (
        <>
          {/* 配置坏了要说出来，不能静默当作「没配 team」——那会让用户以为
              这个功能不存在。 */}
          <Show when={t().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>

          <Show when={t().roles.length > 0}>
            <section class="settings-block">
              <div class="settings-block-head">
                <h3>{t().roles.length} 个角色</h3>
              </div>
              <div class="model-list">
                <For each={t().roles}>
                  {(r) => (
                    <div class="model-row">
                      <div class="model-row-main">
                        <span class="model-id">{r.name}</span>
                        {/* 后端是 builtin 还是某个外部 CLI，是这一行最要紧的事实：
                            外部 CLI 的那些跑在本机另一个进程里，凭证和沙箱都是另一套。 */}
                        <span class="probe-line">{r.backend}</span>
                      </div>
                      <div class="probe-line">{r.description}</div>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <Show when={t().plan.length > 0}>
            <section class="settings-block">
              <div class="settings-block-head">
                <h3>编排</h3>
              </div>
              <div class="model-list">
                <For each={t().plan}>
                  {(n) => (
                    <div class="model-row">
                      <div class="model-row-main">
                        <span class="model-id">{n.roleId}</span>
                        <Show when={n.needs?.length}>
                          <span class="probe-line">依赖 {n.needs!.join(' / ')}</span>
                        </Show>
                      </div>
                      <div class="probe-line">{n.task}</div>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>

          <section class="settings-block">
            <div class="settings-block-head">
              <h3>高级：直接改 team.json</h3>
            </div>
            <Show
              when={loaded(file)}
              fallback={<LoadState error={file.error} onRetry={() => void refetchRaw()} />}
            >
              {(f) => (
                <>
                  <code class="field-path">{f().path}</code>
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
                </>
              )}
            </Show>
          </section>
        </>
      )}
    </Show>
  )
}
