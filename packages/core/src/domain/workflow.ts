import type { NodePhase, NodeState, ToolOutcomeWire } from './model.ts'

export type WorkflowPhase = 'running' | 'waiting_review' | 'completed' | 'failed'

/** 子 agent 的三种创建方式：定义来自角色库、定义写在本次调用中、外部 CLI。 */
export type SubagentSpec =
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'temp'; name: string }
  | { kind: 'cli'; cli: string; name?: string }
export type SubagentKind = SubagentSpec['kind']
/** 三种种类的显示名称。提示词、回执文案与界面共用本词表，不另写第二份。 */
export const SUBAGENT_KIND_LABEL: Record<SubagentKind, string> = {
  role: '角色',
  temp: '临时',
  cli: '外部 CLI',
}
/** 派发对象：新建（按种类）或本会话已有的子 agent（按 id）。 */
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
  /** 该节点派发到的子 agent。记录未能创建时缺失。 */
  subagentId?: string
  label: string
  status: 'done' | 'failed' | 'skipped'
  output: string
  error?: string
  durationMs: number
  /** 派发时模型应知道的事实（续接失败、角色已不存在等），随回执返回。 */
  note?: string
}

export interface WorkflowRevision {
  nodeId: string
  instruction: string
}

/** 首次派发未指定 `maxConcurrent` 时同时运行的 agent 节点数。工具描述中写明的即为该值。 */
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
   * approve 时该检查点 needs 中状态不是 done 的节点。主会话接受了这些失败，
   * 工具回执必须列出它们，否则模型只看到「已完成」而不知道自己批准了哪些内容。
   */
  acceptedFailures?: { nodeId: string; reason: string }[]
}

/**
 * 一次 workflow 工具调用实际执行的操作：派发了哪些节点、批准或修订了什么。
 *
 * 此处不包含回执，也不包含 phase。派发后立即返回，调用结束时节点仍在运行；
 * 回执是节点状态（`NodeState`）的终态记录，phase 由 `foldWorkflow` 从节点状态与
 * 批准派生。在此另存一份将构成独立的第二份状态。
 */
export interface WorkflowTransition {
  workflowId: string
  /** 本次调用派发的节点。空数组表示本次没有可派发的节点，等待运行中节点的回执。 */
  dispatched: string[]
  review?: WorkflowAppliedReview
}

export interface WorkflowCallRecord {
  stepId: string
  args?: Record<string, unknown>
  outcome?: ToolOutcomeWire
  status?: 'running' | 'success' | 'failure'
  /** 本次调用中每个节点的状态，键是节点 id。被中断的调用没有回执，这是它留下的唯一节点事实。 */
  nodes?: Record<string, NodeState>
}

export interface WorkflowProjection {
  workflowId: string
  goal: string
  nodes: WorkflowNode[]
  /** 首次派发调用参数中的值。续接调用不再携带该值，调度并发始终按首次派发的约定。 */
  maxConcurrent: number
  /**
   * 派生值：某检查点上游全部为终态且未批准时为 `waiting_review`；全部批准且节点全部为终态时为
   * `completed`；首次派发调用自身失败时为 `failed`；其余为 `running`。不落库。
   */
  phase: WorkflowPhase
  /** `waiting_review` 时为待审查的检查点。 */
  checkpointId?: string
  /** 每个 agent 节点的回执，由终态节点状态折叠得出。 */
  results: Record<string, WorkflowReceipt>
  /** 每个节点的最近一次状态，按调用顺序折叠。界面绘图与回执都基于它。 */
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
 * 只在声明为结构化值的入口解码一层，解析失败时仍由原有校验报错。
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

/** 并发上限：缺省时返回默认值，非正整数返回 null，由调用方报错。 */
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
 * 种类由字段指定，id 取自运行上下文清单，两者互斥；两者都没有时视为未指定目标。
 */
export function parseSubagentTarget(raw: Record<string, unknown>): SubagentTargetParse {
  const kind = wireText(raw.kind)
  const role = wireText(raw.role)
  const name = wireText(raw.name)
  const cli = wireText(raw.cli)
  const subagent = wireText(raw.subagent)
  if (subagent) {
    if (kind || role || cli || name) {
      return { ok: false, error: '填写 subagent 时不能再填写 kind、role、name、cli' }
    }
    return { ok: true, target: { subagent } }
  }
  if (kind === 'role') {
    if (!role) return { ok: false, error: 'kind 为 role 时必须填写 role' }
    if (cli) return { ok: false, error: 'role 种类不能填写 cli' }
    return { ok: true, target: { kind: 'role', role, ...(name ? { name } : {}) } }
  }
  if (kind === 'temp') {
    if (!name) return { ok: false, error: 'kind 为 temp 时必须填写 name' }
    if (role || cli) return { ok: false, error: 'temp 种类不能填写 role 或 cli' }
    return { ok: true, target: { kind: 'temp', name } }
  }
  if (kind === 'cli') {
    if (!cli) return { ok: false, error: 'kind 为 cli 时必须填写 cli' }
    if (role) return { ok: false, error: 'cli 种类不能填写 role' }
    return { ok: true, target: { kind: 'cli', cli, ...(name ? { name } : {}) } }
  }
  return {
    ok: false,
    error: kind ? `kind 不支持 ${kind}` : '必须填写 kind（role / temp / cli）或 subagent',
  }
}

/** 节点名称，仅凭调用参数即可计算：刷新之后回放、进度事件到达之前都使用它。 */
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

/** strict wire 会补全 null；部分兼容端会补全 "null" 或把结构化值再次 JSON 编码。 */
export function parseWorkflowCall(args: Record<string, unknown>): WorkflowParseResult {
  const wireArgs: Record<string, unknown> = {
    ...args,
    nodes: structuredWireValue(args.nodes),
    revisions: structuredWireValue(args.revisions),
  }
  const hasWorkflow = !nullish(wireArgs.workflowId)
  // 有 workflowId 时，部分 strict 兼容端会为非本分支的 nodes 补全空数组。
  const hasNodes = !nullish(wireArgs.nodes) && !(hasWorkflow && omittedStructured(wireArgs.nodes))
  if (hasNodes === hasWorkflow) {
    return { ok: false, error: '首次派发必须只提供 nodes，审查动作必须只提供 workflowId' }
  }

  if (hasNodes) {
    for (const key of ['workflowId', 'checkpointId', 'decision', 'revisions']) {
      const omitted =
        key === 'revisions' ? omittedStructured(wireArgs[key]) : nullish(wireArgs[key])
      if (!omitted) {
        return {
          ok: false,
          error: `首次派发只填写 goal、nodes、maxConcurrent，workflowId、checkpointId、decision、note、revisions 均填 null；本次调用提供了 ${key}`,
        }
      }
    }
    const goal = wireText(wireArgs.goal)
    if (!goal) return { ok: false, error: '必须写明整张图要达成的目标（goal）' }
    const maxConcurrent = concurrencyOf(wireArgs.maxConcurrent)
    if (maxConcurrent === null) return { ok: false, error: 'maxConcurrent 必须是正整数' }
    if (!Array.isArray(wireArgs.nodes) || wireArgs.nodes.length === 0) {
      return { ok: false, error: '图中没有任何节点' }
    }
    const nodes: WorkflowNode[] = []
    const ids = new Set<string>()
    for (const raw of wireArgs.nodes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, error: '每个节点都必须是对象' }
      }
      const node = raw as Record<string, unknown>
      const id = wireText(node.id)
      if (!id) return { ok: false, error: '每个节点都必须有 id' }
      if (ids.has(id)) return { ok: false, error: `节点 id 重复：${id}` }
      ids.add(id)
      const needs = needsOf(node.needs)
      if (!needs) return { ok: false, error: `节点 ${id} 的 needs 必须是非空字符串数组` }
      if (wireText(node.kind) === 'checkpoint') {
        const label = wireText(node.label)
        if (!label) return { ok: false, error: `检查点 ${id} 必须有 label` }
        if (needs.length === 0) return { ok: false, error: `检查点 ${id} 必须依赖上一批节点` }
        // 扁平 strict schema 中 passInput 同时用于子 agent 节点；部分 provider 会把它
        // 补全为默认值 true，而不是 null。检查点不使用该字段，直接忽略：若因
        // 严格补全拒绝整张图，模型重试会在界面上留下另一张失败卡片。
        for (const key of ['role', 'name', 'cli', 'subagent', 'task', 'provider', 'model']) {
          if (!nullish(node[key])) return { ok: false, error: `检查点 ${id} 不能填写 ${key}` }
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
        return { ok: false, error: `节点 ${id} 指向已有子 agent，不能另行指定模型` }
      if (model && !('subagent' in target.target) && target.target.kind === 'cli')
        return { ok: false, error: `节点 ${id} 的外部 CLI 使用其自身的模型，不接受指定模型` }
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
    if (!omitted) return { ok: false, error: `审查动作不能填写 ${key}` }
  }
  const workflowId = wireText(wireArgs.workflowId)
  const checkpointId = wireText(wireArgs.checkpointId)
  const decision = wireText(wireArgs.decision)
  const note = wireText(wireArgs.note)
  if (!checkpointId) {
    return { ok: false, error: '审查动作必须填写 workflowId 和 checkpointId' }
  }
  if (decision !== 'approve' && decision !== 'revise') {
    return { ok: false, error: 'decision 只能是 approve 或 revise' }
  }
  if (decision === 'approve') {
    if (!omittedStructured(wireArgs.revisions)) {
      return { ok: false, error: 'approve 不能填写 revisions' }
    }
    return {
      ok: true,
      call: { kind: 'review', workflowId, checkpointId, decision, note, revisions: [] },
    }
  }
  if (!Array.isArray(wireArgs.revisions) || wireArgs.revisions.length === 0) {
    return { ok: false, error: 'revise 必须至少填写一条 revisions' }
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
      return { ok: false, error: '每条 revision 都必须有 nodeId 和 instruction' }
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
  if (!workflowId || !Array.isArray(data.dispatched)) return null
  const dispatched = data.dispatched.filter((id): id is string => typeof id === 'string')
  if (dispatched.length !== data.dispatched.length) return null
  const review = reviewLike(data.review) ? data.review : undefined
  return { workflowId, dispatched, ...(review ? { review } : {}) }
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

function ancestorOf(nodes: readonly WorkflowNode[], ancestor: string, nodeId: string): boolean {
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
 * revise 的失效范围。编排器与 `foldWorkflow` 必须调用同一实现，否则内存状态与回放投影不一致。
 *
 * 三步：撤销该检查点及其下游检查点的批准 · 作废下游全部 agent 节点结果 ·
 * 在该检查点的当前批次内按依赖传播作废选中节点及其后继。
 * 前提是批准可撤销：检查点批准之后仍必须能够回退修订。
 */
export function revisionClosure(
  nodes: readonly WorkflowNode[],
  checkpointId: string,
  approvedCheckpointIds: readonly string[],
  selectedNodeIds: readonly string[],
): RevisionClosureResult {
  const checkpoint = nodes.find(
    (node): node is WorkflowCheckpointNode =>
      node.kind === 'checkpoint' && node.id === checkpointId,
  )
  if (!checkpoint) return { ok: false, error: `未找到检查点 ${checkpointId}` }
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

/** 已落终态的节点：它有回执，下游可以继续执行。 */
const SETTLED_PHASES: ReadonlySet<NodePhase> = new Set(['done', 'failed', 'skipped', 'interrupted'])

export function nodeSettled(state: NodeState | undefined): boolean {
  return !!state && SETTLED_PHASES.has(state.phase)
}

/**
 * 把节点的终态折叠为回执。未落终态时返回 null。
 *
 * 回执只有这一个来源。工具返回值中没有第二份：派发后立即返回，此时尚无产出。
 */
export function nodeReceipt(
  node: WorkflowAgentNode,
  state: NodeState | undefined,
): WorkflowReceipt | null {
  if (!nodeSettled(state) || !state) return null
  const status = state.phase === 'done' ? 'done' : state.phase === 'skipped' ? 'skipped' : 'failed'
  const error = state.phase === 'interrupted' ? (state.error ?? '调用中断') : state.error
  return {
    nodeId: node.id,
    ...(state.subagentId ? { subagentId: state.subagentId } : {}),
    label: state.label || targetLabel(node.target),
    status,
    output: state.output ?? '',
    ...(error ? { error } : {}),
    durationMs: state.durationMs ?? 0,
    ...(state.note ? { note: state.note } : {}),
  }
}

/** 每个 agent 节点的回执，由终态节点状态折叠得出。 */
export function workflowResults(
  nodes: readonly WorkflowNode[],
  states: Record<string, NodeState>,
): Record<string, WorkflowReceipt> {
  const out: Record<string, WorkflowReceipt> = {}
  for (const node of nodes) {
    if (node.kind === 'checkpoint') continue
    const receipt = nodeReceipt(node, states[node.id])
    if (receipt) out[node.id] = receipt
  }
  return out
}

/**
 * 把 revise 应用到节点状态：作废的节点回到 `waiting`，保留子 agent 的 id：
 * 续发是向原子 agent 继续发送，而不是新建一个看似相同的任务。
 *
 * `foldWorkflow` 与推进器必须调用本函数，否则回放得到的投影与内存中的图不一致。
 */
export function applyRevision(
  nodes: readonly WorkflowNode[],
  states: Record<string, NodeState>,
  approvals: Record<string, string>,
  review: { checkpointId: string; revisions: readonly WorkflowRevision[] },
): { ok: true } | { ok: false; error: string } {
  const closure = revisionClosure(
    nodes,
    review.checkpointId,
    Object.keys(approvals),
    review.revisions.map((revision) => revision.nodeId),
  )
  if (!closure.ok) return { ok: false, error: closure.error }
  for (const id of closure.revokedCheckpointIds) delete approvals[id]
  for (const nodeId of closure.nodeIds) {
    const state = states[nodeId]
    if (!state) continue
    states[nodeId] = {
      phase: 'waiting',
      label: state.label,
      ...(state.kind ? { kind: state.kind } : {}),
      ...(state.subagentId ? { subagentId: state.subagentId } : {}),
    }
  }
  return { ok: true }
}

/** 链上第一个尚未批准且上游全部为终态的检查点。 */
export function readyCheckpoint(
  nodes: readonly WorkflowNode[],
  results: Record<string, WorkflowReceipt>,
  approvals: Record<string, string>,
): WorkflowCheckpointNode | null {
  const pending = nodes.filter(
    (node): node is WorkflowCheckpointNode => node.kind === 'checkpoint' && !approvals[node.id],
  )
  const ready = pending.filter((checkpoint) =>
    checkpoint.needs.every((id) => results[id] !== undefined || approvals[id] !== undefined),
  )
  return ready.find((c) => !ready.some((o) => o !== c && ancestorOf(nodes, o.id, c.id))) ?? null
}

/**
 * 从同一父会话中按时间排列的 workflow 调用重建投影。没有 I/O，也不保存状态。
 *
 * `phase` 与 `checkpointId` 是派生值：节点状态与批准是唯一权威，工具返回值中
 * 不记录它们。首次派发调用自身失败（进程退出、装配失败）是唯一的例外，此时没有节点状态可用。
 */
export function foldWorkflow(
  records: readonly WorkflowCallRecord[],
  workflowId: string,
): WorkflowFoldResult {
  const initial = records.find((record) => record.stepId === workflowId)
  if (!initial?.args) return { ok: false, error: `未找到工作流 ${workflowId} 的首次调用` }
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
  let startFailed = false

  for (const record of records) {
    if (workflowGroupId(record) !== workflowId) continue
    const transition = workflowTransitionOf(record.outcome)
    const parsedRecord = record.args ? parseWorkflowCall(record.args) : null
    const review =
      parsedRecord?.ok && parsedRecord.call.kind === 'review' ? parsedRecord.call : null
    if (review && review.workflowId !== workflowId) {
      return { ok: false, error: `步骤 ${record.stepId} 的 workflowId 与调用参数不一致` }
    }
    if (transition) {
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
    }
    /*
     * 仍在运行的调用按其参数计入。
     *
     * 派发后立即返回，之后任一节点执行完毕的回调随时会重建该投影，而此时发起它的
     * workflow 调用可能尚未落终态。不计入该调用时，刚批准的检查点在几毫秒内会被再次判定为
     * 「上游已齐、尚未批准」，同一检查点的回执因此发送两次。
     */
    const applied = transition?.review ?? (record.status === 'running' ? review : null)
    if (applied?.decision === 'approve') {
      const checkpoint = projection.nodes.find(
        (node): node is WorkflowCheckpointNode =>
          node.kind === 'checkpoint' && node.id === applied.checkpointId,
      )
      if (!checkpoint) return { ok: false, error: `未找到已批准的检查点 ${applied.checkpointId}` }
      projection.approvals[checkpoint.id] = checkpointOutput(
        checkpoint,
        workflowResults(projection.nodes, projection.states),
        applied.note,
      )
    }
    if (applied?.decision === 'revise' && review) {
      const revised = applyRevision(
        projection.nodes,
        projection.states,
        projection.approvals,
        review,
      )
      if (!revised.ok) return revised
    }
    /*
     * 本次调用写入的节点状态最后应用。
     *
     * 不要移到 revise 之前：revise 作废的是此前的节点，而重新派发的节点
     * 由同一条记录写入，先应用会被作废操作覆盖。
     */
    Object.assign(projection.states, record.nodes)
    // 首次派发没有 transition 且已落终态：本轮被进程退出或装配失败截断，图不会自动继续。
    if (record.status === 'failure' && record.stepId === workflowId) startFailed = true
  }

  projection.results = workflowResults(projection.nodes, projection.states)
  const ready = readyCheckpoint(projection.nodes, projection.results, projection.approvals)
  const allSettled = projection.nodes.every(
    (node) => node.kind === 'checkpoint' || projection.results[node.id] !== undefined,
  )
  const allApproved = projection.nodes.every(
    (node) => node.kind !== 'checkpoint' || projection.approvals[node.id] !== undefined,
  )
  if (startFailed) projection.phase = 'failed'
  else if (ready) {
    projection.phase = 'waiting_review'
    projection.checkpointId = ready.id
  } else if (allSettled && allApproved) projection.phase = 'completed'
  else projection.phase = 'running'
  return { ok: true, projection }
}
