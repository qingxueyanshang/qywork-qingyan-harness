import { describe, expect, test } from 'bun:test'
import { computeCost, lookupModel, officialBaseUrl } from '../catalog.ts'
import { STREAM_IDLE_TIMEOUT_MS } from '../transport.ts'
import type { ChatRequest, ProviderEvent, WireMessage } from '../types.ts'
import { OpenAICompatAdapter } from './openai-compat.ts'

const model = 'gemini-4-argon'
const spec = lookupModel(model, 'openai_chat_completions', Date.UTC(2026, 9, 14))
const extra = (signature: string) => ({ google: { thought_signature: signature } })
const sse = (frames: unknown[]) =>
  new Response(
    `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
  choices: [{ delta, finish_reason }],
})

describe('Gemini 4 Argon', () => {
  test('目录限制与官方 Chat 接口一致，促销在十二月一日切换', () => {
    expect(spec).toMatchObject({
      displayName: 'Gemini 4 Argon',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      vision: true,
      video: false,
      thinksByDefault: true,
      effortLevels: ['low', 'medium', 'high'],
      chatToolSchema: 'native',
      cacheRouting: 'none',
      minCacheablePrefix: 4096,
    })
    expect(officialBaseUrl(spec)).toBe('https://generativelanguage.googleapis.com/v1beta/openai')
    const boundary = Date.UTC(2026, 11, 1)
    expect(lookupModel(model, spec.provider, boundary - 1).pricing).toMatchObject({
      input: 2,
      output: 10,
      cacheRead: 0.1,
    })
    expect(lookupModel(model, spec.provider, boundary).pricing).toMatchObject({
      input: 4,
      output: 20,
      cacheRead: 0.2,
    })
    expect(officialBaseUrl(lookupModel(model, 'openai_responses'))).toBeUndefined()
  })

  test('实际请求保留并行与连续工具调用签名、图片、用量和原生工具参数', async () => {
    const requests: Record<string, unknown>[] = []
    const message = (request: number, index: number) =>
      (requests[request]!.messages as Record<string, unknown>[])[index]!
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        requests.push((await req.json()) as Record<string, unknown>)
        if (requests.length === 1) {
          return sse([
            chunk({
              tool_calls: [
                {
                  index: 1,
                  id: 'b',
                  function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
                },
              ],
            }),
            chunk({
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: '{"path":' },
                  extra_content: extra('signature-a'),
                },
              ],
            }),
            chunk(
              {
                tool_calls: [
                  { index: 0, id: 'a', function: { name: 'read_file', arguments: '"a.ts"}' } },
                ],
              },
              'tool_calls',
            ),
          ])
        }
        if (requests.length === 2) {
          expect(message(1, 1).tool_calls).toEqual([
            {
              id: 'a',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              extra_content: extra('signature-a'),
            },
            {
              id: 'b',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
            },
          ])
          return sse([
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: 'c',
                    function: { name: 'read_file', arguments: '{"path":"c.ts"}' },
                    extra_content: extra('signature-c'),
                  },
                ],
              },
              'tool_calls',
            ),
          ])
        }
        return sse([
          chunk({ content: '完成' }),
          chunk({ content: '', extra_content: extra('signature-text') }, 'stop'),
          {
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 60,
              prompt_tokens_details: { cached_tokens: 400 },
              completion_tokens_details: { reasoning_tokens: 20 },
            },
          },
        ])
      },
    })
    try {
      const adapter = new OpenAICompatAdapter(
        {
          kind: spec.provider,
          model,
          apiKey: 'test',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        },
        spec,
      )
      const messages: WireMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: '查看图片并读取文件' },
            { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'aW1hZ2U=' } },
          ],
        },
      ]
      const request: ChatRequest = {
        model,
        system: [],
        messages,
        maxOutputTokens: 1_048_576,
        idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        cacheKey: 'session',
        tools: [
          {
            name: 'read_file',
            description: '读取文件',
            strict: true,
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, limit: { type: 'integer' } },
              required: ['path'],
            },
          },
        ],
      }
      const events: ProviderEvent[][] = []
      for (let round = 0; round < 3; round++) {
        const turn: ProviderEvent[] = []
        for await (const event of adapter.stream({
          ...request,
          ...(round === 1 ? { effort: 'high' } : {}),
        }))
          turn.push(event)
        events.push(turn)
        const calls = turn.find((event) => event.type === 'tool_calls')
        const reasoning = turn.find((event) => event.type === 'response_reasoning')
        messages.push({
          role: 'assistant',
          content: round === 2 ? '完成' : '',
          ...(calls?.type === 'tool_calls' ? { toolCalls: calls.calls } : {}),
          ...(reasoning?.type === 'response_reasoning'
            ? { responseReasoning: reasoning.reasoning }
            : {}),
        })
        if (calls?.type === 'tool_calls') {
          for (const call of calls.calls)
            messages.push({ role: 'tool', toolCallId: call.id, content: '文件内容' })
        }
      }
      await Array.fromAsync(adapter.stream(request))
      expect(requests[0]!.model).toBe(model)
      expect(requests[0]!.max_tokens).toBe(65_536)
      expect(requests[0]).toHaveProperty('messages.0.content.1', {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aW1hZ2U=' },
      })
      expect(requests[0]).toHaveProperty('tools.0.function.parameters.required', ['path'])
      expect(requests[0]).not.toHaveProperty('tools.0.function.strict')
      for (const field of [
        'reasoning_effort',
        'temperature',
        'top_p',
        'top_k',
        'prompt_cache_key',
        'cached_content',
      ])
        expect(requests[0]![field]).toBeUndefined()
      expect(requests[1]!.reasoning_effort).toBe('high')
      expect(message(2, 1)).toHaveProperty('tool_calls.0.extra_content', extra('signature-a'))
      expect(message(2, 4)).toHaveProperty('tool_calls.0.extra_content', extra('signature-c'))
      expect(message(3, 6).extra_content).toEqual(extra('signature-text'))
      const usage = events[2]!.find((event) => event.type === 'usage')
      expect(usage?.type === 'usage' && usage.usage).toMatchObject({
        inputTokens: 600,
        outputTokens: 60,
        cachedTokens: 400,
        reasoningTokens: 20,
        source: 'provider',
      })
      if (usage?.type === 'usage') expect(computeCost(spec, usage.usage)).toBe(0.00184)
    } finally {
      server.stop(true)
    }
  })
})
