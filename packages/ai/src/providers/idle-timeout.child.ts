/**
 * `idle-timeout.test.ts` 的子进程部分：在 `BUN_CONFIG_HTTP_IDLE_TIMEOUT=1` 的进程中，
 * 启动一个静默 `SILENT_MS` 的 SSE 服务，三种协议的适配器各读取一条流；生成接口的请求在响应头
 * 之前静默 `SILENT_MS`。两种静默各以一条裸 fetch 作对照。
 * 结果按 `{ 协议: 'ok' | 错误文案 }` 以 JSON 写入 stdout。
 */
import { buildAdapter } from '../factory.ts'
import { postJson } from '../media/http.ts'
import { STREAM_IDLE_TIMEOUT_MS } from '../transport.ts'
import type { ChatRequest, ProviderProfile } from '../types.ts'

/** Bun 1.4 的空闲定时器对 1 秒阈值追加一个 4 秒刻度，再向上取整；静默时长须超过两个周期并留有余量。 */
const SILENT_MS = 9_000

const sse = (events: Record<string, unknown>[]): string =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')

/** 每种协议的流分为两部分：第一部分发出后静默，第二部分结束流。键为请求路径的末段。 */
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
    if (path === '/media') return Bun.sleep(SILENT_MS).then(() => Response.json({ data: [] }))
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
      // 只需读完
    }
    return 'ok'
  } catch (err) {
    return describe(err)
  }
}

/** 对照组：不带 `timeout: false` 的裸 fetch，必须被空闲定时器中止。 */
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

/** 生成接口的请求：期限远大于静默时长，响应头到达前不得被空闲定时器中止。 */
async function media(): Promise<string> {
  try {
    await postJson(`${base}/media`, {}, {}, new AbortController().signal, { timeoutMs: 60_000 })
    return 'ok'
  } catch (err) {
    return describe(err)
  }
}

/** 对照组：响应头之前静默的裸 fetch，必须被空闲定时器中止。 */
async function mediaControl(): Promise<string> {
  try {
    await (await fetch(`${base}/media`, { method: 'POST' })).text()
    return 'ok'
  } catch (err) {
    return describe(err)
  }
}

const [anthropic, compat, responses, raw, generated, generatedRaw] = await Promise.all([
  drain('anthropic_messages', 'claude-opus-5'),
  drain('openai_chat_completions', 'deepseek-flash'),
  drain('openai_responses', 'deepseek-flash'),
  control(),
  media(),
  mediaControl(),
])
server.stop(true)
await Bun.write(
  Bun.stdout,
  JSON.stringify({
    anthropic_messages: anthropic,
    openai_chat_completions: compat,
    openai_responses: responses,
    control: raw,
    media: generated,
    media_control: generatedRaw,
  }),
)
process.exit(0)
