import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  loadTeam,
  loadTeamClis,
  loadTeamRaw,
  saveTeamRaw,
} from '../../lib/store/index.ts'
import { IconPencil, IconTrash } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'

/**
 * Agent Team。
 *
 * **这一页是两件事，不是一件事的两种形态**：
 * - **角色**＝子 agent，跑在本进程的 agent 循环上。它的配置是提示词、模型、步数。
 * - **外部 CLI**＝本机装着的别家 agent 程序。它由探测得到，**没有配置面**——
 *   用户改不了「怎么调它」，那是厂商表的事（`packages/team/src/cli-detect.ts`）。
 *
 * 两者都能当编排节点的目标，但配置面毫不相干。把 CLI 当成「角色的一种运行位置」
 * 写进角色里，代价是建一条角色必须先懂后端这个概念。
 *
 * **表单就是 team.json 的编辑器，不是第二本账。** 角色由表单改，但**落盘仍然只有 `/api/team/raw` 一
 * 条路**：表单读当前原文、改对象、整份写回。另开一条结构化写接口就是第二条落库路径，两条路径迟早在
 * 某次加字段时对不上。代价是写回时格式由 `JSON.stringify` 重排——JSON 没有注释，重排不丢信息。
 *
 * 界面上**没有原文编辑框**：表单盖不住的那几样（编排图、规则）要懂 JSON 结构才填得对，
 * 那不是用户在设置页里该判断的事。
 *
 * **加一条角色走对话，不在这里填表。** 角色要写的是系统提示词、能用哪些工具、步数上限，面板里几个格
 * 子填不全。同记忆 / 技能 / MCP / 插件 / 定时任务五页，「添加」把话头递给模型。
 *
 * **编排跟着仓库走。** 角色与编排图全是项目属性，跟到别的仓库去只会派错人。所以配置在工作区的
 * `.qy/team.json`，不在用户全局配置里。
 */

interface RoleJson {
  id?: string
  name?: string
  description?: string
  systemPrompt?: string
  provider?: string
  model?: string
  maxSteps?: number
}
interface TeamJson {
  roles?: RoleJson[]
  plan?: unknown[]
  rules?: unknown
}

interface RoleForm {
  id: string
  name: string
  description: string
  systemPrompt: string
  model: string
  maxSteps: string
}

/** 「添加」递给模型的话头。 */
const NEW_ROLE =
  '我们一起来加一个子 agent 吧。先说明子 agent 在 qywork 里怎么工作、配置写在哪个文件；然后问我要它干什么、能用哪些工具、步数给多少。'

export default function AgentsSettings() {
  const [team, { refetch: refetchTeam }] = createResource(loadTeam)
  const [clis, { refetch: refetchClis }] = createResource(loadTeamClis)
  const [file, { refetch: refetchRaw }] = createResource(loadTeamRaw)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [roleForm, setRoleForm] = createSignal<RoleForm | null>(null)

  // `loaded()` 而不是 `file()`：存一次要把两个 resource 都重取，重取期间留住上一份。
  const text = () => loaded(file)?.raw ?? ''

  /** 当前原文解析出来的对象。解析不了回 null。 */
  const config = (): TeamJson | null => {
    const body = text().trim()
    if (!body) return {}
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
      return parsed as TeamJson
    } catch {
      return null
    }
  }

  /**
   * 改一次对象、整份写回、两个 resource 都重取。
   *
   * `mutate` 返回一句话表示这次改动被拒，返回 null 表示改成了。
   * **拒绝要在写盘之前**——落盘之后再报错，用户看到的是「报了错但也改了」。
   */
  const writeConfig = async (mutate: (cfg: TeamJson) => string | null) => {
    const cfg = config()
    if (cfg === null) {
      setError('team.json 解析不了，修好它再用表单')
      return
    }
    const refused = mutate(cfg)
    if (refused) {
      setError(refused)
      return
    }
    setBusy(true)
    try {
      await saveTeamRaw(`${JSON.stringify(cfg, null, 2)}\n`)
      setError(null)
      await Promise.all([refetchRaw(), refetchTeam()])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 角色那一段的动作。**区头和空态框共用同一份**——两处各写一遍的话，
   * 迟早只改一处，而空的时候用户看到的是空态框里那一份。
   */
  const RoleActions = () => (
    <button class="btn-ghost sm" type="button" onClick={() => askInChat(NEW_ROLE)}>
      添加
    </button>
  )

  const openRole = (id: string) => {
    const r = config()?.roles?.find((x) => x.id === id)
    if (!r) {
      setError('这条角色在 team.json 里找不到，原文可能刚被改过')
      return
    }
    setError(null)
    setRoleForm({
      id: r.id ?? '',
      name: r.name ?? '',
      description: r.description ?? '',
      systemPrompt: r.systemPrompt ?? '',
      model: r.model ?? '',
      maxSteps: r.maxSteps === undefined ? '' : String(r.maxSteps),
    })
  }

  const saveRole = (f: RoleForm) =>
    void writeConfig((cfg) => {
      const id = f.id.trim()
      if (!id) return '标识不能为空'
      const steps = Number(f.maxSteps)
      if (f.maxSteps.trim() && (!Number.isInteger(steps) || steps <= 0)) {
        return '步数上限要是正整数'
      }
      cfg.roles ??= []
      const roles = cfg.roles
      const at = roles.findIndex((x) => x.id === id)
      const next: RoleJson = {
        id,
        name: f.name.trim() || id,
        description: f.description.trim(),
        systemPrompt: f.systemPrompt,
        ...(f.model.trim() ? { model: f.model.trim() } : {}),
        ...(f.maxSteps.trim() ? { maxSteps: steps } : {}),
      }
      if (at >= 0) roles[at] = next
      else roles.push(next)
      setRoleForm(null)
      return null
    })

  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。 */}
      <Show
        when={loaded(team)}
        fallback={<LoadState error={team.error} onRetry={() => void refetchTeam()} />}
      >
        {(t) => (
          <>
            {/* 配置坏了要说出来，不能静默当作「没配 team」——那在界面上等同于
                这个功能不存在。 */}
            <Show when={t().error}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
            {/* 表单改的是这份原文解析出来的对象。读不到它而不说，下一次保存会把
                编排图与规则一起写没——所以这条失败必须显形，并给一条重试的路。 */}
            <Show when={file.error}>
              <LoadState error={file.error} onRetry={() => void refetchRaw()} />
            </Show>

            <Section title="角色" path={loaded(file)?.path ?? ''} actions={<RoleActions />}>
              <Show
                when={t().roles.length > 0}
                fallback={<EmptyBox label="还没有角色" actions={<RoleActions />} />}
              >
                <div class="entry-list">
                  <For each={t().roles}>
                    {(r) => (
                      <EntryCard
                        name={r.name}
                        desc={r.description}
                        actions={
                          <>
                            <button
                              class="icon-btn"
                              type="button"
                              aria-label={`编辑角色 ${r.name}`}
                              data-tip="编辑"
                              onClick={() => openRole(r.id)}
                            >
                              <IconPencil size={13} />
                            </button>
                            <button
                              class="icon-btn"
                              type="button"
                              aria-label={`删除角色 ${r.name}`}
                              data-tip="删除"
                              disabled={busy()}
                              onClick={() =>
                                void writeConfig((cfg) => {
                                  cfg.roles = (cfg.roles ?? []).filter((x) => x.id !== r.id)
                                  if (roleForm()?.id === r.id) setRoleForm(null)
                                  return null
                                })
                              }
                            >
                              <IconTrash size={13} />
                            </button>
                          </>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={roleForm()}>
              {(f) => (
                <Section title={`编辑 ${f().name || f().id}`}>
                  <div class="setting-rows">
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">标识</span>
                        <span class="setting-row-hint">编排图按它引用这个角色</span>
                      </div>
                      {/* 标识不可改：改一个已有角色的 id 等于换一个角色，
                          而编排图里引用它的那些节点会当场失效。 */}
                      <input type="text" value={f().id} disabled />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">名称</span>
                      </div>
                      <input
                        type="text"
                        value={f().name}
                        placeholder="如 代码审查员"
                        onInput={(e) => setRoleForm({ ...f(), name: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">说明</span>
                        <span class="setting-row-hint">调度者按它决定把什么交给这个角色</span>
                      </div>
                      <input
                        type="text"
                        value={f().description}
                        onInput={(e) => setRoleForm({ ...f(), description: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row">
                      <div class="setting-row-text">
                        <span class="setting-row-label">模型</span>
                        <span class="setting-row-hint">留空跟着当前会话</span>
                      </div>
                      <div class="setting-row-control">
                        <input
                          type="text"
                          value={f().model}
                          placeholder="跟随会话"
                          onInput={(e) => setRoleForm({ ...f(), model: e.currentTarget.value })}
                        />
                      </div>
                    </div>
                    <div class="setting-row">
                      <div class="setting-row-text">
                        <span class="setting-row-label">步数上限</span>
                        <span class="setting-row-hint">留空不限</span>
                      </div>
                      <div class="setting-row-control">
                        <input
                          type="text"
                          inputmode="numeric"
                          value={f().maxSteps}
                          placeholder="不限"
                          onInput={(e) => setRoleForm({ ...f(), maxSteps: e.currentTarget.value })}
                        />
                      </div>
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">系统提示词</span>
                        <span class="setting-row-hint">追加在这个角色的系统提示词后面</span>
                      </div>
                      <textarea
                        class="code-area"
                        rows={6}
                        value={f().systemPrompt}
                        onInput={(e) =>
                          setRoleForm({ ...f(), systemPrompt: e.currentTarget.value })
                        }
                      />
                    </div>
                  </div>
                  <div class="row-actions">
                    <button
                      class="btn-primary"
                      type="button"
                      disabled={busy() || !f().id.trim()}
                      onClick={() => saveRole(f())}
                    >
                      保存
                    </button>
                    <button class="btn-ghost" type="button" onClick={() => setRoleForm(null)}>
                      取消
                    </button>
                    <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
                  </div>
                </Section>
              )}
            </Show>

            {/* 外部 CLI 这一段**没有增删改**：它整条来自本机探测。
                能显示的只有「装在哪、接没接入」，两样都不是用户在这里填的。 */}
            <Section title="外部 CLI" desc="本机独立进程，凭证与沙箱各自独立。">
              <Show
                when={loaded(clis)}
                fallback={<LoadState error={clis.error} onRetry={() => void refetchClis()} />}
              >
                {(c) => (
                  <Show
                    when={c().agents.length > 0}
                    fallback={<EmptyBox label="本机没有识别到外部 CLI" />}
                  >
                    <div class="entry-list">
                      <For each={c().agents}>
                        {(a) => (
                          <EntryCard
                            name={a.id}
                            desc={a.path}
                            badge={<span class="entry-tag">{a.vendor}</span>}
                          >
                            {/* 「接入」判的是见没见到凭证，不是真的跑通了——
                                真跑一次要花钱、要几十秒，而这是打开页面就该出的结果。 */}
                            <div class="entry-extra" classList={{ bad: !a.connected }}>
                              {a.connected ? '已接入' : '未见凭证'}
                            </div>
                          </EntryCard>
                        )}
                      </For>
                    </div>
                  </Show>
                )}
              </Show>
            </Section>

            {/* 表单没开着时报错也要有地方落——删一条角色被拒的话，
                否则那句话跟着表单一起消失了。

                **`error()` 必须排在这串 `&&` 的最后。** `Show` 把 `when` 的求值
                结果原样交给子函数，写成 `error() && !roleForm()` 时那个结果是
                布尔 `true`，渲染出来是一个空的红框——报错框在，字没了。 */}
            <Show when={!roleForm() && error()}>
              {(e) => <p class="settings-notices bad">{e()}</p>}
            </Show>
          </>
        )}
      </Show>
    </>
  )
}
