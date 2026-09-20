import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { askInChat, deleteMemory, loadMemory, type Scope } from '../../lib/store/index.ts'
import { IconTrash } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './Page.tsx'
import { ScopeTabs, ShadowTag } from './Scope.tsx'
import { newMemoryPrompt } from './ScopePrompts.ts'

/**
 * 记忆。
 *
 * **按层分列。** 「这条是跟着这个仓库走的，还是全局都生效的」是用户在这一页要回答的第一个问题，
 * 合并去重之后这个事实就没了。所以标签页选层，列表只列那一层的。
 *
 * 被高优先级层盖住的那些**照样列在自己那一层里**，贴一个 `ShadowTag`——
 * 不列的话「在全局改了却没生效」查不出来；不贴标记的话界面等于宣称
 * 一条不生效的内容在生效。
 *
 * **能建、能删，不能在这里改正文。** 记忆是目录里的文件：要改就改那个文件，或在会话里让模型改。
 * 页头给出这一层的目录，卡片给出键名，两者拼起来就是那个文件。
 */
export default function MemorySettings() {
  const [mem, { refetch }] = createResource(loadMemory)
  /** 看的是哪一层。新建也落在这一层——用户正看着它。 */
  const [scope, setScope] = createSignal<Scope>('project')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const rows = () => loaded(mem)?.entries.filter((e) => e.scope === scope()) ?? []

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 这一页的动作。**路径那一行和空态框共用同一份**——两处各写一遍的话迟早只改
   * 一处，而空的时候用户看到的是空态框里那一份。
   */
  const Actions = () => (
    <button class="btn-ghost sm" type="button" onClick={() => askInChat(newMemoryPrompt(scope()))}>
      新增
    </button>
  )

  // `loaded()` 而不是 `mem()`：删一条之后要重取，重取期间留住上一份，列表不闪空；
  // 出错时给 undefined 让下面那条 `LoadState` 接住。
  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。
          它不依赖任何取回来的数据，摆进去只会让失败态变成一块无名的空白。 */}
      <Show
        when={loaded(mem)}
        fallback={<LoadState error={mem.error} onRetry={() => void refetch()} />}
      >
        {(m) => (
          <>
            <ScopeTabs
              value={scope()}
              onChange={(s) => {
                setScope(s)
                setError(null)
              }}
              dirs={m().dirs}
              actions={<Actions />}
            />

            <Section>
              <Show
                when={rows().length > 0}
                fallback={<EmptyBox label="这一层还没有记忆" actions={<Actions />} />}
              >
                <div class="entry-list">
                  <For each={rows()}>
                    {(e) => (
                      <EntryCard
                        name={e.key}
                        desc={e.preview}
                        badge={<Show when={e.shadowedBy}>{(by) => <ShadowTag by={by()} />}</Show>}
                        actions={
                          <button
                            class="icon-btn"
                            type="button"
                            aria-label={`删除记忆 ${e.key}`}
                            data-tip="删除"
                            disabled={busy()}
                            onClick={() =>
                              void run(async () => {
                                await deleteMemory(e.key, e.scope)
                                await refetch()
                              })
                            }
                          >
                            <IconTrash size={13} />
                          </button>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={error()}>{(msg) => <p class="settings-notices bad">{msg()}</p>}</Show>
          </>
        )}
      </Show>
    </>
  )
}
