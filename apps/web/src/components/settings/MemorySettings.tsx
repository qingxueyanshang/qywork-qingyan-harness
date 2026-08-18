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
    setEditing({ key, isNew: false })
    setScope(from)
    setDraft('')
    void loadMemoryEntry(key)
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

  // `loaded()` 而不是 `mem()`：重取期间留住上一份（存一条、删一条之后都要重取，
  // 正在编辑的输入框不该被摘出 DOM），出错时给 undefined 让下面那条 `LoadState` 接住。
  return (
    <Show
      when={loaded(mem)}
      fallback={<LoadState error={mem.error} onRetry={() => void refetch()} />}
    >
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
                    setEditing({ key: '', isNew: true })
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
              <Show when={editing()?.isNew} fallback={<ScopeTag scope={scope()} />}>
                <ScopeBar value={scope()} onChange={setScope} dirs={m().dirs} />
              </Show>

              <div class="setting-rows">
                <div class="setting-row stack">
                  <div class="setting-row-text">
                    <span class="setting-row-label">标识</span>
                  </div>
                  {/* 标识只在新建时可改：改一条已有记忆的键等于换一条记忆，
                      那是新建 + 删除两次操作。 */}
                  <input
                    type="text"
                    value={editing()?.key ?? ''}
                    disabled={!editing()?.isNew}
                    placeholder="如 build-commands"
                    onInput={(e) => setEditing({ key: e.currentTarget.value, isNew: true })}
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
                    onBlur={commit}
                  />
                </div>
              </div>

              <div class="row-actions">
                {/* 只有新建那一次有提交键：它建的是一个还不存在的条目。
                    已有条目在上面的正文框失焦时就已经存了。 */}
                <Show when={editing()?.isNew}>
                  <button
                    class="btn-primary"
                    type="button"
                    disabled={busy() || !editing()?.key.trim() || !draft().trim()}
                    onClick={() =>
                      void run(async () => {
                        await saveMemory(editing()!.key, draft(), scope())
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
                  {editing()?.isNew ? '取消' : '关闭'}
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
