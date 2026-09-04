import type { NodeState, ToolOutcomeWire } from './model.ts'

export type WorkflowPhase = 'running' | 'waiting_review' | 'completed' | 'failed'

/** 子 agent 的三种建法：定义来自角色库、写在这次调用里、外部 CLI。 */
export type SubagentSpec =
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'temp'; name: string }
  | { kind: 'cli'; cli: string; name?: string }
export type SubagentKind = SubagentSpec['kind']
/** 派给谁：新建（按种类）或本会话已有的子 agent（按 id）。 */
export type SubagentTarget = SubagentSpec | { subagent: string }

export interface WorkflowAgentNode {
  id: string
  kind: 'subagent'
  target: SubagentTarget
  task: string
  needs?: string[]
  passInput?: boolean
  /** 与 model 配对的接口名；两列始终分开，不使用 `接口/模型` 拼接串。只在新建时生效。 */
  provider?: string
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
  /** 这一格派给的子 agent。连记录都没建成时缺席。 */
  subagentId?: string
  label: string
  status: 'done' | 'failed' | 'skipped'
  output: string
  error?: string
  durationMs: number
  /** 派发时模型该知道的事实（续接没接上、角色已不在等），随回执交回。 */
  note?: string
}

export interface WorkflowRevision {
  nodeId: string
  instruction: string
}

/** 首派没写 `maxConcurrent` 时同时跑几个 agent 节点。工具描述里写的就是这个值。 */
export const DEFAULT_MAX_CONCURRENT = 4

export type WorkflowCall =
  | { kind: 'start'; goal: string; nodes: WorkflowNode[]; maxConcurrent: number }
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
  /**
   * approve 时该检查点 needs 里状态非 done 的节点。主会话接受了这些失败，
   * 工具回执要把它们列出来，否则模型只看到「已完成」而不知道自己批了什么。
   */
  acceptedFailures?: { nodeId: string; reason: string }[]
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
  /** 这次调用里每一格的状态，键是节点 id。被打断的调用没有回执，这是它留下的唯一节点事实。 */
  nodes?: Record<string, NodeState>
}

export interface WorkflowProjection {
  workflowId: string
  goal: string
  nodes: WorkflowNode[]
  /** 首派调用参数里那个数。续接调用不再带它，调度并发始终按首派那次的约定。 */
  maxConcurrent: number
  phase: WorkflowPhase
  checkpointId?: string
  /** 每个 agent 节点最近一次回执。 */
  results: Record<string, WorkflowReceipt>
  /** 每一格最近一次状态，按调用顺序折叠。界面画图只认它，回执不参与。 */
  states: Record<string, NodeState>
  /** 已批准 checkpoint 的可传递输出。 */
  approvals: Record<string, string>
}

export type WorkflowParseResult = { ok: true; call: WorkflowCall } | { ok: false; error: string }

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const nullish = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && ['', 'null'].includes(value.trim().toLowerCase()))
const wireText = (value: unknown): string => (nullish(value) ? '' : text(value))
const omittedStructured = (value: unknown): boolean =>
  nullish(value) || (Array.isArray(value) && value.length === 0)

/**
 * 个别 OpenAI-compatible provider 会把 schema 中的数组再次 JSON 编码成字符串。
 * 只在声明为结构化值的入口解一层，解析失败仍交给原有校验报错。
 */
function structuredWireValue(value: unknown): unknown {
  if (nullish(value) || typeof value !== 'string') return value
  const source = value.trim()
  if (!source.startsWith('[') && !source.startsWith('{')) return value
  try {
    return JSON.parse(source)
  } catch {
    return value
  }
}

/** 并发上限：缺省回默认值，非正整数回 null 交给调用方报错。 */
function concurrencyOf(value: unknown): number | null {
  if (nullish(value)) return DEFAULT_MAX_CONCURRENT
  const n = typeof value === 'number' ? value : Number(text(value))
  return Number.isInteger(n) && n > 0 ? n : null
}

export type SubagentTargetParse =
  | { ok: true; target: SubagentTarget }
  | { ok: false; error: string }

/**
 * 派发目标：`subagent` 工具的参数与图节点共用同一套字段。
 * 种类在字段上，id 从运行上下文清单里抄，两者互斥；都没有就是没说清。
 */
export function parseSubagentTarget(raw: Record<string, unknown>): SubagentTargetParse {
  const kind = wireText(raw.kind)
  const role = wireText(raw.role)
  const name = wireText(raw.name)
  const cli = wireText(raw.cli)
  const subagent = wireText(raw.subagent)
  if (subagent) {
    if (kind || role || cli || name) {
      return { ok: false, error: '填了 subagent 就不再填 kind、role、name、cli' }
    }
    return { ok: true, target: { subagent } }
  }
  if (kind === 'role') {
    if (!role) return { ok: false, error: 'kind 是 role 时必须填 role' }
    if (cli) return { ok: false, error: 'role 种类不能填 cli' }
    return { ok: true, target: { kind: 'role', role, ...(name ? { name } : {}) } }
  }
  if (kind === 'temp') {
    if (!name) return { ok: false, error: 'kind 是 temp 时必须填 name' }
    if (role || cli) return { ok: false, error: 'temp 种类不能填 role 或 cli' }
    return { ok: true, target: { kind: 'temp', name } }
  }
  if (kind === 'cli') {
    if (!cli) return { ok: false, error: 'kind 是 cli 时必须填 cli' }
    if (role) return { ok: false, error: 'cli 种类不能填 role' }
    return { ok: true, target: { kind: 'cli', cli, ...(name ? { name } : {}) } }
  }
  return {
    ok: false,
    error: kind ? `kind 不支持 ${kind}` : '必须写 kind（role / temp / cli）或 subagent',
  }
}

/** 一格的名字，只凭调用参数就能算：刷新之后回放、进度事件没到之前都用它。 */
export function targetLabel(target: SubagentTarget): string {
  if ('subagent' in target) return target.subagent
  if (target.kind === 'temp') return target.name
  return target.name ?? (target.kind === 'role' ? target.role : target.cli)
}

function needsOf(value: unknown): string[] | null {
  if (nullish(value)) return []
  const structured = structuredWireValue(value)
  if (!Array.isArray(structured)) return null
  const out = structured.map(wireText)
  return out.every(Boolean) ? out : null
}

/** strict wire 会补 null；部分兼容端会补 "null" 或把结构值再次 JSON 编码。 */
export function parseWorkflowCall(args: Record<string, unknown>): WorkflowParseResult {
  const wireArgs: Record<string, unknown> = {
    ...args,
    nodes: structuredWireValue(args.nodes),
    revisions: structuredWireValue(args.revisions),
  }
  const hasWorkflow = !nullish(wireArgs.workflowId)
  // 有 workflowId 时，部分 strict 兼容端会给非本分支的 nodes 补空数组。
  const hasNodes = !nullish(wireArgs.nodes) && !(hasWorkflow && omittedStructured(wireArgs.nodes))
  if (hasNodes === hasWorkflow) {
    return { ok: false, error: '首次派发必须只带 nodes，审查动作必须只带 workflowId' }
  }

  if (hasNodes) {
    for (const key of ['workflowId', 'checkpointId', 'decision', 'revisions']) {
      const omitted =
        key === 'revisions' ? omittedStructured(wireArgs[key]) : nullish(wireArgs[key])
      if (!omitted) return { ok: false, error: `首次派发不能带 ${key}` }
    }
    const goal = wireText(wireArgs.goal)
    if (!goal) return { ok: false, error: '这张图整体要达成什么，得写清楚' }
    const maxConcurrent = concurrencyOf(wireArgs.maxConcurrent)
    if (maxConcurrent === null) return { ok: false, error: 'maxConcurrent 必须是正整数' }
    if (!Array.isArray(wireArgs.nodes) || wireArgs.nodes.length === 0) {
      return { ok: false, error: '图里一个节点都没有' }
    }
    const nodes: WorkflowNode[] = []
    const ids = new Set<string>()
    for (const raw of wireArgs.nodes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '每个节点都必须是对象' }
      }
      const node = raw as Record<string, unknown>
      const id = wireText(node.id)
      if (!id) return { ok: false, error: '每个节点都要有 id' }
      if (ids.has(id)) return { ok: false, error: `节点 id 重复：${id}` }
      ids.add(id)
      const needs = needsOf(node.needs)
      if (!needs) return { ok: false, error: `节点 ${id} 的 needs 必须是非空字符串数组` }
      if (wireText(node.kind) === 'checkpoint') {
        const label = wireText(node.label)
        if (!label) return { ok: false, error: `检查点 ${id} 必须有 label` }
        if (needs.length === 0) return { ok: false, error: `检查点 ${id} 必须依赖上一批节点` }
        // 扁平 strict schema 里 passInput 同时服务子 agent 节点；部分 provider 会把它
        // 补成默认 true，而不是 null。检查点不消费这个字段，忽略它即可——若因
        // 严格补全拒绝整张图，模型重试会在界面留下另一张失败卡。
        for (const key of ['role', 'name', 'cli', 'subagent', 'task', 'provider', 'model']) {
          if (!nullish(node[key])) return { ok: false, error: `检查点 ${id} 不能带 ${key}` }
        }
        nodes.push({ id, kind: 'checkpoint', label, needs })
        continue
      }
      const target = parseSubagentTarget(node)
      if (!target.ok) return { ok: false, error: `节点 ${id}：${target.error}` }
      const task = wireText(node.task)
      if (!task) return { ok: false, error: `节点 ${id} 必须有 task` }
      const provider = wireText(node.provider)
      const model = wireText(node.model)
      if (provider && !model)
        return { ok: false, error: `节点 ${id} 指定 provider 时必须同时指定 model` }
      if (model && 'subagent' in target.target)
        return { ok: false, error: `节点 ${id} 指向已有子 agent，不能再指定模型` }
      if (model && !('subagent' in target.target) && target.target.kind === 'cli')
        return { ok: false, error: `节点 ${id} 的外部 CLI 用它自己的模型` }
      nodes.push({
        id,
        kind: 'subagent',
        target: target.target,
        task,
        ...(needs.length ? { needs } : {}),
        ...(node.passInput === false ? { passInput: false } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      })
    }
    return { ok: true, call: { kind: 'start', goal, nodes, maxConcurrent } }
  }

  for (const key of ['goal', 'nodes', 'maxConcurrent']) {
    const omitted = key === 'nodes' ? omittedStructured(wireArgs[key]) : nullish(wireArgs[key])
    if (!omitted) return { ok: false, error: `审查动作不能带 ${key}` }
  }
  const workflowId = wireText(wireArgs.workflowId)
  const checkpointId = wireText(wireArgs.checkpointId)
  const decision = wireText(wireArgs.decision)
  const note = wireText(wireArgs.note)
  if (!workflowId || !checkpointId) {
    return { ok: false, error: '审查动作必须带 workflowId 和 checkpointId' }
  }
  if (decision !== 'approve' && decision !== 'revise') {
    return { ok: false, error: 'decision 只能是 approve 或 revise' }
  }
  if (decision === 'approve') {
    if (!omittedStructured(wireArgs.revisions)) {
      return { ok: false, error: 'approve 不能带 revisions' }
    }
    return {
      ok: true,
      call: { kind: 'review', workflowId, checkpointId, decision, note, revisions: [] },
    }
  }
  if (!Array.isArray(wireArgs.revisions) || wireArgs.revisions.length === 0) {
    return { ok: false, error: 'revise 必须带至少一条 revisions' }
  }
  const revisions: WorkflowRevision[] = []
  const revised = new Set<string>()
  for (const raw of wireArgs.revisions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: '每条 revision 都必须是对象' }
    }
    const row = raw as Record<string, unknown>
    const nodeId = wireText(row.nodeId)
    const instruction = wireText(row.instruction)
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
    (row.subagentId === undefined || typeof row.subagentId === 'string') &&
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

export type RevisionClosureResult =
  | { ok: true; nodeIds: string[]; revokedCheckpointIds: string[] }
  | { ok: false; error: string }

/**
 * revise 的失效范围。**编排器与 `foldWorkflow` 必须调用同一份**，否则内存状态与回放投影分叉。
 *
 * 三步：撤销该检查点及其下游检查点的批准 · 作废下游全部 agent 节点结果 ·
 * 在该检查点的当前批次内按依赖传播作废选中节点及其后继。
 * 批准可撤销是这里的前提——检查点批准之后仍要能回流。
 */
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
  const revokedCheckpointIds = approvedCheckpointIds.filter(
    (id) => id === checkpoint.id || ancestorOf(nodes, checkpoint.id, id),
  )
  const stillApproved = approvedCheckpointIds.filter((id) => !revokedCheckpointIds.includes(id))
  const agentNodes = nodes.filter((node): node is WorkflowAgentNode => node.kind !== 'checkpoint')
  const revisable = new Set(
    agentNodes
      .filter((node) => ancestorOf(nodes, node.id, checkpoint.id))
      .filter((node) => !stillApproved.some((approved) => ancestorOf(nodes, node.id, approved)))
      .map((node) => node.id),
  )
  const invalidated = new Set<string>(
    agentNodes.filter((node) => ancestorOf(nodes, checkpoint.id, node.id)).map((node) => node.id),
  )
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
  return { ok: true, nodeIds: [...invalidated], revokedCheckpointIds }
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
    maxConcurrent: parsed.call.maxConcurrent,
    phase: 'running',
    results: {},
    states: {},
    approvals: {},
  }

  for (const record of records) {
    if (workflowGroupId(record) !== workflowId) continue
    const transition = workflowTransitionOf(record.outcome)
    Object.assign(projection.states, record.nodes)
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
      for (const id of closure.revokedCheckpointIds) delete projection.approvals[id]
      for (const nodeId of closure.nodeIds) delete projection.results[nodeId]
    }
    if (!transition) {
      if (record.status === 'running' && record.stepId !== workflowId) projection.phase = 'running'
      if (record.status === 'failure') {
        // 被打断的调用没有回执，`nodes` 是它留下的唯一节点事实：建过子 agent 的格折出
        // 「调用中断」回执，revise 才找得到要续的会话。
        for (const [nodeId, state] of Object.entries(record.nodes ?? {})) {
          if (!state.subagentId) continue
          const node = projection.nodes.find(
            (candidate): candidate is WorkflowAgentNode =>
              candidate.kind !== 'checkpoint' && candidate.id === nodeId,
          )
          if (!node) continue
          projection.results[nodeId] = {
            nodeId,
            subagentId: state.subagentId,
            label: state.label || targetLabel(node.target),
            status: 'failed',
            output: '',
            error: '调用中断',
            durationMs: state.durationMs ?? 0,
          }
        }
        // 首派没有 transition 又已落终态：这一轮被进程退出或装配失败截断，图不会自己继续。
        // 不投影成 failed 的话它永远停在 running，approve 只能收到「当前不是待审查状态」。
        if (record.stepId === workflowId) projection.phase = 'failed'
      }
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
      }
    }
    projection.phase = transition.phase
    if (transition.checkpointId) projection.checkpointId = transition.checkpointId
    else delete projection.checkpointId
  }
  return { ok: true, projection }
}
