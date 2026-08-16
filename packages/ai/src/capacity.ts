/**
 * 上下文容量拒绝的**窄**分类。
 *
 * **只认真实的 4xx + provider 原生容量码，或者一条强的、带 token 数的消息。**
 * 泛化的 `invalid_request_error` 和输出 token 的参数校验一律不算输入容量。
 *
 * 为什么必须这么窄：判宽了，一个普通的参数校验错误会被报成上下文超限，
 * 用户拿到的是「上下文满了」而真实原因在别处，查不下去。宁可漏判走通用失败路径。
 *
 * 特别注意 `max_tokens` 这个词：它出现在 4xx 里绝大多数时候指的是
 * **输出**上限的参数校验（"max_tokens must be less than…"），不是输入超限。
 */

/** 各家 provider 原生的容量错误码（归一化成 snake_case 后比对）。 */
const CAPACITY_CODES: ReadonlySet<string> = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'input_too_long',
  'max_context_length_exceeded',
  'prompt_too_long',
])

/**
 * 只认这三个状态码。
 *
 * 401/403/404/429 即使消息里带 "context" 也不是容量问题；5xx 更不是——
 * 那是服务端故障，压缩了也没用。
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
  /** provider 自报的输入 token 数。拿不到就是 null——**不要拿本地估算填这里**。 */
  reportedInputTokens: number | null
  /** provider 自报的上限。 */
  reportedLimitTokens: number | null
  /** 上面两个数指的是什么口径。 */
  scope: 'input' | 'context_total' | 'unknown'
  /**
   * 判定来源。`provider_code` 比 `provider_message` 可信得多——
   * 排查「为什么触发/没触发压缩」时第一个要看的就是它。
   */
  matchSource: 'provider_code' | 'provider_message'
  /** 供日志用的原始消息片段（截断）。 */
  hint: string | null
}

/**
 * 只在**证据充分**时返回容量事实，否则返回 null 让调用方走通用失败路径。
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

  // 两条证据一条都没有 —— 不是容量问题。
  if (nativeCode === null && !strong) return null

  const { input, limit, scope } = reportedCounts(text)

  return {
    code: 'context_overflow',
    providerCode:
      nativeCode ??
      // 没有原生容量码时，退一步记录泛化码。它**不作为判据**（判据是 strong message），
      // 只是让日志能看出 provider 当时到底回了什么。
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

/** 深度受限的对象遍历——错误体可能嵌套，但不该无限深挖。 */
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
      // 循环引用等——跳过这一份 payload，其余证据仍然有效。
    }
  }
  return parts.join('\n').toLowerCase()
}

/**
 * 消息强匹配。
 *
 * **第一道闸是「输入轴」**：消息里必须出现 context / prompt / input token 这类词。
 * 没有输入轴就直接否——这一条挡住了绝大多数输出参数校验误判，因为
 * "max_tokens must be less than 8192" 里一个输入轴的词都没有。
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
 * 从消息里抠出 provider 自报的「用了多少 / 上限多少」。
 *
 * 各家的措辞和**数字顺序**都不一样，所以每条 pattern 要单独标注哪个数在前。
 * `reversed` 那条是 OpenAI 系：先说上限再说请求量。搞反了会得到
 * 「用了 8192，上限 213000」这种荒谬的记录，比没有还糟。
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
    // OpenAI/中转: maximum context length is LIMIT ... requested/resulted REQ —— 数字顺序相反
    {
      re: new RegExp(
        `(?:maximum|max)\\s+context\\s+(?:length|window)[^0-9]{0,50}${NUM}[\\s\\S]{0,180}?(?:requested|resulted\\s+in|input)[^0-9]{0,50}${NUM}`,
        'i',
      ),
      scope: 'context_total',
      reversed: true,
    },
    // 中转变体：请求量在前。
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

/** 日志用的消息片段。截断是必要的：中转服务的错误体能有几十 KB。 */
function hintOf(text: string): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}
