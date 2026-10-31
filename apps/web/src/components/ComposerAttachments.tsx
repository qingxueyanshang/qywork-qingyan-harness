/** 输入区的附件：取得附件的入口、上传计数、本地缩略图、添加附件按钮与待发送附件行。 */

import type { Attachment } from '@qywork/core'
import { attachmentTypeOf, baseNameOf, isInlineImage, mimeOf, toPosixPath } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import {
  explainApiError,
  isDesktopShell,
  pickFiles,
  setState,
  state,
  uploadAttachment,
} from '../lib/store/index.ts'
import { AttachmentThumb } from './AttachmentThumb.tsx'
import { IconPlus, IconX } from './Icons.tsx'

/** 写入草稿中的待发送附件。省略 `conversationId` 时写入当前会话。 */
export type SetPending = (
  next: Attachment[] | ((current: Attachment[]) => Attachment[]),
  conversationId?: string | null,
) => void

/**
 * 附件的取得与上传状态。按会话记录上传计数；取得的附件经 `setPending` 写入发起时所在会话的草稿。
 * 须在组件内调用：上传计数是该组件实例的信号。
 */
export function createAttachmentIntake(setPending: SetPending) {
  const [uploads, setUploads] = createSignal<Record<string, number>>({})
  const uploading = () => uploads()[state.activeConversation ?? ''] ?? 0
  const changeUploading = (conversationId: string, delta: number) => {
    setUploads((all) => ({ ...all, [conversationId]: (all[conversationId] ?? 0) + delta }))
  }
  /**
   * 粘贴附件的本地预览地址，按落盘路径存储。
   *
   * 只增不减：一次会话中粘贴的图片数量有限，而按 chip 的生命周期撤销会与
   * 「发送后 Transcript 仍需显示」冲突。
   */
  const localThumbs = new Map<string, string>()
  /** 有本地预览时附带该字段，没有时省略整个键：`exactOptionalPropertyTypes` 不接受 undefined。 */
  const thumbProps = (path: string): { localUrl?: string } => {
    const u = localThumbs.get(path)
    return u ? { localUrl: u } : {}
  }

  /**
   * 可取得源路径的入口：桌面端拖入、原生选择器。
   *
   * **纯前端处理，不发送任何请求。** 文件已在磁盘上，没有字节需要传输，
   * 这就是「不二次存储」的全部实现。
   *
   * `size` 填 0：此处无法取得字节数，而该字段没有消费者（约定写在 `Attachment` 上）。
   */
  const takePaths = (paths: string[], conversationId = state.activeConversation) => {
    const next = paths.filter(Boolean).map((raw) => {
      const path = toPosixPath(raw)
      const name = baseNameOf(path)
      return { type: attachmentTypeOf(name), name, mime: mimeOf(name), size: 0, path }
    })
    if (next.length) setPending((prev) => [...prev, ...next], conversationId)
  }

  /**
   * 无法取得源路径的入口：剪贴板中只有位图，或浏览器不提供绝对路径。
   *
   * 这些字节除内存外没有第二份，因此落盘是第一次存储，而不是第二次。
   * 存储位置是 `~/.qywork/attachments/<会话id>/`，删除会话时整个目录一并删除。
   *
   * 失败逐个报告并继续处理其余文件：一张图片过大不应导致另外三张也添加失败。
   */
  const takeFiles = async (files: FileList | File[], conversationId = state.activeConversation) => {
    const list = Array.from(files)
    if (!list.length) return
    // 没有会话就没有归属，与「发送」使用同一判据（`sendMessage` 也在此情况下提前返回）。
    if (!conversationId) return
    changeUploading(conversationId, list.length)
    for (const f of list) {
      try {
        const a = await uploadAttachment(f, conversationId)
        // 粘贴的文件已持有字节，缩略图直接使用它，省去一次读取。
        if (isInlineImage(a.path)) localThumbs.set(a.path, URL.createObjectURL(f))
        setPending((prev) => [...prev, a], conversationId)
      } catch (e) {
        setState('notice', {
          message: `${f.name}：${explainApiError(e, '请求失败')}`,
          reason: 'attachment_upload_failed',
        })
      } finally {
        changeUploading(conversationId, -1)
      }
    }
  }

  return { uploading, thumbProps, takePaths, takeFiles }
}

type AttachmentIntake = ReturnType<typeof createAttachmentIntake>

/** 添加附件按钮与它使用的隐藏文件选择器。 */
export function AttachButton(props: Pick<AttachmentIntake, 'takePaths' | 'takeFiles'>) {
  let filePicker!: HTMLInputElement
  let filePickerConversation: string | null = null

  return (
    <>
      {/* 一个 `+` 按钮接收所有附件，不分图片与文件两个入口：对用户而言
        「把这个文件交给模型查看」是同一件事。

        桌面端使用系统对话框：它返回绝对路径，因此该入口与拖入一样
        不传输字节。`<input type="file">` 无法取得路径，它是浏览器端唯一的入口。 */}
      <input
        ref={filePicker}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const fs = e.currentTarget.files
          if (fs) void props.takeFiles(fs, filePickerConversation)
          // 清空 value：同一个文件连续选择两次也必须能触发 change。
          e.currentTarget.value = ''
        }}
      />
      <button
        class="icon-btn"
        type="button"
        aria-label="添加附件"
        data-tip="添加附件，也可直接粘贴或拖入"
        onClick={() => {
          if (isDesktopShell()) {
            const conversationId = state.activeConversation
            void pickFiles()
              .then((paths) => props.takePaths(paths, conversationId))
              .catch((e: unknown) =>
                setState('notice', {
                  reason: 'attachment_pick_failed',
                  message: `无法选择文件：${explainApiError(e, '请求失败')}`,
                }),
              )
            return
          }
          filePickerConversation = state.activeConversation
          filePicker.click()
        }}
      >
        <IconPlus size={16} />
      </button>
    </>
  )
}

/** 待发送附件行：已取得的附件，以及上传中的数量。 */
export function PendingAttachments(props: {
  pending: Attachment[]
  uploading: number
  thumbProps: AttachmentIntake['thumbProps']
  setPending: SetPending
}) {
  return (
    <Show when={props.pending.length > 0 || props.uploading > 0}>
      <div class="attach-row pending">
        <For each={props.pending}>
          {(a, i) => (
            <Show
              when={isInlineImage(a.path)}
              fallback={
                <span class="attach-chip file" data-tip={a.path}>
                  <AttachmentThumb
                    path={a.path}
                    name={a.name}
                    box={20}
                    {...props.thumbProps(a.path)}
                  />
                  <span class="truncate">{a.name}</span>
                  <button
                    class="attach-x"
                    type="button"
                    aria-label={`移除 ${a.name}`}
                    onClick={() => props.setPending((prev) => prev.filter((_, j) => j !== i()))}
                  >
                    <IconX size={11} />
                  </button>
                </span>
              }
            >
              <span class="attach-image" data-tip={a.path}>
                <AttachmentThumb
                  path={a.path}
                  name={a.name}
                  box={72}
                  {...props.thumbProps(a.path)}
                />
                <button
                  class="attach-image-x"
                  type="button"
                  aria-label={`移除 ${a.name}`}
                  onClick={() => props.setPending((prev) => prev.filter((_, j) => j !== i()))}
                >
                  <IconX size={10} />
                </button>
              </span>
            </Show>
          )}
        </For>
        <Show when={props.uploading > 0}>
          <span class="attach-chip busy">上传中 {props.uploading}</span>
        </Show>
      </div>
    </Show>
  )
}
