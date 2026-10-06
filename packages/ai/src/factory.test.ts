import { describe, expect, test } from 'bun:test'
import { builtinCatalog, lookupModel, officialBaseUrl, VENDORS } from './catalog.ts'
import { ProviderError } from './errors.ts'
import { buildAdapter } from './factory.ts'
import { probeModel } from './probe.ts'
import type { ProviderProfile } from './types.ts'

const base = { kind: 'openai_chat_completions' as const, model: 'deepseek-flash' }

describe('Base URL 留空时按模型库解析官方地址', () => {
  const examples: [ProviderProfile['kind'], string, string][] = [
    ['openai_chat_completions', 'deepseek-flash', 'https://api.deepseek.com/v1/chat/completions'],
    ['openai_responses', 'deepseek-flash', 'https://api.deepseek.com/v1/responses'],
    ['anthropic_messages', 'deepseek-flash', 'https://api.deepseek.com/anthropic/v1/messages'],
    ['openai_chat_completions', 'mimo-v2.6-pro', 'https://api.xiaomimimo.com/v1/chat/completions'],
    ['openai_responses', 'mimo-v2.6-pro', 'https://api.xiaomimimo.com/v1/responses'],
    ['anthropic_messages', 'claude-opus-5', 'https://api.anthropic.com/v1/messages'],
    ['openai_responses', 'gpt-6-sol', 'https://api.openai.com/v1/responses'],
    [
      'openai_chat_completions',
      'gemini-3.8-flash',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ],
    [
      'openai_chat_completions',
      'glm-5.3-flash',
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    ],
  ]

  for (const [kind, model, url] of examples) {
    test(`${model} / ${kind} 的检测请求使用官方地址且保留凭证`, async () => {
      const original = globalThis.fetch
      let captured: { url: string; model: string; credential: string | null } | undefined
      globalThis.fetch = (async (input, init) => {
        const headers = new Headers(init?.headers)
        captured = {
          url: String(input),
          model: JSON.parse(String(init?.body)).model,
          credential: headers.get(kind === 'anthropic_messages' ? 'x-api-key' : 'authorization'),
        }
        return new Response(JSON.stringify({ error: { message: 'test rejection' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch
      try {
        const result = await probeModel({ kind, model, apiKey: 'sk-test', baseUrl: '  ' })
        expect(result.reachable).toBe(false)
        expect(captured).toEqual({
          url,
          model,
          credential: kind === 'anthropic_messages' ? 'sk-test' : 'Bearer sk-test',
        })
      } finally {
        globalThis.fetch = original
      }
    })
  }

  test('库中每个厂商至少有一个可用的官方默认协议', () => {
    for (const vendor of VENDORS) {
      expect(builtinCatalog().some((m) => m.vendor === vendor.id && officialBaseUrl(m))).toBe(true)
    }
  })

  test('显式中转、套餐和本地地址始终优先，不按已知模型改换厂商', async () => {
    const original = globalThis.fetch
    let actual = ''
    globalThis.fetch = (async (input) => {
      actual = String(input)
      return new Response(JSON.stringify({ error: { message: 'test rejection' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      for (const root of [
        'https://relay.example',
        'https://token-plan-cn.xiaomimimo.com',
        'http://127.0.0.1:11434',
      ]) {
        for (const kind of [
          'openai_chat_completions',
          'openai_responses',
          'anthropic_messages',
        ] as const) {
          const baseUrl = `${root}/${kind === 'anthropic_messages' ? 'anthropic' : 'v1'}`
          const profile = { kind, model: 'mimo-v2.6-pro', apiKey: 'sk-test', baseUrl }
          await probeModel(profile)
          const suffix =
            kind === 'anthropic_messages'
              ? '/v1/messages'
              : kind === 'openai_responses'
                ? '/responses'
                : '/chat/completions'
          expect(actual).toBe(`${baseUrl}${suffix}`)
          expect(profile.baseUrl).toBe(baseUrl)
        }
      }
    } finally {
      globalThis.fetch = original
    }
  })

  test('未知模型及未登记的协议要求地址，不默认为 OpenAI', () => {
    for (const profile of [
      { ...base, model: 'DeepSeek-V4.1-Flash' },
      { kind: 'anthropic_messages' as const, model: 'gpt-6-sol' },
    ]) {
      const error = grab(() => buildAdapter({ ...profile, apiKey: 'sk-test' }))
      expect(error.code).toBe('invalid_request')
      expect(error.message).toContain('请填写 Base URL')
    }
    expect(
      buildAdapter({
        ...base,
        model: 'custom',
        apiKey: 'sk-test',
        baseUrl: 'https://relay.example/v1',
      }).spec.id,
    ).toBe('custom')
  })

  test('用户在模型库显式绑定厂商后使用对应官方地址', () => {
    const adapter = buildAdapter({
      ...base,
      model: 'custom',
      apiKey: 'sk-test',
      spec: { vendor: 'deepseek' },
    })
    expect((adapter as unknown as { baseUrl: string }).baseUrl).toBe('https://api.deepseek.com/v1')
  })
})

function grab(fn: () => unknown): ProviderError {
  try {
    fn()
  } catch (err) {
    if (err instanceof ProviderError) return err
    throw err
  }
  throw new Error('应当抛出 ProviderError')
}

describe('空 key 在本地判定，不发送请求', () => {
  test('空 key 抛出 no_api_key，而不是等待 401 返回后推测', () => {
    const e = grab(() => buildAdapter({ ...base, apiKey: '' }))
    expect(e.code).toBe('no_api_key')
    // auth_failed 会引导新用户检查 key 是否填写有误，而此时 key 尚未配置。
    expect(e.code).not.toBe('auth_failed')
  })

  test('只含空白字符同样视为未配置', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '   \n' })).code).toBe('no_api_key')
  })

  test('报错中包含处理方法', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '' })).message).toContain('qy init')
  })

  test('anthropic 同样适用', () => {
    expect(
      grab(() => buildAdapter({ kind: 'anthropic_messages', model: 'claude-opus-5', apiKey: '' }))
        .code,
    ).toBe('no_api_key')
  })

  test('有 key 时正常创建适配器', () => {
    expect(buildAdapter({ ...base, apiKey: 'sk-x' }).spec.id).toBe('deepseek-flash')
  })
})

describe('本机模型服务豁免：空 key 是合法配置', () => {
  for (const url of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:8000/v1',
    'https://ollama.localhost/v1',
  ]) {
    test(`${url} 允许空 key`, () => {
      expect(buildAdapter({ ...base, apiKey: '', baseUrl: url }).spec.id).toBe('deepseek-flash')
    })
  }

  test('局域网中的其他机器不豁免：它可能位于需要鉴权的反向代理之后', () => {
    expect(
      grab(() => buildAdapter({ ...base, apiKey: '', baseUrl: 'http://192.168.1.9:11434/v1' }))
        .code,
    ).toBe('no_api_key')
  })

  test('域名含 localhost 但主机不是 localhost 时不豁免', () => {
    expect(
      grab(() => buildAdapter({ ...base, apiKey: '', baseUrl: 'https://localhost.evil.com/v1' }))
        .code,
    ).toBe('no_api_key')
  })

  test('baseUrl 不是合法 URL 时不豁免', () => {
    expect(grab(() => buildAdapter({ ...base, apiKey: '', baseUrl: '不是地址' })).code).toBe(
      'no_api_key',
    )
  })
})

/**
 * 传输参数：**必须覆盖两个 SDK 的默认值。**
 *
 * `@anthropic-ai/sdk` 与 `openai` 都是 `timeout: 600_000` + `maxRetries: 2`。
 * 使用这组默认值时，网络中断后界面持续显示「正在执行」数分钟，之后才报告网络不可达
 * （实测一次 381.9s 的 run，最后一次收到模型响应后空等 301s，共三次连接尝试）。
 *
 * 读取的是客户端实例上的字段，不是传入的参数对象：中间遗漏一层展开、
 * 或被后面的 `...profile` 覆盖，该断言都能发现，而参数快照无法发现。
 */
describe('连接超时与重试次数由本项目设定，不使用 SDK 的默认值', () => {
  const clientOf = (a: unknown) => (a as { client: { timeout: number; maxRetries: number } }).client

  test('openai 兼容协议：超时上限 600 秒，不自动重试', () => {
    const c = clientOf(buildAdapter({ ...base, apiKey: 'sk-x' }))
    expect(c.timeout).toBe(600_000)
    expect(c.maxRetries).toBe(0)
  })

  test('anthropic 原生协议使用相同取值', () => {
    const c = clientOf(
      buildAdapter({ kind: 'anthropic_messages', model: 'claude-opus-5', apiKey: 'sk-x' }),
    )
    expect(c.timeout).toBe(600_000)
    expect(c.maxRetries).toBe(0)
  })

  /** baseUrl / headers 位于展开之后，不能覆盖这两个值。 */
  test('自定义端点与请求头不会覆盖传输参数', () => {
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
 * 模型规格由目录 seed 与用户模型库声明；端点检测只覆盖思考参数，不改窗口或价格。
 */
describe('两层解析：目录 seed → 模型库', () => {
  const seed = () => lookupModel('deepseek-flash', 'openai_chat_completions')

  test('模型库中填写的上限直接生效，不与目录取较小值', () => {
    expect(
      buildAdapter({ ...base, apiKey: 'sk-x', spec: { maxOutputTokens: 512 } }).spec
        .maxOutputTokens,
    ).toBe(512)
  })

  /** 大于目录值时同样生效：目录只是录入的 seed，厂商放宽上限后只有用户能修改。 */
  test('模型库中的值大于目录值时同样生效', () => {
    const bigger = (seed().maxOutputTokens ?? 0) + 1000
    expect(
      buildAdapter({ ...base, apiKey: 'sk-x', spec: { maxOutputTokens: bigger } }).spec
        .maxOutputTokens,
    ).toBe(bigger)
  })

  test('模型库未填写的字段沿用 seed', () => {
    const a = buildAdapter({ ...base, apiKey: 'sk-x', spec: { maxOutputTokens: 512 } })
    expect(a.spec.contextWindow).toBe(seed().contextWindow)
    expect(a.spec.thinking).toBe(seed().thinking)
  })
})
