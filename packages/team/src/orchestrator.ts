/**
 * 编排器。
 *
 * 按依赖图跑角色，尊重并发上限与人工门禁。
 *
 * 一条刻意的设计取舍：**编排是确定性的代码，不是让某个模型自由发挥。**
 * 依赖顺序、并发数、门禁位置都由配置固定。模型只负责节点内的工作，
 * 不负责决定「下一步该谁上」——把调度也交给模型，出问题时无法复现也无法归因。
 */

import type { AgentEvent, ConversationId, RunId } from '@qywork/core'
import { runCli } from './cli-backend.ts'
import type { NodeResult, PlanNode, Role, TeamConfig, TeamRules } from './types.ts'

export interface OrchestratorDeps {
  workspaceRoot: string
  signal: AbortSignal
  /**
   * qywork 自己的凭证，交给外部 CLI 后端之前按值剥掉。
   *
   * 后端需要**它自己**的 key（codex 要 OPENAI_API_KEY），所以不能按名字剥；
   * 但用户配在 qywork 里的那几把它一把都用不上，没有理由拿到。
   * 不传等于「没有已知凭证」，不等于「不用剥」——装配方应当始终提供。
   */
  secrets?: { values: string[] }
  /** 内置后端的执行入口：跑一个子会话并返回最终文本。 */
  runBuiltin(input: {
    role: Role
    prompt: string
    signal: AbortSignal
  }): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }>
  /** 人工门禁：返回 false 即中止整轮。 */
  awaitHumanGate(nodeId: string, summary: string): Promise<boolean>
  emit(event: AgentEvent): void
  runId: RunId
}

export class TeamOrchestrator {
  constructor(
    private readonly config: TeamConfig,
    private readonly deps: OrchestratorDeps,
  ) {}

  async run(goal: string): Promise<NodeResult[]> {
    const plan = this.resolvePlan()
    validatePlan(plan, this.config.roles, this.config.rules)

    const results = new Map<string, NodeResult>()
    const maxConcurrent = this.config.rules?.maxConcurrent ?? 3
    const gates = new Set(this.config.rules?.humanGates ?? [])

    const pending = new Set(plan.map((n) => n.id))
    const running = new Map<string, Promise<void>>()

    while (pending.size > 0 || running.size > 0) {
      if (this.deps.signal.aborted) break

      // 依赖全部完成的节点才可以启动。上游失败则本节点跳过——
      // 拿着失败的上游输出继续跑，产出的是看起来合理实则无根的结果。
      const ready = [...pending].filter((id) => {
        const node = plan.find((n) => n.id === id)!
        return (node.needs ?? []).every((dep) => results.has(dep))
      })

      for (const id of ready) {
        if (running.size >= maxConcurrent) break
        pending.delete(id)
        const node = plan.find((n) => n.id === id)!

        const upstreamFailed = (node.needs ?? []).some((dep) => results.get(dep)?.status !== 'done')
        if (upstreamFailed) {
          results.set(id, {
            nodeId: id,
            roleId: node.roleId,
            status: 'skipped',
            output: '',
            error: '上游节点未成功',
            durationMs: 0,
          })
          continue
        }

        running.set(
          id,
          this.execute(node, goal, results, gates).then((r) => {
            results.set(id, r)
            running.delete(id)
          }),
        )
      }

      if (running.size === 0 && pending.size > 0) {
        // 没有可启动的节点又还有待办 = 依赖成环或指向不存在的节点。
        // validatePlan 应该已经拦住，走到这里说明有漏网的，明确失败而不是死循环。
        for (const id of pending) {
          const node = plan.find((n) => n.id === id)!
          results.set(id, {
            nodeId: id,
            roleId: node.roleId,
            status: 'failed',
            output: '',
            error: '依赖无法满足（可能成环）',
            durationMs: 0,
          })
        }
        break
      }

      if (running.size > 0) await Promise.race(running.values())
    }

    return plan.map(
      (n) =>
        results.get(n.id) ?? {
          nodeId: n.id,
          roleId: n.roleId,
          status: 'skipped' as const,
          output: '',
          durationMs: 0,
        },
    )
  }

  private async execute(
    node: PlanNode,
    goal: string,
    results: Map<string, NodeResult>,
    gates: Set<string>,
  ): Promise<NodeResult> {
    const role = this.config.roles.find((r) => r.id === node.roleId)!
    const started = Date.now()

    const upstream = (node.needs ?? [])
      .map((dep) => results.get(dep)?.output ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n')

    // `{input}` 决定上游产出**放在哪儿**，不决定要不要放。
    //
    // 之前没写 `{input}` 就把上游产出直接丢了——于是 `needs: ["n1"]` 只影响顺序，
    // 不影响内容，实测的表现是下游角色回「没有上一步的上下文，无法复核」。
    // 声明了依赖却拿不到依赖的产出，是最难查的一类配置陷阱：它不报错，
    // 只是让下游角色显得很蠢。真的只想要顺序，写 `passInput: false`。
    const withGoal = node.task.replaceAll('{goal}', goal)
    const wantsInput = node.passInput !== false && upstream !== ''
    const task = withGoal.includes('{input}')
      ? withGoal.replaceAll('{input}', wantsInput ? upstream : '')
      : wantsInput
        ? `${withGoal}\n\n## 上游产出\n\n${upstream}`
        : withGoal
    const prompt = this.composePrompt(role, task)

    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: role.name,
      backend: role.backend.kind === 'builtin' ? 'builtin' : 'custom',
      phase: 'spawned',
    })

    // 人工门禁在**执行前**问：跑完再问等于钱已经花了、文件已经改了。
    if (gates.has(node.id)) {
      this.deps.emit({
        type: 'team.member',
        runId: this.deps.runId,
        memberId: node.id,
        roleName: role.name,
        backend: 'builtin',
        phase: 'blocked',
        summary: task.slice(0, 200),
      })
      const approved = await this.deps.awaitHumanGate(node.id, task)
      if (!approved) {
        return {
          nodeId: node.id,
          roleId: role.id,
          status: 'skipped',
          output: '',
          error: '人工门禁未通过',
          durationMs: Date.now() - started,
        }
      }
    }

    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: role.name,
      backend: role.backend.kind === 'builtin' ? 'builtin' : 'custom',
      phase: 'working',
    })

    try {
      const res =
        role.backend.kind === 'cli'
          ? await runCli(role.backend, {
              prompt,
              workspaceRoot: this.deps.workspaceRoot,
              signal: this.deps.signal,
              ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
            }).then((r) => ({
              ok: r.ok,
              output: r.output,
              error: r.ok
                ? undefined
                : r.timedOut
                  ? '超时'
                  : `退出码 ${r.exitCode}${r.stderr ? `：${r.stderr.slice(-500)}` : ''}`,
            }))
          : await this.deps.runBuiltin({ role, prompt, signal: this.deps.signal })

      this.deps.emit({
        type: 'team.member',
        runId: this.deps.runId,
        memberId: node.id,
        roleName: role.name,
        backend: role.backend.kind === 'builtin' ? 'builtin' : 'custom',
        phase: res.ok ? 'done' : 'failed',
        summary: res.output.slice(0, 200),
        // 子会话不进会话列表（`source='workflow'`），**这个 id 是它唯一的入口**。
        // 不带出去的话，成员到底读了什么、跑了哪些命令就永远看不到了。
        // CLI 后端没有子会话，那边这个字段自然缺席。
        ...('conversationId' in res && res.conversationId
          ? { childConversationId: res.conversationId }
          : {}),
      })

      return {
        nodeId: node.id,
        roleId: role.id,
        status: res.ok ? 'done' : 'failed',
        output: res.output,
        ...(res.error ? { error: res.error } : {}),
        durationMs: Date.now() - started,
      }
    } catch (err) {
      return {
        nodeId: node.id,
        roleId: role.id,
        status: 'failed',
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
    }
  }

  /** 角色约束 + 团队公共约束 + 任务。公共规则放最后，压过角色自己的设定。 */
  private composePrompt(role: Role, task: string): string {
    const parts = [role.systemPrompt]
    if (this.config.rules?.shared) parts.push(this.config.rules.shared)
    parts.push(task)
    return parts.filter(Boolean).join('\n\n')
  }

  private resolvePlan(): PlanNode[] {
    if (this.config.plan?.length) return this.config.plan
    const first = this.config.roles[0]
    if (!first) throw new Error('team 配置里没有角色')
    return [{ id: 'main', roleId: first.id, task: '{goal}' }]
  }
}

/** 加载期就把成环和悬空引用挡掉，不留到运行时变成死循环。 */
export function validatePlan(plan: PlanNode[], roles: Role[], rules?: TeamRules): void {
  const roleIds = new Set(roles.map((r) => r.id))
  const nodeIds = new Set(plan.map((n) => n.id))

  if (nodeIds.size !== plan.length) throw new Error('plan 节点 id 重复')

  // 人工门禁是 fail-closed 语义的开关，**它的悬空引用必须报出来**。
  // 不校验的话，把节点 id 拼错一个字符 = 门禁永远不命中 = 那个「必须人看过」的
  // 节点直接执行，钱已花、文件已改，而且全程没有任何提示。
  // 一个开着但不生效的安全开关比没有这个开关更坏。
  for (const id of rules?.humanGates ?? []) {
    if (!nodeIds.has(id)) {
      throw new Error(`rules.humanGates 引用了不存在的节点 ${id}`)
    }
  }

  for (const node of plan) {
    if (!roleIds.has(node.roleId)) {
      throw new Error(`节点 ${node.id} 引用了不存在的角色 ${node.roleId}`)
    }
    for (const dep of node.needs ?? []) {
      if (!nodeIds.has(dep)) throw new Error(`节点 ${node.id} 依赖不存在的节点 ${dep}`)
      if (dep === node.id) throw new Error(`节点 ${node.id} 依赖自己`)
    }
  }

  // 深度优先找环。成环在运行时的表现是「一直没有可启动节点」，
  // 从现象倒推原因很费劲，所以必须在这里报出确切的环。
  const state = new Map<string, 'visiting' | 'done'>()
  const walk = (id: string, trail: string[]): void => {
    const s = state.get(id)
    if (s === 'done') return
    if (s === 'visiting') {
      throw new Error(`plan 存在循环依赖：${[...trail, id].join(' → ')}`)
    }
    state.set(id, 'visiting')
    for (const dep of plan.find((n) => n.id === id)?.needs ?? []) {
      walk(dep, [...trail, id])
    }
    state.set(id, 'done')
  }
  for (const node of plan) walk(node.id, [])
}
