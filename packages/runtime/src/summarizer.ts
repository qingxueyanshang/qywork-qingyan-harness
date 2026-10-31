/**
 * 摘要生成器：使用会话当前的 provider 档案，独立于主循环发送一次请求。
 *
 * 自动触发与手动 `/compact` 共用此实现。两份装配会逐渐偏离，且偏离难以
 * 发现：两条路径都能产出摘要，无法看出口径已经不同。
 */

import {
  concurrencyRejected,
  type SendOutcome,
  type Summarizer,
  sendLane,
  sendLimiter,
} from '@qywork/agent'
import {
  buildAdapter,
  type ChatRequest,
  failureDiagnostics,
  ProviderError,
  type ProviderProfile,
  type ProviderUsage,
  providerContentKind,
  STREAM_IDLE_TIMEOUT_MS,
} from '@qywork/ai'
import type { EffortLevel } from '@qywork/core'

export interface SummarizerOptions {
  /** 每次发起摘要时调用。轮次内的自动压缩返回本轮开始时的规格；手动压缩在发起时解析。 */
  profile: () => ProviderProfile
  /** 用户为当前「接口 × 模型」选择的思考档位；undefined 表示省略该字段，沿用模型默认值。 */
  effort?: () => EffortLevel | undefined
  /** 调用方的中断信号。未传入时只受流空闲判定约束。 */
  signal?: AbortSignal
}

/**
 * 有意不带工具与冻结前缀：摘要任务只需输入文本、输出文本，附带工具 schema
 * 会使本次调用同样逼近容量上限，而该调用正是在容量已超出时发出的。
 *
 * 思考档位遵循用户选择：用户已选择时原样继承，未选择时省略该字段、沿用模型默认值。
 * 摘要任务不得为提速而在后台降低用户选择的档位，也不得发送关闭思考的参数。
 *
 * 空闲上限交给传输层按字节判定（`idleTimeoutMs`，与主请求使用同一基准），此处不另设计时。
 * 不要改为总时长上限：持续输出的慢速摘要并非无响应，中止它等于作废一次已经计费的
 * 正常调用。
 *
 * 发出前取得与主请求同一个在途名额（`sendLimiter`）：中转的并发按请求方计算，
 * 绕过名额的请求在中转饱和时不排队，收到的并发拒绝也不会收紧上限。
 *
 * 预算单位是 token，直接作为 `max_tokens` 申报。以 `max_tokens` 结束的调用返回
 * null：不完整的摘要比没有摘要更有害，因为它看起来是完整的。
 */
export function makeSummarizer(opts: SummarizerOptions): Summarizer {
  return async (prompt, budgetTokens, trace) => {
    const profile = opts.profile()
    const adapter = buildAdapter(profile)
    const selectedEffort = opts.effort?.()
    const effort =
      selectedEffort && adapter.spec.effortLevels.includes(selectedEffort)
        ? selectedEffort
        : undefined
    const willThink = effort !== undefined || adapter.spec.thinksByDefault

    let text = ''
    /** 摘要被输出上限截断。截断的摘要一律不采用：不完整的摘要看起来是完整的。 */
    let truncated = false
    let finish: string | undefined
    // 自动与手动摘要的请求和花费都由 trace 写回所属轮次。
    let usage: ProviderUsage | null = null
    const req: ChatRequest = {
      model: adapter.spec.id,
      system: [{ text: '你是会话摘要器。只输出摘要正文。' }],
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      /*
       * 会思考的模型不能以正文预算作为 `max_tokens`。
       *
       * 思考与正文共用同一上限，而思考不进入投影；限制为正文预算时，
       * 模型在思考阶段即耗尽额度，正文未写完即被截断，整份作废
       * （实测 deepseek-v4-flash：一句话摘要消耗 259 个思考 token，
       * 正文只有 10 个字）。结果是摘要段始终失败，压缩退化为只有收纳段。
       *
       * 正文长度由提示词中的字数要求约束，此处只保证模型有足够的输出空间。
       * 不思考的模型的正文即全部输出，直接申报预算即可。
       */
      maxOutputTokens: willThink
        ? adapter.spec.maxOutputTokens
        : Math.min(adapter.spec.maxOutputTokens ?? budgetTokens, budgetTokens),
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      ...(effort ? { effort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
    if (!trace) throw new Error('摘要请求缺少会话记账上下文')
    const requestId = trace.open(req, adapter)
    let sawEvent = false
    let providerEvents = 0
    let lastEventAt = Date.now()
    // 在账本行写入之后、发出之前取得名额，排队时间不计入发出时刻。规则与主请求相同（`attempt.ts`）。
    let release: ((outcome: SendOutcome) => void) | null = null
    try {
      const granted = await sendLimiter.acquire(
        sendLane(adapter),
        opts.signal ?? new AbortController().signal,
      )
      release = granted
      trace.sent(requestId)
      for await (const ev of adapter.stream(req)) {
        if (ev.type !== 'request_prepared' && ev.type !== 'response_started') {
          providerEvents++
          lastEventAt = Date.now()
        }
        if (!sawEvent && ev.type !== 'request_prepared' && ev.type !== 'response_started') {
          sawEvent = true
          trace.firstEvent(requestId)
        }
        if (ev.type === 'response_started') {
          trace.headers(requestId, ev.headersAt)
          if (ev.hedge) trace.hedge(requestId, ev.hedge)
        }
        const kind = providerContentKind(ev)
        if (kind !== null && 'at' in ev) trace.content(requestId, ev.at, kind)
        if (ev.type === 'text_delta') text += ev.delta
        else if (ev.type === 'done') {
          truncated = ev.stopReason === 'max_tokens'
          finish = ev.rawStopReason
        } else if (ev.type === 'usage') {
          usage = ev.usage
        }
      }
      granted('completed')
    } catch (err) {
      release?.(concurrencyRejected(err) ? 'concurrency_rejected' : 'failed')
      const pe = err instanceof ProviderError ? err : null
      // 非 2xx 响应的响应头不经过 `response_started`，其时刻只记录在传输读数中。规则与主请求相同。
      if (pe?.transport?.headersAt != null) trace.headers(requestId, pe.transport.headersAt)
      if (pe?.transport?.hedge) trace.hedge(requestId, pe.transport.hedge)
      // 与主请求使用同一套终态：被拒绝为 rejected，其余情况（流被截断、中断、连接断开）均为 uncertain。
      trace.settle(
        requestId,
        pe?.rejected ? 'rejected' : 'uncertain',
        pe?.usage ?? usage,
        opts.signal?.aborted ? null : (pe?.code ?? 'internal_error'),
        finish,
        opts.signal?.aborted ? null : err instanceof Error ? err.message : String(err),
      )
      trace.diagnostic(requestId, {
        ...failureDiagnostics(err),
        providerEvents,
        silentMs: Math.max(0, Date.now() - lastEventAt),
        assistantChars: text.length,
        toolCallCount: 0,
        retry: {
          decision: opts.signal?.aborted ? 'interrupted' : 'not_retryable',
          attempt: null,
          max: 0,
          backoffMs: null,
          at: null,
        },
      })
      throw err
    }

    trace.settle(requestId, 'received', usage, null, finish)
    // 截断作废与空摘要使用同一终态：调用方据此判定摘要段未生成，收纳段照常写入数据库。
    return truncated ? null : text.trim() || null
  }
}
