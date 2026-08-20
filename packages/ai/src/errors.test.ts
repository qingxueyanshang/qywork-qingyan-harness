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
   * 判据必须按 **Bun** 的文案写。照 Node/undici 写的那套
   * （`/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i`）在下面三条真实
   * 失败上一条都匹配不上，全部落到 `internal_error` + 不可重试——
   * 一次抖动就把整轮 run 判死。
   */
  test('Bun 实测：The operation timed out.', () => {
    const e = classifyProviderError(P, transport('ETIMEDOUT', 'The operation timed out.'))
    expect(e.code).toBe('network_error')
  })

  test('Bun 实测：The socket connection was closed unexpectedly.', () => {
    const e = classifyProviderError(P, new Error('The socket connection was closed unexpectedly.'))
    expect(e.code).toBe('network_error')
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
    expect(e.message).toMatch(/证书|代理/)
  })

  test('code 优先于文案：文案没线索也能靠 code 认出来', () => {
    const e = classifyProviderError(P, transport('ECONNRESET', 'read'))
    expect(e.code).toBe('network_error')
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
  })
})

/**
 * 三支的分界。
 *
 * 这一组锁的是**每个码落哪一支**，不是文案好不好看。分错的代价很具体：
 * 「连不上」会把用户支去改接口地址（而问题是链路抖动），「被断开」会让他坐等重发
 * （而 key 根本没配对端口）。
 *
 * 尤其看住 `ECONNREFUSED`（压根没连上）与 `ECONNRESET`（连上了被重置）——
 * 它们长得像、含义相反，原来在同一条正则里，是这次拆分最容易修一头坏一头的地方。
 */
describe('传输失败分三支：连不上 / 被断开 / 超时', () => {
  const shapeOf = (err: unknown) => classifyProviderError(P, err).message

  test('没连上 → 连不上接口', () => {
    for (const err of [
      transport('ECONNREFUSED', 'connect'),
      transport('ENOTFOUND', 'dns'),
      transport('EHOSTUNREACH', ''),
      transport('EAI_AGAIN', ''),
      new Error('getaddrinfo ENOTFOUND api.deepseek.com'),
      new Error('fetch failed'),
      new Error('Connection error.'),
    ]) {
      expect(shapeOf(err)).toMatch(/连不上/)
    }
  })

  test('连上了又断 → 连接被断开', () => {
    for (const err of [
      transport('ECONNRESET', 'read'),
      transport('EPIPE', ''),
      transport('ERR_SOCKET_CLOSED', ''),
      // Bun 实测的那句，`code` 是空的，只能靠文案认。
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
      // SDK 自己那 60 秒掐的就是这一句，没有 code。
      new Error('Request timed out.'),
    ]) {
      expect(shapeOf(err)).toMatch(/超时/)
    }
  })

  test('三支都可重试，也都归到 network_error', () => {
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

describe('用户中断不是错误', () => {
  test('AbortError 不报网络问题也不重发', () => {
    const err = new Error('aborted')
    err.name = 'AbortError'
    const e = classifyProviderError(P, err)
    // internal_error 不在 loop.ts 的重发表里——用户按的停止不该被自动重发。
    expect(e.code).toBe('internal_error')
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

    const broke = classifyProviderError(P, http(429, 'You exceeded your current quota'))
    expect(broke.code).toBe('insufficient_quota')
  })

  test('404 指向模型名或接口地址，而不是「服务不可用」', () => {
    expect(classifyProviderError(P, http(404)).code).toBe('model_not_found')
  })

  test('5xx 归 provider_unavailable —— 这个码在 loop.ts 的重发表里', () => {
    for (const s of [500, 502, 503, 529]) {
      expect(classifyProviderError(P, http(s)).code).toBe('provider_unavailable')
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

  /**
   * 中转站会把「后端暂时不可用」发成 400 而不是 5xx。归 `provider_unavailable`
   * 才进得了 `loop.ts` 的重发表；判成别的码，一次上游抖动就终结整轮。
   */
  test('中转站用 400 报「暂时不可用」，仍归 provider_unavailable', () => {
    const e = classifyProviderError(
      P,
      http(400, '{"error":{"type":"<nil>","message":"暂不可用 请稍后再试"}}'),
    )
    expect(e.code).toBe('provider_unavailable')
    // 带上 capacity 会触发一次压缩重发，而这跟上下文长短无关。
    expect(e.capacity).toBeUndefined()
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
      provider: P,
    })
    expect(classifyProviderError(P, original)).toBe(original)
  })
})
