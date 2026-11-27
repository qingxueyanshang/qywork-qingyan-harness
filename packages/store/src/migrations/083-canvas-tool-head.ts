import type { Database } from 'bun:sqlite'
import { type Migration, parsedObject } from './shared.ts'

/** 迁移 83 每批读取的候选行数。候选行按 payload 中的旧开头预先筛选，数量远少于全部工具行。 */
const BATCH_ROWS = 500

const OLD_HEAD = '画布读写'
const NEW_HEAD = '画布控制'

function renameBatch(db: Database, after: number): number | null {
  const rows = db
    .query<{ rid: number; id: string; payload: string | null }, [number, string, number]>(
      `SELECT rowid AS rid, id, payload FROM steps
       WHERE rowid > ? AND kind = 'tool_action' AND instr(payload, ?) > 0
       ORDER BY rowid LIMIT ?`,
    )
    .all(after, OLD_HEAD, BATCH_ROWS)
  if (!rows.length) return null
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    const action = payload?.action as Record<string, unknown> | undefined
    if (!payload || action?.head !== OLD_HEAD) continue
    write.run(JSON.stringify({ ...payload, action: { ...action, head: NEW_HEAD } }), row.id)
  }
  return rows.at(-1)!.rid
}

export const migration083: Migration = {
  id: 83,
  name: 'canvas_tool_head',
  /**
   * 画布类工具的开头由「画布读写」改为「画布控制」：这组工具除读取与修改画布外还运行生成、取回、取消、截取与导出。
   * 历史工具行的开头写在 payload 中（迁移 81），不改写时历史显示旧名称，与新写入的行和设置页的分组名不一致。
   * 只改写开头恰为旧名称的行。分批执行，理由同迁移 81。
   */
  background: (db, _content, after) => renameBatch(db, after),
}
