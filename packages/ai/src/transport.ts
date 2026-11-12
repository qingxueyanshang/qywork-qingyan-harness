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
 * 补发：响应头之前长时间无响应时再发一份相同的请求，先开始处理的一份被采用（`traceFetch`）。
 *
 * 每个请求各建一份读数，经 SDK 的 `withOptions({ fetch })` 绑定到该次调用，
 * 不放在适配器实例上：同一个适配器会被并发请求共用。
 */

import {
  log,
  type ProviderHedge,
  type ProviderKind,
  type ProviderTransportReading,
} from '@qywork/core'
import { ProviderError } from './errors.ts'

/**
 * 云端模型网关在响应头中返回的请求号，即云端请求记录（`request_log`）的 id。成功、失败与网关自身的拒绝都返回。
 * 不使用 `x-request-id` 或 `request-id`：上游以这两个名称返回自己的请求号，同名时无法区分是哪一方的编号。
 * 云端引用本常量，名称只定义一处。
 */
export const CLOUD_REQUEST_ID_HEADER = 'x-qywork-request-id'

export interface TransportTrace {
  sentAt: number
  status: number | null
  headersAt: number | null
  bytes: number
  lastByteAt: number | null
  keepAliveLines: number
  hedge: ProviderHedge | null
  /** 非 2xx 响应的正文（`boundedErrorBody` 读取的部分）。2xx 与未收到响应时为 null。 */
  errorBody: string | null
  /** 响应头中的云端请求号（`CLOUD_REQUEST_ID_HEADER`）；未收到响应或不是经云端的请求时为 null。 */
  cloudRequestId: string | null
  /** 补发择优尚未结束时，各份响应的实际读数；选定响应后清除。 */
  pending?: TransportTrace[]
}

export function newTrace(now = Date.now()): TransportTrace {
  return {
    sentAt: now,
    status: null,
    headersAt: null,
    bytes: 0,
    lastByteAt: null,
    keepAliveLines: 0,
    hedge: null,
    errorBody: null,
    cloudRequestId: null,
  }
}

/**
 * 失败时刻的读数。时长均相对于 `now`，写入诊断后不再依赖绝对时刻。
 *
 * `headersAt` 是例外：请求账的对应列记录的是时刻，非 2xx 时只有此路径能将它传出适配器。
 */
export function readTransport(trace: TransportTrace, now = Date.now()): ProviderTransportReading {
  // 尚未选出响应时，也不能把已经收到的响应头和保活报告为零。
  // 顶层取第一份已收到响应头的读数，各份分别列出，避免混合状态码与字节数。
  const pending = trace.hedge ? trace.pending : undefined
  const observed = pending?.find((copy) => copy.headersAt !== null) ?? trace
  return {
    status: observed.status,
    headersAfterMs: observed.headersAt === null ? null : observed.headersAt - trace.sentAt,
    headersAt: observed.headersAt,
    bytes: observed.bytes,
    sinceLastByteMs: observed.lastByteAt === null ? null : now - observed.lastByteAt,
    keepAliveLines: observed.keepAliveLines,
    ...(observed.cloudRequestId ? { cloudRequestId: observed.cloudRequestId } : {}),
    ...(trace.hedge ? { hedge: { ...trace.hedge } } : {}),
    ...(pending
      ? {
          pendingResponses: pending.map((copy, i) => ({
            copy: i === 0 ? ('original' as const) : ('hedge' as const),
            status: copy.status,
            headersAt: copy.headersAt,
            bytes: copy.bytes,
            sinceLastByteMs: copy.lastByteAt === null ? null : now - copy.lastByteAt,
            keepAliveLines: copy.keepAliveLines,
          })),
        }
      : {}),
  }
}

/**
 * 流空闲上限的基准值。响应头到达之后，相邻两批字节之间的间隔超过该时长即判定流已中断。
 *
 * 计算的是间隔而非总时长：一轮 agent 运行十分钟属于正常，十分钟内没有任何字节则不正常。
 * 保活注释行也是字节，到达即重置计时：上游已断开而中转站持续发送心跳时，仅凭该连接
 * 无法判定上游已断开，本层不承诺此项判定。
 *
 * 响应头到达之前不受该上限约束：部分中转站在上游产出第一段内容后才返回响应头，该阶段的期限只有一个，
 * 即 `PROVIDER_HTTP.timeout`（`HEDGE_AFTER_MS` 只触发补发，不中断请求）。不要让计时从请求发出时开始：
 * 否则 180 秒会先于 600 秒中止正在等待的请求，两个超时管理同一阶段即构成两本账。
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

/**
 * 响应头之前补发第二份请求的等待时长。只决定何时多发一份，不中断原请求。
 * 取值：本机账本 3425 次成功请求的响应头最慢 113 秒；思考内容、思考摘要或中转站保活在响应头之后到达，
 * 思考强度不拉长响应头之前的等待，因此不按档位放宽。
 */
export const HEDGE_AFTER_MS = 180_000

const COLON = 0x3a
const LF = 0x0a

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** 可以原样再发一次的请求：地址不是 `Request` 对象，请求体缺省、为字符串或字节。流只能读取一次。 */
function replayable(input: string | URL | Request, init: RequestInit | undefined): boolean {
  const body = init?.body
  return (
    !(input instanceof Request) &&
    (body == null ||
      typeof body === 'string' ||
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer)
  )
}

type Outcome = { res: Response } | { err: unknown }

interface Copy {
  closing: AbortController
  settled: boolean
  trace: TransportTrace
  lineStart: boolean
}

/**
 * 读到第一条 SSE 字段行为止，返回接好的正文（已读出的字节在前，与未读取过一样）与该行是否为错误事件。
 * 注释行（保活）不算：中转站排队等待并发名额时先返回 200 响应头并只发送保活，等不到名额才发出错误事件。
 * 正文结束仍没有字段行时按已开始处理，正文交给适配器解析。
 */
async function firstEvent(
  body: ReadableStream<Uint8Array>,
  copy: Copy,
): Promise<{ body: ReadableStream<Uint8Array>; failed: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const prefix: Uint8Array[] = []
  const rest = (): ReadableStream<Uint8Array> => {
    let next = 0
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (next < prefix.length) {
          controller.enqueue(prefix[next++]!)
          return
        }
        try {
          const { done, value } = await reader.read()
          if (done) controller.close()
          else controller.enqueue(value)
        } catch (err) {
          controller.error(err)
        }
      },
      cancel(reason) {
        return reader.cancel(reason)
      },
    })
  }
  let partial = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { body: rest(), failed: false }
    copy.lineStart = count(copy.trace, value, copy.lineStart)
    prefix.push(value)
    const lines = (partial + decoder.decode(value, { stream: true })).split('\n')
    partial = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (line && !line.startsWith(':')) return { body: rest(), failed: errorEvent(line) }
    }
  }
}

/**
 * 字段行是否为错误事件：`event: error` / `event: response.failed`，或 data 为带 `error` 的对象、
 * `type` 为 `error` / `response.failed` 的对象。三种协议的流内错误均为其中一种。
 */
function errorEvent(line: string): boolean {
  if (line.startsWith('event:')) return /^(error|response\.failed)$/.test(line.slice(6).trim())
  if (!line.startsWith('data:')) return false
  try {
    const v = JSON.parse(line.slice(5)) as Record<string, unknown> | null
    return (
      !!v &&
      typeof v === 'object' &&
      (v.error != null || v.type === 'error' || v.type === 'response.failed')
    )
  } catch {
    return false
  }
}

/**
 * 发出请求，响应头之前等待超过 `hedgeAfterMs` 时补发一份，返回被采用的响应、它的中止器与它的响应头时刻。
 *
 * - 未补发时与补发机制引入之前相同：响应头到达即返回。
 * - 补发之后，以先收到第一条数据事件的一份为准，另一份立即中断。不以响应头为准：
 *   排队中的一份同样先返回 200 响应头，只发保活，随后才报并发超限。
 * - 任一份失败（非 2xx、连接错误、第一条事件为错误）而另一份仍在等待时，继续等待另一份。
 * - 两份都失败，或未补发时，以原请求的结果为准：响应照常交给错误分类，连接错误照常抛出。
 *
 * 补发前原请求已失败的，不再补发：连接被拒、立即被关闭等失败与现状一样立即报告。
 *
 * 补发、择优与两份都失败时各写一行运行日志（`transport`），按时刻与请求账中带补发记录的行对照。
 */
function firstResponse(
  trace: TransportTrace,
  provider: ProviderKind,
  input: string | URL | Request,
  init: RequestInit | undefined,
  base: Fetch,
  hedgeAfterMs: number,
): Promise<{
  res: Response
  closing: AbortController
  headersAt: number
  prefixBytes: number
  lineStart: boolean
}> {
  const caller = init?.signal
  const host = new URL(input instanceof Request ? input.url : input).host
  const seconds = (at: number) => Math.round((at - trace.sentAt) / 1000)
  return new Promise((resolve, reject) => {
    const copies: Copy[] = []
    let original: Outcome | undefined
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const selected = (copy: Copy, res: Response) => {
      const { status, headersAt, bytes, lastByteAt, keepAliveLines, cloudRequestId } = copy.trace
      Object.assign(trace, {
        status,
        headersAt,
        bytes,
        lastByteAt,
        keepAliveLines,
        cloudRequestId,
      })
      delete trace.pending
      return {
        res,
        closing: copy.closing,
        headersAt: headersAt!,
        prefixBytes: bytes,
        lineStart: copy.lineStart,
      }
    }
    const win = (copy: Copy, res: Response) => {
      done = true
      copy.settled = true
      clearTimeout(timer)
      for (const other of copies) if (other !== copy) other.closing.abort()
      const headersAt = copy.trace.headersAt!
      if (trace.hedge) {
        trace.hedge.won = copy !== copies[0]
        log.info(
          'transport',
          trace.hedge.won ? '采用补发的一份，原请求已中断' : '采用原请求，补发的一份已中断',
          { provider, host, headersSeconds: seconds(headersAt) },
        )
      }
      resolve(selected(copy, res))
    }
    const fail = (copy: Copy, outcome: Outcome) => {
      copy.settled = true
      if (done) {
        copy.closing.abort()
        return
      }
      if (copy === copies[0]) original = outcome
      else copy.closing.abort()
      if (copies.some((c) => !c.settled)) return
      done = true
      clearTimeout(timer)
      if (trace.hedge) log.warn('transport', '补发后两份请求均未开始处理', { provider, host })
      const first = copies[0]!
      if (original && 'res' in original) resolve(selected(first, original.res))
      else reject(original?.err)
    }
    const arrived = (copy: Copy, res: Response) => {
      copy.trace.headersAt = Date.now()
      copy.trace.status = res.status
      copy.trace.cloudRequestId = res.headers.get(CLOUD_REQUEST_ID_HEADER)
      if (done) {
        copy.closing.abort()
        return
      }
      if (!res.ok) return fail(copy, { res })
      if (!trace.hedge || !res.body) return win(copy, res)
      firstEvent(res.body, copy).then(
        ({ body, failed }) => {
          if (done) {
            copy.closing.abort()
            return
          }
          const joined = new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          })
          if (failed) fail(copy, { res: joined })
          else win(copy, joined)
        },
        (err: unknown) => fail(copy, { err }),
      )
    }
    const send = () => {
      const copy: Copy = {
        closing: new AbortController(),
        settled: false,
        trace: newTrace(),
        lineStart: true,
      }
      copies.push(copy)
      trace.pending = copies.map((item) => item.trace)
      base(input, {
        ...init,
        signal: caller ? AbortSignal.any([caller, copy.closing.signal]) : copy.closing.signal,
      }).then(
        (res) => arrived(copy, res),
        (err: unknown) => fail(copy, { err }),
      )
    }
    send()
    if (!replayable(input, init)) return
    timer = setTimeout(() => {
      if (done || caller?.aborted) return
      trace.hedge = { sentAt: Date.now(), won: false }
      log.warn('transport', '响应头之前等待超过补发时间，补发一份请求', {
        provider,
        host,
        waitedSeconds: seconds(trace.hedge.sentAt),
      })
      send()
    }, hedgeAfterMs)
  })
}

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
  prefixBytes: number,
  lineStart: boolean,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
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
        // 择优阶段已读的前缀只回放给解析器，不重复计数或刷新最后接收时刻。
        const skipped = Math.min(prefixBytes, result.value.byteLength)
        prefixBytes -= skipped
        const fresh = result.value.subarray(skipped)
        if (fresh.byteLength > 0) lineStart = count(trace, fresh, lineStart)
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
  trace.errorBody = new TextDecoder().decode(joined)
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
 *
 * **响应头之前补发一份**（`firstResponse`）：计时只决定何时多发一份，不中断原请求，本身较慢的请求不会因此被丢弃；
 * 响应头之前的期限仍由调用方的信号执行（`PROVIDER_HTTP.timeout`），到期时两份同时中止。
 */
export function traceFetch(
  trace: TransportTrace,
  provider: ProviderKind,
  idleMs: number,
  base: Fetch = fetch,
  hedgeAfterMs = HEDGE_AFTER_MS,
): Fetch {
  return async (input, init) => {
    const { res, closing, headersAt, prefixBytes, lineStart } = await firstResponse(
      trace,
      provider,
      input,
      init,
      base,
      hedgeAfterMs,
    )
    const release = () => {
      closing.abort()
    }
    trace.status = res.status
    trace.headersAt = headersAt
    const body = res.body
    if (!body) return res
    if (!res.ok) return await boundedErrorBody(trace, res, body, release)
    return new Response(supervise(trace, body, provider, idleMs, release, prefixBytes, lineStart), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
