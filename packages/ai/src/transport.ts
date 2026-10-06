/**
 * 一次请求的传输层读数与响应体监督。
 *
 * 读数：响应头到达时刻、正文已接收字节数、最后一个字节到达时刻、SSE 注释行
 * （以 `:` 开头，服务端排队时的保活）条数。事件层的静默无法区分三种情形：
 * 响应头未到达（连接或代理层不通）、服务端排队中（只发送保活行，没有 data 事件）、
 * 连接已断开（不再收到任何字节）。三者的处置不同，失败诊断中必须能区分。
 *
 * 监督：响应头到达之后，本文件是判定响应体何时结束的唯一权威：2xx 按字节空闲计时，
 * 非 2xx 按诊断读取上限截断。适配器与 AgentLoop 不另设计时。
 *
 * 每个请求各建一份读数，经 SDK 的 `withOptions({ fetch })` 绑定到该次调用，
 * 不放在适配器实例上：同一个适配器会被并发请求共用。
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

/**
 * 失败时刻的读数。时长均相对于 `now`，写入诊断后不再依赖绝对时刻。
 *
 * `headersAt` 是例外：请求账的对应列记录的是时刻，非 2xx 时只有此路径能将它传出适配器。
 */
export function readTransport(trace: TransportTrace, now = Date.now()): ProviderTransportReading {
  return {
    status: trace.status,
    headersAfterMs: trace.headersAt === null ? null : trace.headersAt - trace.sentAt,
    headersAt: trace.headersAt,
    bytes: trace.bytes,
    sinceLastByteMs: trace.lastByteAt === null ? null : now - trace.lastByteAt,
    keepAliveLines: trace.keepAliveLines,
  }
}

/**
 * 流空闲上限的基准值。响应头到达之后，相邻两批字节之间的间隔超过该时长即判定流已中断。
 *
 * 计算的是间隔而非总时长：一轮 agent 运行十分钟属于正常，十分钟内没有任何字节则不正常。
 * 保活注释行也是字节，到达即重置计时：上游已断开而中转站持续发送心跳时，仅凭该连接
 * 无法判定上游已断开，本层不承诺此项判定。
 *
 * 响应头到达之前不受该上限约束：部分中转站在上游思考结束后才返回响应头，该阶段只有一个上限，
 * 即 `PROVIDER_HTTP.timeout`。不要让计时从请求发出时开始：否则 180 秒会先于 600 秒
 * 中止正在思考的请求，两个超时管理同一阶段即构成两本账。
 * 180 秒用于响应头之后、首个字节之前：不回传思考内容的模型在此阶段不发送任何字节。
 * 误判的代价（中止一次正常的慢请求）大于漏判（无限期挂起）。
 *
 * 运行时自带的 socket 空闲超时已在适配器中关闭（`PROVIDER_HTTP.fetchOptions`），
 * 否则静默 300 秒时连接即被该超时中止，本常量超过 300 秒的部分不会生效。
 */
export const STREAM_IDLE_TIMEOUT_MS = 180_000

/**
 * 非 2xx 正文的诊断读取上限。这是读取错误正文的上限，不是模型的时限：
 * 错误正文由端点一次写完，在上限内未读完说明后续内容不会到达。
 *
 * 达到上限即结束，已读取的前缀连同状态码与响应头原样交给错误分类：容量拒绝的判据在正文中，
 * 只按状态码分类会将「上下文超限」与「参数错误」混为同一种 400。
 * 不要将这两个值调到模型时限的量级：一条永不结束的错误正文会使整轮请求阻塞于此。
 */
const ERROR_BODY_TIMEOUT_MS = 2_000
const ERROR_BODY_MAX_BYTES = 32 * 1024

const COLON = 0x3a
const LF = 0x0a

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * 将一批字节记入 `trace`，返回下一批的行首状态。
 *
 * 注释行按行首为 `:` 计数，行首状态跨分片保持：一条保活行可能被分割在两个分片中。
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
 * 按字节空闲计时的响应体。超时时本地读取方收到 `stream_idle_timeout`，同时释放连接。
 *
 * 本地读取方收到的必须是 `stream_idle_timeout`，不能是 AbortError：后者与用户点击停止时的错误
 * 形状相同，两者此后无法区分。因此先调用 `controller.error()` 确定错误形状，再中止请求；
 * 不要将中止用作向读取方报错的手段。
 */
function supervise(
  trace: TransportTrace,
  body: ReadableStream<Uint8Array>,
  provider: ProviderKind,
  idleMs: number,
  release: () => void,
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
            // 只给出分类短语，不含数字。已接收量与静默时长由 `AgentLoop` 统一补充。
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
        // 先取消再中止：取消使尚未完成的 `read()` 以 done 结束；省略取消时，
        // 中止会使该 `read()` 产生一条未被处理的拒绝。
        await reader.cancel().catch(() => {})
        controller.error(err)
        release()
      } finally {
        clearTimeout(timer)
      }
    },
    async cancel(reason) {
      clearTimeout(timer)
      await reader.cancel(reason).catch(() => {})
      release()
    },
  })
}

/**
 * 非 2xx 正文的有界读取：读到上限即取消上游，返回正文已完整的响应。
 *
 * 必须在此处读完：SDK 与原生路径都需要 `await res.text()` 才能分类，一条永不结束的
 * 错误正文会使它们阻塞于该步骤，而状态码、Retry-After 与可读前缀此时已经取得。
 */
async function boundedErrorBody(
  trace: TransportTrace,
  res: Response,
  body: ReadableStream<Uint8Array>,
  release: () => void,
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
    release()
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
 * 包装 `fetch`：记录响应头与正文字节，并在响应头到达后接管响应体的生命周期。
 *
 * `idleMs` 是 2xx 正文的字节空闲上限，由调用方从 `ChatRequest.idleTimeoutMs` 传入。
 * 响应对象须重建：`body` 是一次性的流，接入监督后只能返回新建的响应。
 *
 * **释放连接依靠中止请求，而非取消 body。** 实测（Bun 1.3.14）：读取方调用 `cancel()` 之后
 * socket 仍保持打开，服务端既收不到断开也不会释放名额。因此此处自带中止器，
 * 与调用方的停止信号并联，正文提前结束（空闲超时、调用方取消、错误正文读到上限）时
 * 中止请求。调用方的信号仍然独立有效，两者不互相替代。
 */
export function traceFetch(
  trace: TransportTrace,
  provider: ProviderKind,
  idleMs: number,
  base: Fetch = fetch,
): Fetch {
  return async (input, init) => {
    const closing = new AbortController()
    const caller = init?.signal
    const release = () => {
      closing.abort()
    }
    const res = await base(input, {
      ...init,
      signal: caller ? AbortSignal.any([caller, closing.signal]) : closing.signal,
    })
    trace.status = res.status
    trace.headersAt = Date.now()
    const body = res.body
    if (!body) return res
    if (!res.ok) return await boundedErrorBody(trace, res, body, release)
    return new Response(supervise(trace, body, provider, idleMs, release), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
