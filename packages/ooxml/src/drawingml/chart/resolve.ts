/**
 * 图表求值：把 `RawChart` 解决为 `Chart`。缺省值按 WPS 对未写出属性的显示（校准文件实测）。
 *
 * - 自动颜色：第 i 个系列（`varyColors` 为真时为第 i 个数据点）取 `accent((i mod 6) + 1)`；系列数超过 6 时按轮次变化：
 *   共 n 轮时第 k 轮的系数 f = (k + 1) / (n + 1) × 1.4 − 0.7，f < 0 时施加 `shade(1 + f)`，f > 0 时施加 `tint(1 − f)`
 *   （实测 8 个系列：首轮为 shade 76%，次轮为 tint 77%）。
 * - 未写出 `spPr` 的元素：图表区白色（WPS 表格中另有 0.75 磅、`tx1` tint 75% 的边框，WPS 演示没有）；绘图区无填充无边框；坐标轴线与网格线为
 *   0.75 磅、`tx1` tint 75%；折线为 1.5 磅；标记为 5 磅，符号按系列依次取 `MARKER_SYMBOLS`，填充与线条为系列颜色。
 * - 文字样式链：元素自身的 `c:rich` 字段与段落属性 → 元素的 `c:txPr` → 图表区的 `c:txPr` → 缺省值
 *   （字号 10 磅、`tx1`、主题正文字体；图表标题 18 磅粗体）。
 * - 数据标签：系列的 `dLbls` 逐项覆盖图表组的 `dLbls`；`dLbl` 覆盖单个点。未写出的显示项为假。
 * - 标题：只在有 `c:title` 时显示；`c:title` 没有文字时，只有一个系列的图表取系列名，其余取「图表标题」。
 *   坐标轴标题没有文字时为「坐标轴标题」，缺省为 10 磅粗体。
 * - 数据标签的文字样式只取系列与数据点自身的 `txPr`，图表组 `dLbls` 的 `txPr` 不生效；显示项按上一条逐项覆盖。
 * - 数据：有工作簿（`ChartScope.cells`）时系列名、分类与值按引用从单元格取（WPS 表格不用缓存值），
 *   引用无法解析时用缓存值；没有工作簿时只用缓存值。
 */

import { formatNumber, plainText } from '../../numfmt/format.ts'
import type { ColorContext, ColorSpec, ColorTransform, SchemeColorName } from '../color.ts'
import {
  type FillSpec,
  type LineSpec,
  mergeLine,
  resolveFill,
  resolveLine,
  type ShapeFill,
} from '../fill.ts'
import { collectTextFonts } from '../text/fonts.ts'
import type { RunStyle, TextBody } from '../text/model.ts'
import type { ListStyleSpec, ParagraphSpec, RawTextBody, RunSpec } from '../text/read.ts'
import { resolveTextBody } from '../text/resolve.ts'
import type { Theme } from '../theme.ts'
import type {
  Axis,
  Chart,
  ChartBox,
  ChartTitle,
  DataLabels,
  DataPoint,
  Legend,
  Marker,
  PlotGroup,
  Series,
  TextStyle,
} from './model.ts'
import type {
  BoxSpec,
  RawAxis,
  RawChart,
  RawData,
  RawGroup,
  RawLabels,
  RawMarker,
  RawSeries,
  RawTitle,
} from './read.ts'

/** 引用单元格的一个值；`format` 为单元格的数字格式代码。 */
export type CellDatum =
  | { readonly kind: 'number'; readonly value: number; readonly format: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'error'; readonly text: string }
  | { readonly kind: 'empty' }

/**
 * 工作簿单元格：系列引用（`c:f`）按引用顺序的取值。引用无法在本工作簿中解析时（外部工作簿、名称、二维区域）
 * 返回 `null`，该项改用缓存值。`visibleOnly` 为真时略去隐藏行列中的单元格。
 */
export interface ChartCells {
  read(ref: string, visibleOnly: boolean): readonly CellDatum[] | null
}

export interface ChartScope {
  readonly theme: Theme
  readonly colors: ColorContext
  /** 图表所在的应用：`sheet` 为 WPS 表格，`slide` 为 WPS 演示（文字文档中的图表按 `slide`）。 */
  readonly host: Chart['host']
  /** 图表数据所在的工作簿；PPT 与文字文档中的图表为 `null`，只用缓存值。 */
  readonly cells: ChartCells | null
}

const MARKER_SYMBOLS = [
  'diamond',
  'square',
  'triangle',
  'x',
  'star',
  'circle',
  'plus',
  'dash',
  'dot',
]
const NONE: ShapeFill = { kind: 'none' }
const DEFAULT_TITLE = '图表标题'
const DEFAULT_AXIS_TITLE = '坐标轴标题'

function scheme(name: SchemeColorName, transforms: readonly ColorTransform[] = []): ColorSpec {
  return { kind: 'scheme', name, transforms }
}

function solid(color: ColorSpec): FillSpec {
  return { kind: 'solid', color }
}

const AXIS_LINE: LineSpec = {
  width: 9525,
  fill: solid(scheme('tx1', [{ name: 'tint', value: 0.75 }])),
}

/** 图表文字的字段默认样式：主题正文字体、`tx1`。 */
const CHART_FONT: RunSpec = {
  latin: '+mn-lt',
  ea: '+mn-ea',
  cs: '+mn-cs',
  fill: solid(scheme('tx1')),
  size: 10,
}

const SERIES_LINE_WIDTH = 19050
const MARKER_SIZE = 5

/** 自动颜色：见文件头。`count` 为参与配色的系列数（或数据点数）。 */
export function autoColor(index: number, count: number): ColorSpec {
  const accent = `accent${(index % 6) + 1}` as SchemeColorName
  const cycles = Math.max(1, Math.ceil(count / 6))
  const cycle = Math.floor(index / 6)
  const f = ((cycle + 1) / (cycles + 1)) * 1.4 - 0.7
  if (Math.abs(f) < 1e-9) return scheme(accent)
  return scheme(accent, [f < 0 ? { name: 'shade', value: 1 + f } : { name: 'tint', value: 1 - f }])
}

class Resolver {
  private readonly chartLevels: ListStyleSpec | null

  constructor(
    private readonly raw: RawChart,
    private readonly scope: ChartScope,
  ) {
    this.chartLevels = levels(raw.txPr)
  }

  fill(spec: FillSpec | null, fallback: FillSpec | null): ShapeFill {
    const s = spec ?? fallback
    if (s === null) return NONE
    const f = resolveFill(s, this.scope.colors)
    return f.kind === 'group' ? NONE : f
  }

  /** 线条：`spec` 的字段覆盖 `fallback`；`spec` 未出现时取 `fallback`，两者都没有时无线条。 */
  line(spec: LineSpec | null, fallback: LineSpec | null): ReturnType<typeof resolveLine> {
    if (spec === null && fallback === null) return null
    const merged = fallback === null ? (spec ?? {}) : mergeLine(fallback, spec ?? {})
    return resolveLine(merged, this.scope.colors)
  }

  box(spec: BoxSpec, fill: FillSpec | null, line: LineSpec | null): ChartBox {
    return { fill: this.fill(spec.fill, fill), line: this.line(spec.line, line) }
  }

  /** 单段文字的样式：`defaults` 为缺省字段属性。 */
  text(txPr: RawTextBody | null, defaults: RunSpec): TextStyle {
    const body: RawTextBody = {
      body: txPr?.body ?? {},
      listStyle: null,
      paragraphs: [
        {
          level: 0,
          props: {},
          runs: [{ kind: 'text', text: '', props: {}, link: null }],
          end: null,
        },
      ],
    }
    const resolved = resolveTextBody(body, this.textScope(txPr, defaults))
    const p = resolved.paragraphs[0]
    const run = p?.runs[0]
    const rotation = txPr?.body.rotation
    return {
      run: run !== undefined && run.kind !== 'break' ? run.style : (p?.end ?? EMPTY_RUN),
      // `rot="-60000000"`（−1000°）表示自动。
      rotation: rotation === undefined || rotation <= -1000 ? null : rotation,
    }
  }

  textScope(txPr: RawTextBody | null, defaults: RunSpec) {
    return {
      theme: this.scope.theme,
      colors: this.scope.colors,
      listStyles: [
        levels(txPr),
        this.chartLevels,
        { levels: [{ run: { ...CHART_FONT, ...defaults } }, ...EMPTY_LEVELS] },
      ],
      bodies: [],
    }
  }

  title(raw: RawTitle, defaults: RunSpec, auto: string): ChartTitle {
    const scope = this.textScope(raw.txPr, defaults)
    let text: TextBody
    if (raw.rich !== null) text = resolveTextBody(raw.rich, scope)
    else {
      const body: RawTextBody = {
        body: raw.txPr?.body ?? {},
        listStyle: null,
        paragraphs: [
          {
            level: 0,
            props: {},
            runs: [{ kind: 'text', text: raw.text ?? auto, props: {}, link: null }],
            end: null,
          },
        ],
      }
      text = resolveTextBody(body, scope)
    }
    return { text, overlay: raw.overlay, layout: raw.layout, box: this.box(raw.box, null, null) }
  }

  marker(raw: RawMarker | null, auto: string | null, color: ColorSpec): Marker | null {
    const symbol = raw?.symbol ?? auto
    if (symbol === null || symbol === 'none') return null
    const box = raw?.box ?? { fill: null, line: null, effects: null }
    return {
      symbol,
      size: raw?.size ?? MARKER_SIZE,
      box: this.box(box, solid(color), { width: 9525, fill: solid(color) }),
    }
  }

  labels(
    group: RawLabels | null,
    own: RawLabels | null,
    defaultPosition: string,
  ): DataLabels | null {
    const chain = [own, group].filter((l): l is RawLabels => l !== null)
    if (chain.length === 0) return null
    if (chain[0]!.deleted) return null
    return this.labelsFrom(chain, own === null ? 0 : 1, defaultPosition)
  }

  /** `chain` 自高到低；前 `own` 项为系列与数据点自身的标签，其余为图表组的。 */
  labelsFrom(chain: readonly RawLabels[], own: number, defaultPosition: string): DataLabels | null {
    const pick = <K extends keyof RawLabels>(k: K): RawLabels[K] | null => {
      for (const l of chain) if (l[k] !== null) return l[k]
      return null
    }
    const showValue = pick('showValue') === true
    const showCategory = pick('showCategory') === true
    const showSeries = pick('showSeries') === true
    const showPercent = pick('showPercent') === true
    if (!showValue && !showCategory && !showSeries && !showPercent) return null
    // 图表组 `dLbls` 的 `txPr` 与 `spPr` 不生效（WPS 实测），只取系列与数据点自身的。
    let txPr: RawTextBody | null = null
    let box: BoxSpec = { fill: null, line: null, effects: null }
    for (const l of chain.slice(0, own)) {
      txPr ??= l.txPr
      if (box.fill === null && box.line === null) box = l.box
    }
    return {
      showValue,
      showCategory,
      showSeries,
      showPercent,
      position: pick('position') ?? defaultPosition,
      format: pick('format') as string | null,
      separator: (pick('separator') as string | null) ?? ', ',
      text: this.text(txPr, { size: 10 }),
      box: this.box(box, null, null),
    }
  }

  categories(data: RawData | null, length: number): string[] {
    const out: string[] = []
    if (data?.strings) {
      for (let i = 0; i < length; i++) out.push(data.strings[i] ?? '')
      return out
    }
    if (data?.numbers) {
      for (let i = 0; i < length; i++) {
        const v = data.numbers[i]
        out.push(
          v === null || v === undefined
            ? ''
            : this.format(v, data.pointFormats.get(i) ?? data.format),
        )
      }
      return out
    }
    for (let i = 0; i < length; i++) out.push(String(i + 1))
    return out
  }

  format(value: number, code: string): string {
    return plainText(formatNumber(value, code, { date1904: this.raw.date1904, palette: [] }))
  }

  /** 系列的数据来源：引用能从单元格取值时按单元格，否则为缓存。 */
  sourced(s: RawSeries): RawSeries {
    const cells = this.scope.cells
    if (cells === null) return s
    const read = (d: RawData | null): RawData | null => {
      const list = d?.ref == null ? null : cells.read(d.ref, this.raw.visibleOnly)
      return list === null ? d : this.fromCells(d!.ref, list)
    }
    const names = s.nameRef === null ? null : cells.read(s.nameRef, false)
    return {
      ...s,
      name: names === null ? s.name : names.map((c) => this.cellText(c) ?? '').join(' '),
      categories: read(s.categories),
      values: read(s.values),
    }
  }

  cellText(c: CellDatum): string | null {
    if (c.kind === 'number') return this.format(c.value, c.format)
    if (c.kind === 'boolean') return c.value ? 'TRUE' : 'FALSE'
    return c.kind === 'empty' ? null : c.text
  }

  /**
   * 单元格取值换为数据：数值数据中逻辑值计 1 与 0，文字与 `#N/A` 以外的错误值计 0，`#N/A` 不绘制（记入 `missing`），
   * 空单元格为空点（WPS 实测）；含数值以外的值时另有按单元格格式显示的文字数据，供分类使用。
   */
  fromCells(ref: string | null, list: readonly CellDatum[]): RawData {
    const numbers: (number | null)[] = []
    const pointFormats = new Map<number, string>()
    const missing = new Set<number>()
    let format: string | null = null
    let numeric = true
    list.forEach((c, i) => {
      if (c.kind === 'number') {
        numbers.push(c.value)
        pointFormats.set(i, c.format)
        format ??= c.format
        return
      }
      if (c.kind === 'empty') {
        numbers.push(null)
        return
      }
      numeric = false
      if (c.kind === 'boolean') numbers.push(c.value ? 1 : 0)
      else if (c.kind === 'error' && c.text === '#N/A') {
        missing.add(i)
        numbers.push(null)
      } else numbers.push(0)
    })
    return {
      ref,
      strings: numeric ? null : list.map((c) => this.cellText(c)),
      numbers,
      format: format ?? 'General',
      pointFormats,
      missing,
    }
  }

  series(g: RawGroup, s: RawSeries, count: number, pointCount: number): Series {
    const values = s.values?.numbers ?? s.values?.strings?.map(() => null) ?? []
    const length = Math.max(values.length, categoryLength(s.categories))
    const color = autoColor(s.index, count)
    const line = g.type === 'line' || g.type === 'scatter'
    const autoLines =
      g.type === 'line' ||
      (g.type === 'scatter' && g.scatterStyle !== 'marker' && g.scatterStyle !== 'none')
    const lineSpec: LineSpec | null = line
      ? autoLines
        ? { width: SERIES_LINE_WIDTH, cap: 'rnd', join: 'round', fill: solid(color) }
        : null
      : null
    const box: ChartBox = {
      fill: line ? NONE : this.fill(s.box.fill, g.varyColors && isPie(g) ? null : solid(color)),
      line: this.line(s.box.line, lineSpec),
    }
    const autoMarker =
      line && g.markers !== false && !(g.type === 'scatter' && g.scatterStyle === 'line')
        ? MARKER_SYMBOLS[s.index % MARKER_SYMBOLS.length]!
        : null
    const marker = line ? this.marker(s.marker, autoMarker, color) : null
    const points: DataPoint[] = []
    const vary = g.varyColors && (isPie(g) || g.series.length === 1)
    const own = new Map(s.points.map((p) => [p.index, p]))
    if (vary || own.size > 0) {
      for (let i = 0; i < length; i++) {
        const p = own.get(i)
        if (!vary && p === undefined) continue
        const pc = vary ? autoColor(i, pointCount) : color
        const fallbackFill = line ? null : solid(pc)
        const fallbackLine = isPie(g) ? null : line ? lineSpec : null
        const pbox = p?.box ?? { fill: null, line: null, effects: null }
        points.push({
          index: i,
          box: {
            fill: line
              ? NONE
              : this.fill(pbox.fill ?? (vary ? null : s.box.fill), fallbackFill ?? null),
            line: this.line(pbox.line ?? (vary ? null : s.box.line), fallbackLine),
          },
          marker: line ? this.marker(p?.marker ?? s.marker, autoMarker, pc) : null,
          explosion: (p?.explosion ?? s.explosion ?? 0) / 100,
        })
      }
    }
    const defaultPosition = labelPosition(g)
    const pointLabels = new Map<number, DataLabels | null>()
    for (const [index, l] of s.labels?.points ?? []) {
      const chain = [l, s.labels, g.labels].filter((v): v is RawLabels => v !== null)
      const own = s.labels === null ? 1 : 2
      pointLabels.set(index, l.deleted ? null : this.labelsFrom(chain, own, defaultPosition))
    }
    return {
      index: s.index,
      name: s.name ?? `系列${s.index + 1}`,
      categories: this.categories(s.categories, length),
      values: Array.from({ length }, (_, i) => values[i] ?? null),
      xValues: s.categories?.numbers && !s.categories.strings ? s.categories.numbers : null,
      categoryFormat: s.categories?.format ?? 'General',
      missing: s.values?.missing ?? NO_POINTS,
      format: s.values?.format ?? 'General',
      box,
      marker,
      smooth: s.smooth ?? false,
      points,
      pointLabels,
      labels: this.labels(g.labels, s.labels, defaultPosition),
      explosion: (s.explosion ?? 0) / 100,
    }
  }

  group(source: RawGroup): PlotGroup {
    const g: RawGroup = { ...source, series: source.series.map((s) => this.sourced(s)) }
    const count = g.series.length
    const pointCount = Math.max(0, ...g.series.map((s) => s.values?.numbers?.length ?? 0))
    const grouping = (g.grouping ??
      (g.type === 'bar' ? 'clustered' : 'standard')) as PlotGroup['grouping']
    const stacked = grouping === 'stacked' || grouping === 'percentStacked'
    return {
      type: g.type,
      direction: g.direction,
      grouping,
      varyColors: g.varyColors ?? false,
      gapWidth: g.gapWidth ?? 150,
      overlap: g.overlap ?? (stacked ? 100 : 0),
      series: g.series.map((s) => this.series(g, s, count, pointCount)),
      axes: g.axes,
      firstSliceAngle: g.firstSliceAngle ?? 0,
      holeSize: g.holeSize ?? 50,
      lines: g.type === 'line' || (g.scatterStyle !== 'marker' && g.scatterStyle !== 'none'),
      threeD: g.threeD,
    }
  }

  axis(a: RawAxis, scatter: boolean): Axis {
    const tick = (v: string | null): Axis['majorTickMark'] =>
      v === 'none' || v === 'in' || v === 'cross' ? v : 'out'
    const position =
      a.position === 'l' || a.position === 'r' || a.position === 't' ? a.position : 'b'
    const crosses: Axis['crosses'] =
      a.crossesAt !== null
        ? a.crossesAt
        : a.crosses === 'min' || a.crosses === 'max'
          ? a.crosses
          : 'autoZero'
    const label = a.tickLabelPosition
    const unit = (v: string | null) => (v === 'days' || v === 'months' || v === 'years' ? v : null)
    const titleRotation = a.title?.rich?.body.rotation ?? a.title?.txPr?.body.rotation
    return {
      id: a.id,
      kind: a.kind,
      crossAx: a.crossAx,
      date:
        a.kind === 'category' && (a.date || a.auto === true)
          ? {
              forced: a.date && a.auto !== true,
              base: unit(a.baseTimeUnit),
              majorTimeUnit: unit(a.majorTimeUnit),
            }
          : null,
      title:
        a.title === null ? null : this.title(a.title, { size: 10, bold: true }, DEFAULT_AXIS_TITLE),
      titleRotation: titleRotation === undefined || titleRotation <= -1000 ? null : titleRotation,
      position,
      deleted: a.deleted,
      reversed: a.orientation === 'maxMin',
      min: a.min,
      max: a.max,
      majorUnit: a.majorUnit !== null && a.majorUnit > 0 ? a.majorUnit : null,
      crosses,
      crossBetween:
        a.crossBetween === 'midCat' || (a.crossBetween === null && scatter) ? 'midCat' : 'between',
      majorGridlines:
        a.majorGridlines === null ? null : this.line(a.majorGridlines.line, AXIS_LINE),
      majorTickMark: tick(a.majorTickMark),
      tickLabelPosition: label === 'low' || label === 'high' || label === 'none' ? label : 'nextTo',
      format: a.sourceLinked || a.format === null ? null : a.format,
      line: this.line(a.box.line, AXIS_LINE),
      text: this.text(a.txPr, { size: 10 }),
      labelSkip: a.labelSkip !== null && a.labelSkip >= 1 ? Math.floor(a.labelSkip) : null,
    }
  }

  legend(): Legend | null {
    const l = this.raw.legend
    if (l === null) return null
    const p = l.position
    return {
      position: p === 'b' || p === 't' || p === 'l' || p === 'tr' ? p : 'r',
      overlay: l.overlay,
      layout: l.layout,
      text: this.text(l.txPr, { size: 10 }),
      box: this.box(l.box, null, null),
      hidden: l.hidden,
    }
  }

  chart(): Chart {
    const raw = this.raw
    const groups = raw.groups.map((g) => this.group(g))
    const scatter = groups.some((g) => g.type === 'scatter')
    const allSeries = groups.flatMap((g) => g.series)
    const auto = allSeries.length === 1 ? allSeries[0]!.name : DEFAULT_TITLE
    // 没有 `c:title` 时不显示标题，`autoTitleDeleted` 为假也一样（WPS 实测）。
    const title = raw.title === null ? null : this.title(raw.title, { size: 18, bold: true }, auto)
    return {
      box: this.box(raw.box, solid(scheme('bg1')), this.scope.host === 'sheet' ? AXIS_LINE : null),
      host: this.scope.host,
      roundedCorners: raw.roundedCorners ?? false,
      title,
      plot: {
        layout: raw.plotLayout,
        box: this.box(raw.plotBox, null, null),
        groups,
        axes: raw.axes.map((a) => this.axis(a, scatter)),
      },
      legend: this.legend(),
      blanks: raw.blanks === 'zero' || raw.blanks === 'span' ? raw.blanks : 'gap',
      date1904: raw.date1904,
      // 未写出的项取架构缺省值；`rAngAx` 未写出时按透视。
      view3D:
        raw.view3D === null
          ? null
          : {
              rotX: raw.view3D.rotX ?? 0,
              rotY: raw.view3D.rotY ?? 0,
              perspective: raw.view3D.perspective ?? 30,
              rightAngle: raw.view3D.rightAngle ?? false,
              heightPercent: raw.view3D.heightPercent ?? 100,
            },
    }
  }
}

const NO_POINTS: ReadonlySet<number> = new Set()

const EMPTY_LEVELS: (ParagraphSpec | null)[] = Array.from({ length: 8 }, () => null)

const EMPTY_RUN: RunStyle = {
  latin: '',
  ea: '',
  cs: '',
  sym: '',
  size: 10,
  bold: false,
  italic: false,
  underline: 'none',
  strike: 'noStrike',
  baseline: 0,
  caps: 'none',
  spacing: 0,
  kern: 0,
  fill: NONE,
  highlight: null,
  outline: null,
  effects: [],
  lang: '',
}

/** `txPr` 首段的段落属性作为列表样式的第一层：其 `defRPr` 是该元素文字的缺省字段属性。 */
function levels(txPr: RawTextBody | null): ListStyleSpec | null {
  const first = txPr?.paragraphs[0]
  if (first === undefined) return null
  return { levels: [first.props, ...EMPTY_LEVELS] }
}

function categoryLength(d: RawData | null): number {
  return d?.strings?.length ?? d?.numbers?.length ?? 0
}

function isPie(g: { type: string }): boolean {
  return g.type === 'pie' || g.type === 'doughnut'
}

/** 未写出 `dLblPos` 时的标签位置。 */
function labelPosition(g: RawGroup): string {
  if (isPie(g)) return 'bestFit'
  if (g.type === 'bar')
    return g.grouping === 'stacked' || g.grouping === 'percentStacked' ? 'ctr' : 'outEnd'
  return 'r'
}

/** 含未实现的内容时返回 `null`，调用方计入未显示的图表。 */
export function resolveChart(raw: RawChart, scope: ChartScope): Chart | null {
  if (raw.unsupported) return null
  return new Resolver(raw, scope).chart()
}

function addRun(out: Set<string>, s: RunStyle): void {
  for (const name of [s.latin, s.ea, s.cs, s.sym]) if (name !== '') out.add(name)
}

/** 图表用到的字体名加入 `out`：标题、坐标轴与坐标轴标题、图例与数据标签的字体，不含空串。 */
export function collectChartFonts(out: Set<string>, chart: Chart): void {
  if (chart.title !== null) collectTextFonts(out, chart.title.text)
  for (const a of chart.plot.axes) {
    addRun(out, a.text.run)
    if (a.title !== null) collectTextFonts(out, a.title.text)
  }
  if (chart.legend !== null) addRun(out, chart.legend.text.run)
  for (const g of chart.plot.groups) {
    for (const s of g.series) {
      if (s.labels !== null) addRun(out, s.labels.text.run)
      for (const l of s.pointLabels.values()) if (l !== null) addRun(out, l.text.run)
    }
  }
}
