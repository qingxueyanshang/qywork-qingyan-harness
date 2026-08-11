import { describe, expect, test } from 'bun:test'
import { classifyCapacityRejection } from './capacity.ts'

/** 构造一个形似各家 SDK 抛出的错误对象。 */
function apiError(opts: {
  status: number
  message: string
  body?: unknown
  code?: string
  type?: string
}): Error & Record<string, unknown> {
  const e = new Error(opts.message) as Error & Record<string, unknown>
  e.status = opts.status
  if (opts.body !== undefined) e.body = opts.body
  if (opts.code) e.code = opts.code
  if (opts.type) e.type = opts.type
  return e
}

describe('原生容量码', () => {
  test('OpenAI context_length_exceeded 认定为容量拒绝', () => {
    const r = classifyCapacityRejection(
      apiError({
        status: 400,
        message: "This model's maximum context length is 128000 tokens.",
        body: { error: { code: 'context_length_exceeded', type: 'invalid_request_error' } },
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.matchSource).toBe('provider_code')
    expect(r!.providerCode).toBe('context_length_exceeded')
  })

  test('带连字符的码归一化后仍能匹配', () => {
    const r = classifyCapacityRejection(
      apiError({ status: 422, message: 'nope', body: { code: 'Input-Too-Long' } }),
    )
    expect(r?.providerCode).toBe('input_too_long')
  })
})

describe('消息强匹配', () => {
  test('Anthropic prompt is too long，并抠出两个数字', () => {
    const r = classifyCapacityRejection(
      apiError({
        status: 400,
        message: 'prompt is too long: 213000 tokens > 200000 maximum',
        body: { type: 'invalid_request_error' },
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.matchSource).toBe('provider_message')
    expect(r!.reportedInputTokens).toBe(213000)
    expect(r!.reportedLimitTokens).toBe(200000)
    expect(r!.scope).toBe('input')
    // 泛化码只作记录，不作判据。
    expect(r!.providerCode).toBe('invalid_request_error')
  })

  test('OpenAI 措辞里上限在前、请求量在后 —— 顺序不能搞反', () => {
    const r = classifyCapacityRejection(
      apiError({
        status: 400,
        message:
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 131500 tokens.",
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.reportedLimitTokens).toBe(128000)
    expect(r!.reportedInputTokens).toBe(131500)
    expect(r!.scope).toBe('context_total')
  })

  test('Gemini input token count 措辞', () => {
    const r = classifyCapacityRejection(
      apiError({
        status: 400,
        message:
          'The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).',
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.reportedInputTokens).toBe(1048577)
    expect(r!.reportedLimitTokens).toBe(1048576)
  })

  test('带千分位的数字', () => {
    const r = classifyCapacityRejection(
      apiError({ status: 400, message: 'prompt is too long: 213,000 tokens > 200,000 maximum' }),
    )
    expect(r!.reportedInputTokens).toBe(213000)
    expect(r!.reportedLimitTokens).toBe(200000)
  })
})

describe('必须判否的情况（窄分类的全部价值所在）', () => {
  test('输出 max_tokens 参数校验不是输入容量问题', () => {
    // 这正是现有 errors.ts 的 `m.includes('max_tokens')` 会误判的那一条。
    const r = classifyCapacityRejection(
      apiError({
        status: 400,
        message: 'max_tokens must be less than or equal to 8192',
        body: { type: 'invalid_request_error' },
      }),
    )
    expect(r).toBeNull()
  })

  test('泛化 invalid_request_error 不是容量问题', () => {
    const r = classifyCapacityRejection(
      apiError({
        status: 400,
        message: 'tools.0.custom.name: String should match pattern',
        body: { error: { type: 'invalid_request_error' } },
      }),
    )
    expect(r).toBeNull()
  })

  test('429 限速即使消息里带 context 也不算 —— 状态码白名单先否掉', () => {
    const r = classifyCapacityRejection(
      apiError({ status: 429, message: 'rate limited: context length is large' }),
    )
    expect(r).toBeNull()
  })

  test('5xx 不算 —— 服务端故障压缩了也没用', () => {
    const r = classifyCapacityRejection(
      apiError({ status: 500, message: 'prompt is too long', body: { code: 'prompt_too_long' } }),
    )
    expect(r).toBeNull()
  })

  test('没有输入轴词汇时，即使有 exceed/limit 也判否', () => {
    const r = classifyCapacityRejection(
      apiError({ status: 400, message: 'temperature exceeds the allowed limit of 2.0' }),
    )
    expect(r).toBeNull()
  })

  test('非对象错误不炸', () => {
    expect(classifyCapacityRejection('boom')).toBeNull()
    expect(classifyCapacityRejection(null)).toBeNull()
    expect(classifyCapacityRejection(undefined)).toBeNull()
  })

  test('循环引用的 body 不炸', () => {
    const body: Record<string, unknown> = { message: 'prompt is too long: 9 tokens > 8 maximum' }
    body.self = body
    const r = classifyCapacityRejection(apiError({ status: 400, message: 'err', body }))
    expect(r).not.toBeNull()
  })
})

describe('数字抠不出来时', () => {
  test('仍然认定为容量拒绝，只是数字为 null —— 不许拿本地估算填', () => {
    const r = classifyCapacityRejection(
      apiError({
        status: 413,
        message: 'the request exceeds the context window; please reduce the prompt',
        body: { code: 'context_window_exceeded' },
      }),
    )
    expect(r).not.toBeNull()
    expect(r!.reportedInputTokens).toBeNull()
    expect(r!.reportedLimitTokens).toBeNull()
    expect(r!.scope).toBe('unknown')
  })
})
