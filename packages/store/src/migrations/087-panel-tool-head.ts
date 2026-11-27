import { type Migration, nextWindow, parsedObject, SCAN_ROWS } from './shared.ts'

export const migration087: Migration = {
  id: 87,
  name: 'panel_tool_head',
  /**
   * `open_in_panel` 移入单独的类目「面板控制」：它只让界面在右侧面板打开文件、画布或工作台，不读取也不写入文件。
   * 历史行显示为「文件读写 · 打开 a.canvas.json」。只改写开头仍为「文件读写」的行。按 rowid 区间分批执行。
   */
  background: (db, _content, after) => {
    const rows = db
      .query<{ id: string; payload: string | null }, [number, number]>(
        `SELECT id, payload FROM steps
         WHERE rowid > ? AND rowid <= ? AND kind = 'tool_action' AND tool_name = 'open_in_panel'`,
      )
      .all(after, after + SCAN_ROWS)
    const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = parsedObject(row.payload)
      const action = payload?.action as Record<string, unknown> | undefined
      if (!payload || action?.head !== '文件读写') continue
      write.run(JSON.stringify({ ...payload, action: { ...action, head: '面板控制' } }), row.id)
    }
    return nextWindow(db, after)
  },
}
