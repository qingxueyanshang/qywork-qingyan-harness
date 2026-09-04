import { describe, expect, test } from 'bun:test'
import { lookupModel } from './catalog.ts'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'

const base = { kind: 'openai_chat_completions' as const, model: 'deepseek-v4-flash' }

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
  })

  test('只有空白也算没配', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '   \n' })).code).toBe('no_api_key')
  })

  test('报错里带上该做什么', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '' })).message).toContain('qy init')
  })

  test('anthropic 同样适用', () => {
    expect(
      grab(() => buildAdapter({ kind: 'anthropic_messages', model: 'claude-opus-5', apiKey: '' }))
        .code,
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

/**
 * 传输参数：**两个 SDK 的出厂值必须被覆盖掉。**
 *
 * `@anthropic-ai/sdk` 与 `openai` 都是 `timeout: 600_000` + `maxRetries: 2`。
 * 网络断掉时那组值的表现是：界面挂着「正在执行」好几分钟，然后才报网络不可达
 * （实测一条 381.9s 的 run，最后一次模型回包之后空等了 301s，三次连接尝试）。
 *
 * 读的是客户端实例上的字段，不是「传进去的那个对象」——中间少写一层展开、
 * 或者被后面的 `...profile` 覆盖掉，都是这条断言抓得住而参数快照抓不住的。
 */
describe('连接超时与重试次数由这边定，不用 SDK 的出厂值', () => {
  const clientOf = (a: unknown) => (a as { client: { timeout: number; maxRetries: number } }).client

  test('openai 兼容协议：兜底 600 秒、不自动重试', () => {
    const c = clientOf(buildAdapter({ ...base, apiKey: 'sk-x' }))
    expect(c.timeout).toBe(600_000)
    expect(c.maxRetries).toBe(0)
  })

  test('anthropic 原生同一套值', () => {
    const c = clientOf(
      buildAdapter({ kind: 'anthropic_messages', model: 'claude-opus-5', apiKey: 'sk-x' }),
    )
    expect(c.timeout).toBe(600_000)
    expect(c.maxRetries).toBe(0)
  })

  /** baseUrl / headers 排在展开之后，不能把这两个值挤掉。 */
  test('自定义端点与请求头不会覆盖掉它', () => {
    const c = clientOf(
      buildAdapter({
        ...base,
        apiKey: 'sk-x',
        baseUrl: 'https://gateway.example.com/v1',
        headers: { 'x-foo': 'bar' },
      }),
    )
    expect(c.timeout).toBe(600_000)
    expect(c.maxRetries).toBe(0)
  })
})

/**
 * 模型规格只有「目录 seed → 模型库」两层。端点 transport 是独立的传输门控：
 * 它只能收起当前路线发不出去的控制面，不能改模型窗口、价格或凭空增加档位。
 */
describe('两层解析：目录 seed → 模型库', () => {
  const seed = () => lookupModel('deepseek-v4-flash', 'openai_chat_completions')

  test('库里写的上限直接生效，不与目录取小', () => {
    expect(
      buildAdapter({ ...base, apiKey: 'sk-x', spec: { maxOutputTokens: 512 } }).spec
        .maxOutputTokens,
    ).toBe(512)
  })

  /** 比目录大也照写：目录是抄来的 seed，厂商放宽之后只有用户改得动它。 */
  test('库里的值比目录大也照写', () => {
    const bigger = (seed().maxOutputTokens ?? 0) + 1000
    expect(
      buildAdapter({ ...base, apiKey: 'sk-x', spec: { maxOutputTokens: bigger } }).spec
        .maxOutputTokens,
    ).toBe(bigger)
  })

  test('库里没写的字段照 seed', () => {
    const a = buildAdapter({ ...base, apiKey: 'sk-x', spec: { maxOutputTokens: 512 } })
    expect(a.spec.contextWindow).toBe(seed().contextWindow)
    expect(a.spec.thinking).toBe(seed().thinking)
  })
})
