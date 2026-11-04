/**
 * .xls 嵌入图表与图表工作表：图表子流读为图表规格 `RawChart`，求值与绘制同 xlsx（`../../drawingml/chart/resolve.ts`）。
 *
 * - 子流按 Begin/End 组织为记录树；记录的含义取决于所在的块（图表、系列、坐标轴组、图表组、图例、文字）。
 * - BIFF 的「自动」格式在此换算为显式规格，不使用 DrawingML 的主题配色：系列的线条与标记取调色板第 32 起、填充取第 24 起的颜色，
 *   按系列序号（饼图与按数据点变色时按数据点序号）循环 8 色；其他元素的自动格式取记录中的颜色。
 *   未写出的坐标轴线为黑色细线；没有边框记录的图例为黑色细线边框、白色填充。标记的自动大小为 5 磅。
 * - 线宽：细线与单线 0.75 磅（1 像素），中线 1.5 磅，粗线 2.25 磅。
 * - 位置：绘图区取 CrtLayout12A（Excel 2007 写入的布局，内框或外框的比例）；没有该记录而 `fManPlotArea` 为真时取坐标轴组
 *   Pos 的外框（单位为图表区的 1/4000）。WPS 实测：xls-689ed697 的散点图内框与 CrtLayout12A 一致，与 Pos 不一致。
 *   图例未自动定位时取 CrtLayout12 的左上角，没有该记录时取 Legend 记录的左上角。标题、坐标轴标题与数据标签取自动位置。
 * - 字体取 FONT 表（FontX 序号），没有 FontX 的文字取 DefaultText 的字体。FONT 中的字号已按图表尺寸缩放，直接使用。
 * - 数据：系列名、值与分类的引用（BRAI）反编译为引用文字，由调用方的 `ChartCells` 按单元格取值；
 *   引用无法解析时使用子流末尾的缓存（SIIndex 之后的数值与文字记录，行号为数据点、列号为系列）。
 * - 坐标轴的交叉位置在 BIFF 中记在被交叉的坐标轴上，DrawingML 记在交叉的一方，换算时交换。
 * - 未实现的内容使 `unsupported` 为真（整个图表不绘制，调用方计入 `chart`）：面积图、雷达图、曲面图、气泡图、复合饼图、
 *   三维图表、次坐标轴、系列轴、对数刻度、次要刻度线与次要网格线、误差线、线性以外的趋势线、涨跌柱与高低点连线、
 *   图案与渐变填充、负值反色、图例项标示与自定义文字的数据标签。图例项的删除（LegendException）不读取。
 */

import type { ManualLayout, PlotType } from '../../drawingml/chart/model.ts'
import {
  type BoxSpec,
  EMPTY_BOX,
  type RawAxis,
  type RawChart,
  type RawData,
  type RawGroup,
  type RawLabels,
  type RawMarker,
  type RawPoint,
  type RawSeries,
  type RawTitle,
  type RawTrendline,
} from '../../drawingml/chart/read.ts'
import type { ColorSpec } from '../../drawingml/color.ts'
import type { FillSpec, LineSpec } from '../../drawingml/fill.ts'
import type { RawRun, RawTextBody, RunSpec } from '../../drawingml/text/read.ts'
import type { AbsoluteAnchor, FontStyle } from '../model.ts'
import { formulaText } from './formula.ts'
import { type BiffRecord, Bytes, RT, readChars, unicodeString } from './records.ts'

const C = {
  SERIES: 0x1003,
  DATAFORMAT: 0x1006,
  LINEFORMAT: 0x1007,
  MARKERFORMAT: 0x1009,
  AREAFORMAT: 0x100a,
  PIEFORMAT: 0x100b,
  ATTACHEDLABEL: 0x100c,
  SERIESTEXT: 0x100d,
  CHARTFORMAT: 0x1014,
  LEGEND: 0x1015,
  BAR: 0x1017,
  LINE: 0x1018,
  PIE: 0x1019,
  SCATTER: 0x101b,
  CRTLINE: 0x101c,
  AXIS: 0x101d,
  TICK: 0x101e,
  VALUERANGE: 0x101f,
  CATSERRANGE: 0x1020,
  AXISLINE: 0x1021,
  DEFAULTTEXT: 0x1024,
  TEXT: 0x1025,
  FONTX: 0x1026,
  OBJECTLINK: 0x1027,
  FRAME: 0x1032,
  BEGIN: 0x1033,
  END: 0x1034,
  PLOTAREA: 0x1035,
  CHART3D: 0x103a,
  AXISPARENT: 0x1041,
  SHTPROPS: 0x1044,
  SERTOCRT: 0x1045,
  AXESUSED: 0x1046,
  SERPARENT: 0x104a,
  SERAUXTREND: 0x104b,
  IFMT: 0x104e,
  POS: 0x104f,
  ALRUNS: 0x1050,
  BRAI: 0x1051,
  SERAUXERRBAR: 0x105b,
  SERFMT: 0x105d,
  AXCEXT: 0x1062,
  GELFRAME: 0x1066,
  SIINDEX: 0x1065,
  CHART: 0x1002,
  CRTLAYOUT12: 0x089d,
  CRTLAYOUT12A: 0x08a7,
} as const

/** 图表组中不实现的图表类型：面积图、雷达图、曲面图、填充雷达图、复合饼图。 */
const UNSUPPORTED_GROUPS = new Set([0x101a, 0x103e, 0x103f, 0x1040, 0x1061])
/** 涨跌柱（DropBar）。 */
const DROPBAR = 0x103d

const SPRC = 4000
const NO_POINTS: ReadonlySet<number> = new Set()
const MARKERS = [
  'none',
  'square',
  'diamond',
  'triangle',
  'x',
  'star',
  'dash',
  'dash',
  'circle',
  'plus',
]
const DASHES = ['solid', 'dash', 'sysDot', 'dashDot', 'lgDashDotDot']
const TICKS = ['none', 'in', 'out', 'cross']
const TICK_LABELS = ['none', 'low', 'high', 'nextTo']
/** Text 的 `dlp`：数据标签位置。 */
const LABEL_POSITIONS: readonly (string | null)[] = [
  null,
  'outEnd',
  'inEnd',
  'ctr',
  'inBase',
  't',
  'b',
  'l',
  'r',
  'bestFit',
]
const LEGEND_POSITIONS: Readonly<Record<number, 'b' | 'tr' | 't' | 'r' | 'l'>> = {
  0: 'b',
  1: 'tr',
  2: 't',
  3: 'r',
  4: 'l',
}
const UNDERLINES: Readonly<Record<string, string>> = {
  single: 'sng',
  singleAccounting: 'sng',
  double: 'dbl',
  doubleAccounting: 'dbl',
}

export interface ChartContext {
  /** FontX 序号对应的字体。 */
  fontAt(index: number): FontStyle | undefined
  readonly palette: readonly string[]
  numberFormat(ifmt: number): string
  /** EXTERNSHEET 序号对应的工作表名。 */
  sheetName(ixti: number): string | null
  readonly date1904: boolean
}

interface Node {
  readonly id: number
  readonly b: Bytes
  readonly children: Node[]
}

function tree(list: readonly BiffRecord[]): Node[] {
  const root: Node[] = []
  const stack: Node[][] = [root]
  let last: Node | null = null
  for (const r of list) {
    if (r.id === C.BEGIN) {
      stack.push(last?.children ?? [])
      last = null
    } else if (r.id === C.END) {
      if (stack.length > 1) stack.pop()
      last = null
    } else {
      last = { id: r.id, b: new Bytes(r.data), children: [] }
      stack.at(-1)!.push(last)
    }
  }
  return root
}

function child(n: Node | undefined, id: number): Node | undefined {
  return n?.children.find((c) => c.id === id)
}

function rgb(b: Bytes, p: number): ColorSpec {
  return {
    kind: 'rgb',
    color: { r: b.u8(p) / 255, g: b.u8(p + 1) / 255, b: b.u8(p + 2) / 255, a: 1 },
    transforms: [],
  }
}

function hex(color: string): ColorSpec {
  const n = Number.parseInt(color.slice(1), 16)
  return {
    kind: 'rgb',
    color: { r: (n >> 16) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255, a: 1 },
    transforms: [],
  }
}

const NONE: FillSpec = { kind: 'none' }
const BLACK: ColorSpec = hex('#000000')

function solid(color: ColorSpec): FillSpec {
  return { kind: 'solid', color }
}

function width(we: number): number {
  return we === 1 ? 19050 : we === 2 ? 28575 : 9525
}

/** 格式记录：数据格式块中的各项，系列自身的覆盖图表组的缺省格式。 */
interface Formats {
  readonly line?: Bytes
  readonly area?: Bytes
  readonly marker?: Bytes
  readonly pie?: Bytes
  readonly serFmt?: Bytes
  readonly label?: Bytes
  readonly gel?: Bytes
}

function formats(n: Node | undefined): Formats {
  const out: {
    -readonly [K in keyof Formats]: Formats[K]
  } = {}
  for (const c of n?.children ?? []) {
    if (c.id === C.LINEFORMAT) out.line = c.b
    else if (c.id === C.AREAFORMAT) out.area = c.b
    else if (c.id === C.MARKERFORMAT) out.marker = c.b
    else if (c.id === C.PIEFORMAT) out.pie = c.b
    else if (c.id === C.SERFMT) out.serFmt = c.b
    else if (c.id === C.ATTACHEDLABEL) out.label = c.b
    else if (c.id === C.GELFRAME) out.gel = c.b
  }
  return out
}

interface SeriesEntry {
  readonly index: number
  readonly node: Node
  readonly group: number
  readonly parent: number | null
}

class Reader {
  unsupported = false
  private readonly defaultFont: RunSpec

  constructor(
    private readonly ctx: ChartContext,
    chart: Node,
    private readonly cache: ReadonlyMap<number, Map<number, Map<number, number | string>>>,
  ) {
    let font: FontStyle | undefined
    for (const id of [2, 3]) {
      const at = chart.children.findIndex((c) => c.id === C.DEFAULTTEXT && c.b.u16(0) === id)
      const text = at < 0 ? undefined : chart.children[at + 1]
      const ifnt = text?.id === C.TEXT ? child(text, C.FONTX)?.b.u16(0) : undefined
      font ??= ifnt === undefined ? undefined : ctx.fontAt(ifnt)
    }
    this.defaultFont = font === undefined ? {} : fontRun(font)
  }

  color(index: number): ColorSpec {
    return hex(this.ctx.palette[index] ?? '#000000')
  }

  /**
   * LineFormat；`auto` 为自动格式的颜色（系列与数据点），`null` 时取记录中的颜色。系列没有该记录时按自动格式的细线。
   */
  line(b: Bytes | undefined, auto: ColorSpec | null): LineSpec | null {
    if (b === undefined) return auto === null ? null : { width: 9525, fill: solid(auto) }
    const lns = b.u16(4)
    if (lns === 5) return { fill: NONE }
    if (lns > 5) this.unsupported = true
    const color = b.u16(8) & 1 && auto !== null ? auto : rgb(b, 0)
    return {
      width: width(b.i16(6)),
      fill: solid(color),
      dash: { kind: 'preset', name: DASHES[lns] ?? 'solid' },
    }
  }

  /** AreaFormat；GelFrame 只接受纯色（与 AreaFormat 的颜色相同）。系列没有该记录时按自动格式。 */
  area(b: Bytes | undefined, gel: Bytes | undefined, auto: ColorSpec | null): FillSpec | null {
    if (b === undefined) return auto === null ? null : solid(auto)
    const flags = b.u16(10)
    if (flags & 2) this.unsupported = true
    if (gel !== undefined && gelType(gel) !== 0) this.unsupported = true
    if (flags & 1 && auto !== null) return solid(auto)
    const fls = b.u16(8)
    if (fls === 0) return NONE
    if (fls !== 1) this.unsupported = true
    return solid(rgb(b, 0))
  }

  box(n: Node | undefined): BoxSpec {
    const f = formats(n)
    return { fill: this.area(f.area, f.gel, null), line: this.line(f.line, null), effects: null }
  }

  /** MarkerFormat；没有该记录或为自动格式时，符号与大小取自动值，填充与边框为系列颜色。 */
  marker(b: Bytes | undefined, auto: ColorSpec): RawMarker {
    const flags = b?.u16(10) ?? 1
    if (b === undefined || flags & 1) {
      return {
        symbol: null,
        size: null,
        box: { fill: solid(auto), line: { width: 9525, fill: solid(auto) }, effects: null },
      }
    }
    return {
      symbol: MARKERS[b.u16(8)] ?? 'none',
      size: b.u32(16) / 20,
      box: {
        fill: flags & 0x10 ? NONE : solid(rgb(b, 4)),
        line: flags & 0x20 ? { fill: NONE } : { width: 9525, fill: solid(rgb(b, 0)) },
        effects: null,
      },
    }
  }

  /** 文字的字段属性：FontX 的字体（没有时为缺省字体），颜色取 Text 记录（`fAutoColor` 为假时）或字体颜色。 */
  textRun(text: Node | undefined, fontX: Node | undefined): RunSpec {
    const ifnt = (fontX ?? child(text, C.FONTX))?.b.u16(0)
    const font = ifnt === undefined ? undefined : this.ctx.fontAt(ifnt)
    const own = text !== undefined && (text.b.u16(24) & 1) === 0 ? rgb(text.b, 4) : null
    const base = font === undefined ? this.defaultFont : fontRun(font)
    const color = own ?? (font?.color ? hex(font.color) : null)
    return color === null ? base : { ...base, fill: solid(color) }
  }

  body(run: RunSpec, rotation: number | null, runs: RawRun[] = []): RawTextBody {
    return {
      body: rotation === null ? {} : { rotation },
      listStyle: null,
      paragraphs: [{ level: 0, props: { run }, runs, end: null }],
    }
  }

  /** SeriesText 或 AlRuns 分段的文字；没有文字时为 `null`。 */
  richText(text: Node): RawRun[] | null {
    const st = child(text, C.SERIESTEXT)
    if (st === undefined) return null
    const s = seriesText(st.b)
    const al = child(text, C.ALRUNS)
    if (al === undefined) return [{ kind: 'text', text: s, props: {}, link: null }]
    const cuts: { at: number; props: RunSpec }[] = []
    for (let k = 0; k < al.b.u16(0); k++) {
      const font = this.ctx.fontAt(al.b.u16(4 + k * 4))
      cuts.push({ at: al.b.u16(2 + k * 4), props: font === undefined ? {} : fontRun(font) })
    }
    cuts.sort((a, b) => a.at - b.at)
    const out: RawRun[] = []
    if ((cuts[0]?.at ?? s.length) > 0) {
      out.push({ kind: 'text', text: s.slice(0, cuts[0]?.at ?? s.length), props: {}, link: null })
    }
    cuts.forEach((c, i) => {
      const to = cuts[i + 1]?.at ?? s.length
      if (to > c.at) out.push({ kind: 'text', text: s.slice(c.at, to), props: c.props, link: null })
    })
    return out
  }

  title(text: Node): RawTitle | null {
    if (text.b.u16(24) & 0x40) return null
    const run = this.textRun(text, undefined)
    const rotation = textRotation(text.b.u16(30))
    const runs = this.richText(text)
    return {
      rich: runs === null ? null : this.body(run, rotation, runs),
      text: null,
      overlay: false,
      layout: null,
      box: this.box(child(text, C.FRAME)),
      txPr: this.body(run, rotation),
    }
  }

  /** 数据标签：Text 的显示项与位置，系列名取 AttachedLabel。 */
  labels(text: Node, attached: Bytes | undefined): RawLabels {
    const flags = text.b.u16(24)
    if (flags & 2) this.unsupported = true
    if (child(text, C.SERIESTEXT) !== undefined && (flags & 0x10) === 0) this.unsupported = true
    const both = (flags & 0x0800) !== 0
    return {
      deleted: (flags & 0x40) !== 0,
      showValue: (flags & 4) !== 0,
      showCategory: both || (flags & 0x4000) !== 0,
      showSeries: attached === undefined ? false : (attached.u16(0) & 0x40) !== 0,
      showPercent: both || (flags & 0x1000) !== 0,
      position: LABEL_POSITIONS[text.b.u16(28) & 0x0f] ?? null,
      format: null,
      separator: null,
      box: this.box(child(text, C.FRAME)),
      txPr: this.body(this.textRun(text, undefined), textRotation(text.b.u16(30))),
      rich: null,
      layout: null,
      points: new Map(),
    }
  }

  /** BRAI 的引用文字：只取引用方式（`rt` 为 2）的公式；反编译失败时为 `null`。 */
  ref(brai: Node | undefined): string | null {
    const b = brai?.b
    if (b === undefined || b.u8(1) !== 2 || b.u16(6) === 0) return null
    return formulaText(b.data.subarray(8, 8 + b.u16(6)), {
      sheetName: (ixti) => this.ctx.sheetName(ixti),
      base: { row: 0, col: 0 },
    })
  }

  data(series: number, brai: Node | undefined, kind: number): RawData | null {
    if (brai === undefined) return null
    const b = brai.b
    const ref = this.ref(brai)
    const cached = this.cache.get(kind)?.get(series)
    if (ref === null && cached === undefined) return null
    let numbers: (number | null)[] | null = null
    let strings: (string | null)[] | null = null
    if (cached !== undefined) {
      const length = Math.max(...cached.keys()) + 1
      const values = Array.from({ length }, (_, i) => cached.get(i) ?? null)
      if (values.some((v) => typeof v === 'string')) {
        strings = values.map((v) => (v === null ? null : String(v)))
      } else numbers = values as (number | null)[]
    }
    return {
      ref,
      strings,
      numbers,
      format: this.ctx.numberFormat(b.u16(4)),
      pointFormats: new Map(),
      missing: NO_POINTS,
    }
  }

  trendline(n: Node, fmt: Formats): RawTrendline {
    const t = child(n, C.SERAUXTREND)!.b
    const intercept = t.f64(2)
    const linear =
      t.u8(0) === 0 &&
      t.u8(1) === 1 &&
      Number.isNaN(intercept) &&
      t.u8(10) === 0 &&
      t.u8(11) === 0 &&
      t.f64(12) === 0 &&
      t.f64(20) === 0
    if (!linear) this.unsupported = true
    const name = child(n, C.SERIESTEXT)
    const own = formats(n.children.find((c) => c.id === C.DATAFORMAT))
    return {
      name: name === undefined ? null : seriesText(name.b),
      box: { fill: null, line: this.line(own.line ?? fmt.line, null), effects: null },
    }
  }
}

/** SeriesText：2 字节保留，其后为 1 字节长度的字符串。 */
function seriesText(b: Bytes): string {
  return readChars(b, 4, b.u8(2), (b.u8(3) & 1) === 1).text
}

/** GelFrame 中的填充类型（OfficeArt 属性 0x0180）；没有该属性时为 0（纯色）。 */
function gelType(b: Bytes): number {
  const count = b.u16(0) >>> 4
  for (let k = 0; k < count && 8 + k * 6 + 6 <= b.length; k++) {
    const p = 8 + k * 6
    if ((b.u16(p) & 0x3fff) === 0x0180) return b.u32(p + 2)
  }
  return 0
}

function fontRun(font: FontStyle): RunSpec {
  const run: {
    -readonly [K in keyof RunSpec]: RunSpec[K]
  } = {
    latin: font.name,
    ea: font.name,
    cs: font.name,
    size: font.size,
    bold: font.bold,
    italic: font.italic,
    underline: UNDERLINES[font.underline] ?? 'none',
    strike: font.strike ? 'sngStrike' : 'noStrike',
    fill: solid(font.color === null ? BLACK : hex(font.color)),
  }
  if (font.vertAlign !== 'baseline') run.baseline = font.vertAlign === 'superscript' ? 30 : -25
  return run
}

/** Text 与 Tick 的 `trot`：0–90 为逆时针角度，91–180 为顺时针 `trot − 90` 度；竖排（255）不旋转。 */
function textRotation(trot: number): number | null {
  if (trot <= 90) return -trot
  if (trot <= 180) return trot - 90
  return null
}

function manual(x: number, y: number, w: number | null, h: number | null): ManualLayout {
  return { target: 'outer', xMode: 'edge', yMode: 'edge', x, y, w, h }
}

/**
 * CrtLayout12 与 CrtLayout12A 的布局：`p` 为四个方式字段（0 自动、1 相对比例、2 边缘位置）的起点，其后为四个比例。
 * 横纵方式为自动时为 `null`。宽高只取比例方式（DrawingML 的 `factor`）。
 */
function layout12(b: Bytes, p: number, inner: boolean): ManualLayout | null {
  const mode = (m: number) => (m === 2 ? 'edge' : 'factor')
  if (b.u16(p) === 0 || b.u16(p + 2) === 0) return null
  return {
    target: inner ? 'inner' : 'outer',
    xMode: mode(b.u16(p)),
    yMode: mode(b.u16(p + 2)),
    x: b.f64(p + 8),
    y: b.f64(p + 16),
    w: b.u16(p + 4) === 1 ? b.f64(p + 24) : null,
    h: b.u16(p + 6) === 1 ? b.f64(p + 32) : null,
  }
}

/**
 * 绘图区的位置（单位为图表区的 1/4000）。CrtLayout12A（Excel 2007 写入，内框或外框的比例）优先；
 * 否则 `fAlwaysAutoPlotArea` 为真时内框取 AxisParent 记录中的矩形，`fManPlotArea` 为真时外框取坐标轴组的 Pos；都不满足时为自动。
 * WPS 实测：xls-689ed697 与 xls-ec56b30b 的散点图内框与 CrtLayout12A 一致、与 Pos 不一致；thu-xls-000 的两个图表中，
 * `fAlwaysAutoPlotArea` 为真的一个内框与 AxisParent 的矩形一致（左右各 1 像素以内），为假的一个与按 Pos 外框排版的结果一致。
 */
function plotLayout(
  top: readonly Node[],
  parent: Node | undefined,
  flags: number,
): ManualLayout | null {
  const a = top.find((n) => n.id === C.CRTLAYOUT12A)?.b
  if (a !== undefined) return layout12(a, 26, (a.u16(16) & 1) !== 0)
  if (flags & 0x10 && parent !== undefined) {
    const b = parent.b
    return {
      ...manual(b.i32(2) / SPRC, b.i32(6) / SPRC, b.i32(10) / SPRC, b.i32(14) / SPRC),
      target: 'inner',
    }
  }
  const pos = child(parent, C.POS)?.b
  if (flags & 0x08 && pos !== undefined) {
    return manual(pos.i16(4) / SPRC, pos.i16(8) / SPRC, pos.i16(12) / SPRC, pos.i16(16) / SPRC)
  }
  return null
}

/** 子流末尾的缓存：SIIndex 的种类（1 为值、2 为分类）→ 系列 → 数据点 → 值。 */
function readCache(nodes: readonly Node[]): Map<number, Map<number, Map<number, number | string>>> {
  const out = new Map<number, Map<number, Map<number, number | string>>>()
  let kind = 0
  for (const n of nodes) {
    if (n.id === C.SIINDEX) {
      kind = n.b.u16(0)
      continue
    }
    if (n.id !== RT.NUMBER && n.id !== RT.LABEL) continue
    let byKind = out.get(kind)
    if (!byKind) {
      byKind = new Map()
      out.set(kind, byKind)
    }
    const series = n.b.u16(2)
    let points = byKind.get(series)
    if (!points) {
      points = new Map()
      byKind.set(series, points)
    }
    points.set(n.b.u16(0), n.id === RT.NUMBER ? n.b.f64(6) : unicodeString(n.b, 6).text)
  }
  return out
}

/** 1 像素的 EMU 数。 */
const EMU_PER_PX = 9525

/**
 * 图表工作表的图表区：Chart 记录的位置与宽高（磅，16.16 定点数）。WPS 实测图表区比记录的宽高各小 1 像素：
 * thu-xls-008「图表3」记录 734.303×449.25 磅，WPS 的图表区为 733.55×448.5 磅，另 3 张同样。没有 Chart 记录时为 `null`。
 */
export function chartsheetAnchor(list: readonly BiffRecord[]): AbsoluteAnchor | null {
  const chart = list.find((r) => r.id === C.CHART)
  if (chart === undefined) return null
  const b = new Bytes(chart.data)
  const emu = (p: number) => (b.i32(p) / 65536) * 12700
  return {
    kind: 'absolute',
    x: emu(0),
    y: emu(4),
    width: Math.max(0, emu(8) - EMU_PER_PX),
    height: Math.max(0, emu(12) - EMU_PER_PX),
  }
}

/** 一个图表子流（BOF 与 EOF 之间的记录）读为规格。 */
export function readBiffChart(list: readonly BiffRecord[], ctx: ChartContext): RawChart {
  const nodes = tree(list)
  const chart = nodes.find((n) => n.id === C.CHART)
  const r = new Reader(
    ctx,
    chart ?? { id: 0, b: new Bytes(new Uint8Array(0)), children: [] },
    readCache(nodes),
  )
  const top = chart?.children ?? []
  if (chart === undefined) r.unsupported = true

  const props = top.find((n) => n.id === C.SHTPROPS)?.b
  const shtFlags = props?.u16(0) ?? 0x02
  const blank = props?.u8(2) ?? 0
  if ((top.find((n) => n.id === C.AXESUSED)?.b.u16(0) ?? 1) > 1) r.unsupported = true
  const parent = top.find((n) => n.id === C.AXISPARENT)
  if (top.some((n) => n.id === C.AXISPARENT && n.b.u16(0) !== 0)) r.unsupported = true

  // 图表组：按出现顺序编号，SerToCrt 引用该序号。
  const crts = (parent?.children ?? []).filter((n) => n.id === C.CHARTFORMAT)
  const seriesNodes = top.filter((n) => n.id === C.SERIES)
  const entries: SeriesEntry[] = seriesNodes.map((node, index) => {
    const parentRef = child(node, C.SERPARENT)
    return {
      index,
      node,
      group: child(node, C.SERTOCRT)?.b.u16(0) ?? -1,
      parent: parentRef === undefined ? null : parentRef.b.u16(0) - 1,
    }
  })
  const labelTexts = top.filter((n) => n.id === C.TEXT && child(n, C.OBJECTLINK)?.b.u16(0) === 4)

  let transposed = false
  const groups: RawGroup[] = crts.map((crt, gi) => {
    const typeNode = crt.children.find((c) =>
      [C.BAR, C.LINE, C.PIE, C.SCATTER, ...UNSUPPORTED_GROUPS].includes(c.id as never),
    )
    if (typeNode === undefined || UNSUPPORTED_GROUPS.has(typeNode.id)) r.unsupported = true
    if (child(crt, C.CHART3D) !== undefined || child(crt, DROPBAR) !== undefined) {
      r.unsupported = true
    }
    const t = typeNode?.b
    let type: PlotType = 'line'
    let direction: RawGroup['direction'] = 'col'
    let grouping: string | null = null
    let gapWidth: number | null = null
    let overlap: number | null = null
    let firstSliceAngle: number | null = null
    let holeSize: number | null = null
    if (typeNode?.id === C.BAR && t) {
      type = 'bar'
      overlap = t.i16(0)
      gapWidth = t.u16(2)
      const f = t.u16(4)
      direction = f & 1 ? 'bar' : 'col'
      transposed = (f & 1) !== 0
      grouping = f & 4 ? 'percentStacked' : f & 2 ? 'stacked' : 'clustered'
    } else if (typeNode?.id === C.LINE && t) {
      const f = t.u16(0)
      grouping = f & 2 ? 'percentStacked' : f & 1 ? 'stacked' : 'standard'
    } else if (typeNode?.id === C.PIE && t) {
      firstSliceAngle = t.u16(0)
      holeSize = t.u16(2) > 0 ? t.u16(2) : null
      type = holeSize === null ? 'pie' : 'doughnut'
    } else if (typeNode?.id === C.SCATTER && t) {
      type = 'scatter'
      if (t.u16(4) & 1) r.unsupported = true
    }
    let dropLines: BoxSpec | null = null
    crt.children.forEach((c, k) => {
      if (c.id !== C.CRTLINE) return
      const id = c.b.u16(0)
      const next = crt.children[k + 1]
      const fmt = next?.id === C.LINEFORMAT ? next.b : undefined
      if (id === 0) dropLines = { fill: null, line: r.line(fmt, null), effects: null }
      else if (id !== 3) r.unsupported = true
    })
    const varied = (crt.b.u16(16) & 1) !== 0
    const pie = type === 'pie' || type === 'doughnut'
    const lineLike = type === 'line' || type === 'scatter'
    const fallback = formats(crt.children.find((c) => c.id === C.DATAFORMAT))
    const members = entries.filter((e) => e.group === gi && e.parent === null)
    const vary = varied && (pie || members.length === 1)
    const series = members.map((e): RawSeries => {
      const node = e.node
      const s = node.b
      const brai = (id: number) => node.children.find((c) => c.id === C.BRAI && c.b.u8(0) === id)
      const nameText = child(node, C.SERIESTEXT)
      const formatsOf = node.children.filter((c) => c.id === C.DATAFORMAT)
      const ownNode = formatsOf.find((c) => c.b.u16(0) === 0xffff)
      const own = formats(ownNode)
      const merged: Formats = { ...fallback, ...own }
      const seriesColor = autoColor(r, e.index, lineLike)
      const line = r.line(merged.line, lineLike ? seriesColor : BLACK)
      const fill = lineLike ? null : r.area(merged.area, merged.gel, seriesColor)
      const points: RawPoint[] = []
      const count = s.u16(6)
      const pointFormats = new Map(
        formatsOf.filter((c) => c.b.u16(0) !== 0xffff).map((c) => [c.b.u16(0), formats(c)]),
      )
      const pointsWanted = vary
        ? Array.from({ length: count }, (_, i) => i)
        : [...pointFormats.keys()].sort((a, b) => a - b)
      for (const i of pointsWanted) {
        const pf: Formats = { ...merged, ...(pointFormats.get(i) ?? {}) }
        const pc = vary ? autoColor(r, i, lineLike) : seriesColor
        points.push({
          index: i,
          box: {
            fill: lineLike ? null : r.area(pf.area, pf.gel, pc),
            line: r.line(pf.line, lineLike ? pc : BLACK),
            effects: null,
          },
          marker: lineLike ? r.marker(pf.marker, pc) : null,
          explosion: pf.pie === undefined ? null : pf.pie.u16(0),
        })
      }
      const labelNodes = labelTexts.filter((n) => child(n, C.OBJECTLINK)?.b.u16(2) === e.index)
      const seriesLabel = labelNodes.find((n) => child(n, C.OBJECTLINK)?.b.u16(4) === 0xffff)
      const pointLabels = new Map<number, RawLabels>()
      for (const n of labelNodes) {
        const point = child(n, C.OBJECTLINK)!.b.u16(4)
        if (point !== 0xffff) pointLabels.set(point, r.labels(n, pointFormats.get(point)?.label))
      }
      const seriesLabels = seriesLabel === undefined ? null : r.labels(seriesLabel, merged.label)
      const labels: RawLabels | null =
        seriesLabels === null && pointLabels.size === 0
          ? null
          : {
              ...(seriesLabels ?? {
                deleted: false,
                showValue: null,
                showCategory: null,
                showSeries: null,
                showPercent: null,
                position: null,
                format: null,
                separator: null,
                box: EMPTY_BOX,
                txPr: null,
                rich: null,
                layout: null,
              }),
              points: pointLabels,
            }
      const trendlines = entries
        .filter((t) => t.parent === e.index)
        .map((t) => {
          if (
            child(t.node, C.SERAUXERRBAR) !== undefined ||
            child(t.node, C.SERAUXTREND) === undefined
          ) {
            r.unsupported = true
          }
          return child(t.node, C.SERAUXTREND) === undefined
            ? { name: null, box: EMPTY_BOX }
            : r.trendline(t.node, fallback)
        })
      return {
        index: e.index,
        order: e.index,
        name: nameText === undefined ? null : seriesText(nameText.b),
        nameRef: r.ref(brai(0)),
        box: { fill, line, effects: null },
        marker: lineLike ? r.marker(merged.marker, seriesColor) : null,
        points,
        labels,
        categories: r.data(e.index, brai(2), 2),
        values: r.data(e.index, brai(1), 1),
        smooth: lineLike ? merged.serFmt !== undefined && (merged.serFmt.u16(0) & 1) !== 0 : null,
        explosion: merged.pie === undefined ? null : merged.pie.u16(0),
        trendlines,
      }
    })
    return {
      type,
      direction,
      grouping,
      varyColors: vary,
      gapWidth,
      overlap,
      series,
      labels: null,
      axes: pie ? [] : [1, 2],
      firstSliceAngle,
      holeSize,
      scatterStyle: null,
      markers: null,
      threeD: false,
      dropLines,
    }
  })
  if (entries.some((e) => e.parent !== null && !entries.some((p) => p.index === e.parent))) {
    r.unsupported = true
  }

  const axes: RawAxis[] = []
  const crossing = new Map<number, { crosses: string | null; crossesAt: number | null }>()
  const axisNodes = (parent?.children ?? []).filter((n) => n.id === C.AXIS)
  for (const a of axisNodes) {
    const wType = a.b.u16(0)
    if (wType > 1) {
      r.unsupported = true
      continue
    }
    const id = wType + 1
    const other = 3 - id
    const value = child(a, C.VALUERANGE)?.b
    const cat = child(a, C.CATSERRANGE)?.b
    const tick = child(a, C.TICK)?.b
    if (tick !== undefined && tick.u8(1) !== 0) r.unsupported = true
    let min: number | null = null
    let max: number | null = null
    let majorUnit: number | null = null
    let orientation: string | null = null
    let crossBetween: string | null = null
    let labelSkip: number | null = null
    if (value !== undefined) {
      const f = value.u16(40)
      if (!(f & 1)) min = value.f64(0)
      if (!(f & 2)) max = value.f64(8)
      if (!(f & 4)) majorUnit = value.f64(16)
      if (f & 0x20) r.unsupported = true
      if (f & 0x40) orientation = 'maxMin'
      crossing.set(other, {
        crosses: f & 0x80 ? 'max' : null,
        crossesAt: f & 0x80 || f & 0x10 ? null : value.f64(32),
      })
    } else if (cat !== undefined) {
      const f = cat.u16(6)
      crossBetween = f & 1 ? 'between' : 'midCat'
      if (f & 4) orientation = 'maxMin'
      if (cat.u16(2) > 1) labelSkip = cat.u16(2)
      crossing.set(other, {
        crosses: f & 2 ? 'max' : null,
        crossesAt: f & 2 || cat.u16(0) <= 1 ? null : cat.u16(0),
      })
    }
    let axisLine: LineSpec | null = { width: 9525, fill: solid(BLACK) }
    let gridlines: BoxSpec | null = null
    a.children.forEach((c, k) => {
      if (c.id !== C.AXISLINE) return
      const next = a.children[k + 1]
      const fmt = next?.id === C.LINEFORMAT ? next.b : undefined
      const kind = c.b.u16(0)
      if (kind === 0) {
        const shown = fmt === undefined || (fmt.u16(8) & 5) !== 0
        axisLine = shown ? r.line(fmt, null) : { fill: NONE }
      } else if (kind === 1) gridlines = { fill: null, line: r.line(fmt, null), effects: null }
      else if (kind === 2) r.unsupported = true
    })
    const fontX = child(a, C.FONTX)
    let run = r.textRun(undefined, fontX)
    if (tick !== undefined && (tick.u16(24) & 1) === 0) run = { ...run, fill: solid(rgb(tick, 4)) }
    const rotation = tick === undefined || tick.u16(24) & 0x20 ? null : textRotation(tick.u16(28))
    const ifmt = child(a, C.IFMT)
    const axc = child(a, C.AXCEXT)?.b
    const titleText = top
      .concat(parent?.children ?? [])
      .find((n) => n.id === C.TEXT && child(n, C.OBJECTLINK)?.b.u16(0) === (wType === 0 ? 3 : 2))
    axes.push({
      id,
      kind: value !== undefined ? 'value' : 'category',
      date: axc !== undefined && (axc.u16(16) & 0x90) === 0x10,
      auto: axc === undefined ? null : (axc.u16(16) & 0x80) !== 0,
      baseTimeUnit: null,
      majorTimeUnit: null,
      crossAx: other,
      title: titleText === undefined ? null : r.title(titleText),
      position: (wType === 0) !== transposed ? 'b' : 'l',
      deleted: false,
      orientation,
      min,
      max,
      majorUnit,
      crosses: null,
      crossesAt: null,
      crossBetween,
      majorGridlines: gridlines,
      majorTickMark: tick === undefined ? null : (TICKS[tick.u8(0)] ?? null),
      tickLabelPosition: tick === undefined ? null : (TICK_LABELS[tick.u8(2)] ?? null),
      format: ifmt === undefined ? null : ctx.numberFormat(ifmt.b.u16(0)),
      sourceLinked: ifmt === undefined,
      box: { fill: null, line: axisLine, effects: null },
      txPr: r.body(run, rotation),
      labelSkip,
    })
  }
  const crossed = axes.map((a) => {
    const c = crossing.get(a.id)
    return c === undefined ? a : { ...a, crosses: c.crosses, crossesAt: c.crossesAt }
  })

  // 绘图区的填充与边框：坐标轴组中 PlotArea 之后的 Frame。
  const parentNodes = parent?.children ?? []
  const plotIndex = parentNodes.findIndex((n) => n.id === C.PLOTAREA)
  const plotFrame = plotIndex < 0 ? undefined : parentNodes[plotIndex + 1]

  const legendNode = crts.map((c) => child(c, C.LEGEND)).find((l) => l !== undefined)
  let legend: RawChart['legend'] = null
  if (legendNode !== undefined) {
    const l = legendNode.b
    const frame = child(legendNode, C.FRAME)
    const legendLayout = child(legendNode, C.CRTLAYOUT12)?.b
    const text = child(legendNode, C.TEXT)
    legend = {
      position: LEGEND_POSITIONS[l.u8(16)] ?? 'r',
      overlay: false,
      layout:
        l.u16(18) & 1
          ? null
          : legendLayout
            ? layout12(legendLayout, 18, false)
            : manual(l.i32(0) / SPRC, l.i32(4) / SPRC, null, null),
      box:
        frame === undefined
          ? {
              fill: solid(hex('#ffffff')),
              line: { width: 9525, fill: solid(BLACK) },
              effects: null,
            }
          : r.box(frame),
      txPr: r.body(r.textRun(text, undefined), null),
      hidden: [],
    }
  }

  const titleNode = top.find((n) => n.id === C.TEXT && child(n, C.OBJECTLINK)?.b.u16(0) === 1)
  return {
    date1904: ctx.date1904,
    roundedCorners: false,
    title: titleNode === undefined ? null : r.title(titleNode),
    autoTitleDeleted: null,
    plotLayout: plotLayout(top, parent, shtFlags),
    plotBox:
      plotFrame?.id === C.FRAME
        ? r.box(plotFrame)
        : { fill: NONE, line: { fill: NONE }, effects: null },
    groups,
    axes: crossed,
    legend,
    view3D: null,
    blanks: blank === 1 ? 'zero' : blank === 2 ? 'span' : 'gap',
    visibleOnly: (shtFlags & 0x02) !== 0,
    box: r.box(top.find((n) => n.id === C.FRAME)),
    txPr: null,
    unsupported: r.unsupported,
  }
}

/** 系列（或数据点）的自动颜色：线条类取调色板第 32 起，填充类取第 24 起，循环 8 色。 */
function autoColor(r: Reader, index: number, line: boolean): ColorSpec {
  return r.color((line ? 32 : 24) + (index % 8))
}
