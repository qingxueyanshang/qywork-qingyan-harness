/**
 * Provider 错误归类。
 *
 * 这个文件一直没有——而分类结果决定了三件事：**要不要重试**、
 * **要不要压缩重发**、**给用户看哪一句引导**。判错的代价不是文案难看，
 * 是一次网络抖动终结整轮任务，或者一次参数错误引发烧钱的压缩死循环。
 *
 * 下面「Bun 实测」标记的几条文案是 2026-08 在一台网络抖动的机器上
 * 对 `api.deepseek.com` 连打时**真的收到过**的，不是照着文档编的。
 */

import { describe, expect, test } from 'bun:test'
import { classifyProviderError, ProviderError } from './errors.ts'

const P = 'openai_responses' as const

function http(status: number, message = 'boom'): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

function transport(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

describe('传输层失败必须可重试', () => {
  /**
   * 这一组是这个文件存在的直接原因。
   *
   * 原来的判据 `/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i`
   * 是照 Node/undici 的文案写的，而**运行时是 Bun**。下面三条真实失败
   * 一条都没匹配上，全部落到 `internal_error` + 不可重试——
   * 一次抖动就把整轮 run 判死。
   */
  test('Bun 实测：The operation timed out.', () => {
    const e = classifyProviderError(P, transport('ETIMEDOUT', 'The operation timed out.'))
    expect(e.code).toBe('network_error')
    expect(e.retryable).toBe(true)
  })

  test('Bun 实测：The socket connection was closed unexpectedly.', () => {
    const e = classifyProviderError(P, new Error('The socket connection was closed unexpectedly.'))
    expect(e.code).toBe('network_error')
    expect(e.retryable).toBe(true)
  })

  /**
   * 证书错误判成可重试是**权衡后的选择**：它既可能是握手撞上抖动（重试就好），
   * 也可能是代理或自签名证书没被信任（重试没用）。判错成不可重试的代价更大，
   * 所以选可重试——但文案必须同时点出两种可能，否则配错代理的人会去查网络。
   */
  test('Bun 实测：unknown certificate verification error', () => {
    const e = classifyProviderError(
      P,
      transport('UNKNOWN_CERTIFICATE_VERIFICATION_ERROR', 'unknown certificate verification error'),
    )
    expect(e.code).toBe('network_error')
    expect(e.retryable).toBe(true)
    expect(e.message).toMatch(/证书|代理/)
  })

  test('code 优先于文案：文案没线索也能靠 code 认出来', () => {
    const e = classifyProviderError(P, transport('ECONNRESET', 'read'))
    expect(e.code).toBe('network_error')
    expect(e.retryable).toBe(true)
  })

  test('Node 那套文案继续认，别修一头坏一头', () => {
    for (const m of [
      'fetch failed',
      'connect ECONNREFUSED 127.0.0.1:443',
      'getaddrinfo ENOTFOUND',
    ]) {
      const e = classifyProviderError(P, new Error(m))
      expect(e.code).toBe('network_error')
    }
  })

  /** 不能把什么都当网络错误——真正的内部错误要留在 internal_error 里。 */
  test('无关的错误不被误判成网络问题', () => {
    const e = classifyProviderError(P, new Error('Cannot read properties of undefined'))
    expect(e.code).toBe('internal_error')
    expect(e.retryable).toBe(false)
  })
})

describe('用户中断不是错误', () => {
  test('AbortError 不报网络问题也不重试', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    const e = classifyProviderError(P, err)
    expect(e.retryable).toBe(false)
    expect(e.message).toBe('已取消')
  })
})

describe('按用户的下一步动作分类', () => {
  test('401 未配置与 401 key 无效是两条不同的引导', () => {
    expect(classifyProviderError(P, http(401, 'API key missing')).code).toBe('no_api_key')
    expect(classifyProviderError(P, http(401, 'Incorrect API key')).code).toBe('auth_failed')
  })

  /** 限速等一下能好，欠费等多久都不会好。混一起会让用户对着永不成功的重试狂点。 */
  test('429 分限速与额度耗尽', () => {
    const limited = classifyProviderError(P, http(429, 'Rate limit reached'))
    expect(limited.code).toBe('rate_limited')
    expect(limited.retryable).toBe(true)

    const broke = classifyProviderError(P, http(429, 'You exceeded your current quota'))
    expect(broke.code).toBe('insufficient_quota')
    expect(broke.retryable).toBe(false)
  })

  test('404 指向模型名或接口地址，而不是「服务不可用」', () => {
    expect(classifyProviderError(P, http(404)).code).toBe('model_not_found')
  })

  test('5xx 可重试', () => {
    for (const s of [500, 502, 503, 529]) {
      expect(classifyProviderError(P, http(s)).retryable).toBe(true)
    }
  })

  /**
   * `max_tokens must be ≤ 8192` 是**输出**参数校验。判成上下文超限会触发一次
   * 毫无用处的压缩重发，而重发的参数错误一模一样——烧钱的死循环。
   */
  test('400 的参数错误不带 capacity，压缩不会被触发', () => {
    const e = classifyProviderError(P, http(400, 'max_tokens must be less than or equal to 8192'))
    expect(e.capacity).toBeUndefined()
    expect(e.code).toBe('provider_unavailable')
  })

  /** 413 走到这里说明容量分类器已经否掉它了 —— 那是网关体积限制，不是上下文超限。 */
  test('413 指向附件大小与反代配置', () => {
    const e = classifyProviderError(P, http(413))
    expect(e.code).toBe('provider_unavailable')
    expect(e.message).toMatch(/附件|反代|网关/)
  })
})

describe('已经分好类的不再动它', () => {
  test('ProviderError 原样返回，不会被二次归类', () => {
    const original = new ProviderError({
      code: 'context_overflow',
      message: '超了',
      retryable: false,
      provider: P,
    })
    expect(classifyProviderError(P, original)).toBe(original)
  })
})
