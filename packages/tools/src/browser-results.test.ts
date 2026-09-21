/**
 * browser 结果的投递闸。
 *
 * **覆盖范围**：`browser-results.ts` 的上限、大小判定、视图选取、JSONL 存盘、资源引用与
 * 实际用量记账，以及 `browser.ts` 五个出口（observe 含选项页、act 含 partial / unknown、
 * navigate、wait，以及 tabs / upload / download 这三条短回执）接上它之后的结果形状。
 *
 * 夹具是合成的：元素名称、值、正文与页面标题都不取自真实网页。
 */

import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type BrowserElement,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPort,
  type BrowserSelectOption,
  chargeBatchBudget,
  deliveredTokens,
  deliveryBudget,
  type SinkPort,
  type ToolContext,
  type ToolOutcome,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  browserActTool,
  browserDownloadTool,
  browserNavigateTool,
  browserObserveTool,
  browserTabsTool,
  browserUploadTool,
  browserWaitTool,
} from './browser.ts'
import { observationResultBudget } from './sink.ts'

const WINDOW = 200_000
const LIMIT = observationResultBudget(WINDOW)

/** 名称、值与正文都按采集侧的 200 字上限写满。 */
function bigElement(i: number): BrowserElement {
  return {
    ref: `e${i + 1}`,
    role: 'button',
    name: `合成元素 ${i} ${'n'.repeat(180)}`,
    tag: 'button',
    value: `合成值 ${i} ${'v'.repeat(180)}`,
    text: `合成正文 ${i} ${'t'.repeat(180)}`,
  }
}

/** 缺席的 `checked` / `expanded` / `selected` 不许在往返里变成 false。 */
const 状态齐全: BrowserElement = {
  ref: 'e119',
  role: 'checkbox',
  name: '合成复选框',
  tag: 'input',
  inputType: 'checkbox',
  checked: false,
  expanded: false,
  selected: false,
  disabled: false,
  value: '',
}

/** 中文、emoji、空串与嵌套数组一起进存盘正文。 */
const 选择框: BrowserElement = {
  ref: 'e120',
  role: 'combobox',
  name: '合成下拉 🙂 甲乙丙',
  tag: 'select',
  value: '',
  options: [
    { label: '', value: '' },
    { label: '丁🙂', value: 'd', disabled: true },
  ],
  optionsTotal: 300,
  optionsTruncated: true,
}

const 大页元素: BrowserElement[] = [
  ...Array.from({ length: 118 }, (_, i) => bigElement(i)),
  状态齐全,
  选择框,
]

const 小页: BrowserObservation = {
  tabId: 'bt_1',
  url: 'https://a/',
  title: 'A',
  observationId: 'ob_1',
  elements: [{ ref: 'e1', role: 'button', name: '提交', tag: 'button' }],
  truncated: false,
}

const 大页: BrowserObservation = {
  tabId: 'bt_1',
  url: 'https://a/list',
  title: '合成长列表',
  observationId: 'ob_2',
  elements: 大页元素,
  truncated: true,
  framesPending: ['f9c1'],
}

function bigOption(i: number): BrowserSelectOption {
  return { label: `合成选项 ${i} ${'o'.repeat(180)}`, value: `v${i}` }
}

const 大选项页: BrowserOptionsPage = {
  tabId: 'bt_1',
  observationId: 'ob_1',
  ref: 'e3',
  items: [
    ...Array.from({ length: 58 }, (_, i) => bigOption(i)),
    { label: '', value: '', disabled: true },
    { label: '末项🙂', value: 'last', selected: true },
  ],
  total: 420,
  offset: 40,
  nextOffset: 100,
}

interface Acted {
  acts: number
}

function fakeBrowser(over: Partial<BrowserPort> = {}, acted: Acted = { acts: 0 }): BrowserPort {
  return {
    tabs: async () => [{ tabId: 'bt_1', url: 'https://a/', title: 'A', controlled: true }],
    open: async (url) => ({ tabId: 'bt_9', url, title: '', controlled: true }),
    bind: async (tabId) => ({ tabId, url: 'https://a/', title: 'A', controlled: true }),
    close: async () => {},
    navigate: async () => ({ observation: 大页, settle: 'quiet' }),
    observe: async (input) => (input.optionsFor ? 大选项页 : 大页),
    act: async () => {
      acted.acts++
      return { element: 'button 提交', observation: 大页, settle: 'quiet' }
    },
    wait: async () => ({ found: true, observation: 大页 }),
    upload: async (input) => ({ files: input.paths }),
    download: async (input) => ({ path: input.absolutePath, bytes: 3 }),
    release: async () => {},
    ...over,
  }
}

function fakeSink(): SinkPort & { landed: Uint8Array[]; mimes: (string | null)[] } {
  const landed: Uint8Array[] = []
  const mimes: (string | null)[] = []
  return {
    landed,
    mimes,
    land(input) {
      landed.push(input.body)
      mimes.push(input.mimeType ?? null)
      return { resourceId: `rs_${landed.length}`, contentHash: 'sha256:x' }
    },
    read: () => null,
    stat: () => null,
  }
}

const failingSink: SinkPort = {
  land() {
    throw new Error('磁盘满了')
  },
  read: () => null,
  stat: () => null,
}

function context(
  browser: BrowserPort,
  sink: SinkPort | null,
  opts: { workspaceRoot?: string; contextWindow?: number } = {},
): ToolContext {
  return {
    workspaceRoot: opts.workspaceRoot ?? process.cwd(),
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: opts.contextWindow ?? WINDOW,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
    browser,
  }
}

interface Delivery {
  delivered: number
  collected: number
  resourceId?: string
  unsaved?: string
}

function deliveryOf(r: ToolOutcome): Delivery | undefined {
  return (r.data as { delivery?: Delivery }).delivery
}

function elementsOf(r: ToolOutcome): BrowserElement[] {
  return (r.data as { elements: BrowserElement[] }).elements
}

/** 整条结果的 token 数，与上限同一把尺：截图走图像块，不算在内。 */
function sizeOf(r: ToolOutcome): number {
  const { images, ...data } = r.data ?? {}
  return deliveredTokens(
    JSON.stringify({ message: r.message, data, resources: r.resources }),
    DEFAULT_DENSITY,
  )
}

/** 一张超过上限的合成截图。 */
const 大截图 = { data: 'Q'.repeat(200_000), mime: 'image/png' }

/** 存盘正文按行拼回一页。 */
function fromJsonl(body: Uint8Array): Record<string, unknown> {
  const lines = new TextDecoder().decode(body).split('\n')
  const meta = JSON.parse(lines[0] as string) as Record<string, unknown>
  const rows = lines.slice(1).map((line) => JSON.parse(line) as unknown)
  return { meta, rows }
}

const CLICK = { tabId: 'bt_1', observationId: 'ob_0', action: 'click', ref: 'e1' }

describe('小页整份内联', () => {
  test('observe 的 data 与端口交回的那一份逐字相同，不带投递说明，也不落盘', async () => {
    const sink = fakeSink()
    const ctx = context(fakeBrowser({ observe: async () => 小页 }), sink)
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)

    expect(JSON.stringify(r.data)).toBe(JSON.stringify(小页))
    expect(deliveryOf(r)).toBeUndefined()
    expect(r.resources).toBeUndefined()
    expect(sink.landed).toHaveLength(0)
  })

  test('动作结果里的观察同样整份内联，回执与 settle 在原位置', async () => {
    const sink = fakeSink()
    const ctx = context(
      fakeBrowser({
        act: async () => ({ element: 'button 提交', observation: 小页, settle: 'quiet' }),
      }),
      sink,
    )
    const r = await browserActTool.fn(CLICK, ctx)

    expect(JSON.stringify(r.data)).toBe(
      JSON.stringify({ element: 'button 提交', ...小页, settle: 'quiet' }),
    )
    expect(sink.landed).toHaveLength(0)
  })

  test('截图走 images，普通字段里不留 base64', async () => {
    const shot = { ...小页, image: { data: 'QUJD', mime: 'image/png' } }
    const ctx = context(fakeBrowser({ observe: async () => shot }), fakeSink())
    const r = await browserObserveTool.fn({ tabId: 'bt_1', screenshot: true }, ctx)

    expect(r.data).not.toHaveProperty('image')
    expect((r.data as { images: unknown }).images).toEqual([{ data: 'QUJD', mime: 'image/png' }])
  })

  /**
   * 页面自报的标题与网址长度都无界（data URL 可以有几万字）。message 不参与视图裁剪，
   * 这两格印原值会把整条结果的上限吃满，元素表因此一个都投不出去。
   */
  test('超长标题与网址在 message 里截短，data 里仍是原值', async () => {
    const title = '标'.repeat(400)
    const url = `https://a/${'p'.repeat(400)}`
    const ctx = context(fakeBrowser({ observe: async () => ({ ...小页, title, url }) }), fakeSink())
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const data = r.data as { title: string; url: string }

    expect(r.message.length).toBeLessThan(600)
    // 网址留开头：origin 与路径前段还看得出打开的是哪一站。
    expect(r.message).toContain('https://a/pppp')
    expect(data.title).toBe(title)
    expect(data.url).toBe(url)
    expect(elementsOf(r).length).toBe(1)
    expect(sizeOf(r)).toBeLessThanOrEqual(LIMIT)
  })

  /** 截图按图像块发出，不进信封文本：把它算进上限会让一页三个元素的小页去存盘。 */
  test('带一张大截图的小页仍整份内联，不落盘', async () => {
    const sink = fakeSink()
    const shot = { ...小页, image: 大截图 }
    const ctx = context(fakeBrowser({ observe: async () => shot }), sink)
    const r = await browserObserveTool.fn({ tabId: 'bt_1', screenshot: true }, ctx)
    const { images, ...rest } = r.data as Record<string, unknown>

    expect(images).toEqual([大截图])
    expect(JSON.stringify(rest)).toBe(JSON.stringify(小页))
    expect(deliveryOf(r)).toBeUndefined()
    expect(r.resources).toBeUndefined()
    expect(sink.landed).toHaveLength(0)
  })
})

describe('大页只投前面一部分', () => {
  test('视图是本次元素表的前缀，每个元素原样，不从中间切开', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const view = elementsOf(await browserObserveTool.fn({ tabId: 'bt_1' }, ctx))

    expect(view.length).toBeGreaterThan(0)
    expect(view.length).toBeLessThan(大页元素.length)
    expect(view).toEqual(大页元素.slice(0, view.length))
  })

  /**
   * 元素编号只属于产生它的那一次观察。动作参数里的 `ref` 与动作后观察里的同名编号
   * 指的不是同一个节点，按它把元素提到前面等于把另一个节点当成目标。
   */
  test('动作参数里的旧编号不改变视图的取法', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const 前缀 = elementsOf(await browserObserveTool.fn({ tabId: 'bt_1' }, ctx))
    const 动作后 = elementsOf(
      await browserActTool.fn(
        { tabId: 'bt_1', observationId: 'ob_0', action: 'click', ref: 'e120' },
        context(fakeBrowser(), fakeSink()),
      ),
    )

    expect(动作后.map((e) => e.ref)).not.toContain('e120')
    expect(动作后).toEqual(大页元素.slice(0, 动作后.length))
    expect(动作后.length).toBeLessThanOrEqual(前缀.length)
  })

  test('写明给了多少、本次采到多少、其余在哪读', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const delivery = deliveryOf(r)

    expect(delivery?.delivered).toBe(elementsOf(r).length)
    expect(delivery?.collected).toBe(大页元素.length)
    expect(delivery?.resourceId).toBe('rs_1')
    expect(delivery?.unsaved).toBeUndefined()
    expect(r.message).toContain(`已投 ${delivery?.delivered}/${大页元素.length} 个元素`)
    expect(r.message).toContain('rs_1')
    expect(r.message).toContain('read_resource')
  })

  test('采集侧的未采全与投递侧的没给全分列，顶层字段原样', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const data = r.data as {
      tabId: string
      url: string
      title: string
      observationId: string
      truncated: boolean
      framesPending: string[]
    }

    expect(data.tabId).toBe('bt_1')
    expect(data.url).toBe('https://a/list')
    expect(data.title).toBe('合成长列表')
    expect(data.observationId).toBe('ob_2')
    expect(data.truncated).toBe(true)
    expect(data.framesPending).toEqual(['f9c1'])
    expect(deliveryOf(r)?.delivered).toBeLessThan(大页元素.length)
  })

  test('整条结果不超过上限', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    for (const r of [
      await browserObserveTool.fn({ tabId: 'bt_1' }, ctx),
      await browserActTool.fn(CLICK, ctx),
      await browserNavigateTool.fn({ tabId: 'bt_1', action: 'reload' }, ctx),
      await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x' }, ctx),
    ]) {
      expect(sizeOf(r)).toBeLessThanOrEqual(LIMIT)
      expect(deliveryOf(r)?.collected).toBe(大页元素.length)
    }
  })

  test('message 只放执行事实，不印元素正文', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const r = await browserActTool.fn(CLICK, ctx)
    expect(r.message).not.toContain('合成正文')
    expect(r.message.length).toBeLessThan(300)
  })
})

describe('存盘正文与资源引用', () => {
  test('第一行是非元素元数据，之后每行一个元素，拼回与原观察相等', async () => {
    const sink = fakeSink()
    const ctx = context(fakeBrowser(), sink)
    await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)

    expect(sink.landed).toHaveLength(1)
    expect(sink.mimes[0]).toBe('application/x-ndjson')
    const body = sink.landed[0] as Uint8Array
    expect(new TextDecoder().decode(body).split('\n')).toHaveLength(大页元素.length + 1)

    const { meta, rows } = fromJsonl(body) as {
      meta: Record<string, unknown>
      rows: BrowserElement[]
    }
    expect(meta).toEqual({
      tabId: 'bt_1',
      url: 'https://a/list',
      title: '合成长列表',
      observationId: 'ob_2',
      truncated: true,
      framesPending: ['f9c1'],
    })
    expect(rows).toEqual(大页元素)
  })

  test('缺席的状态位不补成 false，空串、中文与 emoji 原样', async () => {
    const sink = fakeSink()
    await browserObserveTool.fn({ tabId: 'bt_1' }, context(fakeBrowser(), sink))
    const { rows } = fromJsonl(sink.landed[0] as Uint8Array) as { rows: BrowserElement[] }

    const 普通 = rows[0] as BrowserElement
    expect('checked' in 普通).toBe(false)
    expect('expanded' in 普通).toBe(false)
    expect('selected' in 普通).toBe(false)

    const 齐全 = rows[118] as BrowserElement
    expect(齐全.checked).toBe(false)
    expect(齐全.expanded).toBe(false)
    expect(齐全.selected).toBe(false)
    expect(齐全.disabled).toBe(false)
    expect(齐全.value).toBe('')

    const 下拉 = rows[119] as BrowserElement
    expect(下拉.name).toBe('合成下拉 🙂 甲乙丙')
    expect(下拉.options).toEqual(选择框.options)
    expect(下拉.optionsTotal).toBe(300)
    expect(下拉.optionsTruncated).toBe(true)
  })

  test('资源引用进 outcome.resources，带状态、字节数与覆盖事实', async () => {
    const sink = fakeSink()
    const ctx = context(fakeBrowser(), sink)
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    const body = sink.landed[0] as Uint8Array

    expect(r.resources).toHaveLength(1)
    const ref = r.resources?.[0]
    expect(String(ref?.resourceId)).toBe('rs_1')
    expect(ref?.status).toBe('complete')
    expect(ref?.contentHash).toBeNull()
    expect(ref?.sizeBytes).toBe(body.byteLength)
    expect(ref?.mimeType).toBe('application/x-ndjson')
    expect(ref?.coverage.totalBytes).toBe(body.byteLength)
    expect(ref?.coverage.truncated).toBe(true)
    expect(ref?.coverage.deliveredBytes).toBeLessThan(body.byteLength)
  })

  test('截图不进存盘正文', async () => {
    const sink = fakeSink()
    const shot = { ...大页, image: { data: 'QUJD', mime: 'image/png' } }
    await browserObserveTool.fn(
      { tabId: 'bt_1', screenshot: true },
      context(fakeBrowser({ observe: async () => shot }), sink),
    )
    const body = new TextDecoder().decode(sink.landed[0] as Uint8Array)
    expect(body).not.toContain('QUJD')
    expect(body).not.toContain('image')
  })

  test('大页带截图时投出的元素数与不带截图相同，图仍在 images 里', async () => {
    const sink = fakeSink()
    const 无图 = await browserObserveTool.fn({ tabId: 'bt_1' }, context(fakeBrowser(), fakeSink()))
    const r = await browserObserveTool.fn(
      { tabId: 'bt_1', screenshot: true },
      context(fakeBrowser({ observe: async () => ({ ...大页, image: 大截图 }) }), sink),
    )

    expect(elementsOf(r)).toEqual(elementsOf(无图))
    expect((r.data as { images: unknown }).images).toEqual([大截图])
    expect(deliveryOf(r)?.resourceId).toBe('rs_1')
    expect(sizeOf(r)).toBeLessThanOrEqual(LIMIT)
    expect(new TextDecoder().decode(sink.landed[0] as Uint8Array)).not.toContain('QQQQ')
  })
})

describe('选项页', () => {
  const 读选项 = { tabId: 'bt_1', optionsFor: { observationId: 'ob_1', ref: 'e3', offset: 40 } }

  test('只投前面一部分选项，所属观察与翻页位置原样', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const r = await browserObserveTool.fn(读选项, ctx)
    const data = r.data as {
      observationId: string
      ref: string
      total: number
      offset: number
      nextOffset: number
      items: BrowserSelectOption[]
    }

    expect(data.observationId).toBe('ob_1')
    expect(data.ref).toBe('e3')
    expect(data.total).toBe(420)
    expect(data.offset).toBe(40)
    expect(data.nextOffset).toBe(100)
    expect(r.data).not.toHaveProperty('elements')
    expect(data.items.length).toBeGreaterThan(0)
    expect(data.items).toEqual(大选项页.items.slice(0, data.items.length))
    expect(deliveryOf(r)?.collected).toBe(大选项页.items.length)
    expect(deliveryOf(r)?.resourceId).toBe('rs_1')
    expect(r.message).toContain(`已投 ${data.items.length}/${大选项页.items.length} 个选项`)
    expect(r.message).toContain('read_resource')
    // 范围与下一页照旧写在 message 里。
    expect(r.message).toContain('41-100/420')
    expect(sizeOf(r)).toBeLessThanOrEqual(LIMIT)
  })

  test('存盘正文拼回与原选项页相等', async () => {
    const sink = fakeSink()
    await browserObserveTool.fn(读选项, context(fakeBrowser(), sink))
    const { meta, rows } = fromJsonl(sink.landed[0] as Uint8Array) as {
      meta: Record<string, unknown>
      rows: BrowserSelectOption[]
    }

    expect(meta).toEqual({
      tabId: 'bt_1',
      observationId: 'ob_1',
      ref: 'e3',
      total: 420,
      offset: 40,
      nextOffset: 100,
    })
    expect(rows).toEqual(大选项页.items)
  })
})

describe('动作回执不因归档改口', () => {
  const 打字 = { tabId: 'bt_1', observationId: 'ob_0', action: 'type', ref: 'e1', text: '一二三' }

  test('partial 仍是失败，确认数量保留，观察按上限投', async () => {
    const ctx = context(
      fakeBrowser({
        act: async () => ({
          element: 'textarea 备注',
          execution: { state: 'partial', confirmedUnits: 12 },
          observation: 大页,
          settle: 'quiet',
        }),
      }),
      fakeSink(),
    )
    const r = await browserActTool.fn(打字, ctx)

    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('browser_partial')
    expect(r.message).toContain('已确认 12 个单元')
    expect(r.message).toContain('不要重放')
    expect(r.data).toMatchObject({
      element: 'textarea 备注',
      execution: { state: 'partial', confirmedUnits: 12 },
      observationId: 'ob_2',
      settle: 'quiet',
    })
    expect(deliveryOf(r)?.resourceId).toBe('rs_1')
    expect(sizeOf(r)).toBeLessThanOrEqual(LIMIT)
  })

  test('unknown 没有观察时不落盘，回执与失败原因原样', async () => {
    const sink = fakeSink()
    const ctx = context(
      fakeBrowser({
        act: async () => ({
          execution: { state: 'unknown' },
          observation: null,
          observationError: '连接已断开',
        }),
      }),
      sink,
    )
    const r = await browserActTool.fn(打字, ctx)

    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('browser_unknown')
    expect(r.data).toEqual({ execution: { state: 'unknown' }, observationError: '连接已断开' })
    expect(r.resources).toBeUndefined()
    expect(sink.landed).toHaveLength(0)
  })

  test('wait 超时仍可带观察，状态按 found 定', async () => {
    const ctx = context(
      fakeBrowser({ wait: async () => ({ found: false, reason: 'timeout', observation: 大页 }) }),
      fakeSink(),
    )
    const r = await browserWaitTool.fn({ tabId: 'bt_1', selector: '#x' }, ctx)

    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.data).toMatchObject({ found: false, reason: 'timeout', observationId: 'ob_2' })
    expect(deliveryOf(r)?.resourceId).toBe('rs_1')
  })
})

describe('存不下时照实说', () => {
  test('没有正文库：动作事实不变，不给地址，写明未返回的部分读不回来', async () => {
    const acted = { acts: 0 }
    const ctx = context(fakeBrowser({}, acted), null)
    const r = await browserActTool.fn(CLICK, ctx)

    expect(r.status).toBe('success')
    expect(r.executed).toBeUndefined()
    expect((r.data as { element: string }).element).toBe('button 提交')
    expect(r.resources).toBeUndefined()
    expect(deliveryOf(r)?.resourceId).toBeUndefined()
    expect(deliveryOf(r)?.unsaved).toBe('本次执行没有正文库')
    expect(r.message).toContain('未保存')
    expect(r.message).toContain('无法回读')
    expect(r.message).not.toContain('read_resource')
    expect(acted.acts).toBe(1)
  })

  test('写失败：原因照实回，仍然只投一部分，不发假地址，不重做', async () => {
    const acted = { acts: 0 }
    const ctx = context(fakeBrowser({}, acted), failingSink)
    const r = await browserActTool.fn(CLICK, ctx)

    expect(r.status).toBe('success')
    expect(deliveryOf(r)?.unsaved).toBe('磁盘满了')
    expect(deliveryOf(r)?.delivered).toBeLessThan(大页元素.length)
    expect(r.resources).toBeUndefined()
    expect(r.message).toContain('磁盘满了')
    expect(acted.acts).toBe(1)
  })

  test('归档失败不改动作状态：partial 仍是失败且已执行', async () => {
    const ctx = context(
      fakeBrowser({
        act: async () => ({
          element: 'textarea 备注',
          execution: { state: 'partial', confirmedUnits: 3 },
          observation: 大页,
        }),
      }),
      failingSink,
    )
    const r = await browserActTool.fn(CLICK, ctx)

    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('browser_partial')
    expect((r.data as { execution: { confirmedUnits: number } }).execution.confirmedUnits).toBe(3)
    expect(deliveryOf(r)?.unsaved).toBe('磁盘满了')
  })

  test('小页不受影响：没有 sink 也整份内联', async () => {
    const ctx = context(fakeBrowser({ observe: async () => 小页 }), null)
    const r = await browserObserveTool.fn({ tabId: 'bt_1' }, ctx)
    expect(JSON.stringify(r.data)).toBe(JSON.stringify(小页))
  })
})

describe('实际用量记账', () => {
  test('投多少记多少，只记一次', async () => {
    const ctx = context(fakeBrowser(), fakeSink())
    const before = chargeBatchBudget(ctx, 0).batchRemaining
    const r = await browserActTool.fn(CLICK, ctx)
    const after = chargeBatchBudget(ctx, 0).batchRemaining

    expect(before - after).toBe(sizeOf(r))
  })

  test('记进本波的用量不含截图字节', async () => {
    const ctx = context(
      fakeBrowser({ observe: async () => ({ ...大页, image: 大截图 }) }),
      fakeSink(),
    )
    const before = chargeBatchBudget(ctx, 0).batchRemaining
    const r = await browserObserveTool.fn({ tabId: 'bt_1', screenshot: true }, ctx)
    const after = chargeBatchBudget(ctx, 0).batchRemaining

    expect(before - after).toBe(sizeOf(r))
    expect(before - after).toBeLessThanOrEqual(LIMIT)
  })

  test('越过本波预算时动作不被拒，余额报 0，其后的读取准入不使用假余额', async () => {
    const small = 32_000
    const ctx = context(fakeBrowser(), fakeSink(), { contextWindow: small })
    const { perCall, batchCap } = deliveryBudget(small)
    expect(chargeBatchBudget(ctx, perCall).ok).toBe(true)
    expect(chargeBatchBudget(ctx, batchCap - perCall - 200).ok).toBe(true)
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(200)

    const r = await browserActTool.fn(CLICK, ctx)
    expect(r.status).toBe('success')
    expect((r.data as { element: string }).element).toBe('button 提交')
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(0)
    expect(chargeBatchBudget(ctx, 100).ok).toBe(false)
  })
})

describe('短回执不落盘', () => {
  test('tabs、upload、download 照旧原样返回', async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), 'qywork-browser-results-')))
    await writeFile(join(root, 'a.txt'), 'abc', 'utf8')
    const sink = fakeSink()
    const ctx = context(fakeBrowser(), sink, { workspaceRoot: root })
    const args = { tabId: 'bt_1', observationId: 'ob_1', ref: 'e1' }

    const tabs = await browserTabsTool.fn({ action: 'list' }, ctx)
    const upload = await browserUploadTool.fn({ ...args, paths: ['a.txt'] }, ctx)
    const download = await browserDownloadTool.fn({ ...args, path: 'out.bin' }, ctx)

    for (const r of [tabs, upload, download]) {
      expect(r.status).toBe('success')
      expect(r.resources).toBeUndefined()
      expect(r.data).not.toHaveProperty('delivery')
    }
    expect((upload.data as { files: string[] }).files).toEqual([join(root, 'a.txt')])
    expect((download.data as { path: string }).path).toBe(join(root, 'out.bin'))
    expect(sink.landed).toHaveLength(0)
  })
})
