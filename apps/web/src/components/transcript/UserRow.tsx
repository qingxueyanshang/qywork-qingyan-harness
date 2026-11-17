import { createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import { fontScale, type TranscriptItem } from '../../lib/store/index.ts'
import { AttachmentThumb } from '../AttachmentThumb.tsx'
import { IconChevron } from '../Icons.tsx'

/** 用户消息行。 */
export function UserRow(props: { id: string; item: TranscriptItem }) {
  // `data-turn` 供会话索引按 id 找到该行。
  return (
    <div class="row user" data-turn={props.id}>
      <div class="user-col">
        {/* 附件位于气泡上方：附件是该消息的上下文，阅读顺序应为先查看附件、再阅读文字。 */}
        <Show when={props.item.attachments?.length}>
          <div class="attach-row sent">
            <For each={props.item.attachments}>
              {(a) => (
                <span class="attach-chip" data-tip={a.path}>
                  <AttachmentThumb path={a.path} name={a.name} box={44} />
                  <span class="truncate">{a.name}</span>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.item.text}>
          <UserBubble text={props.item.text} />
        </Show>
      </div>
    </div>
  )
}

/**
 * 六行用户正文在默认字体大小下的高度：`--fs-prose` 13.5px × 1.55 行高 × 6，取整为 126px。
 * 修改 `.bubble` 的字号或行高时必须同步修改此值。实际高度随字体大小设置按比例变化。
 */
const USER_MESSAGE_PREVIEW_HEIGHT = 126
const userMessagePreviewHeight = () => Math.round(USER_MESSAGE_PREVIEW_HEIGHT * fontScale())

/**
 * 用户消息只在实际渲染高度超过六行时折叠。正文仍是 transcript 的原投影；此处的
 * `expanded` 只决定该气泡的显示高度，不修改消息、不截断文字，也不参与同步或持久化。
 */
function UserBubble(props: { text: string }) {
  let copy!: HTMLDivElement
  const copyId = `user-message-${createUniqueId()}`
  const [collapsible, setCollapsible] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)

  onMount(() => {
    // 观察未裁剪正文的布局结果，避免挂载每条消息时同步读取高度并强制布局。
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const next = entry.contentRect.height > userMessagePreviewHeight() + 1
      setCollapsible(next)
      if (!next) setExpanded(false)
    })
    observer.observe(copy)
    onCleanup(() => observer.disconnect())
  })

  const size = () => Array.from(props.text).length

  return (
    <div
      class="bubble"
      classList={{ collapsible: collapsible(), expanded: expanded() }}
      style={{ '--user-message-preview-height': `${userMessagePreviewHeight()}px` }}
    >
      <div id={copyId} class="user-bubble-viewport">
        <div class="user-bubble-copy" ref={copy}>
          {props.text}
        </div>
      </div>
      <Show when={collapsible()}>
        <button
          class="user-bubble-toggle"
          type="button"
          aria-expanded={expanded()}
          aria-controls={copyId}
          on:click={() => setExpanded((value) => !value)}
        >
          <span>{expanded() ? '收起' : '展开全部'}</span>
          <span class="user-bubble-size">· {size()} 字</span>
          <IconChevron size={12} dir={expanded() ? 'up' : 'down'} />
        </button>
      </Show>
    </div>
  )
}
