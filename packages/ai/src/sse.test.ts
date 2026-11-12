/**
 * 覆盖范围：`sse.ts` 的 `readSse`、`SseSplitter` 与 `sseJson`。三种协议的适配器与云端网关共用此分帧实现，
 * 各协议语义的测试位于 `providers/` 下。
 *
 * 本文件只输入内存流，不启动 HTTP 服务：分帧规则与传输无关。读取器在真实响应体上的取消行为
 * 由 `providers/stream-supervision.test.ts` 锁定。
 */

import { expect, test } from 'bun:test'
import { readSse, SSE_DONE, type SseBlock, type SseFrame, SseSplitter, sseJson } from './sse.ts'

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

test('跨分片的半行重新拼接', async () => {
  expect(await collect('data: {"type":"a","de', 'lta":"x"}\n\n')).toEqual([
    { data: '{"type":"a","delta":"x"}' },
  ])
})

/** 一个多字节字符被分割在两个分片中；逐片独立解码会得到替换字符。 */
test('跨分片的 UTF-8 字符解码正确', async () => {
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

/** 中转站在最后一个事件之后直接发送 FIN 是常见情形，末帧不得因缺少空行而被丢弃。 */
test('末帧缺少结尾空行时同样交付', async () => {
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
    // 必须分两次提供：`error()` 会清空队列，同一次中先 enqueue 再 error 时，该帧不会被读取。
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

/** 逐段送入分帧器，返回交出的各段；`cuts` 为切分处的字节偏移。 */
function split(bytes: Uint8Array, cuts: number[]): SseBlock[] {
  const splitter = new SseSplitter()
  const out: SseBlock[] = []
  let from = 0
  for (const cut of [...cuts, bytes.byteLength]) {
    out.push(...splitter.push(bytes.slice(from, cut)))
    from = cut
  }
  return [...out, ...splitter.end()]
}

const joined = (blocks: SseBlock[]) => Buffer.concat(blocks.map((b) => b.bytes))

/**
 * 原样转发字节的调用方（云端网关）逐段转发分帧器交出的字节。帧跨多个分片、一个分片含多帧、CRLF 行尾、
 * 多字节字符被切开、帧中的注释行与末帧缺少空行时，各段拼接后与原字节相同，帧与 `readSse` 读到的相同。
 */
test('分帧器在任意位置切分时交出的字节与原文相同，帧与 readSse 相同', async () => {
  const text =
    ': ping\r\n\r\nevent: a\r\ndata: {"delta":"你好"}\r\n\r\ndata: 第一行\n: 帧中的注释\ndata: 第二行\n\nid: 7\n\ndata: [DONE]'
  const bytes = enc.encode(text)
  const expected = await collect(text)
  expect(expected).toEqual([
    { event: 'a', data: '{"delta":"你好"}' },
    { data: '第一行\n第二行' },
    { data: SSE_DONE },
  ])
  for (let cut = 1; cut < bytes.byteLength; cut++) {
    const blocks = split(bytes, [cut])
    expect(joined(blocks).equals(Buffer.from(bytes))).toBe(true)
    expect(blocks.flatMap((b) => (b.frame ? [b.frame] : []))).toEqual(expected)
  }
  // 逐字节送入：每个分片都不含完整的一帧。
  const single = split(
    bytes,
    Array.from({ length: bytes.byteLength - 1 }, (_, i) => i + 1),
  )
  expect(joined(single).equals(Buffer.from(bytes))).toBe(true)
  expect(single.flatMap((b) => (b.frame ? [b.frame] : []))).toEqual(expected)
})

test('帧之外的注释行读到即交出，帧读到空行才交出', () => {
  const splitter = new SseSplitter()
  const ping = splitter.push(enc.encode(': ping\n'))
  expect(ping.map((b) => [Buffer.from(b.bytes).toString(), b.frame])).toEqual([[': ping\n', null]])
  expect(splitter.push(enc.encode('data: {"a":1}\n'))).toEqual([])
  const frame = splitter.push(enc.encode('\n'))
  expect(frame.map((b) => [Buffer.from(b.bytes).toString(), b.frame])).toEqual([
    ['data: {"a":1}\n\n', { data: '{"a":1}' }],
  ])
  expect(splitter.end()).toEqual([])
})

test('只去除流开头的 BOM', async () => {
  const bom = new Uint8Array([0xef, 0xbb, 0xbf])
  const first = Buffer.concat([bom, enc.encode('data: 1\n\n')])
  expect(await collect(first)).toEqual([{ data: '1' }])
  const later = Buffer.concat([enc.encode('data: 1\n\n'), bom, enc.encode('data: 2\n\n')])
  expect(await collect(later)).toEqual([{ data: '1' }])
})

test('非 JSON 与非对象的 data 解析为 null，不抛出异常', () => {
  expect(sseJson('{"a":1}')).toEqual({ a: 1 })
  expect(sseJson('不是json')).toBeNull()
  expect(sseJson('12')).toBeNull()
  expect(sseJson('null')).toBeNull()
})
