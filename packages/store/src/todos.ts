/**
 * 待办的读回。**没有写入函数，这里也不该有。**
 *
 * 待办的真源是 `write_todos` 那条 tool step 自己的 `args`——整表语义下，
 * 最后一次成功提交就是全部事实。子 agent 返回只代表产出已交回，不代表父会话
 * 已经验收；把它折成 completed 会绕过 workflow 的 approve/revise 回流关口。
 * 落盘由 loop 记 step 时一并完成，另开一张 `todos` 表就是第二本账。
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
 * 按「run 的先后 + run 内的 seq」倒着取第一条。跨 run 是必须的：一轮做三条、
 * 下一轮接着做第四条是常态。
 */
export function latestTodos(store: Store, conversationId: ConversationId): TodoItem[] | null {
  const row = store.db
    .query<{ payload: string | null }, [string]>(
      `SELECT s.payload FROM steps s
         JOIN runs r ON r.id = s.run_id
        WHERE r.conversation_id = ?
          AND s.tool_name = 'write_todos'
          AND s.status = 'success'
        ORDER BY r.created_at DESC, r.id DESC, s.seq DESC
        LIMIT 1`,
    )
    .get(conversationId)
  if (!row?.payload) return null

  try {
    const todos = (JSON.parse(row.payload) as { args?: { todos?: unknown } }).args?.todos
    return Array.isArray(todos) && todos.length > 0 ? (todos as TodoItem[]) : null
  } catch {
    // 历史 payload 可能来自旧版本。坏清单只退化为没有，不应让历史接口整体失败。
    return null
  }
}
