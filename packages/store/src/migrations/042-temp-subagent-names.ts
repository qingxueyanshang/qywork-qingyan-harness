import { type Migration, TEMP_LABEL } from './shared.ts'

export const migration042: Migration = {
  id: 42,
  name: 'temp_subagent_names',
  /**
   * 迁移 41 曾以子会话标题作为旧临时子 agent 的名字，而旧服务的标题就是任务正文，
   * 卡片上的任务行与节点名称因此内容相同。名字为任务正文开头部分的行改为「临时子 agent」。
   */
  apply(db) {
    const select = db.prepare<{ id: string; payload: string }, []>(
      `SELECT id, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name = 'subagent' AND payload IS NOT NULL`,
    )
    const rows = select.all()
    select.finalize()
    if (rows.length === 0) return
    const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        args?: { kind?: unknown; name?: unknown; task?: unknown }
        nodes?: Record<string, { label?: unknown }>
      }
      const args = payload.args
      if (args?.kind !== 'temp' || typeof args.name !== 'string' || typeof args.task !== 'string') {
        continue
      }
      const head = args.name.replace(/…$/, '')
      if (!head || !args.task.startsWith(head)) continue
      args.name = TEMP_LABEL
      const child = payload.nodes?.child
      if (child) child.label = TEMP_LABEL
      update.run(JSON.stringify(payload), row.id)
    }
    update.finalize()
  },
}
