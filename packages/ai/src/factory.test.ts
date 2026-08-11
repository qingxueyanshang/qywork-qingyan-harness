import { describe, expect, test } from 'bun:test'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'

const base = { kind: 'openai_compatible' as const, model: 'deepseek-v4-flash' }

function grab(fn: () => unknown): ProviderError {
  try {
    fn()
  } catch (err) {
    if (err instanceof ProviderError) return err
    throw err
  }
  throw new Error('应当抛出 ProviderError')
}

describe('空 key 在本地就判定，不发请求', () => {
  test('空 key 抛 no_api_key 而不是等 401 回来猜', () => {
    const e = grab(() => buildAdapter({ ...base, apiKey: '' }))
    expect(e.code).toBe('no_api_key')
    // auth_failed 会把新用户引向「检查 key 抄错没抄错」，而它根本还不存在。
    expect(e.code).not.toBe('auth_failed')
    expect(e.retryable).toBe(false)
  })

  test('只有空白也算没配', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '   \n' })).code).toBe('no_api_key')
  })

  test('报错里带上该做什么', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '' })).message).toContain('qy init')
  })

  test('anthropic 同样适用', () => {
    expect(
      grab(() => buildAdapter({ kind: 'anthropic', model: 'claude-opus-5', apiKey: '' })).code,
    ).toBe('no_api_key')
  })

  test('有 key 时正常建出适配器', () => {
    expect(buildAdapter({ ...base, apiKey: 'sk-x' }).spec.id).toBe('deepseek-v4-flash')
  })
})

describe('本机模型服务豁免 —— 那里空 key 是合法配置', () => {
  for (const url of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:8000/v1',
    'https://ollama.localhost/v1',
  ]) {
    test(`${url} 允许空 key`, () => {
      expect(buildAdapter({ ...base, apiKey: '', baseUrl: url }).spec.id).toBe('deepseek-v4-flash')
    })
  }

  test('局域网里的另一台机器不豁免 —— 它可能挂在需要鉴权的反代后面', () => {
    expect(
      grab(() => buildAdapter({ ...base, apiKey: '', baseUrl: 'http://192.168.1.9:11434/v1' }))
        .code,
    ).toBe('no_api_key')
  })

  test('域名里含 localhost 但主机不是它 —— 不豁免', () => {
    expect(
      grab(() => buildAdapter({ ...base, apiKey: '', baseUrl: 'https://localhost.evil.com/v1' }))
        .code,
    ).toBe('no_api_key')
  })

  test('baseUrl 不是合法 URL 时不豁免（宁可多要一个 key）', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '', baseUrl: '不是地址' })).code).toBe(
      'no_api_key',
    )
  })
})
