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
import { OpenAICompatAdapter } from './openai-compat.ts'

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
    kind: 'openai_compatible',
    apiKey: 'sk-x',
    model,
    baseUrl: base,
  }
  const adapter = new OpenAICompatAdapter(profile, lookupModel(model, 'openai_compatible'))
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
    expect((await send('gemini-3.1-pro', 'low')).reasoning_effort).toBe('low')
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
