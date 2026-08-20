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
 * **文案匹配是刻意的兜底，不是 bug，别删。** 429 分限速与欠费全靠文案，
 * 传输层错误也是——这里没有别的线索可用。规矩写在上面那三档优先级里。
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
 * 传输层失败的四种形状。**顺序即优先级**：先认具体的，泛码（`CONNECTION`、
 * `UND_ERR_`）兜在最后一支。
 *
 * ## 为什么必须分开，而不是一句「网络中断或超时」
 *
 * 三种失败的下一步动作完全不同：**连不上**要去改接口地址或代理，**被断开**重发一次
 * 大概率就过去了，**超时**要先看是不是自己那 60 秒掐的。塞进同一句话等于三件事一起说，
 * 用户读完不知道该干什么——这正是「连接在完成前断开」看不懂的原因。
 *
 * **判据按语义分，不按 errno 表分。** `ECONNREFUSED` 是压根没连上，`ECONNRESET`
 * 是连上了被重置；两个码长得像，含义相反，落进同一支就等于没分类。
 *
 * ## 为什么不能只匹配 Node/undici 那串
 *
 * 运行时是 Bun，它自己的 fetch 报的是另一套话。2026-08 在一台网络抖动的机器上对
 * DeepSeek 连打，三种真实失败一条都匹配不上 Node 那套：`The operation timed out.` /
 * `The socket connection was closed unexpectedly.` / `unknown certificate verification error`。
 * 全部落进 `internal_error` + `retryable: false`——后果不是文案难看，
 * 是**一次抖动直接终结整轮 run**。
 *
 * 所以每一支都带两条正则：`code` 上是整串（锚定），文案里是夹在句子中间的一个词
 * （不锚定）。用同一条会漏掉 `getaddrinfo ENOTFOUND api.x.com` 这种把 errno 拼进
 * 文案、不设 `code` 的库。
 *
 * ## 证书错误也算可重试
 *
 * 它有两种成因：握手撞上抖动（重试就好），和代理/自签名证书配错了（重试没用）。
 * 判成可重试的代价是多打几次白工，判成不可重试的代价是一次抖动打断用户的任务。
 * 后者贵得多，所以选前者——但文案要**同时点出**这两种可能，
 * 别让一个配错代理的人对着「连不上」查半天网。
 */
const TRANSPORT_SHAPES: { code: RegExp; message: RegExp; text: string }[] = [
  {
    code: /CERT|SSL|TLS|SELF_SIGNED|LEAF_SIGNATURE/,
    message: /certificate|ssl|tls handshake/i,
    text: 'TLS 握手失败：可能是网络抖动，也可能是代理或自签名证书未被信任',
  },
  {
    code: /^(ECONNRESET|ECONNABORTED|EPIPE|ERR_SOCKET_CLOSED|UND_ERR_SOCKET|CONNECTION(CLOSED|RESET|ABORTED))/,
    message:
      /socket connection was closed|socket hang up|premature close|connection (closed|reset|aborted)|\b(ECONNRESET|ECONNABORTED|EPIPE)\b/i,
    text: '连接被断开',
  },
  {
    code: /^(ETIMEDOUT|ERR_TIMEOUT|TIMEOUT|CONNECTIONTIMEOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT)/,
    message: /timed out|timeout|\bETIMEDOUT\b/i,
    text: '请求超时',
  },
  {
    code: /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|ERR_NETWORK|UND_ERR_|CONNECTION)/,
    message:
      /fetch failed|unable to connect|connection (refused|error)|network|\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN)\b/i,
    text: '连不上接口：检查接口地址与代理',
  },
]

function classifyTransport(err: unknown, message: string): string | null {
  const code = String((err as { code?: unknown })?.code ?? '').toUpperCase()
  for (const shape of TRANSPORT_SHAPES) {
    if (shape.code.test(code) || shape.message.test(message)) return shape.text
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

/**
 * 工具调用少了名字。
 *
 * **不许静默丢弃。** 流式返回里工具名与参数分片到达，名字那一片没来时
 * （中转站丢片、或它把非流式响应硬转成 SSE），丢掉这条调用的表现是
 * 「模型说要调工具、我们当作它什么都没说」——run 记成正常完成、账本无痕，
 * 而这正是「说做了却没做」最难查的那种形状。
 *
 * 也不许留着空名往下走：那条调用会随 assistant 消息原样回传给端点，
 * 校验严格的端点对空名 400，于是一次可恢复的丢片变成整条会话余下轮次全部失败。
 *
 * 三条协议共用这一个出口，措辞只有一份。
 */
export function namelessToolCall(provider: ProviderKind, model: string): ProviderError {
  return new ProviderError({
    code: 'provider_unavailable',
    message: '返回里有一条没有名字的工具调用，无法执行——通常是流式分片丢失',
    retryable: true,
    provider,
    detail: { model },
  })
}
