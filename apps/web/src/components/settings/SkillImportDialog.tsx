import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { listSkillSources, type SkillSourceListing } from '../../lib/store/index.ts'
import { IconChevron, IconFile, IconFolder } from '../Icons.tsx'

/** 文件夹和 ZIP 共用一个选择窗口，不要求用户预选来源类型。 */
export function SkillImportDialog(props: {
  onImport: (path: string) => Promise<void>
  onClose: () => void
}) {
  let dialog!: HTMLDialogElement
  const [listing, setListing] = createSignal<SkillSourceListing>()
  const [address, setAddress] = createSignal('')
  const [selected, setSelected] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let revision = 0

  const browse = async (path?: string) => {
    const request = ++revision
    setLoading(true)
    setSelected(null)
    setError(null)
    try {
      const next = await listSkillSources(path)
      if (request !== revision) return
      setListing(next)
      setAddress(next.path)
      setSelected(next.selected)
    } catch (e) {
      if (request === revision) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (request === revision) setLoading(false)
    }
  }

  const submit = async () => {
    const path = selected()
    if (!path || loading() || busy()) return
    setBusy(true)
    setError(null)
    try {
      await props.onImport(path)
      props.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    dialog.showModal()
    void browse()
  })
  onCleanup(() => {
    revision++
    dialog.close()
  })

  return (
    <dialog
      ref={dialog}
      class="skill-import-dialog"
      aria-label="导入技能"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy()) props.onClose()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本选择器，不把后面的设置窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">导入技能</h2>
      <p class="skill-import-hint">选择文件夹或 ZIP，双击文件夹进入</p>
      <fieldset disabled={busy()} class="skill-import-fields">
        <form
          class="skill-import-location"
          onSubmit={(e) => {
            e.preventDefault()
            void browse(address().trim())
          }}
        >
          <button
            class="icon-btn"
            type="button"
            aria-label="上级目录"
            disabled={!listing()?.parent || loading()}
            onClick={() => void browse(listing()!.parent!)}
          >
            <IconChevron dir="up" size={16} />
          </button>
          <input
            class="np-input"
            aria-label="位置"
            placeholder="输入文件夹或 ZIP 的完整路径"
            value={address()}
            onInput={(e) => setAddress(e.currentTarget.value)}
          />
          <button class="btn-ghost sm" type="submit">
            前往
          </button>
        </form>
        <nav class="skill-import-locations" aria-label="常用位置">
          <For each={listing()?.locations}>
            {(location) => (
              <button class="btn-ghost sm" type="button" onClick={() => void browse(location.path)}>
                {location.name}
              </button>
            )}
          </For>
        </nav>
        <section class="skill-import-list" aria-label="文件夹和 ZIP" aria-busy={loading()}>
          <Show when={!loading()} fallback={<p class="skill-import-hint">读取中…</p>}>
            <Show when={listing()}>
              {(current) => (
                <>
                  <button
                    class="skill-import-entry"
                    classList={{ selected: selected() === current().path }}
                    type="button"
                    aria-pressed={selected() === current().path}
                    onClick={() => setSelected(current().path)}
                  >
                    <IconFolder size={16} />
                    <span>当前文件夹</span>
                  </button>
                  <For each={current().entries}>
                    {(entry) => (
                      <button
                        class="skill-import-entry"
                        classList={{ selected: selected() === entry.path }}
                        type="button"
                        aria-pressed={selected() === entry.path}
                        onClick={() => setSelected(entry.path)}
                        onDblClick={() => entry.directory && void browse(entry.path)}
                        onKeyDown={(e) => {
                          if (entry.directory && e.key === 'ArrowRight') {
                            e.preventDefault()
                            void browse(entry.path)
                          }
                        }}
                      >
                        <Show when={entry.directory} fallback={<IconFile size={16} />}>
                          <IconFolder size={16} />
                        </Show>
                        <span>{entry.name}</span>
                        <Show when={entry.directory}>
                          <IconChevron dir="right" size={14} />
                        </Show>
                      </button>
                    )}
                  </For>
                </>
              )}
            </Show>
          </Show>
        </section>
      </fieldset>
      <p class="skill-import-selection" title={selected() ?? ''}>
        {selected() ?? '尚未选择'}
      </p>
      <Show when={error()}>
        {(message) => (
          <p class="np-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" disabled={busy()} onClick={props.onClose}>
          取消
        </button>
        <button
          class="btn-primary"
          type="button"
          disabled={!selected() || loading() || busy()}
          onClick={() => void submit()}
        >
          {busy() ? '导入中…' : '导入'}
        </button>
      </div>
    </dialog>
  )
}
