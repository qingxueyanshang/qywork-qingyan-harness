/**
 * `subagent` 工具的服务端实现：把一段任务交给一个角色或本机的外部 CLI。
 *
 * **为什么在 server。** 派一个角色出去 = 起一个成员会话，那要 `Session` 与账本；两样都在依赖图上高
 * 于 tools。所以工具那边只声明端口（`DelegatePort`），实现落在这里——与编排（`team-run.ts`）**共
 * 用同一条成员会话路径**，不另开一套。
 *
 * **派一件与派一张图**：
 * - `subagent`：一次一件，直接起一条成员会话。
 * - `workflow`：一整张图，交给编排器按依赖跑。
 *
 * 两者跑的是同一份角色定义、同一条成员会话路径，区别只在有没有图。
 */

import type { DelegatePort } from '@qywork/agent'
import {
  type AgentEvent,
  type ConversationId,
  foldWorkflow,
  type RunId,
  type StepId,
  SUBAGENT_NODE_ID,
  type WorkflowCallRecord,
  type WorkflowNode,
  type WorkflowTransition,
} from '@qywork/core'
import { collectSecrets, loadTeamConfig, type ModelRef } from '@qywork/runtime'
import { getConversation, listRuns, listSteps, setStepChildConversation } from '@qywork/store'
import {
  CLI_PREFIX,
  detectClis,
  findCli,
  type OrchestratorState,
  type Role,
  runCli,
  TeamOrchestrator,
} from '@qywork/team'
import type { CommandDeps } from './deps.ts'
import { resolveModel as resolveMemberModel, runBuiltinMember } from './team-run.ts'

/** 派活只用到装配三件套（账本、正文库、配置），不碰那条 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

/**
 * 不指定目标时用的那个临时子 agent。
 *
 * **没有系统提示词、不限工具、不限步数**：它要干的事由任务本身说清楚，
 * 而「铺开去查几件小事」正是它的用途——给它一套约束就成了又一个需要先定义的角色。
 * 会话仍然是独立的：上下文不与父会话共享，产出只有最终那段文本。
 */
const AD_HOC_ROLE: Role = {
  id: 'ad-hoc',
  name: '临时子 agent',
  description: '当前模型、全套工具，任务结束即销毁',
  systemPrompt: '',
}

export function makeDelegate(ctx: {
  deps: DelegateDeps
  workspaceRoot: string
  /** 进度事件发给哪条会话——图卡长在这条会话的那张卡上。 */
  conversationId: ConversationId
}): DelegatePort {
  const { deps, workspaceRoot, conversationId } = ctx

  /**
   * 角色与团队规则**每次直接读文件**，不走 `acquireExtensions`。
   *
   * 那份扩展是引用计数缓存的，服务全程持有一份——因此模型这一轮用 `define_subagent`
   * 刚建好的角色，在同一轮里派活时看不见。实测形状：文件写成了、`subagent`
   * 的清单里却只有外部 CLI，模型反复重试后判定「派活引擎读的是另一份文件」。
   * 设置页那条接口（`api/team.ts`）出于同样的理由也是直接读。
   */
  const team = async () => {
    const cfg = await loadTeamConfig(workspaceRoot)
    return { roles: cfg.roles, rules: cfg.rules }
  }
  const roles = async () => (await team()).roles

  /**
   * 父会话当前的「接口 × 模型」。成员没点名接口时跟着它跑，而不是跟着 `config.active`。
   *
   * **每次现读**：模型是会话级属性，用户在界面上随时能切；这一轮开始时读到的那一对
   * 才是他要的那一对。迁移 24 之前建的会话 `provider` 是空串，这种回 undefined，
   * 由下游落回配置默认。
   */
  const inherited = () => {
    const c = getConversation(deps.store, conversationId)
    return c?.provider && c.model ? { provider: c.provider, model: c.model } : undefined
  }

  /**
   * workflow 没有第二份运行表：同一父会话里已经落库的 workflow tool step
   * 就是恢复权威。当前正在执行的 step 尚无结果，必须排除，避免把请求当成事实。
   */
  const workflowRecords = (currentStepId: string): WorkflowCallRecord[] => {
    const records: WorkflowCallRecord[] = []
    for (const run of listRuns(deps.store, conversationId)) {
      for (const step of listSteps(deps.store, run.id)) {
        if (
          step.id === currentStepId ||
          step.kind !== 'tool_action' ||
          step.toolName !== 'workflow'
        ) {
          continue
        }
        const payload = step.payload
        if (payload?.kind !== 'tool_call' && payload?.kind !== 'tool_result') continue
        records.push({
          stepId: step.id,
          ...(payload.args ? { args: payload.args } : {}),
          ...(payload.kind === 'tool_result' ? { outcome: payload.outcome } : {}),
          status:
            step.status === 'running'
              ? 'running'
              : step.status === 'success'
                ? 'success'
                : 'failure',
        })
      }
    }
    return records
  }

  /** 这一次用哪一对：点名了就解析它，没点名就继承父会话。 */
  const pick = (
    named?: string,
    provider?: string,
  ): { explicit: ModelRef } | { inherit: ModelRef } | Record<string, never> | { error: string } => {
    if (provider && !named) return { error: `指定接口 ${provider} 时必须同时指定模型` }
    if (named) {
      const r = resolveMemberModel(named, deps.config, provider)
      return 'error' in r ? r : { explicit: r }
    }
    const pair = inherited()
    return pair ? { inherit: pair } : {}
  }

  /**
   * 一次派活的进度，与编排**共用 `team.member`**：派一件就是一张只有一个节点的图，
   * 前端按同一条通道画同一种卡。
   *
   * **没有 `stepId` 就整条不发**：前端按它认领卡片，认不出的一律丢弃
   * （`connection.ts` 的 `team.member`），发出去只是空转。这条降级路径是安全的——
   * 图的形状来自调用参数，终态来自这条 step 自己。
   *
   * **只发 `working`，不发 `spawned`**：派一件没有排队阶段，交出去就开跑，
   * 两条连着发的话第二条是同一时刻的同一件事。
   *
   * `working` 会发第二次，带上子会话 id：那个 id 要等子会话起来才有，
   * 而前端按 `memberId` 原地更新，第二条只是给同一格补上「点开哪一条」。
   */
  const progress = (
    at: { runId: string; stepId?: string },
    label: string,
    backend: 'builtin' | 'custom',
  ) => {
    return (
      phase: 'working' | 'done' | 'failed',
      extra?: { summary?: string; childConversationId?: ConversationId },
    ) => {
      if (!at.stepId) return
      deps.bus.publish(
        {
          type: 'team.member',
          runId: at.runId as RunId,
          memberId: SUBAGENT_NODE_ID,
          roleName: label,
          backend,
          phase,
          stepId: at.stepId,
          ...extra,
        },
        conversationId,
      )
    }
  }

  return {
    resolveModel(name, provider) {
      return resolveMemberModel(name, deps.config, provider)
    },

    async targets() {
      const [rs, clis] = await Promise.all([roles(), detectClis()])
      return [
        ...rs.map((r) => ({
          id: r.id,
          kind: 'role' as const,
          description: r.description || r.name,
        })),
        ...clis.map((c) => ({
          id: `${CLI_PREFIX}${c.id}`,
          kind: 'cli' as const,
          // 接没接入要说出来：派给一个没登录的 CLI，回来的是它的登录提示，
          // 而模型会把那段当成任务产出。
          description: `${c.vendor} · ${c.connected ? '已接入' : '未见凭证'}`,
        })),
      ]
    },

    async run(input: {
      target: string
      task: string
      model?: string
      provider?: string
      resume?: string
      runId: string
      stepId?: string
      signal: AbortSignal
    }) {
      if (input.target.startsWith(CLI_PREFIX)) {
        const id = input.target.slice(CLI_PREFIX.length)
        // 外部 CLI 用它自己的模型，接不了这个参数。当场说出来，
        // 不要照跑一遍，那在界面上等同于换过了模型。
        if (input.model || input.provider) {
          return {
            ok: false,
            output: '',
            error: `${id} 用它自己的模型，指定不了 ${input.provider ? `${input.provider}/` : ''}${input.model ?? ''}`,
          }
        }
        const cli = await findCli(id)
        if (!cli) return { ok: false, output: '', error: `本机没有识别到 ${id}` }
        // 接不上的那几家当场说清楚：照跑一遍会起一条全新会话，而模型会按记得上一轮行事。
        if (input.resume && !cli.resumeArgs) {
          return { ok: false, output: '', error: `${id} 不支持续接会话，只能新建一次调用` }
        }
        const say = progress(input, `${cli.vendor} ${cli.id}`, 'custom')
        say('working')
        // 它是本机另一个进程，跑完之前写了什么，不发出来一个字都看不到——
        // 内置子 agent 的过程留在它自己那条子会话里，这一种没有。
        const stepId = input.stepId
        const onOutput = stepId
          ? (delta: string) =>
              deps.bus.publish(
                {
                  type: 'team.output',
                  runId: input.runId as RunId,
                  stepId,
                  memberId: SUBAGENT_NODE_ID,
                  delta,
                },
                conversationId,
              )
          : null
        try {
          const r = await runCli(cli, {
            prompt: input.task,
            workspaceRoot,
            signal: input.signal,
            ...(input.resume ? { resume: input.resume } : {}),
            // 外部 CLI 要它自己的 key 才能执行，但 qywork 配置里那几把它一把用不上。
            secrets: collectSecrets(deps.config),
            ...(onOutput ? { onChunk: onOutput } : {}),
          })
          say(r.ok ? 'done' : 'failed', { summary: r.output.slice(0, 200) })
          return {
            ok: r.ok,
            output: r.output,
            ...(r.ok
              ? {}
              : {
                  error: r.timedOut
                    ? '超时'
                    : `退出码 ${r.exitCode}${r.stderr ? `：${r.stderr.slice(-500)}` : ''}`,
                }),
            // 会话 id 无论成败都带回去：执行失败时更需要续接会话问清楚断点。
            ...(r.session ? { session: r.session } : {}),
          }
        } catch (err) {
          // 起进程本身失败（命令在探测之后被删、权限不足）。**必须落终态**：
          // 抛出去的话卡上那个节点停在「进行中」，而这一轮已经结束了。
          say('failed')
          return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) }
        }
      }

      if (input.resume) {
        return {
          ok: false,
          output: '',
          error: 'resume 仅对外部 CLI 有效：角色每次调用都是新的子会话',
        }
      }
      const role = input.target ? (await roles()).find((r) => r.id === input.target) : AD_HOC_ROLE
      if (!role) return { ok: false, output: '', error: `这个项目里没有角色 ${input.target}` }
      const picked = pick(input.model, input.provider)
      if ('error' in picked) return { ok: false, output: '', error: picked.error }
      const say = progress(input, role.name, 'builtin')
      say('working')
      try {
        const res = await runBuiltinMember(
          { role, prompt: input.task, signal: input.signal },
          {
            deps,
            workspaceRoot,
            ...picked,
            onConversation: (cid) => {
              // 先落账再广播。用户此刻切走父会话会错过广播，但切回来从同一条 step
              // 回放时仍拿得到入口，不会把运行中的节点画成不可点击。
              if (input.stepId) {
                setStepChildConversation(deps.store, input.stepId as StepId, cid)
              }
              say('working', { childConversationId: cid })
            },
            onEvent: (ev, cid) => deps.bus.publish(ev, cid),
          },
        )
        say(res.ok ? 'done' : 'failed', {
          summary: res.output.slice(0, 200),
          // 子会话 id 成败都带：没做成的那条正是要翻开看的那一条。
          ...(res.conversationId ? { childConversationId: res.conversationId } : {}),
        })
        return {
          ok: res.ok,
          output: res.output,
          ...(res.error ? { error: res.error } : {}),
          // 子会话不进会话列表，这个 id 是点开它的唯一入口。
          ...(res.conversationId ? { conversationId: res.conversationId } : {}),
        }
      } catch (err) {
        // 成员会话自己 try/catch 不抛（`team-run.ts`），走到这里的是装配期的意外。
        // **必须落终态**：抛出去的话卡上那个节点停在「进行中」，而这一轮已经结束了。
        say('failed')
        return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) }
      }
    },

    /**
     * 跑一整张图。依赖就绪才启动、并发闸都在编排器那边，
     * 这里只负责把图递进去、把进度广播出来、把终态收回来。
     */
    async runGraph(input) {
      const { roles: rs, rules } = await team()
      const clis = await detectClis()
      const workflowId = input.call.kind === 'start' ? input.stepId : input.call.workflowId
      let goal: string
      let nodes: WorkflowNode[]
      let state: OrchestratorState
      if (input.call.kind === 'start') {
        goal = input.call.goal
        nodes = input.call.nodes
        state = {}
      } else {
        const folded = foldWorkflow(workflowRecords(input.stepId), workflowId)
        if (!folded.ok) return { ok: false, error: folded.error }
        const projection = folded.projection
        if (projection.phase !== 'waiting_review') {
          return {
            ok: false,
            error: `工作流 ${workflowId} 当前不是待审查状态（${projection.phase}）`,
          }
        }
        if (projection.checkpointId !== input.call.checkpointId) {
          return {
            ok: false,
            error: `工作流 ${workflowId} 当前待审查的是 ${projection.checkpointId ?? '无'}，不是 ${input.call.checkpointId}`,
          }
        }
        goal = projection.goal
        nodes = projection.nodes
        state = {
          results: projection.results,
          approvals: projection.approvals,
          checkpointId: projection.checkpointId,
          review: {
            checkpointId: input.call.checkpointId,
            decision: input.call.decision,
            note: input.call.note,
            revisions: input.call.revisions,
          },
        }
      }
      const orchestrator = new TeamOrchestrator(
        // 临时子 agent 排在用户的角色**后面**：同 id 时先找到的是用户那条，
        // 用户定义的那一份盖过内置的默认。
        { name: 'workflow', roles: [...rs, AD_HOC_ROLE], rules, plan: nodes },
        {
          workspaceRoot,
          signal: input.signal,
          secrets: collectSecrets(deps.config),
          runId: input.runId as RunId,
          resolveCli: (id) => clis.find((c) => c.id === id),
          // 进度带上 stepId：前端按它认领是哪一张图卡。不带的话事件到了也无处可落。
          emit: (ev: AgentEvent) =>
            deps.bus.publish(
              ev.type === 'team.member' || ev.type === 'team.output'
                ? { ...ev, stepId: input.stepId }
                : ev,
              conversationId,
            ),
          runBuiltin: async (member) => {
            const picked = pick(member.model, member.provider)
            if ('error' in picked) return { ok: false, output: '', error: picked.error }
            if (member.existingConversationId) {
              const parent = getConversation(deps.store, conversationId)
              const child = getConversation(deps.store, member.existingConversationId)
              if (
                !parent ||
                !child ||
                child.workspaceId !== parent.workspaceId ||
                child.source !== 'workflow' ||
                child.sourceRef !== member.role.id
              ) {
                return {
                  ok: false,
                  output: '',
                  error: `子会话 ${member.existingConversationId} 不属于当前工作流节点 ${member.role.id}`,
                }
              }
            }
            return runBuiltinMember(member, {
              deps,
              workspaceRoot,
              ...picked,
              ...(member.onConversation ? { onConversation: member.onConversation } : {}),
              // 子会话的事件按**它自己的会话 id** 发。这条与上面那个 `emit` 不是一回事：
              // 那个发的是图卡进度，归属是父会话。
              onEvent: (ev, cid) => deps.bus.publish(ev, cid),
            })
          },
        },
      )
      try {
        const result = await orchestrator.run(goal, state)
        const transition: WorkflowTransition = {
          workflowId,
          phase: result.phase,
          receipts: result.receipts,
          ...(result.checkpointId ? { checkpointId: result.checkpointId } : {}),
          ...(result.review ? { review: result.review } : {}),
        }
        return {
          ok:
            result.receipts.every((receipt) => receipt.status === 'done') &&
            result.phase !== 'failed',
          transition,
        }
      } catch (err) {
        // 图本身不合法（成环、悬空依赖、门禁引用不到角色）在这里落地：
        // 它是模型写错了参数，要原样告诉它，不能压成一句「工具执行出错」。
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
