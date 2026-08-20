import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { loadTeam, loadTeamRaw, saveTeamRaw } from '../../lib/store/index.ts'
import { IconPencil, IconX } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, PageHead, PathLine, Section } from './Page.tsx'

/**
 * Agent Team。
 *
 * ## 为什么必须有表单
 *
 * 这一页之前只有一个 `team.json` 文本框：角色列表是空的，而唯一的填法是手写
 * JSON。空状态旁边一个出口都没有，比一个点了没反应的按钮更糟。
 *
 * ## 表单就是 team.json 的编辑器，不是第二本账
 *
 * 角色和后端由表单增删改，但**落盘仍然只有 `/api/team/raw` 一条路**：表单读当前
 * 原文、改对象、整份写回。另开一条结构化写接口就是第二条落库路径，两条路径迟早
 * 在某次加字段时对不上。代价是写回时格式由 `JSON.stringify` 重排——JSON 没有注释，
 * 重排丢不掉信息。
 *
 * ## 列表读 `/api/team`，表单读原文
 *
 * 列表显示的是**编排器真正会用的那批角色**：指向不存在后端的会被加载器整条丢掉
 * 并记进 `error`，它们不该出现在列表里。表单改的是文件里的原文对象。
 * 两个来源回答的是不同的问题，不是同一件事的两份。
 *
 * ## 后端不必先建
 *
 * `roles[].backend` 是 `backends` 里的一个键，指向不存在的后端时这条角色会被
 * 整条丢弃。所以新建角色时「内置模型」永远可选，保存时顺带把 `backends.builtin`
 * 建出来——否则第一个角色必然建不成。
 *
 * ## 编排图留在原文里
 *
 * `plan` 是一张 DAG（节点、依赖、产出插在哪里），做成表单要么盖不全、要么长成
 * 一个通用图编辑器的劣化版。它不是必填：空的就是单角色直跑第一个角色。
 *
 * ## 不分层
 *
 * 编排跟着仓库走：角色、后端、编排图全是项目属性，跟到别的仓库去只会派错人。
 * 所以它留在工作区的 `.qy/team.json`，没有全局那一层，也就没有作用域标签页。
 */

interface BackendJson {
  kind?: string
  preset?: string
  command?: string
  args?: string[]
  output?: string
  resultField?: string
  provider?: string
  model?: string
}
interface RoleJson {
  id?: string
  name?: string
  description?: string
  systemPrompt?: string
  backend?: string
  maxSteps?: number
}
interface TeamJson {
  backends?: Record<string, BackendJson>
  roles?: RoleJson[]
  plan?: unknown[]
  rules?: unknown
}

interface RoleForm {
  id: string
  isNew: boolean
  name: string
  description: string
  systemPrompt: string
  backend: string
  maxSteps: string
}
interface BackendForm {
  id: string
  isNew: boolean
  kind: 'builtin' | 'cli'
  provider: string
  model: string
  command: string
  args: string
  output: 'text' | 'jsonl'
  resultField: string
}

/** 内置后端的默认键名。新建角色时选「内置模型」就落在它上面。 */
const BUILTIN_ID = 'builtin'

const emptyRole = (): RoleForm => ({
  id: '',
  isNew: true,
  name: '',
  description: '',
  systemPrompt: '',
  backend: BUILTIN_ID,
  maxSteps: '',
})
const emptyBackend = (): BackendForm => ({
  id: '',
  isNew: true,
  kind: 'cli',
  provider: '',
  model: '',
  command: '',
  args: '',
  output: 'text',
  resultField: '',
})

export default function AgentsSettings() {
  const [team, { refetch: refetchTeam }] = createResource(loadTeam)
  const [file, { refetch: refetchRaw }] = createResource(loadTeamRaw)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [showRaw, setShowRaw] = createSignal(false)
  const [roleForm, setRoleForm] = createSignal<RoleForm | null>(null)
  const [backendForm, setBackendForm] = createSignal<BackendForm | null>(null)

  // `loaded()` 而不是 `file()`：存一次要把两个 resource 都重取，重取期间留住上一份，
  // 编辑框才不会闪空。
  const text = () => draft() ?? loaded(file)?.raw ?? ''

  /**
   * 当前原文解析出来的对象。**草稿优先**——手改了原文还没存就点表单时，
   * 表单基于的是屏幕上那份，不是盘上那份。解析不了回 null。
   */
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

  const backendIds = (): string[] => {
    const ids = Object.keys(config()?.backends ?? {})
    // 内置永远可选：一个后端都没有时，第一个角色否则建不出来。
    return ids.includes(BUILTIN_ID) ? ids : [BUILTIN_ID, ...ids]
  }

  /** 一个后端跑的是什么。角色卡上贴的是它——「这条角色跑在哪」是那一行最要紧的事实。 */
  const backendLabel = (id: string): string => {
    const b = config()?.backends?.[id]
    if (!b) return id
    if (b.kind === 'builtin') return b.model ? `内置模型 · ${b.model}` : '内置模型'
    return b.command ?? id
  }

  /**
   * 后端卡下面那一行：它到底会执行什么。
   *
   * 外部 CLI 给完整的调用式（命令 + 参数），**不是再把命令名写一遍**——
   * 多数人会把后端标识起成和命令一样的名字，那样卡片就是同一个词上下各一次。
   */
  const backendDetail = (id: string): string => {
    const b = config()?.backends?.[id]
    if (!b) return ''
    if (b.kind === 'builtin') {
      return [b.provider, b.model].filter(Boolean).join(' · ')
    }
    return [b.command, ...(b.args ?? [])].filter(Boolean).join(' ')
  }

  /**
   * 改一次对象、整份写回、两个 resource 都重取。
   *
   * `mutate` 返回一句话表示这次改动被拒（比如后端还有人用），返回 null 表示改成了。
   * **拒绝要在写盘之前**——落盘之后再报错，用户看到的是「报了错但也改了」。
   */
  const writeConfig = async (mutate: (cfg: TeamJson) => string | null) => {
    const cfg = config()
    if (cfg === null) {
      setError('team.json 解析不了，先在下面「直接改 team.json」里修好再用表单')
      setShowRaw(true)
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
      // **草稿要等重取完再清**：先清的话编辑框会瞬间回落到重取前的旧原文。
      await Promise.all([refetchRaw(), refetchTeam()])
      setDraft(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const openRole = (id: string) => {
    const r = config()?.roles?.find((x) => x.id === id)
    if (!r) {
      setError('这条角色在 team.json 里找不到，原文可能刚被改过')
      return
    }
    setBackendForm(null)
    setError(null)
    setRoleForm({
      id: r.id ?? '',
      isNew: false,
      name: r.name ?? '',
      description: r.description ?? '',
      systemPrompt: r.systemPrompt ?? '',
      backend: r.backend ?? BUILTIN_ID,
      maxSteps: r.maxSteps === undefined ? '' : String(r.maxSteps),
    })
  }

  const saveRole = (f: RoleForm) =>
    void writeConfig((cfg) => {
      const id = f.id.trim()
      if (!id) return '标识不能为空'
      cfg.roles ??= []
      const roles = cfg.roles
      const at = roles.findIndex((x) => x.id === id)
      if (f.isNew && at >= 0) return `已经有一个叫 ${id} 的角色了`

      // 选了内置而 backends 里还没有它时顺带建出来：不建的话这条角色一落盘
      // 就会被加载器当成「指向不存在的后端」整条丢掉。
      cfg.backends ??= {}
      const backends = cfg.backends
      if (f.backend === BUILTIN_ID && !backends[BUILTIN_ID]) {
        backends[BUILTIN_ID] = { kind: 'builtin' }
      }

      const steps = Number.parseInt(f.maxSteps, 10)
      const next: RoleJson = {
        id,
        name: f.name.trim() || id,
        description: f.description.trim(),
        systemPrompt: f.systemPrompt,
        backend: f.backend,
        ...(Number.isFinite(steps) && steps > 0 ? { maxSteps: steps } : {}),
      }
      if (at >= 0) roles[at] = next
      else roles.push(next)
      setRoleForm(null)
      return null
    })

  const openBackend = (id: string) => {
    const b = config()?.backends?.[id]
    if (!b) {
      setError('这个后端在 team.json 里找不到，原文可能刚被改过')
      return
    }
    setRoleForm(null)
    setError(null)
    setBackendForm({
      id,
      isNew: false,
      kind: b.kind === 'builtin' ? 'builtin' : 'cli',
      provider: b.provider ?? '',
      model: b.model ?? '',
      command: b.command ?? '',
      args: (b.args ?? []).join('\n'),
      output: b.output === 'jsonl' ? 'jsonl' : 'text',
      resultField: b.resultField ?? '',
    })
  }

  const saveBackend = (f: BackendForm) =>
    void writeConfig((cfg) => {
      const id = f.id.trim()
      if (!id) return '标识不能为空'
      cfg.backends ??= {}
      const backends = cfg.backends
      if (f.isNew && backends[id]) return `已经有一个叫 ${id} 的后端了`
      if (f.kind === 'cli' && !f.command.trim()) return '外部 CLI 要填命令'

      backends[id] =
        f.kind === 'builtin'
          ? {
              kind: 'builtin',
              ...(f.provider.trim() ? { provider: f.provider.trim() } : {}),
              ...(f.model.trim() ? { model: f.model.trim() } : {}),
            }
          : {
              kind: 'cli',
              command: f.command.trim(),
              args: f.args
                .split('\n')
                .map((a) => a.trim())
                .filter(Boolean),
              output: f.output,
              ...(f.output === 'jsonl' && f.resultField.trim()
                ? { resultField: f.resultField.trim() }
                : {}),
            }
      setBackendForm(null)
      return null
    })

  /**
   * 原文失焦即存。**先本地解析一次**：这一份要整体合法，不合法就只报错、不发请求
   * ——没有这道闸，敲到一半失焦就是一次必然的 422。
   * 本地解析同时能指出出错的位置，往返一次只会得到一句话。
   */
  const commitRaw = async () => {
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
        actions={
          <button
            class="btn-ghost sm"
            type="button"
            onClick={() => {
              setBackendForm(null)
              setError(null)
              setRoleForm(emptyRole())
            }}
          >
            新建角色
          </button>
        }
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
              <Show when={t().roles.length > 0} fallback={<EmptyBox label="还没有角色" />}>
                <div class="entry-list">
                  <For each={t().roles}>
                    {(r) => (
                      <EntryCard
                        name={r.name}
                        desc={r.description}
                        badge={<span class="entry-tag">{backendLabel(r.backend)}</span>}
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
                              <IconX size={13} />
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
                <Section title={f().isNew ? '新建角色' : `编辑 ${f().name || f().id}`}>
                  <div class="setting-rows">
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">标识</span>
                        <span class="setting-row-hint">编排图按它引用这个角色</span>
                      </div>
                      {/* 标识只在新建时可改：改一个已有角色的 id 等于换一个角色，
                          而编排图里引用它的那些节点会当场失效。 */}
                      <input
                        type="text"
                        value={f().id}
                        disabled={!f().isNew}
                        placeholder="如 reviewer"
                        onInput={(e) => setRoleForm({ ...f(), id: e.currentTarget.value })}
                      />
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
                        <span class="setting-row-hint">调度者据此决定把什么交给它</span>
                      </div>
                      <input
                        type="text"
                        value={f().description}
                        placeholder="负责代码审查、风险识别，并提出改进建议。"
                        onInput={(e) => setRoleForm({ ...f(), description: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row">
                      <div class="setting-row-text">
                        <span class="setting-row-label">后端</span>
                      </div>
                      <div class="setting-row-control">
                        <select
                          value={f().backend}
                          onChange={(e) => setRoleForm({ ...f(), backend: e.currentTarget.value })}
                        >
                          <For each={backendIds()}>
                            {(id) => <option value={id}>{backendLabel(id)}</option>}
                          </For>
                        </select>
                      </div>
                    </div>
                    <div class="setting-row">
                      <div class="setting-row-text">
                        <span class="setting-row-label">步数上限</span>
                        <span class="setting-row-hint">留空不限</span>
                      </div>
                      <div class="setting-row-control">
                        <input
                          type="number"
                          min="1"
                          value={f().maxSteps}
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

            <Section
              title="后端"
              desc="角色跑在哪里。内置 = 本进程的 agent；外部 CLI 跑在本机另一个进程里，凭证和沙箱是另一套。"
              actions={
                <button
                  class="btn-ghost sm"
                  type="button"
                  onClick={() => {
                    setRoleForm(null)
                    setError(null)
                    setBackendForm(emptyBackend())
                  }}
                >
                  添加
                </button>
              }
            >
              <Show
                when={t().backends.length > 0}
                fallback={<EmptyBox label="还没有后端，新建第一个角色时会自动建一个内置的" />}
              >
                <div class="entry-list">
                  <For each={t().backends}>
                    {(id) => (
                      <EntryCard
                        name={id}
                        desc={backendDetail(id)}
                        badge={
                          <span class="entry-tag">
                            {config()?.backends?.[id]?.kind === 'builtin' ? '内置模型' : '外部 CLI'}
                          </span>
                        }
                        actions={
                          <>
                            <button
                              class="icon-btn"
                              type="button"
                              aria-label={`编辑后端 ${id}`}
                              data-tip="编辑"
                              onClick={() => openBackend(id)}
                            >
                              <IconPencil size={13} />
                            </button>
                            <button
                              class="icon-btn"
                              type="button"
                              aria-label={`删除后端 ${id}`}
                              data-tip="删除"
                              disabled={busy()}
                              onClick={() =>
                                void writeConfig((cfg) => {
                                  // 还有人用就不许删：删了那些角色会被加载器整条丢掉，
                                  // 表现是「角色凭空少了几个」，而用户以为自己只删了一个后端。
                                  const used = (cfg.roles ?? []).filter((r) => r.backend === id)
                                  if (used.length) {
                                    return `还有 ${used.length} 个角色在用它，先改掉那些角色的后端`
                                  }
                                  delete (cfg.backends ?? {})[id]
                                  if (backendForm()?.id === id) setBackendForm(null)
                                  return null
                                })
                              }
                            >
                              <IconX size={13} />
                            </button>
                          </>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={backendForm()}>
              {(f) => (
                <Section title={f().isNew ? '添加后端' : `编辑 ${f().id}`}>
                  <div class="setting-rows">
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">标识</span>
                        <span class="setting-row-hint">角色按它引用这个后端</span>
                      </div>
                      <input
                        type="text"
                        value={f().id}
                        disabled={!f().isNew}
                        placeholder="如 codex"
                        onInput={(e) => setBackendForm({ ...f(), id: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row">
                      <div class="setting-row-text">
                        <span class="setting-row-label">类型</span>
                      </div>
                      <div class="setting-row-control">
                        <select
                          value={f().kind}
                          onChange={(e) =>
                            setBackendForm({
                              ...f(),
                              kind: e.currentTarget.value === 'builtin' ? 'builtin' : 'cli',
                            })
                          }
                        >
                          <option value="builtin">内置模型</option>
                          <option value="cli">外部 CLI</option>
                        </select>
                      </div>
                    </div>

                    <Show when={f().kind === 'builtin'}>
                      <div class="setting-row stack">
                        <div class="setting-row-text">
                          <span class="setting-row-label">接口</span>
                          <span class="setting-row-hint">留空用当前生效的那个</span>
                        </div>
                        <input
                          type="text"
                          value={f().provider}
                          onInput={(e) =>
                            setBackendForm({ ...f(), provider: e.currentTarget.value })
                          }
                        />
                      </div>
                      <div class="setting-row stack">
                        <div class="setting-row-text">
                          <span class="setting-row-label">模型</span>
                          <span class="setting-row-hint">留空用当前生效的那个</span>
                        </div>
                        <input
                          type="text"
                          value={f().model}
                          onInput={(e) => setBackendForm({ ...f(), model: e.currentTarget.value })}
                        />
                      </div>
                    </Show>

                    <Show when={f().kind === 'cli'}>
                      <div class="setting-row stack">
                        <div class="setting-row-text">
                          <span class="setting-row-label">命令</span>
                        </div>
                        <input
                          type="text"
                          value={f().command}
                          placeholder="可执行文件名或路径"
                          onInput={(e) =>
                            setBackendForm({ ...f(), command: e.currentTarget.value })
                          }
                        />
                      </div>
                      <div class="setting-row stack">
                        <div class="setting-row-text">
                          <span class="setting-row-label">参数</span>
                          <span class="setting-row-hint">
                            一行一个，<code>{'{prompt}'}</code> 会被替换成任务描述
                          </span>
                        </div>
                        <textarea
                          class="code-area"
                          rows={4}
                          value={f().args}
                          onInput={(e) => setBackendForm({ ...f(), args: e.currentTarget.value })}
                        />
                      </div>
                      <div class="setting-row">
                        <div class="setting-row-text">
                          <span class="setting-row-label">输出</span>
                        </div>
                        <div class="setting-row-control">
                          <select
                            value={f().output}
                            onChange={(e) =>
                              setBackendForm({
                                ...f(),
                                output: e.currentTarget.value === 'jsonl' ? 'jsonl' : 'text',
                              })
                            }
                          >
                            <option value="text">整段 stdout</option>
                            <option value="jsonl">逐行 JSON</option>
                          </select>
                        </div>
                      </div>
                      <Show when={f().output === 'jsonl'}>
                        <div class="setting-row stack">
                          <div class="setting-row-text">
                            <span class="setting-row-label">取哪个字段</span>
                            <span class="setting-row-hint">取它最后一个非空值</span>
                          </div>
                          <input
                            type="text"
                            value={f().resultField}
                            placeholder="如 result"
                            onInput={(e) =>
                              setBackendForm({ ...f(), resultField: e.currentTarget.value })
                            }
                          />
                        </div>
                      </Show>
                    </Show>
                  </div>
                  <div class="row-actions">
                    <button
                      class="btn-primary"
                      type="button"
                      disabled={busy() || !f().id.trim()}
                      onClick={() => saveBackend(f())}
                    >
                      保存
                    </button>
                    <button class="btn-ghost" type="button" onClick={() => setBackendForm(null)}>
                      取消
                    </button>
                    <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
                  </div>
                </Section>
              )}
            </Show>

            <Show when={t().plan.length > 0}>
              <Section title="编排" desc="节点按依赖跑。没有编排图时单角色直跑第一个角色。">
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

            {/* 原文折起来。它是**兜底不是主路**：编排图这类只有 JSON 表达得了，
                但上面的表单已经覆盖了日常要改的那两样，摊开摆着只会让这一页
                看起来仍然只能手写配置。 */}
            <Section>
              <button class="disclosure" type="button" onClick={() => setShowRaw(!showRaw())}>
                {showRaw() ? '收起 team.json' : '直接改 team.json'}
              </button>
              <Show when={showRaw()}>
                <Show
                  when={loaded(file)}
                  fallback={<LoadState error={file.error} onRetry={() => void refetchRaw()} />}
                >
                  {(fl) => (
                    <>
                      <PathLine path={fl().path} />
                      <textarea
                        class="code-area"
                        rows={14}
                        spellcheck={false}
                        value={text()}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onBlur={() => void commitRaw()}
                      />
                    </>
                  )}
                </Show>
              </Show>
            </Section>

            {/* 表单没开着时报错也要有地方落——删一条后端被拒的话，
                否则那句话跟着表单一起消失了。

                **`error()` 必须排在这串 `&&` 的最后。** `Show` 把 `when` 的求值
                结果原样交给子函数，写成 `error() && !roleForm()` 时那个结果是
                布尔 `true`，渲染出来是一个空的红框——报错框在，字没了。 */}
            <Show when={!roleForm() && !backendForm() && error()}>
              {(e) => <p class="settings-notices bad">{e()}</p>}
            </Show>
          </>
        )}
      </Show>
    </>
  )
}
