/**
 * 兼容协议实际发出去的思考控制字段。覆盖 `openai-compat.ts` 的 `buildReasoning`。
 *
 * **必须看真实请求体**，不能只测那个纯函数：这条链路上一次出问题正是
 * 「目录里声明了档位、界面也画了控件、请求里一个字段都没有」——
 * 两头都对，中间那节把值丢了，而任何一端的单测都看不见。
 *
 * 所以这里起一个本机 server 当端点，把收到的 body 原样存下来。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { lookupModel } from '../catalog.ts'
import type { ProviderProfile } from '../types.ts'
import { normalizeBaseUrl, OpenAICompatAdapter } from './openai-compat.ts'

const bodies: Record<string, unknown>[] = []
let server: ReturnType<typeof Bun.serve>
let base = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push((await req.json()) as Record<string, unknown>)
      // 最小可解析的 SSE：一个 delta + 一个终止。适配器只要能读完就行。
      const body =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}/v1`
})

afterAll(() => server.stop(true))

async function send(model: string, effort?: string): Promise<Record<string, unknown>> {
  bodies.length = 0
  const profile: ProviderProfile = {
    kind: 'openai_chat_completions',
    apiKey: 'sk-x',
    model,
    baseUrl: base,
  }
  const adapter = new OpenAICompatAdapter(profile, lookupModel(model, 'openai_chat_completions'))
  for await (const _ of adapter.stream({
    model,
    system: [],
    messages: [{ role: 'user', content: '嗨' }],
    tools: [],
    maxOutputTokens: 64,
    ...(effort ? { effort: effort as never } : {}),
    signal: new AbortController().signal,
  })) {
    // 读完即可，产出不关心。
  }
  return bodies[0]!
}

describe('DeepSeek 要两个字段一起发', () => {
  /**
   * 复现原始失败形状：本仓之前只发过 `reasoning_effort`，实测得出「每一档
   * reasoning_tokens 都一样」，据此把 DeepSeek 记成「不支持 effort」。
   * 现象没错，归因错了——`thinking` 开关没开，思考压根没启动。
   */
  test('thinking 开关和档位同时出现在请求体里', async () => {
    const body = await send('deepseek-v4-flash', 'max')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })

  test('没指定档位就一个字段都不发', async () => {
    const body = await send('deepseek-v4-flash')
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('OpenAI 那套只发 reasoning_effort', () => {
  test('不带 DeepSeek 的 thinking 开关', async () => {
    const body = await send('gpt-5.6-sol', 'high')
    expect(body.reasoning_effort).toBe('high')
    expect('thinking' in body).toBe(false)
  })

  test('Gemini 同样走这条', async () => {
    expect((await send('gemini-3.1-pro-preview', 'low')).reasoning_effort).toBe('low')
  })
})

/**
 * 档位不在这个模型的档位面里，一个字节都不发。
 *
 * 另两条协议各有各的写法：`openai-responses` 是
 * `effortLevels.includes(req.effort) ? … : undefined`，`anthropic` 会降到最高可用档。
 * 这条别只判「有没有给」就把 `effort` 原样发出去。
 *
 * 只调一家模型时档位面一致，用不上这道闸；本仓不是：档位选定值挂在
 * 「接口 × 模型」那一格，同一个模型换条协议档位面就变，Agent Team 的角色还
 * 各带各的模型。越界值到这里不拦，就是发给 provider 的一个 400。
 */
describe('越界的档位不发', () => {
  /** DeepSeek 只有 high/max。`xhigh` 是 Claude 那边的档，它在这里不存在。 */
  test('DeepSeek 收不到 xhigh', async () => {
    const body = await send('deepseek-v4-flash', 'xhigh')
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })

  /** Gemini 只有 low/medium/high，`max` 同样越界。 */
  test('Gemini 收不到 max', async () => {
    expect('reasoning_effort' in (await send('gemini-3.1-pro', 'max'))).toBe(false)
  })

  /** 档位面里的照常发——这道闸只拦越界的，不是把 effort 整个关掉。 */
  test('档位面里的照常发', async () => {
    const body = await send('deepseek-v4-flash', 'high')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })
})

describe('不该发的时候一个字节都不多发', () => {
  /**
   * 自建端点 / 中转站的模型目录里没有，`unknownModel()` 的 `thinking` 是 `'none'`。
   * 这条锁住的是：把兼容协议从「一律不发」改成「按模型发」之后，
   * **那些端点不会突然开始收到它没见过的键**——那会表现成「昨天还好好的，今天 400」。
   */
  test('未收录的模型不发思考字段', async () => {
    const body = await send('某个中转站上的模型', 'max')
    expect('reasoning_effort' in body).toBe(false)
    expect('thinking' in body).toBe(false)
  })

  /** 目录里明确没有思考能力的（Qwen 三款）同样不发。 */
  test('声明无思考能力的模型不发', async () => {
    const body = await send('qwen3.7-max', 'high')
    expect('reasoning_effort' in body).toBe(false)
  })

  /**
   * 经中转站以兼容协议调 Claude：`lookupModel` 的兜底会保留 Claude 的能力约束、
   * 只改写 provider，于是 `effortLevels` 还是那五档。但 Anthropic 的
   * `output_config.effort` 在这条协议上发不出去，所以**什么都不该发**。
   */
  test('中转的 Claude 不发 Anthropic 的思考字段', async () => {
    const body = await send('claude-opus-5', 'high')
    expect('reasoning_effort' in body).toBe(false)
    expect('thinking' in body).toBe(false)
    expect('output_config' in body).toBe(false)
  })
})

/**
 * Base URL 归一。
 *
 * 复现过的故障：用户填 `https://中转站/`（少了 `/v1`），SDK 于是请求
 * `https://中转站/chat/completions`，中转站对这种错误路径回 **200 + 一个 HTML 首页**。
 * 解析器读不出任何 chunk 也不报错，那一轮 0 token、0 步骤、`completed`
 * ——界面上是「消息发出去了，什么也没发生」。
 */
describe('Base URL 归一', () => {
  test('少了 /v1 就补上', () => {
    expect(normalizeBaseUrl('https://direct.example.xyz/')).toBe('https://direct.example.xyz/v1')
    expect(normalizeBaseUrl('https://direct.example.xyz')).toBe('https://direct.example.xyz/v1')
  })

  test('已经带了就原样，不会补成 /v1/v1', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
  })

  test('空值走官方根', () => {
    expect(normalizeBaseUrl(undefined)).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('   ')).toBe('https://api.openai.com/v1')
  })
})

describe('无名工具调用', () => {
  /**
   * 复现的是原始失败形状：中转站把工具名那一片丢了，旧代码 `continue` 掉整条调用，
   * 于是 provider 报 `tool_calls` 而我们一条都没有——run 记成正常完成、账本无痕。
   *
   * 这里断言的是**响亮地失败**：不再有「悄悄少一条调用」这种中间状态。
   */
  test('名字分片没到齐就报错，不静默丢弃', async () => {
    const drop = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          // 只有 id 与参数，从头到尾没有 function.name。
          [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
              '"function":{"arguments":"{}"}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    try {
      const adapter = new OpenAICompatAdapter(
        {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          model: 'deepseek-v4-flash',
          baseUrl: `http://127.0.0.1:${drop.port}/v1`,
        },
        lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
      )
      const run = async () => {
        for await (const _ of adapter.stream({
          model: 'deepseek-v4-flash',
          system: [],
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          maxOutputTokens: 64,
        })) {
          // 只关心它抛不抛，事件本身不看。
        }
      }
      expect(run()).rejects.toThrow(/没有名字的工具调用/)
    } finally {
      drop.stop(true)
    }
  })
})

describe('缓存路由亲和键', () => {
  /**
   * 复现的是一次真账：同一个中转站的 grok，前缀逐字节稳定（字节级测试证过），
   * 命中却在 192 与 16576 之间跳，随后整段会话连 `cached_tokens` 字段都不回。
   *
   * 成因是中转站在多个上游节点之间轮询，而隐式前缀缓存是按分片存的——
   * 不带 `prompt_cache_key` 就是每次随机落一个分片。这个字段本仓早就有、
   * `openai-responses` 也一直在发，只有这条路径漏了，而各家中转全走这条。
   *
   * 断言的是**上线字节**：装配层填了值不算数，要它真的出现在请求体里。
   */
  test('cacheKey 落成请求体里的 prompt_cache_key', async () => {
    bodies.length = 0
    const adapter = new OpenAICompatAdapter(
      {
        kind: 'openai_chat_completions',
        apiKey: 'sk-x',
        model: 'deepseek-v4-flash',
        baseUrl: base,
      },
      lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model: 'deepseek-v4-flash',
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      cacheKey: 'cv_0mt0x92q10000mx0dff',
      signal: new AbortController().signal,
    })) {
      // 只看请求体
    }
    expect(bodies[0]!.prompt_cache_key).toBe('cv_0mt0x92q10000mx0dff')
  })

  /** 没有键就一个字节都不发——自建端点不该因为这个开始收到它不认识的字段。 */
  test('没有 cacheKey 时不出现这个字段', async () => {
    const body = await send('deepseek-v4-flash')
    expect('prompt_cache_key' in body).toBe(false)
  })

  /**
   * **发不发由目录里那条模型说了算，不是协议说了算。**
   *
   * 未收录的模型（自建端点、中转站上那些没人探过的名字）落在 `cacheRouting: 'none'`
   * ——那是「没测过」不是「不支持」。往那些端点乱发未知字段，失败形状是
   * 「昨天还好好的，今天每条请求都 400」。要开就在模型库那一格改，或 `qy probe --save`。
   */
  test('未收录的模型不发亲和键', async () => {
    bodies.length = 0
    const model = '某个中转站上的模型'
    const spec = lookupModel(model, 'openai_chat_completions')
    expect(spec.cacheRouting).toBe('none')
    const adapter = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
      spec,
    )
    for await (const _ of adapter.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      cacheKey: 'cv_x',
      signal: new AbortController().signal,
    })) {
      // 只看请求体
    }
    expect('prompt_cache_key' in bodies[0]!).toBe(false)
  })
})
