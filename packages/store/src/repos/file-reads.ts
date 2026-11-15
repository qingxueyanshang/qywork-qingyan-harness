/**
 * `file_reads` 表：会话读取文件时的内容哈希。
 */

import type { ConversationId } from '@qywork/core'
import type { Store } from '../db.ts'

/**
 * 记录会话读取某个文件时的内容哈希，供写入前的新鲜度校验使用。
 *
 * 同一文件重复读取时只保留最近一次：校验判断的是已读取的内容是否仍与磁盘一致，
 * 旧哈希对此没有作用，保留只会使该表无谓增长。
 */
export function recordFileRead(
  store: Store,
  conversationId: ConversationId,
  path: string,
  hash: string,
): void {
  store.db
    .query(
      `INSERT INTO file_reads (conversation_id, path, hash, read_at) VALUES (?,?,?,?)
       ON CONFLICT(conversation_id, path) DO UPDATE SET hash = excluded.hash, read_at = excluded.read_at`,
    )
    .run(conversationId, path, hash, Date.now())
}

/** 会话读取该文件时的内容哈希；未读取过时返回 null。 */
export function fileReadHash(
  store: Store,
  conversationId: ConversationId,
  path: string,
): string | null {
  const row = store.db
    .query<{ hash: string }, [string, string]>(
      'SELECT hash FROM file_reads WHERE conversation_id = ? AND path = ?',
    )
    .get(conversationId, path)
  return row?.hash ?? null
}
