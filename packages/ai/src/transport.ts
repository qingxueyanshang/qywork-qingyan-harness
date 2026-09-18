/**
 * 一次请求的传输层读数：响应头何时到、正文收了多少字节、最后一个字节何时到、
 * SSE 注释行（`:` 开头，服务端排队时的保活）有几条。
 *
 * 事件层的「静默」分不出三种情形：响应头没到（连接或代理层没通）、服务端排队中
 * （只发保活行，没有 data 事件）、连接已死（一个字节都不再来）。三者的处置不同，
 * 失败诊断里要能看出是哪一种。
 *
 * 读数按请求各建一份，经 SDK 的 `withOptions({ fetch })` 挂到那一次调用上，
 * 不放在适配器实例上：同一个适配器会被并发的请求共用。
 */

import type { ProviderTransportReading } from '@qywork/core'

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

const COLON = 0x3a
const LF = 0x0a

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * 包一层 `fetch`，把响应头与正文字节记进 `trace`，正文原样透传。
 *
 * 注释行按「行首是 `:`」计数，行首状态跨分片保持：一条保活行可能被切在两个分片里。
 * 响应对象要重建：`body` 是一次性的流，接了计数器就只能交出新的那一份。
 */
export function traceFetch(trace: TransportTrace, base: Fetch = fetch): Fetch {
  return async (input, init) => {
    const res = await base(input, init)
    trace.status = res.status
    trace.headersAt = Date.now()
    if (!res.body) return res
    let lineStart = true
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          trace.bytes += chunk.byteLength
          trace.lastByteAt = Date.now()
          for (const byte of chunk) {
            if (lineStart && byte === COLON) trace.keepAliveLines++
            lineStart = byte === LF
          }
          controller.enqueue(chunk)
        },
      }),
    )
    return new Response(counted, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
