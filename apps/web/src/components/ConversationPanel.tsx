/**
 * 右侧面板中的子会话页：显示一条子 agent 会话的执行内容。
 *
 * **运行期间也可查看**：本页订阅该子会话自身的事件流
 * （订阅集见 `connection.ts` 的 `syncViews`），正文与工具卡随之增长，
 * 而不是在执行完毕后一次性显示。
 *
 * **只读**：没有输入框。正文、底部跟随与运行读数和主会话使用同一套组件；
 * 需要追问时，回到会话流中再派发一次。
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
  // 仅用于捕获本次获取的失败：正文读取的是该会话的数据表，由事件实时更新。
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
