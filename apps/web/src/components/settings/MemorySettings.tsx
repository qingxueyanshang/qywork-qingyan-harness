import { createResource, createSignal, For, Show } from 'solid-js'
import {
  deleteMemory,
  loadMemory,
  loadMemoryEntry,
  type Scope,
  saveMemory,
} from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { LoadState } from './LoadState.tsx'
import { ScopeBar, ScopeTag } from './ScopeBar.tsx'

/**
 * 记忆。
 *
 * ## 列表是合并后的那一份
 *
 * 三层合起来、同 key 去重之后才是模型真正看到的索引，所以这里列的就是它。
 * 按层分组会给出一个模型从来不曾看到的视图——「界面上有两条 style，模型只认一条」
 * 是最难查的那类不一致。每条自己标一个层就够了。
 *
 * ## 编辑器拉的是全文
 *
 * 列表接口只回首行摘要。拿摘要填编辑框的话，用户不改任何字点一下保存，
 * 正文就被截成一行——静默、不可恢复。
 */
export default function MemorySettings() {
  const [mem, { refetch }] = createResource(loadMemory)
  const [editing, setEditing] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal('')
  /** 编辑已有条目时是它自己那一层；新建时由上面的选择条决定。 */
  const [scope, setScope] = createSignal<Scope>('user')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

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
    setEditing(key)
    setScope(from)
    setDraft('')
    void loadMemoryEntry(key)
      .then((full) => {
        // 拉回来时用户可能已经切去编辑别的了，别把他正在打的字盖掉。
        if (editing() === key) setDraft(full.content)
      })
      .catch(() => setEditing(null))
  }

  return (
    <Show when={mem()} fallback={<LoadState error={mem.error} onRetry={() => void refetch()} />}>
      {(m) => (
        <>
          <section class="settings-block">
            <div class="settings-block-head">
              <h3>已有 {m().entries.length} 条</h3>
            </div>
            <Show when={m().entries.length > 0}>
              <ul class="mem-list">
                <For each={m().entries}>
                  {(e) => (
                    <li class="mem-item">
                      <button class="mem-open" type="button" onClick={() => open(e.key, e.scope)}>
                        <code class="mem-key">{e.key}</code>
                        <span class="mem-preview truncate">{e.preview}</span>
                      </button>
                      <ScopeTag scope={e.scope} />
                      {/* 内置层只读：它随程序发布，删了下次升级又回来。 */}
                      <Show when={e.scope !== 'builtin'}>
                        <button
                          class="icon-btn"
                          type="button"
                          aria-label={`删除记忆 ${e.key}`}
                          onClick={() =>
                            void run(async () => {
                              await deleteMemory(e.key, e.scope)
                              await refetch()
                            })
                          }
                        >
                          <IconX size={13} />
                        </button>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>

          <section class="settings-block">
            <Show
              when={editing() !== null}
              fallback={
                <button
                  class="btn-ghost"
                  type="button"
                  onClick={() => {
                    setEditing('')
                    setDraft('')
                    setScope('user')
                  }}
                >
                  新增记忆
                </button>
              }
            >
              {/* 层只在新建时能选：改一条已有的记忆时换层等于「移到另一层」，
                  那是两次操作（新建 + 删除），装成一个下拉会让人以为原来那条也没了。 */}
              <Show when={editing() === ''} fallback={<ScopeTag scope={scope()} />}>
                <ScopeBar value={scope()} onChange={setScope} dirs={m().dirs} />
              </Show>

              <div class="setting-rows">
                <div class="setting-row stack">
                  <div class="setting-row-text">
                    <span class="setting-row-label">标识</span>
                  </div>
                  <input
                    type="text"
                    value={editing() ?? ''}
                    disabled={editing() !== ''}
                    placeholder="如 build-commands"
                    onInput={(e) => setEditing(e.currentTarget.value)}
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
                    onInput={(e) => setDraft(e.currentTarget.value)}
                  />
                </div>
              </div>

              {/* 这一格保留显式保存：正文是自由文本，逐 blur 提交会把写到一半的
                  内容当成最终值发出去，而记忆是整条覆盖的。 */}
              <div class="row-actions">
                <button
                  class="btn-primary"
                  type="button"
                  disabled={busy() || !editing()?.trim() || !draft().trim()}
                  onClick={() =>
                    void run(async () => {
                      await saveMemory(editing()!, draft(), scope())
                      setEditing(null)
                      setDraft('')
                      await refetch()
                    })
                  }
                >
                  保存
                </button>
                <button
                  class="btn-ghost"
                  type="button"
                  onClick={() => {
                    setEditing(null)
                    setDraft('')
                  }}
                >
                  取消
                </button>
                <Show when={error()}>{(e) => <span class="save-msg bad">{e()}</span>}</Show>
              </div>
            </Show>
          </section>
        </>
      )}
    </Show>
  )
}
