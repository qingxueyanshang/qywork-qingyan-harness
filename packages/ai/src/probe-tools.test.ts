import { describe, expect, test } from 'bun:test'
import { matchesToolCallCheck, type ProviderKind } from '@qywork/core'
import { lookupModel } from './catalog.ts'
import { probeModel, toTransportCapabilities } from './probe.ts'
import { probeToolCalls } from './probe-tools.ts'
import type { ProviderProfile } from './types.ts'

interface Entry {
  role: string
  type: string
  content: string | Entry[]
  output: string
  reasoning_content?: string
  tool_call_id?: string
  call_id?: string
}
interface Schema {
  properties: Record<string, { type: unknown }>
  required: string[]
}
interface Body {
  messages: Entry[]
  input: Entry[]
  tools: { function: { strict?: boolean; parameters: Schema }; input_schema: Schema }[]
}
const args = (label = 'probe') => ({
  label,
  url: 'pelican-bicycle.html',
  count: 7,
  enabled: false,
  payload: { tags: ['甲', '乙'] },
})
const sse = (events: Record<string, unknown>[]) =>
  new Response(
    events
      .map((e) => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )
const chat = (argumentsText: string, content = '', finish = 'tool_calls') =>
  sse([
    {
      choices: [
        {
          delta: {
            reasoning_content: '检查参数',
            content,
            tool_calls: [
              {
                index: 0,
                id: 'call_probe',
                type: 'function',
                function: { name: 'qy_tool_probe', arguments: argumentsText },
              },
            ],
          },
          finish_reason: finish,
        },
      ],
    },
  ])

async function withEndpoint<T>(
  respond: (body: Body, n: number) => Response | Promise<Response>,
  run: (profile: ProviderProfile, bodies: Body[]) => Promise<T>,
  kind: ProviderKind = 'openai_chat_completions',
) {
  const bodies: Body[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Body
      bodies.push(body)
      return respond(body, bodies.length)
    },
  })
  try {
    return await run(
      {
        model: 'mimo-v2.6-flash',
        kind,
        apiKey: 'test',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
      bodies,
    )
  } finally {
    server.stop(true)
  }
}

const mimoModels = ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']

describe('工具契约检测走实际协议适配器', () => {
  test.each(mimoModels)('%s 原生参数不造 nullable，第二轮携带思考并读回随机凭据', async (model) => {
    await withEndpoint(
      (body) => {
        const tool = body.messages.find((m) => m.role === 'tool')
        return chat(
          JSON.stringify(args(tool ? JSON.parse(tool.content as string).receipt : 'probe')),
        )
      },
      async (profile, bodies) => {
        const result = await probeToolCalls({ ...profile, model })
        expect(result.check.status).toBe('passed')
        expect(bodies).toHaveLength(2)
        const tool = bodies[0]!.tools[0]!.function
        expect(tool.strict).toBeUndefined()
        expect(tool.parameters.properties.url!.type).toBe('string')
        expect(tool.parameters.required).not.toContain('tabId')
        expect(bodies[1]!.messages[1]!.reasoning_content).toBe('检查参数')
        expect(bodies[1]!.messages[2]!.tool_call_id).toBe('call_probe')
        expect(result.steps.every((s) => s.ok)).toBe(true)
      },
    )
  })

  test('模型库声明 strict 的模型会转换参数，下一轮仍使用相同约定', async () => {
    await withEndpoint(
      (body) => {
        const tool = body.messages.find((m) => m.role === 'tool')
        return chat(
          JSON.stringify({
            ...args(tool ? JSON.parse(tool.content as string).receipt : 'probe'),
            tabId: null,
          }),
        )
      },
      async (profile, bodies) => {
        const result = await probeToolCalls({
          ...profile,
          model: 'gpt-5.6-sol',
        })
        expect(result.check).toMatchObject({ schema: 'openai_strict', status: 'passed' })
        expect(bodies[0]!.tools[0]!.function.parameters.properties.url!.type).toEqual([
          'string',
          'null',
        ])
      },
    )
  })

  test.each(['flash', 'pro'])(
    '%s 官方残缺 arguments + 正文 XML 判失败，不修补执行',
    async (variant) => {
      const raw = await Bun.file(
        new URL(`./fixtures/mimo-${variant}-tool-union.sse`, import.meta.url),
      ).text()
      await withEndpoint(
        () => new Response(raw, { headers: { 'content-type': 'text/event-stream' } }),
        async (profile, bodies) => {
          const result = await probeToolCalls(profile)
          expect(result.check.status).toBe('failed')
          expect(result.steps[0]?.detail).toContain('不是完整 JSON')
          expect(bodies).toHaveLength(1)
        },
      )
    },
  )

  for (const [name, value] of [
    ['数字被转成字符串', { ...args(), count: '7' }],
    ['原生可选字段被填 null', { ...args(), tabId: null }],
    ['嵌套数组类型错', { ...args(), payload: { tags: '甲乙' } }],
    ['多出未定义字段', { ...args(), injected: true }],
  ] as const) {
    test(name, async () => {
      await withEndpoint(
        () => chat(JSON.stringify(value)),
        async (profile) => {
          expect((await probeToolCalls(profile)).check.status).toBe('failed')
        },
      )
    })
  }
  test('第二轮未读工具结果不能通过', async () => {
    await withEndpoint(
      () => chat(JSON.stringify(args())),
      async (profile, bodies) => {
        const result = await probeToolCalls(profile)
        expect(result.check.status).toBe('failed')
        expect(result.steps.map((s) => s.ok)).toEqual([true, false])
        expect(bodies).toHaveLength(2)
      },
    )
  })
  for (const [name, response, status] of [
    [
      '正文 XML',
      () =>
        sse([
          {
            choices: [{ delta: { content: '<tool_call>call</tool_call>' }, finish_reason: 'stop' }],
          },
        ]),
      'failed',
    ],
    [
      '仅普通文字',
      () => sse([{ choices: [{ delta: { content: 'hello' }, finish_reason: 'stop' }] }]),
      'inconclusive',
    ],
    ['输出上限', () => chat('{', '', 'length'), 'inconclusive'],
    [
      '请求被拒绝',
      () => new Response('{"error":{"message":"unsupported schema"}}', { status: 400 }),
      'failed',
    ],
    [
      '临时错误',
      () => new Response('{"error":{"message":"busy"}}', { status: 503 }),
      'inconclusive',
    ],
  ] as const) {
    test(name, async () => {
      await withEndpoint(response, async (profile) => {
        expect((await probeToolCalls(profile)).check.status).toBe(status)
      })
    })
  }

  test.each(mimoModels)('%s Responses 工具结果以 function_call_output 回传', async (model) => {
    await withEndpoint(
      (body) => {
        const tool = body.input.find((m) => m.type === 'function_call_output')
        const value = args(tool ? JSON.parse(tool.output).receipt : 'probe')
        return sse([
          {
            type: 'response.completed',
            response: {
              status: 'completed',
              output: [
                {
                  type: 'function_call',
                  id: 'fc_probe',
                  call_id: 'call_probe',
                  name: 'qy_tool_probe',
                  arguments: JSON.stringify(value),
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ])
      },
      async (profile, bodies) => {
        expect((await probeToolCalls({ ...profile, model })).check.status).toBe('passed')
        expect(bodies[1]!.input.find((m) => m.type === 'function_call_output')!.call_id).toBe(
          'call_probe',
        )
      },
      'openai_responses',
    )
  })

  test('Anthropic 使用原生 input_schema 及 tool_result', async () => {
    await withEndpoint(
      (body) => {
        const tool = body.messages
          .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
          .find((m) => m.type === 'tool_result')
        return sse([
          {
            type: 'message_start',
            message: {
              id: 'msg_probe',
              type: 'message',
              role: 'assistant',
              model: 'mimo-v2.6-flash',
              content: [],
              stop_reason: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'call_probe', name: 'qy_tool_probe', input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify(
                args(tool ? JSON.parse(tool.content as string).receipt : 'probe'),
              ),
            },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ])
      },
      async (profile, bodies) => {
        expect((await probeToolCalls(profile)).check.status).toBe('passed')
        expect(bodies[0]!.tools[0]!.input_schema.properties.url!.type).toBe('string')
      },
      'anthropic_messages',
    )
  })

  test('完整检测独立保留工具证据，档位无结论不影响工具结果', async () => {
    await withEndpoint(
      (body) => {
        if (!body.tools?.length)
          return sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])
        const tool = body.messages.find((m) => m.role === 'tool')
        return chat(
          JSON.stringify(args(tool ? JSON.parse(tool.content as string).receipt : 'probe')),
        )
      },
      async (profile) => {
        const outcome = await probeModel({ ...profile, model: 'unknown' }, { gapMs: 0 })
        expect(outcome.inconclusive).toEqual(['effort'])
        expect(toTransportCapabilities(outcome)).toEqual({ toolCalls: outcome.toolCalls! })
        expect(outcome.toolCalls?.status).toBe('passed')
        const check = outcome.toolCalls!
        expect(matchesToolCallCheck(check, { ...check, baseUrl: `${check.baseUrl}/` })).toBe(true)
        for (const change of [
          { baseUrl: 'https://other.test' },
          { model: 'other' },
          { kind: 'openai_responses' as const },
          { schema: 'openai_strict' as const },
        ]) {
          expect(matchesToolCallCheck(check, { ...check, ...change })).toBe(false)
        }
      },
    )
  })
})

test('MiMo 三个型号三种协议统一保留原生定义，其他模型遵循各自映射', () => {
  for (const model of ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed']) {
    for (const kind of [
      'openai_chat_completions',
      'openai_responses',
      'anthropic_messages',
    ] as const)
      expect(lookupModel(model, kind).chatToolSchema).toBe('native')
  }
  expect(lookupModel('gpt-5.6-sol', 'openai_chat_completions').chatToolSchema).toBe('openai_strict')
  expect(lookupModel('custom', 'openai_chat_completions').chatToolSchema).toBe('native')
})
