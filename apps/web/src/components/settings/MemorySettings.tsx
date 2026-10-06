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
 * 按层分列。条目属于当前仓库还是全局生效，是用户在本页首先要确认的问题，
 * 合并去重后该信息即丢失。因此由标签页选择层级，列表只列出该层的条目。
 *
 * 被高优先级层覆盖的条目仍列在各自所属的层中，并附加 `ShadowTag`：
 * 不列出时，无法查明全局修改未生效的原因；不附加标记时，界面等于声明
 * 一条未生效的内容正在生效。
 *
 * 可以新建、删除，但不能在本页修改正文。记忆是目录中的文件：修改时直接编辑该文件，或在会话中由模型修改。
 * 页头显示该层的目录，卡片显示键名，两者拼接即为文件路径。
 */
export default function MemorySettings() {
  const [mem, { refetch }] = createResource(loadMemory)
  /** 当前查看的层级。新建的条目也写入该层，因为用户正在查看它。 */
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
   * 本页的操作按钮。路径行与空状态框共用同一份定义：两处分别编写时容易只修改
   * 一处，而列表为空时用户看到的是空状态框中的那一份。
   */
  const Actions = () => (
    <button class="btn-ghost sm" type="button" onClick={() => askInChat(newMemoryPrompt(scope()))}>
      新增
    </button>
  )

  // 使用 `loaded()` 而不是 `mem()`：删除条目后需要重新获取，重新获取期间保留上一份数据，列表不会短暂清空；
  // 出错时返回 undefined，由下方的 `LoadState` 处理。
  return (
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
              fallback={<EmptyBox label="该层没有记忆" actions={<Actions />} />}
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
  )
}
