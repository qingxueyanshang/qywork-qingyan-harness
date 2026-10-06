/**
 * 待办的读取。**本模块不提供写入函数，也不应提供。**
 *
 * 待办的真源是 `write_todos` tool step 自身的 `args`：在整表语义下，
 * 最后一次成功提交即全部事实。子 agent 返回只表示产出已交回，不表示父会话
 * 已经验收；将其折叠为 completed 会绕过 workflow 的 approve/revise 回流环节。
 * 写入由 loop 在记录 step 时一并完成，另建 `todos` 表即形成第二本账。
 *
 * 历史接口直接返回本函数的结果，前端只消费快照，不另写折叠算法。
 * 工具与提示词同样从此处读取，避免三条路径对同一批 steps 各自推测。
 *
 * SQL 中的 `'write_todos'` 是**已写入磁盘的列值**，不是对 tools 包的依赖：
 * 账本记录的就是该字符串，修改工具名时必须连同迁移一起修改，并与此处同步。
 */

import type { ConversationId, RunId, TodoItem } from '@qywork/core'
import type { Store } from './db.ts'

/**
 * 会话当前的待办清单；从未提交时为 `null`。
 *
 * 按 run 的先后与 run 内的 seq 倒序取第一条。必须跨 run 读取：一轮完成三项、
 * 下一轮继续第四项是常见情况。传入 runId 时，用户新消息只读取本轮提交；子任务或工作流
 * 回执沿用会话清单，因为它们是在接续父任务，而不是用户发起的新指令。
 */
export function latestTodos(
  store: Store,
  conversationId: ConversationId,
  runId?: RunId,
): TodoItem[] | null {
  const row = store.db
    .query<{ payload: string | null }, [string, string | null, string | null, string | null]>(
      `SELECT s.payload FROM steps s
         JOIN runs r ON r.id = s.run_id
        WHERE r.conversation_id = ?
          AND (? IS NULL OR r.id = ? OR (
            SELECT m.origin FROM runs current
              JOIN messages m ON m.id = current.user_message_id
             WHERE current.id = ? AND current.conversation_id = r.conversation_id
          ) IN ('subagent', 'workflow'))
          AND s.tool_name = 'write_todos'
          AND s.status = 'success'
        ORDER BY r.created_at DESC, r.id DESC, s.seq DESC
        LIMIT 1`,
    )
    .get(conversationId, runId ?? null, runId ?? null, runId ?? null)
  if (!row?.payload) return null

  try {
    const todos = (JSON.parse(row.payload) as { args?: { todos?: unknown } }).args?.todos
    return Array.isArray(todos) && todos.length > 0 ? (todos as TodoItem[]) : null
  } catch {
    // 历史 payload 可能来自旧版本。无法解析的清单按不存在处理，不应使历史接口整体失败。
    return null
  }
}
