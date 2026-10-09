/**
 * AgentLoop —— ReAct 主循环。
 *
 * 职责：按轮推进「跟进注入 → 装配请求 → 发送前压缩 → 发送与重发 → 收尾 → 工具波次」，
 * 并在循环结束时给出 run 的终态。各阶段的实现位于同目录的文件中：
 * `compact.ts`（两个压缩调用点）、`attempt.ts`（发送、事件消费、重发策略）、
 * `turn-end.ts`（收尾与无工具时的停机判定）、`tool-wave.ts`（工具执行）。
 * 不负责：选择 provider（由 adapter 负责）、持久化（由 store 负责）、
 * 向客户端传输（由 server 负责）。
 *
 * 上下文装配的硬约束（由代码保证，不依赖提示词）：
 * - 冻结前缀 = system.md + environment.md + rules.md，跨 run 逐字节稳定。
 * - 日期、技能清单、记忆不进入冻结前缀；runtime 按 run 冻结它们并与用户消息绑定。
 * - 工具 schema 按名称排序（由 registry 保证）并排在最前，顺序变化即导致缓存全部失效。
 */

import type { ChatRequest, ProviderEvent, WireMessage } from '@qywork/ai'
import { estimateMessage, estimateRequest, ProviderError, reasoningReplay } from '@qywork/ai'
import type { AgentEvent, ContextOmitted } from '@qywork/core'
import { emptyOmitted, log } from '@qywork/core'
import { stepStamp } from '../compaction.ts'
import { describeDrift, PrefixAudit } from '../prefix-audit.ts'
import { sendTurn } from './attempt.ts'
import { compactBeforeSend } from './compact.ts'
import { contextEvent } from './context.ts'
import {
  breakdownOf,
  declaredMaxOutput,
  envelopeHashOf,
  evictedMedia,
  type InputMediaCapabilities,
  idleTimeoutFor,
  materialize,
  omitImages,
  replayReasoning,
} from './request.ts'
import { type LoopHost, RunState, sleep, TurnState, untilAborted } from './run-state.ts'
import { createSummaryTrace } from './summary-trace.ts'
import { executeCalls } from './tool-wave.ts'
import { concludeWithoutTools, settleResponse } from './turn-end.ts'
import type { CompactionPort, LoopDeps, RunInput } from './types.ts'

export class AgentLoop {
  /**
   * 前缀审计。
   *
   * 存放在 loop 实例上而不是全局：每轮新建一个 loop（adapter 绑定具体模型），
   * 因此它覆盖同一 run 内的多次请求，即前缀必须稳定的范围。
   * 跨 run 的稳定性由 `PrefixAudit` 按 cacheKey 区分，
   * 装配方（runtime）传入的是 conversationId。
   */
  private readonly audit = new PrefixAudit()

  /** 上一次装配省略的原文量。由 `buildRequest` 写入，`context` 事件与账本读取。 */
  private lastOmitted: ContextOmitted = emptyOmitted()

  /**
   * 压缩端口，恒非空：未提供时使用构造函数中的透传实现。
   *
   * 透传的语义与不压缩完全相同：投影原样返回，压缩返回 `nothing_to_fold`，
   * 因此容量拒绝仍上报为 run 错误。区别只在于调用点无需三处判空。
   */
  private readonly compaction: CompactionPort

  /** 交给各阶段的能力，见 `LoopHost`。 */
  private readonly host: LoopHost

  constructor(private readonly deps: LoopDeps) {
    this.compaction = deps.compaction ?? {
      project: (messages) => messages,
      run: async () => ({ status: 'skipped', reasonCode: 'nothing_to_fold' }),
    }
    /*
     * 退避等待。缺省为可中断的真实计时。
     *
     * 等待必须随信号结束：用户在退避的数十秒内点击停止时，不中断等待会使停止按钮无响应。
     */
    const backoff = deps.sleep ?? ((ms, signal) => untilAborted(signal, sleep(ms)))
    this.host = {
      deps,
      compaction: this.compaction,
      backoff,
      summaryTrace: (run, turnIndex) => this.summaryTrace(run, turnIndex),
      openStream: (req) => this.openStream(req),
      buildRequest: (run) => this.buildRequest(run),
      lastOmitted: () => this.lastOmitted,
    }
  }

  /**
   * 轮内压缩时摘要请求的记账。摘要请求按本轮的普通请求处理：发出前写入
   * `provider_requests`（purpose = summary，占用 turnIndex 编号），回报的 usage 并入本轮。
   * `opened` / `merged` 告知调用方是否占用了编号、usage 是否变化。
   */
  private summaryTrace(run: RunState, turnIndex: number): ReturnType<typeof createSummaryTrace> {
    return createSummaryTrace(
      run.persist,
      run.input.runId,
      turnIndex,
      run.adapter,
      run.usage,
      this.deps.providerName,
    )
  }

  /** 本轮的媒体发送方式。换出预算与发送前物化必须使用同一份，否则两处对同一段视频算出不同的字节数。 */
  private mediaCapabilities(): InputMediaCapabilities {
    const { adapter } = this.deps
    const upload = adapter.transmits.mediaUploadAbove
    return {
      image: adapter.spec.vision,
      video: adapter.spec.video && adapter.transmits.video === true,
      mediaPaths: adapter.transmits.mediaPaths === true,
      ...(upload !== undefined ? { mediaUploadAbove: upload } : {}),
    }
  }

  /** 装配完成的请求按模型能力物化媒体后交给适配器。 */
  private async openStream(req: ChatRequest): Promise<AsyncIterable<ProviderEvent>> {
    const materialized = await materialize(req, this.mediaCapabilities())
    return this.deps.adapter.stream(materialized)
  }

  async *run(input: RunInput): AsyncGenerator<AgentEvent, void, unknown> {
    const run = new RunState(this.deps, input)
    const host = this.host

    try {
      for (; ; run.requestTurn++) {
        if (input.signal.aborted) {
          run.stopReason = 'user_interrupt'
          break
        }

        yield* injectFollowUps(this.deps, run)
        await this.deps.beforeRequest?.()

        // `signal` 不在此处合成：每次尝试各有一个中止器，因此装配只生成请求体，
        // 信号在尝试循环中逐次接入。
        const req = this.buildRequest(run)
        const turn = new TurnState(run, req, breakdownOf(req, run.density))
        run.rebaseAnchor(turn.req, turn.breakdown)

        if ((yield* compactBeforeSend(host, run, turn)) === 'interrupted') break

        // 前缀漂移只记录日志，不拦截请求：拦截会把计费问题变成功能故障。
        // 但必须记录：缓存失效本身不产生任何报错，不记录则无法发现。
        const drift = this.audit.observe(input.cacheKey ?? input.runId, turn.req.system)
        if (drift) log.warn('agent', describeDrift(drift))

        if ((yield* sendTurn(host, run, turn)) === 'continued') continue
        if (!settleResponse(run, turn)) break
        yield contextEvent(host, run, turn, estimateRequest(turn.req, run.density))

        const next =
          turn.refusalNote || !turn.calls.length
            ? yield* concludeWithoutTools(run, turn)
            : yield* executeCalls(host, run, turn)
        if (next === 'stop') break
      }
    } catch (err) {
      // 先判断是否为用户停止。
      //
      // run 的绝大部分时间阻塞于等待 provider 事件的 await，在此处中止表现为底层请求
      // 被拒绝并抛出异常，而不是发生在两个事件之间，循环中的 `signal.aborted` 检查均无法捕获。
      // 不在此处识别时，一次主动停止会记为 status:'failed' 并显示一条
      // internal_error（`ai/src/errors.ts` 把 AbortError 归入该错误码），
      // 而该文件规定中断不按错误报告，也不重试。
      if (input.signal.aborted) {
        yield {
          type: 'run.finished',
          runId: input.runId,
          status: 'interrupted',
          stopReason: 'user_interrupt',
          usage: run.usage,
          fileChanges: run.fileChanges,
        }
        return
      }

      const pe = err instanceof ProviderError ? err : null
      run.stopReason = 'provider_error'
      yield {
        type: 'run.error',
        runId: input.runId,
        code: pe?.code ?? 'internal_error',
        message: pe?.message ?? (err instanceof Error ? err.message : String(err)),
      }
      yield {
        type: 'run.finished',
        runId: input.runId,
        status: 'failed',
        stopReason: run.stopReason,
        usage: run.usage,
        fileChanges: run.fileChanges,
      }
      return
    }

    yield {
      type: 'run.finished',
      runId: input.runId,
      status:
        run.stopReason === 'user_interrupt'
          ? 'interrupted'
          : run.stopReason === 'completed' || run.stopReason === 'awaiting_user'
            ? 'done'
            : 'failed',
      stopReason: run.stopReason,
      ...(run.stopDetail ? { stopDetail: run.stopDetail } : {}),
      usage: run.usage,
      fileChanges: run.fileChanges,
    }
  }

  /**
   * 装配一次请求，并同时计算本次未发送的原文量。
   *
   * 省略量不是事后统计，而是装配时用同一估算方法分别计量投影前后再相减：原文始终
   * 保留在 Message/Step 中（压缩是投影，不销毁数据），因此可以计量。
   * 这是该数值的前提：若旧结果正文被改写为占位串，原文将不存在于任何可计量之处，
   * 该数值随即失去依据，届时应删除它，而不是改为估算。
   */
  private buildRequest(run: RunState): ChatRequest {
    const { adapter, registry, systemPrompt } = this.deps
    const { input, transcript } = run

    // 冻结前缀。缓存断点设在其末尾，之后的所有内容都可能变化。
    const system: ChatRequest['system'] = [{ text: systemPrompt, cacheBreakpoint: true }]

    // 历史已包含每个 run 的不可变上下文快照；run 内 transcript 只追加。
    // 整个序列一起经过压缩投影，工具结果因此不会遗留在投影之外。
    /*
     * 缓存断点之二：history 的最后一条（跨 run 稳定点）。
     *
     * 在装配之前标记，随投影一起传递：投影之后 history 与 transcript 之间
     * 没有分界标记，事后无法再定位。投影若折叠该条消息，断点随之消失，
     * 只是少一个断点，不影响正确性。
     */
    const history = input.history.length
      ? [
          ...input.history.slice(0, -1),
          { ...input.history[input.history.length - 1]!, cacheBreakpoint: true },
        ]
      : input.history
    const assembledRaw: WireMessage[] = [...history, ...transcript]
    let lastCall = -1
    for (let i = assembledRaw.length - 1; i >= 0; i--) {
      const m = assembledRaw[i]!
      if (m.role === 'assistant' && m.toolCalls?.length) {
        lastCall = i
        break
      }
    }
    /*
     * 缓存断点之三：最后一批工具结果所属的 assistant 消息。
     *
     * Anthropic 只在断点处写入缓存条目，读取时从断点向前回查约 20 个块。一批并行调用的
     * assistant 与工具结果块数可以超过 20，只依赖末尾断点时，下一步无法回查到上一次在末尾写入的条目，
     * 其后的内容整段重写；此处的断点紧邻上一次的末尾，下一步仍能命中。
     * 一次请求最多 4 个断点：系统提示词、history 末条、此处、末尾，不要添加第五个，
     * 超出会被 400 拒绝。
     */
    if (lastCall >= 0)
      assembledRaw[lastCall] = { ...assembledRaw[lastCall]!, cacheBreakpoint: true }
    /*
     * 媒体去留：工具结果与附件中的图像、视频保留在之后的请求中，保留的总字节超过上限时，
     * 从最早的一批起整批替换为说明（`evictedMedia`）。不要改为「每一步只保留最后一批」：每移除一次图片，
     * 请求前缀就会变化，`replayReasoning` 随之剥离其后全部原生推理，模型既看不到图片，也失去查看图片时得出的
     * 判断，只能反复取回，实测因连续无进展被循环保护判定失败。
     */
    const evicted = evictedMedia(assembledRaw, this.mediaCapabilities())
    const scoped = evicted.size
      ? assembledRaw.map((m, i) => (evicted.has(i) ? omitImages(m) : m))
      : assembledRaw
    const projected = this.compaction.project(scoped)
    const tools = registry.schemas()
    const messages: WireMessage[] = replayReasoning(
      projected,
      reasoningReplay(adapter.spec),
      envelopeHashOf({ model: adapter.spec.id, system, tools }),
    )

    /*
     * 被投影省略的原文，按分组分别记录：历史消息一项、工具结果一项。
     *
     * 用同一估算方法分别计量投影前后再相减：原文始终保留在 Message/Step 中（压缩是投影，不销毁数据），
     * 因此可以计量。整条被折叠与只被替换为信封在此处同样处理：差额都计为省略。
     * 面板中「省略上下文」的两行即来自此处；只说明占用的构成而不说明省略量时，
     * 用户看到占用下降却无法得知下降的来源。
     */
    const omitted = emptyOmitted()
    const account = (list: readonly WireMessage[], sign: 1 | -1): void => {
      for (const m of list) {
        // 没有戳记的投影摘要不参与计算：它不是被折叠的原文。
        if (!m._messageId) continue
        const n = sign * estimateMessage(m, adapter.spec.density)
        if (m.role === 'tool' || m._group === 'intermediateContent')
          omitted.intermediateOriginal += n
        else omitted.historyOriginal += n
      }
    }
    account(assembledRaw, 1)
    account(projected, -1)
    omitted.historyOriginal = Math.max(0, omitted.historyOriginal)
    omitted.intermediateOriginal = Math.max(0, omitted.intermediateOriginal)
    this.lastOmitted = omitted

    /*
     * 缓存断点之四：本次已接受消息的末尾。下一步未改动这一批结果时，从此处整段复用；
     * 兼容协议忽略此标记，Anthropic 将其写为显式断点。
     */
    const latest = messages.length - 1
    if (latest >= 0 && !messages[latest]!.cacheBreakpoint) {
      messages[latest] = { ...messages[latest]!, cacheBreakpoint: true }
    }

    const assembled: ChatRequest = {
      model: adapter.spec.id,
      system,
      messages,
      tools,
      maxOutputTokens: adapter.spec.maxOutputTokens,
      idleTimeoutMs: this.deps.streamIdleTimeoutMs ?? idleTimeoutFor(input.effort),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
      signal: input.signal,
    }
    // 申报值需要计量装配结果后才能算出，因此先装配，再钳位并覆盖同一字段。
    return {
      ...assembled,
      maxOutputTokens: declaredMaxOutput(adapter.spec, run.occupancyOf(assembled)),
    }
  }
}

/*
 * ── 跟进消息注入 ──
 *
 * 执行位置在装配请求之前、本步的其余动作之前，因此本步发出的请求
 * 即包含跟进消息，模型在下一次响应时即可看到。
 *
 * 追加在 transcript 末尾（上一工具波次的结果之后）。运行上下文已固定在 history
 * 中所属的用户消息上，因此此前的 `[history][transcript…]` 逐字节不变。
 *
 * 戳记须在此处自行写入：`stampUnit` 只为其负责的区段写入戳记（起点在推入 assistant 消息时取得），
 * 不覆盖此处。`_group` 取 `historyMessages` 而不是执行记录：这是用户
 * 输入的内容；投影侧（`runtime/transcript.ts`）必须取相同的值，两侧口径不一致的后果比两侧同时出错更严重。
 */
async function* injectFollowUps(
  deps: LoopDeps,
  run: RunState,
): AsyncGenerator<AgentEvent, void, unknown> {
  if (!deps.followUps) return
  const { input, persist, transcript } = run
  for (const f of await deps.followUps()) {
    const seq = run.nextSeq()
    const stepId = persist.landUserStep(input.runId, seq, {
      text: f.text,
      ...(f.attachments?.length ? { attachments: f.attachments } : {}),
      ...(f.origin ? { origin: f.origin } : {}),
    })
    transcript.push({
      role: 'user',
      content: f.content,
      _group: 'historyMessages',
      _step: stepStamp(input.runId, seq),
      ...(input.userMessageId ? { _messageId: input.userMessageId } : {}),
    })
    yield {
      type: 'message.injected',
      runId: input.runId,
      stepId: stepId as never,
      followUpId: f.id,
      content: f.text,
      ...(f.attachments?.length ? { attachments: f.attachments } : {}),
      // 与上方写入数据库的字段取值相同：两侧口径不一致时，实时事件渲染为消息气泡，刷新后渲染为执行记录。
      ...(f.origin ? { origin: f.origin } : {}),
    }
  }
}
