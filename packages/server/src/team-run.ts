/**
 * Agent Team 编排的服务端侧。
 *
 * 成员会话的事件**不往父会话广播**——那些 runId 在父会话里不存在，前端会按
 * 陌生 runId 建出一条并不存在的 run。进度只由 `team.member` 事件表达。
 */

import type { AgentEvent, ConversationId, RunId, RunUsage } from '@qywork/core'
import { acquireExtensions, collectSecrets, releaseExtensions, Session } from '@qywork/runtime'
import { workspaceOf } from '@qywork/store'
import type { BuiltinBackend, Role } from '@qywork/team'
import { TeamOrchestrator } from '@qywork/team'
import { reject } from './commands.ts'
import type { CommandDeps } from './deps.ts'

/**
 * 启动一轮 Agent Team 编排。
 *
 * 编排图与角色来自工作区的 `.qy/team.json`。指令只带目标——
 * 让配置只有一个来源，否则「界面上看到的编排」和「实际跑的编排」会分叉。
 *
 * 每个成员的进展通过 `team.member` 事件广播。人工门禁（`humanGates`）走
 * `permission.request` / `permission.resolve` 通道——**两模式改造后它是这条通道
 * 仅剩的生产者**：工具授权已由 `Session.decide()` 就地裁决，不再问用户。
 * 别看到「权限」二字就以为这里也死了。
 */
export async function runTeam(
  conversationId: ConversationId,
  goal: string,
  clientRequestId: string,
  deps: CommandDeps,
): Promise<void> {
  if (!goal.trim()) {
    reject(deps.ws, 'team.run', 'invalid_payload', '目标为空', clientRequestId)
    return
  }
  if (deps.runs.isBusy(conversationId)) {
    reject(deps.ws, 'team.run', 'conflict', '该会话已有任务在执行', clientRequestId)
    return
  }

  // 跑在哪个目录下按会话查，理由与 `startRun` 里那段相同。
  const workspaceRoot = workspaceOf(deps.store, conversationId)?.rootPath
  if (!workspaceRoot) {
    reject(
      deps.ws,
      'team.run',
      'invalid_payload',
      '这个会话找不到对应的项目目录，无法执行',
      clientRequestId,
    )
    return
  }

  // 只读一下 team 配置就还回去。服务本身全程持有一份引用，
  // 这里 acquire 只是为了拿到已加载好的那份，不是要延长它的寿命。
  const ext = await acquireExtensions(workspaceRoot)
  const team = ext.team
  releaseExtensions(workspaceRoot)

  if (team.roles.length === 0) {
    // 没配就明确说没配，并指出配在哪。回一个空跑的成功会让用户以为功能坏了。
    reject(
      deps.ws,
      'team.run',
      'invalid_payload',
      team.error ?? '未配置 Agent Team：在工作区 .qy/team.json 里定义 backends 与 roles',
      clientRequestId,
    )
    return
  }

  const controller = new AbortController()
  const runId = `rn_team_${clientRequestId.slice(0, 8)}` as RunId
  deps.runs.register({ runId, conversationId, controller, startedAt: Date.now() })

  const emit = (ev: AgentEvent) => deps.bus.publish(ev, conversationId)

  // 编排的用量是各成员之和。
  //
  // 之前这里恒为 0 —— 内置后端没接线时那还算诚实，接上之后它就是在骗人了：
  // 一轮编排可能烧掉比一次普通对话多得多的 token，而账面显示 $0.0000。
  const total: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    cost: 0,
    // 成员可能跑在不同厂商上，币种未必一致。这里先记 USD，
    // 下面 addUsage 遇到第一个非 USD 的成员就跟着它——**不换算**。
    currency: 'USD',
    turns: [],
  }
  const addUsage = (u: RunUsage) => {
    total.inputTokens += u.inputTokens
    total.outputTokens += u.outputTokens
    total.reasoningTokens += u.reasoningTokens
    // 币种不同就不合并金额：跨币种相加得到的是一个没有意义的数字。
    // 编排里混用两家厂商时，这里只保留同币种那部分，并把币种钉在第一个非零的那家。
    if (u.cost > 0) {
      if (total.cost === 0) total.currency = u.currency
      if (total.currency === u.currency) total.cost += u.cost
    }
    // 缓存命中是「有回报才累加」：全程 null 表示没有一个成员回报过，
    // 累成 0 会让前端显示「缓存一次没命中」，那是个具体但错误的结论。
    if (u.cachedTokens !== null) total.cachedTokens = (total.cachedTokens ?? 0) + u.cachedTokens
    if (u.cacheWriteTokens !== null) {
      total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + u.cacheWriteTokens
    }
    total.turns.push(...u.turns)
  }

  void (async () => {
    try {
      const orchestrator = new TeamOrchestrator(
        {
          name: 'workspace',
          roles: team.roles,
          rules: team.rules,
          ...(team.plan.length ? { plan: team.plan } : {}),
        },
        {
          workspaceRoot,
          signal: controller.signal,
          // 外部 CLI 后端要它自己的 key 才能干活，但 qywork 配置里那几把它一把用不上。
          // 按值剥掉——多余的凭证没有理由出现在别人的进程里。
          secrets: collectSecrets(deps.config),
          runId,
          emit,
          runBuiltin: (input) =>
            runBuiltinMember(input, { deps, workspaceRoot, onUsage: addUsage }),
          awaitHumanGate: async (nodeId, summary) =>
            deps.runs.requestPermission({
              runId,
              conversationId,
              toolName: 'team',
              scope: `team:gate:${nodeId}`,
              preview: summary,
              action: { kind: 'delegate', objectLabel: '编排节点', target: nodeId } as never,
            }),
        },
      )
      const results = await orchestrator.run(goal)
      const failed = results.filter((r) => r.status === 'failed').length
      emit({
        type: 'run.finished',
        runId,
        status: failed > 0 ? 'failed' : 'done',
        stopReason: failed > 0 ? 'provider_error' : 'completed',
        usage: total,
        stepCount: results.length,
        durationMs: 0,
        fileChanges: [],
      })
    } catch (err) {
      emit({
        type: 'run.error',
        runId,
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      })
    } finally {
      deps.runs.unregister(runId)
    }
  })()
}

/**
 * 内置后端：用本进程的 agent 跑一个编排成员。
 *
 * 在这之前它是一句「尚未接线」的显式失败——没装 codex / claude 的用户点「开始编排」
 * 什么都得不到。而 `qy` 自己就是一个完整的 agent，把它当成一个后端用不需要新东西，
 * 只需要一个独立会话。
 *
 * ## 每个成员一个独立会话，不共用
 *
 * 成员之间的上下文必须隔离：一个「审查者」角色看见「实现者」的完整思考过程，
 * 它就不再是独立视角了，而独立视角正是多角色的全部意义。节点之间要传递的东西
 * 由编排器显式拼进 prompt（`needs` 的产出），不靠共享上下文。
 *
 * ## 内层事件不往外发
 *
 * 成员会话有自己的 runId，把它的 tool.started / text.delta 广播到父会话上，
 * 前端会按那个陌生 runId 建出一条并不存在的 run。进度由编排器的 `team.member`
 * 事件表达，那是**为这件事设计的**通道。
 */
export async function runBuiltinMember(
  input: { role: Role; prompt: string; signal: AbortSignal },
  ctx: {
    deps: CommandDeps
    /** 父会话所在的项目目录。成员会话跑在同一个根下——一轮编排不跨项目。 */
    workspaceRoot: string
    onUsage?: (u: RunUsage) => void
  },
): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }> {
  const { role } = input
  const backend = role.backend as BuiltinBackend
  const { deps } = ctx

  // provider 指定的是「用哪家的 key」。指了一个不存在的接口要**当场失败**——
  // 悄悄回落到当前接口会让「用便宜模型跑审查」这类配置静默失效，而账单在另一边。
  const pinned = backend.provider ? deps.config.providers[backend.provider] : undefined
  if (backend.provider && !pinned) {
    return {
      ok: false,
      output: '',
      error: `角色 ${role.id} 指定的接口不存在：${backend.provider}`,
    }
  }
  const config =
    backend.provider && pinned
      ? {
          ...deps.config,
          active: {
            provider: backend.provider,
            // 角色没点名模型时用这个接口下的第一个。**不能沿用当前 active.model**：
            // 那个模型属于另一个接口，拿它去发请求就是「换了 key 没换模型名」。
            model: backend.model ?? Object.keys(pinned.models)[0] ?? deps.config.active.model,
          },
        }
      : deps.config

  const session = new Session({
    store: deps.store,
    config,
    content: deps.content,
    workspaceRoot: ctx.workspaceRoot,
    signal: input.signal,
    ...(role.systemPrompt ? { extraSystem: role.systemPrompt } : {}),
    ...(role.allowedTools ? { allowedTools: role.allowedTools } : {}),
    ...(role.maxSteps ? { maxSteps: role.maxSteps } : {}),
  })

  let text = ''
  let error: string | null = null
  let conversationId: ConversationId | undefined

  try {
    for await (const ev of session.ask(input.prompt, undefined, {
      ...(backend.model ? { model: backend.model } : {}),
      // 成员子会话不进会话列表——`listConversations` 的判据是 `source IS NULL`。
      // 不打这个标记的话，每跑一次 team，用户列表里就多出 N 条以成员 prompt
      // 开头的条目，而点进去只有半截独白。
      source: 'workflow',
      sourceRef: role.id,
    })) {
      if (ev.type === 'run.started') conversationId = ev.conversationId
      else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.error') error = `[${ev.code}] ${ev.message}`
      else if (ev.type === 'run.finished') ctx.onUsage?.(ev.usage)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    session.dispose()
  }

  const output = text.trim()
  return {
    // 没报错但一个字也没产出，算失败。返回 ok + 空串会被下游当成
    // 「这个角色认真看过，确实没什么可说的」——那是两件完全不同的事。
    ok: error === null && output.length > 0,
    output,
    ...(error ? { error } : output ? {} : { error: '该角色没有产出任何内容' }),
    ...(conversationId ? { conversationId } : {}),
  }
}
