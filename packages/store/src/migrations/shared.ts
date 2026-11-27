/**
 * 迁移文件共用的定义：每条迁移的结构，以及被多条迁移使用的辅助函数与常量。
 * 只被一条迁移使用的辅助函数写在该迁移的文件中。
 */

import type { Database } from 'bun:sqlite'
import type { ContentStore } from '../content.ts'

export interface Migration {
  id: number
  name: string
  sql?: string
  apply?: (db: Database) => void
  /**
   * 分批执行的数据迁移。打开数据库时不执行，由服务开始接受请求之后逐批调用（`Store.migrateInBackground`）：
   * 每次处理 rowid 大于 `after` 的一批，返回下一批的起点，全部处理完返回 null；完成后整理文件再登记。
   *
   * 只用于不改变表结构、数据量随账本增长的迁移。打开时同步执行会使启动时间随账本增长，超过桌面外壳
   * 等待握手的时限后进程被终止，事务回滚，每次启动都从头开始。迁移完成之前的行与之后的行读取方都必须能读取。
   */
  background?: (db: Database, content: ContentStore, after: number) => number | null
}

export function parsedObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 改写工具开头的迁移每批读取的候选行数。候选行按 payload 中的旧开头预先筛选，数量远少于全部工具行。 */
const HEAD_BATCH_ROWS = 500

/**
 * 工具类目改名后改写历史工具行中已写入的开头（payload 的 `action.head`，迁移 81 写入）的一批。
 * 只改写开头恰为 `from` 的行；返回值的约定同 `Migration.background`。
 */
export function renameToolHeadBatch(
  db: Database,
  after: number,
  from: string,
  to: string,
): number | null {
  const rows = db
    .query<{ rid: number; id: string; payload: string | null }, [number, string, number]>(
      `SELECT rowid AS rid, id, payload FROM steps
       WHERE rowid > ? AND kind = 'tool_action' AND instr(payload, ?) > 0
       ORDER BY rowid LIMIT ?`,
    )
    .all(after, from, HEAD_BATCH_ROWS)
  if (!rows.length) return null
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    const action = payload?.action as Record<string, unknown> | undefined
    if (!payload || action?.head !== from) continue
    write.run(JSON.stringify({ ...payload, action: { ...action, head: to } }), row.id)
  }
  return rows.at(-1)!.rid
}

/** 旧服务为临时子 agent 设定的显示名。迁移 41 沿用该名称，不以任务正文作为名字。 */
export const TEMP_LABEL = '临时子 agent'
