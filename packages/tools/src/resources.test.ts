/**
 * 覆盖 `resources.ts`（`read_resource` 的前置校验、字节分页、query 搜索与续查）。
 */

import { describe, expect, test } from 'bun:test'
import type { SinkPort, ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { readResourceTool } from './resources.ts'

const enc = new TextEncoder()

/** 内存假 sink：只需要 read/stat，不需要真落盘。 */
function memSink(body: string | Uint8Array): SinkPort {
  const raw = typeof body === 'string' ? enc.encode(body) : body
  return {
    land: () => ({ resourceId: 'rs_x', contentHash: 'sha256:x' }),
    read: (id, start, length) =>
      id === 'rs_1' ? raw.subarray(start, Math.min(start + length, raw.byteLength)) : null,
    stat: (id) => (id === 'rs_1' ? { sizeBytes: raw.byteLength, mimeType: 'text/plain' } : null),
  }
}

/** 正文已登记但读不出来：分片丢失、解密失败都是这个形状。 */
function brokenSink(sizeBytes: number): SinkPort {
  return {
    land: () => ({ resourceId: 'rs_x', contentHash: 'sha256:x' }),
    read: () => null,
    stat: () => ({ sizeBytes, mimeType: 'text/plain' }),
  }
}

function ctx(sink: SinkPort | null): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
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

interface Page {
  offset: number
  nextOffset: number | null
  content: string
}

/** 沿 nextOffset 一页一页读到末尾。页不前进就直接失败，避免测试自己转不出来。 */
async function pageThrough(sink: SinkPort, length: number): Promise<Page[]> {
  const pages: Page[] = []
  let offset: number | null = 0
  let guard = 0
  while (offset !== null) {
    const r = await run({ resource_id: 'rs_1', offset, length }, sink)
    expect(r.status).toBe('success')
    const page = r.data as unknown as Page
    if (pages.length > 0) expect(page.offset).toBeGreaterThan(pages[pages.length - 1]!.offset)
    pages.push(page)
    offset = page.nextOffset
    guard++
    expect(guard).toBeLessThan(5000)
  }
  return pages
}

interface Hit {
  line: number
  offset: number
  lineOffset: number
  text: string
}

interface SearchPage {
  hits: Hit[]
  offset: number
  nextOffset: number | null
}

/** 沿 nextOffset 把同一个 query 搜到正文末尾。 */
async function searchThrough(sink: SinkPort, query: string, from = 0): Promise<SearchPage[]> {
  const pages: SearchPage[] = []
  let offset: number | null = from
  let guard = 0
  while (offset !== null) {
    const r = await run({ resource_id: 'rs_1', query, offset }, sink)
    expect(r.status).toBe('success')
    const page = r.data as unknown as SearchPage
    pages.push(page)
    offset = page.nextOffset
    guard++
    expect(guard).toBeLessThan(100)
  }
  return pages
}

const byteLen = (s: string) => enc.encode(s).byteLength

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

  test('带 query 时 offset 同样先过越界校验', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 999, query: 'x' }, memSink('short'))
    expect(r.errorKind).toBe('range_out_of_bounds')
  })

  test('读不出整数的 offset 报 invalid_args', async () => {
    const r = await run({ resource_id: 'rs_1', offset: '1,4000' }, memSink('short'))
    expect(r.errorKind).toBe('invalid_args')
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

  test('中文与 emoji 按 4 字节一页读完，拼回逐字相等', async () => {
    const body = '甲乙丙🙂丁'
    const pages = await pageThrough(memSink(body), 4)
    expect(pages.map((p) => p.content).join('')).toBe(body)
    for (const page of pages) expect(page.content).not.toContain('�')
  })

  test('一页只给 1 字节也必须前进，且不切开码点', async () => {
    const body = '甲乙丙🙂丁'
    const pages = await pageThrough(memSink(body), 1)
    expect(pages.map((p) => p.content).join('')).toBe(body)
    expect(pages).toHaveLength(5)
    for (const page of pages) expect(page.content).not.toContain('�')
  })

  test('组合字符逐页读回也逐字相等', async () => {
    const body = 'éà 中́🙂\u{1F469}‍\u{1F680}'
    for (const length of [1, 2, 3, 4, 5]) {
      const pages = await pageThrough(memSink(body), length)
      expect(pages.map((p) => p.content).join('')).toBe(body)
      for (const page of pages) expect(page.content).not.toContain('�')
    }
  })

  test('起点落在码点中间：回报对齐后的实际起点，不产生替换符', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 1, length: 100 }, memSink('甲乙'))
    expect(r.data!.offset).toBe(3)
    expect(r.data!.content).toBe('乙')
    expect(r.data!.content).not.toContain('�')
  })

  test('续读的实际起点就是上一页的 nextOffset', async () => {
    const body = '中文abc🙂尾'
    const sink = memSink(body)
    const first = await run({ resource_id: 'rs_1', offset: 0, length: 5 }, sink)
    const second = await run(
      { resource_id: 'rs_1', offset: first.data!.nextOffset as number, length: 5 },
      sink,
    )
    expect(second.data!.offset).toBe(first.data!.nextOffset)
    expect(body.startsWith(`${first.data!.content}${second.data!.content}`)).toBe(true)
  })

  test('二进制正文不死循环也不抛错', async () => {
    const bytes = new Uint8Array(300)
    for (let i = 0; i < bytes.length; i++) bytes[i] = 0x80 + (i % 0x80)
    const pages = await pageThrough(memSink(bytes), 3)
    expect(pages.length).toBeGreaterThan(50)
    expect(pages[pages.length - 1]!.nextOffset).toBeNull()
  })

  test('正文读不出来时报读失败', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 0, length: 10 }, brokenSink(1000))
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('resource_read_failed')
  })
})

describe('query 搜索', () => {
  const doc = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: payload`).join('\n')

  test('一次调用直接定位到目标行，不必猜偏移', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'line 137:' }, memSink(doc))
    expect(r.status).toBe('success')
    const hits = r.data!.hits as Hit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(137)
    expect(hits[0]!.text).toBe('line 137: payload')
    expect(r.data!.nextOffset).toBeNull()
  })

  test('命中的字节偏移指向命中处 —— 拿它当 offset 读到的就是命中', async () => {
    const sink = memSink(doc)
    const r = await run({ resource_id: 'rs_1', query: 'line 88:' }, sink)
    const hit = (r.data!.hits as Hit[])[0]!
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 16 }, sink)
    expect(back.data!.content).toBe('line 88: payload')
  })

  test('中文正文的命中偏移按 UTF-8 算，且指向命中处而不是行首', async () => {
    const sink = memSink('第一行\n第二行目标\n第三行')
    const r = await run({ resource_id: 'rs_1', query: '目标' }, sink)
    const hit = (r.data!.hits as Hit[])[0]!
    // '第一行\n' = 10 字节，'第二行' = 9 字节。
    expect(hit.offset).toBe(19)
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 6 }, sink)
    expect(back.data!.content).toBe('目标')
  })

  test('没命中是成功不是失败 —— 「确实不在里面」是有效结论', async () => {
    const r = await run({ resource_id: 'rs_1', query: '不存在的关键字' }, memSink(doc))
    expect(r.status).toBe('success')
    expect(r.data!.hits).toHaveLength(0)
    expect(r.data!.nextOffset).toBeNull()
  })

  test('预算够时一页给全，nextOffset 为 null', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'payload' }, memSink(doc))
    expect(r.data!.hits).toHaveLength(200)
    expect(r.data!.nextOffset).toBeNull()
  })

  test('message 只报数量和位置，不重印命中正文', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'line 137:' }, memSink(doc))
    expect(r.message).toContain('命中 1 行')
    expect(r.message).not.toContain('payload')
  })

  test('末尾无换行的最后一行也参与匹配', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'tail' }, memSink('a\nb\ntail-no-newline'))
    const hits = r.data!.hits as Hit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(3)
    expect(hits[0]!.offset).toBe(4)
  })

  test('长 JSON 行的行尾命中：返回命中附近而不是行首', async () => {
    const long = `{"pad":"${'p'.repeat(4000)}","target":"针"}`
    const sink = memSink(`前一行\n${long}\n后一行`)
    const r = await run({ resource_id: 'rs_1', query: '"target"' }, sink)
    const hit = (r.data!.hits as Hit[])[0]!
    expect(hit.line).toBe(2)
    expect(hit.text).toContain('"target":"针"')
    expect(hit.text.length).toBeLessThan(600)
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 20 }, sink)
    expect(String(back.data!.content).startsWith('"target"')).toBe(true)
    const whole = await run({ resource_id: 'rs_1', offset: hit.lineOffset, length: 20 }, sink)
    expect(String(whole.data!.content).startsWith('{"pad"')).toBe(true)
  })

  test('跨扫描步长边界的中文与 emoji 照样命中，偏移不偏', async () => {
    // 分片步长 256 KB：让 emoji 的四个字节压在 262144 上。
    const filler = `${'g'.repeat(262_140)}\n`
    expect(byteLen(filler)).toBe(262_141)
    const sink = memSink(`${filler}A🙂中NEEDLE\n尾行`)
    const r = await run({ resource_id: 'rs_1', query: 'NEEDLE' }, sink)
    const hits = r.data!.hits as Hit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(2)
    expect(hits[0]!.text).toBe('A🙂中NEEDLE')
    expect(hits[0]!.offset).toBe(262_141 + byteLen('A🙂中'))
    const back = await run({ resource_id: 'rs_1', offset: hits[0]!.offset, length: 6 }, sink)
    expect(back.data!.content).toBe('NEEDLE')
  })

  test('正文读不出来时报读失败，不报成没有找到', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'x' }, brokenSink(1000))
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('resource_read_failed')
    expect(r.message).not.toContain('没有找到')
  })
})

describe('query 跨页续查', () => {
  // 240 行，偶数行命中；每条命中两侧都有内容，单页输出量装不下 120 条。
  const lines = Array.from({ length: 240 }, (_, i) =>
    i % 2 === 1
      ? `${'a'.repeat(250)}hit-${i + 1}-mark${'b'.repeat(250)}`
      : `${'a'.repeat(250)}noise${'b'.repeat(250)}`,
  )
  const doc = lines.join('\n')
  const expectedLines = Array.from({ length: 120 }, (_, i) => (i + 1) * 2)
  const lineStart = (lineNo: number) => byteLen(lines.slice(0, lineNo - 1).join('\n')) + 1

  test('120 条命中跨页读完，不漏不重，最后一页 nextOffset 为 null', async () => {
    const pages = await searchThrough(memSink(doc), 'hit-')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[pages.length - 1]!.nextOffset).toBeNull()
    const all = pages.flatMap((p) => p.hits)
    expect(all.map((h) => h.line)).toEqual(expectedLines)
    expect(new Set(all.map((h) => h.offset)).size).toBe(120)
  })

  test('每一页都从上一页的续查位置开始，命中正文里带着自己的行号', async () => {
    const pages = await searchThrough(memSink(doc), 'hit-')
    for (const [i, page] of pages.entries()) {
      if (i > 0) expect(page.offset).toBe(pages[i - 1]!.nextOffset as number)
      for (const hit of page.hits) expect(hit.text).toContain(`hit-${hit.line}-mark`)
    }
  })

  test('offset 真正生效：从中途开始只回它之后的命中，行号仍是全文口径', async () => {
    const from = lineStart(200)
    const pages = await searchThrough(memSink(doc), 'hit-', from)
    const all = pages.flatMap((p) => p.hits)
    expect(pages[0]!.offset).toBe(from)
    expect(all[0]!.line).toBe(200)
    expect(all.map((h) => h.line)).toEqual(expectedLines.filter((n) => n >= 200))
  })

  test('单页装不下时 message 给出续查位置', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'hit-' }, memSink(doc))
    expect(r.data!.nextOffset).not.toBeNull()
    expect(r.message).toContain(`offset=${r.data!.nextOffset}`)
  })

  test('单条命中超过整页预算也照样投递，不返回空页', async () => {
    const needle = 'n'.repeat(20_000)
    const pages = await searchThrough(memSink(`${needle}\n${needle}`), needle)
    expect(pages).toHaveLength(2)
    for (const page of pages) expect(page.hits.length).toBeGreaterThan(0)
    expect(pages.flatMap((p) => p.hits).map((h) => h.line)).toEqual([1, 2])
  })
})
