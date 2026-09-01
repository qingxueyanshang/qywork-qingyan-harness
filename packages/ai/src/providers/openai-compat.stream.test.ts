/**
 * 兼容适配器的**真实 HTTP 路径**：fetch → SSE → 事件 → 终态。
 *
 * 覆盖 `openai-compat.ts` 的 `stream()` 收尾判定。隔壁 `openai-compat.test.ts`
 * 测的是纯函数（请求体装配、思考标签切分、工具定义），它锁不住「流没按协议收尾
 * 时这一轮算不算完成」——而那正是出过错的地方。
 *
 * **报文取自实测，不得自拟。** 下面的字节逐字取自 2026-08-21 对某中转端点
 * （模型 `ox-alpha-free`）的一次实测：同一个请求形状，一半的次数在 reasoning 中途
 * 直接结束响应体，另一半正常收在 `finish_reason: "length"`。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { unknownModel } from '../catalog.ts'
import { ProviderError } from '../errors.ts'
import type { ChatRequest, ProviderEvent } from '../types.ts'
import { OpenAICompatAdapter } from './openai-compat.ts'

const ID = '2026082201353989830c71e3884968'

function reasoning(text: string): string {
  return `data: {"id":"${ID}","object":"chat.completion.chunk","created":1787333739,"model":"ox-alpha-free","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":${JSON.stringify(text)}}}]}\n\n`
}

/** 思考到一半响应体就结束了：没有 finish_reason、没有 usage、没有 [DONE]。 */
const CUT = reasoning('The user wants a 3D anime') + reasoning(' racing game') + reasoning(' >')

/**
 * 用量那一格到了、收尾那一格没到。
 *
 * 取自 2026-08-22 对同一端点的实测：断流样本带着 `completion_tokens`
 * （6476 / 5126 各一次），说明上游很可能已经计了费。
 */
const CUT_WITH_USAGE =
  reasoning('The user wants a 3D anime') +
  `data: {"id":"${ID}","object":"chat.completion.chunk","created":1787333739,"model":"ox-alpha-free","choices":[],"usage":{"prompt_tokens":466,"completion_tokens":6476,"total_tokens":6942,"prompt_tokens_details":{"cached_tokens":256},"completion_tokens_details":{"reasoning_tokens":6476}}}

` +
  reasoning(' racing game')

/** 正常收尾：输出上限烧完在思考里，正文一个字都没有。 */
const TRUNCATED =
  reasoning('The user wants a 3D anime') +
  reasoning(') shoulders') +
  `data: {"id":"${ID}","object":"chat.completion.chunk","created":1787333368,"model":"ox-alpha-free","choices":[{"index":0,"finish_reason":"length","delta":{"role":"assistant","content":""}}],"usage":{"prompt_tokens":4581,"completion_tokens":8192,"total_tokens":12773,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":3587}}}\n\n` +
  'data: [DONE]\n\n' +
  'data: {"choices":[],"cost":"0"}\n\n'

let body = ''
const server = Bun.serve({
  port: 0,
  fetch: () =>
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
})
const BASE = `http://127.0.0.1:${server.port}/v1`

afterAll(() => server.stop(true))

function request(): ChatRequest {
  return {
    model: 'ox-alpha-free',
    system: [{ text: 'You are a coding agent.' }],
    messages: [{ role: 'user', content: '帮我做一个 3D 赛车游戏' }],
    tools: [],
    maxOutputTokens: 8192,
  }
}

/** 跑完一条流。抛出的错随事件一起给出来——终态和「断之前收到了什么」要一起看。 */
async function run(sse: string): Promise<{ events: ProviderEvent[]; err: unknown }> {
  body = sse
  const adapter = new OpenAICompatAdapter(
    { kind: 'openai_chat_completions', apiKey: 'sk-test', baseUrl: BASE, model: 'ox-alpha-free' },
    unknownModel('ox-alpha-free', 'openai_chat_completions'),
  )
  const events: ProviderEvent[] = []
  try {
    for await (const ev of adapter.stream(request())) events.push(ev)
    return { events, err: null }
  } catch (err) {
    return { events, err }
  }
}

describe('流没按协议收尾', () => {
  test('流对象建立事件早于模型内容', async () => {
    const { events } = await run(TRUNCATED)
    const started = events.findIndex((e) => e.type === 'response_started')
    const content = events.findIndex((e) => e.type === 'thinking_delta' || e.type === 'text_delta')
    expect(started).toBeGreaterThan(0)
    expect(content).toBeGreaterThan(started)
  })

  test('思考中途断流报错，不落成正常完成', async () => {
    const { events, err } = await run(CUT)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).code).toBe('network_error')
    expect(events.some((e) => e.type === 'done')).toBe(false)
    // 断之前收到的思考照常输出：报错的是这一轮的终态，不是已经读到的字节。
    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(3)
  })

  test('用量先到收尾没到的，把实数挂在错误上——账本不记零', async () => {
    const { err } = await run(CUT_WITH_USAGE)
    expect(err).toBeInstanceOf(ProviderError)
    // 缺席不等于零：这一格有数就必须传上去，`loop` 据它落账。
    expect((err as ProviderError).usage).toMatchObject({
      outputTokens: 6476,
      cachedTokens: 256,
      source: 'provider',
    })
  })

  test('一个用量字节都没回报的，不编一份零用量出来', async () => {
    const { err } = await run(CUT)
    expect((err as ProviderError).usage).toBeUndefined()
  })

  test('收到 finish_reason 的照常收尾，输出上限报成截断', async () => {
    const { events, err } = await run(TRUNCATED)
    expect(err).toBeNull()
    expect(events.find((e) => e.type === 'done')).toMatchObject({
      stopReason: 'max_tokens',
      rawStopReason: 'length',
    })
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { outputTokens: 8192, source: 'provider' },
    })
  })
})
