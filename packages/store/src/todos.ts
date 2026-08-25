/**
 * 待办的读回。**没有写入函数，这里也不该有。**
 *
 * 待办的真源是 `write_todos` 那条 tool step 自己的 `args`——整表语义下，
 * 最后一次成功提交就是全部事实。落盘由 loop 记 step 时一并完成，
 * 另开一张 `todos` 表就是第二本账：同一份清单两处存，迟早对不上。
 *
 * 前端早就在这么读（`apps/web/src/lib/store/connection.ts` 的 `todosFromSteps`）。
 * 这个函数是同一件事的服务端一份，给工具判「这是第一份清单还是在改已有的」用。
 *
 * SQL 里那个 `'write_todos'` 是**落盘的列值**，不是对 tools 包的依赖——
 * 账本记的就是这个字符串，改工具名要连同迁移一起改，与这里同步。
 */

import type { ConversationId, TodoItem } from '@qywork/core'
import type { Store } from './db.ts'

/**
 * 这条会话最近一次成功提交的待办清单；没提交过就是 `null`。
 *
 * 按「run 的先后 + run 内的 seq」倒着取第一条，与前端投影同一个口径。
 * 跨 run 是必须的：一轮做三条、下一轮接着做第四条是常态。
 */
export function latestTodos(store: Store, conversationId: ConversationId): TodoItem[] | null {
  const row = store.db
    .query<{ payload: string | null }, [string]>(
      `SELECT s.payload FROM steps s
         JOIN runs r ON r.id = s.run_id
        WHERE r.conversation_id = ?
          AND s.tool_name = 'write_todos'
          AND s.status = 'success'
        ORDER BY r.created_at DESC, s.seq DESC
        LIMIT 1`,
    )
    .get(conversationId)
  if (!row?.payload) return null

  // 账本里的 payload 是历史事实，可能由任何一个历史版本写入。读不出清单就当没有，
  // 不抛——一份读不回来的旧清单只该让动作词退回「创建」，不该让工具调用失败。
  try {
    const todos = (JSON.parse(row.payload) as { args?: { todos?: unknown } }).args?.todos
    return Array.isArray(todos) && todos.length > 0 ? (todos as TodoItem[]) : null
  } catch {
    return null
  }
}
