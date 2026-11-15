import type { Migration } from './shared.ts'

export const migration045: Migration = {
  id: 45,
  name: 'single_cell_duration',
  /** 单个派发的节点耗时即本次调用的耗时。旧服务只记录在 step 上，节点中没有，此处复制到节点。 */
  apply(db) {
    const select = db.prepare<{ id: string; duration_ms: number; payload: string }, []>(
      `SELECT id, duration_ms, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name = 'subagent' AND duration_ms IS NOT NULL
           AND json_type(payload, '$.nodes.child') = 'object'
           AND json_extract(payload, '$.nodes.child.durationMs') IS NULL`,
    )
    const rows = select.all()
    select.finalize()
    if (rows.length === 0) return
    const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as { nodes: { child: { durationMs?: number } } }
      payload.nodes.child.durationMs = row.duration_ms
      update.run(JSON.stringify(payload), row.id)
    }
    update.finalize()
  },
}
