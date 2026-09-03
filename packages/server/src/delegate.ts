/**
 * 派活端口的服务端实现：把任务派给一个子 agent，或跑一整张图。
 *
 * **为什么在 server。** 派活 = 起或续一条子会话，那要 `Session` 与账本；两样都在依赖图上高于
 * tools。所以工具那边只声明端口（`DelegatePort`），实现落在这里。
 *
 * **一个派发函数。** `subagent` 工具派一个、`workflow` 图上每个节点，都经 `dispatch`：
 * 解析目标 → 子 agent 记录（新建或已有）→ 按种类跑 → 回执。编排器不区分内置与外部 CLI。
 *
 * **子 agent 的 id 就是它的子会话 id。** 三种种类一个 id 空间：角色与临时的子会话有正文；
 * 外部 CLI 那一行只有元数据与外部会话句柄（`externalSession`），正文在 CLI 自己那边。
 */

import type { DelegatePort } from '@qywork/agent'
import {
  type Conversation,
  type ConversationId,
  type ConversationSubagentsResponse,
  foldWorkflow,
  type NodeState,
  type RunId,
  type StepId,
  SUBAGENT_NODE_ID,
  type SubagentTarget,
  type WorkflowNode,
  type WorkflowTransition,
} from '@qywork/core'
import { collectSecrets, loadTeamConfig, type ModelRef } from '@qywork/runtime'
import {
  createConversation,
  getConversation,
  listChildConversations,
  listRuns,
  listWorkflowRecords,
  setConversationExternalSession,
  setStepNodeState,
} from '@qywork/store'
import {
  type CliAgent,
  detectClis,
  findCli,
  type OrchestratorState,
  type Role,
  runCli,
  TeamOrchestrator,
} from '@qywork/team'
import type { CommandDeps } from './deps.ts'
import { memberModel, resolveModel as resolveMemberModel, runBuiltinMember } from './team-run.ts'

/** 派活只用到装配三件套（账本、正文库、配置），不碰那条 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

/** 临时子 agent 的运行约束：没有系统提示词、不限工具。名字来自派发参数。 */
const tempRole = (name: string): Role => ({ id: 'temp', name, description: '', systemPrompt: '' })

interface Resolved {
  conversation: Conversation
  /** 内置子 agent 的运行约束；外部 CLI 为 null。 */
  role: Role | null
  cli: CliAgent | null
  created: boolean
}

/**
 * 一条会话的子 agent 清单：种类、模型、此刻的状态。运行快照与右栏那一页读的是同一份。
 * 状态按账本判：有一轮在跑是 running，最近一轮没跑完是 failed，其余 idle。
 */
export function listSubagents(
  deps: Pick<DelegateDeps, 'store' | 'runs'>,
  conversationId: ConversationId,
): ConversationSubagentsResponse['subagents'] {
  return listChildConversations(deps.store, conversationId).map((c) => {
    const runs = listRuns(deps.store, c.id)
    const last = runs[runs.length - 1]
    return {
      id: c.id,
      kind: c.source === 'cli' ? 'cli' : c.source === 'role' ? 'role' : 'temp',
      name: c.title,
      provider: c.provider,
      model: c.model,
      status: deps.runs.isBusy(c.id)
        ? 'running'
        : last?.status === 'failed' || last?.status === 'interrupted'
          ? 'failed'
          : 'idle',
      createdAt: c.createdAt,
    }
  })
}

export function makeDelegate(ctx: {
  deps: DelegateDeps
  workspaceRoot: string
  /** 派活的那条会话。子 agent 都归它，进度事件也发给它。 */
  conversationId: ConversationId
}): DelegatePort {
  const { deps, workspaceRoot, conversationId } = ctx

  /**
   * 角色与团队规则**每次直接读文件**，不走 `acquireExtensions`。
   *
   * 那份扩展是引用计数缓存的，服务全程持有一份——因此模型这一轮用 `define_role`
   * 刚建好的角色，在同一轮里派活时看不见。设置页那条接口（`api/team.ts`）出于同样的理由也是直接读。
   */
  const team = async () => {
    const cfg = await loadTeamConfig(workspaceRoot)
    return { roles: cfg.roles, rules: cfg.rules }
  }

  /**
   * 父会话当前的「接口 × 模型」。子 agent 没点名模型时跟着它跑，而不是跟着 `config.active`。
   * **每次现读**：模型是会话级属性，用户在界面上随时能切。
   */
  const inherited = (): ModelRef | undefined => {
    const c = getConversation(deps.store, conversationId)
    return c?.provider && c.model ? { provider: c.provider, model: c.model } : undefined
  }

  /** 这一次用哪一对：点名了就解析它，没点名就继承父会话。 */
  const pick = (
    named?: string,
    provider?: string,
  ): { explicit?: ModelRef; inherit?: ModelRef } | { error: string } => {
    if (provider && !named) return { error: `指定接口 ${provider} 时必须同时指定模型` }
    if (named) {
      const r = resolveMemberModel(named, deps.config, provider)
      return 'error' in r ? r : { explicit: r }
    }
    const pair = inherited()
    return pair ? { inherit: pair } : {}
  }

  /** 本会话已有的子 agent。 */
  const children = () => listChildConversations(deps.store, conversationId)

  /**
   * 解析派发目标。已有子 agent 按 id 取，并校验它属于本会话；新建的当场落一行，
   * id 从此固定，进度事件与图卡在它跑起来之前就拿得到入口。
   */
  const resolveTarget = async (
    target: SubagentTarget,
    model?: string,
    provider?: string,
  ): Promise<Resolved | { error: string }> => {
    const parent = getConversation(deps.store, conversationId)
    if (!parent) return { error: '找不到当前会话' }

    if ('subagent' in target) {
      if (model || provider) {
        return { error: '续接已有子 agent 时不能再指定模型，它沿用自己的会话' }
      }
      const conversation = getConversation(deps.store, target.subagent as ConversationId)
      if (!conversation || conversation.parentConversationId !== conversationId) {
        return { error: `本会话里没有子 agent ${target.subagent}` }
      }
      if (conversation.source === 'cli') {
        const cli = conversation.sourceRef ? await findCli(conversation.sourceRef) : null
        if (!cli) return { error: `本机没有识别到 ${conversation.sourceRef}` }
        if (conversation.externalSession && !cli.resumeArgs) {
          return { error: `${cli.id} 不支持续接会话` }
        }
        return { conversation, role: null, cli, created: false }
      }
      const role =
        conversation.source === 'role'
          ? ((await team()).roles.find((r) => r.id === conversation.sourceRef) ??
            tempRole(conversation.title))
          : tempRole(conversation.title)
      return { conversation, role, cli: null, created: false }
    }

    if (target.kind === 'cli') {
      // 外部 CLI 用它自己的模型。当场说出来，不要照跑一遍，那在界面上等同于换过了模型。
      if (model || provider) {
        return {
          error: `${target.cli} 用它自己的模型，指定不了 ${provider ? `${provider}/` : ''}${model ?? ''}`,
        }
      }
      const cli = await findCli(target.cli)
      if (!cli) return { error: `本机没有识别到 ${target.cli}` }
      const conversation = createConversation(deps.store, {
        workspaceId: parent.workspaceId,
        provider: 'cli',
        model: cli.id,
        title: target.name ?? `${cli.vendor} ${cli.id}`,
        source: 'cli',
        sourceRef: cli.id,
        parentConversationId: conversationId,
      })
      return { conversation, role: null, cli, created: true }
    }

    const picked = pick(model, provider)
    if ('error' in picked) return picked
    let role: Role
    if (target.kind === 'role') {
      const found = (await team()).roles.find((r) => r.id === target.role)
      if (!found) return { error: `这个项目里没有角色 ${target.role}` }
      role = found
    } else {
      role = tempRole(target.name)
    }
    const active = memberModel(role, deps.config, picked)
    if ('error' in active) return active
    const conversation = createConversation(deps.store, {
      workspaceId: parent.workspaceId,
      provider: active.provider,
      model: active.model,
      title: target.name ?? role.name,
      source: target.kind,
      ...(target.kind === 'role' ? { sourceRef: role.id } : {}),
      parentConversationId: conversationId,
    })
    return { conversation, role, cli: null, created: true }
  }

  /** 一格的名字，给编排器写状态用。同步：角色、CLI、已有子 agent 三份清单在图开跑前读一次。 */
  const describeWith =
    (roles: Role[], clis: CliAgent[], existing: Conversation[]) =>
    (target: SubagentTarget): { label: string } | null => {
      if ('subagent' in target) {
        const c = existing.find((x) => x.id === target.subagent)
        return c ? { label: c.title } : null
      }
      if (target.kind === 'temp') return { label: target.name }
      if (target.kind === 'role') {
        const r = roles.find((x) => x.id === target.role)
        return r ? { label: target.name ?? r.name } : null
      }
      const cli = clis.find((x) => x.id === target.cli)
      return cli ? { label: target.name ?? `${cli.vendor} ${cli.id}` } : null
    }

  /** 每张卡上各格最近一次状态。跑一张图收场时据此把没到终态的格标成中断。 */
  const latest = new Map<string, Map<string, NodeState>>()

  /**
   * 一格的状态变了：先写进那张卡的 step，再广播。派一件与图上的节点同一条路——派一件就是
   * 一张只有一格的图。**先落账再广播**：切走父会话会错过广播，切回来从 step 回放。
   * 没有 `stepId` 的调用（没有卡）什么都不记。
   */
  const note =
    (at: { runId: string; stepId?: string }, nodeId: string) =>
    (state: NodeState): void => {
      if (!at.stepId) return
      const card = latest.get(at.stepId) ?? new Map<string, NodeState>()
      latest.set(at.stepId, card)
      card.set(nodeId, state)
      setStepNodeState(deps.store, at.stepId as StepId, nodeId, state)
      deps.bus.publish(
        { type: 'team.member', runId: at.runId as RunId, stepId: at.stepId, nodeId, state },
        conversationId,
      )
    }

  const dispatch: DelegatePort['dispatch'] = async (input) => {
    const resolved = await resolveTarget(input.target, input.model, input.provider)
    if ('error' in resolved) return { ok: false, output: '', error: resolved.error }
    const { conversation, role, cli, created } = resolved
    const id = conversation.id
    const label = conversation.title
    const nodeId = input.nodeId ?? SUBAGENT_NODE_ID
    const say = note(input, nodeId)
    const started = Date.now()
    say({ phase: 'working', label, subagentId: id })

    const base = { subagentId: id, name: label, created }
    const settle = (ok: boolean, error?: string) => {
      const durationMs = Date.now() - started
      say({
        phase: ok ? 'done' : 'failed',
        label,
        subagentId: id,
        durationMs,
        ...(error ? { error } : {}),
      })
      return { ok, ...(error ? { error } : {}), durationMs, ...base }
    }
    try {
      if (cli) {
        // 它是本机另一个进程，跑完之前写了什么，不发出来一个字都看不到。
        const stepId = input.stepId
        const r = await runCli(cli, {
          prompt: input.task,
          workspaceRoot,
          signal: input.signal,
          ...(conversation.externalSession ? { resume: conversation.externalSession } : {}),
          // 外部 CLI 要它自己的 key 才能执行，但 qywork 配置里那几把它一把用不上。
          secrets: collectSecrets(deps.config),
          ...(stepId
            ? {
                onChunk: (delta: string) =>
                  deps.bus.publish(
                    {
                      type: 'team.output',
                      runId: input.runId as RunId,
                      stepId,
                      nodeId,
                      delta,
                    },
                    conversationId,
                  ),
              }
            : {}),
        })
        // 会话句柄无论成败都记下：执行失败时更需要续接会话问清楚断点。
        if (r.session) setConversationExternalSession(deps.store, id, r.session)
        const error = r.ok
          ? undefined
          : r.timedOut
            ? '超时'
            : `退出码 ${r.exitCode}${r.stderr ? `：${r.stderr.slice(-500)}` : ''}`
        return { output: r.output, ...settle(r.ok, error) }
      }

      const { rules } = await team()
      const res = await runBuiltinMember(
        {
          role: role ?? tempRole(label),
          prompt: input.task,
          signal: input.signal,
          conversationId: id,
        },
        {
          deps,
          workspaceRoot,
          ...(rules.shared ? { shared: rules.shared } : {}),
          // 子会话的事件按**它自己的会话 id** 发；图卡进度归父会话，是上面那条 `say`。
          onEvent: (ev, cid) => deps.bus.publish(ev, cid),
        },
      )
      return { output: res.output, ...settle(res.ok, res.error) }
    } catch (err) {
      // 成员会话自己 try/catch 不抛（`team-run.ts`），走到这里的是装配期的意外。
      // **必须落终态**：抛出去的话卡上那个节点停在「进行中」，而这一轮已经结束了。
      return { output: '', ...settle(false, err instanceof Error ? err.message : String(err)) }
    }
  }

  return {
    resolveModel(name, provider) {
      return resolveMemberModel(name, deps.config, provider)
    },

    async targets() {
      const [{ roles }, clis] = await Promise.all([team(), detectClis()])
      return {
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          ...(r.provider ? { provider: r.provider } : {}),
          ...(r.model ? { model: r.model } : {}),
        })),
        clis: clis.map((c) => ({ id: c.id, vendor: c.vendor, connected: c.connected })),
      }
    },

    async subagents() {
      return listSubagents(deps, conversationId)
    },

    dispatch,

    /**
     * 跑一整张图。依赖就绪才启动、并发闸都在编排器那边，
     * 这里只负责把图递进去、把进度广播出来、把终态收回来。
     */
    async runGraph(input) {
      const [{ roles }, clis] = await Promise.all([team(), detectClis()])
      const existing = children()
      const workflowId = input.call.kind === 'start' ? input.stepId : input.call.workflowId
      let goal: string
      let nodes: WorkflowNode[]
      let maxConcurrent: number
      let state: OrchestratorState
      if (input.call.kind === 'start') {
        goal = input.call.goal
        nodes = input.call.nodes
        maxConcurrent = input.call.maxConcurrent
        state = {}
      } else {
        const folded = foldWorkflow(
          listWorkflowRecords(deps.store, conversationId, input.stepId as StepId),
          workflowId,
        )
        if (!folded.ok) return { ok: false, error: folded.error }
        const projection = folded.projection
        // 这几道闸只拦 approve。revise 对任意检查点都成立，包括已批准的与被打断的：
        // 「批准 = 解散」正是返工只能另起一个子 agent 的根因，被打断的图也靠 revise 续跑原子 agent。
        if (input.call.decision === 'approve') {
          if (projection.phase === 'failed') {
            return { ok: false, error: `工作流 ${workflowId} 已失败，请重新派发` }
          }
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
        }
        goal = projection.goal
        nodes = projection.nodes
        maxConcurrent = projection.maxConcurrent
        state = {
          results: projection.results,
          approvals: projection.approvals,
          ...(projection.checkpointId ? { checkpointId: projection.checkpointId } : {}),
          review: {
            checkpointId: input.call.checkpointId,
            decision: input.call.decision,
            note: input.call.note,
            revisions: input.call.revisions,
          },
        }
      }
      // 图没跑完就收场（中断、图不合法）：还没到终态的格标成中断，不留一格永远「进行中」。
      const interruptUnfinished = () => {
        for (const [nodeId, state] of latest.get(input.stepId) ?? []) {
          if (state.phase === 'waiting' || state.phase === 'queued' || state.phase === 'working') {
            note(input, nodeId)({ ...state, phase: 'interrupted', error: '调用中断' })
          }
        }
        latest.delete(input.stepId)
      }
      const orchestrator = new TeamOrchestrator(
        nodes,
        {
          signal: input.signal,
          runId: input.runId as RunId,
          maxConcurrent,
          node: (nodeId, state) => note(input, nodeId)(state),
          describe: describeWith(roles, clis, existing),
          dispatch: (member) =>
            dispatch({
              target: member.target,
              task: member.prompt,
              ...(member.provider ? { provider: member.provider } : {}),
              ...(member.model ? { model: member.model } : {}),
              runId: input.runId,
              stepId: input.stepId,
              nodeId: member.nodeId,
              signal: member.signal,
            }),
        },
        {
          roles: new Set(roles.map((r) => r.id)),
          clis: new Set(clis.map((c) => c.id)),
          subagents: new Set(existing.map((c) => c.id)),
        },
      )
      try {
        const result = await orchestrator.run(goal, state)
        if (result.phase === 'failed') interruptUnfinished()
        else latest.delete(input.stepId)
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
        // 图本身不合法（成环、悬空依赖、引用不到目标）在这里落地：
        // 它是模型写错了参数，要原样告诉它，不能压成一句「工具执行出错」。
        interruptUnfinished()
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
