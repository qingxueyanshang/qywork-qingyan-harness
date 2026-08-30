/**
 * 覆盖 `anthropic.ts` 的请求体装配：工具结果（含图片块）到 Messages 协议的
 * wire 形状。起本机 server 当端点，把收到的 body 原样存下来——公共层测试
 * 只能证明图片块存在，证明不了最后一个 serializer 没有改形或丢块。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { lookupModel } from '../catalog.ts'
import type { ProviderProfile, WireMessage } from '../types.ts'
import { AnthropicAdapter } from './anthropic.ts'

const bodies: Record<string, unknown>[] = []
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
      bodies.push((await req.json()) as Record<string, unknown>)
      return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

async function send(messages: WireMessage[]): Promise<Record<string, unknown>> {
  bodies.length = 0
  const profile: ProviderProfile = {
    kind: 'anthropic_messages',
    apiKey: 'sk-x',
    model: 'claude-opus-5',
    baseUrl: base,
  }
  const adapter = new AnthropicAdapter(profile, lookupModel('claude-opus-5', 'anthropic_messages'))
  for await (const _ of adapter.stream({
    model: 'claude-opus-5',
    system: [],
    messages,
    tools: [],
    maxOutputTokens: 64,
    signal: new AbortController().signal,
  })) {
    // 读完即可，产出不关心。
  }
  return bodies[0]!
}

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
