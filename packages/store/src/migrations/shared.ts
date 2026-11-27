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
  /**
   * 分批迁移完成后执行 VACUUM 收回空间。只用于移出或删除大量数据的迁移：VACUUM 重写整个账本文件，
   * 在服务线程上同步执行，账本数百 MB 时耗时以秒计；只改写少量行的迁移不收回任何空间。
   */
  vacuum?: true
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

/**
 * 按 rowid 区间分批的迁移每批覆盖的行数。不要改为按匹配行数分批（`LIMIT`）：候选行稀疏时，
 * 一批要扫描到表尾才凑满，整张表的扫描在一个写事务中完成，期间服务线程阻塞。
 */
export const SCAN_ROWS = 5_000

/** 区间 `(after, after + SCAN_ROWS]` 之后是否还有行：有时返回下一批的起点，否则返回 null。 */
export function nextWindow(db: Database, after: number): number | null {
  const end = after + SCAN_ROWS
  return db.query('SELECT 1 FROM steps WHERE rowid > ? LIMIT 1').get(end) ? end : null
}

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
    .query<{ id: string; payload: string | null }, [number, number, string]>(
      `SELECT id, payload FROM steps
       WHERE rowid > ? AND rowid <= ? AND kind = 'tool_action' AND instr(payload, ?) > 0`,
    )
    .all(after, after + SCAN_ROWS, from)
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    const action = payload?.action as Record<string, unknown> | undefined
    if (!payload || action?.head !== from) continue
    write.run(JSON.stringify({ ...payload, action: { ...action, head: to } }), row.id)
  }
  return nextWindow(db, after)
}

/** 旧服务为临时子 agent 设定的显示名。迁移 41 沿用该名称，不以任务正文作为名字。 */
export const TEMP_LABEL = '临时子 agent'
