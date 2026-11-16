import { createEffect, createMemo, useContext } from 'solid-js'
import type { TranscriptItem } from '../../lib/store/index.ts'
import { Fold, foldKey } from './Fold.tsx'
import { RowStream } from './row-stream.ts'

export function ThinkingFold(props: { item: TranscriptItem }) {
  const row = useContext(RowStream)
  // 使用 memo 而不是取值函数，理由同 `Prose`：读取的两个值每追加一条就通知一次。
  // 已中断的思考在重发等待期间仍是最后一条，不得按末尾条目判为正在输出。
  const streaming = createMemo(
    () =>
      !props.item.interrupted &&
      row.live() &&
      !row.generatingToolCall() &&
      row.items().at(-1)?.id === props.item.id,
  )
  // 流仍在增长时显示「思考中」，停止后显示「已思考」，
  // 避免标签显示「已思考」而旁边的加载动画仍表示正在思考。
  const verb = () => {
    if (props.item.interrupted) return '思考已中断'
    return streaming() ? '思考中' : '已思考'
  }
  // 只取开头一段再合并空白：整段思考可达数万字，每帧扫描全文会使耗时随长度增长。
  const preview = () => props.item.text.slice(0, 240).replace(/\s+/g, ' ').trim().slice(0, 80)

  /*
   * 思考块自行滚动到底部。
   *
   * `.fold-pre` 是内层滚动容器（max-height 200px），会话流的底部跟随只作用于外层。
   * 用户在思考仍在流式输出时展开它，若不跟随，它停留在第一屏，
   * 新到达的文字持续追加在视口之外，看起来像已停滞。
   *
   * 只在流式输出期间跟随：输出停止后用户向上滚动时，不应被强制滚回底部，外层同样避免这种行为。
   */
  let pre: HTMLPreElement | undefined
  const stickPreToBottom = () => {
    if (streaming() && pre) pre.scrollTop = pre.scrollHeight
  }
  createEffect(() => {
    void props.item.text
    stickPreToBottom()
  })

  return (
    <Fold
      id={foldKey('thinking', props.item.id)}
      dim
      label={preview() ? `${verb()} — ${preview()}` : verb()}
      onOpen={stickPreToBottom}
    >
      <pre class="fold-pre" ref={pre}>
        {props.item.text}
      </pre>
    </Fold>
  )
}
