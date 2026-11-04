import type { ReleaseNotes } from '@qywork/core'
import { onCleanup, onMount } from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { holdOverlay } from '../lib/store/index.ts'
import { closeReleaseNotes } from '../lib/store/release-notes.ts'

/**
 * 本版说明弹窗（`lib/store/release-notes.ts`）。尺寸固定（CLAUDE.md B9），正文在框内滚动。
 * 正文经 `renderMarkdown` 净化后写入；其中的链接由根节点的 `openLink` 在右侧面板打开。
 */
export default function ReleaseNotesDialog(props: { notes: ReleaseNotes }) {
  holdOverlay(() => true)
  let dialog!: HTMLDialogElement

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
        // Escape 只关闭本窗口，不把后面打开的窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">{props.notes.title}</h2>
      <div class="release-notes-body">
        <div class="markdown" innerHTML={renderMarkdown(props.notes.body)} />
      </div>
      <div class="confirm-actions">
        <button class="btn-primary" type="button" onClick={closeReleaseNotes}>
          关闭
        </button>
      </div>
    </dialog>
  )
}
