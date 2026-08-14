/**
 * run 的起、重试与压缩。
 *
 * 三条入口共用同一个 `Session` 装配：手动发消息、定时任务触发、重试。
 * 给任何一条单开一套装配就是三套会漂移的行为。
 */

import type { Summarizer } from '@qywork/agent'
import { buildAdapter, computeCost, ProviderError, type ProviderUsage } from '@qywork/ai'
import type { AgentEvent, Attachment, ConversationId, Run, RunId } from '@qywork/core'
import {
  configPath,
  RuntimeCompaction,
  resolveApiKey,
  resolveModel,
  Session,
} from '@qywork/runtime'
import { getConversation, getRun, listMessages, recordUsage, workspaceOf } from '@qywork/store'
import { reject } from './commands.ts'
import type { CommandDeps } from './deps.ts'
import { publishGitState } from './http-util.ts'

/**
 * 重试一个已结束的 run。
 *
 * 三条硬约束：
 * - **只能重试已终结的 run**。还在跑的必须先中断，否则两个 run 同时往同一个
 *   工作区写文件，谁覆盖谁全看调度。
 * - **继承原 run 的 `messageIdUpperBound`**。重试要重现的是「当时那个上下文」，
 *   拿新的高水位会把重试期间用户新发的消息卷进来，那就不是重试了。
 * - **原 run 保留并标 `superseded_by`**，不删。那些步骤真实发生过，token 真的花了。
 */
export async function retryRun(
  runId: RunId,
  clientRequestId: string,
  deps: CommandDeps,
): Promise<void> {
  const original = getRun(deps.store, runId)
  if (!original) {
    reject(deps.ws, 'run.retry', 'invalid_payload', 'run 不存在', clientRequestId)
    return
  }
  if (original.status === 'running' || original.status === 'queued') {
    reject(deps.ws, 'run.retry', 'conflict', '该 run 仍在执行，请先中断', clientRequestId)
    return
  }
  if (deps.runs.isBusy(original.conversationId)) {
    reject(deps.ws, 'run.retry', 'conflict', '该会话已有任务在执行', clientRequestId)
    return
  }

  // 原 run 的用户消息就是要重试的那句话。没有它（例如被清理过）无从重放。
  const userMessage = original.userMessageId
    ? listMessages(deps.store, original.conversationId, original.userMessageId).at(-1)
    : null
  if (!userMessage || userMessage.id !== original.userMessageId) {
    reject(deps.ws, 'run.retry', 'invalid_payload', '原始消息已不存在，无法重试', clientRequestId)
    return
  }

  await startRun(original.conversationId, userMessage.content, undefined, deps, {
    retryOf: original,
    clientRequestId,
  })
}

/**
 * 发起一轮。
 *
 * deps 里**不含 `ws`**：这条路径除了 `handleCommand`，还要给定时任务用，
 * 而定时触发没有发起方的连接。它本来也没用过 `ws`——事件全部走 bus 广播，
 * 因为同一个会话可能同时开在桌面端和手机上。
 */
export async function startRun(
  conversationId: ConversationId,
  content: string,
  model: string | undefined,
  deps: Omit<CommandDeps, 'ws'>,
  retry?: { retryOf: Run; clientRequestId: string },
  attachments?: Attachment[],
): Promise<void> {
  // 占位与检查必须是同一个同步动作：只检查不占位的话，从这里到 `runs.register()`
  // 之间隔着好几个 await，两条几乎同时到达的消息会双双通过。
  if (!deps.runs.reserve(conversationId)) {
    deps.bus.publish(
      {
        type: 'run.error',
        runId: '' as RunId,
        code: 'internal_error',
        message: '该会话已有任务在执行，请先中断',
        retryable: false,
      },
      conversationId,
    )
    return
  }

  /*
   * 这一轮跑在哪个目录下，**按会话查，不问进程**。
   *
   * 服务进程曾经拿着一个 `workspaceRoot` 常量（启动时的 `--cwd`），于是一个进程
   * 只服务得了一个项目。那个常量是 `workspaces` 表的一份缓存，已经删掉。
   *
   * 查不到就停：回落到某个默认根等于拿着 A 项目的会话去 B 项目的目录里跑命令，
   * 而工具的路径约束、shell 的沙箱边界全部以这个根为界。
   */
  const ws = workspaceOf(deps.store, conversationId)
  if (!ws) {
    deps.runs.release(conversationId)
    deps.bus.publish(
      {
        type: 'run.error',
        runId: '' as RunId,
        code: 'internal_error',
        message: '这个会话找不到对应的项目目录，无法执行',
        retryable: false,
      },
      conversationId,
    )
    return
  }

  const controller = new AbortController()
  let currentRunId: RunId | null = null

  const session = new Session({
    store: deps.store,
    config: deps.config,
    content: deps.content,
    workspaceRoot: ws.rootPath,
    signal: controller.signal,
  })

  // 后台跑，不阻塞 WebSocket 消息循环——否则一轮 agent 跑十分钟，
  // 这十分钟里连中断指令都收不到。
  void (async () => {
    try {
      for await (const ev of session.ask(content, conversationId, {
        ...(model ? { model } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(retry
          ? {
              clientRequestId: retry.clientRequestId,
              retryOf: {
                runId: retry.retryOf.id,
                userMessageId: retry.retryOf.userMessageId,
                messageIdUpperBound: retry.retryOf.messageIdUpperBound,
              },
            }
          : {}),
      })) {
        // 并非所有事件都带 runId（git.state / file.changed 是工作区级的），
        // 取之前先窄化，不能假设字段存在。
        if ('runId' in ev && ev.runId && currentRunId === null) {
          currentRunId = ev.runId as RunId
          deps.runs.register({
            runId: currentRunId,
            conversationId,
            controller,
            startedAt: Date.now(),
          })
        }
        deps.bus.publish(ev, conversationId)
      }
    } catch (err) {
      // 在 loop 之外抛出的错误（装配 adapter、解析档案）走这里。
      //
      // 这里曾经硬编码 `internal_error`——于是「没配 key」在 CLI 里报 no_api_key、
      // 在桌面端却报 internal_error，前端的「去配置」引导永远不触发。
      // 错误码是给前端决定引导动作用的，一旦压平成 internal_error 就等于没有分类。
      const pe = err instanceof ProviderError ? err : null
      const base = pe?.message ?? (err instanceof Error ? err.message : String(err))
      // 桌面端用户手边不一定有终端，「运行 qy init」对他们只是一句空话。
      // 把配置文件路径带上——那是他们真正能打开的东西。
      const message =
        pe?.code === 'no_api_key' || pe?.code === 'auth_failed'
          ? `${base}\n配置文件：${configPath()}`
          : base
      deps.bus.publish(
        {
          type: 'run.error',
          runId: (currentRunId ?? '') as RunId,
          code: pe?.code ?? 'internal_error',
          message,
          retryable: pe?.retryable ?? false,
        },
        conversationId,
      )
    } finally {
      // register 过就走 unregister，没跑起来的由 release 收——两者都不做的话
      // 这个会话会被永久占住，之后每一条消息都被回绝「已有任务在执行」。
      if (currentRunId) deps.runs.unregister(currentRunId)
      else deps.runs.release(conversationId)
      // 每条消息一个 Session，每个 Session 都持有扩展的一份引用。
      // 不释放的话引用只增不减，插件与 MCP 子进程到进程退出都关不掉。
      session.dispose()
      void publishGitState(ws.rootPath, ws.id, deps.bus)
    }
  })()
}

/**
 * 手动压缩一个会话。
 *
 * 与自动路径共用同一个 ，所以两条入口产出的 manifest 完全一致——
 * 两套压缩实现迟早会漂移，且漂移了很难发现。
 *
 * 事件走总线广播而不是只回发起方：压缩改变了会话的后续行为，
 * 另一端开着同一个会话的人必须看到。
 */
export async function compactConversation(
  conversationId: ConversationId,
  deps: CommandDeps,
): Promise<void> {
  const emit = (ev: AgentEvent) => deps.bus.publish(ev, conversationId)
  // 手动压缩不属于任何 run，用空 runId——事件协议要求这个字段存在，
  // 但前端对压缩卡的渲染不依赖它。
  const runId = '' as RunId

  emit({ type: 'compaction', runId, phase: 'started' })
  try {
    const compaction = new RuntimeCompaction({
      store: deps.store,
      conversationId,
      messageIdUpperBound: null,
      summarize: makeServerSummarizer(deps, conversationId),
    })
    const outcome = await compaction.run()
    if (outcome.status === 'compacted') {
      emit({ type: 'compaction', runId, phase: 'done', manifest: outcome.manifest })
    } else {
      // skipped 也走 failed 通道并带上 reasonCode：用户点了按钮，
      // 「没什么可压的」也是必须回答的结果，静默等于按钮坏了。
      emit({ type: 'compaction', runId, phase: 'failed', reasonCode: outcome.reasonCode })
    }
  } catch (err) {
    // `reasonCode` 是**码**，不是消息。这里曾经塞 `err.message.slice(0, 80)`——
    // 前端把这个字段直接括号显示，于是异常原文（英文、半截、带内部标识）
    // 就成了给用户看的界面文案。分类和 run.error 那条一个口径：
    // 认得的走 ProviderError 的码，其余一律 internal_error。
    emit({
      type: 'compaction',
      runId,
      phase: 'failed',
      reasonCode: err instanceof ProviderError ? err.code : 'internal_error',
    })
  }
}

/** 手动压缩用会话当前模型生成摘要，与自动路径口径一致。 */
export function makeServerSummarizer(
  deps: CommandDeps,
  conversationId: ConversationId,
): Summarizer {
  const model = getConversation(deps.store, conversationId)?.model ?? deps.config.active.model
  const stored = resolveModel(deps.config, model)
  if (!stored) return async () => null

  return async (prompt, budgetChars) => {
    const adapter = buildAdapter({
      kind: stored.kind,
      apiKey: resolveApiKey(stored),
      model: stored.model,
      ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      ...(stored.headers ? { headers: stored.headers } : {}),
      ...(stored.capabilities ? { capabilities: stored.capabilities } : {}),
    })
    let text = ''
    /*
     * 摘要也花钱，而且这条路**从来没有记过账**。
     *
     * `usage_ledger` 的 CHECK 里早就有 `'summary'` 这个 kind，schema 注释也亲口
     * 说压缩摘要的钱要单记——但生产代码零写入，只有测试在写它。
     * 结果是手动压缩越频繁，账单和界面上的数字差得越多，而用户查不出是谁花的。
     * （会话内自动压缩那条路一直在记，见 `runtime/session.ts` 的 `makeSummarizer`。）
     */
    let spent: { cost: number; u: ProviderUsage } | null = null
    for await (const ev of adapter.stream({
      model: adapter.spec.id,
      system: [{ text: '你是会话摘要器。只输出摘要正文。' }],
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      maxOutputTokens: Math.min(adapter.spec.maxOutputTokens, Math.ceil(budgetChars / 2)),
      signal: AbortSignal.timeout(120_000),
    })) {
      if (ev.type === 'text_delta') text += ev.delta
      else if (ev.type === 'usage')
        spent = { cost: computeCost(adapter.spec, ev.usage), u: ev.usage }
    }
    if (spent) {
      recordUsage(deps.store, {
        kind: 'summary',
        workspaceId: workspaceOf(deps.store, conversationId)?.id ?? '',
        model: adapter.spec.id,
        provider: stored.kind,
        inputTokens: spent.u.inputTokens,
        outputTokens: spent.u.outputTokens,
        cachedTokens: spent.u.cachedTokens,
        cacheWriteTokens: spent.u.cacheWriteTokens,
        reasoningTokens: spent.u.reasoningTokens,
        cost: spent.cost,
        currency: adapter.spec.pricing.currency ?? 'USD',
      })
    }
    return text.trim() || null
  }
}

// ───────────────────────── HTTP API ─────────────────────────

// ───────────────────────── 辅助 ─────────────────────────
