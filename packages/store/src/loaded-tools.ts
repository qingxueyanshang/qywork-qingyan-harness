/**
 * 会话级的「已经装进工具表的外部工具」。
 *
 * 外部工具（MCP / 插件）的完整参数说明太贵，默认不进请求，模型用 `load_tool`
 * 按需装。装过这件事**属于这一条会话**：换一条会话该重新判断要不要装，
 * 而同一条会话的下一轮不该再装一遍。
 *
 * 进程里没有「会话级」这个生命周期可挂——服务端每条消息新建一个 Session，
 * 所以真源放账本，随会话删除一起走（同 `file_reads` 与 `goal_events` 的立场）。
 */

import type { ConversationId } from '@qywork/core'
import type { Store } from './db.ts'

/** 这条会话已经装了哪些。返回集合而不是数组：调用方全都是在做包含判断。 */
export function listLoadedTools(store: Store, conversationId: ConversationId): Set<string> {
  const rows = store.db
    .query<{ tool_name: string }, [string]>(
      'SELECT tool_name FROM conversation_loaded_tools WHERE conversation_id = ?',
    )
    .all(conversationId)
  return new Set(rows.map((r) => r.tool_name))
}

/**
 * 记下这一批装好了。
 *
 * `INSERT OR IGNORE`：重复装同一个工具是同一件事，第一次的时间戳才是事实。
 */
export function recordLoadedTools(
  store: Store,
  conversationId: ConversationId,
  toolNames: readonly string[],
): void {
  const now = Date.now()
  const insert = store.db.query(
    'INSERT OR IGNORE INTO conversation_loaded_tools (conversation_id, tool_name, loaded_at) VALUES (?, ?, ?)',
  )
  for (const name of toolNames) insert.run(conversationId, name, now)
}
