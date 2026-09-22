/**
 * 一次请求的传输层读数与响应体监督。
 *
 * 读数：响应头何时到、正文收了多少字节、最后一个字节何时到、SSE 注释行
 * （`:` 开头，服务端排队时的保活）有几条。事件层的「静默」分不出三种情形：
 * 响应头没到（连接或代理层没通）、服务端排队中（只发保活行，没有 data 事件）、
 * 连接已死（一个字节都不再来）。三者的处置不同，失败诊断里要能看出是哪一种。
 *
 * 监督：响应头到达之后，本文件是响应体何时算结束的唯一权威——2xx 按字节空闲计时，
 * 非 2xx 按诊断读取上限截断。适配器与 AgentLoop 不再各起一份计时。
 *
 * 读数按请求各建一份，经 SDK 的 `withOptions({ fetch })` 挂到那一次调用上，
 * 不放在适配器实例上：同一个适配器会被并发的请求共用。
 */

import type { ProviderKind, ProviderTransportReading } from '@qywork/core'
import { ProviderError } from './errors.ts'

export interface TransportTrace {
  sentAt: number
  status: number | null
  headersAt: number | null
  bytes: number
  lastByteAt: number | null
  keepAliveLines: number
}

export function newTrace(now = Date.now()): TransportTrace {
  return {
    sentAt: now,
    status: null,
    headersAt: null,
    bytes: 0,
    lastByteAt: null,
    keepAliveLines: 0,
  }
}

/** 失败时刻的读数。时长都相对于 `now`，落进诊断后不再依赖绝对时刻。 */
export function readTransport(trace: TransportTrace, now = Date.now()): ProviderTransportReading {
  return {
    status: trace.status,
    headersAfterMs: trace.headersAt === null ? null : trace.headersAt - trace.sentAt,
    bytes: trace.bytes,
    sinceLastByteMs: trace.lastByteAt === null ? null : now - trace.lastByteAt,
    keepAliveLines: trace.keepAliveLines,
  }
}

/**
 * 流空闲上限的基准值。响应头到达之后，**相邻两批字节之间**超过这个时长就判流已断。
 *
 * 计的是**间隔**不是总时长：一轮 agent 跑十分钟是正常的，十分钟里一个字节都没有不是。
 * 保活注释行是字节，它一到就重置计时——中转替已死上游持续发心跳时，仅凭这条连接
 * 判不出上游已死，本层不承诺这件事。
 *
 * 响应头之前不归它管：有的中转站要等上游思考结束才回响应头，那一段只有一个上限，
 * 是 `PROVIDER_HTTP.timeout`。不要让计时从发出就开始——那样 180 秒会先于 600 秒
 * 掐掉一次正在思考的请求，两个超时管同一段就是两本账。
 * 180 秒留给响应头之后、首个字节之前：思考不回传的模型在这段一个字节都没有。
 * 判错的代价（把一次正常的慢请求掐掉）比判漏（无限期挂住）大。
 *
 * 运行时自带的 socket 空闲超时在适配器里已关掉（`PROVIDER_HTTP.fetchOptions`），
 * 不然静默 300 秒就被它先掐，这个数超过 300 的部分从不生效。
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000

/**
 * 非 2xx 正文的诊断读取上限。**这是读错误正文的上限，不是模型的时限**——
 * 错误正文由端点一次写完，读不完说明它不会再来。
 *
 * 到界即结束，已读到的前缀连同状态码与响应头原样交给错误分类：容量拒绝的判据在正文里，
 * 只拿状态码分类会把「上下文超了」和「参数写错了」混成同一个 400。
 * 不要把这两个数调到模型时限的量级：一条永不结束的错误正文会把整轮请求挂在这里。
 */
const ERROR_BODY_TIMEOUT_MS = 2_000
const ERROR_BODY_MAX_BYTES = 32 * 1024

const COLON = 0x3a
const LF = 0x0a

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * 把一批字节记进 `trace`，返回下一批的行首状态。
 *
 * 注释行按「行首是 `:`」计数，行首状态跨分片保持：一条保活行可能被切在两个分片里。
 */
function count(trace: TransportTrace, chunk: Uint8Array, lineStart: boolean): boolean {
  trace.bytes += chunk.byteLength
  trace.lastByteAt = Date.now()
  let atLineStart = lineStart
  for (const byte of chunk) {
    if (atLineStart && byte === COLON) trace.keepAliveLines++
    atLineStart = byte === LF
  }
  return atLineStart
}

/**
 * 按字节空闲计时的响应体。超时时让本地读者拿到 `stream_idle_timeout`，同时取消上游。
 *
 * 不要改成 `AbortController` 中止整个请求：SDK 会把它包装成 AbortError，与用户按停止
 * 落到同一个形状，两者从此分不开。
 */
function supervise(
  trace: TransportTrace,
  body: ReadableStream<Uint8Array>,
  provider: ProviderKind,
  idleMs: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let lineStart = true
  let timer: ReturnType<typeof setTimeout> | undefined
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new ProviderError({
            code: 'stream_idle_timeout',
            // 只给分类短语，不带数字。「收到了多少 / 多久没动静」由 `AgentLoop` 统一补。
            message: '模型响应中断',
            provider,
            timedOut: true,
          })
          err.transport = readTransport(trace)
          reject(err)
        }, idleMs)
      })
      try {
        const result = await Promise.race([reader.read(), idle])
        if (result.done) {
          controller.close()
          return
        }
        lineStart = count(trace, result.value, lineStart)
        controller.enqueue(result.value)
      } catch (err) {
        await reader.cancel().catch(() => {})
        controller.error(err)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      return reader.cancel(reason)
    },
  })
}

/**
 * 非 2xx 正文的有界读取：读到上限就取消上游，交出一个正文已完结的响应。
 *
 * 必须在这里读完：SDK 与原生路径都要 `await res.text()` 才能分类，一条永不结束的
 * 错误正文会把它们挂在那一步，而状态码、Retry-After 与可读前缀此刻已经到手。
 */
async function boundedErrorBody(
  trace: TransportTrace,
  res: Response,
  body: ReadableStream<Uint8Array>,
): Promise<Response> {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  let lineStart = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ERROR_BODY_TIMEOUT_MS)
  })
  try {
    while (total < ERROR_BODY_MAX_BYTES) {
      const result = await Promise.race([reader.read(), deadline])
      if (result === null || result.done) break
      lineStart = count(trace, result.value, lineStart)
      parts.push(result.value)
      total += result.value.byteLength
    }
  } finally {
    clearTimeout(timer)
    await reader.cancel().catch(() => {})
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return new Response(joined, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

/**
 * 包一层 `fetch`：记响应头与正文字节，并在响应头到达后接管响应体的生命周期。
 *
 * `idleMs` 是 2xx 正文的字节空闲上限，由调用方从 `ChatRequest.idleTimeoutMs` 传入。
 * 响应对象要重建：`body` 是一次性的流，接了监督就只能交出新的那一份。
 */
export function traceFetch(
  trace: TransportTrace,
  provider: ProviderKind,
  idleMs: number,
  base: Fetch = fetch,
): Fetch {
  return async (input, init) => {
    const res = await base(input, init)
    trace.status = res.status
    trace.headersAt = Date.now()
    const body = res.body
    if (!body) return res
    if (!res.ok) return await boundedErrorBody(trace, res, body)
    return new Response(supervise(trace, body, provider, idleMs), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
