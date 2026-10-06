/**
 * 上下文容量拒绝的**窄**分类。
 *
 * **只认定真实的 4xx + provider 原生容量码，或带 token 数的强匹配消息。**
 * 泛化的 `invalid_request_error` 与输出 token 的参数校验一律不认定为输入容量问题。
 *
 * 必须窄的原因：判定过宽时，普通的参数校验错误会被报告为上下文超限，
 * 用户得到「上下文已满」的提示，而真实原因在别处，无法据此排查。宁可漏判，交由通用失败路径处理。
 *
 * 注意 `max_tokens`：它在 4xx 中绝大多数情况下指
 * **输出**上限的参数校验（"max_tokens must be less than…"），不是输入超限。
 */

/** 各家 provider 原生的容量错误码（归一化为 snake_case 后比对）。 */
const CAPACITY_CODES: ReadonlySet<string> = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'input_too_long',
  'max_context_length_exceeded',
  'prompt_too_long',
])

/**
 * 只认定以下三个状态码。
 *
 * 401/403/404/429 即使消息含 "context" 也不是容量问题；5xx 同样不是：
 * 5xx 是服务端故障，压缩无法解决。
 */
const CAPACITY_STATUS: ReadonlySet<number> = new Set([400, 413, 422])

/** 数字可能带千分位、下划线或空格分组。 */
const NUM = '([0-9][0-9,_. ]*)'

export interface CapacityRejection {
  /** 确定是容量拒绝时恒为 'context_overflow'。 */
  code: 'context_overflow'
  /** provider 原生错误码；只在消息匹配时可能为 null。 */
  providerCode: string | null
  status: number
  /** provider 自报的输入 token 数。无法取得时为 null，**不要用本地估算填充**。 */
  reportedInputTokens: number | null
  /** provider 自报的上限。 */
  reportedLimitTokens: number | null
  /** 上述两个数值的统计口径。 */
  scope: 'input' | 'context_total' | 'unknown'
  /**
   * 判定来源。`provider_code` 的可信度远高于 `provider_message`；
   * 排查压缩是否触发时应首先检查此字段。
   */
  matchSource: 'provider_code' | 'provider_message'
  /** 供日志用的原始消息片段（截断）。 */
  hint: string | null
}

/**
 * 仅在**证据充分**时返回容量事实，否则返回 null，由调用方进入通用失败路径。
 *
 * 判定链：状态码在白名单 → 有原生容量码 **或** 消息强匹配 → 提取自报数字。
 */
export function classifyCapacityRejection(err: unknown): CapacityRejection | null {
  const status = statusOf(err)
  if (status === null) return null

  const payloads = payloadsOf(err)
  const codes = codesOf(err, payloads)
  const nativeCode = codes.find((c) => CAPACITY_CODES.has(c)) ?? null

  const text = messageTextOf(err, payloads)
  const strong = isStrongCapacityMessage(text)

  // 两项证据均不存在：不是容量问题。
  if (nativeCode === null && !strong) return null

  const { input, limit, scope } = reportedCounts(text)

  return {
    code: 'context_overflow',
    providerCode:
      nativeCode ??
      // 没有原生容量码时，改为记录泛化错误码。它**不作为判据**（判据是 strong message），
      // 只用于在日志中显示 provider 本次返回的错误码。
      codes.find((c) => c === 'invalid_argument' || c === 'invalid_request_error') ??
      null,
    status,
    reportedInputTokens: input,
    reportedLimitTokens: limit,
    scope,
    matchSource: nativeCode !== null ? 'provider_code' : 'provider_message',
    hint: hintOf(text),
  }
}

// ─────────────────────────────── 证据提取 ───────────────────────────────

function statusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as Record<string, unknown>
  const candidates: unknown[] = [e.status, e.statusCode]
  const res = e.response as Record<string, unknown> | undefined
  if (res) candidates.push(res.status, res.statusCode)
  for (const v of candidates) {
    if (typeof v === 'number' && CAPACITY_STATUS.has(v)) return v
  }
  return null
}

/** 错误对象上可能挂载结构化 body 的几个位置，各家 SDK 不统一。 */
function payloadsOf(err: unknown): unknown[] {
  if (typeof err !== 'object' || err === null) return []
  const e = err as Record<string, unknown>
  return [e.body, e.error, e.details].filter((v) => v !== undefined && v !== null)
}

/** 深度受限的对象遍历：错误体可能嵌套，但遍历深度须有上限。 */
function* walk(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > 5 || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item, depth + 1)
    return
  }
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>
    yield row
    for (const item of Object.values(row)) yield* walk(item, depth + 1)
  }
}

function normalizeCode(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null
  const text = String(value).trim().toLowerCase().replace(/[-\s]/g, '_')
  return text || null
}

function codesOf(err: unknown, payloads: unknown[]): string[] {
  const values: unknown[] = []
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>
    values.push(e.code, e.type, e.status)
  }
  for (const payload of payloads) {
    for (const row of walk(payload)) {
      values.push(row.code, row.type, row.status, row.reason)
    }
  }
  const out: string[] = []
  for (const v of values) {
    const n = normalizeCode(v)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

function messageTextOf(err: unknown, payloads: unknown[]): string {
  const parts: string[] = [err instanceof Error ? err.message : String(err)]
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>
    for (const v of [e.message, e.detail]) {
      if (typeof v === 'string') parts.push(v)
    }
  }
  for (const payload of payloads) {
    for (const row of walk(payload)) {
      for (const key of ['message', 'detail', 'description']) {
        const v = row[key]
        if (typeof v === 'string') parts.push(v)
      }
    }
    try {
      parts.push(JSON.stringify(payload))
    } catch {
      // 循环引用等情况：跳过该 payload，其余证据仍然有效。
    }
  }
  return parts.join('\n').toLowerCase()
}

/**
 * 消息强匹配。
 *
 * **第一项检查是「输入轴」**：消息中必须出现 context / prompt / input token 等词。
 * 没有输入轴词汇时直接判定为否：此检查排除了绝大多数输出参数校验误判，因为
 * "max_tokens must be less than 8192" 中没有任何输入轴词汇。
 */
function isStrongCapacityMessage(text: string): boolean {
  const hasInputAxis = ['context', 'prompt', 'input token', 'messages resulted'].some((t) =>
    text.includes(t),
  )
  if (!hasInputAxis) return false

  if (
    text.includes('prompt is too long') ||
    text.includes('too many input tokens') ||
    /(?:your\s+)?input\s+exceeds?\s+(?:the\s+)?context\s+window/.test(text)
  ) {
    return true
  }
  if (/input\s+token\s+count[\s\S]{0,120}exceed/.test(text)) return true
  if (/(?:maximum|max)\s+context\s+(?:length|window)/.test(text)) {
    return /exceed|requested|resulted|too\s+long|reduce/.test(text)
  }
  if (/context\s+(?:length|window)[\s\S]{0,100}(?:exceed|too\s+long)/.test(text)) return true
  return /(?:prompt|input)[\s\S]{0,80}(?:exceed|too\s+long)[\s\S]{0,80}(?:token|maximum|limit)/.test(
    text,
  )
}

function tokenInt(raw: string | undefined): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[^0-9]/g, '')
  return cleaned ? Number(cleaned) : null
}

/**
 * 从消息中提取 provider 自报的用量与上限。
 *
 * 各家的措辞与**数字顺序**均不相同，因此每条 pattern 须单独标注哪个数值在前。
 * 带 `reversed` 的一条对应 OpenAI 系：先给出上限再给出请求量。顺序颠倒会得到
 * 「用量 8192，上限 213000」这类错误记录，比没有记录更有害。
 */
function reportedCounts(text: string): {
  input: number | null
  limit: number | null
  scope: 'input' | 'context_total' | 'unknown'
} {
  const patterns: Array<{
    re: RegExp
    scope: 'input' | 'context_total' | 'unknown'
    reversed: boolean
  }> = [
    // Gemini: input token count (1001) exceeds ... allowed (1000)
    {
      re: new RegExp(
        `input\\s+token\\s+count\\s*\\(?${NUM}\\)?[\\s\\S]{0,140}?(?:maximum|max)[^0-9]{0,80}\\(?${NUM}\\)?`,
        'i',
      ),
      scope: 'input',
      reversed: false,
    },
    // Anthropic: prompt is too long: 213000 tokens > 200000 maximum
    {
      re: new RegExp(
        `prompt\\s+is\\s+too\\s+long[^0-9]{0,40}${NUM}\\s*tokens?[\\s\\S]{0,80}?(?:>|maximum|max|limit)[^0-9]{0,30}${NUM}`,
        'i',
      ),
      scope: 'input',
      reversed: false,
    },
    // OpenAI/中转站：maximum context length is LIMIT ... requested/resulted REQ，数字顺序相反
    {
      re: new RegExp(
        `(?:maximum|max)\\s+context\\s+(?:length|window)[^0-9]{0,50}${NUM}[\\s\\S]{0,180}?(?:requested|resulted\\s+in|input)[^0-9]{0,50}${NUM}`,
        'i',
      ),
      scope: 'context_total',
      reversed: true,
    },
    // 中转站变体：请求量在前。
    {
      re: new RegExp(
        `(?:requested|input|prompt)[^0-9]{0,40}${NUM}\\s*tokens?[\\s\\S]{0,120}?(?:maximum|max|limit)[^0-9]{0,40}${NUM}`,
        'i',
      ),
      scope: 'unknown',
      reversed: false,
    },
  ]

  for (const { re, scope, reversed } of patterns) {
    const m = re.exec(text)
    if (!m) continue
    const first = tokenInt(m[1])
    const second = tokenInt(m[2])
    return reversed
      ? { input: second, limit: first, scope }
      : { input: first, limit: second, scope }
  }
  return { input: null, limit: null, scope: 'unknown' }
}

/** 日志用的消息片段。须截断：中转站的错误体可达数十 KB。 */
function hintOf(text: string): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}
