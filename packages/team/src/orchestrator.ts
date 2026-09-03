/**
 * 确定性的 workflow 调度器：并行只发生在同一批就绪 agent 之间；checkpoint
 * 一旦就绪就把回执交回父会话，不在后台替父会话作审批决定。
 */
import {
  type AgentEvent,
  type ConversationId,
  checkpointOutput,
  type RunId,
  revisionClosure,
  type WorkflowAgentNode,
  type WorkflowAppliedReview,
  type WorkflowCheckpointNode,
} from '@qywork/core'
import { runCli } from './cli-backend.ts'
import type { CliAgent, NodeResult, PlanNode, Role, TeamConfig } from './types.ts'
import { CLI_PREFIX } from './types.ts'

export interface OrchestratorDeps {
  workspaceRoot: string
  signal: AbortSignal
  secrets?: { values: string[] }
  resolveCli(id: string): CliAgent | undefined
  runBuiltin(input: {
    role: Role
    prompt: string
    signal: AbortSignal
    provider?: string
    model?: string
    existingConversationId?: ConversationId
    onConversation?: (conversationId: ConversationId) => void
  }): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }>
  emit(event: AgentEvent): void
  runId: RunId
  /** 一张图里同时最多几个 agent 节点在跑。由 workflow 首派参数决定，没有第二个来源。 */
  maxConcurrent: number
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
    private readonly config: TeamConfig,
    private readonly deps: OrchestratorDeps,
  ) {}

  async run(goal: string, state: OrchestratorState = {}): Promise<OrchestratorRunResult> {
    const plan = this.config.plan
    validatePlan(plan, this.config.roles)

    const results = new Map<string, NodeResult>(Object.entries(state.results ?? {}))
    const approvals = new Map<string, string>(Object.entries(state.approvals ?? {}))
    const receipts: NodeResult[] = []
    const priorForResume = new Map<string, NodeResult>()
    const correction = new Map<string, string>()
    let appliedReview: WorkflowAppliedReview | undefined

    if (state.review) {
      const review = state.review
      if (state.checkpointId !== review.checkpointId) {
        throw new Error(
          `当前待审查检查点是 ${state.checkpointId ?? '无'}，不是 ${review.checkpointId}`,
        )
      }
      const checkpoint = plan.find(
        (node): node is WorkflowCheckpointNode =>
          isCheckpoint(node) && node.id === review.checkpointId,
      )
      if (!checkpoint) throw new Error(`找不到检查点 ${review.checkpointId}`)
      if (approvals.has(checkpoint.id))
        throw new Error(`检查点 ${checkpoint.id} 已经批准，不能重复审查`)
      if (!checkpoint.needs.every((id) => this.dependencyResolved(id, results, approvals))) {
        throw new Error(`检查点 ${checkpoint.id} 的上游回执尚未齐全`)
      }

      appliedReview = {
        checkpointId: checkpoint.id,
        decision: review.decision,
        note: review.note,
      }
      if (review.decision === 'approve') {
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

        // 被修订节点和它在本批次内的下游都失效。先保留会话句柄，再删投影结果；
        // 这样是向原会话续发，不是另起一条看似相同的新任务。
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

      for (const node of ready) {
        if (running.size >= maxConcurrent) {
          // 依赖已经齐了却没启动，唯一原因就是并发闸。没有这一帧时图上只剩一格
          // 无说明的灰块，用户无法区分“正在排队”和“调度器漏掉了它”。
          if (!announcedQueued.has(node.id)) {
            announcedQueued.add(node.id)
            this.emitQueued(node)
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
            agent: node.agent,
            label: this.labelOf(node.agent),
            status: 'skipped',
            output: '',
            error: '上游节点未成功',
            durationMs: 0,
          }
          results.set(node.id, skipped)
          receipts.push(skipped)
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

      const unresolvedAgents = plan.filter(
        (node): node is WorkflowAgentNode => isAgent(node) && !results.has(node.id),
      )
      const unresolvedCheckpoints = plan.filter(
        (node) => isCheckpoint(node) && !approvals.has(node.id),
      )
      if (unresolvedAgents.length === 0 && unresolvedCheckpoints.length === 0) {
        const phase = [...results.values()].some((result) => result.status !== 'done')
          ? 'failed'
          : 'completed'
        return this.finish(phase, receipts, appliedReview)
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

  private emitQueued(node: WorkflowAgentNode): void {
    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: this.labelOf(node.agent),
      backend: node.agent.startsWith(CLI_PREFIX) ? 'custom' : 'builtin',
      phase: 'queued',
    })
  }

  private async execute(
    node: Exclude<PlanNode, WorkflowCheckpointNode>,
    goal: string,
    results: Map<string, NodeResult>,
    approvals: Map<string, string>,
    prior?: NodeResult,
    correction?: string,
  ): Promise<NodeResult> {
    const isCli = node.agent.startsWith(CLI_PREFIX)
    const cli = isCli ? this.deps.resolveCli(node.agent.slice(CLI_PREFIX.length)) : undefined
    const role = isCli
      ? undefined
      : this.config.roles.find((candidate) => candidate.id === node.agent)
    const label = this.labelOf(node.agent)
    const started = Date.now()

    if (!role && !cli)
      return this.failed(
        node,
        label,
        started,
        isCli ? `本机没有识别到 ${node.agent.slice(CLI_PREFIX.length)}` : '找不到这个角色',
      )
    if (prior && prior.status !== 'skipped') {
      if (cli && (!prior.session || !cli.resumeArgs)) {
        return {
          ...this.failed(node, label, started, `${node.agent} 的上一轮回执没有可续接会话`),
          ...(prior.session ? { session: prior.session } : {}),
        }
      }
      if (role && !prior.conversationId) {
        return this.failed(node, label, started, `${node.agent} 的上一轮回执没有可续接子会话`)
      }
    }

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
    const task = correction
      ? `## 主会话续发指令\n\n${correction}\n\n## 原任务与最新输入\n\n${originalTask}`
      : originalTask
    const prompt = role ? this.composePrompt(role, task) : task
    const backend = cli ? ('custom' as const) : ('builtin' as const)

    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: label,
      backend,
      phase: 'spawned',
    })
    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: label,
      backend,
      phase: 'working',
      ...(prior?.conversationId
        ? { childConversationId: prior.conversationId as ConversationId }
        : {}),
    })

    try {
      const res = cli
        ? await runCli(cli, {
            prompt,
            workspaceRoot: this.deps.workspaceRoot,
            signal: this.deps.signal,
            ...(prior?.session ? { resume: prior.session } : {}),
            ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
            onChunk: (delta) =>
              this.deps.emit({
                type: 'team.output',
                runId: this.deps.runId,
                memberId: node.id,
                delta,
              }),
          }).then((result) => ({
            ok: result.ok,
            output: result.output,
            error: result.ok
              ? undefined
              : result.timedOut
                ? '超时'
                : `退出码 ${result.exitCode}${result.stderr ? `：${result.stderr.slice(-500)}` : ''}`,
            ...(result.session ? { session: result.session } : {}),
          }))
        : await this.deps.runBuiltin({
            role: role!,
            prompt,
            signal: this.deps.signal,
            ...(node.provider ? { provider: node.provider } : {}),
            ...(node.model ? { model: node.model } : {}),
            ...(prior?.conversationId
              ? { existingConversationId: prior.conversationId as ConversationId }
              : {}),
            onConversation: (conversationId) =>
              this.deps.emit({
                type: 'team.member',
                runId: this.deps.runId,
                memberId: node.id,
                roleName: label,
                backend,
                phase: 'working',
                childConversationId: conversationId,
              }),
          })

      this.deps.emit({
        type: 'team.member',
        runId: this.deps.runId,
        memberId: node.id,
        roleName: label,
        backend,
        phase: res.ok ? 'done' : 'failed',
        summary: res.output.slice(0, 200),
        ...('conversationId' in res && res.conversationId
          ? { childConversationId: res.conversationId }
          : prior?.conversationId
            ? { childConversationId: prior.conversationId as ConversationId }
            : {}),
      })

      return {
        nodeId: node.id,
        agent: node.agent,
        label,
        status: res.ok ? 'done' : 'failed',
        output: res.output,
        ...(res.error ? { error: res.error } : {}),
        durationMs: Date.now() - started,
        ...('session' in res && res.session
          ? { session: res.session }
          : prior?.session
            ? { session: prior.session }
            : {}),
        ...('conversationId' in res && res.conversationId
          ? { conversationId: res.conversationId }
          : prior?.conversationId
            ? { conversationId: prior.conversationId }
            : {}),
      }
    } catch (error) {
      return {
        ...this.failed(
          node,
          label,
          started,
          error instanceof Error ? error.message : String(error),
        ),
        ...(prior?.session ? { session: prior.session } : {}),
        ...(prior?.conversationId ? { conversationId: prior.conversationId } : {}),
      }
    }
  }

  private failed(
    node: Exclude<PlanNode, WorkflowCheckpointNode>,
    label: string,
    started: number,
    error: string,
  ): NodeResult {
    return {
      nodeId: node.id,
      agent: node.agent,
      label,
      status: 'failed',
      output: '',
      error,
      durationMs: Date.now() - started,
    }
  }

  private labelOf(agent: string): string {
    if (agent.startsWith(CLI_PREFIX)) {
      const cli = this.deps.resolveCli(agent.slice(CLI_PREFIX.length))
      return cli ? `${cli.vendor} ${cli.id}` : agent
    }
    return this.config.roles.find((role) => role.id === agent)?.name ?? agent
  }

  private composePrompt(role: Role, task: string): string {
    const parts = [role.systemPrompt]
    if (this.config.rules?.shared) parts.push(this.config.rules.shared)
    parts.push(task)
    return parts.filter(Boolean).join('\n\n')
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

/** 加载期挡住成环、悬空引用，以及会绕过主会话检查点的分支。 */
export function validatePlan(plan: PlanNode[], roles: Role[]): void {
  const roleIds = new Set(roles.map((role) => role.id))
  const nodeIds = new Set(plan.map((node) => node.id))
  if (nodeIds.size !== plan.length) throw new Error('plan 节点 id 重复')

  for (const node of plan) {
    if (isCheckpoint(node)) {
      if (!node.label.trim()) throw new Error(`检查点 ${node.id} 没有 label`)
      if (node.needs.length === 0) throw new Error(`检查点 ${node.id} 必须依赖上一批节点`)
    } else if (!node.agent.startsWith(CLI_PREFIX) && !roleIds.has(node.agent)) {
      throw new Error(`节点 ${node.id} 引用了不存在的角色 ${node.agent}`)
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
}
