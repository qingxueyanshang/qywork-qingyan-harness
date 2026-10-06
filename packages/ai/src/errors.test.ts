/**
 * Provider 错误归类。
 *
 * 分类结果决定三件事：**是否重试**、
 * **是否压缩后重发**、**向用户显示哪条引导**。误判的代价不在于文案，
 * 而在于一次网络波动终止整轮任务，或一次参数错误引发持续计费的压缩循环。
 *
 * 标记为「Bun 实测」的文案是 2026-08 在一台网络不稳定的机器上
 * 连续请求 `api.deepseek.com` 时**实际收到**的，不是依据文档编写的。
 */

import { describe, expect, test } from 'bun:test'
import { APIConnectionError } from 'openai'
import { classifyProviderError, classifyStreamError, ProviderError } from './errors.ts'
import { drainAdapter, FAULT_PROTOCOLS, withFault } from './providers/fault-server.test-helper.ts'

const P = 'openai_responses' as const

function http(status: number, message = 'boom'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function transport(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('传输层失败必须可重试', () => {
  /**
   * 本组覆盖传输层失败的重试判定。
   *
   * 判据必须按 **Bun** 的文案编写。按 Node/undici 编写的正则
   * （`/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i`）无法匹配下面三条真实
   * 失败中的任何一条，它们会全部归入 `internal_error` 且不可重试，
   * 一次网络波动就会终止整轮 run。
   */
  test('Bun 实测：The operation timed out.', () => {
    const e = classifyProviderError(P, transport('ETIMEDOUT', 'The operation timed out.'))
    expect(e.code).toBe('network_error')
    expect(e.timedOut).toBe(true)
  })

  test('Bun 实测：The socket connection was closed unexpectedly.', () => {
    const e = classifyProviderError(P, new Error('The socket connection was closed unexpectedly.'))
    expect(e.code).toBe('network_error')
    expect(e.timedOut).toBe(false)
  })

  test('中转站实测：Upstream HTTP/2 stream failed', () => {
    const e = classifyProviderError(P, new Error('Upstream HTTP/2 stream failed'))
    expect(e.code).toBe('network_error')
    expect(e.message).toBe('连接被断开')
  })

  /**
   * 证书错误判定为可重试是**权衡后的选择**：它既可能是握手时遇到网络波动（重试可恢复），
   * 也可能是代理或自签名证书未被信任（重试无效）。误判为不可重试的代价更大，
   * 因此判定为可重试；但文案必须同时指出两种可能，否则代理配置错误的用户会转而排查网络。
   */
  test('Bun 实测：unknown certificate verification error', () => {
    const e = classifyProviderError(
      P,
      transport('UNKNOWN_CERTIFICATE_VERIFICATION_ERROR', 'unknown certificate verification error'),
    )
    expect(e.code).toBe('network_error')
    expect(e.message).toMatch(/证书|代理/)
  })

  test('code 优先于文案：文案无线索时也能依据 code 识别', () => {
    const e = classifyProviderError(P, transport('ECONNRESET', 'read'))
    expect(e.code).toBe('network_error')
  })

  test('仍能识别 Node 的错误文案', () => {
    for (const m of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND',
    ]) {
      const e = classifyProviderError(P, new Error(m))
      expect(e.code).toBe('network_error')
    }
  })

  /** 不能把所有错误都归为网络错误：真正的内部错误应保留为 internal_error。 */
  test('无关错误不被误判为网络问题', () => {
    const e = classifyProviderError(P, new Error('Cannot read properties of undefined'))
    expect(e.code).toBe('internal_error')
  })
})

/**
 * 三个分支的分界。
 *
 * 本组锁定的是**每个错误码归入哪个分支**，而不是文案。分错的代价：
 * 「无法连接」会引导用户修改接口地址（而问题在于链路波动），「连接被断开」会让用户等待重发
 * （而实际原因是 key 与端点不匹配）。
 *
 * 重点是 `ECONNREFUSED`（未建立连接）与 `ECONNRESET`（建立连接后被重置）：
 * 两者形式相近、含义相反，最容易被归入同一分支。
 */
describe('传输失败分为三个分支：无法连接 / 连接被断开 / 超时', () => {
  const shapeOf = (err: unknown) => classifyProviderError(P, err).message

  test('未建立连接 → 无法连接接口', () => {
    for (const err of [
      transport('ECONNREFUSED', 'connect'),
      transport('ENOTFOUND', 'dns'),
      transport('EHOSTUNREACH', ''),
      transport('EAI_AGAIN', ''),
      new Error('getaddrinfo ENOTFOUND api.deepseek.com'),
      new Error('fetch failed'),
      new Error('Connection error.'),
    ]) {
      expect(shapeOf(err)).toMatch(/无法连接/)
    }
  })

  test('建立连接后断开 → 连接被断开', () => {
    for (const err of [
      transport('ECONNRESET', 'read'),
      transport('EPIPE', ''),
      transport('ERR_SOCKET_CLOSED', ''),
      // Bun 实测的文案，`code` 为空，只能依据文案识别。
      new Error('The socket connection was closed unexpectedly.'),
      new Error('socket hang up'),
    ]) {
      expect(shapeOf(err)).toMatch(/断开/)
    }
  })

  test('超时 → 请求超时', () => {
    for (const err of [
      transport('ETIMEDOUT', 'The operation timed out.'),
      transport('UND_ERR_HEADERS_TIMEOUT', ''),
      // SDK 自身的 60 秒超时产生的就是这条文案，没有 code。
      new Error('Request timed out.'),
    ]) {
      expect(shapeOf(err)).toMatch(/超时/)
    }
  })

  test('三个分支均可重试，均归入 network_error', () => {
    for (const err of [
      transport('ECONNREFUSED', ''),
      transport('ECONNRESET', ''),
      transport('ETIMEDOUT', ''),
    ]) {
      const e = classifyProviderError(P, err)
      expect(e.code).toBe('network_error')
    }
  })
})

describe('SDK 包装保留具体的传输失败原因', () => {
  test.each([
    [
      'UNKNOWN_CERTIFICATE_VERIFICATION_ERROR',
      'unknown certificate verification error',
      'TLS 握手失败',
      false,
    ],
    ['ECONNRESET', 'The socket connection was closed unexpectedly.', '连接被断开', false],
    [
      'ConnectionRefused',
      'Unable to connect. Is the computer able to access the url?',
      '无法连接接口',
      false,
    ],
    ['ENOTFOUND', 'getaddrinfo ENOTFOUND zhende.ai', '无法连接接口', false],
    ['ETIMEDOUT', 'The operation timed out.', '请求超时', true],
    ['', 'unknown certificate verification error', 'TLS 握手失败', false],
    ['', 'The socket connection was closed unexpectedly.', '连接被断开', false],
    ['', 'The operation timed out.', '请求超时', true],
  ] as const)('%s / %s', (code, message, expected, timedOut) => {
    const raw = transport(code, message)
    const wrapped = new APIConnectionError({ cause: raw })
    const e = classifyProviderError('openai_chat_completions', wrapped)
    expect(e.code).toBe('network_error')
    expect(e.message).toContain(expected)
    expect(e.timedOut).toBe(timedOut)
    expect(e.cause).toBe(wrapped)
    expect(wrapped.cause).toBe(raw)
    expect(e.detail?.providerMessage).toBe('Connection error.')
  })

  test('多层包装中的泛化连接码不能掩盖底层证书原因', () => {
    for (const raw of [
      transport('UNKNOWN_CERTIFICATE_VERIFICATION_ERROR', 'read'),
      new Error('unknown certificate verification error'),
    ]) {
      const wrapped = Object.assign(new Error('Connection error.', { cause: raw }), {
        code: 'ConnectionError',
      })
      const e = classifyProviderError(P, new APIConnectionError({ cause: wrapped }))
      expect(e.message).toContain('TLS 握手失败')
    }
  })

  test('底层文案没有线索也能靠错误码识别连接重置', () => {
    const wrapped = new APIConnectionError({
      cause: transport('ECONNRESET', 'read'),
    })
    expect(classifyProviderError(P, wrapped).message).toBe('连接被断开')
  })

  test('原因链成环仍能识别具体错误并结束遍历', () => {
    const raw = transport('ECONNRESET', 'read')
    const wrapped = new APIConnectionError({ cause: raw })
    raw.cause = wrapped
    expect(classifyProviderError(P, wrapped).message).toBe('连接被断开')
  })

  test('HTTP 拒绝和用户取消仍优先于传输原因', () => {
    const raw = transport('UNKNOWN_CERTIFICATE_VERIFICATION_ERROR', 'read')
    const rejected = Object.assign(http(400, 'invalid max_tokens'), { cause: raw })
    expect(classifyProviderError(P, rejected).code).toBe('invalid_request')
    const aborted = new Error('aborted', { cause: raw })
    aborted.name = 'AbortError'
    expect(classifyProviderError(P, aborted).message).toBe('已取消')
  })

  test('已分类的原因保持原实例和超时标记', () => {
    const original = new ProviderError({
      code: 'stream_idle_timeout',
      message: '模型响应中断',
      provider: P,
      timedOut: true,
    })
    const wrapped = new APIConnectionError({ cause: original })
    expect(classifyProviderError(P, wrapped)).toBe(original)
  })
})

describe('用户中断不是错误', () => {
  test('AbortError 不报告为网络问题，也不重发', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    const e = classifyProviderError(P, err)
    // internal_error 不在 agent/loop/attempt.ts 的重发表中：用户主动停止的请求不应被自动重发。
    expect(e.code).toBe('internal_error')
    expect(e.message).toBe('已取消')
  })
})

describe('按用户的下一步动作分类', () => {
  test('流内 error 事件按事件中的 type / code 分类，不依据状态码', () => {
    const byType = (type: string) => classifyStreamError(P, { type, message: 'provider 原话' }).code
    const byCode = (code: string) => classifyStreamError(P, { code, message: 'provider 原话' }).code

    expect(byType('rate_limit_error')).toBe('rate_limited')
    expect(byCode('rate_limit_exceeded')).toBe('rate_limited')
    expect(byType('too_many_requests')).toBe('rate_limited')
    expect(byType('authentication_error')).toBe('auth_failed')
    expect(byType('permission_error')).toBe('auth_failed')
    expect(byCode('invalid_api_key')).toBe('auth_failed')
    expect(byType('not_found_error')).toBe('model_not_found')
    expect(byCode('model_not_found')).toBe('model_not_found')
    expect(byType('invalid_request_error')).toBe('invalid_request')
    expect(byCode('bad_request')).toBe('invalid_request')
    expect(byCode('insufficient_quota')).toBe('insufficient_quota')
    expect(byType('overloaded_error')).toBe('provider_unavailable')
    expect(byType('server_error')).toBe('provider_unavailable')
    expect(byType('api_error')).toBe('provider_unavailable')
    expect(byType('这家中转自己编的码')).toBe('provider_unavailable')
  })

  /** 分类码只表示错误类别，不包含 provider 的报错内容。原文丢失后无法从其他位置取回。 */
  test('流内 error 保留事件原文与结构化字段', () => {
    const e = classifyStreamError(P, {
      type: 'overloaded_error',
      message: 'Overloaded',
      code: 'x_overloaded',
    })
    expect(e.code).toBe('provider_unavailable')
    expect(e.message).toBe('Overloaded')
    expect(e.detail).toMatchObject({
      providerMessage: 'Overloaded',
      providerType: 'overloaded_error',
      providerCode: 'x_overloaded',
    })
    // 没有 HTTP 状态码：流内错误不伪造状态码，账本据此区分请求被拒绝与建立连接后出错。
    expect(e.status).toBeUndefined()
  })

  test('事件不含文案时改用 code / type，不编造文案', () => {
    expect(classifyStreamError(P, { code: 'server_error' }).message).toBe('server_error')
    expect(classifyStreamError(P, {}).message).toBe('模型服务返回错误事件')
  })

  test('401 未配置与 401 key 无效是两条不同的引导', () => {
    expect(classifyProviderError(P, http(401, 'API key missing')).code).toBe('no_api_key')
    expect(classifyProviderError(P, http(401, 'Incorrect API key')).code).toBe('auth_failed')
  })

  /** 限速在等待后可恢复，欠费无论等待多久都不会恢复。两者混为一谈会使用户反复点击不会成功的重试。 */
  test('429 分限速与额度耗尽', () => {
    const raw = Object.assign(new Error('Rate limit reached'), {
      status: 429,
      code: 'rate_limit_exceeded',
      headers: new Headers({ 'retry-after': '2.5' }),
    })
    const limited = classifyProviderError(P, raw)
    expect(limited.code).toBe('rate_limited')
    expect(limited.message).toBe('触发限速')
    expect(limited.retryAfterMs).toBe(2_500)
    expect(limited.detail).toMatchObject({
      providerMessage: 'Rate limit reached',
      providerCode: 'rate_limit_exceeded',
      retryAfterMs: 2_500,
    })

    const broke = classifyProviderError(P, http(429, 'You exceeded your current quota'))
    expect(broke.code).toBe('insufficient_quota')
  })

  test('429 优先读结构化额度码，也识别中文额度正文', () => {
    const structured = Object.assign(new Error('request rejected'), {
      status: 429,
      error: { code: 'insufficient_quota', message: 'request rejected' },
    })
    expect(classifyProviderError(P, structured).code).toBe('insufficient_quota')
    expect(classifyProviderError(P, http(429, '账户余额不足，请充值')).code).toBe(
      'insufficient_quota',
    )
  })

  /** 中转站余额耗尽时返回 403；按 Anthropic 与 OpenAI 两种正文格式各取一份原文。 */
  test('403 带余额不足正文归账户额度不足，其余 403 仍是无权访问', () => {
    const anthropic = Object.assign(new Error('403 insufficient balance'), {
      status: 403,
      error: { error: { message: 'insufficient balance', type: 'billing_error' }, type: 'error' },
    })
    expect(classifyProviderError(P, anthropic).code).toBe('insufficient_quota')
    const openai = classifyProviderError(P, http(403, 'insufficient balance'))
    expect(openai.code).toBe('insufficient_quota')
    expect(openai.message).toBe('账户额度不足')
    const denied = classifyProviderError(P, http(403, 'You do not have access to this model'))
    expect(denied.code).toBe('auth_failed')
    expect(denied.message).toBe('当前 Key 无权访问该模型')
  })

  /**
   * 402 是 Payment Required，不依据正文判定：DeepSeek 的正文中 `code` 为 `invalid_request_error`，
   * 按字段判定会归为参数错误。测试经三种协议的真实适配器发送 HTTP 请求，断言界面最终收到的错误码。
   */
  test('402 归账户额度不足', async () => {
    expect(classifyProviderError(P, http(402, 'Insufficient Balance')).code).toBe(
      'insufficient_quota',
    )
    for (const { kind, model } of FAULT_PROTOCOLS) {
      const { err } = await withFault('payment_required', (fault) =>
        drainAdapter({ fault, kind, model, idleTimeoutMs: 5_000 }),
      )
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).code).toBe('insufficient_quota')
      expect((err as ProviderError).message).toBe('账户额度不足')
    }
  })

  test('retry-after-ms 优先于 retry-after', () => {
    const err = Object.assign(new Error('busy'), {
      status: 429,
      headers: new Headers({ 'retry-after-ms': '125', 'retry-after': '9' }),
    })
    expect(classifyProviderError(P, err).retryAfterMs).toBe(125)
  })

  test('404 指向模型名或接口地址，而不是「服务不可用」', () => {
    expect(classifyProviderError(P, http(404)).code).toBe('model_not_found')
  })

  test('5xx 归入 provider_unavailable，该码在 agent/loop/attempt.ts 的重发表中', () => {
    for (const s of [500, 502, 503, 529]) {
      expect(classifyProviderError(P, http(s)).code).toBe('provider_unavailable')
    }
  })

  /**
   * `max_tokens must be ≤ 8192` 是**输出**参数校验。判定为上下文超限会触发
   * 无效的压缩重发，而重发请求的参数错误完全相同，形成持续计费的循环。
   */
  test('400 的参数错误不带 capacity，压缩不会被触发', () => {
    const e = classifyProviderError(P, http(400, 'max_tokens must be less than or equal to 8192'))
    expect(e.capacity).toBeUndefined()
    expect(e.code).toBe('invalid_request')
  })

  /**
   * 原始失败形状：向不接受图片的模型发送图像块。该码**不在** `agent/loop/attempt.ts` 的重发表中，
   * 因此界面不会显示「正在重连 N / M」。
   */
  test('模型不接受图片的 400 归 invalid_request', () => {
    for (const m of [
      '{"error":{"message":"Invalid content type: image_url is not supported by this model","type":"invalid_request_error"}}',
      '该模型不支持图片输入',
    ]) {
      const e = classifyProviderError(P, http(400, m))
      expect(e.code).toBe('invalid_request')
      expect(e.capacity).toBeUndefined()
      // provider 原文原样保留：分类短语只能说明错误类别，无法指出具体参数。
      expect(e.message).toBe(m)
    }
  })

  /**
   * 中转站会以 400 而不是 5xx 报告「后端暂时不可用」。归入 `provider_unavailable`
   * 才能进入 `agent/loop/attempt.ts` 的重发表；判定为其他码时，一次上游波动就会终止整轮。
   */
  test('中转站用 400 报「暂时不可用」，仍归 provider_unavailable', () => {
    const e = classifyProviderError(
      P,
      http(400, '{"error":{"type":"<nil>","message":"暂不可用 请稍后再试"}}'),
    )
    expect(e.code).toBe('provider_unavailable')
    // 携带 capacity 会触发压缩重发，而该错误与上下文长度无关。
    expect(e.capacity).toBeUndefined()
  })

  test('中转站无参数细节的通用 400 归 provider_unavailable', () => {
    const e = classifyProviderError(P, http(400, 'Request contains an invalid argument.'))
    expect(e.code).toBe('provider_unavailable')
    expect(e.capacity).toBeUndefined()
    expect(e.message).toBe('Request contains an invalid argument.')
  })

  test('中转站包装的上游 403 可换渠道重试，端点直接 403 仍是权限拒绝', () => {
    for (const status of [400, 422]) {
      const relayed = classifyProviderError(P, http(status, 'Upstream returned HTTP 403 Forbidden'))
      expect(relayed.code).toBe('provider_unavailable')
      expect(relayed.message).toBe('Upstream returned HTTP 403 Forbidden')
    }

    expect(classifyProviderError(P, http(403, 'Forbidden')).code).toBe('auth_failed')
  })

  /**
   * 413 到达此处说明容量分类器已排除上下文超限，它是网关的请求体大小限制。
   * 相同字节重发必然同样被拒，因此归入不可重发的类别。
   */
  test('413 指向附件大小与反向代理配置', () => {
    const e = classifyProviderError(P, http(413))
    expect(e.code).toBe('invalid_request')
    expect(e.message).toMatch(/附件|反向代理|网关/)
  })
})

describe('已分类的错误不再重新归类', () => {
  test('ProviderError 原样返回，不会被二次归类', () => {
    const original = new ProviderError({
      code: 'context_overflow',
      message: '超了',
      provider: P,
    })
    expect(classifyProviderError(P, original)).toBe(original)
  })
})
