/**
 * 覆盖 `transport.ts`：`traceFetch` 记录响应头、正文字节与保活行数，并在响应头到达后接管
 * 响应体：2xx 按字节空闲计时，非 2xx 按诊断读取上限截断；`readTransport` 将读数
 * 转换为失败诊断中的字段。
 *
 * 对端是本机 server，正文分片发送：一条保活行被分割在两个分片中时只计一次。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { ProviderError } from './errors.ts'
import { newTrace, readTransport, traceFetch } from './transport.ts'

const enc = new TextEncoder()

let server: ReturnType<typeof Bun.serve>
let base = ''

/**
 * 永不结束的正文：调用方必须自行取消，否则读取方持续挂起。
 *
 * `prefix` 不能为空：`Bun.serve` 在正文的第一个分片写入后才发送响应头，
 * 不写入任何字节时客户端无法收到响应头，也就无法测试响应头之后的静默。
 */
function endless(prefix: string, status: number, headers: Record<string, string>): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(prefix))
    },
  })
  return new Response(body, { status, headers })
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/empty') return new Response(null, { status: 204 })
      // 单个换行只用于促使响应头发出：它不构成任何 SSE 事件，之后不再发送任何字节。
      if (path === '/silent') return endless('\n', 200, { 'content-type': 'text/event-stream' })
      if (path === '/slow-headers') {
        await Bun.sleep(400)
        return new Response('data: {"a":1}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (path === '/keepalive') {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 5; i++) {
              controller.enqueue(enc.encode(': ping\n\n'))
              await Bun.sleep(60)
            }
            controller.enqueue(enc.encode('data: {"a":1}\n\n'))
            controller.close()
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      if (path === '/hung-error') {
        return endless('{"error":{"message":"No available accounts', 503, {
          'content-type': 'application/json',
          'retry-after': '60',
        })
      }
      if (path === '/huge-error') {
        return endless('x'.repeat(200 * 1024), 503, { 'content-type': 'application/json' })
      }
      const chunks = [': keep-al', 'ive\n\n: keep-alive\n\ndata: {"a":1}\n\n', 'data: [DONE]\n\n']
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(enc.encode(c))
            await Bun.sleep(5)
          }
          controller.close()
        },
      })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => server.stop(true))

test('记录响应头、正文字节与保活行，正文原样透传', async () => {
  const trace = newTrace()
  const res = await traceFetch(trace, 'openai_responses', 5_000)(`${base}/sse`)
  expect(trace.status).toBe(200)
  expect(trace.headersAt).not.toBeNull()
  expect(trace.bytes).toBe(0)

  const text = await res.text()
  expect(text).toBe(': keep-alive\n\n: keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n')
  expect(trace.bytes).toBe(enc.encode(text).byteLength)
  expect(trace.keepAliveLines).toBe(2)
  expect(trace.lastByteAt).not.toBeNull()

  const reading = readTransport(trace, trace.lastByteAt! + 1500)
  expect(reading).toEqual({
    status: 200,
    headersAfterMs: trace.headersAt! - trace.sentAt,
    headersAt: trace.headersAt,
    bytes: trace.bytes,
    sinceLastByteMs: 1500,
    keepAliveLines: 2,
  })
})

test('响应头未到达时读数全部为空，状态码为 null', () => {
  const trace = newTrace(1000)
  expect(readTransport(trace, 4000)).toEqual({
    status: null,
    headersAfterMs: null,
    headersAt: null,
    bytes: 0,
    sinceLastByteMs: null,
    keepAliveLines: 0,
  })
})

test('没有正文的响应只记录状态码与响应头时刻', async () => {
  const trace = newTrace()
  await traceFetch(trace, 'openai_responses', 5_000)(`${base}/empty`)
  expect(trace.status).toBe(204)
  expect(trace.headersAt).not.toBeNull()
  expect(trace.bytes).toBe(0)
  expect(trace.lastByteAt).toBeNull()
})

test('响应头之后不再收到字节，按空闲上限使读取方失败并附带读数', async () => {
  const trace = newTrace()
  const res = await traceFetch(trace, 'anthropic_messages', 200)(`${base}/silent`)
  const started = Date.now()
  const err = await res.text().then(
    () => null,
    (e: unknown) => e,
  )
  const elapsed = Date.now() - started
  expect(err).toBeInstanceOf(ProviderError)
  const pe = err as ProviderError
  expect(pe.code).toBe('stream_idle_timeout')
  expect(pe.message).toBe('模型响应中断')
  expect(pe.provider).toBe('anthropic_messages')
  expect(pe.timedOut).toBe(true)
  expect(pe.transport?.status).toBe(200)
  expect(pe.transport?.bytes).toBe(1)
  expect(pe.transport?.keepAliveLines).toBe(0)
  expect(pe.transport?.sinceLastByteMs).toBeGreaterThanOrEqual(150)
  expect(elapsed).toBeLessThan(2_000)
})

test('空闲时间从响应头到达起算，响应头之前的等待不计为空闲', async () => {
  const trace = newTrace()
  const res = await traceFetch(trace, 'openai_responses', 200)(`${base}/slow-headers`)
  expect(trace.headersAt! - trace.sentAt).toBeGreaterThanOrEqual(300)
  expect(await res.text()).toBe('data: {"a":1}\n\n')
})

test('保活注释行重置空闲计时，间隔短于上限时不中止', async () => {
  const trace = newTrace()
  const res = await traceFetch(trace, 'openai_responses', 300)(`${base}/keepalive`)
  const text = await res.text()
  expect(text.endsWith('data: {"a":1}\n\n')).toBe(true)
  expect(trace.keepAliveLines).toBe(5)
})

test('非 2xx 正文永不结束时按时限截断，状态码与响应头原样返回', async () => {
  const trace = newTrace()
  const started = Date.now()
  const res = await traceFetch(trace, 'openai_responses', 60_000)(`${base}/hung-error`)
  const text = await res.text()
  const elapsed = Date.now() - started
  expect(res.status).toBe(503)
  expect(res.headers.get('retry-after')).toBe('60')
  expect(text).toBe('{"error":{"message":"No available accounts')
  expect(elapsed).toBeGreaterThanOrEqual(1_800)
  expect(elapsed).toBeLessThan(6_000)
  expect(trace.status).toBe(503)
  expect(trace.bytes).toBe(text.length)
})

test('非 2xx 正文超过字节上限时提前结束读取，不等待时限届满', async () => {
  const trace = newTrace()
  const started = Date.now()
  const res = await traceFetch(trace, 'openai_responses', 60_000)(`${base}/huge-error`)
  const text = await res.text()
  expect(text.length).toBeGreaterThanOrEqual(32 * 1024)
  expect(Date.now() - started).toBeLessThan(1_500)
  expect(trace.bytes).toBe(text.length)
})
