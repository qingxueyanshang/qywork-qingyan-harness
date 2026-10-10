/**
 * 覆盖 `transport.ts` 的响应头之前补发（`traceFetch` 内的 `firstResponse`），以及三个适配器
 * （`anthropic.ts`、`openai-compat.ts`、`openai-responses.ts`）的请求体可以原样再发一次。
 *
 * 原始失败形状：响应头之前挂起的请求只能等满期限再从头重发；调低期限则会中断本身较慢的正常请求。
 * 补发只决定何时多发一份，不中断原请求。对端是本机 server，补发时间缩短为 100 毫秒。
 * 补发、择优与两份都失败时写入的运行日志由截获的 sink 核对。
 */

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { type LogRecord, type ProviderKind, setLogSink } from '@qywork/core'
import { buildAdapter } from './factory.ts'
import { newTrace, readTransport, traceFetch } from './transport.ts'

const HEDGE_MS = 100
let server: ReturnType<typeof Bun.serve>
let hits = 0
let aborted: number[] = []
let handle: (index: number, req: Request) => Response | Promise<Response> = () => new Response('ok')

/** 不返回响应头，直到客户端中断该请求。 */
const hang = (req: Request) =>
  new Promise<Response>((resolve) => {
    req.signal.addEventListener('abort', () => resolve(new Response(null)))
  })
const after = (ms: number, res: () => Response) =>
  new Promise<Response>((resolve) => setTimeout(() => resolve(res()), ms))

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    fetch(req) {
      const index = hits++
      req.signal.addEventListener('abort', () => aborted.push(index))
      return handle(index, req)
    },
  })
})
afterAll(() => server.stop(true))
let logs: LogRecord[] = []
beforeAll(() => setLogSink((record) => void logs.push(record)))
afterAll(() => setLogSink(null))
afterEach(() => {
  hits = 0
  aborted = []
  logs = []
})
const transportLogs = () => logs.filter((r) => r.scope === 'transport').map((r) => r.message)

const url = () => `http://127.0.0.1:${server.port}/v1`
const post = (trace = newTrace(), signal?: AbortSignal, body: RequestInit['body'] = '{"a":1}') =>
  traceFetch(
    trace,
    'openai_chat_completions',
    5_000,
    fetch,
    HEDGE_MS,
  )(url(), {
    method: 'POST',
    body,
    ...(signal ? { signal } : {}),
  })

test('原请求在响应头之前挂起：补发的一份先返回并被采用，原请求随即中断', async () => {
  handle = (i, req) => (i === 0 ? hang(req) : new Response('hedged'))
  const trace = newTrace()
  const res = await post(trace)
  expect(await res.text()).toBe('hedged')
  expect(hits).toBe(2)
  expect(trace.hedge).toMatchObject({ won: true })
  expect(trace.hedge!.sentAt - trace.sentAt).toBeGreaterThanOrEqual(HEDGE_MS - 5)
  await Bun.sleep(50)
  expect(aborted).toContain(0)
  expect(readTransport(trace).hedge).toEqual(trace.hedge!)
  expect(transportLogs()).toEqual([
    '响应头之前等待超过补发时间，补发一份请求',
    '采用补发的一份，原请求已中断',
  ])
  expect(logs[0]?.fields).toMatchObject({ provider: 'openai_chat_completions', waitedSeconds: 0 })
})

test('原请求只是较慢：先返回者为原请求，补发的一份被中断，原请求不受计时影响', async () => {
  handle = (i, req) => (i === 0 ? after(300, () => new Response('original')) : hang(req))
  const trace = newTrace()
  const res = await post(trace)
  expect(await res.text()).toBe('original')
  expect(trace.hedge).toMatchObject({ won: false })
  await Bun.sleep(50)
  expect(aborted).toContain(1)
  expect(transportLogs()).toEqual([
    '响应头之前等待超过补发时间，补发一份请求',
    '采用原请求，补发的一份已中断',
  ])
})

test('响应头在补发时间之前到达时不补发', async () => {
  handle = () => new Response('fast')
  const trace = newTrace()
  expect(await (await post(trace)).text()).toBe('fast')
  await Bun.sleep(HEDGE_MS + 50)
  expect(hits).toBe(1)
  expect(trace.hedge).toBeNull()
  expect('hedge' in readTransport(trace)).toBe(false)
  expect(transportLogs()).toEqual([])
})

test('补发的一份被拒绝时丢弃，继续等待原请求', async () => {
  handle = (i) =>
    i === 0 ? after(300, () => new Response('original')) : new Response('busy', { status: 429 })
  const trace = newTrace()
  const res = await post(trace)
  expect(res.status).toBe(200)
  expect(await res.text()).toBe('original')
  expect(trace.hedge).toMatchObject({ won: false })
})

test('补发之后原请求返回非 2xx 时继续等待补发的一份；两份都失败时以原请求的结果为准', async () => {
  handle = (i) =>
    i === 0
      ? after(200, () => new Response('upstream', { status: 503 }))
      : after(400, () => new Response('hedged'))
  const won = newTrace()
  expect(await (await post(won)).text()).toBe('hedged')
  expect(won.hedge).toMatchObject({ won: true })

  hits = 0
  handle = (i) =>
    i === 0
      ? after(200, () => new Response('first', { status: 503 }))
      : after(300, () => new Response('second', { status: 502 }))
  const lost = newTrace()
  const res = await post(lost)
  expect(res.status).toBe(503)
  expect(lost.status).toBe(503)
  expect(lost.hedge).toMatchObject({ won: false })
  expect(transportLogs().at(-1)).toBe('补发后两份请求均未取得 2xx 响应')
})

test('补发之后原请求的连接被关闭时改用补发的一份', async () => {
  let connections = 0
  const index = new WeakMap<object, number>()
  const raw = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        index.set(socket, connections++)
      },
      data(socket) {
        if (index.get(socket) === 0) {
          setTimeout(() => socket.end(), 200)
          return
        }
        socket.write(
          'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 6\r\nconnection: close\r\n\r\nhedged',
        )
      },
    },
  })
  try {
    const trace = newTrace()
    const res = await traceFetch(
      trace,
      'openai_chat_completions',
      5_000,
      fetch,
      HEDGE_MS,
    )(`http://127.0.0.1:${raw.port}/v1`, { method: 'POST', body: '{}' })
    expect(await res.text()).toBe('hedged')
    expect(trace.hedge).toMatchObject({ won: true })
  } finally {
    raw.stop(true)
  }
})

test('补发之前原请求已失败的，立即报告失败，不补发', async () => {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  const trace = newTrace()
  const started = Date.now()
  await expect(
    traceFetch(
      trace,
      'openai_chat_completions',
      5_000,
      fetch,
      HEDGE_MS,
    )(`http://127.0.0.1:${port}/v1`, { method: 'POST', body: '{}' }),
  ).rejects.toBeDefined()
  expect(Date.now() - started).toBeLessThan(HEDGE_MS)
  expect(trace.hedge).toBeNull()
})

test('调用方中止时两份同时中断，期限仍由调用方的信号执行', async () => {
  handle = (_, req) => hang(req)
  const controller = new AbortController()
  const trace = newTrace()
  const work = post(trace, controller.signal)
  setTimeout(() => controller.abort(), HEDGE_MS + 100)
  await expect(work).rejects.toBeDefined()
  await Bun.sleep(50)
  expect(aborted.sort()).toEqual([0, 1])
  expect(trace.hedge).toMatchObject({ won: false })
})

test('请求体是流时无法原样再发，不补发', async () => {
  handle = (i) => (i === 0 ? after(300, () => new Response('original')) : new Response('x'))
  const trace = newTrace()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'))
      controller.close()
    },
  })
  expect(await (await post(trace, undefined, body)).text()).toBe('original')
  expect(hits).toBe(1)
  expect(trace.hedge).toBeNull()
})

test.each([
  ['anthropic_messages', 'claude-opus-5'],
  ['openai_chat_completions', 'deepseek-flash'],
  ['openai_responses', 'gpt-6.1-sol'],
] as [ProviderKind, string][])('%s 发出的请求体可以原样再发一次', async (kind, model) => {
  handle = () => new Response('{"error":{"message":"bad"}}', { status: 400 })
  const bodies: unknown[] = []
  const original = globalThis.fetch
  const spy = spyOn(globalThis, 'fetch').mockImplementation(((
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    bodies.push(init?.body)
    return original(input, init)
  }) as typeof fetch)
  try {
    const adapter = buildAdapter({ kind, apiKey: 'k', baseUrl: url(), model })
    const stream = adapter.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      maxOutputTokens: 16,
      idleTimeoutMs: 5_000,
      signal: new AbortController().signal,
    })
    await (async () => {
      for await (const _ of stream) {
        // 只需发出请求
      }
    })().catch(() => {})
  } finally {
    spy.mockRestore()
  }
  expect(bodies.length).toBeGreaterThan(0)
  expect(bodies.every((b) => typeof b === 'string')).toBe(true)
})
