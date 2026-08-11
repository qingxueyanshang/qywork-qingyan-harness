import { For, Show } from 'solid-js'
import { state } from '../lib/store/index.ts'
import { IconCheck, IconSpinner } from './Icons.tsx'

/**
 * 任务清单。
 *
 * 固定在会话流上方而不是插进流里：计划是**当前状态**不是历史事件，
 * 插进流里会随着滚动跑出视野，而用户最需要看到它的时刻恰恰是在往下翻输出的时候。
 *
 * 全部完成后自动收起——留着一屏绿勾只是占地方。
 */
export function PlanCard() {
  const todos = () => state.todos
  const done = () => todos().filter((t) => t.status === 'completed').length
  const allDone = () => todos().length > 0 && done() === todos().length
  const current = () => todos().find((t) => t.status === 'in_progress')

  return (
    <Show when={todos().length > 0 && !allDone()}>
      <div class="plan-card">
        <div class="plan-head">
          <span class="plan-title">{current()?.content ?? '计划'}</span>
          <span class="plan-count">
            {done()}/{todos().length}
          </span>
        </div>
        <ol class="plan-list">
          <For each={todos()}>
            {(t) => (
              <li
                class="plan-item"
                classList={{ done: t.status === 'completed', now: t.status === 'in_progress' }}
              >
                <span class="plan-mark">
                  <Show
                    when={t.status !== 'pending'}
                    fallback={<span class="plan-dot" aria-hidden="true" />}
                  >
                    <Show when={t.status === 'completed'} fallback={<IconSpinner size={12} />}>
                      <IconCheck size={12} />
                    </Show>
                  </Show>
                </span>
                <span class="plan-text">{t.content}</span>
              </li>
            )}
          </For>
        </ol>
      </div>
    </Show>
  )
}
