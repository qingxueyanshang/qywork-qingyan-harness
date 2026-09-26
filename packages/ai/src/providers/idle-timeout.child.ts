/**
 * `idle-timeout.test.ts` 的子进程侧：在 `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1` 的进程里，
 * 起一个静默 `SILENT_MS` 的 SSE 服务，三种协议的适配器各读一条流，裸 fetch 作对照。
 * 结果按 `{ 协议: 'ok' | 错误文案 }` 以 JSON 写到 stdout。
 */
import { buildAdapter } from '../factory.ts'
import { STREAM_IDLE_TIMEOUT_MS } from '../transport.ts'
import type { ChatRequest, ProviderProfile } from '../types.ts'

/** Bun 1.4 的空闲定时器为 1 秒阈值补一个 4 秒刻度，再向上取整；跨过两轮并留余量。 */
const SILENT_MS = 9_000

const sse = (events: Record<string, unknown>[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

/** 每种协议的流拆成两半：第一半发出后静默，第二半收尾。键是请求路径的结尾。 */
const STREAMS: Record<string, [string, string]> = {
  '/v1/messages': [
    sse([
      {
        type: 'message_start',
        message: {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    ]),
    sse([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]),
  ],
  '/chat/completions': [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  ],
  '/responses': [
    sse([
      { type: 'response.created', response: { id: 'r', status: 'in_progress' } },
      { type: 'response.output_text.delta', delta: 'ok', item_id: 'm1', output_index: 0 },
    ]),
    sse([
      {
        type: 'response.completed',
        response: {
          id: 'r',
          status: 'completed',
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]),
  ],
  '/raw': ['data: 0\n\n', 'data: 1\n\n'],
}

const encoder = new TextEncoder()
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    const match = Object.entries(STREAMS).find(([suffix]) => path.endsWith(suffix))
    if (!match) return new Response('not found', { status: 404 })
    const [head, tail] = match[1]
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(head))
        await Bun.sleep(SILENT_MS)
        controller.enqueue(encoder.encode(tail))
        controller.close()
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  },
})
const base = `http://127.0.0.1:${server.port}`

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function drain(kind: ProviderProfile['kind'], model: string): Promise<string> {
  try {
    const adapter = buildAdapter({ kind, apiKey: 'k', baseUrl: base, model })
    const req: ChatRequest = {
      model,
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 16,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal: new AbortController().signal,
    }
    for await (const _ of adapter.stream(req)) {
      // 读完即可
    }
    return 'ok'
  } catch (err) {
    return describe(err)
  }
}

/** 对照组：不带 `timeout: false` 的裸 fetch，必须被空闲定时器掐断。 */
async function control(): Promise<string> {
  try {
    const res = await fetch(`${base}/raw`)
    const reader = res.body!.getReader()
    for (;;) {
      const { done } = await reader.read()
      if (done) return 'ok'
    }
  } catch (err) {
    return describe(err)
  }
}

const [anthropic, compat, responses, raw] = await Promise.all([
  drain('anthropic_messages', 'claude-opus-5'),
  drain('openai_chat_completions', 'deepseek-flash'),
  drain('openai_responses', 'deepseek-flash'),
  control(),
])
server.stop(true)
await Bun.write(
  Bun.stdout,
  JSON.stringify({
    anthropic_messages: anthropic,
    openai_chat_completions: compat,
    openai_responses: responses,
    control: raw,
  }),
)
process.exit(0)
