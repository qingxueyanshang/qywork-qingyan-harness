import type { Migration } from './shared.ts'

export const migration046: Migration = {
  id: 46,
  name: 'temp_cells_by_name',
  /**
   * 临时子 agent 创建时必须给定名字，该名字即子会话标题；节点显示该名字，不显示模型名。
   * 迁移 44 将节点名称统一为模型名，此处恢复为标题；单个派发参数中的 name 同步修改。
   */
  apply(db) {
    const select = db.prepare<{ id: string; tool_name: string; payload: string }, []>(
      `SELECT id, tool_name, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent')
           AND json_type(payload, '$.nodes') = 'object'`,
    )
    const rows = select.all()
    select.finalize()
    if (rows.length === 0) return
    const convOf = db.prepare<{ source: string | null; title: string }, [string]>(
      'SELECT source, title FROM conversations WHERE id = ?',
    )
    const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        args?: { kind?: unknown; name?: unknown }
        nodes: Record<string, { label?: unknown; subagentId?: unknown }>
      }
      let changed = false
      for (const [id, state] of Object.entries(payload.nodes)) {
        if (typeof state.subagentId !== 'string') continue
        const conversation = convOf.get(state.subagentId)
        if (conversation?.source !== 'temp' || !conversation.title) continue
        if (state.label !== conversation.title) {
          state.label = conversation.title
          changed = true
        }
        if (
          id === 'child' &&
          row.tool_name === 'subagent' &&
          payload.args?.kind === 'temp' &&
          payload.args.name !== conversation.title
        ) {
          payload.args.name = conversation.title
          changed = true
        }
      }
      if (changed) update.run(JSON.stringify(payload), row.id)
    }
    convOf.finalize()
    update.finalize()
  },
}
