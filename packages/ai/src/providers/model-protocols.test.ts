import { describe, expect, test } from 'bun:test'
import type { ResponseReasoning } from '@qywork/core'
import { applyTransportCapabilities, builtinCatalog, lookupModel, priceAt } from '../catalog.ts'
import { buildAdapter } from '../factory.ts'
import { STREAM_IDLE_TIMEOUT_MS } from '../transport.ts'
import type { ChatRequest, ProviderEvent } from '../types.ts'
import { buildInput } from './openai-responses.ts'

const reasoning: ResponseReasoning = {
  model: 'grok-4.7',
  items: [{ type: 'reasoning', id: 'rs1', encrypted_content: 'opaque-ciphertext', summary: [] }],
}
const tools = [
  {
    name: 'read_file',
    description: '读取文件',
    strict: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
      required: ['path'],
    },
  },
]

async function exchange(
  model: string,
  kind: 'openai_responses' | 'openai_chat_completions',
  frames: Record<string, unknown>[],
  request: Partial<ChatRequest> = {},
) {
  let body: Record<string, unknown> = {}
  let headers = new Headers()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      body = (await req.json()) as Record<string, unknown>
      headers = req.headers
      return new Response(frames.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  try {
    const adapter = buildAdapter({
      model,
      kind,
      apiKey: 'test',
      baseUrl: `http://127.0.0.1:${server.port}`,
    })
    const events: ProviderEvent[] = []
    for await (const ev of adapter.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: '读取 a.ts' }],
      maxOutputTokens: null,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      tools,
      effort: 'high',
      cacheKey: 'stable-conversation',
      ...request,
    }))
      events.push(ev)
    return { body, headers, events }
  } finally {
    server.stop(true)
  }
}

describe('GLM 5.3 与 Grok 4.7 官方协议映射', () => {
  test('FlashX 精确收录两协议；Responses 不借用 Chat 档位与视频能力', () => {
    expect(builtinCatalog().filter((s) => s.id === 'glm-5.3-flashx')).toHaveLength(2)
    const chat = lookupModel('glm-5.3-flashx', 'openai_chat_completions')
    expect(chat).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      vision: true,
      video: true,
      effortLevels: ['low', 'high', 'max'],
      chatReasoningProtocol: 'glm_preserved',
      pricing: { input: 2, output: 7, cacheRead: 0.57, currency: 'CNY' },
    })
    for (const id of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx']) {
      const spec = lookupModel(id, 'openai_responses')
      expect(spec).toMatchObject({
        effortLevels: ['high', 'max'],
        reasoningEcho: 'reasoning_text_object',
        chatToolSchema: 'native',
        cacheRouting: 'prompt_cache_key',
        video: false,
      })
      expect(
        applyTransportCapabilities(spec, {
          effort: true,
          effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        }).effortLevels,
      ).toEqual(['high', 'max'])
    }
  })

  test('Grok 4.7 价格在 200K 整条翻倍，不捏造输出上限或 Fast API id', () => {
    for (const kind of ['openai_chat_completions', 'openai_responses'] as const) {
      const spec = lookupModel('grok-4.7', kind)
      expect(spec).toMatchObject({
        maxOutputTokens: null,
        contextWindow: 500_000,
        vision: true,
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
      })
      expect(priceAt(spec, { promptTokens: 199_999 })).toMatchObject({
        input: 2,
        output: 6,
        cacheRead: 0.5,
      })
      expect(priceAt(spec, { promptTokens: 200_000 })).toMatchObject({
        input: 4,
        output: 12,
        cacheRead: 1,
      })
    }
    expect(builtinCatalog().some((s) => s.id === 'grok-4.7-fast')).toBe(false)
  })

  test('Chat 请求保留工具可选字段；GLM 思考开关与 Grok 缓存头各用官方形状', async () => {
    const frames = [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]
    for (const model of ['glm-5.3-flashx', 'grok-4.7']) {
      const { body, headers } = await exchange(model, 'openai_chat_completions', frames)
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: tools[0]!.name,
            description: tools[0]!.description,
            parameters: tools[0]!.parameters,
          },
        },
      ])
      expect(body.reasoning_effort).toBe('high')
      expect(body.prompt_cache_key).toBeUndefined()
      if (model === 'glm-5.3-flashx')
        expect(body.thinking).toEqual({ type: 'enabled', clear_thinking: false })
      else expect(headers.get('x-grok-conv-id')).toBe('stable-conversation')
    }
  })

  test('GLM Responses 用单个 reasoning_text 对象、原生 schema 和独立缓存字段', async () => {
    const { body, events } = await exchange(
      'glm-5.3-flashx',
      'openai_responses',
      [
        { type: 'response.reasoning_text.delta', delta: '先读取文件' },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'c2',
                name: 'read_file',
                arguments: '{"path":"b.ts"}',
              },
            ],
          },
        },
      ],
      {
        effort: 'max',
        maxOutputTokens: 200_000,
        messages: [
          { role: 'assistant', content: '计划', reasoningContent: '历史思考' },
          { role: 'user', content: '继续' },
        ],
      },
    )
    expect(body.reasoning).toEqual({ effort: 'max' })
    expect(body.max_output_tokens).toBe(131_072)
    expect(body.prompt_cache_key).toBe('stable-conversation')
    expect(body.input).toEqual([
      { type: 'reasoning', content: { type: 'reasoning_text', text: '历史思考' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '计划' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: tools[0]!.name,
        description: tools[0]!.description,
        parameters: tools[0]!.parameters,
      },
    ])
    expect(events).toContainEqual({
      type: 'tool_calls',
      calls: [
        {
          id: 'c2',
          name: 'read_file',
          arguments: { path: 'b.ts' },
        },
      ],
    })
  })

  test('Grok 完整快照替换早先密文，原样回传且不混入可见思考', async () => {
    const { body, events } = await exchange(
      'grok-4.7',
      'openai_responses',
      [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { ...reasoning.items[0], encrypted_content: 'old' },
        },
        { type: 'response.completed', response: { status: 'completed', output: reasoning.items } },
      ],
      {
        messages: [
          {
            role: 'assistant',
            content: '已读',
            responseReasoning: reasoning,
            toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }],
          },
          { role: 'tool', toolCallId: 'c1', content: '内容' },
        ],
      },
    )
    expect(body.prompt_cache_key).toBe('stable-conversation')
    expect(body.max_output_tokens).toBeUndefined()
    expect((body.input as unknown[])[0]).toEqual(reasoning.items[0])
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: tools[0]!.name,
        description: tools[0]!.description,
        parameters: tools[0]!.parameters,
      },
    ])
    expect(events.filter((e) => e.type === 'response_reasoning')).toEqual([
      { type: 'response_reasoning', reasoning },
    ])
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(false)
  })

  test('无完整快照时使用 output_item.done；空快照不回放已撤销密文', async () => {
    for (const output of [undefined, []]) {
      const { events } = await exchange('grok-4.7', 'openai_responses', [
        { type: 'response.output_item.done', output_index: 0, item: reasoning.items[0] },
        {
          type: 'response.completed',
          response: { status: 'completed', ...(output ? { output } : {}) },
        },
      ])
      expect(events.filter((e) => e.type === 'response_reasoning')).toEqual(
        output ? [] : [{ type: 'response_reasoning', reasoning }],
      )
    }
  })

  test('换模型或协议时不会发送别的模型密文', () => {
    const messages = [{ role: 'assistant' as const, content: '已读', responseReasoning: reasoning }]
    expect(
      buildInput(messages, 'encrypted_content', 'another-model').some(
        (i) => i.type === 'reasoning',
      ),
    ).toBe(false)
    expect(buildInput(messages, 'none', 'grok-4.7').some((i) => i.type === 'reasoning')).toBe(false)
  })
})
