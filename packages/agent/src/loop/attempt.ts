/**
 * 一轮请求的发送、事件消费与自动重发。重发策略（可重发的码、次数上限、退避）也在这里。
 */

import type { ProviderEvent } from '@qywork/ai'
import { estimateRequest, ProviderError } from '@qywork/ai'
import type {
  AgentEvent,
  ProviderFailureCause,
  ProviderRequestContentKind,
  ProviderRetryDecision,
  StepId,
} from '@qywork/core'
import { log, reconcileBreakdown } from '@qywork/core'
import { recoverFromOverflow } from './compact.ts'
import { envelopeHashOf, mergeUsage, payloadSnapshotOf, softLimit } from './request.ts'
import type { LoopHost, RunState, TurnState } from './run-state.ts'

/** 换行。日志里用，避免转义在工具链上被折半。 */
const NEWLINE = String.fromCharCode(10)

/**
 * 一轮之内最多原样重发几次。**对可重发集合里每个码一视同仁。**
 *
 * **这个数只有这一处**，界面上那句「正在重连 N / M」的 M 由 `run.retrying` 事件
 * 带过去，不许在前端再写一遍。
 *
 * 取 5 的依据是 2026-08-22 的一次实测：长思考请求 11/11 在 `reasoning_content`
 * 中途干净 EOF（无 `finish_reason`、无 `[DONE]`、无网络错误），短请求正常收尾。
 * 断的是上游的某条路线不是整条链路，重发一次接不住；而每次尝试本身要跑几十秒到
 * 两分钟，5 次不构成对上游的连打。
 *
 * 重发的形式在尝试循环里按正文是否已显示分：未显示的原样重发；已显示的把正文作为
 * 上一条推进 transcript，带当前上下文续发。两种形式共用这一个上限，续发的下一轮
 * 从上一轮接着数（`carriedResends`）。
 */
export const MAX_RESENDS = 5

/**
 * 会自动重发的失败码。次数上限见 `MAX_RESENDS`，等多久见 `resendBackoffMs`。
 *
 * 这个集合只说「重不重发」，**不说「以什么形式重发」**——原样重发还是带当前上下文
 * 续发，由尝试循环按正文是否已显示决定。
 *
 * 不要以「重发要多付一次长 prompt 的钱」为由把 `provider_unavailable` 摘掉：
 * 不重发时用户要手动继续，那一次付的是同一笔钱，而且 run 已经落成 failed，
 * 新消息还得让模型重新理解上一轮做到哪。
 *
 * **`invalid_request` 不在集合里，别加进来。** 那个码的定义就是「同一份字节再发一次
 * 拿回同一个拒绝」（`ai/errors.ts` 的 400 / 413 / 422 一支），加进来只会把真正的原因
 * （例如这个模型不接受图片）推迟到五次重发之后才显示。中转站已证实可恢复的模糊拒绝
 * 由 `ai/errors.ts` 精确归成 `provider_unavailable`，不在这里再按文案分叉。
 *
 * **超时与断连同价。** `stream_idle_timeout` 是传输层按字节空闲掐断的流，连接已经判死；
 * 连接超时（`timedOut` 的 `network_error`）是响应头等了 `PROVIDER_HTTP.timeout` 还没回，
 * 同样。掐了不重发等于这一轮必败，重复推理的代价由重发窗口限住：正文已显示的部分
 * 作为上一条保留，不重跑。
 */
const RESENDABLE_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'stream_idle_timeout',
  'provider_unavailable',
  'rate_limited',
])

/** 指数退避的首档。中转侧故障的恢复是秒级，更短的首档等于无退避地重压对端。 */
const RESEND_BACKOFF_BASE_MS = 2_000

/** 单次退避上限。取 30 秒后，首发加五次重发的总等待停在一分钟量级。 */
const RESEND_BACKOFF_MAX_MS = 30_000

/** 抖动比例，只向上加：同时被拒的多个请求要错开重发时刻，下限仍是退避档本身。 */
const RESEND_BACKOFF_JITTER = 0.1

/**
 * 重发前等多久。不可重发的失败返回 undefined。
 *
 * **可重发的失败一律先等。** 上游给了 `Retry-After` 就按它等，否则按指数退避。
 * 连接层失败立刻原样重发换不回更快的恢复，只会在对端仍不可用时把五次额度
 * 在几毫秒内耗尽。
 */
function resendBackoffMs(error: ProviderError, resends: number): number | undefined {
  if (!RESENDABLE_CODES.has(error.code)) return undefined
  if (error.retryAfterMs !== null) return Math.max(0, error.retryAfterMs)
  const step = Math.min(RESEND_BACKOFF_BASE_MS * 2 ** resends, RESEND_BACKOFF_MAX_MS)
  return Math.round(step * (1 + Math.random() * RESEND_BACKOFF_JITTER))
}

/**
 * 本地计时器确认超时后的现场读数。
 *
 * 分类短语由 `ai` 包的传输层与错误归类给，它们拿不到静默时长，
 * 也不知道这次收到过数据没有；而这两项区分请求未落地（一个字节都没收到）
 * 与生成中断（收到过之后停了）。只有 `ProviderError.timedOut` 为真才调用这里，
 * 立即断流与协议失败不能借一段“静默了多久”伪装成超时。
 *
 * 这句只在这里拼，全项目只有这一个拼装处。
 */
function transportReading(providerEvents: number, silentMs: number): string {
  const secs = Math.round(silentMs / 1000)
  if (providerEvents === 0) return `${secs} 秒未收到响应`
  return `${secs} 秒未收到后续数据`
}

/**
 * 保留归类错误到最底层 cause 的短链。只取四层，既覆盖 SDK 包装又防损坏对象成环。
 * 原文在 runtime 持久化边界按配置凭证与常见 key 形状脱敏。
 */
function failureCauseChain(error: unknown): ProviderFailureCause[] {
  const out: ProviderFailureCause[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && current !== undefined && out.length < 4 && !seen.has(current)) {
    seen.add(current)
    const record = typeof current === 'object' ? (current as Record<string, unknown>) : null
    const code = record?.code
    out.push({
      name: current instanceof Error ? current.name || 'Error' : typeof current,
      code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
      message: current instanceof Error ? current.message : String(current),
    })
    current = record?.cause
  }
  return out
}

/** 一次尝试里 provider 事件的读数，失败时供诊断与超时读数使用。 */
interface StreamProbe {
  /**
   * 最后一次收到事件的时刻。**起点是「发出」而不是 0**——一个事件都没收到时，
   * 它与此刻的差正好是「发出去之后等了多久」，不需要另记一个发送时刻。
   */
  lastEventAt: number
  /** provider 真的回过来的事件数（不含 `request_prepared`）。 */
  providerEvents: number
  recordedFirstEvent: boolean
}

/**
 * ── 发送与消费：一次尝试，断了带着当前上下文再来，至多 `MAX_RESENDS` 次 ──
 *
 * 断开时收到的内容按两种情形处置，与 `runtime/transcript.ts` 的投影同形：
 *
 * - 正文一个字都没显示：上下文没变，原样重发。失败那次的思考不进模型视图，
 *   step 落失败终态；没收完的工具调用丢掉。
 * - 正文已经显示：它是模型说过的话，作为上一条推进 transcript，再起一轮让它接着做。
 *   没收完的工具调用同样丢掉，模型会重新发。
 *
 * `request_prepared` 不算 provider 事件——三个适配器都在发请求**之前**
 * 先 yield 它（见各 `stream()` 首行），所以「只收到过它」就等于
 * 「一个字节都没回来」。网络失败因此**全部落在 `consumeStream` 的 `for await` 里**，
 * 不在 `openStream` 里。
 *
 * 返回 `received` 表示这一轮的响应已收完（或被用户中止）；返回 `continued` 表示正文
 * 已显示后断开、已推进 transcript，调用方直接进下一轮。不可恢复的失败原样抛出。
 */
export async function* sendTurn(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'received' | 'continued', unknown> {
  const { adapter, input, persist, density, transcript } = run
  /** 本轮已经开过几行账。`uq_provider_run_turn` 的第三段取的就是它。 */
  const ledger = { sendIndex: 0 }
  /**
   * 这一轮自动重发过几次。上限 `MAX_RESENDS`；带上下文续发的一轮从上一轮接着数。
   *
   * **不要拿 `sendIndex` 代替它计数**：那个数还会被压缩重发推进，共用一个数
   * 等于压一次就消耗一次重发额度，界面上报的次数也跟着虚高。
   */
  let resends = run.carriedResends
  run.carriedResends = 0
  for (;;) {
    turn.attemptThinking = []

    // 同一轮的第 N 次发送。`uq_provider_run_turn` 靠它区分，重发因此不会顶掉
    // 上一次那行——两次都真实发生过，账要分开记。**就地自增**，不要挪到各条
    // 重发分支里去加：漏一条就是拿同一组键再插一次，整轮死在唯一索引上。
    const retryIndex = ledger.sendIndex++

    // 账本行在**发出之前**落。此刻要发什么已经确定（分组、指纹都算得出），
    // provider 是否接收仍未知——两件事分开记，「发出去了没回」
    // 和「没发出去」在账本上才可区分。
    const payload = payloadSnapshotOf(turn.req)
    turn.requestId = persist.openRequest({
      runId: input.runId,
      turnIndex: run.requestTurn,
      retryIndex,
      purpose: 'turn',
      ...(host.deps.providerName ? { providerName: host.deps.providerName } : {}),
      providerKind: adapter.kind,
      model: adapter.spec.id,
      measuredInputTokens: estimateRequest(turn.req, density),
      sentCategories: turn.breakdown,
      omittedCategories: host.lastOmitted(),
      payloadHash: payload.hash,
      requestBytes: payload.bytes,
      cacheRouteFingerprint: envelopeHashOf(turn.req),
    })

    const probe: StreamProbe = {
      lastEventAt: Date.now(),
      providerEvents: 0,
      recordedFirstEvent: false,
    }

    try {
      const stream = await host.openStream(turn.req, turn.requestId)
      persist.markRequestSent(turn.requestId)
      yield {
        type: 'run.request',
        runId: input.runId,
        requestId: turn.requestId,
        phase: 'sent',
        attempt: resends,
        max: MAX_RESENDS,
        at: Date.now(),
      }
      yield* consumeStream(host, run, turn, stream, probe, resends)
      return 'received'
    } catch (err) {
      const requestId = turn.requestId
      const pe = err instanceof ProviderError ? err : null
      const code = pe?.code ?? 'internal_error'
      const interrupted = input.signal.aborted
      const silentMs = Math.max(0, Date.now() - probe.lastEventAt)
      // 非 2xx 的响应头不经过 `response_started`（适配器在那条路上直接抛错），
      // 时刻只在传输读数里。它到过就记，账本因此分得出「连不上」和「被回绝」。
      if (pe?.transport?.headersAt != null) {
        persist.markRequestHeaders?.(requestId, pe.transport.headersAt)
      }
      const recordDecision = (
        decision: ProviderRetryDecision,
        attempt: number | null = null,
        backoffMs: number | null = null,
        at: number | null = null,
      ): void => {
        persist.recordRequestDiagnostic?.(requestId, {
          causes: failureCauseChain(err),
          providerEvents: probe.providerEvents,
          silentMs,
          transport: pe?.transport ?? null,
          assistantChars: turn.assistantText.length,
          toolCallCount: turn.calls.length,
          retry: { decision, attempt, max: MAX_RESENDS, backoffMs, at },
        })
      }

      /*
       * 终态判据是**「provider 有没有答复过」**，不是错误码。
       *
       * 有 HTTP 状态码 = 它明确回绝了，`rejected`；没有 = 连接层面就没成，
       * 是否送达、是否计费均无从判断，只能记 `uncertain`。
       * 不要按 `code === 'stream_idle_timeout'` 判：那会把一次「没连上」
       * 记成「provider 拒了」，是编出来的确定性。
       *
       * **用量与终态是两件事。** 流在收尾之前断掉时 provider 常常已经把用量
       * 报过了（实测：断流样本带着 `completion_tokens` 6476/5126）。那一格是实数，
       * 记 `null` 会让账本与实际不符。`uncertain` 表示送达状态未知，
       * 不表示未计费。`pe.usage` 缺席仍记 `null`——缺席不等于零。
       */
      persist.settleRequest(
        requestId,
        interrupted ? 'uncertain' : pe?.status !== undefined ? 'rejected' : 'uncertain',
        pe?.usage ?? null,
        interrupted ? null : code,
        turn.rawStop,
        !interrupted && pe?.status !== undefined && typeof pe.detail?.providerMessage === 'string'
          ? pe.detail.providerMessage
          : null,
      )

      // 中止来源由 runtime 的 AbortSignal reason 落到 run；请求行只记本次不重发。
      if (interrupted) {
        recordDecision('interrupted')
        throw err
      }

      if (code === 'context_overflow' && pe?.capacity && !run.overflowRecovered) {
        yield* recoverFromOverflow(host, run, turn, { err, pe, recordDecision, ledger })
        continue
      }

      // 不在重发表里的原样上抛：provider 已经说清是什么了（参数错、没权限、
      // 模型不存在），重发拿回来的是同一个拒绝。
      if (!pe) {
        recordDecision('not_retryable')
        throw err
      }
      const backoffMs = resendBackoffMs(pe, resends)
      if (backoffMs === undefined) {
        recordDecision('not_retryable')
        throw err
      }

      /*
       * 原始错误形状只写日志。
       *
       * `errno` 与英文原文对排查是全部，对界面是噪音——归类之后那句中文说的是
       * 「哪一类」，说不出「是哪个码」。少了这行，账本里只剩中文，
       * 回头分不出 `ECONNRESET`（对端重置）和本地空闲超时中止的。
       *
       * 取的是 `cause` 而不是 `err`：走到这里 `err` 已经是归类后的
       * `ProviderError`，它的 `code` 是 `network_error` 这种分类码，
       * 真正的 errno 挂在被它包住的那个原始错误上。
       */
      const raw = (err as { cause?: unknown }).cause
      log.warn('agent', `请求失败：${raw instanceof Error ? raw.message : pe.message}`, {
        turn: run.requestTurn,
        retry: retryIndex,
        code,
        errno: String((raw as { code?: unknown })?.code ?? '-'),
        events: probe.providerEvents,
        silentSeconds: Math.round(silentMs / 1000),
        // 传输层三项与事件层对照：响应头没到、排队中（有保活行）、连接已死。
        status: pe?.transport?.status ?? '-',
        bytes: pe?.transport?.bytes ?? '-',
        keepAlive: pe?.transport?.keepAliveLines ?? '-',
        lastByteSeconds:
          pe?.transport?.sinceLastByteMs != null
            ? Math.round(pe.transport.sinceLastByteMs / 1000)
            : '-',
      })

      /*
       * **额度是整轮的，不按码各记一份。** 一轮里先断流再被拒的话，前面用掉的
       * 次数照算——那一轮已经真的发出去过那么多次，换个码不该把账清零。
       */
      if (resends < MAX_RESENDS) {
        // 等待起点取一次，诊断与事件用同一个值——两处各取一次会让刷新后的
        // 倒计时与实时倒计时差出这两行之间的毫秒数。
        const waitingSince = Date.now()
        recordDecision('resend', resends + 1, backoffMs, waitingSince)
        resends++
        if (turn.assistantText === '') {
          /*
           * 正文一个字都没显示：原样重发，本次尝试的痕迹一起处置。
           *
           * - 思考 step 落失败终态。不落的话它们与重发那次的思考在同一个 run 里
           *   相邻，投影时被 `pendingReasoning` 拼成一条回传给 provider。
           * - `open` 必须置空。不置空的话重发后第一个 thinking_delta 经 `stepFor`
           *   命中旧 id，新生成被 `appendText` 拼进已失败的那条 step。
           * - `thinkingText` 同理，不清就是两次生成首尾相接后一起挂上
           *   `reasoningContent`。
           * - 没收完的工具调用丢掉：流干净结束而没有 finish_reason 时适配器会把它们
           *   交出来，参数可能不完整。
           */
          persist.failThinkingSteps(turn.attemptThinking)
          turn.open = null
          turn.pendingText = ''
          turn.thinkingText = ''
          turn.responseReasoning = undefined
          turn.calls.length = 0
          // 界面此刻的末条是失败那次的半截思考，不发这条事件它会一直显示「正在思考…」。
          yield {
            type: 'run.retrying',
            runId: input.runId,
            requestId,
            attempt: resends,
            max: MAX_RESENDS,
            backoffMs,
            at: waitingSince,
            failedThinkingStepIds: [...turn.attemptThinking],
          }
          if (backoffMs > 0) await host.backoff(backoffMs, input.signal)
          continue
        }

        /*
         * 正文已经显示：它是模型说过的话，作为上一条推进 transcript，再起一轮让它接着做。
         * 形状与投影一致（`runtime/transcript.ts`）：正文成 assistant 消息，没收完的
         * 工具调用不带。思考挂上去：续起后这一条与下一条 assistant 之间没有落账的
         * user 消息，DeepSeek 思考模式要求同一轮里每条 assistant 都带 reasoning_content
         * （与待办守卫续起时同一条理由）。
         */
        const unitStart = transcript.length
        transcript.push({
          role: 'assistant',
          content: turn.assistantText,
          ...(turn.thinkingText ? { reasoningContent: turn.thinkingText } : {}),
          ...(turn.responseReasoning ? { responseReasoning: turn.responseReasoning } : {}),
          _group: 'executionRecords',
        })
        run.stampUnit(unitStart)
        run.notices.push('上一条回复在此处中断，其后内容未送达。')
        run.carriedResends = resends
        run.turnIndex++
        yield {
          type: 'run.retrying',
          runId: input.runId,
          requestId,
          attempt: resends,
          max: MAX_RESENDS,
          backoffMs,
          at: waitingSince,
          failedThinkingStepIds: [],
        }
        if (backoffMs > 0) await host.backoff(backoffMs, input.signal)
        return 'continued'
      }

      recordDecision(resends >= MAX_RESENDS ? 'limit_exhausted' : 'not_retryable')

      /* 分类短语 + 已证实的超时读数 + 是否自动重发过，一行说完。 */
      const headline = pe.message.split(NEWLINE)[0]?.trim() || '模型服务出错'
      const facts = [
        headline,
        ...(pe.timedOut ? [transportReading(probe.providerEvents, silentMs)] : []),
        ...(resends > 0 ? [`已重发 ${resends} 次`] : []),
      ]
      throw new ProviderError({
        code: pe.code,
        message:
          facts.length === 1
            ? headline
            : [headline.replace(/[，。,.;；]+$/u, ''), ...facts.slice(1)].join('，'),
        provider: pe.provider,
        ...(pe.status !== undefined ? { status: pe.status } : {}),
        ...(pe.detail !== undefined ? { detail: pe.detail } : {}),
        ...(pe.retryAfterMs !== null ? { retryAfterMs: pe.retryAfterMs } : {}),
        ...(pe.timedOut ? { timedOut: true } : {}),
        cause: err,
      })
    }
  }
}

/** 把一次尝试的 provider 事件折进本轮状态并转成界面事件。用户中止时提前返回。 */
async function* consumeStream(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
  stream: AsyncIterable<ProviderEvent>,
  probe: StreamProbe,
  resends: number,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { adapter, input, persist, usage } = run
  for await (const ev of stream) {
    probe.lastEventAt = Date.now()
    if (ev.type !== 'request_prepared') {
      probe.providerEvents++
      if (!probe.recordedFirstEvent) {
        probe.recordedFirstEvent = true
        persist.markRequestFirstEvent?.(turn.requestId)
      }
      /*
       * 内容时刻**每一段都推进**，用适配器带来的观察时刻。
       *
       * 只记首次答不了「此刻静默了多久」：持续输出时首内容时刻离现在越来越远。
       * 空 delta、心跳、响应头、用量与 `done` 不在这张表里——它们证明连接还活，
       * 不证明模型又写出了内容。
       */
      if (
        ev.type === 'thinking_delta' ||
        ev.type === 'text_delta' ||
        ev.type === 'tool_call_progress' ||
        ev.type === 'tool_calls' ||
        ev.type === 'response_reasoning'
      ) {
        const kind: ProviderRequestContentKind =
          ev.type === 'thinking_delta'
            ? 'thinking'
            : ev.type === 'text_delta'
              ? 'text'
              : ev.type === 'tool_call_progress' || ev.type === 'tool_calls'
                ? 'tool_arguments'
                : 'other'
        const visible =
          (ev.type === 'thinking_delta' && ev.delta.length > 0) ||
          (ev.type === 'text_delta' && (turn.open?.kind === 'text' || /\S/.test(ev.delta)))
        persist.markRequestContent?.(turn.requestId, ev.at, kind, visible)
      }
    }
    if (input.signal.aborted) break

    switch (ev.type) {
      case 'response_reasoning': {
        turn.responseReasoning = ev.reasoning
        const id = persist.openThinkingStep(
          input.runId,
          run.nextSeq(),
          turn.requestId,
          ev.reasoning,
        )
        turn.attemptThinking.push(id as StepId)
        turn.open = null
        break
      }
      case 'tool_call_progress':
        // 参数进度只交给界面显示；空闲计时在传输层按字节走，不看事件。
        yield { type: 'tool.generating', runId: input.runId, at: ev.at }
        break
      case 'response_started':
        // 只作为传输遥测边界；不产生模型可见内容或 UI step。
        persist.markRequestHeaders?.(turn.requestId, ev.headersAt)
        yield {
          type: 'run.request',
          runId: input.runId,
          requestId: turn.requestId,
          phase: 'headers',
          attempt: resends,
          max: MAX_RESENDS,
          at: ev.headersAt,
        }
        break
      case 'request_prepared': {
        const limit = adapter.spec.contextWindow
        const m = run.meter(ev.measuredInputTokens)
        // 保留一位小数：1M 窗口下 2139 token 取整就是 0%，那一位有信息量。
        const pct = limit ? Math.round((m.tokens / limit) * 1000) / 10 : 0
        yield {
          type: 'context',
          runId: input.runId,
          tokens: m.tokens,
          limit,
          percent: pct,
          source: m.source,
          compactAt: softLimit(adapter.spec),
          /*
           * **必须对账**：`tokens` 走锚定尺（provider 真值 + 锚点后的一轮尾巴），
           * `breakdown` 是本地估算，两者天然不等。不对账的话面板上各行
           * 加起来对不上标题，而差额无声地落进「剩余空间」那一行。
           *
           * 会话面板那侧（`runtime/context-panel.ts`）一直是对过账的，
           * 这里不对就成了同一个面板两条路显示两组数：打开会话看到一组，
           * run 一跑起来换成另一组。实测差过 271k。
           *
           * `m.source === 'estimated'` 时 `m.tokens` 与 `breakdown` 同尺
           * 同源（都是 `estimateRequest` 的同一次装配），差额为零，
           * 这里是恒等变换。
           */
          breakdown: reconcileBreakdown(turn.breakdown, m.tokens),
          omitted: host.lastOmitted(),
        }
        break
      }
      case 'thinking_delta': {
        turn.pendingText = ''
        turn.thinkingText += ev.delta
        const stepId = turn.stepFor('thinking')
        persist.appendText(stepId, ev.delta)
        yield {
          type: 'thinking.delta',
          runId: input.runId,
          stepId: stepId as never,
          delta: ev.delta,
          redacted: false,
          at: ev.at,
        }
        break
      }
      case 'text_delta': {
        if (turn.open?.kind !== 'text' && !/\S/.test(ev.delta)) {
          turn.pendingText += ev.delta
          break
        }
        const delta = turn.pendingText + ev.delta
        turn.pendingText = ''
        const stepId = turn.stepFor('text')
        turn.assistantText += delta
        persist.appendText(stepId, delta)
        yield {
          type: 'text.delta',
          runId: input.runId,
          stepId: stepId as never,
          delta,
          at: ev.at,
        }
        break
      }
      case 'tool_calls': {
        turn.calls.push(...ev.calls)
        break
      }
      case 'usage': {
        turn.turnUsage = ev.usage
        mergeUsage(usage, ev.usage, adapter, run.turnIndex)
        persist.saveUsage(input.runId, usage)
        yield { type: 'usage', runId: input.runId, usage: structuredClone(usage) }
        break
      }
      case 'done': {
        turn.providerStop = ev.stopReason
        turn.rawStop = ev.rawStopReason
        if (ev.stopReason === 'refusal') {
          turn.refusalNote = ev.refusal?.explanation ?? '模型出于安全策略拒绝了该请求'
        }
        break
      }
      default:
        break
    }
  }
}
