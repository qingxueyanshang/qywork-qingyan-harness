/**
 * 可编程的三协议故障端点：Responses、Chat Completions 与 Anthropic Messages 共用一个
 * `Bun.serve`，按请求路径分派，故障形态由 `mode` 决定且运行中可改。
 *
 * **只供测试导入，不进生产代码。**
 *
 * `receipts` 是服务端侧的独立事实——收到过几次请求、各在什么时刻。客户端账本要与它
 * 对账才能判出重发次数是否真实；只数客户端自己的记录证明不了对端收没收到。
 *
 * 文件末尾一并提供三协议参数化的适配器驱动（`FAULT_PROTOCOLS` / `drainAdapter` /
 * `withFault`）：夹具与驱动各写一份就会漂移。
 */

import { buildAdapter } from '../factory.ts'
import type { ProviderEvent, ProviderProfile } from '../types.ts'

const enc = new TextEncoder()

export type FaultMode =
  /** 首次 503 + Retry-After，其后正常完成。 */
  | 'retry_after_then_ok'
  /** 503 响应头已到，错误正文永不结束。 */
  | 'hung_error_body'
  /** 完整工具调用与协议终态都已发出，HTTP 永不 EOF。 */
  | 'tool_then_no_eof'
  /** 200 之后在流内发错误事件。 */
  | 'inline_error'
  /** 用量已回报，流在协议终态之前 FIN。 */
  | 'eof_before_terminal'
  /** 首次在协议终态之前 FIN，第二次交完整工具调用，其后正常完成。 */
  | 'eof_before_terminal_then_tool'
  /** 首次交完整工具调用，其后一律 503：工具跑成功了，带着结果的下一次请求被回绝。 */
  | 'tool_then_unavailable'
  /** 200 响应头已到，之后一个字节都不再发。 */
  | 'headers_then_silence'
  /** 先发若干 SSE 注释行保活，间隔短于空闲上限，再正常完成。 */
  | 'keepalive_then_ok'
  /** 一次完整的正常响应：协议终态与用量都发全，随后 EOF。 */
  | 'complete'
  /** 工具参数只发了半截 JSON，协议终态是输出上限。 */
  | 'truncated_tool_call'
  /** 一律 402，正文取 DeepSeek 余额不足时的原样响应体（111 字节）。 */
  | 'payment_required'

export interface FaultServer {
  /** Anthropic Messages 的 baseUrl；SDK 自己接 `/v1/messages`。 */
  anthropicBaseUrl: string
  /** 两条 OpenAI 协议的 baseUrl。 */
  openaiBaseUrl: string
  /** 每次收到请求的时刻，按到达顺序追加。 */
  receipts: number[]
  /**
   * 每次收到的请求正文原文，与 `receipts` 同下标。
   *
   * 留原文不留解析结果：三条协议的请求体结构各不相同，解析成统一形状就是在夹具里
   * 再写一份协议知识，而断言要问的正是「线上那份字节里有没有它」。
   */
  bodies: string[]
  mode: FaultMode
  /**
   * `retry_after_then_ok` 与 `hung_error_body` 的 503 响应头里带的 Retry-After 秒数。
   * `null` 表示不带这个响应头——客户端此时只能按自己的退避策略决定等多久。
   */
  retryAfterSeconds: number | null
  /** `inline_error` 事件里的分类词与原文，三协议共用同一份。 */
  inlineError: { type: string; message: string }
  /**
   * 客户端主动断开连接的次数，由永不结束的响应体的 `cancel` 回调计数。
   *
   * 这是服务端侧的独立事实：客户端说自己取消了 body 证明不了连接真的释放了。
   */
  closedByClient: number
  stop(): void
}

type Protocol = 'responses' | 'chat' | 'anthropic'
type Shape = 'text' | 'tool' | 'inline_error' | 'truncated' | 'truncated_tool'

const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const

/**
 * 正文发出开头一段之后永不结束的响应。
 *
 * 构造的流不 `close`，调用方必须靠 `stop()` 强制断开，否则测试进程不会退出。
 * `prefix` 不能为空：`Bun.serve` 要等正文的第一个分片才发响应头，一个字节都不写的话
 * 客户端连响应头都收不到，「响应头已到、正文不来」这个形状就构造不出来。
 */
function endless(
  prefix: string,
  status: number,
  headers: Record<string, string>,
  onCancel: () => void,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(prefix))
    },
    cancel: onCancel,
  })
  return new Response(body, { status, headers })
}

/** 保活行的条数与间隔。间隔要短于被测客户端的空闲上限，总时长要长于它。 */
const KEEP_ALIVE_LINES = 5
const KEEP_ALIVE_GAP_MS = 80

/** 先发若干 SSE 注释行，再发完整的一次正常响应。 */
function keepAliveThen(protocol: Protocol): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < KEEP_ALIVE_LINES; i++) {
        controller.enqueue(enc.encode(': ping\n\n'))
        await Bun.sleep(KEEP_ALIVE_GAP_MS)
      }
      controller.enqueue(enc.encode(bodyOf(protocol, 'text')))
      controller.close()
    },
  })
  return new Response(body, { headers: SSE_HEADERS })
}

/** 带 `event:` 行的 SSE；Responses 与 Anthropic 两条协议都按事件名分派。 */
function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function responsesBody(shape: Shape, inline: InlineError): string {
  const created = { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }
  const message = {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
  }
  const textDelta = {
    type: 'response.output_text.delta',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    delta: '完成',
  }
  const completed = (usage: Record<string, number>) => ({
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', usage },
  })
  switch (shape) {
    case 'text':
      return sse([created, message, textDelta, completed({ input_tokens: 11, output_tokens: 3 })])
    case 'tool':
      return sse([
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'echo',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          output_index: 0,
          delta: '{"a":1}',
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_1',
          output_index: 0,
          arguments: '{"a":1}',
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'echo',
            arguments: '{"a":1}',
            status: 'completed',
          },
        },
        completed({ input_tokens: 11, output_tokens: 7 }),
      ])
    case 'inline_error':
      return sse([created, { type: 'error', code: inline.type, message: inline.message }])
    case 'truncated':
      return sse([created, message, textDelta])
    case 'truncated_tool':
      return sse([
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'echo',
            arguments: '',
          },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: 'fc_1',
          output_index: 0,
          delta: '{"a":',
        },
        {
          type: 'response.incomplete',
          response: {
            id: 'resp_1',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 11, output_tokens: 7 },
          },
        },
      ])
  }
}

function chatBody(shape: Shape, inline: InlineError): string {
  const chunk = (fields: Record<string, unknown>) => ({
    id: 'chatcmpl_1',
    object: 'chat.completion.chunk',
    ...fields,
  })
  const usageChunk = chunk({
    choices: [],
    usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
  })
  const data = (events: Record<string, unknown>[], done: boolean) =>
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
  switch (shape) {
    case 'text':
      return data(
        [
          chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '完成' } }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
          usageChunk,
        ],
        true,
      )
    case 'tool':
      return data(
        [
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '' },
                    },
                  ],
                },
              },
            ],
          }),
          chunk({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] },
              },
            ],
          }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          // 工具轮的输出用量与另两条协议取同一个数，三协议参数化才能断言同一句。
          chunk({
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        ],
        true,
      )
    case 'inline_error':
      return data([{ error: { message: inline.message, type: inline.type } }], false)
    // 用量那一格先到、finish_reason 还没到就 FIN：适配器据此报断流并带上真实用量。
    case 'truncated':
      return data(
        [
          chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '完成' } }] }),
          usageChunk,
        ],
        false,
      )
    case 'truncated_tool':
      return data(
        [
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'echo', arguments: '{"a":' },
                    },
                  ],
                },
              },
            ],
          }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
          usageChunk,
        ],
        true,
      )
  }
}

function anthropicBody(shape: Shape, inline: InlineError): string {
  const start = {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 1 },
    },
  }
  const textBlock = [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } },
    { type: 'content_block_stop', index: 0 },
  ]
  switch (shape) {
    case 'text':
      return sse([
        start,
        ...textBlock,
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ])
    case 'tool':
      return sse([
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' },
      ])
    case 'inline_error':
      return sse([start, { type: 'error', error: { type: inline.type, message: inline.message } }])
    case 'truncated':
      return sse([start, ...textBlock])
    case 'truncated_tool':
      return sse([
        start,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"a":' },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens', stop_sequence: null },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' },
      ])
  }
}

/** `inline_error` 事件的分类词与原文。 */
export interface InlineError {
  type: string
  message: string
}

/**
 * 三协议默认的流内错误。分类词取各家都用的过载码，原文三协议一致，
 * 参数化测试因此可以对同一句断言。
 */
const DEFAULT_INLINE_ERROR: InlineError = {
  type: 'overloaded_error',
  message: 'Upstream is overloaded, please retry',
}

function bodyOf(protocol: Protocol, shape: Shape, inline = DEFAULT_INLINE_ERROR): string {
  if (protocol === 'responses') return responsesBody(shape, inline)
  if (protocol === 'chat') return chatBody(shape, inline)
  return anthropicBody(shape, inline)
}

function protocolOf(pathname: string): Protocol {
  if (pathname.endsWith('/responses')) return 'responses'
  if (pathname.endsWith('/messages')) return 'anthropic'
  return 'chat'
}

function respond(protocol: Protocol, fault: FaultServer): Response {
  const errorHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...(fault.retryAfterSeconds === null ? {} : { 'retry-after': String(fault.retryAfterSeconds) }),
  }
  const closed = () => {
    fault.closedByClient++
  }
  switch (fault.mode) {
    case 'retry_after_then_ok':
      return fault.receipts.length === 1
        ? new Response('{"error":{"message":"No available accounts"}}', {
            status: 503,
            headers: errorHeaders,
          })
        : new Response(bodyOf(protocol, 'text'), { headers: SSE_HEADERS })
    case 'hung_error_body':
      return endless('{"error":{"message":"No available accounts', 503, errorHeaders, closed)
    case 'tool_then_no_eof':
      return endless(bodyOf(protocol, 'tool'), 200, SSE_HEADERS, closed)
    case 'inline_error':
      return new Response(bodyOf(protocol, 'inline_error', fault.inlineError), {
        headers: SSE_HEADERS,
      })
    case 'eof_before_terminal':
      return new Response(bodyOf(protocol, 'truncated'), { headers: SSE_HEADERS })
    case 'tool_then_unavailable':
      return fault.receipts.length === 1
        ? new Response(bodyOf(protocol, 'tool'), { headers: SSE_HEADERS })
        : new Response('{"error":{"message":"No available accounts"}}', {
            status: 503,
            headers: errorHeaders,
          })
    case 'eof_before_terminal_then_tool': {
      const shape: Shape =
        fault.receipts.length === 1 ? 'truncated' : fault.receipts.length === 2 ? 'tool' : 'text'
      return new Response(bodyOf(protocol, shape), { headers: SSE_HEADERS })
    }
    case 'headers_then_silence':
      // 单个换行只为把响应头冲出去：它不构成任何 SSE 事件，之后一个字节都不再来。
      return endless('\n', 200, SSE_HEADERS, closed)
    case 'keepalive_then_ok':
      return keepAliveThen(protocol)
    case 'complete':
      return new Response(bodyOf(protocol, 'text'), { headers: SSE_HEADERS })
    case 'truncated_tool_call':
      return new Response(bodyOf(protocol, 'truncated_tool'), { headers: SSE_HEADERS })
    case 'payment_required':
      return new Response(
        '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}',
        { status: 402, headers: { 'content-type': 'application/json' } },
      )
  }
}

export function startFaultServer(mode: FaultMode): FaultServer {
  const fault: FaultServer = {
    anthropicBaseUrl: '',
    openaiBaseUrl: '',
    receipts: [],
    bodies: [],
    mode,
    retryAfterSeconds: 1,
    inlineError: DEFAULT_INLINE_ERROR,
    closedByClient: 0,
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      fault.receipts.push(Date.now())
      const protocol = protocolOf(new URL(req.url).pathname)
      // 请求体必须读完，否则未消费的正文会拖住这一条连接的关闭。
      fault.bodies.push(await req.text())
      return respond(protocol, fault)
    },
  })
  fault.anthropicBaseUrl = `http://127.0.0.1:${server.port}`
  fault.openaiBaseUrl = `${fault.anthropicBaseUrl}/v1`
  fault.stop = () => {
    server.stop(true)
  }
  return fault
}

/**
 * 无人监听的回环地址，用来注入连接拒绝。
 *
 * 先占一个端口再立刻释放：直接写一个固定端口号无法保证本机此刻没有别的进程在听。
 */
export function closedPortBaseUrl(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://127.0.0.1:${probe.port}`
  probe.stop(true)
  return url
}

// ───────────────────────── 三协议参数化驱动 ─────────────────────────

/** 三条协议各取一条目录里有的模型。协议按配置判定，不按模型名。 */
export const FAULT_PROTOCOLS = [
  { kind: 'openai_responses', model: 'deepseek-flash' },
  { kind: 'openai_chat_completions', model: 'deepseek-chat' },
  { kind: 'anthropic_messages', model: 'claude-opus-5' },
] as const satisfies readonly { kind: ProviderProfile['kind']; model: string }[]

export function faultBaseUrl(fault: FaultServer, kind: ProviderProfile['kind']): string {
  return kind === 'anthropic_messages' ? fault.anthropicBaseUrl : fault.openaiBaseUrl
}

export interface DrainResult {
  events: ProviderEvent[]
  err: unknown
  elapsedMs: number
}

/** 跑完一条流，把事件和终态一起交出来——「断之前收到了什么」和错误本身要一起看。 */
export async function drainAdapter(opts: {
  fault: FaultServer
  kind: ProviderProfile['kind']
  model: string
  idleTimeoutMs: number
  signal?: AbortSignal
}): Promise<DrainResult> {
  const adapter = buildAdapter({
    kind: opts.kind,
    apiKey: 'sk-fault',
    baseUrl: faultBaseUrl(opts.fault, opts.kind),
    model: opts.model,
  })
  const events: ProviderEvent[] = []
  const started = Date.now()
  try {
    for await (const ev of adapter.stream({
      model: opts.model,
      system: [],
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      maxOutputTokens: 64,
      idleTimeoutMs: opts.idleTimeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })) {
      events.push(ev)
    }
    return { events, err: null, elapsedMs: Date.now() - started }
  } catch (err) {
    return { events, err, elapsedMs: Date.now() - started }
  }
}

export async function withFault<T>(
  mode: FaultMode,
  fn: (fault: FaultServer) => Promise<T>,
): Promise<T> {
  const fault = startFaultServer(mode)
  try {
    return await fn(fault)
  } finally {
    fault.stop()
  }
}
