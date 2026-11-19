/**
 * 一轮请求的发送、事件消费与自动重发。重发策略（可重发的码、次数上限、退避、用尽后等待服务恢复）同样定义在本文件。
 */

import type { ProviderEvent, WireMessage } from '@qywork/ai'
import { estimateRequest, failureDiagnostics, ProviderError, providerContentKind } from '@qywork/ai'
import type { AgentEvent, ProviderRetryDecision, StepId } from '@qywork/core'
import {
  log,
  RECOVERY_WAITS_MS,
  RESEND_LIMIT,
  resendDelay,
  TRANSIENT_RETRY_DELAYS_MS,
  transientRetryDelay,
} from '@qywork/core'
import { concurrencyRejected, type SendOutcome, sendLane, sendLimiter } from '../send-limit.ts'
import { videoMetaOf } from '../video-meta.ts'
import { recoverFromOverflow } from './compact.ts'
import { contextEvent } from './context.ts'
import {
  breakdownOf,
  envelopeHashOf,
  envelopeItemsOf,
  mergeUsage,
  payloadSnapshotOf,
  reasoningPrefix,
  requestConfiguration,
  softLimit,
  videoDelivery,
} from './request.ts'
import type { LoopHost, RunState, TurnState } from './run-state.ts'

/** 换行符。用于日志，避免转义序列的反斜杠被工具链减半。 */
const NEWLINE = String.fromCharCode(10)

/**
 * 会自动重发的失败码。次数上限见 `resendLimitOf`，**对集合中的每个码一视同仁**；等待时长见 `resendBackoffMs`。
 *
 * 重发形式由尝试循环按正文是否已显示决定：未显示时原样重发；已显示时把正文作为
 * 上一条消息推进 transcript，携带当前上下文继续发送。两种形式共用同一上限，继续发送的下一轮
 * 沿用上一轮的计数（`carriedResends`）。
 *
 * 该集合只决定「是否重发」，**不决定「以何种形式重发」**：原样重发还是携带当前上下文
 * 继续发送，由尝试循环按正文是否已显示决定。
 *
 * 不要以「重发需要多支付一次长 prompt 的费用」为由移除 `provider_unavailable`：
 * 不重发时用户需要手动继续，支付的是同样的费用；且 run 已记为 failed，
 * 新消息还需模型重新理解上一轮的进度。
 *
 * **`invalid_request` 不在集合中，不要加入。** 该码的定义是「同一份字节再发一次
 * 得到同一个拒绝」（`ai/errors.ts` 中 400 / 413 / 422 的分支），加入后只会把真正的原因
 * （例如该模型不接受图片）推迟到五次重发之后才显示。第三方接口已证实可恢复的模糊拒绝
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

/**
 * 失败码是否属于暂时故障。摘要请求（`runtime/summarizer.ts`）与 art 卡片请求（`runtime/art.ts`）的重试
 * 与本轮内的重发使用同一个集合，不另立一份分类。
 */
export function transientErrorCode(code: string): boolean {
  return RESENDABLE_CODES.has(code)
}

/**
 * 重发前的等待时长。不可重发的失败返回 undefined。
 *
 * **可重发的失败一律先等待**。顶层会话的时长由 `resendDelay`（`core`）按指数退避与上游给出的 `Retry-After` 计算，
 * 与生成的重试相同；子 agent 的轮次（`transientResend`）按暂时故障的间隔表 `transientRetryDelay` 等待。
 * 不要在此另行处理 `Retry-After`：连接层失败或上游给出 0 秒后立即原样重发不能加快恢复，
 * 只会在对端仍不可用时在数毫秒内用尽次数。
 */
function resendBackoffMs(run: RunState, error: ProviderError, resends: number): number | undefined {
  if (!RESENDABLE_CODES.has(error.code)) return undefined
  return run.input.transientResend
    ? transientRetryDelay(resends, error.retryAfterMs)
    : resendDelay(resends, error.retryAfterMs)
}

/**
 * 本地计时器确认超时后的现场读数。
 *
 * 分类短语由 `ai` 包的传输层与错误归类给出，它们无法取得静默时长，
 * 也无法得知本次是否收到过数据；而这两项用于区分请求未送达（未收到任何字节）
 * 与生成中断（收到数据后停止）。只有 `ProviderError.timedOut` 为真时才调用本函数，
 * 立即断流与协议失败不附带静默时长，不报告为超时。
 *
 * 该读数只在此处拼装，全项目没有第二个拼装处。
 */
function transportReading(receivedResponse: boolean, silentMs: number): string {
  const secs = Math.round(silentMs / 1000)
  if (!receivedResponse) return `${secs} 秒未收到响应`
  return `${secs} 秒未收到后续数据`
}

/** 一次请求的自动重发上限：子 agent 的轮次（`transientResend`）为间隔表的长度，其余为 `RESEND_LIMIT`。 */
function resendLimitOf(run: RunState): number {
  return run.input.transientResend ? TRANSIENT_RETRY_DELAYS_MS.length : RESEND_LIMIT
}

/**
 * 重发用尽之后等待服务恢复期间的重发次数。子 agent 的轮次（`transientResend`）为 0：失败回执立即交给派发方，
 * 由它改用其他接口或模型。
 */
function recoveryLimitOf(run: RunState): number {
  return run.input.transientResend ? 0 : RECOVERY_WAITS_MS.length
}

/**
 * 第 `resends` 次发送（首发为 0）在界面事件中的序号与上限。超过重发上限的发送属于等待服务恢复阶段，
 * 按 `RECOVERY_WAITS_MS` 另行计数，界面据 `recovery` 显示「等待服务恢复」而不是第几次重试。
 */
function attemptOf(
  run: RunState,
  resends: number,
): { attempt: number; max: number; recovery?: true } {
  const limit = resendLimitOf(run)
  return resends > limit
    ? { attempt: resends - limit, max: recoveryLimitOf(run), recovery: true }
    : { attempt: resends, max: limit }
}

/**
 * 等待服务恢复：最长 `ms` 毫秒；同一端点与模型上本进程任一请求成功时提前结束（`SendLimiter.nextCompletion`）。
 * 中止时以中止原因拒绝，与 `LoopHost.backoff` 相同。返回之前取消尚未结束的一个等待，不遗留计时器或等待者。
 */
async function waitForRecovery(host: LoopHost, run: RunState, ms: number): Promise<void> {
  const settled = new AbortController()
  const signal = AbortSignal.any([run.input.signal, settled.signal])
  const timer = host.backoff(ms, signal)
  const peer = sendLimiter.nextCompletion(sendLane(run.adapter), signal)
  // 落后的一个在取消后拒绝；此处先为两者添加处理器，它的拒绝不成为未处理的拒绝。
  timer.catch(() => {})
  peer.catch(() => {})
  try {
    await Promise.race([timer, peer])
  } finally {
    settled.abort()
  }
}

/** 报错的第一行：分类短语。多行的报错正文只在第一行给出分类。 */
function headlineOf(pe: ProviderError): string {
  return pe.message.split(NEWLINE)[0]?.trim() || '模型服务出错'
}

/**
 * 本次尝试的思考写为失败终态并通知前端：所属请求失败，且失败时尚未输出正文。
 *
 * 重发之前与本轮以失败结束之前都经由本函数。只在重发之前处理时，重发次数用尽的那一次尝试的思考
 * 在账本与界面上记为已完成，与此前被中断的几次不一致。已输出正文时不处理：该段思考随正文保留。
 */
function* abandonThinking(run: RunState, turn: TurnState): Generator<AgentEvent, void, unknown> {
  if (turn.assistantText !== '' || turn.attemptThinking.length === 0) return
  run.persist.failThinkingSteps(turn.attemptThinking)
  yield { type: 'thinking.interrupted', runId: run.input.runId, stepIds: [...turn.attemptThinking] }
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
 * ── 发送与消费：一次尝试，中断后携带当前上下文重新发送，次数上限见 `resendLimitOf` ──
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
  const { adapter, input, persist, transcript } = run
  /** 本轮已开的请求记录行数。`uq_provider_run_turn` 的第三列取该值。 */
  const ledger = { sendIndex: 0 }
  /**
   * 本轮自动重发的次数。上限为 `limit`；携带上下文继续发送的一轮沿用上一轮的计数。
   *
   * **不要用 `sendIndex` 代替它计数**：`sendIndex` 还会因压缩后重发而递增，共用同一计数
   * 会使每次压缩都消耗一次重发额度，界面上报告的次数也随之偏高。
   */
  let resends = run.carriedResends
  run.carriedResends = 0
  const limit = resendLimitOf(run)
  const recoveryLimit = recoveryLimitOf(run)
  /** 本轮各次可重发失败的分类短语，按发生顺序；携带上下文继续发送的一轮一并沿用。用尽时写入报错。 */
  const causes = run.carriedCauses
  run.carriedCauses = []
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
    // 读取 `run.density` 而不是循环外的副本：接口拒绝视频后本轮密度随之改变（`removeVideos`）。
    const measured = estimateRequest(turn.req, run.density)
    turn.measured = measured
    turn.requestId = persist.openRequest({
      runId: input.runId,
      turnIndex: run.requestTurn,
      retryIndex,
      purpose: 'turn',
      ...(host.deps.providerName ? { providerName: host.deps.providerName } : {}),
      providerKind: adapter.kind,
      model: adapter.spec.id,
      measuredInputTokens: measured,
      // 与 `request_prepared` 时提供给界面的读数采用同一估算口径、同一数值。
      occupancyTokens: run.meter(measured).tokens,
      // 触发线随主请求写入：面板事后显示的刻度取自该值，不按读取时的设置重算。摘要请求不写。
      configuration: {
        ...requestConfiguration(turn.req, adapter),
        compactAt: softLimit(run.threshold),
      },
      sentCategories: turn.breakdown,
      omittedCategories: host.lastOmitted(),
      payloadHash: payload.hash,
      requestBytes: payload.bytes,
      cacheRouteFingerprint: envelopeHashOf(turn.req),
      envelopeItems: () => envelopeItemsOf(turn.req, run.density),
    })

    const probe: StreamProbe = {
      lastEventAt: Date.now(),
      providerEvents: 0,
      recordedFirstEvent: false,
    }

    /*
     * 同时在途的名额（`send-limit.ts`）。在账本行写入之后、发出之前取得：排队期间该行保持未发出，
     * 发出时刻不含排队时间。出错时在处理开头释放，重发前的退避不占名额；`finally` 覆盖生成器被提前关闭。
     */
    let release: ((outcome: SendOutcome) => void) | null = null
    try {
      release = await sendLimiter.acquire(sendLane(adapter), input.signal)
      const stream = await host.openStream(run, turn.req)
      persist.markRequestSent(turn.requestId)
      yield {
        type: 'run.request',
        runId: input.runId,
        requestId: turn.requestId,
        phase: 'sent',
        ...attemptOf(run, resends),
        at: Date.now(),
      }
      yield* consumeStream(host, run, turn, stream, probe, resends)
      release('completed')
      return 'received'
    } catch (err) {
      release?.(concurrencyRejected(err) ? 'concurrency_rejected' : 'failed')
      const requestId = turn.requestId
      const pe = err instanceof ProviderError ? err : null
      const code = pe?.code ?? 'internal_error'
      const interrupted = input.signal.aborted
      const silentMs = Math.max(0, Date.now() - probe.lastEventAt)
      // 非 2xx 的响应头不经过 `response_started`（适配器在该路径上直接抛错），
      // 到达时刻只记录在传输读数中。响应头到达过就记录，账本因此能区分「无法连接」与「被拒绝」。
      if (pe?.transport?.headersAt != null) {
        persist.markRequestHeaders(
          requestId,
          pe.transport.headersAt,
          pe.transport.cloudRequestId ?? null,
        )
      }
      if (pe?.transport?.hedge) persist.markRequestHedge(requestId, pe.transport.hedge)
      const recordDecision = (
        decision: ProviderRetryDecision,
        attempt: number | null = null,
        backoffMs: number | null = null,
        at: number | null = null,
        max: number = limit,
      ): void => {
        persist.recordRequestDiagnostic(requestId, {
          ...failureDiagnostics(err),
          providerEvents: probe.providerEvents,
          silentMs,
          assistantChars: turn.assistantText.length,
          toolCallCount: turn.calls.length,
          retry: { decision, attempt, max, backoffMs, at },
        })
      }

      /*
       * 终态判据是**「provider 是否答复过」**，不是错误码。
       *
       * 对端明确报告了失败（HTTP 错误状态或流内错误事件，见 `ProviderError.rejected`）记为 `rejected`；
       * 其余情况是连接层未成功，是否送达、是否计费均无从判断，只能记为 `uncertain`。
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
        interrupted ? 'uncertain' : pe?.rejected ? 'rejected' : 'uncertain',
        pe?.usage ?? null,
        interrupted ? null : code,
        turn.rawStop,
        interrupted ? null : err instanceof Error ? err.message : String(err),
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

      if (pe && rejectedForVideos(run, turn, pe)) {
        removeVideos(host, run, turn, pe)
        recordDecision('videos_removed')
        continue
      }

      if (pe && rejectedForImages(run, turn, pe)) {
        removeImages(host, run, turn, pe)
        recordDecision('images_removed')
        continue
      }

      // 不在重发集合中的错误原样抛出：provider 已明确说明原因（参数错误、无权限、
      // 模型不存在），重发得到的是同一个拒绝。
      if (!pe) {
        recordDecision('not_retryable')
        yield* abandonThinking(run, turn)
        throw err
      }
      const backoffMs = resendBackoffMs(run, pe, resends)
      if (backoffMs === undefined) {
        recordDecision('not_retryable')
        yield* abandonThinking(run, turn)
        throw err
      }

      /*
       * 传输层的原始错误形状只写日志。
       *
       * `errno` 与 SDK 的英文原文是排查的依据，不在界面显示：传输层失败的正文只是分类说明，
       * 不包含具体错误码。缺少这行日志时，账本中只有分类说明，
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
       * **额度按整轮计算，不按错误码分别计数。** 一轮中先断流再被拒时，之前已使用的
       * 次数照常计入：该轮已实际发送过这些次数，错误码变化不应使计数清零。
       */
      causes.push(headlineOf(pe))
      /*
       * 重发用尽之后不立即结束：失败仍属于暂时故障时进入等待服务恢复，计数接续 `resends`，
       * 等待取 `RECOVERY_WAITS_MS` 并可被同一端点与模型上其他请求的成功提前结束（`waitForRecovery`）。
       * 不要在等待期间改发探测请求：对端可能接受小请求而仍拒绝真实请求，只有真实请求能确认本次能否成功。
       */
      if (resends < limit + recoveryLimit) {
        const recovering = resends >= limit
        const waitMs = recovering ? RECOVERY_WAITS_MS[resends - limit]! : backoffMs
        const counted = attemptOf(run, resends + 1)
        // 等待起点只取一次，诊断与事件使用同一个值：两处分别取值会使刷新后的
        // 倒计时与实时倒计时相差这两行之间的毫秒数。
        const waitingSince = Date.now()
        recordDecision(
          recovering ? 'recovery_wait' : 'resend',
          counted.attempt,
          waitMs,
          waitingSince,
          counted.max,
        )
        resends++
        const retrying: AgentEvent = {
          type: 'run.retrying',
          runId: input.runId,
          requestId,
          ...counted,
          reason: pe.message,
          backoffMs: waitMs,
          at: waitingSince,
        }
        const wait = () =>
          recovering ? waitForRecovery(host, run, waitMs) : host.backoff(waitMs, input.signal)
        if (turn.assistantText === '') {
          /*
           * 正文尚未显示：原样重发，并一并处置本次尝试留下的状态。
           *
           * - 思考 step 置为失败终态（`abandonThinking`）。否则它们与重发那次的思考在同一个 run 中
           *   相邻，投影时被 `pendingReasoning` 拼接为一条回传给 provider。
           * - `open` 必须置空。不置空时，重发后第一个 thinking_delta 经 `stepFor`
           *   命中旧 id，新生成的内容被 `appendText` 拼接到已失败的 step。
           * - `thinkingText` 同理，不清空会导致两次生成首尾相接后一起写入
           *   `reasoningContent`。
           * - 丢弃未接收完整的工具调用：流正常结束而没有 finish_reason 时，适配器会产出
           *   它们，参数可能不完整。
           */
          yield* abandonThinking(run, turn)
          turn.open = null
          turn.pendingText = ''
          turn.thinkingText = ''
          turn.responseReasoning = undefined
          turn.calls.length = 0
          // 界面此时的末条是失败那次未完成的思考，不发送该事件时它会持续显示「正在思考…」。
          yield retrying
          await wait()
          continue
        }

        /*
         * 正文已显示：它是模型已输出的内容，作为上一条消息推进 transcript，再开始一轮使模型继续执行。
         * 形式与投影一致（`runtime/transcript.ts`）：正文作为 assistant 消息，未接收完整的
         * 工具调用不带入。思考一并附上：自动继续后这一条与下一条 assistant 之间没有已写入账本的
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
        run.carriedCauses = causes
        run.turnIndex++
        yield retrying
        await wait()
        return 'continued'
      }

      recordDecision('limit_exhausted')
      yield* abandonThinking(run, turn)

      /*
       * 分类短语 + 已证实的超时读数 + 自动重发次数 + 此前各次不同的失败原因，合并为一行。
       * 此前的原因不要省略：子 agent 的失败回执只带这一行，派发方据此判断是否改用其他接口或模型，
       * 只写最后一次时，前几次的原因（如第三方接口拒绝访问）不出现在回执中。
       */
      const headline = headlineOf(pe)
      const earlier = [...new Set(causes)].filter((cause) => cause !== headline)
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
        ...(earlier.length ? [`此前的失败：${earlier.join('；')}`] : []),
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
        rejected: pe.rejected,
        cause: err,
      })
    } finally {
      release?.('failed')
    }
  }
}

/**
 * 被拒的请求是否按「接口拒绝视频」处理：provider 以 400 / 422 拒绝、本次请求含原生发送的视频、本 run 尚未停止发送视频。
 *
 * 先于图片判定：接受视频输入的接口比接受图片的少，同一请求中两者都有时先移除视频；重发仍被拒时再按图片判定。
 * 已在模型规格中写明的限制（时长范围）发送前即改为抽帧（`runDensity`），本判定处理规格中没有写明的拒绝原因。
 * 其余约定同 `rejectedForImages`。
 */
function rejectedForVideos(run: RunState, turn: TurnState, pe: ProviderError): boolean {
  const rule = run.density.video
  return (
    pe.code === 'invalid_request' &&
    (pe.status === 400 || pe.status === 422) &&
    !run.videosRejected &&
    rule !== null &&
    turn.req.messages.some(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((b) => {
          if (b.type !== 'video' || b.source.kind !== 'path') return false
          const meta = videoMetaOf(b.source.path)
          const upload = run.adapter.transmits.mediaUploadAbove
          return meta !== null && videoDelivery(meta, rule, upload) !== 'frames'
        }),
    )
  )
}

/**
 * ── 接口拒绝视频：改为抽取关键帧后重发一次 ──
 *
 * 与 `removeImages` 相同：被拒的事实连同接口返回的原因作为执行事实提供给模型，本 run 随即停止原生发送视频
 * （本轮密度的 `video` 置为 null，物化时视频替换为指向 `read_file` 抽帧的说明），请求按同一装配重建。
 * 重发被接口接受后才写入执行事实（`settleRejectionNotices`），其中的接口名与模型 id 是之后的 run 停止原生发送视频的判据。
 */
function removeVideos(host: LoopHost, run: RunState, turn: TurnState, pe: ProviderError): void {
  run.videosRejected = true
  run.density = { ...run.density, video: null }
  const reason = (pe.message.split(NEWLINE)[0] ?? '').trim().replace(/[，。,.;；]+$/u, '')
  const text =
    `包含视频的请求被接口拒绝，接口返回 ${reason}。本会话此后发往该接口的请求不直接携带视频；` +
    '需要画面时用 read_file 读取视频的路径，将按时间抽取若干帧。'
  const seq = run.nextSeq()
  run.pushNotice(text, seq)
  run.pendingVideosNotice = { seq, text }
  turn.req = host.buildRequest(run)
  turn.breakdown = breakdownOf(turn.req, run.density)
}

/**
 * 被拒的请求是否按「接口拒绝图片」处理：provider 以 400 / 422 拒绝、本次请求含图像块、本 run 尚未停止发送图片。
 *
 * 不按报错文字判断：各第三方接口的措辞不同。判断有误的代价是一次不带图片的重发；重发仍被拒时
 * `imagesRejected` 已为 true，按不可重发的错误结束本轮。模型声明不接受图片时（`vision === false`），
 * 图片已在物化时替换为说明，被拒与图片无关。
 *
 * 不要放宽为全部 `invalid_request`：413 同属该码，原因是请求体大小，移除图片后重发虽然成功，
 * 记录的「接口拒绝图片」却不成立，本会话会在该接口上停止发送图片。
 */
function rejectedForImages(run: RunState, turn: TurnState, pe: ProviderError): boolean {
  return (
    pe.code === 'invalid_request' &&
    (pe.status === 400 || pe.status === 422) &&
    !run.imagesRejected &&
    run.adapter.spec.vision !== false &&
    turn.req.messages.some(hasImage)
  )
}

function hasImage(m: WireMessage): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'image')
}

/**
 * ── 接口拒绝图片：移除图片后重发一次 ──
 *
 * 被拒的事实作为执行事实提供给模型，由模型决定下一步。本 run 随即停止发送图片，请求按同一装配重建，
 * 物化时图片替换为说明。
 *
 * 执行事实只追加到 transcript，重发被接口接受后才写入（`settleRejectionNotices`）：重发仍被拒说明原因不在图片，
 * 该事实不成立；写入后，其中的接口名与模型 id 是之后的 run 停止发送图片的判据（`RunInput.imagesRejected`）。
 *
 * 最后一条 assistant 之后的工具图片从未送达模型，写入时对应 step 一并标记为未送达，供界面显示；
 * 此前已送达的图片不标记。
 */
function removeImages(host: LoopHost, run: RunState, turn: TurnState, pe: ProviderError): void {
  const messages = turn.req.messages
  let lastAssistant = -1
  messages.forEach((m, i) => {
    if (m.role === 'assistant') lastAssistant = i
  })
  const toolCallIds = messages
    .slice(lastAssistant + 1)
    .flatMap((m) => (m.role === 'tool' && m.toolCallId && hasImage(m) ? [m.toolCallId] : []))

  run.imagesRejected = true
  const reason = (pe.message.split(NEWLINE)[0] ?? '').trim().replace(/[，。,.;；]+$/u, '')
  const text = `包含图片的请求被接口拒绝，接口返回 ${reason}。本会话此后发往该接口的请求不携带图片。`
  const seq = run.nextSeq()
  run.pushNotice(text, seq)
  run.pendingImagesNotice = { seq, text, toolCallIds }
  turn.req = host.buildRequest(run)
  turn.breakdown = breakdownOf(turn.req, run.density)
}

/**
 * 移除视频或图片后的重发已被接口接受：写入执行事实；图片另标记未送达的工具 step。
 * 视频按路径保留在执行记录中，不标记：之后的请求中它们被替换为指向 `read_file` 抽帧的说明。
 */
function* settleRejectionNotices(
  host: LoopHost,
  run: RunState,
): Generator<AgentEvent, void, unknown> {
  const { input, persist, adapter } = run
  const videos = run.pendingVideosNotice
  if (videos) {
    run.pendingVideosNotice = null
    persist.landUserStep(input.runId, videos.seq, {
      text: videos.text,
      notice: true,
      videosRejected: { provider: host.deps.providerName ?? '', model: adapter.spec.id },
    })
  }
  const pending = run.pendingImagesNotice
  if (!pending) return
  run.pendingImagesNotice = null
  persist.landUserStep(input.runId, pending.seq, {
    text: pending.text,
    notice: true,
    imagesRejected: { provider: host.deps.providerName ?? '', model: adapter.spec.id },
  })
  const stepIds = persist.markImagesUndelivered(input.runId, pending.toolCallIds)
  if (stepIds.length) {
    yield { type: 'tool.images_undelivered', runId: input.runId, stepIds: stepIds as StepId[] }
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
    // 非 2xx 不产生 `request_prepared` 之外的任何事件，收到其他事件即表示接口已接受本次请求。
    if (ev.type !== 'request_prepared') yield* settleRejectionNotices(host, run)
    if (ev.type !== 'request_prepared' && ev.type !== 'response_started') {
      probe.providerEvents++
      if (!probe.recordedFirstEvent) {
        probe.recordedFirstEvent = true
        persist.markRequestFirstEvent(turn.requestId)
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
        persist.markRequestContent(turn.requestId, ev.at, kind, visible)
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
        // 参数进度只提供给界面显示；空闲计时在传输层按字节计算，不依据事件。
        yield { type: 'tool.generating', runId: input.runId, at: ev.at }
        break
      case 'response_started':
        // 只作为传输遥测边界；不产生模型可见内容或 UI step。
        persist.markRequestHeaders(turn.requestId, ev.headersAt, ev.cloudRequestId ?? null)
        if (ev.hedge) persist.markRequestHedge(turn.requestId, ev.hedge)
        yield {
          type: 'run.request',
          runId: input.runId,
          requestId: turn.requestId,
          phase: 'headers',
          ...attemptOf(run, resends),
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
          turn.unusableNote = ev.refusal?.explanation ?? '模型出于安全策略拒绝了该请求'
        }
        break
      }
      default:
        break
    }
  }
}
