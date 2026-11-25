import type { SupportAttachment, SupportMessage } from '@qywork/core'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { touchPrimary } from '../../lib/long-press.ts'
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
import { IconFile, IconHeadset, IconPlus, IconSend, IconX } from '../Icons.tsx'
import { LoadState } from '../settings/LoadState.tsx'
import { AccountAvatar } from './Avatar.tsx'

/** 内联显示缩略图的图片类型，与云端内联返回的类型相同；其余附件显示文件名与大小。 */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** 输入框自动增高的上限（像素），与会话输入框相同；超过后在框内滚动。 */
const INPUT_MAX = 200

/** 自己的头像：已设置时显示图片，否则显示 `label` 的首字符（同 `AccountAvatar`）。 */
export interface SupportSelf {
  label: string
  avatar: string | null
}

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

/** 一条消息：头像与气泡。客服的回复以耳机图标为头像。点击附件（图片或文件）下载原文件，由 `onDownload` 执行。 */
function SupportBubble(props: {
  message: SupportMessage
  self: SupportSelf
  onDownload: (a: SupportAttachment) => void
}) {
  return (
    <div class="support-msg" classList={{ mine: !props.message.fromAdmin }}>
      <Show
        when={props.message.fromAdmin}
        fallback={<AccountAvatar label={props.self.label} avatar={props.self.avatar} />}
      >
        <span class="account-avatar support-agent" aria-hidden="true">
          <IconHeadset size={16} />
        </span>
      </Show>
      <div class="support-body">
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
    </div>
  )
}

/**
 * 「联系客服」窗口，打开在账号窗口之上：上方是对话，下方是会话输入框的同一组件样式（`.composer`）。
 * 窗口尺寸固定（B9），对话贴近输入框排列并在窗口内滚动；待发送的附件在输入框内部，输入框向上增高，工具栏不移动。
 * 附件可粘贴截图、拖入或点「+」选择。
 */
export default function SupportDialog(props: { self: SupportSelf }) {
  let dialog!: HTMLDialogElement
  let list!: HTMLDivElement
  let picker!: HTMLInputElement
  let input!: HTMLTextAreaElement
  const [text, setText] = createSignal('')
  const [files, setFiles] = createSignal<File[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [failure, setFailure] = createSignal<unknown>(null)
  /** 待发送图片的预览地址，窗口关闭时撤销。 */
  const previews = new Map<File, string>()
  const preview = (f: File): string => {
    let url = previews.get(f)
    if (!url) {
      url = URL.createObjectURL(f)
      previews.set(f, url)
    }
    return url
  }

  const load = async () => {
    try {
      await loadSupport()
      setFailure(null)
    } catch (e) {
      setFailure(e)
    }
  }

  /** 对话是否停在末尾，由滚动事件更新。 */
  let atEnd = true
  onMount(() => {
    dialog.showModal()
    void load()
    // 输入框增高（附件、多行文字）使对话区变矮时，停在末尾的对话继续显示最后一条，不被输入框遮住。
    const observer = new ResizeObserver(() => {
      if (atEnd) list.scrollTop = list.scrollHeight
    })
    observer.observe(list)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(() => {
    closeSupport()
    dialog.close()
    for (const url of previews.values()) URL.revokeObjectURL(url)
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

  const autosize = () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX)}px`
  }

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
      autosize()
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
      <div
        class="support-list"
        ref={list}
        onScroll={() => {
          atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 2
        }}
      >
        <Show when={failure() || supportMessages() === null}>
          <LoadState error={failure()} onRetry={() => void load()} lines={3} />
        </Show>
        <For each={supportMessages() ?? []}>
          {(m) => (
            <SupportBubble
              message={m}
              self={props.self}
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
        class="composer support-compose"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div class="composer-body">
          <Show when={files().length > 0}>
            <div class="attach-row pending">
              <For each={files()}>
                {(f, i) => {
                  const remove = () => setFiles((all) => all.filter((_, j) => j !== i()))
                  return (
                    <Show
                      when={IMAGE_TYPES.has(f.type)}
                      fallback={
                        <span class="attach-chip file">
                          <span class="attach-thumb" style={{ width: '20px', height: '20px' }}>
                            <IconFile size={12} />
                          </span>
                          <span class="truncate">{f.name}</span>
                          <button
                            class="attach-x"
                            type="button"
                            aria-label={`移除 ${f.name}`}
                            onClick={remove}
                          >
                            <IconX size={11} />
                          </button>
                        </span>
                      }
                    >
                      <span class="attach-image">
                        <span class="attach-thumb" style={{ width: '72px', height: '72px' }}>
                          <img src={preview(f)} alt={f.name} />
                        </span>
                        <button
                          class="attach-image-x"
                          type="button"
                          aria-label={`移除 ${f.name}`}
                          onClick={remove}
                        >
                          <IconX size={10} />
                        </button>
                      </span>
                    </Show>
                  )
                }}
              </For>
            </div>
          </Show>
          <textarea
            ref={input}
            class="composer-input"
            rows={1}
            aria-label="消息"
            placeholder="描述问题，可粘贴截图"
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value)
              autosize()
            }}
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
            // 触屏上回车换行，经发送按钮发送：手机键盘没有 Shift，回车发送时无法输入换行。与会话输入框相同。
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touchPrimary()) {
                e.preventDefault()
                void submit()
              }
            }}
          />
          <div class="composer-bar">
            <button
              type="button"
              class="icon-btn"
              aria-label="添加附件"
              data-tip="添加附件，也可直接粘贴或拖入"
              onClick={() => picker.click()}
            >
              <IconPlus size={16} />
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
        </div>
      </form>
    </dialog>
  )
}
