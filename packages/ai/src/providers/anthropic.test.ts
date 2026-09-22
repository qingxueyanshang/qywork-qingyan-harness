/**
 * 覆盖 `anthropic.ts` 的请求体装配：工具结果（含图片块）到 Messages 协议的
 * wire 形状。起本机 server 当端点，把收到的 body 原样存下来——公共层测试
 * 只能证明图片块存在，证明不了最后一个 serializer 没有改形或丢块。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { EffortLevel } from '@qywork/core'
import { lookupModel } from '../catalog.ts'
import type { ProviderEvent, ProviderProfile, WireMessage } from '../types.ts'
import { AnthropicAdapter } from './anthropic.ts'

const bodies: Record<string, unknown>[] = []
const requestHeaders: Headers[] = []
let lastEvents: ProviderEvent[] = []
let server: ReturnType<typeof Bun.serve>
let base = ''

/** SDK 能读完的最小事件流：一段正文 + end_turn 终态。 */
const SSE = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}`,
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requestHeaders.push(new Headers(req.headers))
      bodies.push((await req.json()) as Record<string, unknown>)
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

async function send(
  messages: WireMessage[],
  effort?: EffortLevel,
  model = 'claude-opus-5',
): Promise<Record<string, unknown>> {
  bodies.length = 0
  const profile: ProviderProfile = {
    kind: 'anthropic_messages',
    apiKey: 'sk-x',
    model,
    baseUrl: base,
  }
  const adapter = new AnthropicAdapter(profile, lookupModel(model, 'anthropic_messages'))
  lastEvents = []
  for await (const event of adapter.stream({
    model,
    system: [],
    messages,
    tools: [],
    maxOutputTokens: 64,
    ...(effort ? { effort } : {}),
    signal: new AbortController().signal,
  })) {
    lastEvents.push(event)
  }
  return bodies[0]!
}

describe('思考档位严格遵守用户选择', () => {
  test('MiMo 按 Messages 形状回传文本轮与工具轮思考，不发送伪强度', async () => {
    const body = await send(
      [
        { role: 'user', content: '开始' },
        { role: 'assistant', content: '计划', reasoningContent: '第一轮思考' },
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: '工具轮思考',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: { path: 'pelican-bike/index.html' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', content: '内容' },
      ],
      'high',
      'mimo-v2.6-pro',
    )
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('output_config')
    expect(body.messages).toMatchObject([
      { role: 'user' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '第一轮思考' },
          { type: 'text', text: '计划' },
        ],
      },
      { role: 'user' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '工具轮思考' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'read_file',
            input: { path: 'pelican-bike/index.html' },
          },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '内容' }] },
    ])
  })

  test('DeepSeek 三档使用 output_config，并完整回传文本轮和工具轮思考', async () => {
    const messages: WireMessage[] = [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答', reasoningContent: '第一轮思考' },
      { role: 'user', content: '查一下' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: '工具轮思考',
        toolCalls: [{ id: 'call_1', name: 'lookup', arguments: {} }],
      },
      { role: 'tool', content: '结果', toolCallId: 'call_1' },
    ]
    for (const effort of ['low', 'high', 'max'] as const) {
      const body = await send(messages, effort, 'deepseek-flash')
      expect(body.output_config).toEqual({ effort })
      expect(body.thinking).toBeUndefined()
      const history = body.messages as { content: Record<string, unknown>[] }[]
      expect(history[1]?.content).toEqual([
        { type: 'thinking', thinking: '第一轮思考' },
        { type: 'text', text: '第一答' },
      ])
      expect(history[3]?.content[0]).toEqual({ type: 'thinking', thinking: '工具轮思考' })
    }
  })

  test('message_start 早于模型内容进入遥测', async () => {
    await send([{ role: 'user', content: 'hi' }])
    const started = lastEvents.findIndex((e) => e.type === 'response_started')
    const content = lastEvents.findIndex(
      (e) => e.type === 'thinking_delta' || e.type === 'text_delta',
    )
    expect(started).toBeGreaterThan(0)
    expect(content).toBeGreaterThan(started)
  })

  test('模型明确支持的档位原样发送', async () => {
    const body = await send([{ role: 'user', content: 'hi' }], 'max')
    expect(body.output_config).toEqual({ effort: 'max' })
  })

  test('模型不支持的档位省略，不静默换成最高档', async () => {
    const body = await send([{ role: 'user', content: 'hi' }], 'minimal')
    expect(body).not.toHaveProperty('output_config')
  })
})

describe('工具结果带图片', () => {
  test('tool_result 落在 user 轮里，text 与 image 块顺序保留', async () => {
    const body = await send([
      { role: 'user', content: '看图' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c_img', name: 'read_file', arguments: { path: 'a.png' } }],
      },
      {
        role: 'tool',
        toolCallId: 'c_img',
        content: [
          { type: 'text', text: '{"status":"success"}' },
          { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'QUJD' } },
        ],
      },
    ])
    const messages = body.messages as { role: string; content: unknown }[]
    const toolTurn = messages.find(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type?: string }[]).some((b) => b.type === 'tool_result'),
    )
    expect(toolTurn).toBeDefined()
    expect(toolTurn!.role).toBe('user')
    // 合并用的内部标记不得进请求体。
    expect('_toolBatch' in toolTurn!).toBe(false)
    const block = (toolTurn!.content as Record<string, unknown>[]).find(
      (b) => b.type === 'tool_result',
    )!
    expect(block.tool_use_id).toBe('c_img')
    expect(block.content).toEqual([
      { type: 'text', text: '{"status":"success"}' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ])
  })

  test('收纳后的图片省略标记逐字进入 tool_result', async () => {
    const omitted = '{"call_id":"c_img","status":"success","images_omitted":true}'
    const body = await send([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c_img', name: 'read_file', arguments: { path: 'a.png' } }],
      },
      { role: 'tool', toolCallId: 'c_img', content: omitted },
    ])
    const messages = body.messages as { role: string; content: unknown }[]
    const toolTurn = messages.find(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type?: string }[]).some((block) => block.type === 'tool_result'),
    )
    const result = (toolTurn!.content as Record<string, unknown>[]).find(
      (block) => block.type === 'tool_result',
    )
    expect(result?.content).toBe(omitted)
  })

  test('同一轮的多个工具结果合并进一条 user 消息', async () => {
    const body = await send([
      { role: 'user', content: '看' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c_1', name: 'read_file', arguments: { path: 'a.ts' } },
          { id: 'c_2', name: 'read_file', arguments: { path: 'b.ts' } },
        ],
      },
      { role: 'tool', toolCallId: 'c_1', content: '甲' },
      { role: 'tool', toolCallId: 'c_2', content: '乙' },
    ])
    const messages = body.messages as { role: string; content: unknown }[]
    const toolTurns = messages.filter(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as { type?: string }[]).some((b) => b.type === 'tool_result'),
    )
    expect(toolTurns).toHaveLength(1)
    expect((toolTurns[0]!.content as { tool_use_id?: string }[]).map((b) => b.tool_use_id)).toEqual(
      ['c_1', 'c_2'],
    )
  })
})

describe('连接', () => {
  test('每次请求都声明不复用连接', async () => {
    requestHeaders.length = 0
    await send([{ role: 'user', content: 'hi' }])
    // 中转站会掐掉空闲的 keep-alive 连接，复用旧连接的下一次请求当场断开或一直静默。
    expect(requestHeaders[0]?.get('connection')).toBe('close')
  })
})
