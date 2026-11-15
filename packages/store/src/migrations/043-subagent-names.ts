import { type Migration, TEMP_LABEL } from './shared.ts'

export const migration043: Migration = {
  id: 43,
  name: 'subagent_names',
  /**
   * 子 agent 的名字只有一份：新建时给定的 name（角色取 role id，外部 CLI 取 cli id），
   * 子会话标题与卡片上对应节点使用的都是它。旧行的节点名称是子会话标题（旧服务写入的是任务正文），
   * 迁移 42 又将单个派发的临时子 agent 命名为「临时子 agent」，两者都不是名字。
   * 节点名称取派发参数中的目标名，没有名字的临时子 agent 取其模型 id。
   *
   * 预编译语句使用 prepare 并在末尾 finalize：未执行的缓存语句会使数据库文件在 close 之后
   * 仍被占用，在 Windows 上无法删除。
   */
  apply(db) {
    const select = db.prepare<{ id: string; tool_name: string; payload: string }, []>(
      `SELECT id, tool_name, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent') AND payload IS NOT NULL
         ORDER BY created_at ASC, seq ASC`,
    )
    const rows = select.all()
    select.finalize()
    if (rows.length === 0) return
    const convOf = db.prepare<{ title: string; model: string }, [string]>(
      'SELECT title, model FROM conversations WHERE id = ?',
    )
    const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
    const nameOf = (target: Record<string, unknown>, subagentId?: string): string | undefined => {
      for (const key of ['name', 'role', 'cli']) {
        const value = target[key]
        if (typeof value === 'string' && value && value !== TEMP_LABEL) return value
      }
      if (target.kind === 'temp' && subagentId) return convOf.get(subagentId)?.model
      return undefined
    }
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as {
        args?: Record<string, unknown>
        nodes?: Record<string, { label?: unknown; subagentId?: unknown }>
      }
      const targets: Record<string, Record<string, unknown>> = {}
      if (row.tool_name === 'subagent' && payload.args) targets.child = payload.args
      if (row.tool_name === 'workflow' && Array.isArray(payload.args?.nodes)) {
        for (const raw of payload.args.nodes) {
          const node = raw as Record<string, unknown>
          if (typeof node.id === 'string') targets[node.id] = node
        }
      }
      let changed = false
      for (const [id, state] of Object.entries(payload.nodes ?? {})) {
        const subagentId = typeof state.subagentId === 'string' ? state.subagentId : undefined
        const label = typeof state.label === 'string' ? state.label : ''
        const copied =
          label === TEMP_LABEL ||
          (subagentId !== undefined && label === convOf.get(subagentId)?.title)
        const target = targets[id]
        if (copied && target) {
          const name = nameOf(target, subagentId)
          if (name && name !== label) {
            state.label = name
            if (target.kind === 'temp' && target.name === TEMP_LABEL) target.name = name
            changed = true
          }
        }
      }
      if (changed) update.run(JSON.stringify(payload), row.id)
    }
    convOf.finalize()
    update.finalize()
  },
}
