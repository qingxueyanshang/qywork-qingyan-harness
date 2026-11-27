import { type Migration, nextWindow, parsedObject, SCAN_ROWS } from './shared.ts'

export const migration085: Migration = {
  id: 85,
  name: 'office_guide_target',
  /**
   * 历史中 `read_office_guide` 行的目标是格式名（docx、pptx、xlsx），文档类目的读取目标被上下文压缩计入「涉及的文件」。
   * 该工具已不声明目标，清除历史行中的目标，压缩这些会话时文件清单中不再出现格式名。按 rowid 区间分批执行。
   */
  background: (db, _content, after) => {
    const rows = db
      .query<{ id: string; payload: string | null }, [number, number]>(
        `SELECT id, payload FROM steps
         WHERE rowid > ? AND rowid <= ? AND kind = 'tool_action' AND tool_name = 'read_office_guide'`,
      )
      .all(after, after + SCAN_ROWS)
    const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = parsedObject(row.payload)
      const action = payload?.action as Record<string, unknown> | undefined
      if (!payload || !action || action.target == null) continue
      write.run(JSON.stringify({ ...payload, action: { ...action, target: null } }), row.id)
    }
    return nextWindow(db, after)
  },
}
