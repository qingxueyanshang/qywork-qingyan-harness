/**
 * 待办的读回。**没有写入函数，这里也不该有。**
 *
 * 待办的真源是 tool steps 账本：`write_todos` 提交一份整表，之后带
 * `parentTodo` 的成功 `subagent` step 完成它明确认领的那一条。落盘都由 loop
 * 记 step 时一并完成；另开一张 `todos` 表就是第二本账，同一份清单两处存迟早对不上。
 *
 * 历史接口直接返回这个函数的结果，前端只消费快照，不另写一份折叠算法。
 * 工具与提示词也从这里读，避免三条路径对同一批 steps 各猜一次。
 *
 * SQL 里那个 `'write_todos'` 是**落盘的列值**，不是对 tools 包的依赖——
 * 账本记的就是这个字符串，改工具名要连同迁移一起改，与这里同步。
 */

import type { ConversationId, TodoItem } from '@qywork/core'
import type { Store } from './db.ts'

/**
 * 这条会话此刻的待办清单；没提交过就是 `null`。
 *
 * 按「run 的先后 + run 内的 seq」折叠：`write_todos` 整表替换，之后成功的
 * `subagent(parentTodo=...)` 完成匹配条目并认领下一条。跨 run 是必须的：
 * 一轮做三条、下一轮接着做第四条是常态。
 */
export function latestTodos(store: Store, conversationId: ConversationId): TodoItem[] | null {
  const rows = store.db
    .query<{ tool_name: string; payload: string | null }, [string]>(
      `SELECT s.tool_name, s.payload FROM steps s
         JOIN runs r ON r.id = s.run_id
        WHERE r.conversation_id = ?
          AND s.tool_name IN ('write_todos', 'subagent')
          AND s.status = 'success'
        ORDER BY r.created_at ASC, r.id ASC, s.seq ASC`,
    )
    .all(conversationId)

  let todos: TodoItem[] | null = null
  for (const row of rows) {
    if (!row.payload) continue
    try {
      const args = (JSON.parse(row.payload) as { args?: Record<string, unknown> }).args
      if (row.tool_name === 'write_todos') {
        const next = args?.todos
        if (Array.isArray(next) && next.length > 0) todos = next as TodoItem[]
        continue
      }

      const parentTodo = typeof args?.parentTodo === 'string' ? args.parentTodo.trim() : ''
      if (todos && parentTodo) todos = completeLinkedTodo(todos, parentTodo)
    } catch {
      // 账本里的 payload 是历史事实，可能由任何历史版本写入。坏掉的一条只跳过，
      // 不能让它抹掉前面仍然可读的整表，更不能让会话历史接口整体失败。
    }
  }
  return todos
}

/** 成功子任务只推进它明确绑定的那一条；匹配不到就保持账本原样。 */
function completeLinkedTodo(todos: TodoItem[], content: string): TodoItem[] {
  const index = todos.findIndex((todo) => todo.content === content && todo.status !== 'completed')
  if (index < 0) return todos

  const next = todos.map((todo, i) =>
    i === index ? { ...todo, status: 'completed' as const } : { ...todo },
  )
  if (!next.some((todo) => todo.status === 'in_progress')) {
    const pending = next.findIndex((todo) => todo.status === 'pending')
    if (pending >= 0) next[pending] = { ...next[pending]!, status: 'in_progress' }
  }
  return next
}
