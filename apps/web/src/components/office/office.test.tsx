/**
 * 覆盖 `office/SheetView.tsx`、`office/pptx/SlideView.tsx` 与 `office/docx/DocView.tsx`（经 `FileView.tsx` 的 Office 分支：
 * 加载态、四类失败、能力边界、工作表签与图表工作表、改写后刷新、主机上没有的字体改取替代字体、嵌入字体还原前先绘制与还原后只重绘用到它的幻灯片、文档的字体请求）、
 * `office/document.ts`（加载与重新加载、Worker 请求与回复、Worker 出错、失败与能力边界文案）、
 * `office/fonts.ts`（主机上没有的字体按缺失处理、嵌入字体的注册）、`office/viewport.ts`、`office/sheet-viewport.ts`、
 * `office/pptx/slide-viewport.ts` 与 `office/docx/page-viewport.ts`（只为可见的幻灯片与页面创建画布并绘制、首次显示的缩放比例、
 * 页面居中、幻灯片与页面按像素取整、工作表与幻灯片为不透明画布并在绘制前以白色铺满、改写后保留滚动位置与缩放比例）、
 * `office/OfficePicker.tsx` 与 `lib/file-search.ts` 的 `office` 筛选、
 * `SidePanel.tsx` 看板的 Word 行、PPT 行、Excel 行与文件预览页、`lib/store/ui.ts` 的 `openFileTab`。
 *
 * happy-dom 没有 Canvas（`getContext` 返回 `null`）与 `FontFace`：绘制由对比基准与浏览器实测验证，这里只断言界面状态、
 * 画布的创建与释放、绘制的调用对象，以及替身上下文记录的填充（`recordContexts`）；`FontFace` 与 `document.fonts`
 * 替换为记录注册与删除的替身。
 * `Worker` 替换为按请求回复的替身，断言 Worker 以模块方式从同源文件加载；解析本身由 `@qywork/ooxml` 的测试覆盖。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { DocumentPages, Page } from '@qywork/ooxml/docx'
import type {
  EmbeddedFont,
  PptxResult,
  Presentation,
  Shape,
  Slide,
  UnsupportedCounts,
} from '@qywork/ooxml/pptx'
import type { CellStyle, Chartsheet, Workbook, Worksheet, XlsxResult } from '@qywork/ooxml/xlsx'
import type { WorkerReply, WorkerRequest } from './document.ts'
import type { DocxParsed, DocxRequest } from './docx/docx-worker.ts'
import type { PptxRequest } from './pptx/pptx-worker.ts'
import type { XlsxRequest } from './xlsx-worker.ts'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents, DelegatedEvents } = await import('solid-js/web')
  delegateEvents([...DelegatedEvents])
})

let dispose: (() => void) | undefined
const restores: (() => void)[] = []

afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  for (const restore of restores.splice(0).reverse()) restore()
  const store = await import('../../lib/store/index.ts')
  store.setOpenFile(null)
  store.setSidePanel(null)
  store.setWorkspace(null)
  const { flushSession } = await import('../../lib/session.ts')
  flushSession()
  sessionStorage.clear()
  store.setState({ connection: 'connecting', fileVersion: 0 })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

const font = {
  name: '宋体',
  size: 11,
  bold: false,
  italic: false,
  underline: 'none',
  strike: false,
  color: null,
  vertAlign: 'baseline',
} as const

const style: CellStyle = {
  font,
  fill: null,
  border: null,
  alignment: {
    horizontal: 'general',
    vertical: 'bottom',
    wrap: false,
    shrink: false,
    rotation: 0,
    indent: 0,
  },
  numFmt: 'General',
}

function sheet(name: string, over: Partial<Worksheet> = {}): Worksheet {
  return {
    kind: 'worksheet',
    name,
    state: 'visible',
    cells: new Map(),
    rows: new Map(),
    cols: [],
    format: {
      defaultRowHeight: 15,
      zeroHeight: false,
      customHeight: false,
      defaultColWidth: null,
      baseColWidth: 8,
      declared: true,
    },
    merges: [],
    view: {
      showGridLines: true,
      gridColor: null,
      zoom: 100,
      rightToLeft: false,
      frozenRows: 0,
      frozenCols: 0,
      topLeft: { row: 0, col: 0 },
    },
    conditionalFormats: [],
    images: [],
    shapes: [],
    charts: [],
    autoFilter: null,
    maxRow: -1,
    maxCol: -1,
    unsupported: {},
    ...over,
  }
}

/** 没有可绘制图表的图表工作表：测试中画布没有绘制上下文，不绘制图表。 */
function chartsheet(name: string, zoom = 100): Chartsheet {
  return {
    kind: 'chartsheet',
    name,
    state: 'visible',
    view: { zoom },
    charts: [],
    unsupported: { chart: 1 },
  }
}

function workbook(sheets: Workbook['sheets'], over: Partial<Workbook> = {}): Workbook {
  return {
    sheets,
    styles: [style],
    defaultFont: font,
    minorFont: null,
    date1904: false,
    palette: [],
    activeSheet: 0,
    gridSize: { rows: 1_048_576, cols: 16_384 },
    fontNames: ['宋体'],
    unsupported: {},
    ...over,
  }
}

/** 第一版：两个可见工作表、一个隐藏工作表与一张图表工作表，「甲」有图表与批注，工作簿另有一张宏表。 */
const FIRST = workbook(
  [
    sheet('甲', { unsupported: { chart: 2, comment: 1 } }),
    sheet('隐', { state: 'hidden', unsupported: { graphic: 9 } }),
    chartsheet('图'),
    sheet('乙'),
  ],
  { unsupported: { chart: 3, comment: 1, graphic: 9, otherSheet: 1 } },
)
/** 改写后的版本：「乙」多了未绘制的图形对象。 */
const SECOND = workbook(
  [
    sheet('甲'),
    sheet('隐', { state: 'hidden' }),
    chartsheet('图'),
    sheet('乙', { unsupported: { graphic: 3 } }),
  ],
  { unsupported: { chart: 1, graphic: 3, otherSheet: 1 } },
)

const FAILURES = {
  encrypted: { ok: false, failure: { kind: 'encrypted' } },
  corrupt: { ok: false, failure: { kind: 'corrupt', reason: 'end-record' } },
  plain: { ok: false, failure: { kind: 'not-office' } },
} as const

/** 保存的缩放比例为 85% 的空白工作表：画布变换不是整数比例。 */
const ZOOMED = workbook([
  sheet('甲', {
    view: {
      showGridLines: true,
      gridColor: null,
      zoom: 85,
      rightToLeft: false,
      frozenRows: 0,
      frozenCols: 0,
      topLeft: { row: 0, col: 0 },
    },
  }),
])

/** 打开时显示缩放比例为 75% 的图表工作表。 */
const CHARTSHEET = workbook([sheet('甲'), chartsheet('图', 75)], { activeSheet: 1 })

/** 文件字节（文本）到 xlsx 解析结果的对应。 */
const XLSX_RESULTS: Record<string, XlsxResult> = {
  first: { ok: true, value: FIRST },
  chartsheet: { ok: true, value: CHARTSHEET },
  'missing-font': { ok: true, value: workbook([sheet('甲')], { fontNames: ['Inherit', '宋体'] }) },
  second: { ok: true, value: SECOND },
  zoomed: { ok: true, value: ZOOMED },
  ...FAILURES,
}

function slide(number: number): Slide {
  return {
    part: `/ppt/slides/slide${number}.xml`,
    number,
    hidden: false,
    layout: '/ppt/slideLayouts/slideLayout1.xml',
    master: '/ppt/slideMasters/slideMaster1.xml',
    background: null,
    shapes: [],
    unsupported: {},
  }
}

/**
 * 只含一个文本框的幻灯片，文字字体为 `typeface`；`image` 为背景图片部件。只填写字体收集与图片收集读取的字段：
 * 测试中画布没有绘制上下文，不执行绘制。
 */
function textSlide(number: number, typeface: string, image: string | null = null): Slide {
  const style = { latin: typeface, ea: '', cs: '', sym: '', fill: null }
  const shape = {
    kind: 'shape',
    fill: null,
    text: { paragraphs: [{ bullet: { kind: 'none' }, end: style, runs: [{ style }] }] },
  }
  const background = image === null ? null : { kind: 'picture', image: { part: image } }
  return {
    ...slide(number),
    background: background as unknown as Slide['background'],
    shapes: [shape as unknown as Shape],
  }
}

function presentation(
  count: number,
  unsupported: UnsupportedCounts = {},
  embeddedFonts: EmbeddedFont[] = [],
  slides: Slide[] = Array.from({ length: count }, (_, i) => slide(i + 1)),
): Presentation {
  return {
    width: 12192000,
    height: 6858000,
    firstSlideNumber: 1,
    embeddedFonts,
    masters: ['/ppt/slideMasters/slideMaster1.xml'],
    slides,
    unsupported,
    metafileFonts: [],
  }
}

function embeddedFont(typeface: string, n: number): EmbeddedFont {
  return { typeface, bold: false, italic: false, part: `/ppt/fonts/font${n}.fntdata` }
}

const EMBEDDED = embeddedFont('华文行楷', 1)

/** 文件字节（文本）到 pptx 解析结果的对应。 */
const PPTX_RESULTS: Record<string, PptxResult> = {
  deck: { ok: true, value: presentation(10, { chart: 1, smartArt: 2, animation: 4 }) },
  rewritten: { ok: true, value: presentation(10, { imageFormat: 1, transition: 2 }) },
  kinds: {
    ok: true,
    value: presentation(1, {
      chart: 1,
      smartArt: 1,
      ole: 1,
      graphic: 1,
      media: 1,
      ink: 1,
      imageFormat: 1,
      verticalText: 1,
      textWarp: 1,
      tableStyle: 1,
      effect3d: 1,
      imageEffect: 1,
      effect: 1,
      math: 1,
      animation: 1,
      transition: 1,
    }),
  },
  embedded: { ok: true, value: presentation(2, {}, [EMBEDDED]) },
  /** 两个主机没有的嵌入字体：第 1 张用「甲」，第 2 张用「乙」且有背景图片。 */
  pair: {
    ok: true,
    value: presentation(
      2,
      {},
      [embeddedFont('甲', 1), embeddedFont('乙', 2)],
      [textSlide(1, '甲'), textSlide(2, '乙', '/ppt/media/image1.png')],
    ),
  },
  /** 主机没有的字体名：第 1 张为 WPS 演示自带度量的字体，第 2 张按前缀匹配为 Courier New。 */
  substitute: {
    ok: true,
    value: presentation(2, {}, [], [textSlide(1, '华文楷体'), textSlide(2, 'Courier')]),
  },
  ...FAILURES,
}

/** A4 纵向与横向页面（磅）。 */
const A4 = { width: 595.3, height: 841.9 }
const A4_LANDSCAPE = { width: 841.9, height: 595.3 }

/** 没有内容的页面：测试中画布没有绘制上下文，不执行绘制。`hiddenMath` 为未绘制的公式个数。 */
function docPage(size: { width: number; height: number }, hiddenMath = 0): Page {
  return {
    section: 0,
    ...size,
    number: '1',
    header: [],
    body: [],
    footer: [],
    floats: [],
    background: null,
    borders: null,
    graphicFonts: null,
    hiddenMath,
  }
}

function docPages(pages: Page[]): DocumentPages {
  return { faces: [], images: [], pages }
}

/** 假服务端的主机字体族名（`/api/fonts/families`）。 */
const HOST_FAMILIES = {
  local: ['宋体', 'Courier New'],
  names: ['courier new', 'simsun', '宋体'],
  language: 0x0804,
}

/** 第 4 页为横向，其余为纵向。 */
const REPORT_SIZES = Array.from({ length: 10 }, (_, i) => (i === 3 ? A4_LANDSCAPE : A4))

/** 文件字节（文本）到 docx 解析结果与分页结果的对应。 */
const DOCX_RESULTS: Record<string, { parsed: DocxParsed; pages?: DocumentPages }> = {
  report: {
    parsed: {
      ok: true,
      fonts: ['宋体', 'SimSun', '黑体'],
      embedded: [],
      unsupported: { chart: 2, decimalTab: 3 },
    },
    pages: docPages(REPORT_SIZES.map((size) => docPage(size))),
  },
  revised: {
    parsed: { ok: true, fonts: ['宋体'], embedded: [], unsupported: {} },
    pages: docPages(REPORT_SIZES.map((size, i) => docPage(size, i === 0 ? 1 : 0))),
  },
  embedded: {
    parsed: {
      ok: true,
      fonts: ['宋体', '方正小标宋简体'],
      embedded: [{ family: '方正小标宋简体', bold: false, italic: false, bytes: tinyFont() }],
      unsupported: {},
    },
    pages: docPages([docPage(A4)]),
  },
  kinds: {
    parsed: {
      ok: true,
      fonts: [],
      embedded: [],
      unsupported: {
        frame: 1,
        floatingTable: 1,
        altChunk: 1,
        subDocument: 1,
        picture: 1,
        chart: 1,
        smartArt: 1,
        shape: 1,
        group: 1,
        canvas: 1,
        drawing: 1,
        effect: 1,
        imageFormat: 1,
        vml: 1,
        ole: 1,
        contentPart: 1,
        columns: 1,
        footnote: 1,
        endnote: 1,
        comment: 1,
        artBorder: 1,
        lineNumbers: 1,
        textDirection: 1,
        characterScale: 1,
        emphasisMark: 1,
        smallCaps: 1,
        eastAsianLayout: 1,
        fitText: 1,
        rtl: 1,
        charGrid: 1,
        decimalTab: 1,
        barTab: 1,
        ruby: 1,
        ptab: 1,
        softHyphen: 1,
        revision: 1,
        dynamicField: 1,
        numberFormat: 1,
        nesting: 1,
      },
    },
    pages: docPages([docPage(A4, 1), docPage(A4)]),
  },
  encrypted: { parsed: FAILURES.encrypted },
  corrupt: { parsed: FAILURES.corrupt },
  plain: { parsed: FAILURES.plain },
}

/**
 * 最小的 TrueType 字体：只含排版读取的表（`head`、`hhea`、`maxp`、`hmtx`、`cmap`、`OS/2`），两个字形，
 * `cmap` 不映射任何码位。
 */
function tinyFont(): Uint8Array<ArrayBuffer> {
  const table = (size: number, write: (v: DataView) => void) => {
    const bytes = new Uint8Array(size)
    write(new DataView(bytes.buffer))
    return bytes
  }
  const tables: [string, Uint8Array][] = [
    [
      'OS/2',
      table(78, (v) => {
        v.setUint16(74, 900)
        v.setUint16(76, 300)
      }),
    ],
    [
      'cmap',
      table(36, (v) => {
        v.setUint16(2, 1)
        v.setUint16(4, 3)
        v.setUint16(6, 1)
        v.setUint32(8, 12)
        v.setUint16(12, 4)
        v.setUint16(14, 24)
        v.setUint16(18, 2)
        v.setUint16(20, 2)
        v.setUint16(26, 0xffff)
        v.setUint16(30, 0xffff)
        v.setUint16(32, 1)
      }),
    ],
    [
      'head',
      table(54, (v) => {
        v.setUint32(0, 0x00010000)
        v.setUint32(12, 0x5f0f3cf5)
        v.setUint16(18, 1000)
      }),
    ],
    [
      'hhea',
      table(36, (v) => {
        v.setUint32(0, 0x00010000)
        v.setInt16(4, 800)
        v.setInt16(6, -200)
        v.setUint16(34, 2)
      }),
    ],
    [
      'hmtx',
      table(8, (v) => {
        v.setUint16(0, 500)
        v.setUint16(4, 1000)
      }),
    ],
    [
      'maxp',
      table(6, (v) => {
        v.setUint32(0, 0x00005000)
        v.setUint16(4, 2)
      }),
    ],
  ]
  let offset = 12 + 16 * tables.length
  const placed = tables.map(([tag, bytes]) => {
    const at = offset
    offset += Math.ceil(bytes.length / 4) * 4
    return { tag, bytes, at }
  })
  const out = new Uint8Array(offset)
  const v = new DataView(out.buffer)
  v.setUint32(0, 0x00010000)
  v.setUint16(4, tables.length)
  placed.forEach(({ tag, bytes, at }, i) => {
    for (let k = 0; k < 4; k++) v.setUint8(12 + 16 * i + k, tag.charCodeAt(k))
    v.setUint32(12 + 16 * i + 8, at)
    v.setUint32(12 + 16 * i + 12, bytes.length)
    out.set(bytes, at)
  })
  return out
}

interface WorkerCall {
  readonly url: string
  readonly type: string | undefined
}

/**
 * 替换 `Worker`：xlsx Worker 按收到的字节回复 `XLSX_RESULTS`；pptx Worker 的 `parse` 按字节回复 `PPTX_RESULTS`，
 * `font` 回复一份 `tinyFont()`，`images` 回复空列表；docx Worker 的 `parse` 按字节回复 `DOCX_RESULTS` 的解析结果，
 * `layout` 回复同一份文件的分页结果。记录每次创建时的地址与类型、pptx 与 docx 请求的种类、docx 的 `parse` 与 `layout` 请求、
 * 结束的次数。`holdFonts` 时 `font` 请求不立即回复，按请求顺序放入 `held`，由 `release` 发出回复；Worker 结束后不再回复。
 */
function fakeWorker(opts: { fail?: boolean; holdFonts?: boolean } = {}) {
  const calls: WorkerCall[] = []
  const requests: (PptxRequest | DocxRequest)['kind'][] = []
  const parses: Extract<DocxRequest, { kind: 'parse' }>[] = []
  const layouts: Extract<DocxRequest, { kind: 'layout' }>[] = []
  const held: { readonly typeface: string; readonly release: () => void }[] = []
  let terminated = 0
  class FakeWorker {
    onmessage: ((e: { data: WorkerReply<unknown> }) => void) | null = null
    onerror: ((e: { message: string }) => void) | null = null
    private ended = false
    private readonly url: string
    /** docx Worker 收到的文件字节（文本）。 */
    private doc = ''
    constructor(url: URL | string, options?: { type?: string }) {
      this.url = String(url)
      calls.push({ url: this.url, type: options?.type })
    }
    postMessage(message: WorkerRequest<XlsxRequest | PptxRequest | DocxRequest>) {
      const { id, body } = message
      const xlsx = this.url.endsWith('/xlsx-worker.ts')
      const docx = this.url.endsWith('/docx-worker.ts')
      if (!xlsx) requests.push(body.kind)
      if (body.kind === 'layout') layouts.push(body)
      if (docx && body.kind === 'parse') {
        parses.push(body as Extract<DocxRequest, { kind: 'parse' }>)
        this.doc = new TextDecoder().decode(body.bytes)
      }
      const reply = (): WorkerReply<unknown> => {
        if (docx) {
          const result = DOCX_RESULTS[this.doc]
          if (!result) return { id, error: '未登记的字节' }
          return { id, body: body.kind === 'parse' ? result.parsed : result.pages }
        }
        if (xlsx && body.kind === 'parse') {
          const result = XLSX_RESULTS[new TextDecoder().decode(body.bytes)]
          return result ? { id, body: result } : { id, error: '未登记的字节' }
        }
        if (body.kind === 'parse') {
          const result = PPTX_RESULTS[new TextDecoder().decode(body.bytes)]
          return result ? { id, body: result } : { id, error: '未登记的字节' }
        }
        if (body.kind === 'font') return { id, body: { ...body.font, bytes: tinyFont() } }
        return { id, body: [] }
      }
      const deliver = () => {
        if (this.ended) return
        if (opts.fail) this.onerror?.({ message: '' })
        else this.onmessage?.({ data: reply() })
      }
      if (opts.holdFonts && body.kind === 'font') {
        held.push({ typeface: body.font.typeface, release: deliver })
      } else {
        queueMicrotask(deliver)
      }
    }
    terminate() {
      if (!this.ended) terminated += 1
      this.ended = true
    }
  }
  const original = globalThis.Worker
  globalThis.Worker = FakeWorker as unknown as typeof Worker
  restores.push(() => {
    globalThis.Worker = original
  })
  return { calls, requests, parses, layouts, held, terminated: () => terminated }
}

/**
 * 替换 `FontFace` 与 `document.fonts`：记录当前已注册的族名。`holdLoad(族名)` 为真的字体在 `load()` 中等待，
 * 放入 `loads`，由 `release` 完成加载。
 */
function fakeFonts(holdLoad: (family: string) => boolean = () => false) {
  const registered = new Set<{ family: string }>()
  const loads: { readonly family: string; readonly release: () => void }[] = []
  class FakeFontFace {
    constructor(readonly family: string) {}
    async load() {
      if (holdLoad(this.family)) {
        await new Promise<void>((resolve) => loads.push({ family: this.family, release: resolve }))
      }
      return this
    }
  }
  const g = globalThis as unknown as { FontFace?: unknown }
  const original = g.FontFace
  g.FontFace = FakeFontFace
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      add: (face: { family: string }) => registered.add(face),
      delete: (face: { family: string }) => registered.delete(face),
    },
  })
  restores.push(() => {
    g.FontFace = original
    delete (document as unknown as { fonts?: unknown }).fonts
  })
  return { families: () => [...registered].map((f) => f.family).sort(), loads }
}

/**
 * 替换服务端：预览接口按扩展名返回 Office 元数据（修改时间取 `mtime()`），原始字节按路径取 `bytes`。
 * 字体接口只提供宋体（内容为 `tinyFont()`），其余为 404（主机上没有该字体）。主机字体按字体名缓存在页面模块中、
 * 跨用例保留，因此每个用例都提供同一组字体；同时替换 `FontFace`（`families` 为本用例中注册的族名，
 * `holdLoad` 与 `loads` 见 `fakeFonts`）。字体平滑接口下发 `clearType`，省略时为主机不使用 ClearType。
 */
async function fakeServer(opts: {
  bytes: (path: string) => string | Promise<string>
  mtime?: () => number
  find?: (query: URLSearchParams) => { path: string; kind: 'file' | 'dir' }[]
  holdLoad?: (family: string) => boolean
  clearType?: { contrast: number }
}) {
  const { families, loads } = fakeFonts(opts.holdLoad)
  const store = await import('../../lib/store/index.ts')
  const { ApiError } = await import('../../lib/client.ts')
  const raw: string[] = []
  const finds: URLSearchParams[] = []
  const fontRequests: string[] = []
  const originalApi = store.client.api
  const originalRaw = store.client.raw
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
    path: string,
  ) => {
    if (path.startsWith('/api/fonts?')) {
      const name = new URLSearchParams(path.split('?')[1]).get('name') ?? ''
      fontRequests.push(name)
      if (name !== '宋体') throw new ApiError(404, path, '')
      return { faces: [{ id: `id-${name}`, bold: false, italic: false }] }
    }
    if (path === '/api/fonts/smoothing') return { clearType: opts.clearType ?? null }
    if (path === '/api/fonts/families') return HOST_FAMILIES
    if (path.startsWith('/api/files/tree')) return { nodes: [] }
    if (path.startsWith('/api/files/find')) {
      const query = new URLSearchParams(path.split('?')[1] ?? '')
      finds.push(query)
      return { matches: opts.find?.(query) ?? [], truncated: false }
    }
    if (path.startsWith('/api/files/preview')) {
      const file = decodeURIComponent(path.split('path=')[1] ?? '')
      return {
        path: file,
        kind: 'office',
        office: file.endsWith('.pptx') ? 'pptx' : file.endsWith('.docx') ? 'docx' : 'xlsx',
        mime: 'application/octet-stream',
        size: 10,
        mtime: opts.mtime?.() ?? 1,
        truncated: false,
      }
    }
    throw new Error(`未预期请求：${path}`)
  }
  ;(store.client as unknown as { raw: (path: string) => Promise<Response> }).raw = async (
    path: string,
  ) => {
    if (path.startsWith('/api/fonts/file')) return new Response(tinyFont())
    raw.push(path)
    const file = decodeURIComponent(path.split('path=')[1] ?? '')
    return new Response(await opts.bytes(file))
  }
  restores.push(() => {
    ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    ;(store.client as unknown as { raw: typeof originalRaw }).raw = originalRaw
  })
  return { raw, finds, store, families, loads, fontRequests }
}

async function mountFileView(path: () => string, refresh: () => number) {
  const { render } = await import('solid-js/web')
  const { default: FileView } = await import('../FileView.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(
    () => <FileView path={path()} refresh={refresh()} />,
    host as unknown as HTMLElement,
  )
  return host
}

const tabNames = (host: HTMLElement) =>
  [...host.querySelectorAll('.sheet-tab')].map((el) => el.textContent)
const activeTab = (host: HTMLElement) => host.querySelector('.sheet-tab.active')?.textContent
const boundary = (host: HTMLElement) => host.querySelector('.office-boundary')?.textContent ?? null
const note = (host: HTMLElement) => host.querySelector('.preview-note')?.textContent ?? null

describe('表格预览', () => {
  test('加载期间显示加载态；解析在模块 Worker 中进行，Worker 为同源文件', async () => {
    const workers = fakeWorker()
    let release: (() => void) | undefined
    await fakeServer({
      bytes: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('first')
        }),
    })
    const host = await mountFileView(
      () => 'books/a.xlsx',
      () => 0,
    )
    await waitFor(
      () => release !== undefined,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.sheet-view .preview-loading')).not.toBeNull()
    expect(host.querySelector('.sheet-tab')).toBeNull()

    release?.()
    await waitFor(
      () => tabNames(host).length > 0,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.sheet-view .preview-loading')).toBeNull()
    expect(workers.calls).toHaveLength(1)
    expect(workers.calls[0]!.type).toBe('module')
    expect(new URL(workers.calls[0]!.url).pathname.endsWith('/office/xlsx-worker.ts')).toBe(true)
    // 解析完成后结束 Worker。
    expect(workers.terminated()).toBe(1)
  })

  test('主机上没有的字体改为取得其替代字体', async () => {
    fakeWorker()
    const { fontRequests } = await fakeServer({ bytes: () => 'missing-font' })
    const host = await mountFileView(
      () => 'missing.xlsx',
      () => 0,
    )
    await waitFor(
      () => tabNames(host).length > 0,
      () => fontRequests.join(','),
    )
    expect(fontRequests).toContain('Inherit')
    expect(fontRequests.indexOf('Arial')).toBeGreaterThan(fontRequests.indexOf('Inherit'))
  })

  test('三类失败各显示一句原因，不显示工作表签', async () => {
    fakeWorker()
    await fakeServer({ bytes: (path) => path.replace(/\.xlsx$/, '') })
    const { createSignal } = await import('solid-js')
    const [path, setPath] = createSignal('encrypted.xlsx')
    const host = await mountFileView(path, () => 0)
    for (const [file, text] of [
      ['encrypted.xlsx', '文件已加密'],
      ['corrupt.xlsx', '文件已损坏'],
      ['plain.xlsx', '不是 Office 文件'],
    ] as const) {
      setPath(file)
      await waitFor(
        () => note(host) === text,
        () => `${file}：${host.innerHTML.slice(0, 300)}`,
      )
      expect(host.querySelector('.sheet-tab')).toBeNull()
      expect(host.querySelector('.office-boundary')).toBeNull()
    }
  })

  test('按工作簿顺序列出可见的工作表与图表工作表；能力边界按当前页面与工作簿级的种类列出', async () => {
    fakeWorker()
    await fakeServer({ bytes: () => 'first' })
    const host = await mountFileView(
      () => 'a.xlsx',
      () => 0,
    )
    await waitFor(
      () => tabNames(host).length > 0,
      () => host.innerHTML.slice(0, 300),
    )
    expect(tabNames(host)).toEqual(['甲', '图', '乙'])
    expect(activeTab(host)).toBe('甲')
    expect(boundary(host)).toBe('未显示：图表 2、宏表与对话框表 1、批注 1')

    host.querySelectorAll<HTMLButtonElement>('.sheet-tab')[1]!.click()
    await waitFor(
      () => activeTab(host) === '图',
      () => host.innerHTML.slice(0, 300),
    )
    expect(boundary(host)).toBe('未显示：图表 1、宏表与对话框表 1')

    host.querySelectorAll<HTMLButtonElement>('.sheet-tab')[2]!.click()
    await waitFor(
      () => activeTab(host) === '乙',
      () => host.innerHTML.slice(0, 300),
    )
    expect(boundary(host)).toBe('未显示：宏表与对话框表 1')
  })

  /** 原始失败形状：图表工作表不进入工作表签，只计入能力边界。 */
  test('图表工作表按其缩放比例显示，只绘制白色底与图表，没有网格线', async () => {
    fakeWorker()
    const contexts = recordContexts()
    await fakeServer({ bytes: () => 'chartsheet' })
    sizeScrollers()
    const host = await mountFileView(
      () => 'a.xlsx',
      () => 0,
    )
    await waitFor(
      () => contexts[0] !== undefined && contexts[0].fills.length > 1,
      () => host.innerHTML.slice(0, 300),
    )
    expect(activeTab(host)).toBe('图')
    const { fills } = contexts[0]!
    expect(fills.slice(1).map((f) => [f.transform, f.fillStyle])).toEqual([
      [[0.75, 0, 0, 0.75, 0, 0], '#ffffff'],
    ])
  })

  /**
   * 原始失败形状：AI 改写文件后预览不刷新；或刷新后回到第一个工作表。
   * 修改时间不变的失效（会话中写入其他文件）不重新获取。
   */
  test('改写后按修改时间重新加载，保留当前工作表；修改时间不变时不重新获取', async () => {
    fakeWorker()
    let mtime = 1
    const server = await fakeServer({
      bytes: () => (mtime === 1 ? 'first' : 'second'),
      mtime: () => mtime,
    })
    const { createSignal } = await import('solid-js')
    const [refresh, setRefresh] = createSignal(0)
    const host = await mountFileView(() => 'a.xlsx', refresh)
    await waitFor(
      () => tabNames(host).length > 0,
      () => host.innerHTML.slice(0, 300),
    )
    host.querySelectorAll<HTMLButtonElement>('.sheet-tab')[2]!.click()
    await waitFor(
      () => activeTab(host) === '乙',
      () => host.innerHTML.slice(0, 300),
    )

    setRefresh(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.raw).toHaveLength(1)

    mtime = 2
    setRefresh(2)
    await waitFor(
      () => boundary(host) === '未显示：宏表与对话框表 1、其他对象 3',
      () => `raw=${server.raw.length} ${host.innerHTML.slice(0, 300)}`,
    )
    expect(server.raw).toHaveLength(2)
    expect(activeTab(host)).toBe('乙')
  })

  test('解析线程出错时显示一句原因', async () => {
    fakeWorker({ fail: true })
    await fakeServer({ bytes: () => 'first' })
    const host = await mountFileView(
      () => 'a.xlsx',
      () => 0,
    )
    await waitFor(
      () => note(host) === '无法启动解析线程',
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.sheet-tab')).toBeNull()
  })

  /**
   * 原始失败形状：透明画布上的文字为灰度抗锯齿，与 WPS 屏幕显示不同。不透明画布的初始像素为黑色，
   * 缩放比例不是整数时窗格边缘只被部分覆盖，须先以白色铺满。主机使用 ClearType 时单元格文字读写画布像素，
   * 画布以 `willReadFrequently` 创建。
   */
  test('工作表画布为不透明画布，主机使用 ClearType 时按频繁读取像素创建；每次绘制前在单位变换下以白色铺满整个画布；画布像素与 CSS 像素相同', async () => {
    fakeWorker()
    const contexts = recordContexts()
    await fakeServer({ bytes: () => 'zoomed', clearType: { contrast: 1200 } })
    sizeScrollers()
    const host = await mountFileView(
      () => 'a.xlsx',
      () => 0,
    )
    await waitFor(
      () => contexts[0] !== undefined && contexts[0].fills.length > 1,
      () => host.innerHTML.slice(0, 300),
    )
    const { canvas, options, fills } = contexts[0]!
    expect(canvas.classList.contains('sheet-canvas')).toBe(true)
    expect(options).toEqual({ alpha: false, willReadFrequently: true })
    expect([canvas.width, canvas.height]).toEqual([VIEW_W, VIEW_H])
    expect(fills[0]).toEqual({
      transform: [1, 0, 0, 1, 0, 0],
      fillStyle: '#ffffff',
      rect: [0, 0, VIEW_W, VIEW_H],
    })
    // 其后的绘制按工作表的缩放比例变换。
    expect(fills[1]!.transform).toEqual([0.85, 0, 0, 0.85, 0, 0])
    expect(canvas.style.width).toBe(`${canvas.width}px`)
    expect(canvas.style.height).toBe(`${canvas.height}px`)
  })

  test('主机不使用 ClearType 时画布不按频繁读取像素创建', async () => {
    fakeWorker()
    const contexts = recordContexts()
    await fakeServer({ bytes: () => 'zoomed' })
    sizeScrollers()
    const host = await mountFileView(
      () => 'a.xlsx',
      () => 0,
    )
    await waitFor(
      () => contexts[0] !== undefined && contexts[0].fills.length > 1,
      () => host.innerHTML.slice(0, 300),
    )
    expect(contexts[0]!.options).toEqual({ alpha: false, willReadFrequently: false })
  })
})

/** 幻灯片与页面视口的测试尺寸：滚动容器 800 × 600，幻灯片 16:9。 */
const VIEW_W = 800
const VIEW_H = 600
const ASPECT = 6858000 / 12192000

/** happy-dom 不计算布局：未隐藏的工作表、幻灯片与页面滚动容器取上述尺寸（宽度可另给），其余元素为 0。挂载前调用。 */
function sizeScrollers(width = VIEW_W) {
  const proto = HTMLElement.prototype
  const size = (value: number) => ({
    configurable: true,
    get(this: HTMLElement) {
      const scroller = ['sheet-scroll', 'slide-scroll', 'doc-scroll'].some((name) =>
        this.classList.contains(name),
      )
      return scroller && !this.hidden ? value : 0
    },
  })
  Object.defineProperty(proto, 'clientWidth', size(width))
  Object.defineProperty(proto, 'clientHeight', size(VIEW_H))
  restores.push(() => {
    delete (proto as { clientWidth?: number }).clientWidth
    delete (proto as { clientHeight?: number }).clientHeight
  })
}

/** 替换 `getContext`，记录被绘制的画布。 */
function spyPaint(): HTMLCanvasElement[] {
  const painted: HTMLCanvasElement[] = []
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (this: HTMLCanvasElement) => null
  }
  const original = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement) {
    painted.push(this)
    return null
  }
  restores.push(() => {
    proto.getContext = original
  })
  return painted
}

interface RecordedFill {
  /** 填充时的画布变换 `[a, b, c, d, e, f]`。 */
  readonly transform: readonly unknown[]
  readonly fillStyle: unknown
  readonly rect: readonly number[]
}

interface RecordedContext {
  readonly canvas: HTMLCanvasElement
  /** 首次取得绘制上下文时的选项。 */
  readonly options: unknown
  readonly fills: RecordedFill[]
}

/**
 * 替换 `getContext`：每个画布返回一个记录 `fillRect` 的替身上下文（同一画布返回同一个），其余方法为空操作。
 * 替身只记录填充时的变换与填充色，不模拟像素；`in` 运算对任何属性为假，绘制代码按缺少可选属性处理。
 */
function recordContexts(): RecordedContext[] {
  const list: RecordedContext[] = []
  const contexts = new WeakMap<HTMLCanvasElement, object>()
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (this: HTMLCanvasElement, kind: string, options?: unknown) => object | null
  }
  const original = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement, _kind: string, options?: unknown) {
    let ctx = contexts.get(this)
    if (!ctx) {
      const record: RecordedContext = { canvas: this, options, fills: [] }
      list.push(record)
      let transform: readonly unknown[] = [1, 0, 0, 1, 0, 0]
      let fillStyle: unknown = '#000000'
      ctx = new Proxy(
        {},
        {
          has: () => false,
          get: (_target, prop) => {
            if (prop === 'fillStyle') return fillStyle
            if (prop === 'setTransform')
              return (...m: unknown[]) => {
                transform = m
              }
            if (prop === 'getTransform')
              return () => {
                const [a, b, c, d, e, f] = transform
                return { a, b, c, d, e, f }
              }
            if (prop === 'fillRect')
              return (...rect: number[]) => record.fills.push({ transform, fillStyle, rect })
            return () => {}
          },
          set: (_target, prop, value) => {
            if (prop === 'fillStyle') fillStyle = value
            return true
          },
        },
      )
      contexts.set(this, ctx)
    }
    return ctx
  }
  restores.push(() => {
    proto.getContext = original
  })
  return list
}

/** 由画布的纵向位置求幻灯片序号（`slide-viewport.ts` 的排列：间距 `GAP`，以幻灯片宽度为单位）。 */
async function slideIndex(canvas: HTMLCanvasElement): Promise<number> {
  const { GAP } = await import('./pptx/slide-viewport.ts')
  const scale = VIEW_W / (1 + 2 * GAP)
  // 加 0 使 -0 成为 0。
  return Math.round((Number.parseFloat(canvas.style.top) / scale - GAP) / (ASPECT + GAP)) + 0
}

async function pageIndexes(host: HTMLElement): Promise<number[]> {
  const pages = [...host.querySelectorAll<HTMLCanvasElement>('.slide-page')]
  return (await Promise.all(pages.map(slideIndex))).sort((a, b) => a - b)
}

describe('演示文稿预览', () => {
  test('加载期间显示加载态；解析在模块 Worker 中进行，Worker 为同源文件且在显示期间保留', async () => {
    const workers = fakeWorker()
    let release: (() => void) | undefined
    await fakeServer({
      bytes: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('deck')
        }),
    })
    const host = await mountFileView(
      () => 'slides/a.pptx',
      () => 0,
    )
    await waitFor(
      () => release !== undefined,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.slide-view .preview-loading')).not.toBeNull()
    expect(host.querySelector<HTMLElement>('.slide-scroll')!.hidden).toBe(true)

    release?.()
    await waitFor(
      () => boundary(host) !== null,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.slide-view .preview-loading')).toBeNull()
    expect(host.querySelector<HTMLElement>('.slide-scroll')!.hidden).toBe(false)
    expect(workers.calls).toHaveLength(1)
    expect(workers.calls[0]!.type).toBe('module')
    expect(new URL(workers.calls[0]!.url).pathname.endsWith('/office/pptx/pptx-worker.ts')).toBe(
      true,
    )
    expect(workers.terminated()).toBe(0)

    dispose?.()
    dispose = undefined
    expect(workers.terminated()).toBe(1)
  })

  /** 原始失败形状：只按文件中的字体名取得字体，WPS 演示替代所用的字体（自带度量的绘制字体、前缀匹配的结果）未取得。 */
  test('主机没有的字体名另取得 WPS 演示替代所用的字体', async () => {
    fakeWorker()
    const { fontRequests } = await fakeServer({ bytes: () => 'substitute' })
    const host = await mountFileView(
      () => 'substitute.pptx',
      () => 0,
    )
    await waitFor(
      () => host.querySelector<HTMLElement>('.slide-scroll')?.hidden === false,
      () => fontRequests.join(','),
    )
    expect(fontRequests).toEqual(
      expect.arrayContaining(['华文楷体', 'Yu Gothic UI', '微软雅黑', 'Courier', 'Courier New']),
    )
  })

  test('三类失败各显示一句原因，不显示幻灯片与能力边界', async () => {
    fakeWorker()
    await fakeServer({ bytes: (path) => path.replace(/\.pptx$/, '') })
    const { createSignal } = await import('solid-js')
    const [path, setPath] = createSignal('encrypted.pptx')
    const host = await mountFileView(path, () => 0)
    for (const [file, text] of [
      ['encrypted.pptx', '文件已加密'],
      ['corrupt.pptx', '文件已损坏'],
      ['plain.pptx', '不是 Office 文件'],
    ] as const) {
      setPath(file)
      await waitFor(
        () => note(host) === text,
        () => `${file}：${host.innerHTML.slice(0, 300)}`,
      )
      expect(host.querySelector<HTMLElement>('.slide-scroll')!.hidden).toBe(true)
      expect(host.querySelector('.office-boundary')).toBeNull()
    }
  })

  test('能力边界按整个文件列出各种类的名称与计数', async () => {
    fakeWorker()
    await fakeServer({ bytes: () => 'kinds' })
    const host = await mountFileView(
      () => 'kinds.pptx',
      () => 0,
    )
    await waitFor(
      () => boundary(host) !== null,
      () => host.innerHTML.slice(0, 300),
    )
    expect(boundary(host)).toBe(
      '未显示：图表 1、SmartArt 1、嵌入对象 1、其他对象 1、音视频 1、墨迹 1、图片 1、' +
        '竖排文字 1、文字变形 1、表格样式 1、三维效果 1、图片效果 1、其他效果 1、公式 1、动画 1、切换效果 1',
    )
  })

  test('只为与可见区域相交的幻灯片创建画布并绘制；滚动后释放离开可见区域的画布', async () => {
    fakeWorker()
    const painted = spyPaint()
    await fakeServer({ bytes: () => 'deck' })
    sizeScrollers()
    const host = await mountFileView(
      () => 'deck.pptx',
      () => 0,
    )
    await waitFor(
      () => painted.length >= 2,
      () => host.innerHTML.slice(0, 300),
    )
    const scroller = host.querySelector<HTMLElement>('.slide-scroll')!
    expect(await pageIndexes(host)).toEqual([0, 1])
    expect(await Promise.all(painted.map(slideIndex))).toEqual([0, 1])
    for (const canvas of painted) {
      expect(canvas.width).toBe(Math.round(VIEW_W / 1.06))
    }

    const { GAP } = await import('./pptx/slide-viewport.ts')
    const scale = VIEW_W / (1 + 2 * GAP)
    scroller.scrollTop = (5 * (ASPECT + GAP) + 0.1) * scale
    scroller.dispatchEvent(new Event('scroll'))
    await waitFor(
      () => painted.length >= 4,
      () => host.innerHTML.slice(0, 300),
    )
    expect(await pageIndexes(host)).toEqual([5, 6])
    expect(await Promise.all(painted.slice(2).map(slideIndex))).toEqual([5, 6])
    // 离开可见区域的画布已移除并释放像素。
    expect(painted.slice(0, 2).every((c) => !c.isConnected && c.width === 0)).toBe(true)
  })

  /**
   * 原始失败形状：透明画布上的文字为灰度抗锯齿；画布位置与 CSS 尺寸为小数时浏览器重采样，文字发虚。
   * 不透明画布的初始像素为黑色，画布高度取整后最后一行像素只被幻灯片部分覆盖，须先以白色铺满。
   * 主机不使用 ClearType 时画布不按频繁读取像素创建。
   */
  test('幻灯片画布为不透明画布，绘制前以白色铺满整个画布；位置按像素取整，画布像素与 CSS 像素相同', async () => {
    fakeWorker()
    const contexts = recordContexts()
    await fakeServer({ bytes: () => 'deck' })
    sizeScrollers()
    const host = await mountFileView(
      () => 'deck.pptx',
      () => 0,
    )
    await waitFor(
      () => contexts.length >= 2 && contexts.every((c) => c.fills.length > 0),
      () => host.innerHTML.slice(0, 300),
    )
    const { GAP } = await import('./pptx/slide-viewport.ts')
    const scale = VIEW_W / (1 + 2 * GAP)
    for (const { canvas, options, fills } of contexts) {
      expect(options).toEqual({ alpha: false, willReadFrequently: false })
      expect(fills[0]).toEqual({
        transform: [1, 0, 0, 1, 0, 0],
        fillStyle: '#ffffff',
        rect: [0, 0, canvas.width, canvas.height],
      })
      expect([canvas.width, canvas.height]).toEqual([Math.round(scale), Math.round(ASPECT * scale)])
      expect(canvas.style.width).toBe(`${canvas.width}px`)
      expect(canvas.style.height).toBe(`${canvas.height}px`)
    }
    const left = `${Math.round(GAP * scale)}px`
    expect(contexts.map((c) => c.canvas.style.left)).toEqual([left, left])
    expect(contexts.map((c) => c.canvas.style.top)).toEqual([
      `${Math.round(GAP * scale)}px`,
      `${Math.round((2 * GAP + ASPECT) * scale)}px`,
    ])
  })

  /** 原始失败形状：WPS 演示的文字为 GDI 的 ClearType 绘制，此前幻灯片一律以浏览器字体绘制。 */
  test('主机使用 ClearType 时幻灯片画布按频繁读取像素创建：文字以 ClearType 字形读写画布像素', async () => {
    fakeWorker()
    const contexts = recordContexts()
    await fakeServer({ bytes: () => 'deck', clearType: { contrast: 1200 } })
    sizeScrollers()
    const host = await mountFileView(
      () => 'deck.pptx',
      () => 0,
    )
    await waitFor(
      () => contexts.length >= 2 && contexts.every((c) => c.fills.length > 0),
      () => host.innerHTML.slice(0, 300),
    )
    for (const { options } of contexts) {
      expect(options).toEqual({ alpha: false, willReadFrequently: true })
    }
  })

  /** 原始失败形状：AI 改写文件后预览不刷新；或刷新后回到第一张幻灯片、缩放复原。 */
  test('改写后按修改时间重新加载，保留滚动位置与缩放比例；修改时间不变时不重新获取', async () => {
    fakeWorker()
    let mtime = 1
    const server = await fakeServer({
      bytes: () => (mtime === 1 ? 'deck' : 'rewritten'),
      mtime: () => mtime,
    })
    const { createSignal } = await import('solid-js')
    const [refresh, setRefresh] = createSignal(0)
    sizeScrollers()
    const host = await mountFileView(() => 'deck.pptx', refresh)
    await waitFor(
      () => boundary(host) === '未显示：图表 1、SmartArt 2、动画 4',
      () => host.innerHTML.slice(0, 300),
    )
    const scroller = host.querySelector<HTMLElement>('.slide-scroll')!
    const extent = host.querySelector<HTMLElement>('.slide-extent')!
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(VIEW_W, 3)

    // happy-dom 的 `WheelEvent` 不采用初始化参数中的 `ctrlKey`，在事件对象上设定。
    const wheel = new WheelEvent('wheel', { deltaY: -200, cancelable: true })
    Object.defineProperty(wheel, 'ctrlKey', { value: true })
    scroller.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    const zoom = Math.exp(200 * 0.0015)
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(VIEW_W * zoom, 3)
    scroller.scrollTop = 1500
    scroller.dispatchEvent(new Event('scroll'))

    setRefresh(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.raw).toHaveLength(1)

    mtime = 2
    setRefresh(2)
    await waitFor(
      () => boundary(host) === '未显示：图片 1、切换效果 2',
      () => `raw=${server.raw.length} ${host.innerHTML.slice(0, 300)}`,
    )
    expect(server.raw).toHaveLength(2)
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(VIEW_W * zoom, 3)
    expect(scroller.scrollTop).toBeCloseTo(1500, 6)
  })

  test('主机没有的字体取嵌入字体，每次加载以新的族名注册，文档被替换与卸载时删除', async () => {
    const workers = fakeWorker()
    let mtime = 1
    const { families } = await fakeServer({ bytes: () => 'embedded', mtime: () => mtime })
    const { createSignal } = await import('solid-js')
    const [refresh, setRefresh] = createSignal(0)
    const host = await mountFileView(() => 'embedded.pptx', refresh)
    await waitFor(
      () => families().some((f) => f.startsWith('华文行楷 ')),
      () => host.innerHTML.slice(0, 300),
    )
    expect(workers.requests).toEqual(['parse', 'font'])
    const first = families().filter((f) => f.startsWith('华文行楷 '))
    expect(first).toHaveLength(1)

    mtime = 2
    setRefresh(1)
    await waitFor(
      () => workers.requests.length === 4,
      () => workers.requests.join(','),
    )
    await waitFor(
      () => {
        const now = families().filter((f) => f.startsWith('华文行楷 '))
        return now.length === 1 && now[0] !== first[0]
      },
      () => families().join(','),
    )

    dispose?.()
    dispose = undefined
    expect(families().filter((f) => f.startsWith('华文行楷 '))).toEqual([])
  })

  /** 原始失败形状：嵌入字体全部还原之后才开始绘制，大文件首屏等待十秒以上。 */
  test('主机字体就绪后即绘制可见幻灯片；嵌入字体逐个还原，每注册一个只重绘用到它的幻灯片', async () => {
    const workers = fakeWorker({ holdFonts: true })
    const painted = spyPaint()
    const { families } = await fakeServer({ bytes: () => 'pair' })
    sizeScrollers()
    const host = await mountFileView(
      () => 'pair.pptx',
      () => 0,
    )
    await waitFor(
      () => painted.length >= 2 && workers.held.length === 1,
      () => `painted=${painted.length} ${workers.requests.join(',')}`,
    )
    expect(await Promise.all(painted.map(slideIndex))).toEqual([0, 1])
    expect(families().filter((f) => /^[甲乙] /.test(f))).toEqual([])
    // 第 2 张的图片请求在第一帧发出，先于字体请求；第一个字体的回复到达之前不请求第二个。
    expect(workers.requests).toEqual(['parse', 'images', 'font'])
    expect(workers.held.map((h) => h.typeface)).toEqual(['甲'])

    workers.held.shift()!.release()
    await waitFor(
      () => painted.length >= 3 && workers.held.length === 1,
      () => `painted=${painted.length} ${workers.requests.join(',')}`,
    )
    expect(families().filter((f) => /^[甲乙] /.test(f))).toHaveLength(1)
    expect(families().some((f) => f.startsWith('甲 '))).toBe(true)
    expect(await slideIndex(painted[2]!)).toBe(0)
    expect(workers.held.map((h) => h.typeface)).toEqual(['乙'])

    workers.held.shift()!.release()
    await waitFor(
      () => painted.length >= 4,
      () => `painted=${painted.length} ${host.innerHTML.slice(0, 300)}`,
    )
    expect(await slideIndex(painted[3]!)).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(painted).toHaveLength(4)
    expect(workers.requests).toEqual(['parse', 'images', 'font', 'font'])
  })

  test('改写后刷新时，旧文档尚未完成的还原结果丢弃，已注册的嵌入字体删除', async () => {
    const workers = fakeWorker({ holdFonts: true })
    let mtime = 1
    let holding = false
    const { families, loads } = await fakeServer({
      bytes: () => 'pair',
      mtime: () => mtime,
      holdLoad: (family) => holding && family.startsWith('甲 '),
    })
    const { createSignal } = await import('solid-js')
    const [refresh, setRefresh] = createSignal(0)
    sizeScrollers()
    const host = await mountFileView(() => 'pair.pptx', refresh)
    const embedded = () => families().filter((f) => /^[甲乙] /.test(f))

    // 第一份：「甲」已注册，「乙」的还原尚未回复。
    await waitFor(
      () => workers.held.length === 1,
      () => host.innerHTML.slice(0, 300),
    )
    workers.held.shift()!.release()
    await waitFor(
      () => embedded().length === 1 && workers.held.length === 1,
      () => `${embedded().join(',')} ${workers.requests.join(',')}`,
    )
    const pending = workers.held.shift()!

    mtime = 2
    setRefresh(1)
    await waitFor(
      () => workers.terminated() === 1 && workers.held.length === 1,
      () => `terminated=${workers.terminated()} ${workers.requests.join(',')}`,
    )
    expect(embedded()).toEqual([])
    pending.release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(embedded()).toEqual([])

    // 第二份：「甲」的还原已回复、注册尚未完成时被替换；收到「甲」时已请求「乙」。
    holding = true
    workers.held.shift()!.release()
    await waitFor(
      () => loads.length === 1 && workers.held.length === 1,
      () => `${workers.requests.join(',')}`,
    )
    const unanswered = workers.held.shift()!
    mtime = 3
    setRefresh(2)
    await waitFor(
      () => workers.terminated() === 2 && workers.held.length === 1,
      () => `terminated=${workers.terminated()} ${workers.requests.join(',')}`,
    )
    loads[0]!.release()
    unanswered.release()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(embedded()).toEqual([])

    // 第三份照常还原。
    holding = false
    workers.held.shift()!.release()
    await waitFor(
      () => embedded().length === 1 && workers.held.length === 1,
      () => embedded().join(','),
    )
    expect(workers.requests).toEqual([
      'parse',
      'images',
      'font',
      'font',
      'parse',
      'images',
      'font',
      'font',
      'parse',
      'images',
      'font',
      'font',
    ])
  })
})

/** 页面视口中各页的顶边（磅，`page-viewport.ts` 的排列：页面之间与四周间距 `GAP`）。 */
async function docTops(sizes: readonly { height: number }[]): Promise<number[]> {
  const { GAP } = await import('./docx/page-viewport.ts')
  let y = GAP
  return sizes.map((s) => {
    const top = y
    y += s.height + GAP
    return top
  })
}

/** 由画布的纵向位置求页面序号；`scale` 为每磅的 CSS 像素数。 */
async function docIndexes(host: HTMLElement, scale: number): Promise<number[]> {
  const tops = await docTops(REPORT_SIZES)
  return [...host.querySelectorAll<HTMLCanvasElement>('.doc-page')]
    .map((c) => tops.findIndex((t) => Math.abs(t * scale - Number.parseFloat(c.style.top)) <= 1))
    .sort((a, b) => a - b)
}

describe('文档预览', () => {
  test('加载期间显示加载态；解析与分页在模块 Worker 中进行，Worker 为同源文件，分页完成后结束；排版使用主机字体的字节与族名', async () => {
    const workers = fakeWorker()
    let release: (() => void) | undefined
    await fakeServer({
      bytes: () =>
        new Promise<string>((resolve) => {
          release = () => resolve('report')
        }),
    })
    const host = await mountFileView(
      () => 'docs/a.docx',
      () => 0,
    )
    await waitFor(
      () => release !== undefined,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.doc-view .preview-loading')).not.toBeNull()
    expect(host.querySelector<HTMLElement>('.doc-scroll')!.hidden).toBe(true)

    release?.()
    await waitFor(
      () => boundary(host) !== null,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.doc-view .preview-loading')).toBeNull()
    expect(host.querySelector<HTMLElement>('.doc-scroll')!.hidden).toBe(false)
    expect(workers.calls).toHaveLength(1)
    expect(workers.calls[0]!.type).toBe('module')
    expect(new URL(workers.calls[0]!.url).pathname.endsWith('/office/docx/docx-worker.ts')).toBe(
      true,
    )
    expect(workers.requests).toEqual(['parse', 'layout'])
    expect(workers.terminated()).toBe(1)
    // 主机字体的族名随解析请求交给 Worker（前缀匹配与所需字体名都按它求得）。
    expect(workers.parses[0]!.host).toEqual(HOST_FAMILIES)
    // 文档所需的字体名与回退字体都请求过；主机只有宋体，其余字体名没有字体文件。
    const layout = workers.layouts[0]!
    expect(layout.families).toEqual([
      ['宋体', [0]],
      ['SimSun', []],
      ['黑体', []],
    ])
    expect(layout.files).toHaveLength(1)
    expect([...layout.files[0]!]).toEqual([...tinyFont()])
    expect(layout.fallback).toBe('宋体')
  })

  test('三类失败各显示一句原因，不显示页面与能力边界', async () => {
    fakeWorker()
    await fakeServer({ bytes: (path) => path.replace(/\.docx$/, '') })
    const { createSignal } = await import('solid-js')
    const [path, setPath] = createSignal('encrypted.docx')
    const host = await mountFileView(path, () => 0)
    for (const [file, text] of [
      ['encrypted.docx', '文件已加密'],
      ['corrupt.docx', '文件已损坏'],
      ['plain.docx', '不是 Office 文件'],
    ] as const) {
      setPath(file)
      await waitFor(
        () => note(host) === text,
        () => `${file}：${host.innerHTML.slice(0, 300)}`,
      )
      expect(host.querySelector<HTMLElement>('.doc-scroll')!.hidden).toBe(true)
      expect(host.querySelector('.office-boundary')).toBeNull()
    }
  })

  test('能力边界按整个文件列出名称与计数；无法解码的图片格式计入图片，VML 计入其他对象，未绘制的公式取自分页结果', async () => {
    fakeWorker()
    await fakeServer({ bytes: () => 'kinds' })
    const host = await mountFileView(
      () => 'kinds.docx',
      () => 0,
    )
    await waitFor(
      () => boundary(host) !== null,
      () => host.innerHTML.slice(0, 300),
    )
    expect(boundary(host)).toBe(
      '未显示：图片 2、图表 1、SmartArt 1、形状 1、组合 1、绘图画布 1、其他对象 2、嵌入对象 1、公式 1、墨迹 1、' +
        '其他效果 1、图文框 1、浮动表格 1、外部内容 1、子文档 1、脚注 1、尾注 1、批注 1、修订 1、域 1、分栏 1、' +
        '文字方向 1、行号 1、字符网格 1、艺术型页面边框 1、编号格式 1、嵌套过深的内容 1、' +
        '小数点对齐制表位 1、竖线对齐制表位 1、对齐方式选项卡 1、字符缩放 1、着重号 1、小型大写字母 1、中文版式 1、' +
        '调整宽度 1、从右向左 1、拼音指南 1、可选连字符 1',
    )
  })

  test('页面列宽于滚动容器时首次显示缩放到适合宽度；只为可见页面创建画布，各页水平居中；滚动后释放离开可见区域的画布', async () => {
    fakeWorker()
    const painted = spyPaint()
    await fakeServer({ bytes: () => 'report' })
    sizeScrollers()
    const host = await mountFileView(
      () => 'report.docx',
      () => 0,
    )
    await waitFor(
      () => painted.length >= 1,
      () => host.innerHTML.slice(0, 300),
    )
    const { GAP } = await import('./docx/page-viewport.ts')
    // 最宽的是横向页：页面列 841.9 + 2 × GAP 磅缩放到 800 像素。
    const scale = VIEW_W / (A4_LANDSCAPE.width + 2 * GAP)
    const scroller = host.querySelector<HTMLElement>('.doc-scroll')!
    const extent = host.querySelector<HTMLElement>('.doc-extent')!
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(VIEW_W, 3)
    expect(await docIndexes(host, scale)).toEqual([0])
    const first = painted[0]!
    expect(first.width).toBe(Math.ceil(A4.width * scale))
    expect(first.style.left).toBe(
      `${Math.round((GAP + (A4_LANDSCAPE.width - A4.width) / 2) * scale)}px`,
    )

    const tops = await docTops(REPORT_SIZES)
    scroller.scrollTop = (tops[3]! + 0.1) * scale
    scroller.dispatchEvent(new Event('scroll'))
    await waitFor(
      () => painted.length >= 3,
      () => host.innerHTML.slice(0, 300),
    )
    expect(await docIndexes(host, scale)).toEqual([3, 4])
    const landscape = painted[1]!
    expect(landscape.width).toBe(Math.ceil(A4_LANDSCAPE.width * scale))
    expect(landscape.style.left).toBe(`${Math.round(GAP * scale)}px`)
    // 离开可见区域的画布已移除并释放像素。
    expect(!first.isConnected && first.width === 0).toBe(true)
  })

  /** 原始失败形状：100% 显示时画布像素与屏幕像素不一一对应，点阵字形与整数像素宽度经重采样后发虚。 */
  test('页面列窄于滚动容器时为 100%：每磅 4/3 像素，画布位置按像素取整，画布像素与 CSS 像素相同', async () => {
    fakeWorker()
    const painted = spyPaint()
    await fakeServer({ bytes: () => 'report' })
    sizeScrollers(1200)
    const host = await mountFileView(
      () => 'report.docx',
      () => 0,
    )
    await waitFor(
      () => painted.length >= 1,
      () => host.innerHTML.slice(0, 300),
    )
    const { GAP, PX_PER_POINT } = await import('./docx/page-viewport.ts')
    const column = (A4_LANDSCAPE.width + 2 * GAP) * PX_PER_POINT
    const extent = host.querySelector<HTMLElement>('.doc-extent')!
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(1200, 3)
    const canvas = painted[0]!
    expect(canvas.width).toBe(Math.ceil(A4.width * PX_PER_POINT))
    expect(canvas.style.width).toBe(`${canvas.width}px`)
    const left = (1200 - column) / 2 + (GAP + (A4_LANDSCAPE.width - A4.width) / 2) * PX_PER_POINT
    expect(canvas.style.left).toBe(`${Math.round(left)}px`)
    expect(canvas.style.top).toBe(`${Math.round(GAP * PX_PER_POINT)}px`)
  })

  /** 原始失败形状：WPS 文字的正文为 GDI 的 ClearType 绘制，此前页面一律以浏览器字体绘制。 */
  test('主机使用 ClearType 时页面画布按频繁读取像素创建；不使用时按缺省方式创建', async () => {
    for (const clearType of [{ contrast: 1200 }, undefined]) {
      fakeWorker()
      const contexts = recordContexts()
      await fakeServer(clearType ? { bytes: () => 'report', clearType } : { bytes: () => 'report' })
      sizeScrollers()
      const host = await mountFileView(
        () => 'report.docx',
        () => 0,
      )
      await waitFor(
        () => contexts.length >= 1 && contexts.every((c) => c.fills.length > 0),
        () => host.innerHTML.slice(0, 300),
      )
      for (const { options } of contexts)
        expect(options).toEqual({ alpha: false, willReadFrequently: clearType !== undefined })
      dispose?.()
      dispose = undefined
      document.body.replaceChildren()
      for (const restore of restores.splice(0).reverse()) restore()
    }
  })

  /** 原始失败形状：AI 改写文件后预览不刷新；或刷新后回到第一页、缩放复原。 */
  test('嵌入字体随解析结果取得，每次加载以新的族名注册并与主机字体一同排版，文档被替换与卸载时删除', async () => {
    const workers = fakeWorker()
    let mtime = 1
    const { families } = await fakeServer({ bytes: () => 'embedded', mtime: () => mtime })
    const { createSignal } = await import('solid-js')
    const [refresh, setRefresh] = createSignal(0)
    const host = await mountFileView(() => 'embedded.docx', refresh)
    const embedded = () => families().filter((f) => f.startsWith('方正小标宋简体 '))
    await waitFor(
      () => workers.layouts.length === 1 && embedded().length === 1,
      () => host.innerHTML.slice(0, 300),
    )
    const layout = workers.layouts[0]!
    expect(layout.families).toEqual([
      ['宋体', [0]],
      ['方正小标宋简体', [1]],
    ])
    expect(layout.files).toHaveLength(2)
    const first = embedded()

    mtime = 2
    setRefresh(1)
    await waitFor(
      () => workers.layouts.length === 2 && embedded().length === 1 && embedded()[0] !== first[0],
      () => families().join(','),
    )

    dispose?.()
    dispose = undefined
    expect(embedded()).toEqual([])
  })

  test('改写后按修改时间重新加载，保留滚动位置与缩放比例；修改时间不变时不重新获取', async () => {
    fakeWorker()
    let mtime = 1
    const server = await fakeServer({
      bytes: () => (mtime === 1 ? 'report' : 'revised'),
      mtime: () => mtime,
    })
    const { createSignal } = await import('solid-js')
    const [refresh, setRefresh] = createSignal(0)
    sizeScrollers()
    const host = await mountFileView(() => 'report.docx', refresh)
    await waitFor(
      () => boundary(host) === '未显示：图表 2、小数点对齐制表位 3',
      () => host.innerHTML.slice(0, 300),
    )
    const scroller = host.querySelector<HTMLElement>('.doc-scroll')!
    const extent = host.querySelector<HTMLElement>('.doc-extent')!

    // happy-dom 的 `WheelEvent` 不采用初始化参数中的 `ctrlKey`，在事件对象上设定。
    const wheel = new WheelEvent('wheel', { deltaY: -200, cancelable: true })
    Object.defineProperty(wheel, 'ctrlKey', { value: true })
    scroller.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    const zoom = Math.exp(200 * 0.0015)
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(VIEW_W * zoom, 3)
    scroller.scrollTop = 1500
    scroller.dispatchEvent(new Event('scroll'))

    setRefresh(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(server.raw).toHaveLength(1)

    mtime = 2
    setRefresh(2)
    await waitFor(
      () => boundary(host) === '未显示：公式 1',
      () => `raw=${server.raw.length} ${host.innerHTML.slice(0, 300)}`,
    )
    expect(server.raw).toHaveLength(2)
    expect(Number.parseFloat(extent.style.width)).toBeCloseTo(VIEW_W * zoom, 3)
    expect(scroller.scrollTop).toBeCloseTo(1500, 6)
  })
})

/** 打开看板，点击标签为 `label` 的行。 */
async function openBoardRow(host: HTMLElement, label: string): Promise<HTMLButtonElement> {
  host.querySelector<HTMLButtonElement>('[aria-label="新开预览"]')!.click()
  await waitFor(
    () => host.querySelectorAll('.board-item').length > 0,
    () => host.innerHTML.slice(0, 300),
  )
  return [...host.querySelectorAll<HTMLButtonElement>('.board-item')].find(
    (el) => el.querySelector('.board-label')?.textContent === label,
  )!
}

async function mountSidePanel(workspaceId: string) {
  const store = await import('../../lib/store/index.ts')
  store.setState({ connection: 'ready', fileVersion: 0 })
  store.setWorkspace({ id: workspaceId, root: 'C:\\work', name: 'work' })
  store.setSidePanel('files')
  const { render } = await import('solid-js/web')
  const { default: SidePanel } = await import('../SidePanel.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <SidePanel />, host as unknown as HTMLElement)
  return host
}

describe('看板的 Office 行', () => {
  test('Excel 行点击后打开文件选择框，按 office 格式筛选；选中后新开文件预览页', async () => {
    fakeWorker()
    const server = await fakeServer({
      bytes: () => 'first',
      find: () => [
        { path: 'books/a.xlsx', kind: 'file' },
        { path: 'books/b.xlsm', kind: 'file' },
      ],
    })
    const { store } = server
    const host = await mountSidePanel('ws_office_board')

    const excel = await openBoardRow(host, 'Excel')
    expect(excel.disabled).toBe(false)
    expect(excel.querySelector('.board-tag')).toBeNull()
    excel.click()

    await waitFor(
      () => host.querySelectorAll('.office-picker-list > button').length === 2,
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.preview-board')).toBeNull()
    expect(server.finds).toHaveLength(1)
    expect(server.finds[0]!.get('office')).toBe('xlsx')
    expect(server.finds[0]!.get('q')).toBe('')
    expect(server.finds[0]!.has('kinds')).toBe(false)

    host.querySelectorAll<HTMLButtonElement>('.office-picker-list > button')[1]!.click()
    await waitFor(
      () => host.querySelector('.office-picker') === null && tabNames(host).length > 0,
      () => host.innerHTML.slice(0, 400),
    )
    expect(store.panelTabs().map((t) => [t.kind, t.title, t.path])).toEqual([
      ['file', 'b.xlsm', 'books/b.xlsm'],
    ])
    expect(host.querySelector('.tab-pane.active .preview-head')?.textContent).toBe(
      'C:\\work\\books\\b.xlsm',
    )
    // 页签上已有 ×，标题条不再放第二个关闭按钮。
    expect(host.querySelector('.tab-pane.active .preview-head [aria-label="关闭"]')).toBeNull()

    // 再次选中同一文件时切换到已有页，不新建第二页。
    store.openFileTab('books/b.xlsm')
    expect(store.panelTabs()).toHaveLength(1)
  })

  test('PPT 行点击后打开文件选择框，只按演示文稿格式筛选；选中后新开文件预览页', async () => {
    fakeWorker()
    const server = await fakeServer({
      bytes: () => 'deck',
      find: () => [
        { path: 'slides/a.pptx', kind: 'file' },
        { path: 'slides/b.pptm', kind: 'file' },
      ],
    })
    const { store } = server
    const host = await mountSidePanel('ws_office_ppt')

    const ppt = await openBoardRow(host, 'PPT')
    expect(ppt.disabled).toBe(false)
    expect(ppt.querySelector('.board-tag')).toBeNull()
    ppt.click()

    await waitFor(
      () => host.querySelectorAll('.office-picker-list > button').length === 2,
      () => host.innerHTML.slice(0, 300),
    )
    expect(server.finds).toHaveLength(1)
    expect(server.finds[0]!.get('office')).toBe('pptx')
    expect(server.finds[0]!.has('kinds')).toBe(false)

    host.querySelectorAll<HTMLButtonElement>('.office-picker-list > button')[0]!.click()
    await waitFor(
      () => host.querySelector('.office-picker') === null && boundary(host) !== null,
      () => host.innerHTML.slice(0, 400),
    )
    expect(store.panelTabs().map((t) => [t.kind, t.title, t.path])).toEqual([
      ['file', 'a.pptx', 'slides/a.pptx'],
    ])
    expect(host.querySelector('.tab-pane.active .slide-view')).not.toBeNull()
  })

  test('Word 行点击后打开文件选择框，只按文档格式筛选；选中后新开文件预览页', async () => {
    fakeWorker()
    const server = await fakeServer({
      bytes: () => 'report',
      find: () => [
        { path: 'docs/a.docx', kind: 'file' },
        { path: 'docs/b.dotx', kind: 'file' },
      ],
    })
    const { store } = server
    const host = await mountSidePanel('ws_office_word')

    const word = await openBoardRow(host, 'Word')
    expect(word.disabled).toBe(false)
    expect(word.querySelector('.board-tag')).toBeNull()
    word.click()

    await waitFor(
      () => host.querySelectorAll('.office-picker-list > button').length === 2,
      () => host.innerHTML.slice(0, 300),
    )
    expect(server.finds).toHaveLength(1)
    expect(server.finds[0]!.get('office')).toBe('docx')
    expect(server.finds[0]!.has('kinds')).toBe(false)

    host.querySelectorAll<HTMLButtonElement>('.office-picker-list > button')[0]!.click()
    await waitFor(
      () => host.querySelector('.office-picker') === null && boundary(host) !== null,
      () => host.innerHTML.slice(0, 400),
    )
    expect(store.panelTabs().map((t) => [t.kind, t.title, t.path])).toEqual([
      ['file', 'a.docx', 'docs/a.docx'],
    ])
    expect(host.querySelector('.tab-pane.active .doc-view')).not.toBeNull()
  })

  test('按 Escape 或点击遮罩关闭选择框，不打开任何页', async () => {
    fakeWorker()
    const { store } = await fakeServer({ bytes: () => 'first' })
    const host = await mountSidePanel('ws_office_close')

    const openPicker = async () => {
      ;(await openBoardRow(host, 'Excel')).click()
      await waitFor(
        () => host.querySelector('.office-picker') !== null,
        () => host.innerHTML.slice(0, 300),
      )
    }

    await openPicker()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitFor(
      () => host.querySelector('.office-picker') === null,
      () => host.innerHTML.slice(0, 300),
    )

    await openPicker()
    host.querySelector<HTMLButtonElement>('.backdrop-close')!.click()
    await waitFor(
      () => host.querySelector('.office-picker') === null,
      () => host.innerHTML.slice(0, 300),
    )
    expect(store.panelTabs()).toEqual([])
  })
})
