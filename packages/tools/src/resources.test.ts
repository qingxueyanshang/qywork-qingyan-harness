/**
 * 覆盖 `resources.ts`（`read_resource` 的前置校验、字节分页、query 搜索与续查、按投递额度分页）。
 */

import { describe, expect, test } from 'bun:test'
import { openBatchBudget, outcomeTokens, type SinkPort, type ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { readResourceTool } from './resources.ts'
import { MIN_DELIVERY_BYTES } from './sink.ts'

const enc = new TextEncoder()

/** 内存中的模拟 sink：只需要 read/stat，无需实际写入磁盘。 */
function memSink(body: string | Uint8Array): SinkPort {
  const raw = typeof body === 'string' ? enc.encode(body) : body
  return {
    land: () => ({ resourceId: 'rs_x', contentHash: 'sha256:x' }),
    read: (id, start, length) =>
      id === 'rs_1' ? raw.subarray(start, Math.min(start + length, raw.byteLength)) : null,
    stat: (id) => (id === 'rs_1' ? { sizeBytes: raw.byteLength, mimeType: 'text/plain' } : null),
  }
}

/** 正文已登记但无法读取：分片丢失、解密失败均属此类。 */
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
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

const run = (args: Record<string, unknown>, sink: SinkPort | null) =>
  readResourceTool.fn(args, ctx(sink))

interface Page {
  offset: number
  nextOffset: number | null
  content: string
}

/** 沿 nextOffset 逐页读取到末尾。页位置不前进时直接失败，避免测试陷入死循环。 */
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
  wholeLine: boolean
}

interface SearchPage {
  hits: Hit[]
  offset: number
  nextOffset: number | null
}

/** 沿 nextOffset 用同一个 query 搜索到正文末尾。 */
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
  test('没有正文库时如实报告，不误报资源不存在', async () => {
    const r = await run({ resource_id: 'rs_1' }, null)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('sink_unavailable')
  })

  test('未知资源报告 not_found', async () => {
    const r = await run({ resource_id: 'rs_nope' }, memSink('x'))
    expect(r.errorKind).toBe('resource_not_found')
  })

  test('偏移越界报错而不是返回空内容', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 999 }, memSink('short'))
    expect(r.errorKind).toBe('range_out_of_bounds')
  })

  test('带 query 时 offset 同样先经过越界校验', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 999, query: 'x' }, memSink('short'))
    expect(r.errorKind).toBe('range_out_of_bounds')
  })

  test('无法解析为整数的 offset 报告 invalid_args', async () => {
    const r = await run({ resource_id: 'rs_1', offset: '1,4000' }, memSink('short'))
    expect(r.errorKind).toBe('invalid_args')
  })
})

describe('分段读取', () => {
  test('返回 nextOffset 供继续读取', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 0, length: 5 }, memSink('0123456789'))
    expect(r.status).toBe('success')
    expect(r.data!.offset).toBe(0)
    expect(r.data!.nextOffset).toBe(5)
    expect(r.data!.content).toBe('01234')
  })

  test('读取到末尾时 nextOffset 为 null', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 5, length: 100 }, memSink('0123456789'))
    expect(r.data!.nextOffset).toBeNull()
    expect(r.data!.content).toBe('56789')
  })

  test('位置信息出现在 message 中：模型读取的是 message', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 0, length: 3 }, memSink('0123456789'))
    expect(r.message).toContain('offset=3')
  })

  test('中文与 emoji 按每页 4 字节读完，拼接后逐字相等', async () => {
    const body = '甲乙丙🙂丁'
    const pages = await pageThrough(memSink(body), 4)
    expect(pages.map((p) => p.content).join('')).toBe(body)
    for (const page of pages) expect(page.content).not.toContain('�')
  })

  test('每页只有 1 字节时也必须前进，且不切开码点', async () => {
    const body = '甲乙丙🙂丁'
    const pages = await pageThrough(memSink(body), 1)
    expect(pages.map((p) => p.content).join('')).toBe(body)
    expect(pages).toHaveLength(5)
    for (const page of pages) expect(page.content).not.toContain('�')
  })

  test('组合字符逐页读取后同样逐字相等', async () => {
    const body = 'éà 中́🙂\u{1F469}‍\u{1F680}'
    for (const length of [1, 2, 3, 4, 5]) {
      const pages = await pageThrough(memSink(body), length)
      expect(pages.map((p) => p.content).join('')).toBe(body)
      for (const page of pages) expect(page.content).not.toContain('�')
    }
  })

  test('起点落在码点中间：返回对齐后的实际起点，不产生替换符', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 1, length: 100 }, memSink('甲乙'))
    expect(r.data!.offset).toBe(3)
    expect(r.data!.content).toBe('乙')
    expect(r.data!.content).not.toContain('�')
  })

  test('续读的实际起点即上一页的 nextOffset', async () => {
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

  test('二进制正文不陷入死循环，也不抛出错误', async () => {
    const bytes = new Uint8Array(300)
    for (let i = 0; i < bytes.length; i++) bytes[i] = 0x80 + (i % 0x80)
    const pages = await pageThrough(memSink(bytes), 3)
    expect(pages.length).toBeGreaterThan(50)
    expect(pages[pages.length - 1]!.nextOffset).toBeNull()
  })

  test('正文无法读取时报告读取失败', async () => {
    const r = await run({ resource_id: 'rs_1', offset: 0, length: 10 }, brokenSink(1000))
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('resource_read_failed')
  })
})

describe('query 搜索', () => {
  const doc = Array.from({ length: 200 }, (_, i) => `line ${i + 1}: payload`).join('\n')

  test('一次调用直接定位到目标行，无需推测偏移', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'line 137:' }, memSink(doc))
    expect(r.status).toBe('success')
    const hits = r.data!.hits as Hit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.line).toBe(137)
    expect(hits[0]!.text).toBe('line 137: payload')
    expect(r.data!.nextOffset).toBeNull()
  })

  test('命中的字节偏移指向命中处：以它作为 offset 读取的内容即为命中', async () => {
    const sink = memSink(doc)
    const r = await run({ resource_id: 'rs_1', query: 'line 88:' }, sink)
    const hit = (r.data!.hits as Hit[])[0]!
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 16 }, sink)
    expect(back.data!.content).toBe('line 88: payload')
  })

  test('中文正文的命中偏移按 UTF-8 计算，且指向命中处而不是行首', async () => {
    const sink = memSink('第一行\n第二行目标\n第三行')
    const r = await run({ resource_id: 'rs_1', query: '目标' }, sink)
    const hit = (r.data!.hits as Hit[])[0]!
    // '第一行\n' = 10 字节，'第二行' = 9 字节。
    expect(hit.offset).toBe(19)
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 6 }, sink)
    expect(back.data!.content).toBe('目标')
  })

  test('未命中是成功而不是失败：「确实不包含」是有效结论', async () => {
    const r = await run({ resource_id: 'rs_1', query: '不存在的关键字' }, memSink(doc))
    expect(r.status).toBe('success')
    expect(r.data!.hits).toHaveLength(0)
    expect(r.data!.nextOffset).toBeNull()
  })

  test('预算充足时一页返回全部命中，nextOffset 为 null', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'payload' }, memSink(doc))
    expect(r.data!.hits).toHaveLength(200)
    expect(r.data!.nextOffset).toBeNull()
  })

  test('message 只报告数量与位置，不重复列出命中正文', async () => {
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

  test('控件表的命中返回整条记录，可直接解析，不从中间切开', async () => {
    // 落盘控件表的格式：第一行为元数据，之后每行一个控件；命中的“账号”位于记录中段。
    const record = {
      ref: 'e244',
      parentRef: 'e230',
      depth: 11,
      role: 'text',
      name: '账号',
      automationId: '',
      enabled: true,
      offscreen: false,
      rect: [812, 402, 36, 20],
      actions: [
        { action: 'scroll_into_view', delivery: ['background'] },
        { action: 'click', delivery: ['foreground'] },
        { action: 'hover', delivery: ['foreground'] },
      ],
    }
    const pad = (i: number) => JSON.stringify({ ...record, ref: `e${i}`, name: `控件${i}` })
    const body = ['{"windowId":"dw_5"}', pad(1), pad(2), JSON.stringify(record), pad(3)].join('\n')
    const r = await run({ resource_id: 'rs_1', query: '账号' }, memSink(body))
    const hits = r.data!.hits as Hit[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.wholeLine).toBe(true)
    expect(JSON.parse(hits[0]!.text)).toEqual(record)
  })

  test('单行超过整页预算：只返回命中附近的片段并加以标明，从 lineOffset 可读取整行', async () => {
    const long = `{"pad":"${'p'.repeat(20_000)}","target":"针"}`
    const sink = memSink(`前一行\n${long}\n后一行`)
    const r = await run({ resource_id: 'rs_1', query: '"target"' }, sink)
    const hit = (r.data!.hits as Hit[])[0]!
    expect(hit.line).toBe(2)
    expect(hit.wholeLine).toBe(false)
    expect(hit.text).toContain('"target":"针"')
    expect(hit.text.length).toBeLessThan(600)
    const back = await run({ resource_id: 'rs_1', offset: hit.offset, length: 20 }, sink)
    expect(String(back.data!.content).startsWith('"target"')).toBe(true)
    const whole = await run({ resource_id: 'rs_1', offset: hit.lineOffset, length: 20 }, sink)
    expect(String(whole.data!.content).startsWith('{"pad"')).toBe(true)
  })

  test('本页剩余预算无法容纳整行时留到下一页，不切成片段', async () => {
    const line = (i: number) => `${'x'.repeat(6000)}hit-${i}`
    const pages = await searchThrough(memSink([line(1), line(2), line(3)].join('\n')), 'hit-')
    const all = pages.flatMap((p) => p.hits)
    expect(all.map((h) => h.line)).toEqual([1, 2, 3])
    for (const h of all) expect(h.wholeLine).toBe(true)
    expect(pages.length).toBeGreaterThan(1)
  })

  test('跨扫描步长边界的中文与 emoji 同样命中，偏移准确', async () => {
    // 分片步长 256 KB：使 emoji 的四个字节跨越 262144 边界。
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

  test('正文无法读取时报告读取失败，不报告为未找到', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'x' }, brokenSink(1000))
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('resource_read_failed')
    expect(r.message).not.toContain('未找到')
  })
})

describe('query 跨页续查', () => {
  // 240 行，偶数行命中；每条命中两侧都有内容，单页输出量无法容纳 120 条。
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

  test('每一页都从上一页的续查位置开始，命中正文中包含各自的行号', async () => {
    const pages = await searchThrough(memSink(doc), 'hit-')
    for (const [i, page] of pages.entries()) {
      if (i > 0) expect(page.offset).toBe(pages[i - 1]!.nextOffset as number)
      for (const hit of page.hits) expect(hit.text).toContain(`hit-${hit.line}-mark`)
    }
  })

  test('offset 生效：从中途开始只返回其后的命中，行号仍按全文计算', async () => {
    const from = lineStart(200)
    const pages = await searchThrough(memSink(doc), 'hit-', from)
    const all = pages.flatMap((p) => p.hits)
    expect(pages[0]!.offset).toBe(from)
    expect(all[0]!.line).toBe(200)
    expect(all.map((h) => h.line)).toEqual(expectedLines.filter((n) => n >= 200))
  })

  test('单页无法容纳时 message 给出续查位置', async () => {
    const r = await run({ resource_id: 'rs_1', query: 'hit-' }, memSink(doc))
    expect(r.data!.nextOffset).not.toBeNull()
    expect(r.message).toContain(`offset=${r.data!.nextOffset}`)
  })

  test('单条命中超过整页预算时仍然投递，不返回空页', async () => {
    const needle = 'n'.repeat(20_000)
    const pages = await searchThrough(memSink(`${needle}\n${needle}`), needle)
    expect(pages).toHaveLength(2)
    for (const page of pages) expect(page.hits.length).toBeGreaterThan(0)
    expect(pages.flatMap((p) => p.hits).map((h) => h.line)).toEqual([1, 2])
  })
})

describe('按本次决策的投递额度分页', () => {
  const withRoom = (sink: SinkPort, room: number): ToolContext => ({
    ...ctx(sink),
    state: openBatchBudget(new Map(), room),
  })
  const body = `${'甲'.repeat(20_000)}尾部标记`

  test('不传 length 时读取到末尾', async () => {
    const r = await readResourceTool.fn({ resource_id: 'rs_1' }, withRoom(memSink(body), 1_000_000))
    const page = r.data as unknown as Page
    expect(page.content).toBe(body)
    expect(page.nextOffset).toBeNull()
  })

  test('余额不足时只返回可容纳的一页，沿 nextOffset 续读不重不漏', async () => {
    const sink = memSink(body)
    const first = await readResourceTool.fn({ resource_id: 'rs_1' }, withRoom(sink, 5_000))
    const page = first.data as unknown as Page
    expect(page.nextOffset).not.toBeNull()
    expect(outcomeTokens(first, DEFAULT_DENSITY)).toBeLessThanOrEqual(5_000)
    const rest = await readResourceTool.fn(
      { resource_id: 'rs_1', offset: page.nextOffset },
      withRoom(sink, 1_000_000),
    )
    expect(page.content + (rest.data as unknown as Page).content).toBe(body)
  })

  test('余额为 0 时仍返回最小的一页，沿 nextOffset 续读不重不漏', async () => {
    const sink = memSink(body)
    const first = await readResourceTool.fn({ resource_id: 'rs_1' }, withRoom(sink, 0))
    expect(first.status).toBe('success')
    const page = first.data as unknown as Page
    expect(page.nextOffset).not.toBeNull()
    // 码点补全最多多出 3 字节。
    expect(new TextEncoder().encode(page.content).byteLength).toBeLessThanOrEqual(
      MIN_DELIVERY_BYTES + 3,
    )
    const rest = await readResourceTool.fn(
      { resource_id: 'rs_1', offset: page.nextOffset },
      withRoom(sink, 1_000_000),
    )
    expect(page.content + (rest.data as unknown as Page).content).toBe(body)
  })
})
