/**
 * workflow 的推进器：给定这张图此刻的格状态与批准，算出**这一趟该派哪几格**、
 * 哪几格因为上游没成功而跳过、到了哪个检查点。
 *
 * **纯函数，不等任何一格。** 派出去、写状态、发回执由派活通道做；一格跑完它再调一次
 * 这里。并行只发生在同一批就绪节点之间，上限沿用首派那次的约定。
 *
 * 节点派给谁、怎么建、怎么续，全在派活通道：这里只管依赖、并发与检查点，
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

/** 加载期校验引用用的已知集合：角色 id、CLI id、本会话已有子 agent id。 */
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
  /** 一张图里同时最多几个节点在跑。由 workflow 首派参数决定，没有第二个来源。 */
  maxConcurrent: number
  /** 每一格最近一次状态。回执与「在不在跑」都从它读，没有第二份。 */
  states: Record<string, NodeState>
  approvals: Record<string, string>
  /** 这次调用带的审查动作。一格跑完后的推进不带。 */
  review?: OrchestratorReview
}

/** 一格要怎么派：目标与任务正文都算好了，派活通道照着发。 */
export interface NodeDispatch {
  nodeId: string
  target: SubagentTarget
  prompt: string
  provider?: string
  model?: string
}

export interface AdvanceResult {
  dispatch: NodeDispatch[]
  /** 上游没成功、这一趟直接判跳过的格。它们是终态，检查点据此往下走。 */
  skipped: { nodeId: string; state: NodeState }[]
  /** 依赖齐了但撞并发闸的格。 */
  queued: { nodeId: string; state: NodeState }[]
  /** 上游全部终态、还没批准的检查点。到了就发检查点回执。 */
  checkpoint: string | null
  /** 全部格终态、全部检查点已批准。 */
  completed: boolean
  /** 这次调用应用下去的审查，随转移落库。 */
  review?: WorkflowAppliedReview
}

const isCheckpoint = (node: PlanNode): node is WorkflowCheckpointNode => node.kind === 'checkpoint'
const isAgent = (node: PlanNode): node is WorkflowAgentNode => node.kind !== 'checkpoint'

/** 续接原子 agent 时，没有点名指令的那几格发这一句。 */
const RESUME_INSTRUCTION =
  '上游结果已被主会话要求修订。请重新核验原任务，并基于更新后的上游产出给出新版结果。'

/**
 * 推进一趟。**入参不被修改**：状态怎么落是调用方的事。
 *
 * 审查不成立（检查点不存在、重复批准、点名的格还没有终态）直接抛：那是模型写错了
 * 参数，要原样交回去，不能压成一句「工具执行出错」。
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
   * 上游没成功的格判跳过，而且跳过会传播：不判到不动为止的话，它下游那个检查点
   * 这一趟不会被判成就绪，图就停在没有人能推进的地方。
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
      // 依赖已经齐了却没启动，唯一原因就是并发闸。没有这一帧时图上只剩一格
      // 无说明的灰块，用户无法区分「正在排队」和「调度器漏掉了它」。
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
 * 批准或修订落到状态上。
 *
 * 三道前置条件只约束 approve：必须还没批准过、上游回执齐全、检查点存在。
 * revise 一条都不设：批准之后要能返工（否则一次 approve 等于解散整张图），
 * 上一轮被中断、只有部分节点留下回执时也要能对留下回执的那个续发。
 * revise 自己的前置条件是**被点名的格已经终态**——还在跑的格改不了，
 * 它的回执马上就到。
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
  if (!checkpoint) throw new Error(`找不到检查点 ${review.checkpointId}`)
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
      throw new Error(`节点 ${revision.nodeId} 还没有终态，等它的回执再修订`)
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
 * 一格派出去时的目标与任务正文。
 *
 * 格上留着子 agent id 又没有回执，说明它跑过、被 revise 作废了：向**原子 agent**
 * 续发，只发修订指令与最新上游产出。把整段任务再抄一遍会让它每一轮都从头读同一段话。
 *
 * **判据是这一格跑过没有，不是目标像不像已有子 agent。** 首次派给一个已有子 agent 的格
 * 要发它自己的 `task`——按目标判的话那段任务一个字都发不出去。
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
    // 续接已有子 agent 时模型跟着它自己的会话走，节点上的覆盖只在新建时生效。
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

/** 加载期挡住成环、悬空引用、引用不存在的目标，以及会绕过主会话检查点的分支。 */
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
  // 每个节点的成败都必须由某个检查点裁决。没有下游检查点的节点谁都没验收过，
  // 失败之后也没有回流入口。不需要验收的一次性派活归 subagent，不画图。
  for (const node of plan) {
    if (isCheckpoint(node)) continue
    if (!checkpoints.some((checkpoint) => ancestorOf(plan, node.id, checkpoint.id))) {
      throw new Error(`节点 ${node.id} 后面没有检查点，无法验收`)
    }
  }
}
