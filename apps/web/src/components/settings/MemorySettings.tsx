import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import {
  deleteMemory,
  loadMemory,
  loadMemoryEntry,
  type Scope,
  saveMemory,
} from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { EmptyBox, EntryCard, PageHead, Section } from './Page.tsx'
import { ScopeTabs, ShadowTag } from './Scope.tsx'

/**
 * 记忆。
 *
 * ## 按层分列
 *
 * 「这条是跟着这个仓库走的，还是我到处都带着的」是用户在这一页要回答的第一个问题，
 * 合并去重之后这个事实就没了。所以标签页选层，列表只列那一层的。
 *
 * 被高优先级层盖住的那些**照样列在自己那一层里**，贴一个 `ShadowTag`——
 * 不列的话「我在全局改了怎么没生效」查不出来；不贴标记的话界面等于宣称
 * 一条不生效的内容在生效。
 *
 * ## 编辑器拉的是全文，而且是这一层的全文
 *
 * 列表接口只回首行摘要。拿摘要填编辑框的话，用户不改任何字点一下保存，
 * 正文就被截成一行——静默、不可恢复。读单条**必须带层**：同一个 key 在两层里
 * 各有一份，拿错层等于把项目层的正文存进全局。
 *
 * ## 已有的失焦即存，新建要一次显式提交
 *
 * 改一条已有记忆和改「工作区之外额外可读写的目录」是同一个形状，没有理由两样。
 * 新建不同：它建的是一个还不存在的条目，标识敲到一半就落盘会在库里留下一串
 * 半截的键，所以那一次保留一颗「创建」。
 */
export default function MemorySettings() {
  const [mem, { refetch }] = createResource(loadMemory)
  /**
   * 正在编辑哪一条。`isNew` **不能从 key 是不是空串推出来**——用户敲下第一个字
   * key 就非空了，靠它判断的话标识框会在打第二个字之前自己变成只读。
   */
  const [editing, setEditing] = createSignal<{ key: string; isNew: boolean } | null>(null)
  const [draft, setDraft] = createSignal('')
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

  const open = (key: string, from: Scope) => {
    setEditing({ key, isNew: false })
    setDraft('')
    void loadMemoryEntry(key, from)
      .then((full) => {
        // 拉回来时用户可能已经切去编辑别的了，别把他正在打的字盖掉。
        if (editing()?.key === key) setDraft(full.content)
      })
      .catch(() => setEditing(null))
  }

  /** 已有条目失焦即存。正文空着不发——那是一次误清空，不是一条空记忆。 */
  const commit = () => {
    const e = editing()
    if (!e || e.isNew || !draft().trim()) return
    void run(async () => {
      await saveMemory(e.key, draft(), scope())
      await refetch()
    })
  }

  const startNew = () => {
    setEditing({ key: '', isNew: true })
    setDraft('')
  }

  // `loaded()` 而不是 `mem()`：重取期间留住上一份（存一条、删一条之后都要重取，
  // 正在编辑的输入框不该被摘出 DOM），出错时给 undefined 让下面那条 `LoadState` 接住。
  return (
    <>
      {/* 页头在 `Show` 外面：读取中和读取失败时这一页也该有名字。
          它不依赖任何取回来的数据，摆进去只会让失败态变成一块无名的空白。 */}
      <PageHead
        title="记忆"
        desc="记忆索引每轮都发给模型，正文由它按需读取。"
        actions={
          <button class="btn-ghost sm" type="button" onClick={startNew}>
            新增
          </button>
        }
      />
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
                // 切层等于换一批文件，正在编辑的那条不属于新的这一层。
                setEditing(null)
                setDraft('')
                setError(null)
              }}
              dirs={m().dirs}
            />

            <Section>
              <Show when={rows().length > 0} fallback={<EmptyBox label="这一层还没有记忆" />}>
                <div class="entry-list">
                  <For each={rows()}>
                    {(e) => (
                      <EntryCard
                        name={e.key}
                        desc={e.preview}
                        onOpen={() => open(e.key, e.scope)}
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
                                if (editing()?.key === e.key) setEditing(null)
                                await refetch()
                              })
                            }
                          >
                            <IconX size={13} />
                          </button>
                        }
                      />
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={editing()}>
              {(e) => (
                <Section title={e().isNew ? '新增记忆' : `编辑 ${e().key}`}>
                  <div class="setting-rows">
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">标识</span>
                      </div>
                      {/* 标识只在新建时可改：改一条已有记忆的键等于换一条记忆，
                        那是新建 + 删除两次操作。 */}
                      <input
                        type="text"
                        value={e().key}
                        disabled={!e().isNew}
                        placeholder="如 build-commands"
                        onInput={(ev) => setEditing({ key: ev.currentTarget.value, isNew: true })}
                      />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">内容</span>
                      </div>
                      <textarea
                        class="code-area"
                        rows={8}
                        value={draft()}
                        onInput={(ev) => setDraft(ev.currentTarget.value)}
                        onBlur={commit}
                      />
                    </div>
                  </div>

                  <div class="row-actions">
                    {/* 只有新建那一次有提交键：它建的是一个还不存在的条目。
                      已有条目在上面的正文框失焦时就已经存了。 */}
                    <Show when={e().isNew}>
                      <button
                        class="btn-primary"
                        type="button"
                        disabled={busy() || !e().key.trim() || !draft().trim()}
                        onClick={() =>
                          void run(async () => {
                            await saveMemory(e().key, draft(), scope())
                            setEditing(null)
                            setDraft('')
                            await refetch()
                          })
                        }
                      >
                        创建
                      </button>
                    </Show>
                    <button
                      class="btn-ghost"
                      type="button"
                      onClick={() => {
                        setEditing(null)
                        setDraft('')
                      }}
                    >
                      {e().isNew ? '取消' : '关闭'}
                    </button>
                    <Show when={error()}>{(msg) => <span class="save-msg bad">{msg()}</span>}</Show>
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
