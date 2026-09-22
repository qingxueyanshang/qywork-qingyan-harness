/**
 * 覆盖范围：`sse.ts` 的 `readSse` 与 `sseJson`。三条协议的适配器共用这一份分帧，
 * 协议语义各自的测试在 `providers/` 下。
 *
 * 这里只喂内存流，不起 HTTP：分帧规则与传输无关。读取器在真实响应体上的取消行为
 * 由 `providers/stream-supervision.test.ts` 锁。
 */

import { expect, test } from 'bun:test'
import { readSse, SSE_DONE, type SseFrame, sseJson } from './sse.ts'

const enc = new TextEncoder()

function streamOf(...chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk)
      c.close()
    },
  })
}

async function collect(...chunks: (string | Uint8Array)[]): Promise<SseFrame[]> {
  const out: SseFrame[] = []
  for await (const frame of readSse(streamOf(...chunks))) out.push(frame)
  return out
}

test('逐帧解析 data 行，空行分帧', async () => {
  const frames = await collect(
    'event: response.output_text.delta\ndata: {"delta":"你"}\n\n',
    'data: {"delta":"好"}\n\n',
  )
  expect(frames).toEqual([
    { event: 'response.output_text.delta', data: '{"delta":"你"}' },
    { data: '{"delta":"好"}' },
  ])
})

test('同一帧的多条 data 行按换行合并', async () => {
  expect(await collect('data: 第一行\ndata: 第二行\n\n')).toEqual([{ data: '第一行\n第二行' }])
})

test('注释行跳过，不成帧', async () => {
  expect(await collect(': ping\n\n: ping\n\ndata: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }])
})

test('[DONE] 原样交给调用方', async () => {
  const frames = await collect('data: {"a":1}\n\ndata: [DONE]\n\n')
  expect(frames.map((f) => f.data)).toEqual(['{"a":1}', SSE_DONE])
})

test('跨分片的半行拼回来', async () => {
  expect(await collect('data: {"type":"a","de', 'lta":"x"}\n\n')).toEqual([
    { data: '{"type":"a","delta":"x"}' },
  ])
})

/** 一个多字节字符被切在两个分片之间；逐片独立解码会得到替换字符。 */
test('跨分片的 UTF-8 字符不被切坏', async () => {
  const bytes = enc.encode('data: {"delta":"好"}\n\n')
  const cut = 17
  const frames = await collect(bytes.slice(0, cut), bytes.slice(cut))
  expect(frames).toEqual([{ data: '{"delta":"好"}' }])
})

test('CRLF 行尾按 LF 处理', async () => {
  expect(await collect('event: ping\r\ndata: {"a":1}\r\n\r\n')).toEqual([
    { event: 'ping', data: '{"a":1}' },
  ])
})

/** 中转在最后一个事件之后直接 FIN 是常见形状，末帧不能因为缺空行被丢掉。 */
test('末帧没有空行收尾时照样交付', async () => {
  expect(await collect('data: {"a":1}')).toEqual([{ data: '{"a":1}' }])
})

test('调用方提前结束：释放 reader 并取消 body', async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode('data: {"a":1}\n\ndata: {"a":2}\n\n'))
    },
    cancel() {
      cancelled = true
    },
  })
  for await (const frame of readSse(body)) {
    expect(frame.data).toBe('{"a":1}')
    break
  }
  expect(cancelled).toBe(true)
})

test('body 出错原样抛出，不改写成协议错误', async () => {
  const boom = new Error('模型响应中断')
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    // 必须分两次给：`error()` 会清空队列，同一次里 enqueue 再 error 等于那一帧从没发生过。
    pull(c) {
      pulls++
      if (pulls === 1) c.enqueue(enc.encode('data: {"a":1}\n\n'))
      else c.error(boom)
    },
  })
  const seen: SseFrame[] = []
  let thrown: unknown = null
  try {
    for await (const frame of readSse(body)) seen.push(frame)
  } catch (err) {
    thrown = err
  }
  expect(seen).toEqual([{ data: '{"a":1}' }])
  expect(thrown).toBe(boom)
})

test('非 JSON 与非对象的 data 读成 null，不抛', () => {
  expect(sseJson('{"a":1}')).toEqual({ a: 1 })
  expect(sseJson('不是json')).toBeNull()
  expect(sseJson('12')).toBeNull()
  expect(sseJson('null')).toBeNull()
})
