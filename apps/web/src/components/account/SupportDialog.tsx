import type { SupportAttachment, SupportMessage } from '@qywork/core'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'
import {
  closeSupport,
  downloadSupportFile,
  loadSupport,
  SUPPORT_BYTES_MAX,
  SUPPORT_FILES_MAX,
  sendSupport,
  supportFileUrl,
  supportMessages,
} from '../../lib/store/support.ts'
import { IconFilePlus, IconSend, IconX } from '../Icons.tsx'
import { LoadState } from '../settings/LoadState.tsx'

/** 内联显示缩略图的图片类型，与云端内联返回的类型相同；其余附件显示文件名与大小。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 消息的时间：当天只显示时刻，否则带日期。 */
function timeText(iso: string): string {
  const at = new Date(iso)
  const hm = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return at.toDateString() === new Date().toDateString()
    ? hm
    : `${at.getMonth() + 1}月${at.getDate()}日 ${hm}`
}

/** 一条消息。点击附件（图片或文件）下载原文件，由 `onDownload` 执行。 */
function SupportBubble(props: {
  message: SupportMessage
  onDownload: (a: SupportAttachment) => void
}) {
  return (
    <div class="support-msg" classList={{ mine: !props.message.fromAdmin }}>
      <div class="support-bubble">
        <Show when={props.message.body}>
          <p class="support-text">{props.message.body}</p>
        </Show>
        <For each={props.message.attachments}>
          {(a) =>
            IMAGE_TYPES.has(a.mime) ? (
              <button type="button" class="support-image" onClick={() => props.onDownload(a)}>
                <img src={supportFileUrl(a.id)} alt={a.name} />
              </button>
            ) : (
              <button type="button" class="support-file" onClick={() => props.onDownload(a)}>
                <span class="support-file-name">{a.name}</span>
                <span class="support-file-size">{sizeText(a.size)}</span>
              </button>
            )
          }
        </For>
      </div>
      <time class="support-time" dateTime={props.message.createdAt}>
        {timeText(props.message.createdAt)}
      </time>
    </div>
  )
}

/**
 * 「联系客服」窗口，打开在账号窗口之上：上方是对话，下方是待发送的附件与输入框。尺寸固定（B9），对话在窗口内滚动；
 * 附件条固定高度，添加附件时输入框与按钮不移动。附件可粘贴截图、拖入或点按钮选择。
 */
export default function SupportDialog() {
  let dialog!: HTMLDialogElement
  let list!: HTMLDivElement
  let picker!: HTMLInputElement
  const [text, setText] = createSignal('')
  const [files, setFiles] = createSignal<File[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [failure, setFailure] = createSignal<unknown>(null)

  const load = async () => {
    try {
      await loadSupport()
      setFailure(null)
    } catch (e) {
      setFailure(e)
    }
  }

  onMount(() => {
    dialog.showModal()
    void load()
  })
  onCleanup(() => {
    closeSupport()
    dialog.close()
  })

  // 对话有新消息时滚动到末尾。
  createEffect(
    on(
      () => supportMessages()?.length,
      () => {
        list.scrollTop = list.scrollHeight
      },
    ),
  )

  const add = (picked: readonly File[]) => {
    if (!picked.length) return
    const next = [...files(), ...picked]
    if (next.length > SUPPORT_FILES_MAX) {
      setError(`附件不能超过 ${SUPPORT_FILES_MAX} 个`)
      return
    }
    if (next.reduce((n, f) => n + f.size, 0) > SUPPORT_BYTES_MAX) {
      setError(`附件合计不能超过 ${SUPPORT_BYTES_MAX / 1024 / 1024} MB`)
      return
    }
    setError(null)
    setFiles(next)
  }

  const ready = () => !busy() && (text().trim() !== '' || files().length > 0)

  const submit = async () => {
    if (!ready()) return
    setBusy(true)
    setError(null)
    try {
      await sendSupport(text().trim(), files())
      setText('')
      setFiles([])
    } catch (e) {
      setError(explainApiError(e, '发送失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      class="support-dialog"
      aria-label="联系客服"
      onCancel={(e) => {
        e.preventDefault()
        closeSupport()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不关闭下层的账号窗口。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <header class="support-head">
        <h2 class="support-title">联系客服</h2>
        <button
          class="icon-btn support-close"
          type="button"
          aria-label="关闭"
          onClick={closeSupport}
        >
          <IconX size={15} />
        </button>
      </header>
      <div class="support-list" ref={list}>
        <Show when={failure() || supportMessages() === null}>
          <LoadState error={failure()} onRetry={() => void load()} lines={3} />
        </Show>
        <For each={supportMessages() ?? []}>
          {(m) => (
            <SupportBubble
              message={m}
              onDownload={(a) =>
                void downloadSupportFile(a).catch((e) =>
                  setError(explainApiError(e, '无法下载附件')),
                )
              }
            />
          )}
        </For>
      </div>
      <form
        class="support-compose"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div class="support-pending">
          <For each={files()}>
            {(f, i) => (
              <span class="support-chip">
                <span class="support-chip-name">{f.name}</span>
                <button
                  type="button"
                  class="support-chip-remove"
                  aria-label={`移除 ${f.name}`}
                  onClick={() => setFiles((all) => all.filter((_, j) => j !== i()))}
                >
                  <IconX size={11} />
                </button>
              </span>
            )}
          </For>
        </div>
        <textarea
          class="support-input"
          aria-label="消息"
          placeholder="描述问题，可粘贴截图"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData?.files ?? [])
            // 仅在包含文件时拦截：拦截纯文本粘贴会导致无法粘贴文字。
            if (pasted.length) {
              e.preventDefault()
              add(pasted)
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const dropped = Array.from(e.dataTransfer?.files ?? [])
            if (dropped.length) {
              e.preventDefault()
              add(dropped)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div class="support-actions">
          <button
            type="button"
            class="icon-btn"
            aria-label="添加附件"
            data-tip="添加附件"
            onClick={() => picker.click()}
          >
            <IconFilePlus size={16} stroke={1.8} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(Array.from(e.currentTarget.files ?? []))
              e.currentTarget.value = ''
            }}
          />
          <output class="support-error">{error() ?? ''}</output>
          <button class="send-btn" type="submit" disabled={!ready()} aria-label="发送">
            <IconSend size={16} />
          </button>
        </div>
      </form>
    </dialog>
  )
}
