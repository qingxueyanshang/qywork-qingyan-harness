/**
 * 派活端口的服务端实现：把任务派给一个子 agent，或推进一整张图。
 *
 * **为什么在 server。** 派活 = 起或续一条子会话，那要 `Session` 与账本；两样都在依赖图上高于
 * tools。所以工具那边只声明端口（`DelegatePort`），实现落在这里。
 *
 * **派出即返回，完成是事件。** `dispatch` 只负责把它跑起来；子 agent 做完之后，
 * 这里写格的终态、组装回执，再把回执作为一条消息投进父会话（忙就在下一个 step
 * 边界注入，闲就当场起一轮）。等待、汇合、「这一轮结束就停掉它们」都不存在了。
 *
 * **一个派发函数。** `subagent` 工具派一个、`workflow` 图上每个节点，都经它：
 * 解析目标 → 子 agent 记录（新建或已有）→ 按种类跑 → 完成回调。不区分内置与外部 CLI。
 *
 * **子 agent 的 id 就是它的子会话 id。** 三种种类一个 id 空间：角色与临时的子会话有正文；
 * 外部 CLI 那一行只有元数据与外部会话句柄（`externalSession`），正文在 CLI 自己那边。
 */

import type { DelegatePort, SubagentSummary } from '@qywork/agent'
import { applySpecOverride, lookupModel, type TokenDensity } from '@qywork/ai'
import {
  type Conversation,
  type ConversationId,
  type FileChange,
  type FollowUp,
  foldWorkflow,
  type NodeState,
  type RunId,
  type StepId,
  type StopReason,
  SUBAGENT_KIND_LABEL,
  SUBAGENT_NODE_ID,
  type SubagentKind,
  type SubagentTarget,
  targetLabel,
  type WorkflowCheckpointNode,
  type WorkflowNode,
  type WorkflowProjection,
  type WorkflowTransition,
  workflowResults,
} from '@qywork/core'
import {
  collectSecrets,
  loadTeamConfig,
  type ModelRef,
  RuntimeSink,
  resolveModel,
} from '@qywork/runtime'
import {
  createConversation,
  getConversation,
  latestSubagentPhases,
  listChildConversations,
  listWorkflowRecords,
  setConversationExternalSession,
  setStepNodeState,
} from '@qywork/store'
import {
  type AdvanceResult,
  advance,
  type CliAgent,
  detectClis,
  findCli,
  type NodeDispatch,
  type OrchestratorReview,
  type Role,
  runCli,
  validatePlan,
} from '@qywork/team'
import { deliverAgentOutput, MAX_TIMEOUT_MS, openChangeWindow } from '@qywork/tools'
import type { CommandDeps } from './deps.ts'
import { memberModel, resolveModel as resolveMemberModel, runBuiltinMember } from './team-run.ts'

/** 派活只用到装配三件套（账本、正文库、配置）与两张服务级表，不碰那条 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

/** 临时子 agent 的运行约束：没有系统提示词、不限工具。名字来自派发参数。 */
const tempRole = (name: string): Role => ({ id: 'temp', name, description: '', systemPrompt: '' })

interface Resolved {
  conversation: Conversation
  /** 内置子 agent 的运行约束；外部 CLI 为 null。 */
  role: Role | null
  cli: CliAgent | null
  created: boolean
  /** 解析时发现的、模型该知道的事实：续接没接上、角色已不在。 */
  note?: string
}

/** 这一格挂在哪张卡上，以及它属不属于一张图。 */
interface DispatchAt {
  runId: string
  stepId?: string
  nodeId?: string
  /** 图节点才有：这张图的 id，与这一格的产出摘录该占单次投递预算的几分之一。 */
  workflow?: { workflowId: string; share: number }
}

/** 一个子 agent 跑完之后可知的全部事实。 */
interface Outcome {
  ok: boolean
  output: string
  error?: string
  stop?: StopReason | null
  note?: string
  /** 只有外部 CLI 有：它是本机另一个进程，改了什么只有工作区观察器看得见。 */
  fileChanges?: FileChange[]
}

/**
 * 一条会话的子 agent 清单：种类、模型、此刻的状态。运行快照与右栏那一页读的是同一份。
 * 状态按账本判：有一轮在跑是 running，最近一轮没跑完是 failed，其余 idle。
 */
export async function listSubagents(
  deps: Pick<DelegateDeps, 'store'>,
  conversationId: ConversationId,
): Promise<(SubagentSummary & { createdAt: number })[]> {
  // 状态取自它最后一次出现在卡上的那一格，三种同一条规则：外部 CLI 不建 run，按 runs 判永远是空闲。
  const phases = latestSubagentPhases(deps.store, conversationId)
  const out: (SubagentSummary & { createdAt: number })[] = []
  for (const c of listChildConversations(deps.store, conversationId)) {
    const phase = phases.get(c.id)
    const cli = c.source === 'cli' && c.sourceRef ? await findCli(c.sourceRef) : null
    out.push({
      id: c.id,
      kind: c.source === 'cli' ? 'cli' : c.source === 'role' ? 'role' : 'temp',
      name: c.title,
      provider: c.provider,
      model: c.model,
      status:
        phase === 'working'
          ? 'running'
          : phase === 'failed' || phase === 'interrupted'
            ? 'failed'
            : 'idle',
      resumable: c.source !== 'cli' || (!!c.externalSession && !!cli?.resumeArgs),
      createdAt: c.createdAt,
    })
  }
  return out
}

export function makeDelegate(ctx: {
  deps: DelegateDeps
  workspaceRoot: string
  /** 派活的那条会话。子 agent 都归它，进度事件也发给它。 */
  conversationId: ConversationId
  /**
   * 把一条回执投进这条会话：忙就排进队列在下一个 step 边界注入，闲就当场起一轮。
   *
   * **注入而不是 import**：那个函数与 `message.send` 是同一个（`run-control.ts`），
   * 而它要调 `startRun`——直接 import 就是 `run-control` ↔ `delegate` 成环。
   */
  deliver: (followUp: FollowUp) => void
}): DelegatePort {
  const { deps, workspaceRoot, conversationId, deliver } = ctx

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
        // 接不上会话照跑，但把事实交回：模型知道它只收到了这次的指令。
        const note = !conversation.externalSession
          ? '这家 CLI 上次没有给会话号，这次是新开的会话，它只收到了这次的指令'
          : !cli.resumeArgs
            ? `${cli.id} 不支持续接会话，这次是新开的会话，它只收到了这次的指令`
            : undefined
        return { conversation, role: null, cli, created: false, ...(note ? { note } : {}) }
      }
      if (conversation.source === 'role') {
        const found = (await team()).roles.find((r) => r.id === conversation.sourceRef)
        if (found) return { conversation, role: found, cli: null, created: false }
        return {
          conversation,
          role: tempRole(conversation.title),
          cli: null,
          created: false,
          note: `角色 ${conversation.sourceRef} 已不在 team.json，这次按临时子 agent 跑（没有系统提示词与工具限制）`,
        }
      }
      return { conversation, role: tempRole(conversation.title), cli: null, created: false }
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

  /**
   * 一格的名字与种类，给图上写状态用。同步：角色、CLI、已有子 agent 三份清单在图开跑前读一次。
   * 续接已有子 agent 时种类只能从那条会话记录取——参数里只有一个 id。
   */
  const describeWith =
    (roles: Role[], clis: CliAgent[], existing: Conversation[]) =>
    (target: SubagentTarget): { label: string; kind?: SubagentKind } | null => {
      if ('subagent' in target) {
        const c = existing.find((x) => x.id === target.subagent)
        return c ? { label: c.title, ...(c.source ? { kind: c.source } : {}) } : null
      }
      if (target.kind === 'temp') return { label: target.name, kind: 'temp' }
      if (target.kind === 'role') {
        const r = roles.find((x) => x.id === target.role)
        return r ? { label: target.name ?? r.name, kind: 'role' } : null
      }
      const cli = clis.find((x) => x.id === target.cli)
      return cli ? { label: target.name ?? `${cli.vendor} ${cli.id}`, kind: 'cli' } : null
    }

  /**
   * 一格的状态变了：先写进那张卡的 step，再广播。派一件与图上的节点同一条路——派一件就是
   * 一张只有一格的图。**先落账再广播**：切走父会话会错过广播，切回来从 step 回放。
   * 没有 `stepId` 的调用（没有卡）什么都不记。
   */
  const note =
    (at: { runId: string; stepId?: string }, nodeId: string) =>
    (state: NodeState): void => {
      if (!at.stepId) return
      setStepNodeState(deps.store, at.stepId as StepId, nodeId, state)
      deps.bus.publish(
        { type: 'team.member', runId: at.runId as RunId, stepId: at.stepId, nodeId, state },
        conversationId,
      )
    }

  /**
   * 产出过投递闸的上下文。**摘录长度按父会话当前模型的窗口算**——回执要进的是它的上下文。
   * 模型不在配置里时按未收录模型的保守窗口，不为此拒发回执。
   */
  const deliveryContext = (runId: string) => {
    const conv = getConversation(deps.store, conversationId)
    const stored = resolveModel(
      deps.config,
      conv?.provider && conv.model ? { provider: conv.provider, model: conv.model } : undefined,
    )
    const spec = applySpecOverride(
      lookupModel(stored?.model ?? conv?.model ?? '', stored?.kind ?? 'openai_chat_completions'),
      stored?.spec,
    )
    return {
      sink: new RuntimeSink(deps.store, deps.content, runId as RunId),
      contextWindow: spec.contextWindow,
      density: spec.density as TokenDensity,
      state: new Map<string, unknown>(),
    }
  }

  /**
   * 子 agent 的产出过闸。**这一步不能省**：产出没有上界，一份被杀在半路的外部 CLI
   * 回执实测二十六万字符，整段进上下文之后压缩层已经无从下手（单条结果超过整个
   * 批级保留预算），那一轮的读数会直接越过窗口。超预算的落盘，正文里留定位符。
   */
  const excerpt = (at: DispatchAt, nodeId: string, body: string): string => {
    if (!body) return ''
    return deliverAgentOutput(deliveryContext(at.runId), {
      toolName: at.workflow ? 'workflow' : 'subagent',
      sourceType: at.workflow ? `workflow:${nodeId}` : 'subagent',
      body,
      ...(at.workflow ? { share: at.workflow.share } : {}),
    }).text
  }

  /** 一条回执进队列。id 只要唯一：它服务的是队列去重与那张卡的寻址。 */
  const send = (content: string, origin: 'subagent' | 'workflow'): void => {
    deliver({ id: `rc_${crypto.randomUUID()}`, content, steer: true, origin })
  }

  // ─────────────────────────── 派出 ───────────────────────────

  const dispatch: DelegatePort['dispatch'] = async (input) => {
    return start(input.target, input.task, {
      runId: input.runId,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      nodeId: input.nodeId ?? SUBAGENT_NODE_ID,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
    })
  }

  /**
   * 派出去，当场返回。跑完之后由 `complete` 写终态、发回执。
   *
   * controller **不链任何 run 的信号**：子 agent 的生命期跟着会话，
   * 停它的只有三处——按会话停止、删会话、服务退出，全部经在跑表。
   */
  const start = async (
    target: SubagentTarget,
    task: string,
    at: DispatchAt & { provider?: string; model?: string },
  ): Promise<Awaited<ReturnType<DelegatePort['dispatch']>>> => {
    const nodeId = at.nodeId ?? SUBAGENT_NODE_ID
    const resolved = await resolveTarget(target, at.model, at.provider)
    if ('error' in resolved) {
      // 目标不成立也是这一格的终态：不写的话卡上那格永远停在等待，而工具说派不出去。
      note(
        at,
        nodeId,
      )({
        phase: 'failed',
        label: targetLabel(target),
        // 只给了子 agent id 时判不出种类：那条会话没解析成，记录取不到。
        ...('subagent' in target ? {} : { kind: target.kind }),
        error: resolved.error,
      })
      return { ok: false, error: resolved.error }
    }

    const id = resolved.conversation.id
    const label = resolved.conversation.title
    const kindOf = resolved.conversation.source ? { kind: resolved.conversation.source } : {}
    const controller = new AbortController()
    deps.subagents.add(conversationId, id, {
      name: label,
      kind: resolved.conversation.source ?? 'temp',
      controller,
    })
    deps.runs.announce(conversationId)
    note(at, nodeId)({ phase: 'working', label, ...kindOf, subagentId: id })

    const started = Date.now()
    void perform(resolved, task, at, controller.signal)
      .then((outcome) => complete(resolved, at, outcome, controller.signal, started))
      .catch((err) => {
        // `perform` 自己 try/catch 不抛，走到这里的是完成回调里的意外：
        // **必须落终态**，否则卡上那一格停在「进行中」，而没有人会再来收它。
        complete(
          resolved,
          at,
          { ok: false, output: '', error: err instanceof Error ? err.message : String(err) },
          controller.signal,
          started,
        )
      })

    return {
      ok: true,
      subagentId: id,
      name: label,
      ...kindOf,
      created: resolved.created,
      ...(resolved.note ? { note: resolved.note } : {}),
    }
  }

  /** 真正把它跑起来。**不抛**：失败是返回值，终态由 `complete` 统一落。 */
  const perform = async (
    resolved: Resolved,
    task: string,
    at: DispatchAt,
    signal: AbortSignal,
  ): Promise<Outcome> => {
    const { conversation, role, cli } = resolved
    const notes: string[] = resolved.note ? [resolved.note] : []
    const nodeId = at.nodeId ?? SUBAGENT_NODE_ID
    try {
      if (cli) {
        // 它是本机另一个进程，跑完之前写了什么，不发出来一个字都看不到。
        const stepId = at.stepId
        const changeWindow = openChangeWindow(workspaceRoot)
        const r = await runCli(cli, {
          prompt: task,
          workspaceRoot,
          signal,
          ...(conversation.externalSession ? { resume: conversation.externalSession } : {}),
          // 外部 CLI 要它自己的 key 才能执行，但 qywork 配置里那几把它一把用不上。
          secrets: collectSecrets(deps.config),
          ...(stepId
            ? {
                onChunk: (delta: string) =>
                  deps.bus.publish(
                    { type: 'team.output', runId: at.runId as RunId, stepId, nodeId, delta },
                    conversationId,
                  ),
              }
            : {}),
        })
        const fileChanges = await changeWindow.close()
        // 会话句柄无论成败都记下：执行失败时更需要续接会话问清楚断点。
        if (r.session) setConversationExternalSession(deps.store, conversation.id, r.session)
        else if (!conversation.externalSession) {
          notes.push('这家 CLI 没有给会话号，续派它不记得这次的内容，任务要写全')
        }
        const error = r.ok
          ? undefined
          : r.timedOut
            ? `静默 ${MAX_TIMEOUT_MS / 1000} 秒，已终止`
            : `退出码 ${r.exitCode}${r.stderr ? `：${r.stderr.slice(-500)}` : ''}`
        return {
          ok: r.ok,
          output: r.output,
          ...(error ? { error } : {}),
          ...(notes.length ? { note: notes.join('；') } : {}),
          ...(fileChanges.length ? { fileChanges } : {}),
        }
      }

      const { rules } = await team()
      const res = await runBuiltinMember(
        {
          role: role ?? tempRole(conversation.title),
          prompt: task,
          signal,
          conversationId: conversation.id,
          ...(at.stepId ? { dispatch: { stepId: at.stepId as StepId, nodeId } } : {}),
        },
        {
          deps,
          workspaceRoot,
          ...(rules.shared ? { shared: rules.shared } : {}),
          // 子会话的事件按**它自己的会话 id** 发；图卡进度归父会话，是上面那条 `note`。
          onEvent: (ev, cid) => deps.bus.publish(ev, cid),
        },
      )
      return {
        ok: res.ok,
        output: res.output,
        ...(res.error ? { error: res.error } : {}),
        stop: res.stop,
        ...(notes.length ? { note: notes.join('；') } : {}),
      }
    } catch (err) {
      // 成员会话自己 try/catch 不抛（`team-run.ts`），走到这里的是装配期的意外。
      return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 一个子 agent 落终态：写格、发回执、图上接着往下派。
   *
   * **被中断的不发回执，也不推进图。** 中断只来自「停这条会话」与服务退出，两者都是
   * 「这条会话的活全停」；投一条回执进去等于停完又起一轮，正好与用户按的那一下相反。
   * 事实写在格上，模型下次被唤醒时从快照里看得到。
   */
  const complete = (
    resolved: Resolved,
    at: DispatchAt,
    outcome: Outcome,
    signal: AbortSignal,
    started: number,
  ): void => {
    const id = resolved.conversation.id
    const label = resolved.conversation.title
    const kindOf = resolved.conversation.source ? { kind: resolved.conversation.source } : {}
    const nodeId = at.nodeId ?? SUBAGENT_NODE_ID
    deps.subagents.remove(conversationId, id)
    deps.runs.announce(conversationId)

    const interrupted = signal.aborted || outcome.stop === 'user_interrupt'
    const output = interrupted ? '' : excerpt(at, nodeId, outcome.output)
    const error = interrupted ? '已停止' : outcome.error
    note(
      at,
      nodeId,
    )({
      phase: interrupted ? 'interrupted' : outcome.ok ? 'done' : 'failed',
      label,
      ...kindOf,
      subagentId: id,
      durationMs: Date.now() - started,
      ...(error ? { error } : {}),
      ...(output ? { output } : {}),
      ...(outcome.note ? { note: outcome.note } : {}),
      ...(outcome.fileChanges?.length ? { fileChanges: outcome.fileChanges } : {}),
    })
    if (interrupted) return

    if (at.workflow) {
      continueGraph(at.workflow.workflowId, at, { nodeId, failed: !outcome.ok })
      return
    }
    send([head(resolved, outcome.ok, error), output].filter(Boolean).join('\n'), 'subagent')
  }

  /** 回执第一行：谁、什么结果。种类词与界面、提示词同一张表。 */
  const head = (resolved: Resolved, ok: boolean, error?: string): string => {
    const kind = resolved.conversation.source ?? 'temp'
    const who = `${SUBAGENT_KIND_LABEL[kind]} ${resolved.conversation.title}`
    const tail = ok ? '已返回' : `没做成：${error ?? '没有说明原因'}`
    return `[子 agent 回执] ${who}（subagentId ${resolved.conversation.id}）${tail}`
  }

  // ─────────────────────────── 图 ───────────────────────────

  /** 图上一格的产出摘录该占单次投递预算的几分之一：同一条检查点回执里几格平分。 */
  const shareOf = (nodes: WorkflowNode[], nodeId: string): number => {
    const checkpoint = nodes.find(
      (node): node is WorkflowCheckpointNode =>
        node.kind === 'checkpoint' && node.needs.includes(nodeId),
    )
    if (!checkpoint) return 1
    const agents = checkpoint.needs.filter((id) =>
      nodes.some((node) => node.id === id && node.kind !== 'checkpoint'),
    )
    return Math.max(1, agents.length)
  }

  /** 把推进器算出来的这一趟落下去：跳过的、排队的、要派的、到了的检查点。 */
  const applyAdvance = (
    result: AdvanceResult,
    projection: WorkflowProjection,
    at: { runId: string; stepId?: string },
  ): void => {
    for (const skipped of result.skipped) note(at, skipped.nodeId)(skipped.state)
    for (const queued of result.queued) note(at, queued.nodeId)(queued.state)
    for (const plan of result.dispatch) startNode(plan, projection, at)
    if (result.checkpoint) sendCheckpointReceipt(projection, result.checkpoint)
  }

  const startNode = (
    plan: NodeDispatch,
    projection: WorkflowProjection,
    at: { runId: string; stepId?: string },
  ): void => {
    /*
     * 先同步占住这一格再去解析目标。
     *
     * 解析要 await（读角色库、探测 CLI），那段窗口里另一格跑完就会重新推进一次，
     * 而那时这一格在账本上还没有状态——推进器会把它再派一次，同一格因此有两个子 agent。
     */
    const prior = projection.states[plan.nodeId]
    note(
      at,
      plan.nodeId,
    )({
      phase: 'working',
      label: prior?.label ?? targetLabel(plan.target),
      ...(prior?.kind ? { kind: prior.kind } : {}),
    })
    void start(plan.target, plan.prompt, {
      runId: at.runId,
      ...(at.stepId ? { stepId: at.stepId } : {}),
      nodeId: plan.nodeId,
      workflow: {
        workflowId: projection.workflowId,
        share: shareOf(projection.nodes, plan.nodeId),
      },
      ...(plan.provider ? { provider: plan.provider } : {}),
      ...(plan.model ? { model: plan.model } : {}),
    })
  }

  /**
   * 一格跑完之后接着推进这张图：从账本重建投影，算出这一趟该派谁。
   *
   * **从账本重建，不留内存里的图。** 派活通道每一轮新建，而一格跑完可能已经是好几轮
   * 之后的事；账本是唯一能跨轮回答「这张图跑到哪了」的地方。
   */
  const continueGraph = (
    workflowId: string,
    at: { runId: string; stepId?: string },
    just: { nodeId: string; failed: boolean },
  ): void => {
    const folded = foldWorkflow(listWorkflowRecords(deps.store, conversationId), workflowId)
    if (!folded.ok) {
      send(`[workflow 回执] ${workflowId} 的账本读不回来：${folded.error}`, 'workflow')
      return
    }
    const projection = folded.projection
    let result: AdvanceResult
    try {
      result = advance({
        plan: projection.nodes,
        goal: projection.goal,
        maxConcurrent: projection.maxConcurrent,
        states: projection.states,
        approvals: projection.approvals,
      })
    } catch (err) {
      send(
        `[workflow 回执] ${workflowId} 推进不下去：${err instanceof Error ? err.message : String(err)}`,
        'workflow',
      )
      return
    }
    /*
     * 失败先单发一条，其余格照跑——父会话不必等整批跑完才知道有一格早就失败了。
     * 这一趟同时到了检查点就不发：检查点回执里逐格列着，同一件事印两处。
     */
    if (just.failed && !result.checkpoint) {
      const receipt = projection.results[just.nodeId]
      send(
        [
          `[workflow 回执] ${just.nodeId}（${receipt?.label ?? just.nodeId}）没做成：${receipt?.error ?? '没有说明原因'}`,
          `workflowId=${workflowId}`,
        ].join('\n'),
        'workflow',
      )
    }
    applyAdvance(result, projection, at)
  }

  /** 检查点到了：把它上游每一格的回执摘录列出来，交回父会话决定 approve 还是 revise。 */
  const sendCheckpointReceipt = (projection: WorkflowProjection, checkpointId: string): void => {
    const checkpoint = projection.nodes.find(
      (node): node is WorkflowCheckpointNode =>
        node.kind === 'checkpoint' && node.id === checkpointId,
    )
    if (!checkpoint) return
    const results = workflowResults(projection.nodes, projection.states)
    const cells = checkpoint.needs
      .map((id) => results[id])
      .filter((receipt): receipt is NonNullable<typeof receipt> => !!receipt)
      .map((receipt) => {
        const state =
          receipt.status === 'done' ? '已返回' : `没做成：${receipt.error ?? receipt.status}`
        const body = [receipt.output, receipt.note].filter(Boolean).join('\n')
        return `### ${receipt.nodeId}（${receipt.label}）${state}\n${body || '无产出'}`
      })
    send(
      [
        `[workflow 回执] 检查点 ${checkpoint.label} 的上游已经全部返回`,
        ...cells,
        `workflowId=${projection.workflowId}，checkpointId=${checkpoint.id}`,
      ].join('\n\n'),
      'workflow',
    )
  }

  const port: DelegatePort = {
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

    inflight() {
      return deps.subagents.listOf(conversationId).map((entry) => ({ name: entry.name }))
    },

    /**
     * 推进一张图。首派校验并把就绪的格派出去，审查动作先落批准或修订再派下一批，
     * 两条都当场返回：格跑完的回执与检查点回执由完成回调投递。
     */
    async runGraph(input) {
      const startedAt = Date.now()
      const [{ roles }, clis] = await Promise.all([team(), detectClis()])
      const listedAt = Date.now()
      const existing = children()
      const workflowId = input.call.kind === 'start' ? input.stepId : input.call.workflowId
      const at = { runId: input.runId, stepId: input.stepId }

      let projection: WorkflowProjection
      let review: OrchestratorReview | undefined
      if (input.call.kind === 'start') {
        projection = {
          workflowId,
          goal: input.call.goal,
          nodes: input.call.nodes,
          maxConcurrent: input.call.maxConcurrent,
          phase: 'running',
          results: {},
          states: {},
          approvals: {},
        }
      } else {
        // 本次调用那条记录要排除：它的审查动作在下面当场应用，折进来就成了应用两次。
        const folded = foldWorkflow(
          listWorkflowRecords(deps.store, conversationId, input.stepId as StepId),
          workflowId,
        )
        if (!folded.ok) return { ok: false, error: folded.error }
        projection = folded.projection
        /*
         * 这道闸只拦 approve。revise 对任意检查点都成立，包括已批准的与被打断的：
         * 「批准 = 解散」正是返工只能另起一个子 agent 的根因，被打断的图也靠 revise 续跑原子 agent。
         */
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
        review = {
          checkpointId: input.call.checkpointId,
          decision: input.call.decision,
          note: input.call.note,
          revisions: input.call.revisions,
        }
      }

      // 真机上出现过工具已开始执行、几分钟后才写第一格的情形，来源未定；起跑前的耗时超过两秒就记一行。
      const foldedAt = Date.now()
      if (foldedAt - startedAt > 2000) {
        process.stderr.write(
          `[qy] workflow 起跑前 ${foldedAt - startedAt}ms（角色与 CLI 清单 ${listedAt - startedAt}ms，账本折叠 ${foldedAt - listedAt}ms）\n`,
        )
      }

      let result: AdvanceResult
      try {
        // 图本身不合法（成环、悬空依赖、引用不到目标）与审查不成立都在这里落地：
        // 它是模型写错了参数，要原样告诉它，不能压成一句「工具执行出错」。
        validatePlan(projection.nodes, {
          roles: new Set(roles.map((r) => r.id)),
          clis: new Set(clis.map((c) => c.id)),
          subagents: new Set(existing.map((c) => c.id)),
        })
        result = advance({
          plan: projection.nodes,
          goal: projection.goal,
          maxConcurrent: projection.maxConcurrent,
          states: projection.states,
          approvals: projection.approvals,
          ...(review ? { review } : {}),
        })
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      // 图一开跑就把还没派的格标成等待：刷新之后也看得见全貌，不只看见跑起来的那几格。
      if (input.call.kind === 'start') {
        const describe = describeWith(roles, clis, existing)
        for (const node of projection.nodes) {
          if (node.kind === 'checkpoint') continue
          const described = describe(node.target) ?? { label: targetLabel(node.target) }
          note(at, node.id)({ phase: 'waiting', ...described })
        }
      }
      applyAdvance(result, projection, at)

      const transition: WorkflowTransition = {
        workflowId,
        dispatched: result.dispatch.map((plan) => plan.nodeId),
        ...(result.review ? { review: result.review } : {}),
      }
      return { ok: true, transition, completed: result.completed }
    },
  }
  return port
}
