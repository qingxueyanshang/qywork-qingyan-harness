import { describe, expect, test } from 'bun:test'
import type { SinkPort, ToolContext } from '@qywork/agent'
import { readResourceTool } from './resources.ts'

const enc = new TextEncoder()

/** 内存假 sink：只需要 read/stat，不需要真落盘。 */
function memSink(body: string): SinkPort {
  const raw = enc.encode(body)
  return {
    land: () => ({ resourceId: 'rs_x', contentHash: 'sha256:x' }),
    read: (id, start, length) =>
      id === 'rs_1' ? raw.subarray(start, Math.min(start + length, raw.byteLength)) : null,
    stat: (id) => (id === 'rs_1' ? { sizeBytes: raw.byteLength, mimeType: 'text/plain' } : null),
  }
}

function ctx(sink: SinkPort | null): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

const run = (args: Record<string, unknown>, sink: SinkPort | null) =>
  readResourceTool.fn(args, ctx(sink))

describe('前置校验', () => {
  test('没有正文库时如实说，不谎称资源不存在', async () => {
    const r = await run({ resource_id: 'rs_1' }, null)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('sink_unavailable')
  })

  test('未知资源报 not_found', async () => {
    const r = await run({ resource_id: 'rs_nope' }, memSink('x'))
    expect(r.errorKind).toBe('resource_not_found')
  })

  test('偏移越界报错而不是返回空内容', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 999 }, memSink('short'))
    expect(r.errorKind).toBe('range_out_of_bounds')
  })
})

describe('分段读取', () => {
  test('返回 nextOffset 供继续读', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 0, length: 5 }, memSink('0123456789'))
    expect(r.status).toBe('success')
    expect(r.data!.offset).toBe(0)
    expect(r.data!.nextOffset).toBe(5)
    expect(r.data!.content).toBe('01234')
  })

  test('读到末尾时 nextOffset 为 null', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 5, length: 100 }, memSink('0123456789'))
    expect(r.data!.nextOffset).toBeNull()
    expect(r.data!.content).toBe('56789')
  })

  test('位置信息出现在 message 里 —— 模型读的是 message', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 0, length: 3 }, memSink('0123456789'))
    expect(r.message).toContain('offset=3')
  })
})

describe('query 投影', () => {
  const doc = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: payload`).join('\n')

  test('一次调用直接定位到目标行，不必猜偏移', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'line 137:' }, memSink(doc))
    expect(r.status).toBe('success')
    const hits = r.data!.hits as { line: number; offset: number; text: string }[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(137)
    expect(hits[0]!.text).toBe('line 137: payload')
  })

  test('命中行的字节偏移是准确的 —— 拿它当 offset 能读到同一行', async () => {
    const sink = memSink(doc)
    const r = await run({ resource_id: 'rs_1', query: 'line 88:' }, sink)
    const hit = (r.data!.hits as { offset: number }[])[0]!
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 16 }, sink)
    expect(back.data!.content).toBe('line 88: payload')
  })

  test('没命中是成功不是失败 —— 「确实不在里面」是有效结论', async () => {
    const r = await run({ resource_id: 'rs_1', query: '不存在的关键字' }, memSink(doc))
    expect(r.status).toBe('success')
    expect(r.data!.hits).toHaveLength(0)
    expect(r.data!.totalLines).toBe(200)
  })

  test('多行命中全部返回', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'payload' }, memSink(doc))
    const hits = r.data!.hits as unknown[]
    // 输出预算会截，但至少要命中其中绝大多数。
    expect(hits.length).toBeGreaterThan(100)
  })

  test('末尾无换行的最后一行也参与匹配', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'tail' }, memSink('a\nb\ntail-no-newline'))
    const hits = r.data!.hits as { line: number }[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(3)
  })

  test('中文正文的字节偏移按 UTF-8 算，不按字符数', async () => {
    const sink = memSink('第一行\n第二行目标\n第三行')
    const r = await run({ resource_id: 'rs_1', query: '目标' }, sink)
    const hit = (r.data!.hits as { offset: number }[])[0]!
    // '第一行\n' = 3*3+1 = 10 字节
    expect(hit.offset).toBe(10)
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 15 }, sink)
    expect(back.data!.content).toBe('第二行目标')
  })
})
