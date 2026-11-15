import { Show } from 'solid-js'
import { loadOlderConversation, retryConversationHistory, viewOf } from '../../lib/store/index.ts'
import { IconSpinner } from '../Icons.tsx'

/** 会话历史的加载状态：首次加载提示、失败重试，以及按需加载更早的轮次。 */
export function ConversationHistoryBoundary(props: {
  conversationId: string
  onLoadOlder?: () => void | Promise<void>
}) {
  const history = () => viewOf(props.conversationId).history
  const loadOlder = () =>
    props.onLoadOlder ? props.onLoadOlder() : loadOlderConversation(props.conversationId)

  return (
    <Show
      when={
        (history().loading !== 'unloaded' && history().loading !== null) ||
        history().error !== null ||
        history().nextCursor !== null
      }
    >
      <div class="history-boundary" aria-live="polite">
        <Show when={history().loading === 'initial'}>
          <span class="history-note">
            <IconSpinner size={13} />
            正在加载会话…
          </span>
        </Show>
        <Show when={history().loading === 'older'}>
          <button class="history-button" type="button" disabled>
            <IconSpinner size={13} />
            正在加载更早记录…
          </button>
        </Show>
        <Show when={history().error}>
          {(error) => (
            <div class="history-error" role="alert">
              <span>历史记录加载失败：{error().message}</span>
              <button
                class="btn-ghost sm"
                type="button"
                onClick={() => void retryConversationHistory(props.conversationId)}
              >
                重试
              </button>
            </div>
          )}
        </Show>
        <Show
          when={
            history().loading === null && history().error === null && history().nextCursor !== null
          }
        >
          <button class="history-button" type="button" onClick={() => void loadOlder()}>
            加载更早记录
          </button>
        </Show>
      </div>
    </Show>
  )
}
