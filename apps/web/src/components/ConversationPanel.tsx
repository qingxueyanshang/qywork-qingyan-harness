/**
 * 右侧面板里的子会话页：一条子 agent 会话的只读回放。
 *
 * 子会话跑完就不再有事件，也不在会话列表里——所以这里投影一次即可，不订阅、
 * 不接事件、不给输入框。**它是回放，不是第二个可以说话的地方。**
 */

import { createResource, Show } from 'solid-js'
import { projectConversation } from '../lib/store/connection.ts'
import { tabConversationId } from '../lib/store/ui.ts'
import { TranscriptRows } from './Transcript.tsx'

export default function ConversationPanel(props: { id: string }) {
  const [items] = createResource(
    () => tabConversationId(props.id),
    (cid) => projectConversation(cid),
  )
  return (
    <div class="child-cv">
      <Show when={items.error}>
        <div class="error-card" role="alert">
          {String(items.error)}
        </div>
      </Show>
      <TranscriptRows items={items() ?? []} />
    </div>
  )
}
