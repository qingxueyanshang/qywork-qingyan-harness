import { type Migration, nextWindow, parsedObject, SCAN_ROWS } from './shared.ts'

export const migration086: Migration = {
  id: 86,
  name: 'tool_load_head',
  /**
   * `load_tool` 移入单独的类目「工具加载」，动词由「读取」改为「加载」：它加载按需工具的说明与参数定义，
   * 不读取会话，也不读取文件。历史行显示为「会话读取 · 读取 read_office」，看似读取名为 read_office 的内容。
   * 只改写开头仍为「会话读取」的行。按 rowid 区间分批执行。
   */
  background: (db, _content, after) => {
    const rows = db
      .query<{ id: string; payload: string | null }, [number, number]>(
        `SELECT id, payload FROM steps
         WHERE rowid > ? AND rowid <= ? AND kind = 'tool_action' AND tool_name = 'load_tool'`,
      )
      .all(after, after + SCAN_ROWS)
    const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = parsedObject(row.payload)
      const action = payload?.action as Record<string, unknown> | undefined
      if (!payload || action?.head !== '会话读取') continue
      write.run(
        JSON.stringify({ ...payload, action: { ...action, head: '工具加载', verb: '加载' } }),
        row.id,
      )
    }
    return nextWindow(db, after)
  },
}
