import type { Migration } from './shared.ts'

export const migration044: Migration = {
  id: 44,
  name: 'temp_cells_by_model',
  /** 临时子 agent 的节点名称统一为其模型名；存量行中混有节点 id、给定名等多种名称。 */
  apply(db) {
    const select = db.prepare<{ id: string; payload: string }, []>(
      `SELECT id, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent')
           AND json_type(payload, '$.nodes') = 'object'`,
    )
    const rows = select.all()
    select.finalize()
    if (rows.length === 0) return
    const convOf = db.prepare<{ source: string | null; model: string }, [string]>(
      'SELECT source, model FROM conversations WHERE id = ?',
    )
    const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        nodes: Record<string, { label?: unknown; subagentId?: unknown }>
      }
      let changed = false
      for (const state of Object.values(payload.nodes)) {
        if (typeof state.subagentId !== 'string') continue
        const conversation = convOf.get(state.subagentId)
        if (conversation?.source !== 'temp' || state.label === conversation.model) continue
        state.label = conversation.model
        changed = true
      }
      if (changed) update.run(JSON.stringify(payload), row.id)
    }
    convOf.finalize()
    update.finalize()
  },
}
