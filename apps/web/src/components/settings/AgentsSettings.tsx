import { createResource, createSignal, For, Show } from 'solid-js'
import { loadTeam, loadTeamRaw, saveTeamRaw } from '../../lib/store/index.ts'
import { LoadState } from './LoadState.tsx'

const TEMPLATE = `{
  "backends": {},
  "roles": [],
  "plan": []
}
`

/**
 * 智能体。
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
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const text = () => draft() ?? file()?.raw ?? ''

  return (
    <Show
      when={team()}
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
              when={file()}
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
                  />
                  <div class="row-actions">
                    <Show when={!f().exists && draft() === null}>
                      <button class="btn-ghost" type="button" onClick={() => setDraft(TEMPLATE)}>
                        插入空模板
                      </button>
                    </Show>
                    {/* JSON 编辑框保留显式保存：它要整体合法，逐 blur 提交必然频繁 422。 */}
                    <button
                      class="btn-primary"
                      type="button"
                      disabled={busy() || !text().trim()}
                      onClick={() =>
                        void (async () => {
                          setBusy(true)
                          try {
                            // 先本地解析一次再发：同样的错误让服务端回 422 也行，
                            // 但本地解析能立刻指出出错的位置，往返一次只会得到一句话。
                            JSON.parse(text())
                            await saveTeamRaw(text())
                            setDraft(null)
                            setError(null)
                            await Promise.all([refetchRaw(), refetchTeam()])
                          } catch (e) {
                            setError(e instanceof Error ? e.message : String(e))
                          } finally {
                            setBusy(false)
                          }
                        })()
                      }
                    >
                      保存
                    </button>
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
