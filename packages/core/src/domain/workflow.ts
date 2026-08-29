import type { ToolOutcomeWire } from './model.ts'

export type WorkflowPhase = 'running' | 'waiting_review' | 'completed' | 'failed'

export interface WorkflowAgentNode {
  id: string
  /** 旧的内部 team 配置可省略；工具入口会统一规范成 agent。 */
  kind?: 'agent'
  agent: string
  task: string
  needs?: string[]
  passInput?: boolean
  model?: string
}

export interface WorkflowCheckpointNode {
  id: string
  kind: 'checkpoint'
  label: string
  needs: string[]
}

export type WorkflowNode = WorkflowAgentNode | WorkflowCheckpointNode

export interface WorkflowReceipt {
  nodeId: string
  agent: string
  label: string
  status: 'done' | 'failed' | 'skipped'
  output: string
  error?: string
  durationMs: number
  session?: string
  conversationId?: string
}

export interface WorkflowRevision {
  nodeId: string
  instruction: string
}

export type WorkflowCall =
  | { kind: 'start'; goal: string; nodes: WorkflowNode[] }
  | {
      kind: 'review'
      workflowId: string
      checkpointId: string
      decision: 'approve' | 'revise'
      note: string
      revisions: WorkflowRevision[]
    }

export interface WorkflowAppliedReview {
  checkpointId: string
  decision: 'approve' | 'revise'
  note: string
}

/**
 * 一次 workflow 工具调用真正落下的状态转移。只记这一轮，不记累计快照。
 */
export interface WorkflowTransition {
  workflowId: string
  phase: Exclude<WorkflowPhase, 'running'>
  checkpointId?: string
  receipts: WorkflowReceipt[]
  review?: WorkflowAppliedReview
}

export interface WorkflowCallRecord {
  stepId: string
  args?: Record<string, unknown>
  outcome?: ToolOutcomeWire
  status?: 'running' | 'success' | 'failure'
}

export interface WorkflowProjection {
  workflowId: string
  goal: string
  nodes: WorkflowNode[]
  phase: WorkflowPhase
  checkpointId?: string
  /** 每个 agent 节点最近一次回执。 */
  results: Record<string, WorkflowReceipt>
  /** 每个 agent 节点累计真实执行次数，由回执序列折叠，不单独持久化。 */
  attempts: Record<string, number>
  /** 已批准 checkpoint 的可传递输出。 */
  approvals: Record<string, string>
}

export type WorkflowParseResult = { ok: true; call: WorkflowCall } | { ok: false; error: string }

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const nullish = (value: unknown): boolean => value === undefined || value === null

function needsOf(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const out = value.map(text)
  return out.every(Boolean) ? out : null
}

/** strict wire 会把源码层可选字段补成 null；所有判别都按非 null 值。 */
export function parseWorkflowCall(args: Record<string, unknown>): WorkflowParseResult {
  const hasNodes = !nullish(args.nodes)
  const hasWorkflow = !nullish(args.workflowId)
  if (hasNodes === hasWorkflow) {
    return { ok: false, error: '首次派发必须只带 nodes，审查动作必须只带 workflowId' }
  }

  if (hasNodes) {
    for (const key of ['workflowId', 'checkpointId', 'decision', 'revisions']) {
      if (!nullish(args[key])) return { ok: false, error: `首次派发不能带 ${key}` }
    }
    const goal = text(args.goal)
    if (!goal) return { ok: false, error: '这张图整体要达成什么，得写清楚' }
    if (!Array.isArray(args.nodes) || args.nodes.length === 0) {
      return { ok: false, error: '图里一个节点都没有' }
    }
    const nodes: WorkflowNode[] = []
    const ids = new Set<string>()
    for (const raw of args.nodes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '每个节点都必须是对象' }
      }
      const node = raw as Record<string, unknown>
      const id = text(node.id)
      if (!id) return { ok: false, error: '每个节点都要有 id' }
      if (ids.has(id)) return { ok: false, error: `节点 id 重复：${id}` }
      ids.add(id)
      const kind = nullish(node.kind) ? 'agent' : text(node.kind)
      const needs = needsOf(node.needs)
      if (!needs) return { ok: false, error: `节点 ${id} 的 needs 必须是非空字符串数组` }
      if (kind === 'checkpoint') {
        const label = text(node.label)
        if (!label) return { ok: false, error: `检查点 ${id} 必须有 label` }
        if (needs.length === 0) return { ok: false, error: `检查点 ${id} 必须依赖上一批节点` }
        // 扁平 strict schema 里 passInput 同时服务 agent 节点；部分 provider 会把它
        // 补成默认 true，而不是 null。检查点不消费这个字段，忽略它即可——若因
        // 严格补全拒绝整张图，模型重试会在界面留下另一张失败卡。
        for (const key of ['agent', 'task', 'model']) {
          if (!nullish(node[key])) return { ok: false, error: `检查点 ${id} 不能带 ${key}` }
        }
        nodes.push({ id, kind: 'checkpoint', label, needs })
        continue
      }
      if (kind !== 'agent') return { ok: false, error: `节点 ${id} 的 kind 不支持 ${kind}` }
      const task = text(node.task)
      if (!task) return { ok: false, error: `节点 ${id} 必须有 task` }
      const agent = text(node.agent) || 'ad-hoc'
      const model = text(node.model)
      nodes.push({
        id,
        kind: 'agent',
        agent,
        task,
        ...(needs.length ? { needs } : {}),
        ...(node.passInput === false ? { passInput: false } : {}),
        ...(model ? { model } : {}),
      })
    }
    return { ok: true, call: { kind: 'start', goal, nodes } }
  }

  for (const key of ['goal', 'nodes']) {
    if (!nullish(args[key])) return { ok: false, error: `审查动作不能带 ${key}` }
  }
  const workflowId = text(args.workflowId)
  const checkpointId = text(args.checkpointId)
  const decision = text(args.decision)
  const note = text(args.note)
  if (!workflowId || !checkpointId) {
    return { ok: false, error: '审查动作必须带 workflowId 和 checkpointId' }
  }
  if (decision !== 'approve' && decision !== 'revise') {
    return { ok: false, error: 'decision 只能是 approve 或 revise' }
  }
  if (decision === 'approve') {
    if (!nullish(args.revisions)) return { ok: false, error: 'approve 不能带 revisions' }
    return {
      ok: true,
      call: { kind: 'review', workflowId, checkpointId, decision, note, revisions: [] },
    }
  }
  if (!Array.isArray(args.revisions) || args.revisions.length === 0) {
    return { ok: false, error: 'revise 必须带至少一条 revisions' }
  }
  const revisions: WorkflowRevision[] = []
  const revised = new Set<string>()
  for (const raw of args.revisions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: '每条 revision 都必须是对象' }
    }
    const row = raw as Record<string, unknown>
    const nodeId = text(row.nodeId)
    const instruction = text(row.instruction)
    if (!nodeId || !instruction)
      return { ok: false, error: '每条 revision 都要有 nodeId 和 instruction' }
    if (revised.has(nodeId)) return { ok: false, error: `revision 节点重复：${nodeId}` }
    revised.add(nodeId)
    revisions.push({ nodeId, instruction })
  }
  return {
    ok: true,
    call: { kind: 'review', workflowId, checkpointId, decision, note, revisions },
  }
}

export function workflowGroupId(
  record: Pick<WorkflowCallRecord, 'stepId' | 'args' | 'outcome'>,
): string {
  return text(record.args?.workflowId) || text(record.outcome?.data?.workflowId) || record.stepId
}

export function workflowTransitionOf(
  outcome: ToolOutcomeWire | undefined,
): WorkflowTransition | null {
  const data = outcome?.data
  if (!data || typeof data !== 'object') return null
  const workflowId = text(data.workflowId)
  const phase = data.phase
  if (
    !workflowId ||
    (phase !== 'waiting_review' && phase !== 'completed' && phase !== 'failed') ||
    !Array.isArray(data.receipts)
  ) {
    return null
  }
  const receipts = data.receipts.filter(receiptLike) as WorkflowReceipt[]
  if (receipts.length !== data.receipts.length) return null
  const checkpointId = text(data.checkpointId)
  const review = reviewLike(data.review) ? data.review : undefined
  return {
    workflowId,
    phase,
    receipts,
    ...(checkpointId ? { checkpointId } : {}),
    ...(review ? { review } : {}),
  }
}

function receiptLike(value: unknown): value is WorkflowReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    !!text(row.nodeId) &&
    typeof row.agent === 'string' &&
    typeof row.label === 'string' &&
    (row.status === 'done' || row.status === 'failed' || row.status === 'skipped') &&
    typeof row.output === 'string' &&
    typeof row.durationMs === 'number'
  )
}

function reviewLike(value: unknown): value is WorkflowAppliedReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return (
    !!text(row.checkpointId) &&
    (row.decision === 'approve' || row.decision === 'revise') &&
    typeof row.note === 'string'
  )
}

export function checkpointOutput(
  checkpoint: WorkflowCheckpointNode,
  results: Record<string, WorkflowReceipt>,
  note: string,
): string {
  const accepted = checkpoint.needs
    .map((id) => {
      const result = results[id]
      if (!result) return ''
      const body = result.output || result.error || '无产出'
      return `### ${id}\n${body}`
    })
    .filter(Boolean)
    .join('\n\n')
  return [note ? `## 主会话审查\n${note}` : '', accepted ? `## 已接受的上游回执\n${accepted}` : '']
    .filter(Boolean)
    .join('\n\n')
}

function ancestorOf(nodes: WorkflowNode[], ancestor: string, nodeId: string): boolean {
  const seen = new Set<string>()
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    const node = nodes.find((candidate) => candidate.id === id)
    return (node?.needs ?? []).some((dependency) => dependency === ancestor || visit(dependency))
  }
  return visit(nodeId)
}

export type RevisionClosureResult = { ok: true; nodeIds: string[] } | { ok: false; error: string }

/** revise 的失效范围：选中节点及其在当前检查点前的后继。server 与 UI 共用。 */
export function revisionClosure(
  nodes: WorkflowNode[],
  checkpointId: string,
  approvedCheckpointIds: readonly string[],
  selectedNodeIds: readonly string[],
): RevisionClosureResult {
  const checkpoint = nodes.find(
    (node): node is WorkflowCheckpointNode =>
      node.kind === 'checkpoint' && node.id === checkpointId,
  )
  if (!checkpoint) return { ok: false, error: `找不到检查点 ${checkpointId}` }
  const revisable = new Set(
    nodes
      .filter((node): node is WorkflowAgentNode => node.kind !== 'checkpoint')
      .filter((node) => ancestorOf(nodes, node.id, checkpoint.id))
      .filter(
        (node) => !approvedCheckpointIds.some((approved) => ancestorOf(nodes, node.id, approved)),
      )
      .map((node) => node.id),
  )
  const invalidated = new Set<string>()
  for (const nodeId of selectedNodeIds) {
    if (!revisable.has(nodeId)) {
      return { ok: false, error: `节点 ${nodeId} 不属于检查点 ${checkpoint.id} 的当前批次` }
    }
    invalidated.add(nodeId)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (node.kind === 'checkpoint' || !revisable.has(node.id) || invalidated.has(node.id))
        continue
      if ((node.needs ?? []).some((id) => invalidated.has(id))) {
        invalidated.add(node.id)
        changed = true
      }
    }
  }
  return { ok: true, nodeIds: [...invalidated] }
}

export type WorkflowFoldResult =
  | { ok: true; projection: WorkflowProjection }
  | { ok: false; error: string }

/**
 * 从同一父会话里按时间排列的 workflow 调用重建投影。没有 I/O，也不保存状态。
 */
export function foldWorkflow(
  records: readonly WorkflowCallRecord[],
  workflowId: string,
): WorkflowFoldResult {
  const initial = records.find((record) => record.stepId === workflowId)
  if (!initial?.args) return { ok: false, error: `找不到工作流 ${workflowId} 的首次调用` }
  const parsed = parseWorkflowCall(initial.args)
  if (!parsed.ok || parsed.call.kind !== 'start') {
    return { ok: false, error: `工作流 ${workflowId} 的首次调用无效` }
  }
  const projection: WorkflowProjection = {
    workflowId,
    goal: parsed.call.goal,
    nodes: parsed.call.nodes,
    phase: 'running',
    results: {},
    attempts: {},
    approvals: {},
  }

  for (const record of records) {
    if (workflowGroupId(record) !== workflowId) continue
    const transition = workflowTransitionOf(record.outcome)
    const parsedRecord = record.args ? parseWorkflowCall(record.args) : null
    const review =
      parsedRecord?.ok && parsedRecord.call.kind === 'review' ? parsedRecord.call : null
    if (review?.workflowId !== workflowId) {
      if (review)
        return { ok: false, error: `步骤 ${record.stepId} 的 workflowId 与调用参数不一致` }
    }
    if (review?.decision === 'revise' && (transition || record.status === 'running')) {
      const closure = revisionClosure(
        projection.nodes,
        review.checkpointId,
        Object.keys(projection.approvals),
        review.revisions.map((revision) => revision.nodeId),
      )
      if (!closure.ok) return closure
      for (const nodeId of closure.nodeIds) delete projection.results[nodeId]
    }
    if (!transition) {
      if (record.status === 'running' && record.stepId !== workflowId) projection.phase = 'running'
      continue
    }
    if (transition.workflowId !== workflowId) {
      return { ok: false, error: `步骤 ${record.stepId} 的 workflowId 与调用参数不一致` }
    }
    if (
      transition.review &&
      (!review ||
        review.checkpointId !== transition.review.checkpointId ||
        review.decision !== transition.review.decision ||
        review.note !== transition.review.note)
    ) {
      return { ok: false, error: `步骤 ${record.stepId} 的审查参数与结果不一致` }
    }
    if (transition.review?.decision === 'approve') {
      const checkpoint = projection.nodes.find(
        (node): node is WorkflowCheckpointNode =>
          node.kind === 'checkpoint' && node.id === transition.review?.checkpointId,
      )
      if (!checkpoint)
        return { ok: false, error: `找不到已批准的检查点 ${transition.review.checkpointId}` }
      projection.approvals[checkpoint.id] = checkpointOutput(
        checkpoint,
        projection.results,
        transition.review.note,
      )
    }
    for (const receipt of transition.receipts) {
      projection.results[receipt.nodeId] = receipt
      if (receipt.status !== 'skipped') {
        projection.attempts[receipt.nodeId] = (projection.attempts[receipt.nodeId] ?? 0) + 1
      }
    }
    projection.phase = transition.phase
    if (transition.checkpointId) projection.checkpointId = transition.checkpointId
    else delete projection.checkpointId
  }
  return { ok: true, projection }
}
