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
 *
 * **分类码与报错正文分开。** 分类码决定重发与界面判定；正文是对端说明的原因：带 HTTP 状态的失败写成
 * 「HTTP 状态码 名称：对端原文」，流内错误事件写原文。不要按分类码改写正文：分类文案只说明类别，
 * 会把一次具体的拒绝表述为另一种原因（Key 所属分组已删除会被写成「无权访问该模型」）。
 * 传输层失败与容量拒绝没有可用的对端原文，正文是本地的分类说明。
 */

import type {
  ChannelVendor,
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
   * 对端是否明确报告了这次失败：带 HTTP 状态的响应，或 200 之后的流内错误事件。
   *
   * 请求行据此记为「被拒绝」，否则记为「结果不明」。不要改为只判断 `status`：
   * 流内错误事件没有状态码，中转站以这种方式报告并发超限等拒绝，只判断状态码会把对端的明确答复记为结果不明。
   */
  readonly rejected: boolean
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
    /** 未提供时按是否带 HTTP 状态判定。 */
    rejected?: boolean
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
    this.rejected = opts.rejected ?? opts.status !== undefined
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

/** HTTP 状态码的通用名称（RFC 9110；429 见 RFC 6585），列在服务商原文之前，原文不翻译。 */
const STATUS_NAMES: Record<number, string> = {
  400: '请求无效',
  401: '未授权',
  402: '需要付费',
  403: '禁止访问',
  404: '未找到',
  408: '请求超时',
  413: '请求内容过大',
  422: '无法处理的内容',
  429: '请求过多',
  500: '服务器内部错误',
  502: '网关错误',
  503: '服务不可用',
  504: '网关超时',
}

export function httpStatusName(status: number): string {
  return STATUS_NAMES[status] ?? (status >= 500 ? '服务器错误' : '请求被拒绝')
}

/**
 * 错误正文中的说明：JSON 取 `error.message`、顶层 `message` 或字符串形式的 `error`（只含一个元素的数组按该元素，见 `singleElement`）；
 * HTML 错误页取 `<title>`，没有标题时取去除标签后的文字；其余取正文原文。生成一侧（`media/http.ts`）共用本函数。
 * 不要对 HTML 返回原文：网关与 CDN 以 HTML 页面报告 502 等失败，下游只显示首行，页面源码的首行是 `<html>`。
 */
export function bodyMessage(body: string): string | null {
  const text = body.trim()
  if (!text) return null
  if (/^<(?:!doctype|html|head|body)\b/i.test(text)) return htmlMessage(text)
  let json: unknown
  try {
    json = singleElement(JSON.parse(text))
  } catch {
    return text
  }
  const nested =
    typeof json === 'object' && json !== null ? (json as { error?: unknown }).error : null
  return (
    stringField(nested, 'message')?.trim() ||
    stringField(json, 'message')?.trim() ||
    (typeof nested === 'string' ? nested.trim() : '') ||
    text
  )
}

function htmlMessage(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const source = title ?? html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
  return (
    source
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null
  )
}

/**
 * 服务商的报错原文。
 *
 * 优先取传输层读取的错误正文：OpenAI SDK 只从正文的 `error` 字段取说明，正文是顶层 `{code, message}`
 * 时报为「400 status code (no body)」，原文随之丢失。没有正文时取错误对象的消息并去掉开头的状态码：
 * 两个 SDK 的 `APIError.message` 都是「状态码 + 空格 + 说明」，状态码另由 `status` 表达。
 * 消息同样按正文解析：直连适配器以未解析的 HTML 错误页作为消息。
 */
function providerText(err: unknown, status: number | undefined, errorBody: string | null): string {
  const fromBody = errorBody === null ? null : bodyMessage(errorBody)
  if (fromBody) return fromBody
  const message = messageOf(err)
  const prefix = status === undefined ? null : `${status} `
  const text = prefix && message.startsWith(prefix) ? message.slice(prefix.length) : message
  return bodyMessage(text) ?? text
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

export function retryAfterOf(err: unknown, now = Date.now()): number | null {
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

/**
 * 原文是否说明账户额度、余额或配额用尽：等待后重试不会成功，须由用户处理。对话请求对 400 / 403 / 422 / 429 据此报告
 * `insufficient_quota`（`httpFailureCode`），生成请求对全部错误状态与上游报告的任务失败据此判定（`media/http.ts`、`media/task.ts`）。
 * 正文带已收录的错误码时以错误码为准（`upstreamFailureCode`，先于本函数）：百炼以与 OpenAI 额度用尽相同的原文
 * （`You exceeded your current quota`）报告 TPM 限流，只有错误码能区分。
 *
 * `outstanding balance`：Gemini API 以 403 `PERMISSION_DENIED` 报告账单未结清；
 * `reached your specified … API usage limits`：Anthropic 以 400 报告达到用户自设的支出上限。
 */
export function quotaExhausted(message: string): boolean {
  return /exceeded your current quota|insufficient (?:quota|credit|balance)|credit balance|billing hard limit|not enough credits|free allocated quota exceeded|voice-clone voice limit exceeded|bill is overdue|budget configured in budget management has been exhausted|account is in good standing|outstanding balance|reached your specified (?:workspace )?api usage limits|额度不足|余额不足|余额耗尽|余额已用完|欠费|需要充值/i.test(
    message,
  )
}

/** 按错误码得到的失败码。 */
type CodeVerdict = Extract<ErrorCode, 'rate_limited' | 'insufficient_quota' | 'auth_failed'>

/** 一个错误码的判定：失败码，或该错误码对应多种原因时按原文依次匹配的规则，都不匹配时不按错误码归类。 */
type CodeRule = CodeVerdict | readonly (readonly [RegExp, CodeVerdict])[]

type Codes = Readonly<Record<string, CodeRule>>

/**
 * 百炼 `Throttling.AllocationQuota`（兼容接口写作 `insufficient_quota`）：错误码文档中同一错误码对应 TPS / TPM 限流、
 * Batch 限流、免费额度耗尽与音色数量上限四种原因，按原文区分；音色数量上限不按错误码归类。
 */
const ALLOCATION_QUOTA: CodeRule = [
  [/free allocated quota exceeded/i, 'insufficient_quota'],
  [
    /allocated quota exceeded|exceeded your current quota|batch requests are being throttled/i,
    'rate_limited',
  ],
]

/**
 * Gemini API 以 429 `RESOURCE_EXHAUSTED` 报告超过速率限制（按指数退避重试），也以同一错误码报告预付费额度用尽
 * （`Your prepayment credits are depleted`，Gemini API 开发者论坛中的实际答复），按原文区分。
 */
const RESOURCE_EXHAUSTED: CodeRule = [
  [/prepayment credits are depleted/i, 'insufficient_quota'],
  [/^/, 'rate_limited'],
]

/**
 * 上游错误码表，对话（`classify`、`classifyStreamError`）与生成（`media/http.ts`）共用唯一的一份。
 * 只收录官方错误码文档写明为限流、并发超限、余额或额度用尽、鉴权失败，且只靠状态码与原文（`quotaExhausted`）无法正确归类的错误码；
 * 注释为文档给出的含义。文档没有写明的错误码不收录，按状态码与原文处理。键不区分大小写。
 * - `any`：取值本身写明含义、各上游没有不同用法的错误码，对全部请求生效，包括经中转站转发、上游按接口地址未收录（渠道商为 null）的请求。
 * - 渠道商分区（`channelVendorOf` 的渠道商）：只在该上游内有含义的错误码（数字业务码：MiniMax 的 1002 是限流，可灵的 1002 是鉴权失败），
 *   以及该上游另有用法或取值是通用词的错误码（百炼的 `insufficient_quota` 是限流，与 OpenAI 的取值与原文都相同）。
 *   只在请求发往该上游时生效，先于 `any` 判定。经中转站转发时这些错误码不按原厂的表归类：取值本身不能说明来源。
 */
const UPSTREAM_CODES: Readonly<{ any: Codes } & Partial<Record<ChannelVendor, Codes>>> = {
  any: {
    // OpenAI 错误码指南。计费类错误的 `error.type` 为 `insufficient_quota`，`error.code` 区分具体原因。
    insufficient_quota: 'insufficient_quota',
    credit_balance_exhausted: 'insufficient_quota', // Your organization has no prepaid credits remaining.
    organization_spend_limit_exceeded: 'insufficient_quota', // Your organization reached its enforced spend limit.
    project_spend_limit_exceeded: 'insufficient_quota', // Your project reached its enforced spend limit.
    organization_usage_limit_exceeded: 'insufficient_quota', // Your organization reached its OpenAI-assigned usage limit.
    billing_hard_limit_reached: 'insufficient_quota', // 达到账单硬上限
    insufficient_balance: 'insufficient_quota', // 余额不足
    // Anthropic：402 `billing_error` 为账单或付款信息有误；429 `rate_limit_error` 的 `error.details.error_code`
    // 为 `enforced_spend_limit_reached` 时是达到用量档位的月度支出上限，不是限流。
    billing_error: 'insufficient_quota',
    enforced_spend_limit_reached: 'insufficient_quota',
    // Gemini API（Interactions）：429 You have exceeded your daily quota.
    quota_exceeded: 'insufficient_quota',
    // 阿里云百炼。
    Arrearage: 'insufficient_quota', // API Key 所属的阿里云账号存在欠费
    'isv.OUT_OF_SERVICE': 'insufficient_quota', // 阿里云账户余额不足，导致服务被暂停
    'AllocationQuota.FreeTierOnly': 'insufficient_quota', // 免费额度用尽，且开启了免费额度用完即停
    BudgetLimitExceeded: 'insufficient_quota', // 预算管理中设置的预算额度已用尽
    PrepaidBillOverdue: 'insufficient_quota', // 业务空间预付费账单到期
    PostpaidBillOverdue: 'insufficient_quota', // The postpaid bill is overdue.
    CommodityNotPurchased: 'insufficient_quota', // 业务空间未订购
    // 火山方舟。
    AccountOverdueError: 'insufficient_quota', // 403：当前账号欠费（余额<0）
    'OperationDenied.ServiceOverdue': 'insufficient_quota', // 403：账单已逾期
    'QuotaExceeded.AgentPlanQuotaExceeded': 'insufficient_quota', // 429：Agent Plan 套餐的 AFP 已耗尽
    'QuotaExceeded.DoubaoSearchFreeQuotaExceeded': 'insufficient_quota', // 403：豆包搜索的免费额度已耗尽
    AccountQuotaExceeded: 'insufficient_quota', // 429：账户额度不足
    SetLimitExceeded: 'insufficient_quota', // 429：已达到设置的模型或接入点用量上限值，服务已暂停
    // 月之暗面：429 账户欠费或已停用；账户 token 额度不足。
    exceeded_current_quota_error: 'insufficient_quota',
    // 阶跃星辰：429，与速率限制同一状态码。
    project_credit_limit_exceeded: 'insufficient_quota', // 项目达到当期 Credit 上限
    member_project_credit_limit_exceeded: 'insufficient_quota', // 成员在该项目内达到当期 Credit 上限
    // 阿里云百炼（原生接口为顶层 `code`，兼容接口为 `error.code`）。`Throttling` 在阿里云与 AWS 的接口中同为调用频率超限。
    Throttling: 'rate_limited', // 接口调用触发限流
    'Throttling.RateQuota': 'rate_limited', // 调用频率（RPS/RPM）触发限流
    'Throttling.BurstRate': 'rate_limited', // 调用频率骤增，触发系统稳定性保护机制
    'Throttling.Concurrency': 'rate_limited', // 当前并发请求数超出平台动态分配的上限
    'Throttling.ServiceOverloaded': 'rate_limited', // 网络资源目前处于过载状态
    'Throttling.ResourceExhausted': 'rate_limited', // 网络资源目前处于饱和状态
    'Throttling.AllocationQuota': ALLOCATION_QUOTA,
    // Gemini API（`error.status`；Interactions 为 `error.code`）。`RESOURCE_EXHAUSTED` 是 gRPC 的通用状态名，
    // Google 的接口都用于配额与速率限制；`rate_limit_exceeded` 在 OpenAI 的接口中同为速率限制。
    RESOURCE_EXHAUSTED,
    rate_limit_exceeded: 'rate_limited', // 429：超过每分钟或每秒的请求数或 token 数限制
    too_many_requests: 'rate_limited', // 429：短时间内请求过多
  },
  // 阿里云百炼的兼容接口以 `insufficient_quota` 报告限流（见 `ALLOCATION_QUOTA`）。
  alibaba: {
    insufficient_quota: ALLOCATION_QUOTA,
  },
  // 火山方舟（`error.code`）。`QuotaExceeded` 一个错误码对应三种原因，按原文区分；火山引擎的其他服务（知识库）以它报告数据集配额，
  // `QuotaExceeded` 与 `InvalidSubscription` 都是通用词，不放入 `any`。
  volcengine: {
    InvalidSubscription: 'insufficient_quota', // 403：Coding Plan 套餐未订阅或已过期
    QuotaExceeded: [
      [/free trial quota/i, 'insufficient_quota'], // 对该模型的免费试用额度已消耗完毕
      [/usage quota/i, 'insufficient_quota'], // 使用的额度超出 5 小时 / 周 / 月限额
      [/exceeded the quota/i, 'rate_limited'], // 处于排队中状态的任务数已超过限制，请稍后重试
    ],
  },
  // 可灵开放平台业务码（顶层 `code`），文档与 HTTP 429 成对给出。
  kling: {
    '1302': 'rate_limited', // API请求过快，超过平台速率限制
    '1303': 'rate_limited', // 并发或QPS超出预付费资源包限制
    '1101': 'insufficient_quota', // 账户欠费（后付费场景）
    '1102': 'insufficient_quota', // 资源包已用完/已过期（预付费场景）
    '1100': 'auth_failed', // 账户异常
    '1304': 'auth_failed', // 触发平台的IP白名单策略
  },
  // MiniMax 开放平台错误码（`base_resp.status_code`，语音与图像在 HTTP 200 的正文中报告）。
  minimax: {
    '1002': 'rate_limited', // 请求频率超限
    '1045': 'rate_limited', // 任务并发数超限
    '2045': 'rate_limited', // 请求频率增长超限
    '2046': 'rate_limited', // Token 用量增长超限
    '2047': 'rate_limited', // 连接数增长超限
    '2062': 'rate_limited', // 超出 M Plan 速率限制
    '2064': 'rate_limited', // 服务集群负载较高，请稍后重试
    '1008': 'insufficient_quota', // 余额不足
    '2053': 'insufficient_quota', // 积分不足
    '2056': 'insufficient_quota', // 超出M Plan资源限制，等待下一个时间段资源释放
    '2067': 'insufficient_quota', // 套餐额度已用完，且未开启积分自动消耗
    '1004': 'auth_failed', // 未授权/Token 不匹配/Cookie 缺失
    '2049': 'auth_failed', // 无效的 API Key
  },
  // 智谱开放平台业务码（`error.code`），均以 HTTP 429 返回。
  zhipu: {
    '1308': 'insufficient_quota', // 已达到使用上限，限额将在指定时间重置
    '1309': 'insufficient_quota', // GLM Coding Plan 套餐已到期
    '1310': 'insufficient_quota', // 已达到每周/每月使用上限
    '1314': 'insufficient_quota', // 企业套餐已失效
    '1318': 'insufficient_quota', // 已达到 5 小时使用上限，且已达子账号月消费上限
    '1319': 'insufficient_quota', // 已达到 7 天使用上限，且已达子账号月消费上限
    '1320': 'insufficient_quota', // 已达到 5 小时使用上限，且已达企业级月消费上限
    '1321': 'insufficient_quota', // 已达到 7 天使用上限，且已达企业级月消费上限
    '1311': 'auth_failed', // 当前订阅套餐暂未开放该模型权限
    '1315': 'auth_failed', // 该 API Key 仅限企业编程套餐场景使用
  },
}

/** 按分区查找时键为小写。 */
const CODE_SECTIONS: ReadonlyMap<string, ReadonlyMap<string, CodeRule>> = new Map(
  Object.entries(UPSTREAM_CODES).map(([section, codes]) => [
    section,
    new Map(Object.entries(codes).map(([code, rule]) => [code.toLowerCase(), rule])),
  ]),
)

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 正文或错误对象中写有错误码的字段，按具体程度排列：`base_resp.status_code`（MiniMax）、`error.details.error_code`（Anthropic）、
 * `error.code` 与顶层 `code`、`error.status`（Google）、`error.type` 与顶层 `type`。流内错误事件即 `error` 对象本身，同样按顶层读取。
 * 顶层的数值 `status` 是 HTTP 状态码，不读取。
 */
function codesOf(value: unknown): string[] {
  const o = recordOf(value)
  if (!o) return []
  const error = recordOf(o.error)
  return [
    recordOf(o.base_resp)?.status_code,
    recordOf(error?.details)?.error_code,
    recordOf(o.details)?.error_code,
    error?.code,
    o.code,
    error?.status,
    typeof o.status === 'string' ? o.status : undefined,
    error?.type,
    o.type,
  ].flatMap((v) => ((typeof v === 'string' && v) || typeof v === 'number' ? [String(v)] : []))
}

/**
 * 上游错误码对应的失败码（`UPSTREAM_CODES`）；没有已收录的错误码时为 null，由调用方按状态码与原文处理。
 * `vendor` 是请求发往的上游，未收录时为 null：对话请求与 OpenAI 形状的生成协议按接口地址（`channelVendorOf`），其余生成协议按协议本身。
 * 不要按模型名推断上游：中转站以 OpenAI 协议转发各家模型。`bodies` 是错误正文或错误对象，`message` 是对端原文，供按原文区分的错误码使用。
 * 命中该上游分区的错误码后不再查 `any`。
 */
export function upstreamFailureCode(
  vendor: ChannelVendor | null,
  bodies: readonly unknown[],
  message: string,
): ErrorCode | null {
  const codes = bodies.flatMap(codesOf).map((code) => code.toLowerCase())
  for (const section of vendor ? [vendor, 'any'] : ['any']) {
    const table = CODE_SECTIONS.get(section)
    if (!table) continue
    for (const code of codes) {
      const rule = table.get(code)
      if (rule === undefined) continue
      if (typeof rule === 'string') return rule
      return rule.find(([pattern]) => pattern.test(message))?.[1] ?? null
    }
  }
  return null
}

/**
 * 只含一个元素的数组取出该元素，其余值原样返回。Gemini API 的 OpenAI 兼容接口以这种数组返回错误正文
 * （`[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED",…}}]`），官方 SDK `google-genai` 的 `APIError` 同样先取出唯一的元素。
 * 不取出时读取不到其中的错误码与说明：限流的原文与额度用尽相同，按原文归为额度用尽而不重发。
 */
function singleElement(value: unknown): unknown {
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

/** 错误正文按 JSON 解析后的值（`singleElement`），供按错误码判定；不是 JSON 时为 null。对话与生成（`media/http.ts`）共用。 */
export function parsedBody(text: string | null): unknown {
  if (!text) return null
  try {
    return singleElement(JSON.parse(text.trim()))
  } catch {
    return null
  }
}

/** 云端网关拒绝请求中的技能标记时的错误码（`skill-marker/marker.ts`），归为 `skill_rejected`。 */
const SKILL_REJECTIONS: ReadonlySet<string> = new Set([
  'skill_marker_invalid',
  'skill_not_granted',
  'skill_content_too_large',
])

/**
 * 网关的技能拒绝码；不是时返回 null。网关正文为 `{ type: 'error', error: { type, code, message } }`：
 * OpenAI SDK 把 `error.code` 放在错误对象上，Anthropic SDK 不放，因此再从传输层读取的正文中取。
 */
function gatewaySkillRejection(err: unknown, errorBody: string | null): string | null {
  let code = providerErrorField(err, 'code')
  if (!code && errorBody) {
    try {
      code = stringField((JSON.parse(errorBody) as { error?: unknown }).error, 'code')
    } catch {
      code = null
    }
  }
  return code && SKILL_REJECTIONS.has(code) ? code : null
}

/** 判断是「未配置 key」还是「key 错误」：两者的引导文案完全不同。 */
function looksUnconfigured(err: unknown): boolean {
  const m = messageOf(err).toLowerCase()
  return m.includes('unset') || m.includes('missing') || m.includes('no api key')
}

/**
 * `errorBody` 是传输层读取的非 2xx 正文（`transport.ts` 的 `TransportTrace.errorBody`），没有时为 null。
 * `vendor` 是接口地址所属的渠道商（`channelVendorOf`），决定按哪一家的错误码归类（`upstreamFailureCode`）；未收录的地址为 null。
 */
export function classifyProviderError(
  provider: ProviderKind,
  err: unknown,
  transport: ProviderTransportReading | null = null,
  errorBody: string | null = null,
  vendor: ChannelVendor | null = null,
): ProviderError {
  const classified = classify(provider, err, errorBody, vendor)
  if (transport) classified.transport = transport
  return classified
}

/**
 * 流内错误事件中的错误对象，交给 `classifyStreamError` 归类；不是错误事件时为 null。`event` 是 `event:` 行的值，
 * `data` 是该帧 `data` 解析后的对象。三个对话适配器使用本函数，云端网关（改写发给客户端的错误事件）使用同一判定的 `streamErrorAt`：
 * 两处判定不同时，适配器按错误处理而网关未识别的事件会带着上游原文到达用户。
 * - Anthropic：类型为 `error`（取 `type` 字段，没有时取 `event:` 行，中转站不一定两者都发送）；错误对象为 `error` 字段，没有时为事件本身。
 * - Chat Completions：带对象形式的 `error` 字段，即错误对象。SSE 已返回 200，错误只能出现在 chunk 中。
 * - Responses：`type` 为 `error` 或 `response.failed`；错误对象依次取 `response.error`、`error`，都没有时为事件本身
 *   （顶层 `error` 事件的字段即错误字段）。
 * 错误字段存在而不是对象时返回空对象：其中没有可读取的字段，按没有字段的错误事件归类。
 */
export function streamErrorOf(
  provider: ProviderKind,
  event: string | undefined,
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  return streamErrorAt(provider, event, data)?.error ?? null
}

/**
 * 流内错误事件中的错误字段：`error` 是 `streamErrorOf` 返回的错误对象；错误字段为 `holder[key]`，错误对象即事件本身时
 * `key` 为 null、`holder` 为事件。错误字段不是对象时 `holder[key]` 是原值（如字符串），`error` 为新建的空对象。
 * 云端网关按 `holder` 与 `key` 改写帧中的错误字段：只改写 `error` 时，不是对象的错误字段带着上游原文到达电脑端。
 */
export function streamErrorAt(
  provider: ProviderKind,
  event: string | undefined,
  data: Record<string, unknown>,
): { error: Record<string, unknown>; holder: Record<string, unknown>; key: string | null } | null {
  const at = (holder: Record<string, unknown>, key: string | null) => ({
    error: recordOf(key === null ? holder : holder[key]) ?? {},
    holder,
    key,
  })
  if (provider === 'anthropic_messages') {
    const type = typeof data.type === 'string' && data.type ? data.type : (event ?? '')
    if (type !== 'error') return null
    return at(data, data.error == null ? null : 'error')
  }
  if (provider === 'openai_chat_completions') {
    return typeof data.error === 'object' && data.error !== null ? at(data, 'error') : null
  }
  const type = String(data.type ?? '')
  if (type !== 'error' && type !== 'response.failed') return null
  const response = recordOf(data.response)
  if (response?.error != null) return at(response, 'error')
  return at(data, data.error == null ? null : 'error')
}

/**
 * 流内 `error` 事件的归类。三种协议的错误事件字段名一致（`type` / `code` / `message`
 * / `param`），由本入口统一处理。`vendor` 的含义与 `classifyProviderError` 相同。
 *
 * **输入是事件中的结构化字段，不是异常对象**：SSE 已返回 200，此时没有可读取的 HTTP 状态码，
 * 伪造状态码会使「provider 拒绝请求」与「连接建立后出错」在账本上无法区分。
 *
 * 正文是事件原文，分类码只表示错误类别。事件不含文案时改用 `code` / `type`，不编造文案。
 */
export function classifyStreamError(
  provider: ProviderKind,
  event: Record<string, unknown>,
  vendor: ChannelVendor | null = null,
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
    ...(code ? { providerCode: code } : {}),
    ...(type ? { providerType: type } : {}),
    ...(param ? { providerParam: param } : {}),
  }
  const build = (errorCode: ErrorCode) =>
    new ProviderError({ code: errorCode, message, provider, detail, rejected: true })

  const tabled = upstreamFailureCode(vendor, [event], message)
  if (tabled) return build(tabled)
  if (quotaExhausted(message)) return build('insufficient_quota')
  // 并发超限属于限流：中转站在 200 之后以错误事件报告（实际答复：`code` 为 `gateway_concurrency_limit`）。
  if (/rate[\s_-]?limit|too[\s_-]?many[\s_-]?requests|concurrency[\s_-]?limit/.test(reported))
    return build('rate_limited')
  if (/authentication|unauthorized|invalid[\s_-]?api[\s_-]?key|permission|forbidden/.test(reported))
    return build('auth_failed')
  if (/not[\s_-]?found/.test(reported)) return build('model_not_found')
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

function classify(
  provider: ProviderKind,
  err: unknown,
  errorBody: string | null,
  vendor: ChannelVendor | null,
): ProviderError {
  const carried = carriedProviderError(err)
  if (carried) return carried

  const status = statusOf(err)
  const message = providerText(err, status, errorBody)
  // 正文写成状态码名称加原文，与生成一侧（`media/http.ts`）相同；原文不翻译。
  const text =
    status === undefined ? message : `HTTP ${status} ${httpStatusName(status)}：${message}`
  const retryAfterMs = retryAfterOf(err)
  const providerCode = providerErrorField(err, 'code')
  const providerType = providerErrorField(err, 'type')
  const detail = {
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
      message: msg ?? text,
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

  // 先于容量分类与状态码分支：这三个码的状态是 400 / 403 / 413，落入状态码分支会归为参数错误或鉴权失败。
  const skillCode = status === undefined ? null : gatewaySkillRejection(err, errorBody)
  if (skillCode) {
    return new ProviderError({
      code: 'skill_rejected',
      message: text,
      provider,
      ...(status !== undefined ? { status } : {}),
      detail: { ...detail, providerCode: skillCode },
      cause: err,
    })
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

  // 错误码先于状态码：智谱、可灵、火山方舟以 429 同时报告限流与欠费，百炼以 400 报告欠费。
  const code =
    status === undefined
      ? null
      : (upstreamFailureCode(vendor, [parsedBody(errorBody), err], message) ??
        httpFailureCode(status, err, message))
  if (code) return build(code)

  const transport = classifyTransport(err)
  if (transport) return build('network_error', transport.text, transport.timedOut)

  return build('internal_error')
}

/**
 * HTTP 失败按状态码与原文得到的失败码，对话请求（`classify`）与生成请求（`media/http.ts`）共用；正文中已收录的错误码由调用方
 * 先按 `upstreamFailureCode` 判定。`error` 是接口的错误对象，`message` 是对端原文。本表未列出的状态码返回 null，由调用方按自身的判据归类：
 * 对话请求归为传输层失败或 `internal_error`。上下文超限与技能拒绝由 `classify` 在本函数之前判定，不在本表中。
 */
export function httpFailureCode(status: number, error: unknown, message: string): ErrorCode | null {
  switch (status) {
    case 401:
      return looksUnconfigured(error) ? 'no_api_key' : 'auth_failed'
    // 402 Payment Required 不依据正文判定：余额不足时正文中的 `code` 可能是 `invalid_request_error`。
    case 402:
      return 'insufficient_quota'
    // 403 也分两种：无权访问（更换 key 或模型可解决）与余额耗尽（中转站以 403 + `billing_error`
    // 报告），后者归为无权访问会使界面引导用户检查 key 与模型权限。
    case 403:
      return quotaExhausted(message) ? 'insufficient_quota' : 'auth_failed'
    case 404:
      return 'model_not_found'
    case 413:
      // 到达此处说明容量分类器已排除上下文超限，
      // 原因是网关的请求体大小限制（如 nginx 的 client_max_body_size）。
      // 归为上下文超限会触发压缩重发，而实际应缩小附件。
      return 'invalid_request'
    case 429:
      // 429 分两种：限速（等待后可恢复）与额度耗尽（无论等待多久都不会恢复）。
      // 混为一谈会使用户对不会成功的请求反复重发。
      return quotaExhausted(message) ? 'insufficient_quota' : 'rate_limited'
    case 400:
    case 422:
      /*
       * 不要按「消息中含 context / too long / max_tokens」判定上下文超限：
       * `max_tokens must be ≤ 8192` 是**输出**参数校验，判定为上下文超限会把
       * 参数错误报告为上下文已满，用户无法据此定位问题。
       * 容量判定全部交给 `classify` 中的分类器，此处只处理确属参数错误的情况。
       *
       * 额度用尽同样会以 400 报告：Anthropic 以 400 报告达到用户自设的支出上限。
       *
       * **默认归入不可重发的类别。** 4xx 表示该请求被拒绝，相同字节再发送
       * 一次仍会被同样拒绝：不接受图片的模型收到图像块、`max_tokens` 越界，
       * 每次都会触发。归为可重发的码时界面显示「正在重连 N / M」，
       * 该提示无法指出真正的原因。
       */
      if (quotaExhausted(message)) return 'insufficient_quota'
      return looksRetryableRejection(status, message) ? 'provider_unavailable' : 'invalid_request'
    case 500:
    case 502:
    case 503:
    case 529:
      return 'provider_unavailable'
    default:
      return null
  }
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
export type TransportFailureKind = 'tls' | 'closed' | 'timeout' | 'unreachable'

const TRANSPORT_SHAPES: {
  kind: TransportFailureKind
  code: RegExp
  message: RegExp
  text: string
  timedOut: boolean
}[] = [
  {
    kind: 'tls',
    code: /CERT|SSL|TLS|SELF_SIGNED|LEAF_SIGNATURE/,
    message: /certificate|ssl|tls handshake/i,
    text: 'TLS 握手失败：可能是网络不稳定，也可能是代理或自签名证书未被信任',
    timedOut: false,
  },
  {
    kind: 'closed',
    code: /^(ECONNRESET|ECONNABORTED|EPIPE|ERR_SOCKET_CLOSED|UND_ERR_SOCKET|CONNECTION(CLOSED|RESET|ABORTED))/,
    message:
      /socket connection was closed|socket hang up|premature close|http\/2 stream failed|connection (closed|reset|aborted)|\b(ECONNRESET|ECONNABORTED|EPIPE)\b/i,
    text: '连接被断开',
    timedOut: false,
  },
  {
    kind: 'timeout',
    code: /^(ETIMEDOUT|ERR_TIMEOUT|TIMEOUT|CONNECTIONTIMEOUT|UND_ERR_(HEADERS|BODY)_TIMEOUT)/,
    message: /timed out|timeout|\bETIMEDOUT\b/i,
    text: '请求超时',
    timedOut: true,
  },
  {
    kind: 'unreachable',
    code: /^(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN|ERR_NETWORK|UND_ERR_|CONNECTION)/,
    message:
      /fetch failed|unable to connect|connection (refused|error)|network|\b(ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EAI_AGAIN)\b/i,
    text: '无法连接接口：检查接口地址与代理',
    timedOut: false,
  },
]

function classifyTransport(
  err: unknown,
): { kind: TransportFailureKind; text: string; timedOut: boolean } | null {
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
      return { kind: shape.kind, text: shape.text, timedOut: shape.timedOut }
    }
  }
  return null
}

/**
 * 传输层失败的形状，不是传输层失败时为 null。供模型接口以外的请求使用：
 * 它们的文案不提「接口地址」，只需要与 `TRANSPORT_SHAPES` 相同的判定。
 */
export function transportFailureKind(err: unknown): TransportFailureKind | null {
  return classifyTransport(err)?.kind ?? null
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
