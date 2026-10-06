import type { TodoItem } from '@qywork/core'
import { For, Show } from 'solid-js'
import { IconCheck, IconSpinner } from './Icons.tsx'

/**
 * 待办清单的行渲染。**三种状态各有独立的标记**：对勾（已完成）、旋转图标（进行中）、
 * 空心圆点（未开始）。仅凭文字无法区分状态，而该区域要回答的正是哪些条目已完成。
 *
 * 独立为组件是因为有**两个挂载点**：右侧的待办面板（当前清单）与会话流中
 * `write_todos` 卡片的展开区（该次提交的清单）。后者若使用通用参数表，只会显示一行
 * JSON：状态全部位于引号内，无法看出哪些条目已完成。
 *
 * **清单由调用方传入，不读取 store。** 会话流中的卡片显示的是**该次**提交的
 * 清单，读取全局当前清单会使每张历史卡片都显示最新状态。
 */
export function TodoList(props: { todos: readonly TodoItem[] }) {
  return (
    <ol class="todo-list">
      <For each={props.todos}>
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
  )
}
