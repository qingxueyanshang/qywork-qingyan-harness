/**
 * 会话级的「已加载到工具表的外部工具」。
 *
 * 外部工具（MCP / 插件）的完整参数说明占用大量 token，默认不进入请求，模型用 `load_tool`
 * 按需加载。加载记录属于单个会话：在其他会话中应重新判断是否加载，
 * 同一会话的下一轮则不应重复加载。
 *
 * 进程中没有会话级的生命周期可供依附：服务端为每条消息新建一个 Session，
 * 因此真源放在账本中，随会话一并删除（与 `file_reads`、`goal_events` 的处理方式相同）。
 */

import type { ConversationId } from '@qywork/core'
import type { Store } from './db.ts'

/** 该会话已加载的工具。返回集合而不是数组：所有调用方都只做包含判断。 */
export function listLoadedTools(store: Store, conversationId: ConversationId): Set<string> {
  const rows = store.db
    .query<{ tool_name: string }, [string]>(
      'SELECT tool_name FROM conversation_loaded_tools WHERE conversation_id = ?',
    )
    .all(conversationId)
  return new Set(rows.map((r) => r.tool_name))
}

/**
 * 记录本批工具已加载。
 *
 * 使用 `INSERT OR IGNORE`：重复加载同一个工具是同一事实，以第一次的时间戳为准。
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
