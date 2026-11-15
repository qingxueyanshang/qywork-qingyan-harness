import { type Migration, TEMP_LABEL } from './shared.ts'

/**
 * 旧的派发目标字段 `agent` 改为按 kind 记录：`ad-hoc` 与空值是临时子 agent，
 * `cli:<id>` 是外部 CLI，其余是角色 id。临时子 agent 的名字使用传入的后备名称。
 */
function kindFieldsOf(agent: unknown, fallbackName: string): Record<string, string> {
  if (typeof agent !== 'string' || agent === '' || agent === 'ad-hoc') {
    return { kind: 'temp', name: fallbackName }
  }
  if (agent.startsWith('cli:')) return { kind: 'cli', cli: agent.slice('cli:'.length) }
  return { kind: 'role', role: agent }
}

/**
 * 迁移 41 对单条派发任务 step 的改写。返回 false 表示该行已是新结构，无需写回。
 *
 * 回执中的逐节点终态是各节点状态的真值：续接调用缺少逐节点状态时由回执推导；
 * 首次派发的记录中由迁移 40 按 step 终态估算的状态，同样以回执为准。
 */
function rewriteDelegationPayload(payload: Record<string, unknown>, toolName: string): boolean {
  let changed = false
  const args = payload.args as Record<string, unknown> | undefined
  const nodes = (payload.nodes ?? {}) as Record<string, Record<string, unknown>>
  if (toolName === 'subagent' && args && 'agent' in args) {
    const { agent, ...rest } = args
    const target = kindFieldsOf(agent, TEMP_LABEL)
    payload.args = { ...target, ...rest }
    // 旧服务以任务正文作为临时子会话的标题，迁移 40 将其复制为节点名称，与卡片上的任务行重复。
    if (target.kind === 'temp' && nodes.child) nodes.child.label = TEMP_LABEL
    changed = true
  }
  if (toolName === 'workflow' && args && Array.isArray(args.nodes)) {
    args.nodes = args.nodes.map((raw) => {
      const node = raw as Record<string, unknown>
      if (node.kind === 'checkpoint' || !('agent' in node || node.kind === 'agent')) return node
      const { kind: _kind, agent, ...rest } = node
      changed = true
      return { ...kindFieldsOf(agent, TEMP_LABEL), ...rest }
    })
  }
  const data = (payload.outcome as { data?: Record<string, unknown> } | undefined)?.data
  const receipts = data?.receipts
  if (data && Array.isArray(receipts)) {
    const rewritten = receipts.map((raw) => {
      const receipt = raw as Record<string, unknown>
      if (!('agent' in receipt) && !('conversationId' in receipt)) return receipt
      const { agent: _agent, conversationId, ...rest } = receipt
      changed = true
      return {
        ...rest,
        ...(typeof conversationId === 'string' ? { subagentId: conversationId } : {}),
      }
    })
    data.receipts = rewritten
    for (const raw of rewritten) {
      const receipt = raw as Record<string, unknown>
      const id = typeof receipt.nodeId === 'string' ? receipt.nodeId : ''
      if (!id) continue
      const status = receipt.status
      const known = nodes[id]
      const subagentId =
        typeof receipt.subagentId === 'string' ? receipt.subagentId : known?.subagentId
      const state = {
        phase: status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : 'failed',
        label: typeof receipt.label === 'string' ? receipt.label : (known?.label ?? ''),
        ...(typeof subagentId === 'string' ? { subagentId } : {}),
        ...(typeof receipt.durationMs === 'number' ? { durationMs: receipt.durationMs } : {}),
        ...(typeof receipt.error === 'string' && receipt.error ? { error: receipt.error } : {}),
      }
      if (JSON.stringify(known) !== JSON.stringify(state)) {
        nodes[id] = state
        changed = true
      }
    }
    if (Object.keys(nodes).length) payload.nodes = nodes
  }
  const action = payload.action as { objectLabel?: string } | undefined
  if (action?.objectLabel === '编排') {
    action.objectLabel = '工作流'
    changed = true
  }
  return changed
}

export const migration041: Migration = {
  id: 41,
  name: 'delegation_kind_args',
  /**
   * 派发任务参数与回执改为按 kind 记录之后，旧行仍是旧结构：节点为 `kind: 'agent'` 加
   * `agent`（角色 id / `ad-hoc` / `cli:<id>`），单个派发的 `agent` 为空表示临时子 agent，
   * 回执带 `agent` 与 `conversationId`，卡片标题的对象名是「编排」。新解析器无法识别旧行，
   * 工作流图因此无法生成。旧行按同一规则改写；续接调用的逐节点状态由其回执推导。
   */
  apply(db) {
    const select = db.prepare<{ id: string; tool_name: string; payload: string }, []>(
      `SELECT id, tool_name, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent') AND payload IS NOT NULL`,
    )
    const rows = select.all()
    select.finalize()
    if (rows.length === 0) return
    const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      if (rewriteDelegationPayload(payload, row.tool_name)) {
        update.run(JSON.stringify(payload), row.id)
      }
    }
    update.finalize()
  },
}
