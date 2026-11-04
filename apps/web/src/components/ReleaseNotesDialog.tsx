import { createResource, onCleanup, onMount, Show } from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { loaded } from '../lib/resource.ts'
import { holdOverlay } from '../lib/store/index.ts'
import {
  closeReleaseNotes,
  fetchReleaseNotes,
  type ReleaseNotesView,
} from '../lib/store/release-notes.ts'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 本版说明弹窗（`lib/store/release-notes.ts`）。尺寸固定（CLAUDE.md B9），正文在框内滚动。
 * 正文经 `renderMarkdown` 净化后写入；其中的链接由根节点的 `openLink` 在右侧面板打开。
 */
export default function ReleaseNotesDialog(props: { view: ReleaseNotesView }) {
  holdOverlay(() => true)
  let dialog!: HTMLDialogElement
  const [notes, { refetch }] = createResource(
    () => props.view.version,
    (version) => props.view.notes ?? fetchReleaseNotes(version),
  )
  const ready = () => notes.state === 'ready' || notes.state === 'refreshing'

  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())

  return (
    <dialog
      ref={dialog}
      class="release-notes-dialog"
      aria-label="本版说明"
      onCancel={(e) => {
        e.preventDefault()
        closeReleaseNotes()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不把后面的设置窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">{loaded(notes)?.title ?? `qywork ${props.view.version}`}</h2>
      <div class="release-notes-body">
        <Show
          when={ready()}
          fallback={<LoadState error={notes.error} onRetry={refetch} lines={8} />}
        >
          <Show when={loaded(notes)} fallback={<p class="release-notes-empty">暂无说明</p>}>
            {(n) => <div class="markdown" innerHTML={renderMarkdown(n().body)} />}
          </Show>
        </Show>
      </div>
      <div class="confirm-actions">
        <button class="btn-primary" type="button" onClick={closeReleaseNotes}>
          关闭
        </button>
      </div>
    </dialog>
  )
}
