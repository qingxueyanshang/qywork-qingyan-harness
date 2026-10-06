/**
 * workflow 的推进器：根据工作流图当前的节点状态与批准记录，计算**本次应派发的节点**、
 * 因上游未成功而跳过的节点，以及已到达的检查点。
 *
 * **纯函数，不等待任何节点。** 派发、写入状态、发送回执由派发通道完成；节点执行完毕后派发通道再次调用
 * 本函数。并行只发生在同一批就绪节点之间，上限沿用首次派发时的设定。
 *
 * 节点的派发目标、创建方式与续接方式全部由派发通道决定：此处只处理依赖、并发与检查点，
 * 不区分内置子 agent 与外部 CLI。
 */
import {
  applyRevision,
  checkpointOutput,
  type NodeState,
  readyCheckpoint,
  type SubagentTarget,
  targetLabel,
  type WorkflowAgentNode,
  type WorkflowAppliedReview,
  type WorkflowCheckpointNode,
  type WorkflowReceipt,
  workflowResults,
} from '@qywork/core'
import type { PlanNode } from './types.ts'

/** 加载期校验引用所用的已知集合：角色 id、CLI id、本会话已有的子 agent id。 */
export interface PlanKnown {
  roles: ReadonlySet<string>
  clis: ReadonlySet<string>
  subagents: ReadonlySet<string>
}

export interface OrchestratorReview {
  checkpointId: string
  decision: 'approve' | 'revise'
  note: string
  revisions: Array<{ nodeId: string; instruction: string }>
}

export interface AdvanceInput {
  plan: PlanNode[]
  goal: string
  /** 一张图中同时运行的节点数上限。由 workflow 首次派发的参数决定，没有第二个来源。 */
  maxConcurrent: number
  /** 每个节点的最近状态。回执与运行状态都从此读取，没有第二份。 */
  states: Record<string, NodeState>
  approvals: Record<string, string>
  /** 本次调用携带的审查动作。节点执行完毕后的推进不携带。 */
  review?: OrchestratorReview
}

/** 节点的派发内容：目标与任务正文均已计算完成，派发通道按此发送。 */
export interface NodeDispatch {
  nodeId: string
  target: SubagentTarget
  prompt: string
  provider?: string
  model?: string
}

export interface AdvanceResult {
  dispatch: NodeDispatch[]
  /** 因上游未成功而在本次判定为跳过的节点。跳过是终态，检查点据此继续推进。 */
  skipped: { nodeId: string; state: NodeState }[]
  /** 依赖已满足但受并发上限限制的节点。 */
  queued: { nodeId: string; state: NodeState }[]
  /** 上游全部到达终态、尚未批准的检查点。到达时发送检查点回执。 */
  checkpoint: string | null
  /** 全部节点到达终态，全部检查点已批准。 */
  completed: boolean
  /** 本次调用应用的审查，随状态转移写入数据库。 */
  review?: WorkflowAppliedReview
}

const isCheckpoint = (node: PlanNode): node is WorkflowCheckpointNode => node.kind === 'checkpoint'
const isAgent = (node: PlanNode): node is WorkflowAgentNode => node.kind !== 'checkpoint'

/** 续接原有子 agent 时，未指定指令的节点发送此句。 */
const RESUME_INSTRUCTION =
  '上游结果已被主会话要求修订。请重新核验原任务，并基于更新后的上游产出给出新版结果。'

/**
 * 推进一次。**不修改入参**：状态如何写入由调用方负责。
 *
 * 审查不成立（检查点不存在、重复批准、指定的节点尚未到达终态）时直接抛错：这是模型写错了
 * 参数，错误必须原样返回，不能简化为「工具执行出错」。
 */
export function advance(input: AdvanceInput): AdvanceResult {
  const { plan, goal, maxConcurrent } = input
  const states: Record<string, NodeState> = { ...input.states }
  const approvals: Record<string, string> = { ...input.approvals }
  const corrections = new Map<string, string>()
  let review: WorkflowAppliedReview | undefined

  if (input.review) {
    review = applyReview(plan, states, approvals, input.review, corrections)
  }

  let results = workflowResults(plan, states)
  const skipped: { nodeId: string; state: NodeState }[] = []
  /*
   * 上游未成功的节点判定为跳过，且跳过会向下传播：不迭代到结果不再变化时，其下游检查点
   * 本次不会被判定为就绪，图将停滞在无法推进的位置。
   */
  let changed = true
  while (changed) {
    changed = false
    for (const node of plan.filter(isAgent)) {
      if (results[node.id] || !dependenciesResolved(node, results, approvals)) continue
      if (!(node.needs ?? []).some((id) => results[id] && results[id]?.status !== 'done')) continue
      const state: NodeState = {
        ...(states[node.id] ?? { phase: 'waiting', label: targetLabel(node.target) }),
        phase: 'skipped',
        error: '上游节点未成功',
      }
      states[node.id] = state
      skipped.push({ nodeId: node.id, state })
      results = workflowResults(plan, states)
      changed = true
    }
  }

  const working = plan.filter(
    (node) => isAgent(node) && states[node.id]?.phase === 'working',
  ).length
  const dispatch: NodeDispatch[] = []
  const queued: { nodeId: string; state: NodeState }[] = []
  for (const node of plan.filter(isAgent)) {
    if (results[node.id] || states[node.id]?.phase === 'working') continue
    if (!dependenciesResolved(node, results, approvals)) continue
    if (working + dispatch.length >= maxConcurrent) {
      // 依赖已满足却未启动，唯一原因是并发上限。不发送该状态时图上只有一个
      // 无说明的灰色节点，用户无法区分正在排队与调度器遗漏。
      const prior = states[node.id]
      if (prior?.phase === 'queued') continue
      queued.push({
        nodeId: node.id,
        state: { ...(prior ?? { label: targetLabel(node.target) }), phase: 'queued' },
      })
      continue
    }
    dispatch.push(planDispatch(node, goal, results, approvals, states, corrections))
  }

  const checkpoint = readyCheckpoint(plan, results, approvals)
  const allSettled = plan.every((node) => !isAgent(node) || results[node.id] !== undefined)
  const allApproved = plan.every((node) => !isCheckpoint(node) || approvals[node.id] !== undefined)
  return {
    dispatch,
    skipped,
    queued,
    checkpoint: checkpoint?.id ?? null,
    completed: !checkpoint && allSettled && allApproved,
    ...(review ? { review } : {}),
  }
}

/**
 * 将批准或修订应用到状态上。
 *
 * 三项前置条件只约束 approve：尚未批准过、上游回执齐全、检查点存在。
 * revise 不设这三项：批准之后必须能够返工（否则一次 approve 即等于结束整张图），
 * 上一轮被中断、只有部分节点留下回执时，也必须能够对留下回执的节点续发。
 * revise 自身的前置条件是**被指定的节点已到达终态**：仍在运行的节点无法修订，
 * 其回执即将到达。
 */
function applyReview(
  plan: PlanNode[],
  states: Record<string, NodeState>,
  approvals: Record<string, string>,
  review: OrchestratorReview,
  corrections: Map<string, string>,
): WorkflowAppliedReview {
  const checkpoint = plan.find(
    (node): node is WorkflowCheckpointNode => isCheckpoint(node) && node.id === review.checkpointId,
  )
  if (!checkpoint) throw new Error(`未找到检查点 ${review.checkpointId}`)
  const results = workflowResults(plan, states)

  if (review.decision === 'approve') {
    if (approvals[checkpoint.id] !== undefined) {
      throw new Error(`检查点 ${checkpoint.id} 已经批准，不能重复审查`)
    }
    const missing = checkpoint.needs.filter(
      (id) => results[id] === undefined && approvals[id] === undefined,
    )
    if (missing.length) {
      throw new Error(`检查点 ${checkpoint.id} 的上游回执尚未齐全：${missing.join('、')}`)
    }
    const acceptedFailures = checkpoint.needs
      .map((id) => results[id])
      .filter((result): result is WorkflowReceipt => !!result && result.status !== 'done')
      .map((result) => ({ nodeId: result.nodeId, reason: result.error || `状态 ${result.status}` }))
    approvals[checkpoint.id] = checkpointOutput(checkpoint, results, review.note)
    return {
      checkpointId: checkpoint.id,
      decision: 'approve',
      note: review.note,
      ...(acceptedFailures.length ? { acceptedFailures } : {}),
    }
  }

  for (const revision of review.revisions) {
    if (!results[revision.nodeId]) {
      throw new Error(`节点 ${revision.nodeId} 尚无终态，收到其回执后再修订`)
    }
    corrections.set(revision.nodeId, revision.instruction)
  }
  const applied = applyRevision(plan, states, approvals, review)
  if (!applied.ok) throw new Error(applied.error)
  return { checkpointId: checkpoint.id, decision: 'revise', note: review.note }
}

function dependenciesResolved(
  node: WorkflowAgentNode,
  results: Record<string, WorkflowReceipt>,
  approvals: Record<string, string>,
): boolean {
  return (node.needs ?? []).every((id) => results[id] !== undefined || approvals[id] !== undefined)
}

/**
 * 节点派发时的目标与任务正文。
 *
 * 节点上保留子 agent id 而没有回执，说明该节点执行过且已被 revise 作废：向**原有子 agent**
 * 续发，只发送修订指令与最新上游产出。重复发送整段任务会使其每一轮都重新阅读同一段内容。
 *
 * **判据是该节点是否执行过，不是目标是否为已有子 agent。** 首次派发给已有子 agent 的节点
 * 必须发送节点自身的 `task`：按目标判定时该任务将完全无法发出。
 */
function planDispatch(
  node: WorkflowAgentNode,
  goal: string,
  results: Record<string, WorkflowReceipt>,
  approvals: Record<string, string>,
  states: Record<string, NodeState>,
  corrections: Map<string, string>,
): NodeDispatch {
  const resumeId = states[node.id]?.subagentId
  const target: SubagentTarget = resumeId ? { subagent: resumeId } : node.target
  const continuing = !!resumeId

  const upstream = (node.needs ?? [])
    .map((id) => results[id]?.output ?? approvals[id] ?? '')
    .filter(Boolean)
    .join('\n\n---\n\n')
  const wantsInput = node.passInput !== false && upstream !== ''

  const original = (): string => {
    const withGoal = node.task.replaceAll('{goal}', goal)
    if (withGoal.includes('{input}'))
      return withGoal.replaceAll('{input}', wantsInput ? upstream : '')
    return wantsInput ? `${withGoal}\n\n## 上游产出\n\n${upstream}` : withGoal
  }
  const prompt = continuing
    ? [
        corrections.get(node.id) ?? RESUME_INSTRUCTION,
        wantsInput ? `## 上游产出（最新）\n\n${upstream}` : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    : original()

  return {
    nodeId: node.id,
    target,
    prompt,
    // 续接已有子 agent 时模型沿用其会话的设置，节点上的覆盖只在新建时生效。
    ...(!continuing && node.provider ? { provider: node.provider } : {}),
    ...(!continuing && node.model ? { model: node.model } : {}),
  }
}

function ancestorOf(plan: PlanNode[], ancestor: string, nodeId: string): boolean {
  const seen = new Set<string>()
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false
    seen.add(id)
    const node = plan.find((candidate) => candidate.id === id)
    return (node?.needs ?? []).some((dependency) => dependency === ancestor || visit(dependency))
  }
  return visit(nodeId)
}

/** 在加载期拒绝成环、悬空引用、引用不存在的目标，以及会绕过主会话检查点的分支。 */
export function validatePlan(plan: PlanNode[], known: PlanKnown): void {
  const nodeIds = new Set(plan.map((node) => node.id))
  if (nodeIds.size !== plan.length) throw new Error('plan 节点 id 重复')

  for (const node of plan) {
    if (isCheckpoint(node)) {
      if (!node.label.trim()) throw new Error(`检查点 ${node.id} 没有 label`)
      if (node.needs.length === 0) throw new Error(`检查点 ${node.id} 必须依赖上一批节点`)
    } else {
      const target = node.target
      if ('subagent' in target) {
        if (!known.subagents.has(target.subagent))
          throw new Error(`节点 ${node.id} 指向的子 agent ${target.subagent} 不在本会话里`)
      } else if (target.kind === 'role' && !known.roles.has(target.role)) {
        throw new Error(`节点 ${node.id} 引用了不存在的角色 ${target.role}`)
      } else if (target.kind === 'cli' && !known.clis.has(target.cli)) {
        throw new Error(`节点 ${node.id} 引用了本机没有的外部 CLI ${target.cli}`)
      }
    }
    for (const dependency of node.needs ?? []) {
      if (!nodeIds.has(dependency))
        throw new Error(`节点 ${node.id} 依赖不存在的节点 ${dependency}`)
      if (dependency === node.id) throw new Error(`节点 ${node.id} 依赖自己`)
    }
  }

  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (id: string, trail: string[]): void => {
    const current = state.get(id)
    if (current === 'done') return
    if (current === 'visiting') throw new Error(`plan 存在循环依赖：${[...trail, id].join(' → ')}`)
    state.set(id, 'visiting')
    for (const dependency of plan.find((node) => node.id === id)?.needs ?? []) {
      walk(dependency, [...trail, id])
    }
    state.set(id, 'done')
  }
  for (const node of plan) walk(node.id, [])

  const checkpoints = plan.filter(isCheckpoint)
  for (let i = 0; i < checkpoints.length; i += 1) {
    for (let j = i + 1; j < checkpoints.length; j += 1) {
      const left = checkpoints[i]!
      const right = checkpoints[j]!
      if (!ancestorOf(plan, left.id, right.id) && !ancestorOf(plan, right.id, left.id)) {
        throw new Error(`检查点必须形成单链：${left.id} 与 ${right.id} 不能并行`)
      }
    }
  }
  for (const checkpoint of checkpoints) {
    for (const node of plan) {
      if (isCheckpoint(node)) continue
      if (!ancestorOf(plan, node.id, checkpoint.id) && !ancestorOf(plan, checkpoint.id, node.id)) {
        throw new Error(`节点 ${node.id} 会绕过检查点 ${checkpoint.id}`)
      }
    }
  }
  // 每个节点的成败都必须由某个检查点裁决。没有下游检查点的节点未经任何验收，
  // 失败之后也没有回流入口。不需要验收的一次性任务派发使用 subagent，不使用工作流图。
  for (const node of plan) {
    if (isCheckpoint(node)) continue
    if (!checkpoints.some((checkpoint) => ancestorOf(plan, node.id, checkpoint.id))) {
      throw new Error(`节点 ${node.id} 后面没有检查点，无法验收`)
    }
  }
}
