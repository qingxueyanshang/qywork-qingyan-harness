import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  askInChat,
  deleteSkill,
  importSkill,
  isDesktopShell,
  loadSkills,
  pickWorkspace,
  type Scope,
} from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'
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

/** 「新增」递给模型的话头。不自动发送——用户可以改了再发。 */
const NEW_SKILL =
  '我们一起来做一个技能吧。先说明技能在 qywork 里怎么被索引、什么时候会被加载，目录和 SKILL.md 长什么样；然后问我这个技能要干什么、分几步。'

export default function SkillsSettings() {
  const [data, { refetch }] = createResource(loadSkills)
  const [scope, setScope] = createSignal<Scope>('project')
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

  const doImport = (path: string) =>
    void run(async () => {
      const r = await importSkill(scope(), path)
      return `已导入 ${r.name}`
    })

  /**
   * 这一段的两个动作。**区头和空态框共用同一份**——两处各写一遍的话迟早只改一处，
   * 而空的时候用户看到的恰恰是空态框里那一份。
   */
  const Actions = () => (
    <>
      {/* 导入只有桌面外壳有：网页里没有系统文件选择器，
          留一个点了没反应的按钮比不给更糟（B5）。 */}
      <Show when={isDesktopShell()}>
        <button class="btn-ghost sm" type="button" disabled={busy()} onClick={() => void browse()}>
          导入
        </button>
      </Show>
      <button class="btn-ghost sm" type="button" onClick={() => askInChat(NEW_SKILL)}>
        新增
      </button>
    </>
  )

  /** 选一个本机上已经存在的技能目录，选完就导。 */
  const browse = async () => {
    if (!isDesktopShell()) return
    setError(null)
    setOkMsg(null)
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
                // 切层等于换一批目录，上一层那条结果不属于新的这一层。
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

            {/* 导入和删除的结果都落在这里。**必须排在 `Show` 的 `when` 末位**：
                它把求值结果原样交给子函数，布尔 `true` 渲染出来是一个空框。 */}
            <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
            <Show when={okMsg()}>{(m) => <p class="settings-notices">{m()}</p>}</Show>
          </>
        )}
      </Show>
    </>
  )
}
