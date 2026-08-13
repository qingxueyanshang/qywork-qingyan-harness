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
 *
 * ## 默认折叠
 *
 * 常驻展开时，十条 todo 会吃掉小半屏，而其中九条是「待办」和「已完成」——
 * 真正要看的只有当前那条。所以收起态就是**当前这条 + N/M**，点开才列全部。
 * 参照物（青研魔盒 `PlanChip`）也是折叠的，理由相同。
 *
 * 载体用原生 `<details>`，和会话流里的折叠是同一套形状与键盘语义。
 */
export function PlanCard() {
  const todos = () => state.todos
  const done = () => todos().filter((t) => t.status === 'completed').length
  const allDone = () => todos().length > 0 && done() === todos().length
  const current = () => todos().find((t) => t.status === 'in_progress')

  return (
    <Show when={todos().length > 0 && !allDone()}>
      <details class="plan-card">
        <summary class="plan-head">
          <span class="plan-title truncate">{current()?.content ?? '计划'}</span>
          <span class="plan-count">
            {done()}/{todos().length}
          </span>
        </summary>
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
      </details>
    </Show>
  )
}
