/** 覆盖已保存的模型规格 → HTTP 探测入口 → 实际供应商请求，含未知模型与重新检测。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { ProbeOutcome, TransportCapabilities } from '@qywork/ai'
import type { ProviderKind, ThinkingMode } from '@qywork/core'
import { catalogKey, type QyConfig } from '@qywork/runtime'
import { handleProbeApi } from './probe.ts'
import type { ApiRequestDeps } from './types.ts'

let server: ReturnType<typeof Bun.serve>
const requests: Record<string, unknown>[] = []
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push((await req.json()) as Record<string, unknown>)
      const body = requests.at(-1)!
      const effort =
        body.reasoning_effort ??
        (body.reasoning as { effort?: string } | undefined)?.effort ??
        (body.output_config as { effort?: string } | undefined)?.effort
      if (effort && !['low', 'high', 'max'].includes(String(effort))) {
        return new Response(JSON.stringify({ error: { message: 'unsupported effort' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      const path = new URL(req.url).pathname
      const events = path.endsWith('/responses')
        ? [
            {
              type: 'response.completed',
              response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } },
            },
          ]
        : path.endsWith('/messages')
          ? [
              {
                type: 'message_start',
                message: {
                  id: 'msg_test',
                  type: 'message',
                  role: 'assistant',
                  model: 'custom',
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ]
          : [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]
      return new Response(
        events
          .map((e) => `${'type' in e ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`)
          .join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    },
  })
})
afterAll(() => server.stop(true))

const routes: { kind: ProviderKind; thinking: ThinkingMode; fields: Record<string, unknown> }[] = [
  {
    kind: 'openai_chat_completions',
    thinking: 'deepseek_thinking',
    fields: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
  },
  {
    kind: 'openai_responses',
    thinking: 'reasoning_effort',
    fields: { reasoning: { effort: 'low', summary: 'auto' } },
  },
  {
    kind: 'anthropic_messages',
    thinking: 'deepseek_thinking',
    fields: { output_config: { effort: 'low' } },
  },
]
for (const route of routes) {
  test(`自定义模型 ${route.kind} 保留手动规格并重新校验传输`, async () => {
    requests.length = 0
    const config: QyConfig = {
      mode: 'auto',
      active: { provider: 'local', model: 'custom' },
      providers: {
        local: {
          kind: route.kind,
          apiKey: 'sk-local-test',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          models: { custom: { transport: { effort: false } } },
        },
      },
      catalog: {
        [catalogKey('custom', route.kind)]: {
          thinking: route.thinking,
          effortLevels: ['low', 'high', 'max'],
        },
      },
    }
    const req = new Request('http://localhost/api/probe', {
      method: 'POST',
      body: JSON.stringify({ provider: 'local', model: 'custom' }),
    })
    const response = await handleProbeApi(new URL(req.url), req, { config } as ApiRequestDeps)
    expect(response?.status).toBe(200)
    const result = (await response!.json()) as {
      outcome: ProbeOutcome
      transport: TransportCapabilities
    }
    expect(result.outcome.reachable).toBe(true)
    expect(result.outcome.effortLevels).toEqual(['low', 'high', 'max'])
    expect(result.transport).toMatchObject({
      effort: true,
      effortLevels: ['low', 'high', 'max'],
      thinking: route.thinking,
      toolCalls: {
        kind: route.kind,
        model: 'custom',
        baseUrl: config.providers.local!.baseUrl,
        schema: 'native',
        status: 'inconclusive',
      },
    })
    expect(result.outcome.effortSource).toBe('catalog')
    expect(requests).toHaveLength(6)
    expect(requests[1]).toMatchObject({ model: 'custom', ...route.fields })
    // 检测只返回当前端点的结论，不修改全局规格或配置。
    expect(config.providers.local?.models.custom?.transport).toEqual({ effort: false })
    expect(config.catalog?.[catalogKey('custom', route.kind)]?.effortLevels).toEqual([
      'low',
      'high',
      'max',
    ])
  })
}
