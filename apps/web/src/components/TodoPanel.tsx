import { Show } from 'solid-js'
import { state } from '../lib/store/index.ts'
import { TodoList } from './TodoList.tsx'

/**
 * 任务清单。**位于右侧面板中，不在会话流上方。**
 *
 * 固定在会话流顶部的折叠卡（随进度更新）会使**同一信息在三处重复显示**：
 * 卡片显示当前步骤的序号与名称，输入区上方的状态条也显示步数，
 * 展开后的清单是第三处。
 *
 * 按信息密度分层：
 *
 * - **输入区上方的状态条**只显示「已完成 N / M」，占用空间小，不含条目正文。
 * - **完整清单放在此处**，需要查看细节时打开面板。
 *
 * 全部完成后仍然显示：面板由用户主动打开，此时移除内容会显示为空白，
 * 而不是已全部完成的清单。常驻在会话流顶部的卡片则相反，完成后不收起只会占用空间。
 */
export function TodoPanel() {
  const todos = () => state.todos

  return (
    <div class="todo-panel">
      {/* 此处不显示完成比例：清单就在下方，已完成的条目可直接看出；
          剩余进度由输入区上方的状态条显示，两处都显示会重复。 */}
      <Show when={todos().length > 0}>
        <TodoList todos={todos()} />
      </Show>
    </div>
  )
}
