/**
 * 任务派发端口的服务端实现：将任务派发给子 agent，或推进整个工作流图。
 *
 * **实现位于 server。** 派发任务即新建或续接一条子会话，需要 `Session` 与账本，两者在依赖图上均高于
 * tools。因此工具侧只声明端口（`DelegatePort`），实现位于此处。
 *
 * **派发后立即返回，完成以事件通知。** `dispatch` 只负责启动子 agent；子 agent 完成之后，
 * 此处写入节点终态、组装回执，再将回执作为一条消息投递到父会话（父会话忙碌时在下一个 step
 * 边界注入，空闲时立即启动一轮）。不设等待与汇合，本轮结束时也不停止子 agent。
 *
 * **单一派发函数。** `subagent` 工具的单次派发与 `workflow` 图上的每个节点都经由它：
 * 解析目标 → 子 agent 记录（新建或已有）→ 按种类执行 → 完成回调。不区分内置与外部 CLI。
 *
 * **子 agent 的 id 即其子会话 id。** 三个种类共用一个 id 空间：角色与临时子 agent 的子会话有正文；
 * 外部 CLI 的会话记录只有元数据与外部会话句柄（`externalSession`），正文保存在 CLI 一侧。
 */

import type { DelegatePort, SubagentSummary } from '@qywork/agent'
import { applySpecOverride, lookupModel, type TokenDensity } from '@qywork/ai'
import {
  type Conversation,
  type ConversationId,
  type FileChange,
  type FollowUp,
  foldWorkflow,
  log,
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
import { deliverAgentOutput, openChangeWindow } from '@qywork/tools'
import type { CommandDeps } from './deps.ts'
import { memberModel, resolveModel as resolveMemberModel, runBuiltinMember } from './team-run.ts'

/** 任务派发只使用装配的三项基础依赖（账本、正文库、配置）与两张服务级表，不涉及 WebSocket。 */
type DelegateDeps = Omit<CommandDeps, 'ws'>

/** 临时子 agent 的运行约束：无系统提示词、不限制工具。名称取自派发参数。 */
const tempRole = (name: string): Role => ({ id: 'temp', name, description: '', systemPrompt: '' })

interface Resolved {
  conversation: Conversation
  /** 内置子 agent 的运行约束；外部 CLI 为 null。 */
  role: Role | null
  cli: CliAgent | null
  created: boolean
  /** 解析时发现的、需要告知模型的事实：会话未能续接、角色已不存在。 */
  note?: string
}

/** 节点所在的卡片（run 与 step），以及它是否属于工作流图。 */
interface DispatchAt {
  runId: string
  stepId?: string
  nodeId?: string
  /** 仅图节点具有：工作流图的 id，以及该节点产出摘录所占的份额（单份视图尺寸的 1/share）。 */
  workflow?: { workflowId: string; share: number }
}

/** 子 agent 执行完毕后可知的全部事实。 */
interface Outcome {
  ok: boolean
  output: string
  error?: string
  stop?: StopReason | null
  note?: string
  /** 仅外部 CLI 具有：它是本机的另一个进程，其文件改动只能由工作区观察器获知。 */
  fileChanges?: FileChange[]
}

/**
 * 会话的子 agent 清单：种类、模型、当前状态。运行快照与右栏的子 agent 页读取同一份数据。
 * 状态按账本中最近一次节点状态判定：working 为 running，failed 或 interrupted 为 failed，其余为 idle。
 */
export async function listSubagents(
  deps: Pick<DelegateDeps, 'store'>,
  conversationId: ConversationId,
): Promise<(SubagentSummary & { createdAt: number })[]> {
  // 状态取自该子 agent 最后一次出现在卡片上的节点，三个种类使用同一规则：外部 CLI 不创建 run，按 runs 判定将始终为空闲。
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
  /** 发起派发的会话。子 agent 均归属于该会话，进度事件也发送给它。 */
  conversationId: ConversationId
  /**
   * 将一条回执投递到该会话：会话忙碌时排入队列，在下一个 step 边界注入；空闲时立即启动一轮。
   *
   * **由调用方注入，不直接 import**：该函数与 `message.send` 是同一个实现（`run-control.ts`），
   * 而它需要调用 `startRun`，直接 import 会使 `run-control` ↔ `delegate` 成环。
   */
  deliver: (followUp: FollowUp) => void
}): DelegatePort {
  const { deps, workspaceRoot, conversationId, deliver } = ctx

  /**
   * 本轮各次外部 CLI 已报告的工作区相对路径。一个 `makeDelegate` 对应一个
   * `Session`，即一轮（`run-control.ts` 为每条消息新建）。
   *
   * 观察器用它对账：删除整个目录时，递归 watch 只给出该目录的一条事件，目录中的文件
   * 在两个来源中均不可见；不对账时这些文件停留在最后一次观察到的状态。
   */
  const reported = new Set<string>()

  /**
   * 角色与团队规则**每次直接读取文件**，不经由 `acquireExtensions`。
   *
   * 扩展由引用计数缓存，服务运行期间始终持有一份；经由缓存读取时，模型在本轮用 `define_role`
   * 新建的角色在同一轮派发任务时不可见。设置页的接口（`api/team.ts`）出于同样的原因也直接读取文件。
   */
  const team = async () => {
    const cfg = await loadTeamConfig(workspaceRoot)
    return { roles: cfg.roles, rules: cfg.rules }
  }

  /**
   * 父会话当前的「接口 × 模型」。子 agent 未指定模型时沿用该组合，而不是 `config.active`。
   * **每次实时读取**：模型是会话级属性，用户可随时在界面上切换。
   */
  const inherited = (): ModelRef | undefined => {
    const c = getConversation(deps.store, conversationId)
    return c?.provider && c.model ? { provider: c.provider, model: c.model } : undefined
  }

  /** 确定本次使用的接口与模型：指定了模型时解析该模型，未指定时继承父会话。 */
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
   * 解析派发目标。已有子 agent 按 id 取得，并校验其属于本会话；新建时立即写入一条会话记录，
   * id 随即固定，进度事件与图卡片在子 agent 开始运行之前即可取得入口。
   */
  const resolveTarget = async (
    target: SubagentTarget,
    model?: string,
    provider?: string,
  ): Promise<Resolved | { error: string }> => {
    const parent = getConversation(deps.store, conversationId)
    if (!parent) return { error: '未找到当前会话' }

    if ('subagent' in target) {
      if (model || provider) {
        return { error: '续接已有子 agent 时不能另行指定模型，子 agent 沿用其原有会话' }
      }
      const conversation = getConversation(deps.store, target.subagent as ConversationId)
      if (!conversation || conversation.parentConversationId !== conversationId) {
        return { error: `本会话中没有子 agent ${target.subagent}` }
      }
      if (conversation.source === 'cli') {
        const cli = conversation.sourceRef ? await findCli(conversation.sourceRef) : null
        if (!cli) return { error: `本机未识别到 ${conversation.sourceRef}` }
        // 无法续接会话时照常执行，但将该事实返回给模型：子 agent 只收到了本次的指令。
        const note = !conversation.externalSession
          ? '该 CLI 上次未提供会话号，本次为新会话，只收到了本次的指令'
          : !cli.resumeArgs
            ? `${cli.id} 不支持续接会话，本次为新会话，只收到了本次的指令`
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
          note: `角色 ${conversation.sourceRef} 已不在 team.json，本次按临时子 agent 运行（无系统提示词与工具限制）`,
        }
      }
      return { conversation, role: tempRole(conversation.title), cli: null, created: false }
    }

    if (target.kind === 'cli') {
      // 外部 CLI 使用自身的模型。此处直接返回错误，不要忽略模型参数照常执行：那样界面显示的模型与实际使用的模型不一致。
      if (model || provider) {
        return {
          error: `${target.cli} 使用自身的模型，无法指定 ${provider ? `${provider}/` : ''}${model ?? ''}`,
        }
      }
      const cli = await findCli(target.cli)
      if (!cli) return { error: `本机未识别到 ${target.cli}` }
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
      if (!found) return { error: `本项目中没有角色 ${target.role}` }
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
   * 节点的名称与种类，用于在图上写入状态。同步函数：角色、CLI、已有子 agent 三份清单在图开始运行前读取一次。
   * 续接已有子 agent 时种类只能从其会话记录取得：参数中只有 id。
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
   * 节点状态变化：先写入所在卡片的 step，再广播。单次派发与图上的节点使用同一路径：单次派发即
   * 只有一个节点的图。**先写入账本再广播**：切离父会话会错过广播，切回时从 step 回放。
   * 没有 `stepId` 的调用（没有卡片）不记录任何内容。
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
   * 产出经过投递限制时使用的上下文。**摘录长度按父会话当前模型的窗口计算**：回执进入的是父会话的上下文。
   * 模型不在配置中时按未收录模型的保守窗口计算，不因此拒绝发送回执。
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
    }
  }

  /**
   * 子 agent 的产出经过投递限制。**不能省略此步骤**：产出没有上限，一次中途被终止的外部 CLI
   * 回执实测为二十六万字符；整段进入上下文后压缩无法处理（单条消息超过压缩保留的
   * 上下文末尾），该轮的读数会直接超出窗口。超出摘录尺寸的部分写入磁盘，正文中保留定位符。
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

  /** 将一条回执加入队列。id 只需唯一：它用于队列去重与卡片寻址。 */
  const send = (content: string, origin: 'subagent' | 'workflow'): void => {
    deliver({ id: `rc_${crypto.randomUUID()}`, content, steer: true, origin })
  }

  // ─────────────────────────── 派发 ───────────────────────────

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
   * 派发后立即返回。执行完毕后由 `complete` 写入终态并发送回执。
   *
   * controller **不关联任何 run 的信号**：子 agent 的生命期跟随会话，
   * 只有三处能停止它：按会话停止、删除会话、服务退出，均经由运行表。
   */
  const start = async (
    target: SubagentTarget,
    task: string,
    at: DispatchAt & { provider?: string; model?: string },
  ): Promise<Awaited<ReturnType<DelegatePort['dispatch']>>> => {
    const nodeId = at.nodeId ?? SUBAGENT_NODE_ID
    const resolved = await resolveTarget(target, at.model, at.provider)
    if ('error' in resolved) {
      // 目标无效同样是该节点的终态：不写入时卡片上该节点始终停留在等待，而工具已报告无法派发。
      note(
        at,
        nodeId,
      )({
        phase: 'failed',
        label: targetLabel(target),
        // 只提供子 agent id 时无法判定种类：该会话未能解析，无法取得记录。
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
        // `perform` 内部捕获异常、不抛出，到达此处的是完成回调中的意外异常：
        // **必须写入终态**，否则卡片上该节点停留在「进行中」，且之后没有任何路径会再处理它。
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

  /** 实际启动执行。**不抛出异常**：失败以返回值表示，终态由 `complete` 统一写入。 */
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
        // 外部 CLI 是本机的另一个进程，执行完毕之前写入的内容只能经由观察器推送获知。
        const stepId = at.stepId
        // 必须先打开观察窗口再启动进程：窗口起点之前写入的文件无法判定为该 CLI 新建。
        // 无法启动时关闭窗口：不关闭则该窗口始终排在最前，此后的窗口收不到任何事件。
        const changeWindow = openChangeWindow(workspaceRoot, { reported })
        const r = await runCli(cli, {
          prompt: task,
          workspaceRoot,
          signal,
          ...(conversation.externalSession ? { resume: conversation.externalSession } : {}),
          // 外部 CLI 使用自身的 key 执行；qywork 配置中的 key 对它没有用途，按值剥离。
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
        }).catch(async (e: unknown) => {
          await changeWindow.close()
          throw e
        })
        const watched = await changeWindow.close()
        for (const c of watched.changes) {
          if (c.changeType === 'deleted') reported.delete(c.path)
          else reported.add(c.path)
        }
        // 观察范围不完整时必须告知模型：不说明时，观察遗漏与确实没有改动无法区分。
        if (watched.incomplete) notes.push('工作区观察范围不完整，本次的文件改动清单可能有遗漏')
        // 无论成败均记录会话句柄：执行失败时更需要续接会话以确认中断位置。
        if (r.session) setConversationExternalSession(deps.store, conversation.id, r.session)
        else if (!conversation.externalSession) {
          notes.push('该 CLI 未提供会话号，再次派发时不会保留本次内容，任务须完整描述')
        }
        return {
          ok: r.ok,
          output: r.output,
          ...(r.error ? { error: r.error } : {}),
          ...(notes.length ? { note: notes.join('；') } : {}),
          ...(watched.changes.length ? { fileChanges: watched.changes } : {}),
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
          // 子会话的事件按**子会话自身的 id** 发布；图卡片的进度属于父会话，由上方的 `note` 发布。
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
      // 成员会话内部捕获异常、不抛出（`team-run.ts`），到达此处的是装配阶段的意外异常。
      return { ok: false, output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * 子 agent 进入终态：写入节点状态、发送回执、继续派发图上的后续节点。
   *
   * **被中断的子 agent 不发送回执，也不推进图。** 中断只来自停止该会话与服务退出，两者的含义均为
   * 停止该会话的全部执行；投递回执会在停止后再启动一轮，与用户的操作相反。
   * 中断事实写入节点状态，模型下次被唤醒时可从快照中读取。
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

  /** 回执首行：执行者与结果。种类名称与界面、提示词使用同一张表。 */
  const head = (resolved: Resolved, ok: boolean, error?: string): string => {
    const kind = resolved.conversation.source ?? 'temp'
    const who = `${SUBAGENT_KIND_LABEL[kind]} ${resolved.conversation.title}`
    const tail = ok ? '已返回' : `失败：${error ?? '未说明原因'}`
    return `[子 agent 回执] ${who}（subagentId ${resolved.conversation.id}）${tail}`
  }

  // ─────────────────────────── 图 ───────────────────────────

  /** 图节点产出摘录所占的份额（单份视图尺寸的 1/share）：同一条检查点回执中的各节点平分。 */
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

  /** 将推进器本次的计算结果写入账本并执行：跳过、排队、待派发的节点与已到达的检查点。 */
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
     * 先同步占用该节点，再解析目标。
     *
     * 解析需要 await（读取角色库、探测 CLI），期间另一节点执行完毕会再次推进，
     * 而此时该节点在账本中尚无状态，推进器会再次派发它，同一节点因此有两个子 agent。
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
   * 节点执行完毕后继续推进该图：从账本重建投影，计算本次应派发的节点。
   *
   * **从账本重建，不在内存中保留图。** 任务派发通道每一轮新建，而节点执行完毕可能发生在若干轮
   * 之后；只有账本能跨轮记录图的执行进度。
   */
  const continueGraph = (
    workflowId: string,
    at: { runId: string; stepId?: string },
    just: { nodeId: string; failed: boolean },
  ): void => {
    const folded = foldWorkflow(listWorkflowRecords(deps.store, conversationId), workflowId)
    if (!folded.ok) {
      send(`[workflow 回执] ${workflowId} 的账本无法读取：${folded.error}`, 'workflow')
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
        `[workflow 回执] ${workflowId} 无法推进：${err instanceof Error ? err.message : String(err)}`,
        'workflow',
      )
      return
    }
    /*
     * 节点失败时先单独发送一条回执，其余节点照常执行：父会话无需等待整批执行完毕即可得知失败。
     * 只有检查点直接列出了该失败节点时才去重。经由被跳过的下游到达检查点时，
     * 检查点并不包含原失败节点，仍须单独回传其错误。
     */
    const includedInCheckpoint = projection.nodes.some(
      (node) =>
        node.kind === 'checkpoint' &&
        node.id === result.checkpoint &&
        node.needs.includes(just.nodeId),
    )
    if (just.failed && !includedInCheckpoint) {
      const receipt = projection.results[just.nodeId]
      send(
        [
          `[workflow 回执] ${just.nodeId}（${receipt?.label ?? just.nodeId}）失败：${receipt?.error ?? '未说明原因'}`,
          `workflowId=${workflowId}`,
        ].join('\n'),
        'workflow',
      )
    }
    applyAdvance(result, projection, at)
  }

  /** 到达检查点：列出其每个上游节点的回执摘录，交由父会话决定 approve 或 revise。 */
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
          receipt.status === 'done' ? '已返回' : `失败：${receipt.error ?? receipt.status}`
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
     * 推进工作流图。首次派发时校验并派发就绪的节点；审查动作先写入批准或修订，再派发下一批。
     * 两种调用均立即返回：节点执行完毕的回执与检查点回执由完成回调投递。
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
        // 排除本次调用的记录：其审查动作在下方直接应用，纳入折叠会导致应用两次。
        const folded = foldWorkflow(
          listWorkflowRecords(deps.store, conversationId, input.stepId as StepId),
          workflowId,
        )
        if (!folded.ok) return { ok: false, error: folded.error }
        projection = folded.projection
        /*
         * 此检查只拦截 approve。revise 对任意检查点均有效，包括已批准的与被中断的：
         * 若批准即解散子 agent，返工只能另起新的子 agent；被中断的图也依靠 revise 续接原有子 agent。
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

      // 实际运行中出现过工具开始执行数分钟后才写入第一个节点状态的情形，原因未明；开始执行前的耗时超过两秒时记录一条日志。
      const foldedAt = Date.now()
      if (foldedAt - startedAt > 2000) {
        log.warn('workflow', '开始执行前耗时过长', {
          totalMs: foldedAt - startedAt,
          listMs: listedAt - startedAt,
          foldMs: foldedAt - listedAt,
        })
      }

      let result: AdvanceResult
      try {
        // 图本身不合法（成环、悬空依赖、引用的目标不存在）与审查无效均在此处返回：
        // 这些是模型的参数错误，须原样告知模型，不能概括为「工具执行出错」。
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

      // 图开始运行时即将尚未派发的节点标为等待：刷新后可看到全部节点，而不只是已运行的节点。
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
