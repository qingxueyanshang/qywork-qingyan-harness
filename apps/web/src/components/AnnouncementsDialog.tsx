import type { Announcement } from '@qywork/core'
import { For, onCleanup, onMount } from 'solid-js'
import { renderMarkdown } from '../lib/markdown.ts'
import { announcements, closeAnnouncements } from '../lib/store/announcements.ts'
import { holdOverlay } from '../lib/store/index.ts'

const KIND_NAME: Record<Announcement['kind'], string> = { release: '版本更新', notice: '通知' }

/**
 * 公告窗口（`lib/store/announcements.ts`），内容与官网顶栏的公告相同。尺寸固定（CLAUDE.md B9），列表在框内滚动。
 * 正文经 `renderMarkdown` 净化后写入；其中的链接由根节点的 `openLink` 在右侧面板打开。
 */
export default function AnnouncementsDialog() {
  holdOverlay(() => true)
  let dialog!: HTMLDialogElement

  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())

  return (
    <dialog
      ref={dialog}
      class="announcements-dialog"
      aria-label="公告"
      onCancel={(e) => {
        e.preventDefault()
        closeAnnouncements()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不把后面的窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">公告</h2>
      <div class="announcements-list">
        <For each={announcements()}>
          {(a) => (
            <article class="announcements-item">
              <div class="announcements-meta">
                {KIND_NAME[a.kind]} · {a.publishedAt.slice(0, 10)}
              </div>
              <h3 class="announcements-title">{a.title}</h3>
              <div class="markdown" innerHTML={renderMarkdown(a.body)} />
            </article>
          )}
        </For>
      </div>
      <div class="confirm-actions">
        <button class="btn-primary" type="button" onClick={closeAnnouncements}>
          关闭
        </button>
      </div>
    </dialog>
  )
}
