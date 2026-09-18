/**
 * 覆盖 `transport.ts`：`traceFetch` 记的是响应头到达、正文字节、保活行数，
 * `readTransport` 把它折成失败诊断里的读数。
 *
 * 对端是本机 server，正文按分片发：一条保活行被切在两个分片里也只能计一次。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { newTrace, readTransport, traceFetch } from './transport.ts'

let server: ReturnType<typeof Bun.serve>
let base = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/empty') return new Response(null, { status: 204 })
      const chunks = [': keep-al', 'ive\n\n: keep-alive\n\ndata: {"a":1}\n\n', 'data: [DONE]\n\n']
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(new TextEncoder().encode(c))
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

test('记响应头、正文字节与保活行，正文原样透传', async () => {
  const trace = newTrace()
  const res = await traceFetch(trace)(`${base}/sse`)
  expect(trace.status).toBe(200)
  expect(trace.headersAt).not.toBeNull()
  expect(trace.bytes).toBe(0)

  const text = await res.text()
  expect(text).toBe(': keep-alive\n\n: keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n')
  expect(trace.bytes).toBe(new TextEncoder().encode(text).byteLength)
  expect(trace.keepAliveLines).toBe(2)
  expect(trace.lastByteAt).not.toBeNull()

  const reading = readTransport(trace, trace.lastByteAt! + 1500)
  expect(reading).toEqual({
    status: 200,
    headersAfterMs: trace.headersAt! - trace.sentAt,
    bytes: trace.bytes,
    sinceLastByteMs: 1500,
    keepAliveLines: 2,
  })
})

test('响应头没到时读数全空，状态码为 null', () => {
  const trace = newTrace(1000)
  expect(readTransport(trace, 4000)).toEqual({
    status: null,
    headersAfterMs: null,
    bytes: 0,
    sinceLastByteMs: null,
    keepAliveLines: 0,
  })
})

test('没有正文的响应只记状态码与响应头时刻', async () => {
  const trace = newTrace()
  await traceFetch(trace)(`${base}/empty`)
  expect(trace.status).toBe(204)
  expect(trace.headersAt).not.toBeNull()
  expect(trace.bytes).toBe(0)
  expect(trace.lastByteAt).toBeNull()
})
