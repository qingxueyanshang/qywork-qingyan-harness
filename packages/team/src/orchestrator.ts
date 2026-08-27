/**
 * 编排器。
 *
 * 按依赖图跑角色，尊重并发上限。
 *
 * 一条刻意的设计取舍：**编排是确定性的代码，不是让某个模型自由发挥。**
 * 依赖顺序、并发数、门禁位置都由配置固定。模型只负责节点内的工作，
 * 不负责决定「下一步该谁上」——把调度也交给模型，出问题时无法复现也无法归因。
 */

import type { AgentEvent, ConversationId, RunId } from '@qywork/core'
import { runCli } from './cli-backend.ts'
import type { CliAgent, NodeResult, PlanNode, Role, TeamConfig } from './types.ts'
import { CLI_PREFIX } from './types.ts'

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
  /**
   * 派给外部 CLI 时，按 id 取那一条识别结果。识别不到返回 undefined——
   * 节点当场失败，不退回内置跑：那会拿一个模型冒充另一个模型的产出。
   */
  resolveCli(id: string): CliAgent | undefined
  /** 角色的执行入口：跑一个子会话并返回最终文本。 */
  runBuiltin(input: {
    role: Role
    prompt: string
    signal: AbortSignal
    /** 节点点名的模型，实现方负责解析成一对「接口 × 模型」。 */
    model?: string
    /**
     * 子会话 id 一拿到就回调，不等这一趟跑完。
     *
     * 这一格靠它才点得开。等返回值的话，这张图上正在跑的那几格全程点不开，
     * 而正在跑的那几格正是用户要翻开的。
     */
    onConversation?: (conversationId: ConversationId) => void
  }): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }>
  emit(event: AgentEvent): void
  runId: RunId
}

export class TeamOrchestrator {
  constructor(
    private readonly config: TeamConfig,
    private readonly deps: OrchestratorDeps,
  ) {}

  async run(goal: string): Promise<NodeResult[]> {
    const plan = this.config.plan
    validatePlan(plan, this.config.roles)

    const results = new Map<string, NodeResult>()
    const maxConcurrent = this.config.rules?.maxConcurrent ?? 3

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
            agent: node.agent,
            label: this.labelOf(node.agent),
            status: 'skipped',
            output: '',
            error: '上游节点未成功',
            durationMs: 0,
          })
          continue
        }

        running.set(
          id,
          this.execute(node, goal, results).then((r) => {
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
            agent: node.agent,
            label: this.labelOf(node.agent),
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
          agent: n.agent,
          label: this.labelOf(n.agent),
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
  ): Promise<NodeResult> {
    // 目标要么是角色，要么是 `cli:<id>` 的外部 CLI。两者的配置面不相干，
    // 所以这里各解析各的，不做「找不到角色就当 CLI」那种回退。
    const isCli = node.agent.startsWith(CLI_PREFIX)
    const cli = isCli ? this.deps.resolveCli(node.agent.slice(CLI_PREFIX.length)) : undefined
    const role = isCli ? undefined : this.config.roles.find((r) => r.id === node.agent)
    const label = this.labelOf(node.agent)
    const started = Date.now()

    if (!role && !cli) {
      return {
        nodeId: node.id,
        agent: node.agent,
        label,
        status: 'failed',
        output: '',
        error: isCli ? `本机没有识别到 ${node.agent.slice(CLI_PREFIX.length)}` : '找不到这个角色',
        durationMs: Date.now() - started,
      }
    }

    const upstream = (node.needs ?? [])
      .map((dep) => results.get(dep)?.output ?? '')
      .filter(Boolean)
      .join('\n\n---\n\n')

    // `{input}` 决定上游产出**放在哪儿**，不决定要不要放。
    //
    // 不写 `{input}` 就会把上游产出直接丢掉——`needs: ["n1"]` 只影响顺序、不影响内容，
    // 实测的表现是下游角色回「没有上一步的上下文，无法复核」。
    // 声明了依赖却拿不到依赖的产出，是最难查的一类配置陷阱：它不报错，
    // 只是让下游角色拿不到上游产出。真的只想要顺序，写 `passInput: false`。
    const withGoal = node.task.replaceAll('{goal}', goal)
    const wantsInput = node.passInput !== false && upstream !== ''
    const task = withGoal.includes('{input}')
      ? withGoal.replaceAll('{input}', wantsInput ? upstream : '')
      : wantsInput
        ? `${withGoal}\n\n## 上游产出\n\n${upstream}`
        : withGoal
    // 外部 CLI 拿不到角色的系统提示词——它有自己的一套，也没有地方接收。
    const prompt = role ? this.composePrompt(role, task) : task
    const kind = cli ? ('custom' as const) : ('builtin' as const)

    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: label,
      backend: kind,
      phase: 'spawned',
    })

    this.deps.emit({
      type: 'team.member',
      runId: this.deps.runId,
      memberId: node.id,
      roleName: label,
      backend: kind,
      phase: 'working',
    })

    try {
      const res = cli
        ? await runCli(cli, {
            prompt,
            workspaceRoot: this.deps.workspaceRoot,
            signal: this.deps.signal,
            ...(this.deps.secrets ? { secrets: this.deps.secrets } : {}),
            // 外部 CLI 的过程只能靠这条看得见：它是本机另一个进程，
            // 不像内置子 agent 那样有一条点得开的子会话。
            onChunk: (delta) =>
              this.deps.emit({
                type: 'team.output',
                runId: this.deps.runId,
                memberId: node.id,
                delta,
              }),
          }).then((r) => ({
            ok: r.ok,
            output: r.output,
            error: r.ok
              ? undefined
              : r.timedOut
                ? '超时'
                : `退出码 ${r.exitCode}${r.stderr ? `：${r.stderr.slice(-500)}` : ''}`,
            ...(r.session ? { session: r.session } : {}),
          }))
        : await this.deps.runBuiltin({
            role: role!,
            prompt,
            signal: this.deps.signal,
            ...(node.model ? { model: node.model } : {}),
            // 子会话起来了，把「点开哪一条」补给这一格。仍是 `working`——
            // 阶段没变，变的是这一格多了一个可以翻开的去处。
            onConversation: (cid) =>
              this.deps.emit({
                type: 'team.member',
                runId: this.deps.runId,
                memberId: node.id,
                roleName: label,
                backend: kind,
                phase: 'working',
                childConversationId: cid,
              }),
          })

      this.deps.emit({
        type: 'team.member',
        runId: this.deps.runId,
        memberId: node.id,
        roleName: label,
        backend: kind,
        phase: res.ok ? 'done' : 'failed',
        summary: res.output.slice(0, 200),
        // 子会话不进会话列表（`source='workflow'`），**这个 id 是它唯一的入口**。
        // 不带出去的话，成员读了什么、跑了哪些命令就永远看不到了。
        // 外部 CLI 没有子会话，那边这个字段自然缺席。
        ...('conversationId' in res && res.conversationId
          ? { childConversationId: res.conversationId }
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
        // 图跑完之后常常还要追一句「你刚才那步具体改了什么」——不带出去就只能重派。
        ...('session' in res && res.session ? { session: res.session } : {}),
        ...('conversationId' in res && res.conversationId
          ? { conversationId: res.conversationId }
          : {}),
      }
    } catch (err) {
      return {
        nodeId: node.id,
        agent: node.agent,
        label,
        status: 'failed',
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      }
    }
  }

  /**
   * 节点上显示的名字：角色名，或「厂商 + CLI 名」，两样都认不出就退回 agent 那个 id。
   *
   * 事件与结果**共用这一份**：两处各写一遍的话，刷新前后同一个节点会显示两个名字。
   */
  private labelOf(agent: string): string {
    if (agent.startsWith(CLI_PREFIX)) {
      const cli = this.deps.resolveCli(agent.slice(CLI_PREFIX.length))
      return cli ? `${cli.vendor} ${cli.id}` : agent
    }
    return this.config.roles.find((r) => r.id === agent)?.name ?? agent
  }

  /** 角色约束 + 团队公共约束 + 任务。公共规则放最后，压过角色自己的设定。 */
  private composePrompt(role: Role, task: string): string {
    const parts = [role.systemPrompt]
    if (this.config.rules?.shared) parts.push(this.config.rules.shared)
    parts.push(task)
    return parts.filter(Boolean).join('\n\n')
  }
}

/** 加载期就把成环和悬空引用挡掉，不留到运行时变成死循环。 */
export function validatePlan(plan: PlanNode[], roles: Role[]): void {
  const roleIds = new Set(roles.map((r) => r.id))
  const nodeIds = new Set(plan.map((n) => n.id))

  if (nodeIds.size !== plan.length) throw new Error('plan 节点 id 重复')

  for (const node of plan) {
    // 指向外部 CLI 的节点这里不校验：装没装是本机的事实，随时会变，
    // 校验点在执行时（识别不到就那一个节点失败），不该让整张图起不来。
    if (!node.agent.startsWith(CLI_PREFIX) && !roleIds.has(node.agent)) {
      throw new Error(`节点 ${node.id} 引用了不存在的角色 ${node.agent}`)
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
