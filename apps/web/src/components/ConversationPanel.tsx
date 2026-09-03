/**
 * 右侧面板里的子会话页：一条子 agent 会话在做什么。
 *
 * **跑着的时候也看得到**：这一页订阅的是那条子会话自己的事件流
 * （订阅集见 `connection.ts` 的 `syncViews`），正文与工具卡跟着长，
 * 不是等它跑完再一次性显示。
 *
 * **只读**：没有输入框。正文、贴底跟随与运行读数和主会话走同一套组件；
 * 要接着问，回到会话流里再派一次。
 */

import { createResource, Show } from 'solid-js'
import {
  conversationRunClosed,
  isConversationRunning,
  loadConversationView,
  tabConversationId,
  viewOf,
} from '../lib/store/index.ts'
import {
  ConversationHistoryBoundary,
  createConversationScroll,
  LiveRunBar,
  TranscriptRows,
} from './Transcript.tsx'

export default function ConversationPanel(props: { id: string }) {
  const cid = () => tabConversationId(props.id)
  const follow = createConversationScroll(cid)
  // 只用来接住这一拉的失败：正文本身读的是那条会话的表，由事件实时更新。
  const [loaded] = createResource(cid, (id) => loadConversationView(id))

  return (
    <div class="child-cv" ref={follow.scrollerRef} onScroll={follow.onScroll}>
      <div class="child-cv-inner" ref={follow.innerRef}>
        <Show when={loaded.error}>
          <div class="error-card" role="alert">
            {String(loaded.error)}
          </div>
        </Show>
        <ConversationHistoryBoundary
          conversationId={cid()}
          onLoadOlder={follow.loadOlderAnchored}
        />
        {/* 忙闲只读服务端那张按会话 id 的表，不从是否收到 run.started 猜。 */}
        <TranscriptRows
          items={viewOf(cid()).transcript}
          live={() => isConversationRunning(cid())}
        />
        {/* 与主会话同一判据：忙态一成立就挂。打开页面时即使错过 run.started，
            也不能让“是否有状态条”取决于这条瞬时事件；run 收尾后再由同一条
            transcript 里的终态条目完成交接，避免短暂画出两条。 */}
        <Show when={isConversationRunning(cid()) && !conversationRunClosed(cid())}>
          <LiveRunBar conversationId={cid()} />
        </Show>
      </div>
    </div>
  )
}
