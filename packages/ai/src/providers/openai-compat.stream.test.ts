/**
 * 兼容适配器的真实 HTTP 路径：fetch → SSE → 事件 → 终态。
 *
 * 覆盖 `openai-compat.ts` 的 `stream()` 结束判定。同目录的 `openai-compat.test.ts`
 * 测试纯函数（请求体装配、思考标签切分、工具定义），无法锁定「流未按协议结束
 * 时该轮是否视为完成」这一判定。
 *
 * 报文取自实测，不得自行编写。以下字节逐字取自 2026-08-21 对某中转端点
 * （模型 `ox-alpha-free`）的一次实测：同一请求形状，约一半次数在 reasoning 中途
 * 结束响应体，另一半正常结束于 `finish_reason: "length"`。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { unknownModel } from '../catalog.ts'
import { ProviderError } from '../errors.ts'
import { STREAM_IDLE_TIMEOUT_MS } from '../transport.ts'
import type { ChatRequest, ProviderEvent } from '../types.ts'
import { OpenAICompatAdapter } from './openai-compat.ts'

const ID = '2026082201353989830c71e3884968'

function reasoning(text: string): string {
  return `data: {"id":"${ID}","object":"chat.completion.chunk","created":1787333739,"model":"ox-alpha-free","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":${JSON.stringify(text)}}}]}\n\n`
}

/** 思考中途响应体结束：没有 finish_reason、usage 与 [DONE]。 */
const CUT = reasoning('The user wants a 3D anime') + reasoning(' racing game') + reasoning(' >')

/**
 * 用量 chunk 已到达，结束 chunk 未到达。
 *
 * 取自 2026-08-22 对同一端点的实测：断流样本带有 `completion_tokens`
 * （6476 / 5126 各一次），表明上游很可能已经计费。
 */
const CUT_WITH_USAGE =
  reasoning('The user wants a 3D anime') +
  `data: {"id":"${ID}","object":"chat.completion.chunk","created":1787333739,"model":"ox-alpha-free","choices":[],"usage":{"prompt_tokens":466,"completion_tokens":6476,"total_tokens":6942,"prompt_tokens_details":{"cached_tokens":256},"completion_tokens_details":{"reasoning_tokens":6476}}}

` +
  reasoning(' racing game')

/** 正常结束：输出上限在思考阶段耗尽，正文为空。 */
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
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
  }
}

/** 读完一条流。抛出的错误随事件一并返回：终态须与「断开之前收到的内容」一同检查。 */
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

describe('流未按协议结束', () => {
  test('流对象建立事件早于模型内容', async () => {
    const { events } = await run(TRUNCATED)
    const started = events.findIndex((e) => e.type === 'response_started')
    const content = events.findIndex((e) => e.type === 'thinking_delta' || e.type === 'text_delta')
    expect(started).toBeGreaterThan(0)
    expect(content).toBeGreaterThan(started)
  })

  test('思考中途断流时报错，不记为正常完成', async () => {
    const { events, err } = await run(CUT)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).code).toBe('network_error')
    expect(events.some((e) => e.type === 'done')).toBe(false)
    // 断流之前收到的思考照常输出：报错针对的是该轮的终态，而非已读取的字节。
    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(3)
  })

  /**
   * 失败诊断须能区分「排队中」与「连接已断开」：错误附带传输层读数，
   * 服务端排队时发送的 `:` 保活行也计入其中。
   */
  test('断流错误附带传输层读数：状态码、字节数与保活行', async () => {
    const { err } = await run(`: keep-alive\n\n: keep-alive\n\n${CUT}`)
    expect(err).toBeInstanceOf(ProviderError)
    const transport = (err as ProviderError).transport
    expect(transport).toMatchObject({ status: 200, keepAliveLines: 2 })
    expect(transport?.bytes).toBeGreaterThan(0)
    expect(transport?.headersAfterMs).not.toBeNull()
    expect(transport?.sinceLastByteMs).not.toBeNull()
  })

  test('用量已到达而结束 chunk 未到达时，真实用量附在错误上，账本不记零', async () => {
    const { err } = await run(CUT_WITH_USAGE)
    expect(err).toBeInstanceOf(ProviderError)
    // 缺失不等于零：该 chunk 有数值时必须上报，`loop` 据此记账。
    expect((err as ProviderError).usage).toMatchObject({
      outputTokens: 6476,
      cachedTokens: 256,
      source: 'provider',
    })
  })

  test('未回报任何用量时，不虚构零用量', async () => {
    const { err } = await run(CUT)
    expect((err as ProviderError).usage).toBeUndefined()
  })

  test('收到 finish_reason 时正常结束，输出上限报告为截断', async () => {
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
