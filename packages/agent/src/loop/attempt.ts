/**
 * 一轮请求的发送、事件消费与自动重发。重发策略（可重发的码、次数上限、退避）同样定义在本文件。
 */

import type { ProviderEvent } from '@qywork/ai'
import {
  estimateRequest,
  failureDiagnostics,
  ProviderError,
  providerContentKind,
  providerErrorMessage,
} from '@qywork/ai'
import type { AgentEvent, ProviderRetryDecision, StepId } from '@qywork/core'
import { log } from '@qywork/core'
import { recoverFromOverflow } from './compact.ts'
import { contextEvent } from './context.ts'
import {
  envelopeHashOf,
  mergeUsage,
  payloadSnapshotOf,
  reasoningPrefix,
  requestConfiguration,
} from './request.ts'
import type { LoopHost, RunState, TurnState } from './run-state.ts'

/** 换行符。用于日志，避免转义序列的反斜杠被工具链减半。 */
const NEWLINE = String.fromCharCode(10)

/**
 * 一轮之内原样重发的最大次数。**对可重发集合中的每个码一视同仁。**
 *
 * **该数值只在此处定义**，界面上「正在重连 N / M」中的 M 由 `run.retrying` 事件
 * 传递，不得在前端重复定义。
 *
 * 取 5 的依据是 2026-08-22 的一次实测：长思考请求 11/11 在 `reasoning_content`
 * 中途干净 EOF（无 `finish_reason`、无 `[DONE]`、无网络错误），短请求正常收尾。
 * 中断的是上游的某条线路而不是整条链路，重发一次不足以恢复；而每次尝试本身需要运行几十秒到
 * 两分钟，5 次不构成对上游的密集请求。
 *
 * 重发形式由尝试循环按正文是否已显示决定：未显示时原样重发；已显示时把正文作为
 * 上一条消息推进 transcript，携带当前上下文续发。两种形式共用同一上限，续发的下一轮
 * 沿用上一轮的计数（`carriedResends`）。
 */
export const MAX_RESENDS = 5

/**
 * 会自动重发的失败码。次数上限见 `MAX_RESENDS`，等待时长见 `resendBackoffMs`。
 *
 * 该集合只决定「是否重发」，**不决定「以何种形式重发」**：原样重发还是携带当前上下文
 * 续发，由尝试循环按正文是否已显示决定。
 *
 * 不要以「重发需要多支付一次长 prompt 的费用」为由移除 `provider_unavailable`：
 * 不重发时用户需要手动继续，那一次支付的是同样的费用，而且 run 已被写为 failed，
 * 新消息还需让模型重新理解上一轮的进度。
 *
 * **`invalid_request` 不在集合中，不要加入。** 该码的定义是「同一份字节再发一次
 * 得到同一个拒绝」（`ai/errors.ts` 中 400 / 413 / 422 的分支），加入后只会把真正的原因
 * （例如该模型不接受图片）推迟到五次重发之后才显示。中转站已证实可恢复的模糊拒绝
 * 由 `ai/errors.ts` 精确归入 `provider_unavailable`，此处不再按文案分支判断。
 *
 * **超时与断连同等处理。** `stream_idle_timeout` 是传输层按字节空闲中断的流，连接已判定失效；
 * 连接超时（`timedOut` 的 `network_error`）是等待 `PROVIDER_HTTP.timeout` 后响应头仍未返回，
 * 处理相同。中断后不重发意味着本轮必然失败；重复推理的代价由重发窗口限制：正文已显示的部分
 * 作为上一条保留，不重新执行。
 */
const RESENDABLE_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'stream_idle_timeout',
  'provider_unavailable',
  'rate_limited',
])

/** 指数退避的首个间隔。中转侧故障的恢复为秒级，更短的首个间隔等于不退避地反复请求对端。 */
const RESEND_BACKOFF_BASE_MS = 2_000

/** 单次退避上限。取 30 秒时，首发加五次重发的总等待时间为分钟量级。 */
const RESEND_BACKOFF_MAX_MS = 30_000

/** 抖动比例，只向上增加：同时被拒的多个请求需要错开重发时刻，下限仍是退避间隔本身。 */
const RESEND_BACKOFF_JITTER = 0.1

/**
 * 重发前的等待时长。不可重发的失败返回 undefined。
 *
 * **可重发的失败一律先等待。** 上游提供 `Retry-After` 时按其等待，否则按指数退避。
 * 连接层失败后立即原样重发不能加快恢复，只会在对端仍不可用时把五次额度
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
 * 分类短语由 `ai` 包的传输层与错误归类给出，它们无法取得静默时长，
 * 也无法得知本次是否收到过数据；而这两项用于区分请求未送达（未收到任何字节）
 * 与生成中断（收到数据后停止）。只有 `ProviderError.timedOut` 为真时才调用本函数，
 * 立即断流与协议失败不能借静默时长伪装成超时。
 *
 * 该读数只在此处拼装，全项目没有第二个拼装处。
 */
function transportReading(receivedResponse: boolean, silentMs: number): string {
  const secs = Math.round(silentMs / 1000)
  if (!receivedResponse) return `${secs} 秒未收到响应`
  return `${secs} 秒未收到后续数据`
}

/** 一次尝试中 provider 事件的读数，失败时供诊断与超时读数使用。 */
interface StreamProbe {
  /**
   * 最后一次收到事件的时刻。**初值是发出时刻而不是 0**：未收到任何事件时，
   * 它与当前时刻之差即发出后的等待时长，无需另记发送时刻。
   */
  lastEventAt: number
  /** provider 实际返回的事件数（不含 `request_prepared`）。 */
  providerEvents: number
  recordedFirstEvent: boolean
}

/**
 * ── 发送与消费：一次尝试，中断后携带当前上下文重新发送，至多 `MAX_RESENDS` 次 ──
 *
 * 断开时已收到的内容按两种情形处置，与 `runtime/transcript.ts` 的投影形式一致：
 *
 * - 正文尚未显示：上下文未变，原样重发。失败那次的思考不进入模型视图，
 *   step 置为失败终态；未接收完整的工具调用丢弃。
 * - 正文已显示：它是模型已输出的内容，作为上一条消息推进 transcript，再开始一轮使模型继续执行。
 *   未接收完整的工具调用同样丢弃，模型会重新发出。
 *
 * `request_prepared` 不计为 provider 事件：三个适配器都在发送请求**之前**
 * yield 它（见各 `stream()` 首行），因此「只收到过它」等于
 * 「未返回任何字节」。网络失败因此**全部发生在 `consumeStream` 的 `for await` 中**，
 * 不在 `openStream` 中。
 *
 * 返回 `received` 表示本轮响应已接收完毕（或被用户中止）；返回 `continued` 表示正文
 * 已显示后断开、已推进 transcript，调用方直接进入下一轮。不可恢复的失败原样抛出。
 */
export async function* sendTurn(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'received' | 'continued', unknown> {
  const { adapter, input, persist, density, transcript } = run
  /** 本轮已开的请求记录行数。`uq_provider_run_turn` 的第三列取该值。 */
  const ledger = { sendIndex: 0 }
  /**
   * 本轮自动重发的次数。上限为 `MAX_RESENDS`；携带上下文续发的一轮沿用上一轮的计数。
   *
   * **不要用 `sendIndex` 代替它计数**：`sendIndex` 还会因压缩后重发而递增，共用同一计数
   * 会使每次压缩都消耗一次重发额度，界面上报告的次数也随之偏高。
   */
  let resends = run.carriedResends
  run.carriedResends = 0
  for (;;) {
    turn.attemptThinking = []

    // 同一轮的第 N 次发送。`uq_provider_run_turn` 依据它区分各次发送，重发因此不会覆盖
    // 上一次的记录行：两次发送都实际发生过，必须分开记录。**就地自增**，不要移到各个
    // 重发分支中递增：遗漏一处就会以同一组键再次插入，整轮因唯一索引冲突而失败。
    const retryIndex = ledger.sendIndex++

    // 账本行在**发出之前**写入。此时发送内容已经确定（分组与指纹均可计算），
    // provider 是否接收仍未知；两件事分开记录，「已发出但未返回」
    // 与「未发出」在账本上才可区分。
    const payload = payloadSnapshotOf(turn.req)
    const measured = estimateRequest(turn.req, density)
    turn.requestId = persist.openRequest({
      runId: input.runId,
      turnIndex: run.requestTurn,
      retryIndex,
      purpose: 'turn',
      ...(host.deps.providerName ? { providerName: host.deps.providerName } : {}),
      providerKind: adapter.kind,
      model: adapter.spec.id,
      measuredInputTokens: measured,
      // 与 `request_prepared` 时交给界面的读数采用同一估算口径、同一数值。
      occupancyTokens: run.meter(measured).tokens,
      configuration: requestConfiguration(turn.req, adapter),
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
      const stream = await host.openStream(turn.req)
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
      // 非 2xx 的响应头不经过 `response_started`（适配器在该路径上直接抛错），
      // 到达时刻只记录在传输读数中。响应头到达过就记录，账本因此能区分「无法连接」与「被拒绝」。
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
          ...failureDiagnostics(err),
          providerEvents: probe.providerEvents,
          silentMs,
          assistantChars: turn.assistantText.length,
          toolCallCount: turn.calls.length,
          retry: { decision, attempt, max: MAX_RESENDS, backoffMs, at },
        })
      }

      /*
       * 终态判据是**「provider 是否答复过」**，不是错误码。
       *
       * 有 HTTP 状态码表示 provider 明确拒绝，记为 `rejected`；没有状态码表示连接层未成功，
       * 是否送达、是否计费均无从判断，只能记为 `uncertain`。
       * 不要按 `code === 'stream_idle_timeout'` 判定：那会把一次「未连接成功」
       * 记为「provider 已拒绝」，这是无依据的确定性。
       *
       * **用量与终态相互独立。** 流在结束之前中断时，provider 通常已经报告过用量
       * （实测：断流样本带有 `completion_tokens` 6476/5126）。该字段是实际数值，
       * 记为 `null` 会使账本与实际不符。`uncertain` 表示送达状态未知，
       * 不表示未计费。`pe.usage` 缺失时仍记 `null`：缺失不等于零。
       */
      persist.settleRequest(
        requestId,
        interrupted ? 'uncertain' : pe?.status !== undefined ? 'rejected' : 'uncertain',
        pe?.usage ?? null,
        interrupted ? null : code,
        turn.rawStop,
        interrupted ? null : providerErrorMessage(err),
      )

      // 中止来源由 runtime 的 AbortSignal reason 写入 run；请求行只记录本次不重发。
      if (interrupted) {
        recordDecision('interrupted')
        throw err
      }

      if (code === 'context_overflow' && pe?.capacity && !run.overflowRecovered) {
        yield* recoverFromOverflow(host, run, turn, { err, pe, recordDecision, ledger })
        continue
      }

      // 不在重发集合中的错误原样上抛：provider 已明确说明原因（参数错误、无权限、
      // 模型不存在），重发得到的是同一个拒绝。
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
       * `errno` 与英文原文是排查的全部依据，但对界面是噪音：归类后的中文说明只表达
       * 错误类别，不包含具体错误码。缺少这行日志时，账本中只有中文说明，
       * 事后无法区分 `ECONNRESET`（对端重置）与本地空闲超时中止。
       *
       * 读取 `cause` 而不是 `err`：执行到此处时 `err` 已是归类后的
       * `ProviderError`，其 `code` 是 `network_error` 这类分类码，
       * 真正的 errno 位于它所包装的原始错误上。
       */
      const raw = (err as { cause?: unknown }).cause
      log.warn('agent', `请求失败：${raw instanceof Error ? raw.message : pe.message}`, {
        turn: run.requestTurn,
        retry: retryIndex,
        code,
        errno: String((raw as { code?: unknown })?.code ?? '-'),
        events: probe.providerEvents,
        silentSeconds: Math.round(silentMs / 1000),
        // 传输层三项与事件层对照：响应头未到达、排队中（有保活行）、连接已失效。
        status: pe?.transport?.status ?? '-',
        bytes: pe?.transport?.bytes ?? '-',
        keepAlive: pe?.transport?.keepAliveLines ?? '-',
        lastByteSeconds:
          pe?.transport?.sinceLastByteMs != null
            ? Math.round(pe.transport.sinceLastByteMs / 1000)
            : '-',
      })

      /*
       * **额度按整轮计算，不按错误码分别计数。** 一轮中先断流再被拒时，之前用掉的
       * 次数照常计入：该轮已实际发送过这些次数，错误码变化不应使计数清零。
       */
      if (resends < MAX_RESENDS) {
        // 等待起点只取一次，诊断与事件使用同一个值：两处分别取值会使刷新后的
        // 倒计时与实时倒计时相差这两行之间的毫秒数。
        const waitingSince = Date.now()
        recordDecision('resend', resends + 1, backoffMs, waitingSince)
        resends++
        if (turn.assistantText === '') {
          /*
           * 正文尚未显示：原样重发，并一并处置本次尝试留下的状态。
           *
           * - 思考 step 置为失败终态。否则它们与重发那次的思考在同一个 run 中
           *   相邻，投影时被 `pendingReasoning` 拼接为一条回传给 provider。
           * - `open` 必须置空。不置空时，重发后第一个 thinking_delta 经 `stepFor`
           *   命中旧 id，新生成的内容被 `appendText` 拼接到已失败的 step。
           * - `thinkingText` 同理，不清空会导致两次生成首尾相接后一起写入
           *   `reasoningContent`。
           * - 丢弃未接收完整的工具调用：流正常结束而没有 finish_reason 时，适配器会把它们
           *   交出，参数可能不完整。
           */
          persist.failThinkingSteps(turn.attemptThinking)
          turn.open = null
          turn.pendingText = ''
          turn.thinkingText = ''
          turn.responseReasoning = undefined
          turn.calls.length = 0
          // 界面此时的末条是失败那次未完成的思考，不发送该事件时它会持续显示「正在思考…」。
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
         * 正文已显示：它是模型已输出的内容，作为上一条消息推进 transcript，再开始一轮使模型继续执行。
         * 形式与投影一致（`runtime/transcript.ts`）：正文作为 assistant 消息，未接收完整的
         * 工具调用不带入。思考一并附上：自动继续后这一条与下一条 assistant 之间没有已落账的
         * user 消息，DeepSeek 思考模式要求同一轮中每条 assistant 都带 reasoning_content
         * （与待办守卫自动继续时的理由相同）。
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
        run.notify('上一条回复在此处中断，其后内容未送达。')
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

      /* 分类短语 + 已证实的超时读数 + 自动重发次数，合并为一行。 */
      const headline = pe.message.split(NEWLINE)[0]?.trim() || '模型服务出错'
      const facts = [
        headline,
        ...(pe.timedOut
          ? [
              transportReading(
                probe.providerEvents > 0 || pe.transport?.headersAt != null,
                silentMs,
              ),
            ]
          : []),
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

/** 把一次尝试的 provider 事件合并到本轮状态并转换为界面事件。用户中止时提前返回。 */
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
    if (ev.type !== 'request_prepared' && ev.type !== 'response_started') {
      probe.providerEvents++
      if (!probe.recordedFirstEvent) {
        probe.recordedFirstEvent = true
        persist.markRequestFirstEvent?.(turn.requestId)
      }
      /*
       * 内容时刻**每收到一段都更新**，取适配器提供的观察时刻。
       *
       * 只记录首次时刻无法回答「当前已静默多久」：持续输出时，首个内容时刻与当前时刻的间隔不断增大。
       * 空 delta、心跳、响应头、用量与 `done` 不在此列：它们证明连接仍然有效，
       * 不证明模型产生了新内容。
       */
      const kind = providerContentKind(ev)
      if (kind !== null && 'at' in ev) {
        const visible =
          (ev.type === 'thinking_delta' && ev.delta.length > 0) ||
          (ev.type === 'text_delta' && (turn.open?.kind === 'text' || /\S/.test(ev.delta)))
        persist.markRequestContent?.(turn.requestId, ev.at, kind, visible)
      }
    }
    if (input.signal.aborted) break

    switch (ev.type) {
      case 'response_reasoning': {
        // 附加产生它的请求的前缀指纹：回放时据此判断前缀是否变化。
        turn.responseReasoning = { ...ev.reasoning, prefix: reasoningPrefix(turn.req) }
        const id = persist.openThinkingStep(
          input.runId,
          run.nextSeq(),
          turn.requestId,
          turn.responseReasoning,
        )
        turn.attemptThinking.push(id as StepId)
        turn.open = null
        break
      }
      case 'tool_call_progress':
        // 参数进度只交给界面显示；空闲计时在传输层按字节计算，不依据事件。
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
        yield contextEvent(host, run, turn, ev.measuredInputTokens)
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
