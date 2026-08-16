import { For, Show } from 'solid-js'
import { state } from '../lib/store/index.ts'
import { IconCheck, IconSpinner } from './Icons.tsx'

/**
 * 任务清单。**住在右侧面板里，不在会话流上方。**
 *
 * 钉在会话流顶部（一张随进度改写的折叠卡）会让**同一件事被摊在三个地方说**：
 * 那张卡说「在做第几步、当前这步叫什么」，输入区上方的状态条也说步数，
 * 展开后的清单又是第三份。用户第一眼找不到它，找到之后又要在两处对同一个数。
 *
 * 现在按信息密度分层：
 *
 * - **输入区那条状态条**只报「第 N / M 步」——一眼扫到，不占地方，不带正文。
 * - **完整清单收进这里**，要看细节才点开面板。
 *
 * 全部完成后仍然显示：面板是用户主动点开的，这时候把内容抽走，
 * 他看到的是一块空白，而不是「都做完了」。这与顶部那张卡的处境正相反——
 * 那里是常驻的，做完不收起来就只是占地方。
 */
export function TodoPanel() {
  const todos = () => state.todos
  const done = () => todos().filter((t) => t.status === 'completed').length

  return (
    <div class="todo-panel">
      <Show when={todos().length > 0}>
        <div class="todo-progress">
          {done()}/{todos().length}
        </div>
        <ol class="todo-list">
          <For each={todos()}>
            {(t) => (
              <li
                class="todo-item"
                classList={{ done: t.status === 'completed', now: t.status === 'in_progress' }}
              >
                <span class="todo-mark">
                  <Show
                    when={t.status !== 'pending'}
                    fallback={<span class="todo-dot" aria-hidden="true" />}
                  >
                    <Show when={t.status === 'completed'} fallback={<IconSpinner size={12} />}>
                      <IconCheck size={12} />
                    </Show>
                  </Show>
                </span>
                <span class="todo-text">{t.content}</span>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  )
}
