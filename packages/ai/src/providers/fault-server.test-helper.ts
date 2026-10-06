/**
 * 可编程的三协议故障端点：Responses、Chat Completions 与 Anthropic Messages 共用一个
 * `Bun.serve`，按请求路径分派，故障形态由 `mode` 决定，且可在运行中修改。
 *
 * 仅供测试导入，不进入生产代码。
 *
 * `receipts` 是服务端记录的独立事实：收到的请求次数及各自的时刻。客户端账本须与其
 * 对账才能判定重发次数是否属实；仅统计客户端自身的记录无法证明对端是否收到。
 *
 * 文件末尾同时提供三协议参数化的适配器驱动（`FAULT_PROTOCOLS` / `drainAdapter` /
 * `withFault`）：夹具与驱动分开维护会导致两者不一致。
 */

import { buildAdapter } from '../factory.ts'
import type { ProviderEvent, ProviderProfile } from '../types.ts'

const enc = new TextEncoder()

export type FaultMode =
  /** 首次返回 503 与 Retry-After，其后正常完成。 */
  | 'retry_after_then_ok'
  /** 503 响应头已到达，错误正文永不结束。 */
  | 'hung_error_body'
  /** 完整工具调用与协议终态都已发出，HTTP 永不 EOF。 */
  | 'tool_then_no_eof'
  /** 返回 200 之后在流内发送错误事件。 */
  | 'inline_error'
  /** 用量已回报，流在协议终态之前 FIN。 */
  | 'eof_before_terminal'
  /** 首次在协议终态之前 FIN，第二次交付完整工具调用，其后正常完成。 */
  | 'eof_before_terminal_then_tool'
  /** 首次交付完整工具调用，其后一律返回 503：工具执行成功，携带结果的下一次请求被拒绝。 */
  | 'tool_then_unavailable'
  /** 200 响应头已到达，之后不再发送任何字节。 */
  | 'headers_then_silence'
  /** 先发送若干 SSE 注释行保活，间隔短于空闲上限，再正常完成。 */
  | 'keepalive_then_ok'
  /** 一次完整的正常响应：协议终态与用量全部发送，随后 EOF。 */
  | 'complete'
  /** 工具参数只发送了不完整的 JSON，协议终态是输出上限。 */
  | 'truncated_tool_call'
  /** 一律返回 402，正文取 DeepSeek 余额不足时的原始响应体（111 字节）。 */
  | 'payment_required'
  /** 首次交付完整工具调用（参数原文取 `toolArguments`），其后正常完成。 */
  | 'tool_then_complete'

export interface FaultServer {
  /** Anthropic Messages 的 baseUrl；SDK 自行拼接 `/v1/messages`。 */
  anthropicBaseUrl: string
  /** 两条 OpenAI 协议的 baseUrl。 */
  openaiBaseUrl: string
  /** 每次收到请求的时刻，按到达顺序追加。 */
  receipts: number[]
  /**
   * 每次收到的请求正文原文，与 `receipts` 同下标。
   *
   * 保留原文而不保留解析结果：三条协议的请求体结构各不相同，解析为统一形状等于在夹具中
   * 重复实现协议知识，而断言要检查的正是「实际发送的字节中是否包含该内容」。
   */
  bodies: string[]
  mode: FaultMode
  /**
   * `retry_after_then_ok` 与 `hung_error_body` 的 503 响应头中携带的 Retry-After 秒数。
   * `null` 表示不带该响应头，此时客户端只能按自身的退避策略决定等待时长。
   */
  retryAfterSeconds: number | null
  /** `inline_error` 事件中的分类词与原文，三协议共用。 */
  inlineError: { type: string; message: string }
  /** `tool_then_complete` 中工具调用的参数原文，三协议共用。默认 `{"a":1}`。 */
  toolArguments: string
  /**
   * 客户端主动断开连接的次数，由永不结束的响应体的 `cancel` 回调计数。
   *
   * 这是服务端记录的独立事实：客户端声称已取消 body 不能证明连接已实际释放。
   */
  closedByClient: number
  stop(): void
}

type Protocol = 'responses' | 'chat' | 'anthropic'
type Shape = 'text' | 'tool' | 'inline_error' | 'truncated' | 'truncated_tool'

const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const

/**
 * 发送正文开头一段后永不结束的响应。
 *
 * 构造的流不调用 `close`，调用方必须通过 `stop()` 强制断开，否则测试进程不会退出。
 * `prefix` 不能为空：`Bun.serve` 在正文的第一个分片到达后才发送响应头，不写入任何字节时
 * 客户端无法收到响应头，无法构造「响应头已到达、正文未到达」的形状。
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

/** 保活行的条数与间隔。间隔须短于被测客户端的空闲上限，总时长须长于该上限。 */
const KEEP_ALIVE_LINES = 5
const KEEP_ALIVE_GAP_MS = 80

/** 先发送若干 SSE 注释行，再发送一次完整的正常响应。 */
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

/** 带 `event:` 行的 SSE；Responses 与 Anthropic 两条协议均按事件名分派。 */
function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

function responsesBody(shape: Shape, inline: InlineError, args: string): string {
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
          delta: args,
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: 'fc_1',
          output_index: 0,
          arguments: args,
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'echo',
            arguments: args,
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

function chatBody(shape: Shape, inline: InlineError, args: string): string {
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
                delta: { tool_calls: [{ index: 0, function: { arguments: args } }] },
              },
            ],
          }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          // 工具轮的输出用量与另两条协议取相同的值，三协议参数化测试才能使用同一断言。
          chunk({
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        ],
        true,
      )
    case 'inline_error':
      return data([{ error: { message: inline.message, type: inline.type } }], false)
    // 用量 chunk 已到达、finish_reason 未到达时 FIN：适配器据此报告断流并附带真实用量。
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

function anthropicBody(shape: Shape, inline: InlineError, args: string): string {
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
          delta: { type: 'input_json_delta', partial_json: args },
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
 * 三协议默认的流内错误。分类词取各厂商通用的过载码，原文三协议一致，
 * 因此参数化测试可以使用同一断言。
 */
const DEFAULT_TOOL_ARGUMENTS = '{"a":1}'

const DEFAULT_INLINE_ERROR: InlineError = {
  type: 'overloaded_error',
  message: 'Upstream is overloaded, please retry',
}

function bodyOf(
  protocol: Protocol,
  shape: Shape,
  inline = DEFAULT_INLINE_ERROR,
  args = DEFAULT_TOOL_ARGUMENTS,
): string {
  if (protocol === 'responses') return responsesBody(shape, inline, args)
  if (protocol === 'chat') return chatBody(shape, inline, args)
  return anthropicBody(shape, inline, args)
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
      // 单个换行仅用于促使响应头发出：它不构成任何 SSE 事件，之后不再发送任何字节。
      return endless('\n', 200, SSE_HEADERS, closed)
    case 'keepalive_then_ok':
      return keepAliveThen(protocol)
    case 'complete':
      return new Response(bodyOf(protocol, 'text'), { headers: SSE_HEADERS })
    case 'truncated_tool_call':
      return new Response(bodyOf(protocol, 'truncated_tool'), { headers: SSE_HEADERS })
    case 'tool_then_complete':
      return new Response(
        bodyOf(
          protocol,
          fault.receipts.length === 1 ? 'tool' : 'text',
          fault.inlineError,
          fault.toolArguments,
        ),
        { headers: SSE_HEADERS },
      )
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
    toolArguments: DEFAULT_TOOL_ARGUMENTS,
    closedByClient: 0,
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      fault.receipts.push(Date.now())
      const protocol = protocolOf(new URL(req.url).pathname)
      // 请求体必须读完，否则未消费的正文会延迟该连接的关闭。
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
 * 无人监听的回环地址，用于注入连接拒绝。
 *
 * 先占用一个端口再立即释放：固定端口号无法保证本机此时没有其他进程在监听。
 */
export function closedPortBaseUrl(): string {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const url = `http://127.0.0.1:${probe.port}`
  probe.stop(true)
  return url
}

// ───────────────────────── 三协议参数化驱动 ─────────────────────────

/** 三条协议各取一个目录中已收录的模型。协议按配置判定，不按模型名。 */
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

/** 读完一条流，将事件与终态一并返回：「断开之前收到的内容」须与错误本身一同检查。 */
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
