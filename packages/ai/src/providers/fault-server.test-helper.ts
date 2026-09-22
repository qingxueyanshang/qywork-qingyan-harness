/**
 * 可编程的三协议故障端点：Responses、Chat Completions 与 Anthropic Messages 共用一个
 * `Bun.serve`，按请求路径分派，故障形态由 `mode` 决定且运行中可改。
 *
 * **只供测试导入，不进生产代码。**
 *
 * `receipts` 是服务端侧的独立事实——收到过几次请求、各在什么时刻。客户端账本要与它
 * 对账才能判出重发次数是否真实；只数客户端自己的记录证明不了对端收没收到。
 */

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
  /** 200 响应头已到，之后一个字节都不再发。 */
  | 'headers_then_silence'
  /** 先发若干 SSE 注释行保活，间隔短于空闲上限，再正常完成。 */
  | 'keepalive_then_ok'

export interface FaultServer {
  /** Anthropic Messages 的 baseUrl；SDK 自己接 `/v1/messages`。 */
  anthropicBaseUrl: string
  /** 两条 OpenAI 协议的 baseUrl。 */
  openaiBaseUrl: string
  /** 每次收到请求的时刻，按到达顺序追加。 */
  receipts: number[]
  mode: FaultMode
  /** `retry_after_then_ok` 与 `hung_error_body` 的 503 响应头里带的 Retry-After 秒数。 */
  retryAfterSeconds: number
  stop(): void
}

type Protocol = 'responses' | 'chat' | 'anthropic'
type Shape = 'text' | 'tool' | 'inline_error' | 'truncated'

const SSE_HEADERS = { 'content-type': 'text/event-stream' } as const

/**
 * 正文发出开头一段之后永不结束的响应。
 *
 * 构造的流不 `close`，调用方必须靠 `stop()` 强制断开，否则测试进程不会退出。
 * `prefix` 不能为空：`Bun.serve` 要等正文的第一个分片才发响应头，一个字节都不写的话
 * 客户端连响应头都收不到，「响应头已到、正文不来」这个形状就构造不出来。
 */
function endless(prefix: string, status: number, headers: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(prefix))
    },
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

function responsesBody(shape: Shape): string {
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
      return sse([
        created,
        { type: 'error', code: 'server_error', message: 'The server had an error' },
      ])
    case 'truncated':
      return sse([created, message, textDelta])
  }
}

function chatBody(shape: Shape): string {
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
          usageChunk,
        ],
        true,
      )
    case 'inline_error':
      return data(
        [
          {
            error: {
              message: 'The server had an error while processing your request',
              type: 'server_error',
            },
          },
        ],
        false,
      )
    // 用量那一格先到、finish_reason 还没到就 FIN：适配器据此报断流并带上真实用量。
    case 'truncated':
      return data(
        [
          chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '完成' } }] }),
          usageChunk,
        ],
        false,
      )
  }
}

function anthropicBody(shape: Shape): string {
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
      return sse([
        start,
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      ])
    case 'truncated':
      return sse([start, ...textBlock])
  }
}

function bodyOf(protocol: Protocol, shape: Shape): string {
  if (protocol === 'responses') return responsesBody(shape)
  if (protocol === 'chat') return chatBody(shape)
  return anthropicBody(shape)
}

function protocolOf(pathname: string): Protocol {
  if (pathname.endsWith('/responses')) return 'responses'
  if (pathname.endsWith('/messages')) return 'anthropic'
  return 'chat'
}

function respond(protocol: Protocol, fault: FaultServer): Response {
  const retryAfter = String(fault.retryAfterSeconds)
  switch (fault.mode) {
    case 'retry_after_then_ok':
      return fault.receipts.length === 1
        ? new Response('{"error":{"message":"No available accounts"}}', {
            status: 503,
            headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
          })
        : new Response(bodyOf(protocol, 'text'), { headers: SSE_HEADERS })
    case 'hung_error_body':
      return endless('{"error":{"message":"No available accounts', 503, {
        'content-type': 'application/json',
        'retry-after': retryAfter,
      })
    case 'tool_then_no_eof':
      return endless(bodyOf(protocol, 'tool'), 200, SSE_HEADERS)
    case 'inline_error':
      return new Response(bodyOf(protocol, 'inline_error'), { headers: SSE_HEADERS })
    case 'eof_before_terminal':
      return new Response(bodyOf(protocol, 'truncated'), { headers: SSE_HEADERS })
    case 'headers_then_silence':
      // 单个换行只为把响应头冲出去：它不构成任何 SSE 事件，之后一个字节都不再来。
      return endless('\n', 200, SSE_HEADERS)
    case 'keepalive_then_ok':
      return keepAliveThen(protocol)
  }
}

export function startFaultServer(mode: FaultMode): FaultServer {
  const fault: FaultServer = {
    anthropicBaseUrl: '',
    openaiBaseUrl: '',
    receipts: [],
    mode,
    retryAfterSeconds: 1,
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      fault.receipts.push(Date.now())
      const protocol = protocolOf(new URL(req.url).pathname)
      // 请求体必须读完，否则未消费的正文会拖住这一条连接的关闭。
      await req.text()
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
