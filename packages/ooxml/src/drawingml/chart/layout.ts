/**
 * 图表布局：标题、图例、绘图区与坐标轴的位置，刻度范围与标签。单位为 96 dpi 像素，原点为图表区左上角。
 *
 * 规则取自 WPS 对照图（校准文件实测；f 为相关文字的字号换算的像素数）：
 * - 图表区四边留白 `PAD`。标题框顶在留白处、水平居中，标题框底与下一元素相距 `TITLE_GAP`。
 * - 绘图区内框（坐标轴围成的矩形）：上沿在外沿之下 max(4.91, 0.6f − 3.15)（f 为数值轴标签字号）；
 *   下沿留出分类标签：标签框顶距坐标轴线 0.943f − 2.35，旋转的标签按旋转后的高度计；右沿在外沿之内 `RIGHT_EXTRA`，
 *   水平数值轴另保证末个标签的一半落在留白之内（再向外 2.4）；左沿留出数值轴标签，标签右对齐，距内框 0.92f − 3。
 *   坐标轴跨越另一条数值轴的内部（如数据有负值、轴在 0 处）且标签为 `nextTo` 时，标签随轴线位于内框内部，不另留空间（`low`、`high` 的标签在内框边缘，照常留出）。
 * - 数值轴区间数上限：竖直轴为 ⌊轴长 / (1.4f − 3.1)⌋（WPS 表格为 ⌊轴长 / (1.4f − 0.8)⌋，只核对过 9 磅），
 *   水平轴为 ⌊轴长 / (最宽标签 / 2 + 2.5f)⌋，且都不超过 10。
 * - 分类标签：最宽标签不超过分类宽度时不旋转；否则 −45°（文字框右上角对齐分类中心），旋转后仍超过时 −90°
 *   （文字框右端中点对齐分类中心）。
 *   `bodyPr/@rot` 为具体角度（含 0）时按该角度，不自动旋转。
 * - 图例：符号边长 0.63f，折线符号长 2.2f，符号与文字间隔 0.42f，横排条目间隔 0.3f，竖排行距 0.33f，框内边距 0.37f − 1.9。
 *   底部图例框底在留白处，框顶与分类标签相距 11.4；右侧图例框右沿在留白处，在标题以下的高度内竖直居中，
 *   与绘图区外沿相距 12.3；顶部图例与绘图区外沿相距 1.67f − 7.1。含折线条目的图例中条形的符号与折线符号同宽。
 * - 坐标轴按交叉位置分在绘图区四侧（`crosses` 为 `max` 时在右侧或上方，次坐标轴通常如此），各侧分别留出标签；
 *   右侧标签左对齐，距内框 0.92f − 3。
 * - 坐标轴标题在标签外侧，沿绘图区居中；竖直坐标轴的标题缺省旋转 −90°。
 * - 日期轴（见 `date-axis.ts`）的标签：最宽标签 + `DATE_LABEL_GAP` 不超过标签间距时不旋转，间距不小于
 *   `DATE_DIAGONAL` × 行高时 −45°，否则 −90°。
 */

import { formatNumber, plainText } from '../../numfmt/format.ts'
import type { BodyLayout, TextSettings } from '../text/body.ts'
import { layoutBody } from '../text/body.ts'
import type { Paragraph, Run, RunStyle, TextBody } from '../text/model.ts'
import {
  autoBase,
  autoStep,
  type DateScale,
  type DateStep,
  dateLabels,
  dateScale,
  isDateFormat,
} from './date-axis.ts'
import type { Axis, Chart, DataLabels, Legend, PlotGroup, Series, TextStyle } from './model.ts'
import { clean, type Scale, ticks, valueScale } from './scale.ts'

const PX_PER_PT = 4 / 3
const PAD = 9.25
const RIGHT_EXTRA = 6.05
const TITLE_GAP = 13.54
/** 内框上沿在外沿之下的最小距离。 */
const TOP_OFFSET = 4.91
/** 没有底部标签时内框下沿在外沿之上的距离。 */
const BOTTOM_OFFSET = 5.91
const LEGEND_BOTTOM_GAP = 11.4
const LEGEND_SIDE_GAP = 12.3
/** 标题与顶部图例之间的间距。 */
const TITLE_LEGEND_GAP = 11.36
const MAX_INTERVALS = 10
const SQRT1_2 = Math.SQRT1_2
/** 右侧标签的外缘与外沿之间另留的距离。 */
const RIGHT_LABEL_EXTRA = 1.25
/** 竖直坐标轴标题的外接框与外沿、与标签之间的距离。 */
const TITLE_EDGE = 6.3
const TITLE_LABEL_GAP = 6
/** 水平坐标轴标题的外接框与外沿、与标签之间的距离；外沿为图表区留白（下方没有图例）时另加 `TITLE_EDGE_BARE`。 */
const TITLE_EDGE_H = 6.3
const TITLE_EDGE_BARE = 1.3
const TITLE_LABEL_GAP_H = 5
/** 日期轴自动主要单位：相邻标签间距不小于行高 + `DATE_FIT`。 */
const DATE_FIT = 2.5
const DATE_LABEL_GAP = 3
const DATE_DIAGONAL = 1.78
/** 旋转的首个分类标签与外沿之间至少留出的距离。 */
const ROTATED_MARGIN = 5.5

type Side = 'l' | 'r' | 't' | 'b'

/** 图表区尺寸；`bare` 为下方没有图例时水平坐标轴标题另留的距离。 */
interface Size {
  readonly width: number
  readonly height: number
  readonly bare: number
}

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 已排版的一段文字：`x`、`y` 为文字框左上角（旋转前），`rotation` 绕文字框左上角顺时针（度）。 */
export interface PlacedText {
  readonly layout: BodyLayout
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation: number
}

export interface TickLabel extends PlacedText {
  readonly text: string
}

export interface AxisLayout {
  readonly axis: Axis
  /** 水平轴（沿 x 方向）。 */
  readonly horizontal: boolean
  /** 数值轴的刻度；分类轴为 `null`。 */
  readonly scale: Scale | null
  /** 刻度线位置（沿轴方向的像素坐标）。 */
  readonly ticks: readonly number[]
  /** 坐标轴线所在的位置（垂直于轴方向的像素坐标）。 */
  readonly at: number
  readonly labels: readonly TickLabel[]
  /** 分类轴的分类数（日期轴为单位数）；数值轴为 0。 */
  readonly slots: number
  /** 日期轴的排列；其余为 `null`。 */
  readonly date: DateScale | null
  readonly title: PlacedText | null
}

export interface LegendEntry {
  readonly series: Series
  /** 饼图与按点着色的图表：数据点下标；否则为 `null`。 */
  readonly point: number | null
  readonly group: PlotGroup
  /** 图例符号框。 */
  readonly symbol: Rect
  readonly text: PlacedText
}

export interface ChartLayout {
  readonly width: number
  readonly height: number
  readonly title: PlacedText | null
  readonly legend: { readonly box: Rect; readonly entries: readonly LegendEntry[] } | null
  /** 绘图区：有坐标轴时为内框，饼图为外框。 */
  readonly plot: Rect
  readonly axes: readonly AxisLayout[]
}

interface Measured {
  readonly layout: BodyLayout
  readonly width: number
  readonly height: number
}

// ── 文字 ──

const BODY = {
  rotation: 0,
  vertical: 'horz',
  wrap: false,
  insetLeft: 0,
  insetTop: 0,
  insetRight: 0,
  insetBottom: 0,
  anchor: 't',
  anchorCenter: false,
  columns: 1,
  columnSpacing: 0,
  rtlColumns: false,
  upright: false,
  autofit: { kind: 'none' },
} as const

function paragraph(text: string, run: RunStyle, align: string): Paragraph {
  const runs: Run[] = []
  text.split('\n').forEach((line, i) => {
    if (i > 0) runs.push({ kind: 'break', style: run })
    if (line !== '') runs.push({ kind: 'text', text: line, style: run, link: null })
  })
  return {
    level: 0,
    align,
    marginLeft: 0,
    marginRight: 0,
    indent: 0,
    rtl: false,
    defaultTabSize: 914400,
    tabs: [],
    lineSpacing: { unit: 'percent', value: 1 },
    spaceBefore: { unit: 'points', value: 0 },
    spaceAfter: { unit: 'points', value: 0 },
    eaLineBreak: true,
    latinLineBreak: false,
    hangingPunctuation: false,
    fontAlign: 'auto',
    bullet: { kind: 'none' },
    runs,
    end: run,
  }
}

/** 单段文字的文本框；`align` 为多行时各行的对齐（`l`、`ctr`、`r`）。 */
export function labelBody(text: string, run: RunStyle, align = 'ctr'): TextBody {
  return { body: BODY, paragraphs: [paragraph(text, run, align)] }
}

function extent(layout: BodyLayout): number {
  let right = 0
  for (const p of layout.paragraphs) {
    p.block.lines.forEach((l, i) => {
      right = Math.max(right, p.x + l.left + l.width + (p.shifts[i] ?? 0))
    })
  }
  return right
}

/**
 * 排版文字，返回像素尺寸。`wrapWidth` 为像素，`null` 为不断行：先按左对齐求出最宽行，
 * 再以该宽度为文本区域排版，使多行文字按段落的对齐方式在框内对齐。
 */
export function measure(
  body: TextBody,
  settings: TextSettings,
  wrapWidth: number | null = null,
): Measured {
  if (wrapWidth !== null) {
    const layout = layoutBody(
      { ...body, body: { ...body.body, wrap: true } },
      wrapWidth / PX_PER_PT,
      settings,
    )
    return { layout, width: extent(layout) * PX_PER_PT, height: layout.height * PX_PER_PT }
  }
  const left = { ...body, paragraphs: body.paragraphs.map((p) => ({ ...p, align: 'l' })) }
  const width = extent(layoutBody(left, 1e7, settings))
  const layout = layoutBody({ ...body, body: { ...body.body, wrap: false } }, width, settings)
  return { layout, width: width * PX_PER_PT, height: layout.height * PX_PER_PT }
}

function fontPx(style: TextStyle): number {
  return style.run.size * PX_PER_PT
}

function labelSize(text: string, style: TextStyle, settings: TextSettings): Measured {
  return measure(labelBody(text, style.run), settings)
}

export function formatValue(value: number, code: string, date1904: boolean): string {
  return plainText(formatNumber(clean(value), code, { date1904, palette: [] }))
}

// ── 坐标轴 ──

interface AxisPlan {
  readonly axis: Axis
  readonly horizontal: boolean
  /** 数值轴（含散点图的 x 轴）。 */
  readonly value: boolean
  /** 散点图的 x 轴：数据取各系列的 `xValues`。 */
  readonly xAxis: boolean
  readonly groups: readonly PlotGroup[]
  /** 分类为日期时的日期轴排列。 */
  readonly dates: DateScale | null
  /** 分类轴的分类数（日期轴为单位数）；数值轴为 0。 */
  readonly slots: number
}

interface Labeled extends Measured {
  readonly text: string
  /** 分类轴：标签所在的分类（日期轴为单位）下标；数值轴为刻度序号。 */
  readonly slot: number
}

/** 数值轴的数据范围：堆积图按分类累计正负值，百分比堆积为 0–1。 */
function dataRange(plan: AxisPlan): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  const add = (v: number) => {
    if (v < min) min = v
    if (v > max) max = v
  }
  for (const g of plan.groups) {
    if (plan.xAxis) {
      for (const s of g.series) {
        const xs = s.xValues ?? s.values.map((_, i) => i + 1)
        for (const v of xs) if (v !== null) add(v)
      }
    } else if (g.grouping === 'percentStacked') {
      add(0)
      add(1)
    } else if (g.grouping === 'stacked') {
      const n = Math.max(0, ...g.series.map((s) => s.values.length))
      for (let i = 0; i < n; i++) {
        let pos = 0
        let neg = 0
        for (const s of g.series) {
          const v = s.values[i] ?? 0
          if (v >= 0) pos += v
          else neg += v
        }
        add(pos)
        add(neg)
      }
    } else {
      for (const s of g.series) for (const v of s.values) if (v !== null) add(v)
    }
  }
  return min === Infinity ? { min: 0, max: 0 } : { min, max }
}

function axisFormat(plan: AxisPlan, percent: boolean): string {
  if (plan.axis.format !== null) return plan.axis.format
  if (percent) return '0%'
  if (plan.xAxis) return 'General'
  return plan.groups[0]?.series[0]?.format ?? 'General'
}

/** 数值轴：按轴长取刻度并排版标签。 */
function valueLabels(
  plan: AxisPlan,
  length: number,
  settings: TextSettings,
  date1904: boolean,
  host: Chart['host'],
): { scale: Scale; labels: Labeled[] } {
  const a = plan.axis
  const range = dataRange(plan)
  const percent = !plan.xAxis && plan.groups.some((g) => g.grouping === 'percentStacked')
  const code = axisFormat(plan, percent)
  const f = fontPx(a.text)
  const build = (limit: number) => {
    const scale = valueScale(range.min, range.max, {
      min: a.min ?? (percent ? 0 : null),
      max: a.max ?? (percent ? 1 : null),
      major: a.majorUnit,
      maxIntervals: Math.max(1, Math.min(MAX_INTERVALS, limit)),
    })
    const labels = ticks(scale).map((v, slot) => {
      const text = formatValue(v, code, date1904)
      return { text, slot, ...labelSize(text, a.text, settings) }
    })
    return { scale, labels }
  }
  if (!plan.horizontal) {
    const step = 1.4 * f - (host === 'sheet' ? 0.8 : 3.1)
    return build(Math.floor(length / Math.max(1, step)))
  }
  // 水平轴的区间数上限取决于标签宽度，标签又取决于刻度：从 10 个区间起按最宽标签逐步收紧。
  let limit = MAX_INTERVALS
  let out = build(limit)
  for (let i = 0; i < 6; i++) {
    const widest = Math.max(1, ...out.labels.map((l) => l.width))
    const next = Math.max(1, Math.floor(length / (widest / 2 + 2.5 * f)))
    if (next >= limit) break
    limit = next
    out = build(limit)
  }
  return out
}

function categoryLabels(plan: AxisPlan, count: number, settings: TextSettings): Labeled[] {
  const s = plan.groups.flatMap((g) => g.series).find((x) => x.categories.length > 0)
  const out: Labeled[] = []
  for (let i = 0; i < count; i++) {
    const text = s?.categories[i] ?? String(i + 1)
    out.push({ text, slot: i, ...labelSize(text, plan.axis.text, settings) })
  }
  return out
}

/** 分类标签的旋转角（度，逆时针为负）。 */
function categoryRotation(axis: Axis, labels: readonly Measured[], band: number): number {
  if (axis.text.rotation !== null) return axis.text.rotation
  const widest = Math.max(0, ...labels.map((l) => l.width))
  const tallest = Math.max(0, ...labels.map((l) => l.height))
  if (widest <= band - 2) return 0
  if (tallest / SQRT1_2 <= band) return -45
  return -90
}

/** 分类标签放在分类中心为 0 处时，旋转后最左点的横坐标。 */
function leftExtent(l: Labeled, rotation: number, f: number, date: boolean): number {
  const t = placeCategory(l, 0, 0, rotation, f, date)
  const a = (rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return Math.min(
    t.x,
    t.x + l.width * cos,
    t.x - l.height * sin,
    t.x + l.width * cos - l.height * sin,
  )
}

/** 旋转后的标签在垂直于轴方向上占的高度。 */
function rotatedExtent(l: Measured, rotation: number): number {
  const a = (Math.abs(rotation) * Math.PI) / 180
  return Math.abs(l.width * Math.sin(a)) + Math.abs(l.height * Math.cos(a))
}

/**
 * 分类标签框的左上角：不旋转时居中；−90° 时右端中点对齐分类中心；其余角度时右上角对齐分类中心右侧 0.12f
 * （日期轴为左侧 0.3f：两组实测的 −45° 日期标签比分类轴的规则靠左 5 像素）。
 */
function placeCategory(
  l: Labeled,
  cx: number,
  y: number,
  rotation: number,
  f: number,
  date: boolean,
): TickLabel {
  if (rotation === 0) return { ...l, x: cx - l.width / 2, y, rotation: 0 }
  const a = (rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  // 锚点在文字框中的位置及其对齐的位置。
  const [ax, ay, tx, ty] =
    rotation === -90
      ? [l.width, l.height / 2, cx, y - (0.943 * f - 2.35) + 0.375 * f]
      : [l.width, 0, cx + (date ? -0.3 : 0.12) * f, y]
  return { ...l, x: tx - (ax * cos - ay * sin), y: ty - (ax * sin + ay * cos), rotation }
}

// ── 图例 ──

interface LegendItem {
  readonly series: Series
  readonly point: number | null
  readonly group: PlotGroup
}

function legendItems(chart: Chart): LegendItem[] {
  const out: LegendItem[] = []
  for (const g of chart.plot.groups) {
    const pie = g.type === 'pie' || g.type === 'doughnut'
    if (pie || (g.varyColors && g.series.length === 1 && g.type !== 'scatter')) {
      const s = g.series[0]
      if (s === undefined) continue
      for (let i = 0; i < s.values.length; i++) out.push({ series: s, point: i, group: g })
      continue
    }
    const list = g.series.map((series) => ({ series, point: null, group: g }))
    // 横向条形图的图例按系列倒序排列（WPS 实测）。
    if (g.type === 'bar' && g.direction === 'bar') list.reverse()
    out.push(...list)
  }
  const hidden = new Set(chart.legend?.hidden ?? [])
  return out.filter((_, i) => !hidden.has(i))
}

function itemText(item: LegendItem): string {
  if (item.point === null) return item.series.name
  return item.series.categories[item.point] ?? String(item.point + 1)
}

function lineItem(item: LegendItem): boolean {
  return item.group.type === 'line' || item.group.type === 'scatter'
}

interface LegendPlan {
  readonly width: number
  readonly height: number
  /** 相对图例内容左上角。 */
  readonly cells: readonly {
    item: LegendItem
    x: number
    y: number
    text: Measured
    symbolWidth: number
  }[]
  readonly symbol: number
  readonly gap: number
}

function planLegend(
  chart: Chart,
  legend: Legend,
  settings: TextSettings,
  maxWidth: number,
): LegendPlan {
  const items = legendItems(chart)
  const f = fontPx(legend.text)
  const symbol = 0.63 * f
  const gap = 0.42 * f
  const spacing = 0.3 * f
  const rowGap = 0.33 * f
  const anyLine = items.some(lineItem)
  const sw = anyLine ? 2.2 * f : symbol
  const sized = items.map((item) => ({
    item,
    text: labelSize(itemText(item), legend.text, settings),
  }))
  const cells: LegendPlan['cells'][number][] = []
  const vertical = legend.position === 'l' || legend.position === 'r' || legend.position === 'tr'
  let width = 0
  let height = 0
  if (vertical) {
    let y = 0
    for (const c of sized) {
      cells.push({ ...c, x: 0, y, symbolWidth: sw })
      width = Math.max(width, sw + gap + c.text.width)
      height = y + c.text.height
      y += c.text.height + rowGap
    }
  } else {
    const rows: { start: number; width: number; height: number }[] = []
    let x = 0
    let y = 0
    sized.forEach((c, i) => {
      const w = sw + gap + c.text.width
      if (rows.length === 0 || (x > 0 && x + w > maxWidth)) {
        if (rows.length > 0) y += rows.at(-1)!.height + rowGap
        rows.push({ start: i, width: 0, height: 0 })
        x = 0
      }
      cells.push({ ...c, x, y, symbolWidth: sw })
      const row = rows.at(-1)!
      row.width = x + w
      row.height = Math.max(row.height, c.text.height)
      x += w + spacing
    })
    width = Math.max(0, ...rows.map((r) => r.width))
    height = rows.length === 0 ? 0 : y + rows.at(-1)!.height
    rows.forEach((r, ri) => {
      const end = rows[ri + 1]?.start ?? cells.length
      const shift = (width - r.width) / 2
      for (let i = r.start; i < end; i++) cells[i] = { ...cells[i]!, x: cells[i]!.x + shift }
    })
  }
  return { width, height, cells, symbol, gap }
}

function legendEntries(plan: LegendPlan, x0: number, y0: number): LegendEntry[] {
  return plan.cells.map((c) => {
    const cy = y0 + c.y + c.text.height / 2
    return {
      series: c.item.series,
      point: c.item.point,
      group: c.item.group,
      symbol: { x: x0 + c.x, y: cy - plan.symbol / 2, w: c.symbolWidth, h: plan.symbol },
      text: {
        layout: c.text.layout,
        x: x0 + c.x + c.symbolWidth + plan.gap,
        y: y0 + c.y,
        width: c.text.width,
        height: c.text.height,
        rotation: 0,
      },
    }
  })
}

// ── 主流程 ──

/** 坐标轴是图表组的第一条坐标轴（散点图的 x 轴）。 */
function firstAxis(groups: readonly PlotGroup[], id: number): boolean {
  return groups.some((g) => g.axes[0] === id)
}

function categoryCount(groups: readonly PlotGroup[]): number {
  let n = 0
  for (const g of groups)
    for (const s of g.series) n = Math.max(n, s.values.length, s.categories.length)
  return n
}

/** 分类为日期时的日期轴排列：见 `date-axis.ts`；不按日期轴时为 `null`。 */
function datePlan(axis: Axis, groups: readonly PlotGroup[], date1904: boolean): DateScale | null {
  if (axis.date === null) return null
  const series = groups.flatMap((g) => g.series).filter((s) => s.xValues !== null)
  const serials = series.flatMap((s) => s.xValues!.filter((v): v is number => v !== null && v >= 0))
  if (serials.length === 0) return null
  if (!axis.date.forced && !isDateFormat(series[0]!.categoryFormat)) return null
  return dateScale(serials, axis.date.base ?? autoBase(serials, date1904), date1904)
}

function axisPlans(chart: Chart): AxisPlan[] {
  const out: AxisPlan[] = []
  for (const a of chart.plot.axes) {
    const groups = chart.plot.groups.filter((g) => g.axes.includes(a.id))
    if (groups.length === 0) continue
    const scatter = groups.some((g) => g.type === 'scatter')
    const value = a.kind === 'value' || scatter
    const dates = value ? null : datePlan(a, groups, chart.date1904)
    out.push({
      axis: a,
      horizontal: a.position === 'b' || a.position === 't',
      value,
      xAxis: scatter && firstAxis(groups, a.id),
      groups,
      dates,
      slots: value ? 0 : (dates?.slots ?? categoryCount(groups)),
    })
  }
  return out
}

/** 与坐标轴交叉的坐标轴：`crossAx`，未写出时取同一图表组的另一条坐标轴。 */
function partnerOf(p: AxisPlan, plans: readonly AxisPlan[]): number {
  const id = p.axis.crossAx ?? p.groups[0]?.axes.find((a) => a !== p.axis.id)
  return plans.findIndex((q) => q !== p && q.axis.id === id)
}

/** 标签（与坐标轴标题）所在的一侧：`low`、`high` 按位置，其余按交叉位置（`max` 为右侧或上方）。 */
function labelSide(p: AxisPlan): Side {
  const pos = p.axis.tickLabelPosition
  const far = pos === 'high' || (pos !== 'low' && p.axis.crosses === 'max')
  if (p.horizontal) return far ? 't' : 'b'
  return far ? 'r' : 'l'
}

function manualPlot(chart: Chart, width: number, height: number): Rect | null {
  const l = chart.plot.layout
  if (l === null || l.xMode !== 'edge' || l.yMode !== 'edge') return null
  if (l.x === null || l.y === null || l.w === null || l.h === null) return null
  return { x: l.x * width, y: l.y * height, w: l.w * width, h: l.h * height }
}

function legendInset(f: number): number {
  return Math.max(1, 0.37 * f - 1.9)
}

export function layoutChart(
  chart: Chart,
  width: number,
  height: number,
  settings: TextSettings,
): ChartLayout {
  let top = PAD
  let bottom = height - PAD
  let bare = TITLE_EDGE_BARE
  let left = PAD
  let right = width - PAD
  let titleBottom = PAD
  let title: PlacedText | null = null
  if (chart.title !== null) {
    const m = measure(chart.title.text, settings, width * 0.8)
    const manual = chart.title.layout
    const x =
      manual?.xMode === 'edge' && manual.x !== null ? manual.x * width : (width - m.width) / 2
    const y = manual?.yMode === 'edge' && manual.y !== null ? manual.y * height : PAD
    title = { layout: m.layout, x, y, width: m.width, height: m.height, rotation: 0 }
    if (!chart.title.overlay && manual === null) {
      titleBottom = y + m.height
      top = titleBottom + TITLE_GAP
    }
  }

  let legend: ChartLayout['legend'] = null
  const lg = chart.legend
  if (lg !== null) {
    const f = fontPx(lg.text)
    const inset = legendInset(f)
    const plan = planLegend(chart, lg, settings, width - 2 * PAD - 2 * inset)
    const bw = plan.width + 2 * inset
    const bh = plan.height + 2 * inset
    let box: Rect
    if (lg.position === 'b') {
      box = { x: (width - bw) / 2, y: height - PAD - bh, w: bw, h: bh }
      if (!lg.overlay) {
        bottom = box.y - LEGEND_BOTTOM_GAP
        bare = 0
      }
    } else if (lg.position === 't') {
      const y = chart.title !== null ? titleBottom + TITLE_LEGEND_GAP : PAD
      box = { x: (width - bw) / 2, y, w: bw, h: bh }
      if (!lg.overlay) top = y + bh + Math.max(2, 1.67 * f - 7.1)
    } else {
      const span = chart.title !== null ? titleBottom : PAD
      const y = (span + height - PAD - bh) / 2
      if (lg.position === 'l') {
        box = { x: PAD, y, w: bw, h: bh }
        if (!lg.overlay) left = box.x + bw + LEGEND_SIDE_GAP
      } else {
        box = { x: width - PAD - bw, y, w: bw, h: bh }
        if (!lg.overlay) right = box.x - LEGEND_SIDE_GAP
      }
    }
    const manual = lg.layout
    if (
      manual !== null &&
      manual.xMode === 'edge' &&
      manual.yMode === 'edge' &&
      manual.x !== null &&
      manual.y !== null
    ) {
      box = { ...box, x: manual.x * width, y: manual.y * height }
    }
    legend = { box, entries: legendEntries(plan, box.x + inset, box.y + inset) }
  }

  const outer: Rect = {
    x: left,
    y: top,
    w: Math.max(1, right - left),
    h: Math.max(1, bottom - top),
  }
  const plans = axisPlans(chart)
  const manual = manualPlot(chart, width, height)
  if (plans.length === 0) return { width, height, title, legend, plot: manual ?? outer, axes: [] }
  const fixed = manual !== null && chart.plot.layout?.target === 'inner' ? manual : null
  const base = manual !== null && fixed === null ? manual : outer
  const { plot, axes } = layoutAxes(chart, plans, base, settings, fixed, { width, height, bare })
  return { width, height, title, legend, plot, axes }
}

/** 坐标轴在另一条数值轴上的交叉值：`autoZero` 取 0，不在刻度范围内时取最近的端点。 */
function crossValue(axis: Axis, s: Scale): number {
  const c = axis.crosses
  const v = typeof c === 'number' ? c : c === 'max' ? s.max : c === 'min' ? s.min : 0
  return Math.min(s.max, Math.max(s.min, v))
}

function inside(axis: Axis, s: Scale | null): boolean {
  if (s === null) return false
  const v = crossValue(axis, s)
  return v > s.min && v < s.max
}

function valueAt(
  s: Scale,
  v: number,
  start: number,
  length: number,
  reversed: boolean,
  vertical: boolean,
): number {
  const t = (v - s.min) / (s.max - s.min)
  const u = reversed ? 1 - t : t
  return vertical ? start + length - u * length : start + u * length
}

/** 分类轴的刻度在折线组上为 `midCat` 时落在分类中心，其余落在分类边界。 */
function between(plan: AxisPlan): boolean {
  return plan.axis.crossBetween === 'between' || !plan.groups.every((g) => g.type === 'line')
}

interface TitlePlan {
  readonly measured: Measured
  readonly rotation: number
  readonly side: Side
  /** 旋转后外接框的宽与高。 */
  readonly w: number
  readonly h: number
  readonly reserve: boolean
}

function axisTitle(p: AxisPlan, side: Side, settings: TextSettings): TitlePlan | null {
  const t = p.axis.title
  if (t === null) return null
  const measured = measure(t.text, settings)
  const rotation = p.axis.titleRotation ?? (p.horizontal ? 0 : -90)
  const a = (rotation * Math.PI) / 180
  const c = Math.abs(Math.cos(a))
  const s = Math.abs(Math.sin(a))
  return {
    measured,
    rotation,
    side,
    w: measured.width * c + measured.height * s,
    h: measured.width * s + measured.height * c,
    reserve: !t.overlay,
  }
}

/** 旋转文字框使其外接框左上角位于 (`bx`, `by`)。 */
function placeRotated(m: Measured, rotation: number, bx: number, by: number): PlacedText {
  const a = (rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const xs = [0, m.width * cos, -m.height * sin, m.width * cos - m.height * sin]
  const ys = [0, m.width * sin, m.height * cos, m.width * sin + m.height * cos]
  return {
    layout: m.layout,
    x: bx - Math.min(...xs),
    y: by - Math.min(...ys),
    width: m.width,
    height: m.height,
    rotation,
  }
}

/** 日期轴的标签：主要单位未指定时按间距自动选择（见 `date-axis.ts`），旋转规则见文件头。 */
function dateAxisLabels(
  plan: AxisPlan,
  scale: DateScale,
  length: number,
  settings: TextSettings,
  date1904: boolean,
): { labels: Labeled[]; rotation: number } {
  const a = plan.axis
  const source = plan.groups.flatMap((g) => g.series).find((s) => s.xValues !== null)
  const code = a.format ?? source?.categoryFormat ?? 'General'
  const text = (serial: number) => formatValue(serial, code, date1904)
  const band = length / Math.max(1, scale.slots)
  const sample = labelSize(text(scale.origin), a.text, settings)
  const step: DateStep =
    a.majorUnit !== null
      ? { count: a.majorUnit, unit: a.date?.majorTimeUnit ?? scale.base }
      : autoStep(scale, band, sample.height + DATE_FIT)
  const labels = dateLabels(scale, step).map((d) => {
    const t = text(d.serial)
    return { text: t, slot: d.slot, ...labelSize(t, a.text, settings) }
  })
  if (a.text.rotation !== null || !plan.horizontal) {
    return { labels, rotation: a.text.rotation ?? 0 }
  }
  const spacing = labels.length > 1 ? (labels[1]!.slot - labels[0]!.slot) * band : length
  const widest = Math.max(0, ...labels.map((l) => l.width))
  const rotation =
    widest + DATE_LABEL_GAP <= spacing ? 0 : spacing >= DATE_DIAGONAL * sample.height ? -45 : -90
  return { labels, rotation }
}

function layoutAxes(
  chart: Chart,
  plans: readonly AxisPlan[],
  outer: Rect,
  settings: TextSettings,
  fixed: Rect | null,
  size: Size,
): { plot: Rect; axes: AxisLayout[] } {
  const date1904 = chart.date1904
  const shown = (p: AxisPlan) => !p.axis.deleted && p.axis.tickLabelPosition !== 'none'
  const font = plans.map((p) => fontPx(p.axis.text))
  const gap = plans.map((p, i) =>
    p.horizontal ? Math.max(2, 0.943 * font[i]! - 2.35) : Math.max(2, 0.92 * font[i]! - 3),
  )
  const partner = plans.map((p) => partnerOf(p, plans))
  const sides = plans.map(labelSide)
  const titles = plans.map((p, i) => axisTitle(p, sides[i]!, settings))
  // 坐标轴标题占据外沿的一条：标题外接框距外沿 `TITLE_EDGE`，与标签相距 `TITLE_LABEL_GAP`。
  const box = { l: outer.x, r: outer.x + outer.w, t: outer.y, b: outer.y + outer.h }
  for (const t of titles) {
    if (t === null || !t.reserve) continue
    if (t.side === 'l') box.l += TITLE_EDGE + t.w + TITLE_LABEL_GAP
    else if (t.side === 'r') box.r -= TITLE_EDGE + t.w + TITLE_LABEL_GAP
    else if (t.side === 't') box.t += TITLE_EDGE_H + t.h + TITLE_LABEL_GAP_H
    else box.b -= TITLE_EDGE_H + size.bare + t.h + TITLE_LABEL_GAP_H
  }

  const scales: (Scale | null)[] = plans.map(() => null)
  const labels: Labeled[][] = plans.map(() => [])
  const rotations = plans.map(() => 0)
  const scaleOf = (i: number) => (i < 0 ? null : scales[i]!)
  let rect = { l: box.l, r: box.r - RIGHT_EXTRA, t: box.t + TOP_OFFSET, b: box.b - BOTTOM_OFFSET }
  for (let pass = 0; pass < 3; pass++) {
    plans.forEach((p, i) => {
      const length = Math.max(1, p.horizontal ? rect.r - rect.l : rect.b - rect.t)
      if (p.value) {
        const r = valueLabels(p, length, settings, date1904, chart.host)
        scales[i] = r.scale
        labels[i] = r.labels
      } else if (p.dates !== null) {
        const r = dateAxisLabels(p, p.dates, length, settings, date1904)
        labels[i] = r.labels
        rotations[i] = r.rotation
      } else {
        labels[i] = categoryLabels(p, p.slots, settings)
        rotations[i] = p.horizontal
          ? categoryRotation(p.axis, labels[i]!, length / Math.max(1, p.slots))
          : 0
      }
    })
    let l = box.l
    let r = box.r - RIGHT_EXTRA
    let t = box.t + TOP_OFFSET
    let b = box.b - BOTTOM_OFFSET
    plans.forEach((p, i) => {
      if (!p.horizontal && p.value && shown(p))
        t = Math.max(t, box.t + Math.max(TOP_OFFSET, 0.6 * font[i]! - 3.15))
    })
    plans.forEach((p, i) => {
      // 标签在绘图区边缘（`low`、`high`）时总要留出空间；随轴线位于内部时不留。
      const nextTo = p.axis.tickLabelPosition === 'nextTo'
      if (!shown(p) || (nextTo && inside(p.axis, scaleOf(partner[i]!)))) return
      const ls = labels[i]!
      if (p.horizontal) {
        const ext = Math.max(0, ...ls.map((x) => rotatedExtent(x, rotations[i]!)))
        if (sides[i] === 'b') b = Math.min(b, box.b - ext - gap[i]!)
        else t = Math.max(t, box.t + ext + gap[i]!)
        const first = ls[0]
        if (!p.value && first !== undefined && rotations[i] !== 0 && sides[i] === 'b') {
          // 旋转的首个标签伸出分类中心左侧的部分不越过外沿。
          const band = (rect.r - rect.l) / Math.max(1, between(p) ? p.slots : p.slots - 1)
          const offset = (first.slot + (between(p) ? 0.5 : 0)) * band
          const over = -leftExtent(first, rotations[i]!, font[i]!, p.dates !== null)
          l = Math.max(l, box.l + ROTATED_MARGIN + over - offset)
        }
        if (p.value && ls.length > 0) {
          r = Math.min(r, box.r - ls.at(-1)!.width / 2 + 2.4)
          l = Math.max(l, box.l + ls[0]!.width / 2 - 2.4)
        }
      } else {
        const w = Math.max(0, ...ls.map((x) => x.width))
        if (sides[i] === 'l') l = Math.max(l, box.l + w + gap[i]!)
        else r = Math.min(r, box.r - w - gap[i]! - RIGHT_LABEL_EXTRA)
      }
    })
    rect = { l, r, t, b }
  }
  const plot: Rect = fixed ?? {
    x: rect.l,
    y: rect.t,
    w: Math.max(1, rect.r - rect.l),
    h: Math.max(1, rect.b - rect.t),
  }

  const axes = plans.map((p, i): AxisLayout => {
    const q = partner[i]!
    const ps = scaleOf(q)
    const reversed = q >= 0 && plans[q]!.axis.reversed
    const far = sides[i] === 't' || sides[i] === 'r'
    const pos = p.axis.tickLabelPosition
    const out: TickLabel[] = []
    const tickPos: number[] = []
    const scale = scales[i]!
    const n = Math.max(1, p.slots)
    const mid = between(p)
    const visible = shown(p)
    let at: number
    if (p.horizontal) {
      at =
        ps !== null
          ? valueAt(ps, crossValue(p.axis, ps), plot.y, plot.h, reversed, true)
          : p.axis.crosses === 'max'
            ? plot.y
            : plot.y + plot.h
      const edge = pos === 'low' ? plot.y + plot.h : pos === 'high' ? plot.y : at
      const labelY = far ? edge - gap[i]! : edge + gap[i]!
      if (scale !== null) {
        ticks(scale).forEach((v, k) => {
          const x = valueAt(scale, v, plot.x, plot.w, p.axis.reversed, false)
          tickPos.push(x)
          const l = labels[i]![k]
          if (l === undefined || !visible) return
          out.push({ ...l, x: x - l.width / 2, y: far ? labelY - l.height : labelY, rotation: 0 })
        })
      } else {
        const band = plot.w / (mid ? n : Math.max(1, n - 1))
        categoryTicks(p, labels[i]!, n, mid, (k) => tickPos.push(plot.x + k * band))
        const skip = p.dates === null ? (p.axis.labelSkip ?? 1) : 1
        for (const l of labels[i]!) {
          if (!visible || l.slot % skip !== 0) continue
          const idx = p.axis.reversed ? n - 1 - l.slot : l.slot
          const cx = plot.x + (mid ? (idx + 0.5) * band : idx * band)
          out.push(
            far
              ? { ...l, x: cx - l.width / 2, y: labelY - l.height, rotation: 0 }
              : placeCategory(l, cx, labelY, rotations[i]!, font[i]!, p.dates !== null),
          )
        }
      }
    } else {
      at =
        ps !== null
          ? valueAt(ps, crossValue(p.axis, ps), plot.x, plot.w, reversed, false)
          : p.axis.crosses === 'max'
            ? plot.x + plot.w
            : plot.x
      const edge = pos === 'low' ? plot.x : pos === 'high' ? plot.x + plot.w : at
      const place = (l: Labeled, cy: number): TickLabel => ({
        ...l,
        x: far ? edge + gap[i]! : edge - gap[i]! - l.width,
        y: cy - l.height / 2,
        rotation: 0,
      })
      if (scale !== null) {
        ticks(scale).forEach((v, k) => {
          const y = valueAt(scale, v, plot.y, plot.h, p.axis.reversed, true)
          tickPos.push(y)
          const l = labels[i]![k]
          if (l !== undefined && visible) out.push(place(l, y))
        })
      } else {
        const band = plot.h / (mid ? n : Math.max(1, n - 1))
        categoryTicks(p, labels[i]!, n, mid, (k) => tickPos.push(plot.y + plot.h - k * band))
        for (const l of labels[i]!) {
          if (!visible) continue
          const idx = p.axis.reversed ? n - 1 - l.slot : l.slot
          out.push(place(l, plot.y + plot.h - (mid ? (idx + 0.5) * band : idx * band)))
        }
      }
    }
    return {
      axis: p.axis,
      horizontal: p.horizontal,
      scale,
      ticks: tickPos,
      at,
      labels: out,
      slots: p.value ? 0 : n,
      date: p.dates,
      title: placeTitle(p, titles[i]!, plot, outer, size),
    }
  })
  return { plot, axes }
}

/** 分类轴的刻度位置（以分类宽度计）：普通分类轴为每个分类边界，日期轴为各标签所在单位的起点与末端。 */
function categoryTicks(
  p: AxisPlan,
  labels: readonly Labeled[],
  n: number,
  mid: boolean,
  push: (k: number) => void,
): void {
  const last = mid ? n : n - 1
  if (p.dates === null) {
    for (let k = 0; k <= last; k++) push(k)
    return
  }
  for (const l of labels) push(l.slot)
  push(last)
}

/** 坐标轴标题：沿绘图区居中，位于标签一侧的外沿；手动布局（`edge`）时外接框左上角取指定位置。 */
function placeTitle(
  p: AxisPlan,
  t: TitlePlan | null,
  plot: Rect,
  outer: Rect,
  size: Size,
): PlacedText | null {
  if (t === null) return null
  const manual = p.axis.title?.layout ?? null
  let bx: number
  let by: number
  if (t.side === 'l' || t.side === 'r') {
    bx = t.side === 'l' ? outer.x + TITLE_EDGE : outer.x + outer.w - TITLE_EDGE - t.w
    by = plot.y + plot.h / 2 - t.h / 2
  } else {
    bx = plot.x + plot.w / 2 - t.w / 2
    by =
      t.side === 't' ? outer.y + TITLE_EDGE_H : outer.y + outer.h - TITLE_EDGE_H - size.bare - t.h
  }
  if (manual?.xMode === 'edge' && manual.x !== null) bx = manual.x * size.width
  if (manual?.yMode === 'edge' && manual.y !== null) by = manual.y * size.height
  return placeRotated(t.measured, t.rotation, bx, by)
}

/**
 * 百分比标签按最大余数法取整，使显示值之和为 100%（WPS 实测：8.2、3.2、1.4、1.2 显示为 59%、23%、10%、8%）。
 * `digits` 为格式的小数位数。
 */
export function roundPercents(values: readonly number[], digits: number): number[] {
  const total = values.reduce((a, v) => a + v, 0)
  if (!(total > 0)) return values.map(() => 0)
  const unit = 10 ** (2 + digits)
  const raw = values.map((v) => (v / total) * unit)
  const floors = raw.map((r) => Math.floor(r + 1e-9))
  let rest = unit - floors.reduce((a, v) => a + v, 0)
  const order = raw
    .map((r, i) => ({ i, frac: r - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  for (const o of order) {
    if (rest <= 0) break
    if (values[o.i]! <= 0) continue
    floors[o.i]! += 1
    rest--
  }
  return floors.map((v) => v / unit)
}

/** 数据标签的文字：系列名、分类名、值、百分比按此顺序以分隔符连接。 */
export function dataLabelText(
  labels: DataLabels,
  series: Series,
  index: number,
  percent: number | null,
  date1904: boolean,
): string {
  const parts: string[] = []
  const v = series.values[index]
  if (labels.showSeries) parts.push(series.name)
  if (labels.showCategory) parts.push(series.categories[index] ?? '')
  if (labels.showValue && v !== null && v !== undefined) {
    parts.push(formatValue(v, labels.format ?? series.format, date1904))
  }
  if (labels.showPercent && percent !== null) {
    parts.push(formatValue(percent, labels.format ?? '0%', date1904))
  }
  return parts.join(labels.separator)
}
