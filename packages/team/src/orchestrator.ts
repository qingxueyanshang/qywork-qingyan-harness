/**
 * 确定性的 workflow 调度器：并行只发生在同一批就绪节点之间；checkpoint
 * 一旦就绪就把回执交回父会话，不在后台替父会话作审批决定。
 *
 * 节点派给谁、怎么建、怎么续，全在实现方的 `dispatch`：编排器只管依赖、并发与回执，
 * 不区分内置子 agent 与外部 CLI。
 */
import {
  type ConversationId,
  checkpointOutput,
  type NodeState,
  type RunId,
  revisionClosure,
  type SubagentTarget,
  targetLabel,
  type WorkflowAgentNode,
  type WorkflowAppliedReview,
  type WorkflowCheckpointNode,
} from '@qywork/core'
import type { NodeResult, PlanNode } from './types.ts'

export interface OrchestratorDeps {
  signal: AbortSignal
  runId: RunId
  /** 一张图里同时最多几个节点在跑。由 workflow 首派参数决定，没有第二个来源。 */
  maxConcurrent: number
  /** 一格的状态变了。实现方负责写进卡片并广播；编排器只报事实。 */
  node(nodeId: string, state: NodeState): void
  /**
   * 一格的名字：角色是角色名，外部 CLI 是 CLI 名，临时子 agent 是它的模型名——节点上点了
   * 模型就是那个，没点就跟当前会话。写状态之前就要有；认不出目标返回 null。
   */
  describe(target: SubagentTarget, model?: string): { label: string } | null
  /**
   * 派给一个子 agent。目标是新建还是已有由 `target` 决定，实现方负责建记录与跑；
   * 编排器只拿回执与子 agent id。
   */
  dispatch(input: {
    nodeId: string
    target: SubagentTarget
    prompt: string
    signal: AbortSignal
    provider?: string
    model?: string
  }): Promise<{
    ok: boolean
    output: string
    error?: string
    subagentId?: string
    /** 派发方量的耗时，回执与卡上那一格都用它。 */
    durationMs?: number
  }>
}

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

export interface OrchestratorState {
  results?: Record<string, NodeResult>
  approvals?: Record<string, string>
  checkpointId?: string
  review?: OrchestratorReview
}

export interface OrchestratorRunResult {
  /** 只含本次工具调用实际产生的增量；累计状态由父会话 transcript 折叠。 */
  receipts: NodeResult[]
  phase: 'waiting_review' | 'completed' | 'failed'
  checkpointId?: string
  review?: WorkflowAppliedReview
}

const isCheckpoint = (node: PlanNode): node is WorkflowCheckpointNode => node.kind === 'checkpoint'
const isAgent = (node: PlanNode): node is WorkflowAgentNode => node.kind !== 'checkpoint'

export class TeamOrchestrator {
  constructor(
    private readonly plan: PlanNode[],
    private readonly deps: OrchestratorDeps,
    private readonly known: PlanKnown,
  ) {}

  async run(goal: string, state: OrchestratorState = {}): Promise<OrchestratorRunResult> {
    const plan = this.plan
    validatePlan(plan, this.known)

    const results = new Map<string, NodeResult>(Object.entries(state.results ?? {}))
    const approvals = new Map<string, string>(Object.entries(state.approvals ?? {}))
    const receipts: NodeResult[] = []
    const priorForResume = new Map<string, NodeResult>()
    const correction = new Map<string, string>()
    let appliedReview: WorkflowAppliedReview | undefined

    if (state.review) {
      const review = state.review
      const checkpoint = plan.find(
        (node): node is WorkflowCheckpointNode =>
          isCheckpoint(node) && node.id === review.checkpointId,
      )
      if (!checkpoint) throw new Error(`找不到检查点 ${review.checkpointId}`)
      /*
       * 三道前置条件只约束 approve：必须是当前检查点、不能重复批准、上游回执齐全。
       *
       * revise 一条都不设：批准之后要能返工（否则一次 approve 等于解散整张图），
       * 上一轮被中断、只有部分节点留下回执时也要能对留下回执的那个续发。
       * revise 自己的前置条件在下面——被修订节点必须有带子 agent id 的上一轮回执。
       */
      if (review.decision === 'approve') {
        if (state.checkpointId !== review.checkpointId) {
          throw new Error(
            `当前待审查检查点是 ${state.checkpointId ?? '无'}，不是 ${review.checkpointId}`,
          )
        }
        if (approvals.has(checkpoint.id))
          throw new Error(`检查点 ${checkpoint.id} 已经批准，不能重复审查`)
        if (!checkpoint.needs.every((id) => this.dependencyResolved(id, results, approvals))) {
          throw new Error(`检查点 ${checkpoint.id} 的上游回执尚未齐全`)
        }
      }

      appliedReview = {
        checkpointId: checkpoint.id,
        decision: review.decision,
        note: review.note,
      }
      if (review.decision === 'approve') {
        const acceptedFailures = checkpoint.needs
          .map((id) => results.get(id))
          .filter((result): result is NodeResult => !!result && result.status !== 'done')
          .map((result) => ({
            nodeId: result.nodeId,
            reason: result.error || `状态 ${result.status}`,
          }))
        if (acceptedFailures.length > 0) appliedReview = { ...appliedReview, acceptedFailures }
        approvals.set(
          checkpoint.id,
          checkpointOutput(checkpoint, Object.fromEntries(results), review.note),
        )
      } else {
        const closure = revisionClosure(
          plan,
          checkpoint.id,
          [...approvals.keys()],
          review.revisions.map((revision) => revision.nodeId),
        )
        if (!closure.ok) throw new Error(closure.error)
        for (const revision of review.revisions) {
          const prior = results.get(revision.nodeId)
          if (!prior) throw new Error(`节点 ${revision.nodeId} 没有可续接的上一轮回执`)
          correction.set(revision.nodeId, revision.instruction)
        }
        for (const id of closure.revokedCheckpointIds) approvals.delete(id)

        // 被修订节点和它在本批次内的下游都失效。先保留子 agent 句柄，再删投影结果；
        // 这样是向原子 agent 续发，不是另起一个看似相同的新任务。
        for (const id of closure.nodeIds) {
          const prior = results.get(id)
          if (prior) priorForResume.set(id, prior)
          results.delete(id)
          if (!correction.has(id)) {
            correction.set(
              id,
              '上游结果已被主会话要求修订。请重新核验原任务，并基于更新后的上游产出给出新版结果。',
            )
          }
        }
      }
    }

    // 图一开跑就把还没结果的格标成等待：刷新之后也看得见全貌，不只看见跑过的那几格。
    for (const node of plan) {
      if (isAgent(node) && !results.has(node.id)) {
        this.deps.node(node.id, { phase: 'waiting', label: this.labelOf(node) })
      }
    }

    const maxConcurrent = this.deps.maxConcurrent
    const running = new Map<string, Promise<void>>()
    const announcedQueued = new Set<string>()

    while (true) {
      if (this.deps.signal.aborted && running.size === 0) {
        return this.finish('failed', receipts, appliedReview)
      }

      const readyCheckpoints = plan.filter(
        (node): node is WorkflowCheckpointNode =>
          isCheckpoint(node) &&
          !approvals.has(node.id) &&
          node.needs.every((id) => this.dependencyResolved(id, results, approvals)),
      )
      if (readyCheckpoints.length > 1) {
        throw new Error(
          `同时有多个检查点就绪：${readyCheckpoints.map((node) => node.id).join('、')}`,
        )
      }
      if (readyCheckpoints.length === 1 && running.size === 0) {
        return this.finish('waiting_review', receipts, appliedReview, readyCheckpoints[0]!.id)
      }

      const ready = plan.filter(
        (node): node is WorkflowAgentNode =>
          isAgent(node) &&
          !results.has(node.id) &&
          !running.has(node.id) &&
          (node.needs ?? []).every((id) => this.dependencyResolved(id, results, approvals)),
      )

      // 跳过不经过 await，本轮没有任何 Promise 可等。不重新入循环的话，跳过的节点
      // 下游那个检查点这一轮不会被重新判定就绪，会被当成「依赖无法继续」抛出去。
      let skippedThisPass = false
      for (const node of ready) {
        if (running.size >= maxConcurrent) {
          // 依赖已经齐了却没启动，唯一原因就是并发闸。没有这一帧时图上只剩一格
          // 无说明的灰块，用户无法区分“正在排队”和“调度器漏掉了它”。
          if (!announcedQueued.has(node.id)) {
            announcedQueued.add(node.id)
            this.deps.node(node.id, { phase: 'queued', label: this.labelOf(node) })
          }
          continue
        }
        announcedQueued.delete(node.id)
        const upstreamFailed = (node.needs ?? []).some((id) => {
          const result = results.get(id)
          return result ? result.status !== 'done' : false
        })
        if (upstreamFailed) {
          const skipped: NodeResult = {
            nodeId: node.id,
            label: this.labelOf(node),
            status: 'skipped',
            output: '',
            error: '上游节点未成功',
            durationMs: 0,
          }
          results.set(node.id, skipped)
          receipts.push(skipped)
          this.deps.node(node.id, {
            phase: 'skipped',
            label: skipped.label,
            error: '上游节点未成功',
          })
          skippedThisPass = true
          continue
        }

        running.set(
          node.id,
          this.execute(
            node,
            goal,
            results,
            approvals,
            priorForResume.get(node.id),
            correction.get(node.id),
          ).then((result) => {
            results.set(node.id, result)
            receipts.push(result)
            running.delete(node.id)
          }),
        )
      }

      if (running.size > 0) {
        await Promise.race(running.values())
        continue
      }
      if (skippedThisPass) continue

      const unresolvedAgents = plan.filter(
        (node): node is WorkflowAgentNode => isAgent(node) && !results.has(node.id),
      )
      const unresolvedCheckpoints = plan.filter(
        (node) => isCheckpoint(node) && !approvals.has(node.id),
      )
      // 每个节点都在某个检查点下游（`validatePlan` 保证），所以走到这里说明每一份回执
      // 都已被某次 approve 接受或被 revise 重跑过。终态只由「是否被中断」决定，
      // 中断那条在循环开头返回 failed。
      if (unresolvedAgents.length === 0 && unresolvedCheckpoints.length === 0) {
        return this.finish('completed', receipts, appliedReview)
      }
      throw new Error(
        `依赖无法继续：${[...unresolvedAgents, ...unresolvedCheckpoints].map((node) => node.id).join('、')}`,
      )
    }
  }

  private finish(
    phase: OrchestratorRunResult['phase'],
    receipts: NodeResult[],
    review?: WorkflowAppliedReview,
    checkpointId?: string,
  ): OrchestratorRunResult {
    return {
      receipts,
      phase,
      ...(checkpointId ? { checkpointId } : {}),
      ...(review ? { review } : {}),
    }
  }

  private dependencyResolved(
    id: string,
    results: Map<string, NodeResult>,
    approvals: Map<string, string>,
  ): boolean {
    return results.has(id) || approvals.has(id)
  }

  private labelOf(node: WorkflowAgentNode): string {
    return this.deps.describe(node.target, node.model)?.label ?? targetLabel(node.target)
  }

  private async execute(
    node: WorkflowAgentNode,
    goal: string,
    results: Map<string, NodeResult>,
    approvals: Map<string, string>,
    prior?: NodeResult,
    correction?: string,
  ): Promise<NodeResult> {
    const started = Date.now()
    const described = this.deps.describe(node.target, node.model)
    if (!described) {
      return this.failed(node, targetLabel(node.target), started, '找不到派发目标')
    }
    const label = described.label

    // 上一轮跑过就续接同一个子 agent；没留下 id 的回执续不了，只能原样报出来。
    let target: SubagentTarget = node.target
    if (prior && prior.status !== 'skipped') {
      if (!prior.subagentId) {
        return this.failed(node, label, started, `${node.id} 的上一轮回执没有可续接的子 agent`)
      }
      target = { subagent: prior.subagentId }
    }
    const continuing = 'subagent' in target

    const upstream = (node.needs ?? [])
      .map((id) => results.get(id)?.output ?? approvals.get(id) ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n')
    const withGoal = node.task.replaceAll('{goal}', goal)
    const wantsInput = node.passInput !== false && upstream !== ''
    const originalTask = withGoal.includes('{input}')
      ? withGoal.replaceAll('{input}', wantsInput ? upstream : '')
      : wantsInput
        ? `${withGoal}\n\n## 上游产出\n\n${upstream}`
        : withGoal
    // 续接的子 agent 接的是它自己的会话，原任务早在它的历史里：只发修订指令与上游产出，
    // 不把整段任务再抄一遍——那会让它每一轮都从头读同一段话，卡上也一遍遍重复。
    const prompt = continuing
      ? [
          correction ?? '接着上一轮继续，把原任务做完。',
          wantsInput ? `## 上游产出（最新）\n\n${upstream}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : originalTask

    try {
      const res = await this.deps.dispatch({
        nodeId: node.id,
        target,
        prompt,
        signal: this.deps.signal,
        // 续接已有子 agent 时模型跟着它自己的会话走，节点上的覆盖只在新建时生效。
        ...(!continuing && node.provider ? { provider: node.provider } : {}),
        ...(!continuing && node.model ? { model: node.model } : {}),
      })
      const subagentId = res.subagentId ?? prior?.subagentId
      return {
        nodeId: node.id,
        ...(subagentId ? { subagentId } : {}),
        label,
        status: res.ok ? 'done' : 'failed',
        output: res.output,
        ...(res.error ? { error: res.error } : {}),
        // 耗时以派发方量的为准：卡上那一格印的就是它，回执不另量一次。
        durationMs: res.durationMs ?? Date.now() - started,
      }
    } catch (error) {
      return this.failed(
        node,
        label,
        started,
        error instanceof Error ? error.message : String(error),
        prior?.subagentId,
      )
    }
  }

  /** 派发之外的失败：目标不存在、续不了、派发方抛了异常。回执与卡上那一格一起落。 */
  private failed(
    node: WorkflowAgentNode,
    label: string,
    started: number,
    error: string,
    subagentId?: string,
  ): NodeResult {
    const durationMs = Date.now() - started
    this.deps.node(node.id, {
      phase: 'failed',
      label,
      durationMs,
      error,
      ...(subagentId ? { subagentId: subagentId as ConversationId } : {}),
    })
    return {
      nodeId: node.id,
      ...(subagentId ? { subagentId } : {}),
      label,
      status: 'failed',
      output: '',
      error,
      durationMs,
    }
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
