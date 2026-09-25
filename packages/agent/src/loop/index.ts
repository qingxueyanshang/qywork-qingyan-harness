/**
 * AgentLoop —— ReAct 主循环。
 *
 * 职责：按轮推进「跟进注入 → 装配请求 → 发送前压缩 → 发送与重发 → 收尾 → 工具波次」，
 * 并在循环结束时给出 run 的终态。各阶段的实现分在同目录的文件里：
 * `compact.ts`（两个压缩调用点）、`attempt.ts`（发送、事件消费、重发策略）、
 * `turn-end.ts`（收尾与无工具时的停机判定）、`tool-wave.ts`（工具执行）。
 * 它**不**负责：决定用哪个 provider（adapter 的事）、怎么存（store 的事）、
 * 怎么传给客户端（server 的事）。
 *
 * 上下文装配的硬约束（靠代码保证，不靠提示词）：
 * - 冻结前缀 = system.md + environment.md + rules.md，跨 run 逐字节稳定。
 * - 日期、技能清单、记忆**永不进冻结前缀**；runtime 按 run 冻结并跟用户消息绑定。
 * - 工具 schema 按名排序（registry 保证），排在最前，顺序抖动即全量失效。
 */

import type { ChatRequest, ProviderEvent, ProviderUsage, WireMessage } from '@qywork/ai'
import { estimateMessage, estimateRequest, ProviderError } from '@qywork/ai'
import type { AgentEvent, ContextOmitted } from '@qywork/core'
import { emptyBreakdown, emptyOmitted, log } from '@qywork/core'
import { stepStamp } from '../compaction.ts'
import { describeDrift, PrefixAudit } from '../prefix-audit.ts'
import { sendTurn } from './attempt.ts'
import { compactBeforeSend } from './compact.ts'
import {
  batchImageCount,
  breakdownOf,
  collapseSuperseded,
  declaredMaxOutput,
  envelopeHashOf,
  idleTimeoutFor,
  materialize,
  mergeUsage,
  omitImages,
  payloadSnapshotOf,
} from './request.ts'
import { type LoopHost, RunState, sleep, TurnState, untilAborted } from './run-state.ts'
import { executeCalls } from './tool-wave.ts'
import { concludeWithoutTools, settleResponse } from './turn-end.ts'
import type { CompactionPort, LoopDeps, RunInput } from './types.ts'

export class AgentLoop {
  /**
   * 前缀审计。
   *
   * 挂在 loop 实例上而不是全局：loop 每轮新建（adapter 绑具体模型），
   * 所以它天然覆盖「同一 run 内多次请求」——那正是前缀**必须**稳定的范围。
   * 跨 run 的稳定性由 `PrefixAudit` 的 cacheKey 维度承担，
   * 装配方（runtime）传的是 conversationId。
   */
  private readonly audit = new PrefixAudit()

  /** 上一次装配丢掉了多少原文。由 `buildRequest` 写，`context` 事件与账本读。 */
  private lastOmitted: ContextOmitted = emptyOmitted()

  /**
   * 上一次装配打算带上的那批工具图片：批次 id 与张数。`null` = 这次没有待带的图。
   *
   * 由 `buildRequest` 写、`openStream` 在 `materialize` 之后读。张数是**装配前**
   * 数出来的，能力过滤或压缩去掉任意一张都会让两侧对不上，引用因此不写。
   */
  private lastInputImages: { batchId: string; images: number } | null = null

  /**
   * 压缩端口。**恒非空**——缺省时是下面那个透传实现。
   *
   * 透传的语义与「没有压缩」逐字相同：投影原样返回、压缩报「没什么可折」，
   * 因此容量拒绝照旧上报为 run 错误。差别只在调用点少了三处判空。
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
     * 退避等待。缺省是可中断的真实计时。
     *
     * 等待必须随信号结束：退避的这几十秒内用户点停止，不中断等待就是按钮无响应。
     */
    const backoff = deps.sleep ?? ((ms, signal) => untilAborted(signal, sleep(ms)))
    this.host = {
      deps,
      compaction: this.compaction,
      backoff,
      summaryTrace: (run, turnIndex) => this.summaryTrace(run, turnIndex),
      openStream: (req, requestId) => this.openStream(req, requestId),
      buildRequest: (run, notice) => this.buildRequest(run, notice),
      lastOmitted: () => this.lastOmitted,
    }
  }

  /**
   * 一轮之内压缩时摘要请求的记账。摘要请求按这一轮的普通请求处理：发出前落
   * `provider_requests`（purpose = summary，占 turnIndex 这个编号），回报的 usage 并进这一轮。
   * `opened` / `merged` 告诉调用方编号占没占、usage 变没变。
   */
  private summaryTrace(run: RunState, turnIndex: number): ReturnType<LoopHost['summaryTrace']> {
    const { persist, adapter, usage, density } = run
    const runId = run.input.runId
    const providerName = this.deps.providerName
    const trace = {
      opened: false,
      merged: false,
      open: (req: ChatRequest): string => {
        trace.opened = true
        const payload = payloadSnapshotOf(req)
        return persist.openRequest({
          runId,
          turnIndex,
          retryIndex: 0,
          purpose: 'summary',
          ...(providerName ? { providerName } : {}),
          providerKind: adapter.kind,
          model: req.model,
          measuredInputTokens: estimateRequest(req, density),
          sentCategories: emptyBreakdown(),
          omittedCategories: emptyOmitted(),
          payloadHash: payload.hash,
          requestBytes: payload.bytes,
          cacheRouteFingerprint: envelopeHashOf(req),
        })
      },
      sent: (requestId: string): void => persist.markRequestSent(requestId),
      headers: (requestId: string, at: number): void => persist.markRequestHeaders?.(requestId, at),
      firstEvent: (requestId: string): void => persist.markRequestFirstEvent?.(requestId),
      content: (requestId: string, at: number): void => persist.markRequestContent?.(requestId, at),
      settle: (
        requestId: string,
        status: 'received' | 'uncertain' | 'rejected',
        u: ProviderUsage | null,
        errorCode: string | null,
        finishReason?: string,
      ): void => {
        if (u) {
          mergeUsage(usage, u, adapter, turnIndex)
          persist.saveUsage(runId, usage)
          trace.merged = true
        }
        persist.settleRequest(requestId, status, u, errorCode, finishReason)
      },
    }
    return trace
  }

  /**
   * 装配完的请求交给适配器，并在这里确认那批工具图片有没有真的进请求体。
   *
   * 确认点只有这一个，位置是 `materialize` 之后：压缩投影、能力过滤三道都在它之前，
   * 三个适配器把图像块一比一序列化，所以这里数到的张数就是线上那份字节里的张数。
   * 放在装配处确认会漏掉「模型不收图、图被换成文字注记」这一支。
   */
  private async openStream(
    req: ChatRequest,
    requestId: string,
  ): Promise<AsyncIterable<ProviderEvent>> {
    const { adapter } = this.deps
    const materialized = await materialize(req, {
      image: adapter.spec.vision,
      video: adapter.spec.video && adapter.transmits.video === true,
      mediaPaths: adapter.transmits.mediaPaths === true,
    })
    const pending = this.lastInputImages
    if (pending && batchImageCount(materialized.messages, pending.batchId) === pending.images) {
      this.deps.persist.markRequestInputImages?.(requestId, pending.batchId)
    }
    return adapter.stream(materialized)
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

        // `signal` 不在这里合成：每次尝试自带一个中止器，所以装配只出请求体，
        // 信号在尝试循环里逐次接上。
        const turnNotice = run.notices.length ? run.notices.join('\n') : null
        run.notices.length = 0
        const req = this.buildRequest(run, turnNotice)
        const turn = new TurnState(run, turnNotice, req, breakdownOf(req, run.density))
        run.rebaseAnchor(turn.req, turn.breakdown)

        if ((yield* compactBeforeSend(host, run, turn)) === 'interrupted') break

        // 前缀漂移只报不拦：拦了等于让一个计费问题变成一个功能故障。
        // 但必须**说出来**——缓存失效本身是完全静默的，不报就永远没人知道。
        const drift = this.audit.observe(input.cacheKey ?? input.runId, turn.req.system)
        if (drift) log.warn('agent', describeDrift(drift))

        if ((yield* sendTurn(host, run, turn)) === 'continued') continue
        if (!settleResponse(run, turn)) break

        const next =
          turn.refusalNote || !turn.calls.length
            ? yield* concludeWithoutTools(run, turn)
            : yield* executeCalls(run, turn)
        if (next === 'stop') break
      }
    } catch (err) {
      // **先看是不是用户按了停止。**
      //
      // run 的绝大部分时间挂在等 provider 事件的 await 上，中止在那里表现为底层请求
      // 被拒绝并抛出，而不是「两个事件之间」——循环里的 `signal.aborted` 检查一个都
      // 赶不上。不在这里认出来的话，一次主动停止会落成 status:'failed' + 一条红色的
      // internal_error（`ai/src/errors.ts` 把 AbortError 归到那里），
      // 而那个文件自己写着「中断不是错误：不该报红也不该重试」。
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
          : run.stopReason === 'completed'
            ? 'done'
            : 'failed',
      stopReason: run.stopReason,
      ...(run.stopDetail ? { stopDetail: run.stopDetail } : {}),
      usage: run.usage,
      fileChanges: run.fileChanges,
    }
  }

  /**
   * 装配一次请求，并**同时算出这次没发出去多少原文**。
   *
   * 省略量不是事后统计出来的，是装配时**同尺两测相减**——原文一直在
   * Message/Step 里留有（压缩是投影、不销毁数据），所以量得到。
   * 前提就是这个：一旦哪天把旧结果正文改写成占位串，原文不在任何可测处，
   * 这个数就失去依据，届时该删掉它而不是估一个。
   */
  private buildRequest(
    run: RunState,
    /** 只交给这一次请求的事实（见 `RunState.notices`）。附在末尾、在缓存断点之后，不落账本。 */
    notice: string | null,
  ): ChatRequest {
    const { adapter, registry, systemPrompt } = this.deps
    const { input, transcript } = run

    // 冻结前缀。缓存断点打在这里的末尾——它之后的所有内容都是易变的。
    const system: ChatRequest['system'] = [{ text: systemPrompt, cacheBreakpoint: true }]

    // 历史已经带着每个 run 的不可变上下文快照；run 内 transcript 只追加。
    // 整串一起走压缩投影，工具结果才不会留在投影之外。
    /*
     * 缓存断点之二：**history 的最后一条**（跨 run 稳定点）。
     *
     * 标在装配之前，随投影一起流下来——投影之后 history 与 transcript 之间
     * 没有任何分界标记，事后再找不出来。投影若把这条折掉，断点跟着没，
     * 退化成少一个断点，正确性无损。
     */
    const history = input.history.length
      ? [
          ...input.history.slice(0, -1),
          { ...input.history[input.history.length - 1]!, cacheBreakpoint: true },
        ]
      : input.history
    const assembledRaw: WireMessage[] = [...history, ...transcript]
    /*
     * 图像块只在**模型还没收到过的那一批**工具结果上出现：history 与 transcript
     * 合起来的最后一条带 toolCalls 的 assistant 及其后的 tool 结果，若请求账里没有
     * 「它的图已被一次已接收的主请求完整携带」的记录，整批保留；其余带图的工具结果
     * 换成 `images_omitted` 信封。模型在看图的那一轮已经把观察写进正文，之后每轮
     * 重放的是它看过的像素，而字节随张数线性累积。要再看按路径重读，或用信封里的
     * `call_id` 经 `read_history` 取回定格的那一张。
     *
     * 判据不能是「这批图在不在当前 transcript 里」：工具成功之后那次请求被拒、
     * 换一个 run 带着 history 续跑时，图从来没送达过却会被当成旧图省略，
     * 模型因此在没有观察结果的情况下接着做。批次归属查不到引用记录时保守保留——
     * 无记录不等于模型看过。
     */
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
     * 下一步装配时，这一批结果可能被同一对象的更新视图取代、或摘掉图像块，末尾断点的
     * 前缀随之对不上。Anthropic 只在断点处写入缓存条目，命中只发生在以往请求写过条目的
     * 位置；不在这里打断点，下一步只能命中 history 末条，其后的内容每一步整段重写。
     * 一次请求最多 4 个断点：系统提示词、history 末条、这里、末尾，不要再加第五个，
     * 超出会被 400 拒绝。
     */
    if (lastCall >= 0)
      assembledRaw[lastCall] = { ...assembledRaw[lastCall]!, cacheBreakpoint: true }
    const pendingBatch = lastCall < 0 ? null : (assembledRaw[lastCall]!._batch ?? null)
    const consumed =
      pendingBatch !== null && this.deps.persist.inputImagesConsumed?.(pendingBatch) === true
    const keepFrom = lastCall < 0 || consumed ? assembledRaw.length : lastCall
    /*
     * 同一对象的当前视图在历史里只留最新那一份（`collapseSuperseded`）。与图像块同一步
     * 处理：两者都是「模型已经看过、之后不再有用」的内容，换成同一种收纳信封。
     */
    const scoped = collapseSuperseded(
      assembledRaw.map((m, i) => (i >= keepFrom ? m : omitImages(m))),
    )
    const pendingImages = pendingBatch === null ? 0 : batchImageCount(scoped, pendingBatch)
    this.lastInputImages =
      pendingBatch !== null && pendingImages > 0
        ? { batchId: pendingBatch, images: pendingImages }
        : null
    const projected = this.compaction.project(scoped)
    const messages: WireMessage[] = [...projected]

    /*
     * 被投影丢掉的那部分原文，按分组分开记：历史消息一份、工具结果一份。
     *
     * 同尺两测相减——原文一直在 Message/Step 里留有（压缩是投影、不销毁数据），
     * 所以量得到。整条被折掉和只被换成信封在这里是同一件事：差额都算省略。
     * 面板的「省略上下文」两行就是它；只回答「被谁占的」是半张账，
     * 用户看到占用下降却不知道降在哪里。
     */
    const omitted = emptyOmitted()
    const account = (list: readonly WireMessage[], sign: 1 | -1): void => {
      for (const m of list) {
        // 无戳的投影摘要不参与——它不是被折的原文。
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
     * 缓存断点之四：本次已接受消息的末尾。下一步没有改动这一批结果时，从这里整段复用；
     * 兼容协议忽略此标记，Anthropic 把它落成显式断点。
     */
    const latest = messages.length - 1
    if (latest >= 0 && !messages[latest]!.cacheBreakpoint) {
      messages[latest] = { ...messages[latest]!, cacheBreakpoint: true }
    }
    if (notice) messages.push({ role: 'user', content: notice, _group: 'workspaceState' })

    const assembled: ChatRequest = {
      model: adapter.spec.id,
      system,
      messages,
      tools: registry.schemas(),
      maxOutputTokens: adapter.spec.maxOutputTokens,
      idleTimeoutMs: this.deps.streamIdleTimeoutMs ?? idleTimeoutFor(input.effort),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
      signal: input.signal,
    }
    // 申报值要量过装配结果才算得出来，所以先装配、再钳位覆盖同一个字段。
    return {
      ...assembled,
      maxOutputTokens: declaredMaxOutput(adapter.spec, run.occupancyOf(assembled)),
    }
  }
}

/*
 * ── 跟进消息注入 ──
 *
 * 位置是**装配请求之前、这一步的其余动作之前**，所以这一步发出去的请求
 * 就带着它，模型下一次开口即已看到。
 *
 * 追加在 transcript 尾部（上一波工具结果之后）。运行上下文已经固定在 history
 * 的所属用户消息上，所以此前的 `[history][transcript…]` 逐字节不变。
 *
 * 戳要自己盖：`stampUnit` 只盖它自己那一段（起点在推 assistant 消息时才取），
 * 波及不到这里。`_group` 用 `historyMessages` 而不是执行记录——这是用户
 * 打的字；投影侧（`runtime/transcript.ts`）必须同值，两侧不同口径比都记错更坏。
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
      // 与上面落库的那一格同值：两侧不同口径的话，这一帧画气泡、刷新后画回执行。
      ...(f.origin ? { origin: f.origin } : {}),
    }
  }
}
