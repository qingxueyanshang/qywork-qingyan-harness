/**
 * Provider 错误归类。
 *
 * 归类的目的只有一个：让前端知道**该让用户做什么**。所以分类轴是「用户的下一步动作」
 * （去配 key / 去充值 / 等一会重试 / 换模型 / 缩上下文），不是 HTTP 状态码的镜像。
 *
 * ## 判据的优先级
 *
 * 1. **异常类与状态码**——最稳，优先用。
 * 2. **错误对象上的 `code`**（`ECONNRESET`、`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`…）
 *    ——次稳，跨版本基本不动。
 * 3. **文案匹配**——最后兜底，且**只在文案是唯一线索时**用。
 *
 * 这里原来写的是「一律用类型化异常判定，不做文案匹配」。那句话不实：429 分
 * 限速与欠费全靠文案，传输层错误也是。既然实际在匹配，就该把规矩写清楚
 * （优先级 + 兜底），而不是留一句自己都没遵守的原则——后者会让下一个人
 * 以为文案匹配是 bug 而不是刻意的兜底，然后把它删掉。
 */

import type { ErrorCode } from '@qywork/core'
import { type CapacityRejection, classifyCapacityRejection } from './capacity.ts'
import type { ProviderKind } from './catalog.ts'

export class ProviderError extends Error {
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly provider: ProviderKind
  readonly status: number | undefined
  readonly detail: Record<string, unknown> | undefined
  /**
   * 只有**被容量分类器证实**的上下文超限才带这个字段。
   *
   * 要区分「provider 亲口说超了」和「我们从消息里猜它超了」时判
   * `err.capacity !== undefined`——只看 `code === 'context_overflow'` 不够，
   * 那个码也可能来自别的路径。
   */
  readonly capacity: CapacityRejection | undefined

  constructor(opts: {
    code: ErrorCode
    message: string
    retryable: boolean
    provider: ProviderKind
    status?: number
    detail?: Record<string, unknown>
    capacity?: CapacityRejection
    cause?: unknown
  }) {
    super(opts.message, opts.cause !== undefined ? { cause: opts.cause } : undefined)
    this.name = 'ProviderError'
    this.code = opts.code
    this.retryable = opts.retryable
    this.provider = opts.provider
    this.status = opts.status
    this.detail = opts.detail
    this.capacity = opts.capacity
  }
}

/** 从异常对象上尽力取 HTTP 状态码，兼容各家 SDK 的字段名差异。 */
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

/** 判断是不是「根本没配 key」而不是「key 不对」——两者的引导文案完全不同。 */
function looksUnconfigured(err: unknown): boolean {
  const m = messageOf(err).toLowerCase()
  return m.includes('unset') || m.includes('missing') || m.includes('no api key')
}

export function classifyProviderError(provider: ProviderKind, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err

  const status = statusOf(err)
  const message = messageOf(err)

  const build = (code: ErrorCode, retryable: boolean, msg?: string) =>
    new ProviderError({
      code,
      message: msg ?? message,
      retryable,
      provider,
      ...(status !== undefined ? { status } : {}),
      cause: err,
    })

  // 中断不是错误：用户点了停止，不该报红也不该重试。
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError')) {
    return build('internal_error', false, '已取消')
  }

  // 上下文超限先于状态码分支判定：它跨 400/413/422 三个码，而且判据比状态码强得多
  // （provider 原生容量码 / 强消息匹配）。判定为真时**必须**带上 capacity——
  // 上层靠它决定要不要压缩重发，缺了这个字段压缩永远不会触发。
  const capacity = classifyCapacityRejection(err)
  if (capacity) {
    return new ProviderError({
      code: 'context_overflow',
      message: capacityMessage(capacity),
      retryable: false,
      provider,
      ...(status !== undefined ? { status } : {}),
      capacity,
      cause: err,
    })
  }

  switch (status) {
    case 401:
      return build(
        looksUnconfigured(err) ? 'no_api_key' : 'auth_failed',
        false,
        looksUnconfigured(err) ? '未配置 API Key' : 'API Key 无效',
      )
    case 403:
      return build('auth_failed', false, '当前 Key 无权访问该模型')
    case 404:
      return build('model_not_found', false, `模型不存在：检查模型 ID 与接口地址`)
    case 413:
      // 走到这里说明容量分类器已经否掉了它 —— 那就不是上下文超限，
      // 而是网关的请求体大小限制（nginx client_max_body_size 之类）。
      // 报成上下文超限会把用户引向「精简对话」，而真正该做的是缩小附件。
      return build('provider_unavailable', false, '请求体超出网关限制：检查附件大小或反代配置')
    case 429: {
      // 429 有两种：限速（等一下能好）和额度耗尽（等多久都不会好）。
      // 混为一谈会让用户对着一个永远不会成功的重试按钮反复点。
      const m = message.toLowerCase()
      const exhausted =
        m.includes('quota') ||
        m.includes('credit') ||
        m.includes('balance') ||
        m.includes('insufficient')
      return exhausted
        ? build('insufficient_quota', false, '账户额度不足')
        : build('rate_limited', true, '触发限速，稍后重试')
    }
    case 400:
    case 422:
      // 不要按「消息里含 context / too long / max_tokens」判上下文超限：
      // `max_tokens must be ≤ 8192` 是**输出**参数校验，判成上下文超限等于把一个
      // 参数错误报成「上下文满了」，用户照着这条查不下去。
      // 容量判定全部交给上面的分类器，这里只剩「确实是参数错了」。
      return build('provider_unavailable', false, message)
    case 500:
    case 502:
    case 503:
    case 529:
      return build('provider_unavailable', true, '服务端暂时不可用')
    default:
      break
  }

  const transport = classifyTransport(err, message)
  if (transport) return build('network_error', true, transport)

  return build('internal_error', false)
}

/**
 * 传输层失败：连不上、连上了又断、握手失败、超时。
 *
 * ## 为什么不能只匹配 `fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network`
 *
 * 那一版是照着 Node/undici 的文案写的，而**运行时是 Bun**，它自己的 fetch
 * 报的是另一套话。2026-08 在一台网络抖动的机器上对 DeepSeek 连打，三种真实失败
 * 一条都没匹配上：
 *
 * - `The operation timed out.`
 * - `The socket connection was closed unexpectedly.`
 * - `unknown certificate verification error`
 *
 * 三条全部落到最后的 `internal_error` + `retryable: false`。后果不是「报错文案难看」，
 * 是**一次网络抖动直接终结整轮 run**，而它本该重试一次就过去。
 *
 * 所以这里先看 `err.code`（Bun 与 Node 都挂在错误对象上，比文案稳），
 * 文案匹配只作兜底。
 *
 * ## 证书错误也算可重试
 *
 * 它有两种成因：握手撞上抖动（重试就好），和代理/自签名证书配错了（重试没用）。
 * 判成可重试的代价是多打几次白工，判成不可重试的代价是一次抖动打断用户的任务。
 * 后者贵得多，所以选前者——但文案要**同时点出**这两种可能，
 * 别让一个配错代理的人对着「网络不可达」查半天网。
 */
function classifyTransport(err: unknown, message: string): string | null {
  const code = String((err as { code?: unknown })?.code ?? '').toUpperCase()

  const tls =
    /CERT|SSL|TLS|SELF_SIGNED|LEAF_SIGNATURE/.test(code) ||
    /certificate|ssl|tls handshake/i.test(message)
  if (tls) return 'TLS 握手失败：可能是网络抖动，也可能是代理或自签名证书未被信任'

  // errno / 库自定义码。`code` 上是整串，文案里是夹在句子中间的一个词，
  // 所以锚定与不锚定要各写一条——用同一条会漏掉
  // `getaddrinfo ENOTFOUND api.x.com` 这种把 errno 拼进文案、不设 `code` 的库。
  const ERRNO =
    'ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN|ERR_SOCKET_CLOSED|ERR_NETWORK|UND_ERR_|CONNECTION'
  if (new RegExp(`^(${ERRNO})`).test(code)) return '网络不可达：检查接口地址与代理'
  if (new RegExp(`\\b(${ERRNO})`).test(message.toUpperCase())) {
    return '网络不可达：检查接口地址与代理'
  }

  // Bun 自己的几句人话。这几条是实测抄来的，不是猜的。
  if (
    /fetch failed|network|socket connection was closed|operation timed out|unable to connect|connection (closed|refused|reset)/i.test(
      message,
    )
  ) {
    return '网络中断或超时：连接在完成前断开'
  }

  return null
}

/**
 * 容量拒绝的用户文案。
 *
 * 有 provider 自报的数字就报数字——「用了 213000，上限 200000」比
 * 「上下文超出模型窗口」有用得多，用户能据此判断该删多少。
 * 没有数字时不编，也不拿本地估算冒充 provider 的口径。
 */
function capacityMessage(c: CapacityRejection): string {
  const { reportedInputTokens: used, reportedLimitTokens: limit } = c
  if (used !== null && limit !== null) {
    return `上下文超出模型窗口：${used.toLocaleString()} / ${limit.toLocaleString()} token`
  }
  if (limit !== null) return `上下文超出模型窗口（上限 ${limit.toLocaleString()} token）`
  return '上下文超出模型窗口'
}
