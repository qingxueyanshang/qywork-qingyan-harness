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
import { delegateConversationId } from '../lib/step-view.ts'
import {
  conversationRunClosed,
  isConversationRunning,
  loadConversationView,
  state,
  tabConversationId,
  viewOf,
} from '../lib/store/index.ts'
import { ConversationStream } from './Transcript.tsx'

/**
 * 这条子会话是否仍由一条运行中的父步骤持有。
 *
 * 正常路径只读 `busyConversations`。这里接的是开发热更新期间已经在旧 sidecar 中开跑
 * 的成员：旧进程会转发正文并把父步骤保持为 running，却没有把子 run 登记进忙闲表。
 * 判据必须同时对上运行中步骤与精确 conversationId；不能拿“最近还有事件”或未收尾
 * run 猜，否则崩溃遗留行会把普通历史会话永久画成运行中。
 */
export function delegatedParentStillRunning(conversationId: string): boolean {
  return Object.values(state.views).some((parent) =>
    parent.transcript.some((item) => {
      if (item.kind !== 'tool' || item.status !== 'running') return false
      if (item.toolName === 'subagent') return delegateConversationId(item) === conversationId
      return item.nodes?.some(
        (node) =>
          node.conversationId === conversationId &&
          (node.phase === 'spawned' || node.phase === 'working'),
      )
    }),
  )
}

export default function ConversationPanel(props: { id: string }) {
  const cid = () => tabConversationId(props.id)
  const live = () => isConversationRunning(cid()) || delegatedParentStillRunning(cid())
  // 只用来接住这一拉的失败：正文本身读的是那条会话的表，由事件实时更新。
  const [loaded] = createResource(cid, (id) => loadConversationView(id))

  return (
    <ConversationStream
      conversationId={cid()}
      items={viewOf(cid()).transcript}
      live={live}
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
