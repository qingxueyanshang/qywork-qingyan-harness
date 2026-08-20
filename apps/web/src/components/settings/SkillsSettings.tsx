import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  createSkill,
  deleteSkill,
  importSkill,
  isDesktopShell,
  loadSkills,
  pickWorkspace,
  type Scope,
} from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, PageHead, Section } from './Page.tsx'
import { ScopeTabs, ShadowTag } from './Scope.tsx'

/**
 * 技能。
 *
 * ## 能建、能导、能删，不能在这里改正文
 *
 * 一个技能最少就是 `<目录>/SKILL.md`，建一个用一个表单就够。改正文不在这里：
 * 技能目录里可以带脚本和附件，在网页上编辑一个目录需要一整套文件管理器，
 * 那是编辑器该干的事。所以卡片上给出目录名，要改就去那儿改。
 *
 * ## 说明是必填
 *
 * 扫描器对没有 `description` 的目录是**静默跳过**的（那种技能装了也不会被用到）。
 * 表单不拦的话，建完刷新列表里没有，而用户完全无从知道为什么。
 *
 * ## 按层分列
 *
 * 「这个技能是跟着这个仓库走的，还是我到处都带着的」是这一页要回答的第一个问题。
 * 被高优先级层同名盖住的那些照样列在自己那一层里，贴一个 `ShadowTag`。
 */

/** 技能目录的最后一段。删和「去哪儿改」都按它，不是按前置元信息里的 name。 */
function dirName(dir: string): string {
  return dir.split(/[\\/]/).pop() ?? dir
}

interface Draft {
  name: string
  description: string
  body: string
}
const emptyDraft = (): Draft => ({ name: '', description: '', body: '' })

export default function SkillsSettings() {
  const [data, { refetch }] = createResource(loadSkills)
  const [scope, setScope] = createSignal<Scope>('project')
  const [draft, setDraft] = createSignal<Draft | null>(null)
  const [importPath, setImportPath] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [okMsg, setOkMsg] = createSignal<string | null>(null)

  const rows = () => loaded(data)?.skills.filter((s) => s.scope === scope()) ?? []

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    setOkMsg(null)
    try {
      const msg = await fn()
      if (msg) setOkMsg(msg)
      // 建完 / 删完立刻重拉：列表不刷新的话用户会以为没生效，然后再点一次。
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (d: Draft) =>
    void run(async () => {
      const r = await createSkill({ scope: scope(), ...d })
      setDraft(null)
      return `已建好 ${r.name}`
    })

  const doImport = (path: string) =>
    void run(async () => {
      const r = await importSkill(scope(), path)
      setImportPath(null)
      return `已导入 ${r.name}`
    })

  /**
   * 这一段的两个动作。**区头和空态框共用同一份**——两处各写一遍的话迟早只改一处，
   * 而空的时候用户看到的恰恰是空态框里那一份。
   */
  const Actions = () => (
    <>
      <button
        class="btn-ghost sm"
        type="button"
        disabled={busy()}
        onClick={() => {
          setDraft(null)
          setError(null)
          setOkMsg(null)
          setImportPath('')
        }}
      >
        导入
      </button>
      <button
        class="btn-ghost sm"
        type="button"
        disabled={busy()}
        onClick={() => {
          setImportPath(null)
          setError(null)
          setOkMsg(null)
          setDraft(emptyDraft())
        }}
      >
        新建
      </button>
    </>
  )

  /** 桌面外壳才有目录选择器。网页上只能敲路径，所以两条路都留着。 */
  const browse = async () => {
    if (!isDesktopShell()) return
    try {
      const picked = await pickWorkspace()
      if (picked) doImport(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。 */}
      <PageHead title="技能" desc="技能是按需加载的操作步骤：索引每轮都发，正文由模型自己拉。" />
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
                // 切层等于换一批目录，正在填的那个不属于新的这一层。
                setDraft(null)
                setImportPath(null)
                setError(null)
                setOkMsg(null)
              }}
              dirs={d().dirs}
            />

            <Section title="技能" actions={<Actions />}>
              <Show
                when={rows().length > 0}
                fallback={<EmptyBox label="这一层还没有技能" actions={<Actions />} />}
              >
                <div class="entry-list">
                  <For each={rows()}>
                    {(s) => (
                      <EntryCard
                        name={s.name}
                        desc={s.description}
                        badge={<Show when={s.shadowedBy}>{(by) => <ShadowTag by={by()} />}</Show>}
                        actions={
                          <button
                            class="icon-btn"
                            type="button"
                            aria-label={`删除技能 ${s.name}`}
                            data-tip="删除"
                            disabled={busy()}
                            onClick={() =>
                              void run(async () => {
                                await deleteSkill(dirName(s.dir), s.scope)
                                return null
                              })
                            }
                          >
                            <IconX size={13} />
                          </button>
                        }
                      >
                        {/* 目录名和技能名多数时候是同一个（`name` 取自前置元信息，
                            缺省回落成目录名）。只在两者不同时才显示——一样时它是把
                            同一个词写两遍。整条绝对路径不进卡：这一层的目录已经写在
                            标签页那一行了。 */}
                        <Show when={dirName(s.dir) !== s.name}>
                          <div class="entry-extra">
                            目录 <code>{dirName(s.dir)}</code>
                          </div>
                        </Show>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={draft()}>
              {(f) => (
                <Section title="新建技能">
                  <div class="setting-rows">
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">名称</span>
                        <span class="setting-row-hint">模型在索引里看到的就是它</span>
                      </div>
                      <input
                        type="text"
                        value={f().name}
                        placeholder="如 发版流程"
                        onInput={(e) => setDraft({ ...f(), name: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">说明</span>
                        {/* 这不是解释是边界：缺了它扫描器直接跳过这个目录。 */}
                        <span class="setting-row-hint">
                          模型靠它判断什么时候用这个技能，缺了等于装了也不会被用到
                        </span>
                      </div>
                      <input
                        type="text"
                        value={f().description}
                        placeholder="改 VERSION、跑 sync-version、打 tag。"
                        onInput={(e) => setDraft({ ...f(), description: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">正文</span>
                        <span class="setting-row-hint">操作步骤，模型读到这个技能时看的就是它</span>
                      </div>
                      <textarea
                        class="code-area"
                        rows={10}
                        value={f().body}
                        onInput={(e) => setDraft({ ...f(), body: e.currentTarget.value })}
                      />
                    </div>
                  </div>
                  <div class="row-actions">
                    <button
                      class="btn-primary"
                      type="button"
                      disabled={busy() || !f().name.trim() || !f().description.trim()}
                      onClick={() => submit(f())}
                    >
                      创建
                    </button>
                    <button class="btn-ghost" type="button" onClick={() => setDraft(null)}>
                      取消
                    </button>
                    <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
                  </div>
                </Section>
              )}
            </Show>

            {/* 导入 = 把本机上一个已经存在的目录整个拷进来。
                **刻意不做 `git clone <任意 URL>`**：那等于从网上取一段东西、
                下次加载就用它，和插件那条边界同一个理由。 */}
            <Show when={importPath() !== null}>
              <Section title="导入技能目录">
                <div class="field">
                  <input
                    type="text"
                    placeholder="技能目录的绝对路径"
                    value={importPath() ?? ''}
                    onInput={(e) => setImportPath(e.currentTarget.value)}
                  />
                  <span class="field-hint">
                    目录里要有 <code>SKILL.md</code>；没有会被拒绝，不会拷进去一半。
                  </span>
                </div>
                <div class="row-actions">
                  <Show when={isDesktopShell()}>
                    <button
                      class="btn-ghost"
                      type="button"
                      disabled={busy()}
                      onClick={() => void browse()}
                    >
                      选择目录…
                    </button>
                  </Show>
                  <button
                    class="btn-primary"
                    type="button"
                    disabled={busy() || !(importPath() ?? '').trim()}
                    onClick={() => doImport((importPath() ?? '').trim())}
                  >
                    导入
                  </button>
                  <button class="btn-ghost" type="button" onClick={() => setImportPath(null)}>
                    取消
                  </button>
                  <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
                </div>
              </Section>
            </Show>

            {/* 表单没开着时结果也要有地方落——删一条失败的话，
                否则那句话跟着表单一起消失了。`error()` / `okMsg()` 必须排在
                这串 `&&` 的最后：`Show` 把 `when` 的求值结果原样交给子函数，
                布尔 `true` 渲染出来是一个空框。 */}
            <Show when={!draft() && importPath() === null && error()}>
              {(e) => <p class="settings-notices bad">{e()}</p>}
            </Show>
            <Show when={!draft() && importPath() === null && okMsg()}>
              {(m) => <p class="settings-notices">{m()}</p>}
            </Show>
          </>
        )}
      </Show>
    </>
  )
}
