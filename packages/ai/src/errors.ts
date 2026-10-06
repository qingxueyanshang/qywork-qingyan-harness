/**
 * Provider 错误归类。
 *
 * 归类的唯一目的是让前端知道**应引导用户执行什么操作**。因此分类依据是「用户的下一步动作」
 * （配置 key / 充值 / 稍后重试 / 更换模型 / 缩减上下文），而不是与 HTTP 状态码一一对应。
 *
 * **判据的优先级**：
 * 1. **异常类与状态码**：最可靠，优先使用。
 * 2. **错误对象上的 `code`**（`ECONNRESET`、`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`…）：
 *    次可靠，跨版本基本不变。
 * 3. **文案匹配**：最后的后备手段，**只在文案是唯一线索时**使用。
 *
 * **文案匹配是有意保留的后备手段，不是缺陷，不要删除。** 429 优先读取结构化错误码，
 * 没有错误码时仍需依据文案区分限速与欠费；传输层错误同样需要文案匹配作为后备。
 *
 * 两个入口：`classifyProviderError` 接收异常对象（HTTP 失败、SDK 抛出、传输层断流），
 * `classifyStreamError` 接收流内 `error` 事件中的结构化字段。流内错误没有 HTTP 状态码，
 * 不要为使用前一个入口而伪造状态码。
 */

import type {
  ErrorCode,
  ProviderFailureCause,
  ProviderKind,
  ProviderTransportReading,
} from '@qywork/core'
import { type CapacityRejection, classifyCapacityRejection } from './capacity.ts'
import type { ProviderUsage } from './types.ts'

export class ProviderError extends Error {
  readonly code: ErrorCode
  readonly provider: ProviderKind
  readonly status: number | undefined
  readonly detail: Record<string, unknown> | undefined
  /**
   * 只有**被容量分类器证实**的上下文超限才带这个字段。
   *
   * 需要区分「provider 明确报告超限」与「从消息中推断超限」时判定
   * `err.capacity !== undefined`。只判断 `code === 'context_overflow'` 不够，
   * 该码也可能来自其他路径。
   */
  readonly capacity: CapacityRejection | undefined
  /**
   * 失败前 provider 已报告的用量。
   *
   * 只有传输中断类错误会携带：流在 `finish_reason` 之前结束，但用量字段已经到达。
   * **缺少该字段不等于未计费**，只表示本地未收到用量；记账时区分两者，
   * 不要把 `undefined` 当作 0。
   */
  readonly usage: ProviderUsage | undefined
  /** Provider 要求的重试等待时间。null 表示响应没有给出有效等待值。 */
  readonly retryAfterMs: number | null
  /**
   * 这次失败是否由本地等待计时器判定为超时。
   *
   * 不能用「没有 HTTP 状态码」代替：断流、协议错误与本地超时都可能没有状态码，
   * 只有该值为真时，上层才能补充静默时长。
   */
  readonly timedOut: boolean
  /**
   * 失败时刻的传输层读数。由 `classifyProviderError` 在适配器出口处填写；
   * 请求发出之前的失败（参数、路径、本地拒绝）没有该读数，为 null。
   */
  transport: ProviderTransportReading | null = null

  constructor(opts: {
    code: ErrorCode
    message: string
    provider: ProviderKind
    status?: number
    detail?: Record<string, unknown>
    capacity?: CapacityRejection
    usage?: ProviderUsage
    retryAfterMs?: number
    timedOut?: boolean
    cause?: unknown
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ProviderError'
    this.code = opts.code
    this.provider = opts.provider
    this.status = opts.status
    this.detail = opts.detail
    this.capacity = opts.capacity
    this.usage = opts.usage
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.timedOut = opts.timedOut ?? false
  }
}

/** 尽可能从异常对象上取得 HTTP 状态码，兼容各 SDK 的字段名差异。 */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  for (const key of ['status', 'statusCode', 'code']) {
    const v = e[key]
    if (typeof v === 'number' && v >= 100 && v < 600) return v
  }
  const res = e.response as Record<string, unknown> | undefined
  if (res && typeof res.status === 'number') return res.status
  return undefined
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

/** SDK 与直连适配器都把响应头放在错误对象的 headers 字段。 */
function headerOf(err: unknown, name: string): string | null {
  if (typeof err !== 'object' || err === null) return null
  const headers = (err as Record<string, unknown>).headers
  if (typeof headers !== 'object' || headers === null) return null

  const get = (headers as { get?: unknown }).get
  if (typeof get === 'function') {
    const value = get.call(headers, name)
    return typeof value === 'string' ? value : null
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value
  }
  return null
}

function retryAfterOf(err: unknown, now = Date.now()): number | null {
  const milliseconds = headerOf(err, 'retry-after-ms')
  if (milliseconds !== null) {
    const parsed = Number(milliseconds)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }

  const value = headerOf(err, 'retry-after')
  if (value === null) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000

  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

function providerErrorField(err: unknown, key: string): string | null {
  const direct = stringField(err, key)
  if (direct) return direct
  if (typeof err !== 'object' || err === null) return null
  return stringField((err as Record<string, unknown>).error, key)
}

function quotaExhausted(err: unknown, message: string): boolean {
  const code = providerErrorField(err, 'code')?.toLowerCase() ?? ''
  const type = providerErrorField(err, 'type')?.toLowerCase() ?? ''
  if (
    /^(insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|quota_exceeded|insufficient_balance)$/.test(
      code,
    ) ||
    /^(insufficient_quota|billing_error)$/.test(type)
  ) {
    return true
  }

  return /exceeded your current quota|insufficient (?:quota|credit|balance)|credit balance|billing hard limit|not enough credits|额度不足|余额不足|余额耗尽|余额已用完|欠费|需要充值/i.test(
    message,
  )
}

/** 判断是「未配置 key」还是「key 错误」：两者的引导文案完全不同。 */
function looksUnconfigured(err: unknown): boolean {
  const m = messageOf(err).toLowerCase()
  return m.includes('unset') || m.includes('missing') || m.includes('no api key')
}

export function classifyProviderError(
  provider: ProviderKind,
  err: unknown,
  transport: ProviderTransportReading | null = null,
): ProviderError {
  const classified = classify(provider, err)
  if (transport) classified.transport = transport
  return classified
}

/**
 * 流内 `error` 事件的归类。三种协议的错误事件字段名一致（`type` / `code` / `message`
 * / `param`），由本入口统一处理。
 *
 * **输入是事件中的结构化字段，不是异常对象**：SSE 已返回 200，此时没有可读取的 HTTP 状态码，
 * 伪造状态码会使「provider 拒绝请求」与「连接建立后出错」在账本上无法区分。
 *
 * `message` 保留事件原文：分类码只表示错误类别，不包含 provider 的报错原文。
 * 事件不含文案时改用 `code` / `type`，不编造文案。
 */
export function classifyStreamError(
  provider: ProviderKind,
  event: Record<string, unknown>,
): ProviderError {
  const field = (key: string): string => {
    const value = event[key]
    return typeof value === 'string' ? value : ''
  }
  const code = field('code')
  const type = field('type')
  const param = field('param')
  const message = field('message').trim() || code || type || '模型服务返回错误事件'
  const reported = `${type} ${code}`.toLowerCase()
  const detail = {
    providerMessage: message,
    source: 'stream',
    ...(code ? { providerCode: code } : {}),
    ...(type ? { providerType: type } : {}),
    ...(param ? { providerParam: param } : {}),
  }
  const build = (errorCode: ErrorCode, msg?: string) =>
    new ProviderError({ code: errorCode, message: msg ?? message, provider, detail })

  if (quotaExhausted(event, message)) return build('insufficient_quota', '账户额度不足')
  if (/rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests/.test(reported)) {
    return build('rate_limited', '触发限速')
  }
  if (/authentication|unauthorized|invalid[\s_-]?api[\s_-]?key|permission|forbidden/.test(reported))
    return build('auth_failed', '当前凭证无权完成请求')
  if (/not[\s_-]?found/.test(reported)) {
    return build('model_not_found', '模型不存在：检查模型 ID 与接口地址')
  }
  if (/invalid[\s_-]?request|bad[\s_-]?request/.test(reported)) return build('invalid_request')
  // 明确的失败事件本身即表明 provider 暂不可用；没有结构化细分码时保留原文，
  // 并使其进入 `agent/loop/attempt.ts` 的重发表。
  return build('provider_unavailable')
}

/**
 * 沿 cause 链取回已归类的错误。只遍历四层，既覆盖 SDK 包装，又防止损坏对象成环。
 *
 * 传输层判定的断流是 `ProviderError`，而 SDK 在响应体流出错时会再包装一层
 * （Anthropic 的 `messages.stream` 经实测如此）。只检查最外层会把 `stream_idle_timeout`
 * 归为 `internal_error`，重发表因此无法识别该码。
 */
function carriedProviderError(err: unknown): ProviderError | null {
  let current: unknown = err
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth++) {
    if (current instanceof ProviderError) return current
    current = (current as { cause?: unknown }).cause
  }
  return null
}

function classify(provider: ProviderKind, err: unknown): ProviderError {
  const carried = carriedProviderError(err)
  if (carried) return carried

  const status = statusOf(err)
  const message = messageOf(err)
  const retryAfterMs = retryAfterOf(err)
  const providerCode = providerErrorField(err, 'code')
  const providerType = providerErrorField(err, 'type')
  const detail = {
    providerMessage: message,
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    ...(providerErrorField(err, 'param')
      ? { providerParam: providerErrorField(err, 'param') }
      : {}),
  }

  const build = (code: ErrorCode, msg?: string, timedOut = false) =>
    new ProviderError({
      code,
      message: msg ?? message,
      provider,
      ...(status !== undefined ? { status } : {}),
      detail,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      cause: err,
    })

  // 中断不是错误：用户点击了停止，不应显示错误，也不应重试。
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError')) {
    return build('internal_error', '已取消')
  }

  // 上下文超限先于状态码分支判定：它涉及 400/413/422 三个状态码，且判据比状态码可靠得多
  // （provider 原生容量码 / 强消息匹配）。判定为真时**必须**携带 capacity：
  // 上层依据它决定是否压缩重发，缺少该字段时压缩永远不会触发。
  const capacity = classifyCapacityRejection(err)
  if (capacity) {
    return new ProviderError({
      code: 'context_overflow',
      message: capacityMessage(capacity),
      provider,
      ...(status !== undefined ? { status } : {}),
      capacity,
      detail,
      cause: err,
    })
  }

  switch (status) {
    case 401:
      return build(
        looksUnconfigured(err) ? 'no_api_key' : 'auth_failed',
        looksUnconfigured(err) ? '未配置 API Key' : 'API Key 无效',
      )
    // 402 Payment Required 不依据正文判定：余额不足时正文中的 `code` 可能是 `invalid_request_error`。
    case 402:
      return build('insufficient_quota', '账户额度不足')
    // 403 也分两种：无权访问（更换 key 或模型可解决）与余额耗尽（中转站以 403 + `billing_error`
    // 报告），后者报告为无权访问会引导用户检查 key 与模型权限。
    case 403:
      return quotaExhausted(err, message)
        ? build('insufficient_quota', '账户额度不足')
        : build('auth_failed', '当前 Key 无权访问该模型')
    case 404:
      return build('model_not_found', `模型不存在：检查模型 ID 与接口地址`)
    case 413:
      // 到达此处说明容量分类器已排除上下文超限，
      // 原因是网关的请求体大小限制（如 nginx 的 client_max_body_size）。
      // 报告为上下文超限会引导用户精简对话，而实际应缩小附件。
      return build('invalid_request', '请求体超出网关限制：检查附件大小或反向代理配置')
    case 429: {
      // 429 分两种：限速（等待后可恢复）与额度耗尽（无论等待多久都不会恢复）。
      // 混为一谈会使用户对不会成功的请求反复重发。
      return quotaExhausted(err, message)
        ? build('insufficient_quota', '账户额度不足')
        : build('rate_limited', '触发限速')
    }
    case 400:
    case 422:
      /*
       * 不要按「消息中含 context / too long / max_tokens」判定上下文超限：
       * `max_tokens must be ≤ 8192` 是**输出**参数校验，判定为上下文超限会把
       * 参数错误报告为上下文已满，用户无法据此定位问题。
       * 容量判定全部交给上方的分类器，此处只处理确属参数错误的情况。
       *
       * **默认归入不可重发的类别。** 4xx 表示该请求被拒绝，相同字节再发送
       * 一次仍会被同样拒绝：不接受图片的模型收到图像块、`max_tokens` 越界，
       * 每次都会触发。归为可重发的码时界面显示「正在重连 N / M」，
       * 该提示无法指出真正的原因。
       */
      return build(
        looksRetryableRejection(status, message) ? 'provider_unavailable' : 'invalid_request',
        message,
      )
    case 500:
    case 502:
    case 503:
    case 529:
      return build('provider_unavailable', '服务端暂时不可用')
    default:
      break
  }

  const transport = classifyTransport(err)
  if (transport) return build('network_error', transport.text, transport.timedOut)

  return build('internal_error')
}

/**
 * 400 / 422 中少数「原样重发可能恢复」的拒绝。
 *
 * 中转站将后端的 5xx 转为 400 是常见做法，仅凭状态码无法区分，文案是唯一线索
 * （判据优先级见文件头第 3 项）。命中的归为可重发的码，其余按 4xx 的本义处理。
 *
 * `Request contains an invalid argument.` 是另一种中转站通用拒绝：没有参数名、字段位置
 * 或任何可供用户修正的细节。两段实际失败的历史按完全相同的装配结果重放后均被同一中转站
 * 接受，说明该文案在此并不稳定地代表真正的参数错误。只精确匹配 400 的整句文案，不把任何
 * 带具体参数信息的 4xx 放入重发表。
 *
 * 词表只收录实际出现过的措辞，**宁可漏判**：漏判的代价是一次上游波动需要用户手动重发，
 * 误判的代价是对不会成功的请求空等五轮退避，并支付五次长 prompt 的费用。
 */
function looksRetryableRejection(status: number, message: string): boolean {
  const normalized = message.trim()
  if (status === 400 && /^request contains an invalid argument\.?$/i.test(normalized)) return true
  /*
   * 聚合中转站会把所选上游渠道返回的 403 包装为 400 / 422。它与配置端点
   * 直接返回 403 不同：前者在下一次请求时可能切换到可用渠道，后者才是当前 Key
   * 对该端点的稳定权限拒绝。只收录实际出现过的整句文案，不能放行所有普通 403。
   */
  if (
    (status === 400 || status === 422) &&
    /^upstream returned http 403 forbidden\.?$/i.test(normalized)
  ) {
    return true
  }
  return /暂不可用|暂时不可用|稍后(?:再试|重试)|服务(?:繁忙|不可用)|系统繁忙|上游(?:负载|不可用)|无可用渠道|temporarily unavailable|service unavailable|try again later|overloaded|server is busy|no available channel/i.test(
    normalized,
  )
}

/**
 * 传输层失败的四种形状。**顺序即优先级**：先匹配具体形状，泛化码（`CONNECTION`、
 * `UND_ERR_`）放在最后一个分支。
 *
 * **必须区分，不能合并为「网络中断或超时」。** 三种失败的下一步动作完全不同：**无法连接**需要修改
 * 接口地址或代理，**连接被断开**重发一次大概率可恢复，**超时**需要先确认是否由本地 60 秒超时触发。合并为同一
 * 句文案等于同时陈述三件事，用户无法判断应执行的操作。
 *
 * **判据按语义划分，不按 errno 表划分。** `ECONNREFUSED` 表示未建立连接，`ECONNRESET`
 * 表示建立连接后被重置；两个码形式相近、含义相反，归入同一分支等于未分类。
 *
 * **不能只匹配 Node/undici 的文案。** 运行时是 Bun，其 fetch 的错误文案不同。2026-08 在一
 * 台网络不稳定的机器上连续请求 DeepSeek，三种真实失败均无法匹配 Node 的文案：
 * `The operation timed out.` / `The socket connection was closed unexpectedly.` /
 * `unknown certificate verification error`。它们全部归入 `internal_error`，而该码不在 `agent/loop/attempt.ts` 的重发表
 * 中，后果是**一次网络波动直接终止整轮 run**。
 *
 * 因此每个分支都有两条正则：匹配 `code` 的是整串（锚定），匹配文案的是句中的一个词
 * （不锚定）。共用同一条正则会遗漏 `getaddrinfo ENOTFOUND api.x.com` 这类把 errno 拼入
 * 文案、不设置 `code` 的库。
 *
 * **证书错误同样判定为可重试。** 它有两种成因：握手时遇到网络波动（重试可恢复），以及代理或自签名证书配置错误
 * （重试无效）。判定为可重试的代价是多发几次无效请求，判定为不可重试的代价是一次网络波动中断用户的任务。
 * 后者代价高得多，因此选择前者；但文案必须**同时指出**这两种可能，以免代理配置错误的用户依据「无法连接」
 * 长时间排查网络。
 */
const TRANSPORT_SHAPES: {
  code: RegExp
  message: RegExp
  text: string
  timedOut: boolean
}[] = [
  {
    code: /CERT|SSL|TLS|SELF_SIGNED|LEAF_SIGNATURE/,
    message: /certificate|ssl|tls handshake/i,
    text: 'TLS 握手失败：可能是网络不稳定，也可能是代理或自签名证书未被信任',
    timedOut: false,
  },
  {
    code: /^(ECONNRESET|ECONNABORTED|EPIPE|ERR_SOCKET_CLOSED|UND_ERR_SOCKET|CONNECTION(CLOSED|RESET|ABORTED))/,
    message:
      /socket connection was closed|socket hang up|premature close|http\/2 stream failed|connection (closed|reset|aborted)|\b(ECONNRESET|ECONNABORTED|EPIPE)\b/i,
    text: '连接被断开',
    timedOut: false,
  },
  {
    code: /^(ETIMEDOUT|ERR_TIMEOUT|TIMEOUT|CONNECTIONTIMEOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT)/,
    message: /timed out|timeout|\bETIMEDOUT\b/i,
    text: '请求超时',
    timedOut: true,
  },
  {
    code: /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|ERR_NETWORK|UND_ERR_|CONNECTION)/,
    message:
      /fetch failed|unable to connect|connection (refused|error)|network|\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN)\b/i,
    text: '无法连接接口：检查接口地址与代理',
    timedOut: false,
  },
]

function classifyTransport(err: unknown): { text: string; timedOut: boolean } | null {
  // SDK 的 Connection error. 把具体 errno 放在 cause 中。复用有界、去环的原因链，
  // 按从具体到泛化的既有顺序检查整条链，避免包装层先命中「无法连接」而掩盖证书或断流原因。
  const causes = failureCauseChain(err)
  for (const shape of TRANSPORT_SHAPES) {
    if (
      causes.some(
        (cause) =>
          shape.code.test((cause.code ?? '').toUpperCase()) || shape.message.test(cause.message),
      )
    ) {
      return { text: shape.text, timedOut: shape.timedOut }
    }
  }
  return null
}

/**
 * 容量拒绝的用户文案。
 *
 * 有 provider 报告的数值时显示数值：「已用 213000，上限 200000」比
 * 「上下文超出模型窗口」有用得多，用户可据此判断需要删减多少。
 * 没有数值时不编造，也不以本地估算代替 provider 报告的数值。
 */
function capacityMessage(c: CapacityRejection): string {
  const { reportedInputTokens: used, reportedLimitTokens: limit } = c
  if (used !== null && limit !== null) {
    return `上下文超出模型窗口：${used.toLocaleString()} / ${limit.toLocaleString()} token`
  }
  if (limit !== null) return `上下文超出模型窗口（上限 ${limit.toLocaleString()} token）`
  return '上下文超出模型窗口'
}

/**
 * 工具调用缺少名称。
 *
 * **不得静默丢弃。** 流式响应中工具名与参数分片到达，名称分片缺失时
 * （中转站丢失分片，或将非流式响应强行转换为 SSE），丢弃该调用会使
 * 模型请求的工具调用被本地忽略：run 记为正常完成，账本中没有任何记录，
 * 这是「声称已执行而实际未执行」中最难排查的一种。
 *
 * 也不得保留空名继续执行：该调用会随 assistant 消息原样回传给端点，
 * 校验严格的端点对空名返回 400，一次可恢复的分片丢失因此变成会话后续轮次全部失败。
 *
 * 三种协议共用此出口，文案只有一份。
 */
export function namelessToolCall(provider: ProviderKind, model: string): ProviderError {
  return new ProviderError({
    code: 'provider_unavailable',
    message: '响应中有一个工具调用缺少名称，无法执行；通常由流式分片丢失导致',
    provider,
    detail: { model },
  })
}

/**
 * 保留从归类错误到最底层 cause 的短链。只取四层，既覆盖 SDK 包装，又防止损坏对象成环。
 * 原文在 runtime 持久化边界按配置的凭证与常见 key 格式脱敏。
 */
export function failureCauseChain(error: unknown): ProviderFailureCause[] {
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

/** 两种请求共用的失败证据；传输统计与接口原生错误码各自保留，不互相推测。 */
export function failureDiagnostics(error: unknown) {
  const pe = error instanceof ProviderError ? error : null
  const field = (key: string) =>
    typeof pe?.detail?.[key] === 'string' ? (pe.detail[key] as string) : null
  return {
    causes: failureCauseChain(error),
    transport: pe?.transport ?? null,
    provider: {
      status: pe?.status ?? null,
      code: field('providerCode'),
      type: field('providerType'),
      param: field('providerParam'),
    },
  }
}

export function providerErrorMessage(error: unknown): string | null {
  return error instanceof ProviderError &&
    (error.status !== undefined || error.detail?.source === 'stream') &&
    typeof error.detail?.providerMessage === 'string'
    ? error.detail.providerMessage
    : null
}
