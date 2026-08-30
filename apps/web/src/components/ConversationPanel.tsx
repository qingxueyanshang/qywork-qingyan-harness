/**
 * 右侧面板里的子会话页：一条子 agent 会话在做什么。
 *
 * **跑着的时候也看得到**：这一页订阅的是那条子会话自己的事件流
 * （订阅集见 `connection.ts` 的 `syncViews`），正文与工具卡跟着长，
 * 不是等它跑完再一次性显示。
 *
 * **只读**：没有输入框，也没有读数条、待办、目标那几样——那些是当前会话那一份账
 * （`applyEvent` 里的分工）。要接着问，回到会话流里再派一次。
 */

import { createResource, Show } from 'solid-js'
import {
  loadConversationView,
  loadOlderConversation,
  tabConversationId,
  viewOf,
} from '../lib/store/index.ts'
import { ConversationHistoryBoundary, TranscriptRows } from './Transcript.tsx'

export default function ConversationPanel(props: { id: string }) {
  let scroller!: HTMLDivElement
  const cid = () => tabConversationId(props.id)
  // 只用来接住这一拉的失败：正文本身读的是那条会话的表，由事件实时更新。
  const [loaded] = createResource(cid, (id) => loadConversationView(id))

  const loadOlderAnchored = async () => {
    const id = cid()
    const beforeHeight = scroller.scrollHeight
    const beforeTop = scroller.scrollTop
    const added = await loadOlderConversation(id)
    if (!added || cid() !== id) return
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    scroller.scrollTop = beforeTop + (scroller.scrollHeight - beforeHeight)
  }

  return (
    <div class="child-cv" ref={scroller}>
      <Show when={loaded.error}>
        <div class="error-card" role="alert">
          {String(loaded.error)}
        </div>
      </Show>
      <ConversationHistoryBoundary conversationId={cid()} onLoadOlder={loadOlderAnchored} />
      {/* 这一列还在不在长，看这条子会话自己那一轮起没起——不是看当前会话在不在跑。 */}
      <TranscriptRows
        items={viewOf(cid()).transcript}
        live={() => viewOf(cid()).runStartedAt !== null}
      />
    </div>
  )
}
