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
import { ConversationStream } from './Transcript.tsx'

export default function ConversationPanel(props: { id: string }) {
  const cid = () => tabConversationId(props.id)
  // 只用来接住这一拉的失败：正文本身读的是那条会话的表，由事件实时更新。
  const [loaded] = createResource(cid, (id) => loadConversationView(id))

  return (
    <ConversationStream
      conversationId={cid()}
      items={viewOf(cid()).transcript}
      live={() => isConversationRunning(cid())}
      closed={() => conversationRunClosed(cid())}
      variant="panel"
      leading={
        <Show when={loaded.error}>
          <div class="error-card" role="alert">
            {String(loaded.error)}
          </div>
        </Show>
      }
    />
  )
}
