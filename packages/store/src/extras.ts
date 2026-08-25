/**
 * 会话级的「这一轮不用它」。
 *
 * **它管的是什么。** 技能 / MCP / 插件 / 记忆各自的开关，**只影响当前这一条会话**。
 * 设置页回答「要改什么」，这里回答「这一轮怎么跑」——同一个扩展在设置页里
 * 装好了，在某条会话里可以关掉，而不必去改一份对所有会话生效的配置。
 *
 * **只记「关掉的」。** 默认全开，所以**没有行 = 全开**。反过来记的话，每装一个新技能都要给所有历史
 * 会话补一行，漏补的表现是「新装的技能在老会话里不生效」——而那是一条谁都不会
 * 去查的路径。
 *
 * **内置层不在这里。** 用户看不到内置层，也就没有开关可言。key 里不会出现它。
 */

import type { ConversationId } from '@qywork/core'
import type { Store } from './db.ts'

/** `<类目>:<标识>`，如 `skill:release`、`mcp:github`、`plugin:foo`、`memory:style`。 */
export type ExtraKey = string

/** 这条会话关掉了哪些。返回集合而不是数组：调用方全都是在做包含判断。 */
export function listDisabledExtras(store: Store, conversationId: ConversationId): Set<ExtraKey> {
  const rows = store.db
    .query<{ key: string }, [string]>(
      'SELECT key FROM conversation_extras WHERE conversation_id = ?',
    )
    .all(conversationId)
  return new Set(rows.map((r) => r.key))
}

/**
 * 开或关一项。
 *
 * 开 = 删掉那一行（回到默认），不是写一行 `enabled = 1`——两种表示同一个状态
 * 的写法并存就是两本账。
 */
export function setExtraEnabled(
  store: Store,
  conversationId: ConversationId,
  key: ExtraKey,
  enabled: boolean,
): void {
  if (enabled) {
    store.db
      .query('DELETE FROM conversation_extras WHERE conversation_id = ? AND key = ?')
      .run(conversationId, key)
    return
  }
  store.db
    .query('INSERT OR IGNORE INTO conversation_extras (conversation_id, key) VALUES (?, ?)')
    .run(conversationId, key)
}
