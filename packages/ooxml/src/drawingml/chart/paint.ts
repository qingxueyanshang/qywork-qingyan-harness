/**
 * 图表绘制：按 `layout.ts` 的布局把 `Chart` 绘制到 Canvas 2D 上下文。
 *
 * - 坐标：图表局部坐标为 96 dpi 像素，原点为图形框左上角；`parent` 为外层坐标到设备坐标的变换（与形状相同）。
 *   图表整体另向右下平移半个像素：WPS 的像素中心在整数坐标处（校准文件逐页比对，平移后网格线与文字位置一致）。
 * - 绘制顺序：图表区、绘图区、网格线、数据系列（条形、折线与标记、散点、扇区）、坐标轴线与刻度线、坐标轴标签、
 *   坐标轴标题、数据标签、图例、标题。各图表组按自身的坐标轴换算（次坐标轴的组按次坐标轴）。
 * - 条形：分类宽度 = 条宽 × (系列数 − (系列数 − 1) × 重叠比例 + 间隙比例)，组内条形依次错开 条宽 × (1 − 重叠比例)，
 *   分类两侧各留 间隙比例 / 2 × 条宽。条形从坐标轴交叉值延伸到数据值，超出绘图区的部分裁去。
 * - 饼图：直径为绘图区较短边减去 `PIE_MARGIN` 与数据标签的预留，居中；第一个扇区从 12 点方向起顺时针排列，
 *   `firstSliceAng` 再顺时针旋转。圆环图的内径为外径 × `holeSize`。三维饼图见 `pie3d.ts`。
 * - 平滑折线按相邻点构造三次曲线段（控制点取前后点连线方向的 1/6）。
 */

import type { Line, ShapeFill } from '../fill.ts'
import type { Segment, ShapePath } from '../geometry/path.ts'
import {
  type Matrix,
  multiply,
  rotation,
  scaling,
  setMatrix,
  translation,
} from '../paint/context.ts'
import { paintFill, tracePath } from '../paint/fill.ts'
import { paintLine } from '../paint/line.ts'
import type { Frame } from '../shape/model.ts'
import { placeFrame, type ShapeScene } from '../shape/paint.ts'
import { paintBody, type TextSettings } from '../text/body.ts'
import { unitIndex } from './date-axis.ts'
import {
  type AxisLayout,
  type ChartLayout,
  dataLabelText,
  labelBody,
  layoutChart,
  measure,
  type PlacedText,
  type Rect,
  roundPercents,
} from './layout.ts'
import type { Chart, ChartBox, DataLabels, Marker, PlotGroup, Series, View3D } from './model.ts'
import { type Pie3D, pieGeometry, project, sideFill, topFill, wallFill } from './pie3d.ts'

const PX_PER_PT = 4 / 3
const EMU_PER_PX = 9525
const PIE_MARGIN = 10
/** 刻度线长度。 */
const TICK = 5
/** 图表区的圆角半径（`roundedCorners`）。 */
const CORNER = 10

interface Scene {
  readonly base: ShapeScene
  readonly settings: TextSettings
  /** 图表局部坐标到设备坐标。 */
  readonly matrix: Matrix
  readonly layout: ChartLayout
  readonly date1904: boolean
}

// ── 基本图元 ──

function shifted(segments: readonly Segment[], dx: number, dy: number): Segment[] {
  const out: Segment[] = []
  for (const g of segments) {
    if (g.kind === 'close') out.push(g)
    else if (g.kind === 'arc')
      out.push({ ...g, cx: g.cx + dx, cy: g.cy + dy, x: g.x + dx, y: g.y + dy })
    else if (g.kind === 'quad')
      out.push({ ...g, x1: g.x1 + dx, y1: g.y1 + dy, x: g.x + dx, y: g.y + dy })
    else if (g.kind === 'cubic') {
      out.push({
        ...g,
        x1: g.x1 + dx,
        y1: g.y1 + dy,
        x2: g.x2 + dx,
        y2: g.y2 + dy,
        x: g.x + dx,
        y: g.y + dy,
      })
    } else out.push({ ...g, x: g.x + dx, y: g.y + dy })
  }
  return out
}

/** 以 `bounds` 为填充范围（渐变与图案的坐标系）填充路径。 */
function fillPath(s: Scene, segments: readonly Segment[], fill: ShapeFill, bounds: Rect): void {
  if (fill.kind === 'none' || bounds.w <= 0 || bounds.h <= 0) return
  const ctx = s.base.ctx
  const matrix = multiply(s.matrix, translation(bounds.x, bounds.y))
  const local = shifted(segments, -bounds.x, -bounds.y)
  setMatrix(ctx, matrix)
  paintFill(
    ctx,
    () => tracePath(ctx, local),
    fill,
    { width: bounds.w, height: bounds.h, matrix },
    s.base.res,
  )
}

function strokePath(s: Scene, segments: readonly Segment[], line: Line | null, bounds: Rect): void {
  if (line === null || segments.length === 0) return
  const path: ShapePath = { fill: 'none', stroke: true, segments }
  const area = { width: bounds.w, height: bounds.h, matrix: s.matrix }
  paintLine(s.base.ctx, [path], line, area, s.base.res, s.base.canvas)
}

function rectSegments(r: Rect): Segment[] {
  return [
    { kind: 'move', x: r.x, y: r.y },
    { kind: 'line', x: r.x + r.w, y: r.y },
    { kind: 'line', x: r.x + r.w, y: r.y + r.h },
    { kind: 'line', x: r.x, y: r.y + r.h },
    { kind: 'close' },
  ]
}

function paintBox(s: Scene, r: Rect, box: ChartBox): void {
  const seg = rectSegments(r)
  fillPath(s, seg, box.fill, r)
  strokePath(s, seg, box.line, r)
}

function paintText(s: Scene, t: PlacedText): void {
  const local = multiply(
    translation(t.x, t.y),
    multiply(rotation((t.rotation * Math.PI) / 180), scaling(PX_PER_PT, PX_PER_PT)),
  )
  paintBody(
    s.base.ctx,
    t.layout,
    {
      matrix: multiply(s.matrix, local),
      width: t.width / PX_PER_PT,
      height: t.height / PX_PER_PT,
      scale: s.base.scale,
    },
    s.settings.faces,
    s.base.res,
    s.base.canvas,
    [],
  )
}

// ── 坐标换算 ──

interface Mapping {
  /** 分类轴（或散点图 x 轴）上的位置；`x` 为散点图的 x 值。 */
  cat(index: number, x: number | null): number
  /** 数值轴上的位置。 */
  val(v: number): number
  /** 条形的起点：数值轴上 0 的位置，0 不在刻度范围内时取最近的端点。 */
  readonly base: number
  readonly band: number
  /** 分类轴水平。 */
  readonly horizontal: boolean
  /** 分类位置按数值（散点图 x 轴、日期轴）：没有数值的点不绘制。 */
  readonly numeric: boolean
}

function mapping(s: Scene, g: PlotGroup): Mapping | null {
  const { layout } = s
  const plot = layout.plot
  const axes = g.axes
    .map((id) => layout.axes.find((a) => a.axis.id === id))
    .filter((a): a is AxisLayout => a !== undefined)
  const catAxis =
    axes.find((a) => a.scale === null) ??
    (g.type === 'scatter' ? axes.find((a) => a.horizontal) : undefined)
  const valAxis = axes.find((a) => a !== catAxis && a.scale !== null)
  if (catAxis === undefined || valAxis === undefined || valAxis.scale === null) return null
  const vs = valAxis.scale
  const along = (scale: { min: number; max: number }, v: number, axis: AxisLayout) => {
    const t = (v - scale.min) / (scale.max - scale.min)
    const u = axis.axis.reversed ? 1 - t : t
    return axis.horizontal ? plot.x + u * plot.w : plot.y + plot.h - u * plot.h
  }
  const n = Math.max(1, catAxis.slots)
  const between = catAxis.axis.crossBetween === 'between' || g.type === 'bar'
  const band = (catAxis.horizontal ? plot.w : plot.h) / (between ? n : Math.max(1, n - 1))
  const cs = catAxis.scale
  const ds = catAxis.date
  const cat = (index: number, x: number | null) => {
    if (cs !== null) return along(cs, x ?? index + 1, catAxis)
    const slot = ds !== null && x !== null ? unitIndex(x, ds) : index
    const i = catAxis.axis.reversed ? n - 1 - slot : slot
    const offset = between ? (i + 0.5) * band : i * band
    return catAxis.horizontal ? plot.x + offset : plot.y + plot.h - offset
  }
  const zero = Math.min(vs.max, Math.max(vs.min, 0))
  return {
    cat,
    val: (v) => along(vs, v, valAxis),
    base: along(vs, zero, valAxis),
    band,
    horizontal: catAxis.horizontal,
    numeric: cs !== null || ds !== null,
  }
}

// ── 系列 ──

function pointBox(series: Series, index: number): ChartBox {
  return series.points.find((p) => p.index === index)?.box ?? series.box
}

function pointMarker(series: Series, index: number): Marker | null {
  const p = series.points.find((q) => q.index === index)
  return p === undefined ? series.marker : p.marker
}

interface LabelSpot {
  readonly labels: DataLabels
  readonly series: Series
  readonly index: number
  /** 条形的矩形；数据点为宽高为 0 的矩形。 */
  readonly anchor: Rect
  readonly percent: number | null
  readonly kind: 'bar' | 'point' | 'slice'
  /** 竖向柱形。 */
  readonly column: boolean
  readonly positive: boolean
  /** 扇区：中心、半径与中线角（弧度）；`squash` 为标签位置的纵向比例（三维饼图为 sin `rotX`）。 */
  readonly slice: {
    cx: number
    cy: number
    r: number
    inner: number
    angle: number
    squash: number
  } | null
  /** 数据点的标记：标签与标记边缘的间距按其尺寸。 */
  readonly marker: Marker | null
}

function labelsAt(series: Series, index: number): DataLabels | null {
  if (series.pointLabels.has(index)) return series.pointLabels.get(index) ?? null
  return series.labels
}

/** 百分比堆积时各分类的总量。 */
function totals(g: PlotGroup): number[] {
  const count = Math.max(0, ...g.series.map((x) => x.values.length))
  const out = new Array<number>(count).fill(0)
  if (g.grouping === 'percentStacked') {
    for (const x of g.series) {
      for (let i = 0; i < x.values.length; i++) out[i]! += Math.abs(x.values[i] ?? 0)
    }
  }
  return out
}

function paintBars(s: Scene, g: PlotGroup, m: Mapping, spots: LabelSpot[]): void {
  const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked'
  const slots = stacked ? 1 : g.series.length
  const overlap = stacked ? 1 : g.overlap / 100
  const gap = g.gapWidth / 100
  const bar = m.band / (slots - (slots - 1) * overlap + gap)
  const ctx = s.base.ctx
  const plot = s.layout.plot
  ctx.save()
  setMatrix(ctx, s.matrix)
  ctx.beginPath()
  ctx.rect(plot.x, plot.y, plot.w, plot.h)
  ctx.clip()
  const sums = totals(g)
  const pos = sums.map(() => 0)
  const neg = sums.map(() => 0)
  g.series.forEach((series, k) => {
    const slot = stacked ? 0 : k
    // 组内第一个系列在分类轴起点一侧：竖向柱形在左，横向条形在下。
    const offset = (gap / 2) * bar + slot * bar * (1 - overlap)
    series.values.forEach((raw, i) => {
      const x = series.xValues?.[i] ?? null
      if (raw === null || (m.numeric && x === null)) return
      const v = g.grouping === 'percentStacked' ? (sums[i]! > 0 ? raw / sums[i]! : 0) : raw
      let from = 0
      if (stacked && v >= 0) {
        from = pos[i]!
        pos[i]! += v
      } else if (stacked) {
        from = neg[i]!
        neg[i]! += v
      }
      const a = from === 0 ? m.base : m.val(from)
      const b = m.val(from + v)
      const center = m.cat(i, x)
      const r: Rect = m.horizontal
        ? { x: center - m.band / 2 + offset, y: Math.min(a, b), w: bar, h: Math.abs(b - a) }
        : { x: Math.min(a, b), y: center + m.band / 2 - offset - bar, w: Math.abs(b - a), h: bar }
      paintBox(s, r, pointBox(series, i))
      const labels = labelsAt(series, i)
      if (labels === null) return
      spots.push({
        labels,
        series,
        index: i,
        anchor: r,
        percent: null,
        kind: 'bar',
        column: m.horizontal,
        positive: v >= 0,
        slice: null,
        marker: null,
      })
    })
  })
  ctx.restore()
}

function smoothSegments(points: readonly { x: number; y: number }[]): Segment[] {
  const out: Segment[] = []
  points.forEach((p, i) => {
    if (i === 0) {
      out.push({ kind: 'move', x: p.x, y: p.y })
      return
    }
    const p0 = points[i - 2] ?? points[i - 1]!
    const p1 = points[i - 1]!
    const p3 = points[i + 1] ?? p
    out.push({
      kind: 'cubic',
      x1: p1.x + (p.x - p0.x) / 6,
      y1: p1.y + (p.y - p0.y) / 6,
      x2: p.x - (p3.x - p1.x) / 6,
      y2: p.y - (p3.y - p1.y) / 6,
      x: p.x,
      y: p.y,
    })
  })
  return out
}

/** 标记的路径与是否填充：`x`、`+`、`*` 只有线条。 */
function markerPath(
  symbol: string,
  x: number,
  y: number,
  size: number,
): { seg: Segment[]; filled: boolean } {
  const h = size / 2
  const seg: Segment[] = []
  const poly = (pts: readonly (readonly [number, number])[], close: boolean) => {
    pts.forEach(([px, py], i) => {
      seg.push({ kind: i === 0 ? 'move' : 'line', x: x + px, y: y + py })
    })
    if (close) seg.push({ kind: 'close' })
  }
  const bar = size / 10
  switch (symbol) {
    case 'square':
      poly(
        [
          [-h, -h],
          [h, -h],
          [h, h],
          [-h, h],
        ],
        true,
      )
      return { seg, filled: true }
    case 'diamond':
      poly(
        [
          [0, -h],
          [h, 0],
          [0, h],
          [-h, 0],
        ],
        true,
      )
      return { seg, filled: true }
    case 'triangle':
      poly(
        [
          [0, -h],
          [h, h],
          [-h, h],
        ],
        true,
      )
      return { seg, filled: true }
    case 'x':
      poly(
        [
          [-h, -h],
          [h, h],
        ],
        false,
      )
      poly(
        [
          [h, -h],
          [-h, h],
        ],
        false,
      )
      return { seg, filled: false }
    case 'star':
      poly(
        [
          [-h, -h],
          [h, h],
        ],
        false,
      )
      poly(
        [
          [h, -h],
          [-h, h],
        ],
        false,
      )
      poly(
        [
          [0, -h],
          [0, h],
        ],
        false,
      )
      return { seg, filled: false }
    case 'plus':
      poly(
        [
          [0, -h],
          [0, h],
        ],
        false,
      )
      poly(
        [
          [-h, 0],
          [h, 0],
        ],
        false,
      )
      return { seg, filled: false }
    case 'dash':
      poly(
        [
          [-h, -bar],
          [h, -bar],
          [h, bar],
          [-h, bar],
        ],
        true,
      )
      return { seg, filled: true }
    case 'dot':
      poly(
        [
          [-bar, -bar],
          [bar, -bar],
          [bar, bar],
          [-bar, bar],
        ],
        true,
      )
      return { seg, filled: true }
    default:
      seg.push({ kind: 'move', x: x + h, y })
      seg.push({
        kind: 'arc',
        cx: x,
        cy: y,
        rx: h,
        ry: h,
        start: 0,
        end: Math.PI * 2,
        anticlockwise: false,
        x: x + h,
        y,
      })
      seg.push({ kind: 'close' })
      return { seg, filled: true }
  }
}

function paintMarker(s: Scene, marker: Marker, x: number, y: number): void {
  const size = marker.size * PX_PER_PT
  const { seg, filled } = markerPath(marker.symbol, x, y, size)
  const r: Rect = { x: x - size / 2, y: y - size / 2, w: size, h: size }
  if (filled) fillPath(s, seg, marker.box.fill, r)
  strokePath(s, seg, marker.box.line, r)
}

function paintLines(
  s: Scene,
  g: PlotGroup,
  m: Mapping,
  spots: LabelSpot[],
  blanks: Chart['blanks'],
): void {
  const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked'
  const sums = totals(g)
  const acc = sums.map(() => 0)
  const plot = s.layout.plot
  for (const series of g.series) {
    const pts = series.values.map((raw, i) => {
      const x = series.xValues === null ? null : (series.xValues[i] ?? null)
      if (m.numeric && x === null) return null
      if (raw === null && (blanks !== 'zero' || series.missing.has(i))) return null
      let v = raw ?? 0
      if (g.grouping === 'percentStacked') v = sums[i]! > 0 ? v / sums[i]! : 0
      if (stacked) {
        acc[i]! += v
        v = acc[i]!
      }
      const c = m.cat(i, x)
      const p = m.val(v)
      return m.horizontal ? { x: c, y: p, i } : { x: p, y: c, i }
    })
    if (g.lines && series.box.line !== null) {
      const runs: { x: number; y: number }[][] = [[]]
      pts.forEach((p, i) => {
        if (p !== null) runs.at(-1)!.push(p)
        else if (blanks !== 'span' && !series.missing.has(i)) runs.push([])
      })
      for (const run of runs) {
        if (run.length < 2) continue
        const seg = series.smooth
          ? smoothSegments(run)
          : run.map((p, i): Segment => ({ kind: i === 0 ? 'move' : 'line', x: p.x, y: p.y }))
        strokePath(s, seg, series.box.line, plot)
      }
    }
    for (const p of pts) {
      if (p === null) continue
      const marker = pointMarker(series, p.i)
      if (marker !== null) paintMarker(s, marker, p.x, p.y)
      const labels = labelsAt(series, p.i)
      if (labels === null) continue
      spots.push({
        labels,
        series,
        index: p.i,
        anchor: { x: p.x, y: p.y, w: 0, h: 0 },
        percent: null,
        kind: 'point',
        column: false,
        positive: true,
        slice: null,
        marker,
      })
    }
  }
}

/** 扇区（或圆环段）的路径。 */
function sliceSegments(
  cx: number,
  cy: number,
  r: number,
  inner: number,
  a0: number,
  a1: number,
): Segment[] {
  const at = (radius: number, a: number) => ({
    x: cx + Math.cos(a) * radius,
    y: cy + Math.sin(a) * radius,
  })
  const outerEnd = at(r, a1)
  const outer: Segment = {
    kind: 'arc',
    cx,
    cy,
    rx: r,
    ry: r,
    start: a0,
    end: a1,
    anticlockwise: false,
    ...outerEnd,
  }
  if (inner <= 0)
    return [
      { kind: 'move', x: cx, y: cy },
      { kind: 'line', ...at(r, a0) },
      outer,
      { kind: 'close' },
    ]
  const innerEnd = at(inner, a0)
  return [
    { kind: 'move', ...at(r, a0) },
    outer,
    { kind: 'line', ...at(inner, a1) },
    {
      kind: 'arc',
      cx,
      cy,
      rx: inner,
      ry: inner,
      start: a1,
      end: a0,
      anticlockwise: true,
      ...innerEnd,
    },
    { kind: 'close' },
  ]
}

function paintPie(s: Scene, g: PlotGroup, spots: LabelSpot[]): void {
  const series = g.series[0]
  if (series === undefined) return
  const plot = s.layout.plot
  const sample = series.labels ?? [...series.pointLabels.values()].find((l) => l !== null) ?? null
  // 有数据标签时为标签留出上下各一行：外侧标签另加间距（实测 bestFit 共 2 × 行高 + 3.7，outEnd 共 2 × (行高 + 5)）。
  const labelH = sample === null ? 0 : measure(labelBody('0%', sample.text.run), s.settings).height
  const reserve =
    sample === null ? 0 : sample.position === 'outEnd' ? 2 * (labelH + 5) : 2 * labelH + 3.7
  const r = Math.max(1, Math.min(plot.w, plot.h) - PIE_MARGIN - reserve) / 2
  const cx = plot.x + plot.w / 2
  const cy = plot.y + plot.h / 2
  const values = series.values.map((v) => Math.abs(v ?? 0))
  const total = values.reduce((a, v) => a + v, 0)
  if (!(total > 0)) return
  const inner = g.type === 'doughnut' ? (r * g.holeSize) / 100 : 0
  const percents = roundPercents(values, percentDigits(sample?.format ?? '0%'))
  let angle = -Math.PI / 2 + (g.firstSliceAngle * Math.PI) / 180
  values.forEach((v, i) => {
    const a0 = angle
    const a1 = angle + (v / total) * Math.PI * 2
    angle = a1
    if (v <= 0) return
    const explosion = series.points.find((q) => q.index === i)?.explosion ?? series.explosion
    const mid = (a0 + a1) / 2
    const ox = cx + Math.cos(mid) * explosion * r
    const oy = cy + Math.sin(mid) * explosion * r
    const seg = sliceSegments(ox, oy, r, inner, a0, a1)
    const box = pointBox(series, i)
    const bounds: Rect = { x: ox - r, y: oy - r, w: 2 * r, h: 2 * r }
    fillPath(s, seg, box.fill, bounds)
    strokePath(s, seg, box.line, bounds)
    const labels = labelsAt(series, i)
    if (labels === null) return
    spots.push({
      labels,
      series,
      index: i,
      anchor: bounds,
      percent: percents[i] ?? 0,
      kind: 'slice',
      column: false,
      positive: true,
      slice: { cx: ox, cy: oy, r, inner, angle: mid, squash: 1 },
      marker: null,
    })
  })
}

function polygon(points: readonly { x: number; y: number }[]): Segment[] {
  const seg: Segment[] = points.map((p, i) => ({ kind: i === 0 ? 'move' : 'line', x: p.x, y: p.y }))
  seg.push({ kind: 'close' })
  return seg
}

/** 圆弧上自 `a0` 至 `a1` 的投影点（约每 2° 一个）。 */
function arcPoints(
  g: Pie3D,
  a0: number,
  a1: number,
  z: number,
  ox: number,
  oz: number,
): { x: number; y: number }[] {
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 90)))
  return Array.from({ length: n + 1 }, (_, i) =>
    project(g, a0 + ((a1 - a0) * i) / n, g.r, z, ox, oz),
  )
}

/** 三维饼图：几何与着色见 `pie3d.ts`；扇区按中线深度自远至近绘制，每个扇区依次为径向侧面、外侧面、顶面。 */
function paintPie3D(s: Scene, g: PlotGroup, view: View3D, spots: LabelSpot[]): void {
  const series = g.series[0]
  if (series === undefined) return
  const plot = s.layout.plot
  const sample = series.labels ?? [...series.pointLabels.values()].find((l) => l !== null) ?? null
  const labelH = sample === null ? 0 : measure(labelBody('0%', sample.text.run), s.settings).height
  const reserve =
    sample === null ? 0 : sample.position === 'outEnd' ? 2 * (labelH + 5) : 2 * labelH + 3.7
  const explode = Math.max(series.explosion, ...series.points.map((q) => q.explosion))
  const geo = pieGeometry(view, plot.x, plot.y, plot.w, plot.h, reserve, explode)
  const values = series.values.map((v) => Math.abs(v ?? 0))
  const total = values.reduce((a, v) => a + v, 0)
  if (!(total > 0)) return
  const percents = roundPercents(values, percentDigits(sample?.format ?? '0%'))
  const bottom = -geo.thickness
  const area: Rect = { x: geo.cx - geo.r, y: plot.y, w: 2 * geo.r, h: plot.h }
  let angle = (view.rotY * Math.PI) / 180
  const slices = values.map((v, i) => {
    const a0 = angle
    angle += (v / total) * Math.PI * 2
    const mid = (a0 + angle) / 2
    const e = (series.points.find((q) => q.index === i)?.explosion ?? series.explosion) * geo.r
    return { i, v, a0, a1: angle, mid, ox: Math.sin(mid) * e, oz: -Math.cos(mid) * e }
  })
  const order = [...slices].sort((a, b) => -Math.cos(a.mid) - -Math.cos(b.mid))
  for (const sl of order) {
    if (sl.v <= 0) continue
    const box = pointBox(series, sl.i)
    const { ox, oz } = sl
    // 径向侧面只在与相邻扇区的分离程度不同时露出。
    const n = slices.length
    for (const [a, other] of [
      [sl.a0, slices[(sl.i + n - 1) % n]!],
      [sl.a1, slices[(sl.i + 1) % n]!],
    ] as const) {
      if (other.ox === ox && other.oz === oz) continue
      const wall = polygon([
        project(geo, 0, 0, 0, ox, oz),
        project(geo, a, geo.r, 0, ox, oz),
        project(geo, a, geo.r, bottom, ox, oz),
        project(geo, 0, 0, bottom, ox, oz),
      ])
      fillPath(s, wall, wallFill(box.fill), area)
    }
    // 外侧面只有朝向观察者的半圈（3 点经 6 点至 9 点方向）可见。
    for (let k = -1; k <= 1; k++) {
      const lo = Math.max(sl.a0, Math.PI / 2 + k * 2 * Math.PI)
      const hi = Math.min(sl.a1, (3 * Math.PI) / 2 + k * 2 * Math.PI)
      if (hi <= lo) continue
      const top = arcPoints(geo, lo, hi, 0, ox, oz)
      const side = polygon([...top, ...arcPoints(geo, hi, lo, bottom, ox, oz)])
      fillPath(s, side, sideFill(box.fill), area)
      const edges: Segment[] = []
      for (const a of [lo, hi]) {
        // 只在扇区边界处画竖直分隔线，半圈的端点处不画。
        if (a !== sl.a0 && a !== sl.a1) continue
        const p = project(geo, a, geo.r, 0, ox, oz)
        const q = project(geo, a, geo.r, bottom, ox, oz)
        edges.push({ kind: 'move', x: p.x, y: p.y }, { kind: 'line', x: q.x, y: q.y })
      }
      strokePath(s, edges, box.line, area)
    }
    const face = polygon([
      project(geo, 0, 0, 0, ox, oz),
      ...arcPoints(geo, sl.a0, sl.a1, 0, ox, oz),
    ])
    fillPath(s, face, topFill(box.fill), area)
    strokePath(s, face, box.line, area)
  }
  for (const sl of slices) {
    const labels = labelsAt(series, sl.i)
    if (labels === null || sl.v <= 0) continue
    const c = project(geo, 0, 0, 0, sl.ox, sl.oz)
    spots.push({
      labels,
      series,
      index: sl.i,
      anchor: { x: c.x - geo.r, y: c.y - geo.r, w: 2 * geo.r, h: 2 * geo.r },
      percent: percents[sl.i] ?? 0,
      kind: 'slice',
      column: false,
      positive: true,
      slice: { cx: c.x, cy: c.y, r: geo.r, inner: 0, angle: sl.mid - Math.PI / 2, squash: geo.sin },
      marker: null,
    })
  }
}

// ── 坐标轴 ──

function paintGridlines(s: Scene): void {
  const plot = s.layout.plot
  for (const a of s.layout.axes) {
    const line = a.axis.majorGridlines
    if (line === null) continue
    const seg: Segment[] = []
    for (const t of a.ticks) {
      if (a.horizontal)
        seg.push({ kind: 'move', x: t, y: plot.y }, { kind: 'line', x: t, y: plot.y + plot.h })
      else seg.push({ kind: 'move', x: plot.x, y: t }, { kind: 'line', x: plot.x + plot.w, y: t })
    }
    strokePath(s, seg, line, plot)
  }
}

function paintAxes(s: Scene): void {
  const plot = s.layout.plot
  for (const a of s.layout.axes) {
    if (a.axis.deleted) continue
    const line = a.axis.line
    if (line !== null) {
      const seg: Segment[] = a.horizontal
        ? [
            { kind: 'move', x: plot.x, y: a.at },
            { kind: 'line', x: plot.x + plot.w, y: a.at },
          ]
        : [
            { kind: 'move', x: a.at, y: plot.y },
            { kind: 'line', x: a.at, y: plot.y + plot.h },
          ]
      const tick = a.axis.majorTickMark
      if (tick !== 'none') {
        // 刻度线朝外（远离绘图区）为正方向。
        const outward = a.horizontal
          ? a.axis.position === 't'
            ? -1
            : 1
          : a.axis.position === 'r'
            ? 1
            : -1
        const from = a.at + outward * (tick === 'out' ? 0 : -TICK)
        const to = a.at + outward * (tick === 'in' ? 0 : TICK)
        for (const t of a.ticks) {
          if (a.horizontal) seg.push({ kind: 'move', x: t, y: from }, { kind: 'line', x: t, y: to })
          else seg.push({ kind: 'move', x: from, y: t }, { kind: 'line', x: to, y: t })
        }
      }
      strokePath(s, seg, line, plot)
    }
    for (const l of a.labels) paintText(s, l)
  }
  for (const a of s.layout.axes) {
    if (a.title === null || a.axis.title === null) continue
    paintRotatedBox(s, a.title, a.axis.title.box)
    paintText(s, a.title)
  }
}

/** 文字框（含旋转）的填充与边框。 */
function paintRotatedBox(s: Scene, t: PlacedText, box: ChartBox): void {
  if (box.fill.kind === 'none' && box.line === null) return
  const a = (t.rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const corners: [number, number][] = [
    [0, 0],
    [t.width, 0],
    [t.width, t.height],
    [0, t.height],
  ]
  const pts = corners.map(([x, y]) => ({ x: t.x + x * cos - y * sin, y: t.y + x * sin + y * cos }))
  const seg: Segment[] = [
    ...pts.map((p, i): Segment => ({ kind: i === 0 ? 'move' : 'line', x: p.x, y: p.y })),
    { kind: 'close' },
  ]
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const bounds: Rect = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  }
  fillPath(s, seg, box.fill, bounds)
  strokePath(s, seg, box.line, bounds)
}

// ── 数据标签 ──

/** 百分比格式的小数位数：`0.0%` 为 1。 */
function percentDigits(code: string): number {
  const m = /\.(0+)%/.exec(code)
  return m === null ? 0 : m[1]!.length
}

/**
 * 数据标签文字框的左上角（实测）：柱形外端相距 5，横向条形外端相距 9.4（`inEnd`、`inBase` 在内侧以同样间距）；
 * 折线与散点的上方、下方、右侧（左侧）与标记边缘相距 7、7.9、9.6；
 * 饼图扇区内侧（`bestFit`、`inEnd`）的标签中心距圆心 半径 − 径向半宽 − 7，外侧（`outEnd`）为 半径 + 径向半宽 + 11，
 * 径向半宽为文字框沿半径方向的投影的一半；`ctr` 与圆环在半径（环宽）中点。
 */
function placeLabel(spot: LabelSpot, w: number, h: number): { x: number; y: number } {
  const a = spot.anchor
  const x = a.x + a.w / 2 - w / 2
  const y = a.y + a.h / 2 - h / 2
  const pos = spot.labels.position
  if (spot.kind === 'bar') {
    if (pos !== 'outEnd' && pos !== 'inEnd' && pos !== 'inBase') return { x, y }
    // 沿数值方向：`start` 为条形的基线端，`end` 为数据端；`out` 为远离基线的方向。
    if (spot.column) {
      const end = spot.positive ? a.y : a.y + a.h
      const start = spot.positive ? a.y + a.h : a.y
      const out = spot.positive ? -1 : 1
      const edge =
        pos === 'outEnd' ? end + out * 5 : pos === 'inEnd' ? end - out * 5 : start + out * 5
      const toward = pos === 'inEnd' ? -out : out
      return { x, y: toward < 0 ? edge - h : edge }
    }
    const end = spot.positive ? a.x + a.w : a.x
    const start = spot.positive ? a.x : a.x + a.w
    const out = spot.positive ? 1 : -1
    const edge =
      pos === 'outEnd' ? end + out * 9.4 : pos === 'inEnd' ? end - out * 9.4 : start + out * 9.4
    const toward = pos === 'inEnd' ? -out : out
    return { x: toward < 0 ? edge - w : edge, y }
  }
  if (spot.kind === 'point') {
    const half = ((spot.marker?.size ?? 0) * PX_PER_PT) / 2
    if (pos === 't') return { x, y: a.y - half - 7 - h }
    if (pos === 'b') return { x, y: a.y + half + 7.9 }
    if (pos === 'l') return { x: a.x - half - 9.6 - w, y }
    if (pos === 'r') return { x: a.x + half + 9.6, y }
    return { x, y }
  }
  const sl = spot.slice
  if (sl === null) return { x, y }
  const cos = Math.cos(sl.angle)
  const sin = Math.sin(sl.angle)
  const radial = (Math.abs(cos) * w + Math.abs(sin) * h) / 2
  let dist = sl.r - radial - 7
  if (pos === 'outEnd') dist = sl.r + radial + 11
  else if (sl.inner > 0) dist = (sl.r + sl.inner) / 2
  else if (pos === 'ctr') dist = sl.r / 2
  return { x: sl.cx + cos * dist - w / 2, y: sl.cy + sin * dist * sl.squash - h / 2 }
}

function paintDataLabels(s: Scene, spots: readonly LabelSpot[]): void {
  for (const spot of spots) {
    const text = dataLabelText(spot.labels, spot.series, spot.index, spot.percent, s.date1904)
    if (text === '') continue
    const m = measure(labelBody(text, spot.labels.text.run), s.settings)
    const { x, y } = placeLabel(spot, m.width, m.height)
    paintBox(s, { x, y, w: m.width, h: m.height }, spot.labels.box)
    paintText(s, { layout: m.layout, x, y, width: m.width, height: m.height, rotation: 0 })
  }
}

// ── 图例、图表区与标题 ──

function paintLegend(s: Scene, chart: Chart): void {
  const legend = s.layout.legend
  if (legend === null || chart.legend === null) return
  paintBox(s, legend.box, chart.legend.box)
  for (const e of legend.entries) {
    const r = e.symbol
    const box = e.point === null ? e.series.box : pointBox(e.series, e.point)
    if (e.group.type === 'line' || e.group.type === 'scatter') {
      const cy = r.y + r.h / 2
      if (e.group.lines) {
        strokePath(
          s,
          [
            { kind: 'move', x: r.x, y: cy },
            { kind: 'line', x: r.x + r.w, y: cy },
          ],
          box.line,
          r,
        )
      }
      const marker = e.point === null ? e.series.marker : pointMarker(e.series, e.point)
      if (marker !== null) paintMarker(s, marker, r.x + r.w / 2, cy)
    } else {
      paintBox(s, r, box)
    }
    paintText(s, e.text)
  }
}

function roundedRect(w: number, h: number): Segment[] {
  const k = Math.min(CORNER, w / 2, h / 2)
  const arc = (cx: number, cy: number, start: number, x: number, y: number): Segment => ({
    kind: 'arc',
    cx,
    cy,
    rx: k,
    ry: k,
    start,
    end: start + Math.PI / 2,
    anticlockwise: false,
    x,
    y,
  })
  return [
    { kind: 'move', x: k, y: 0 },
    { kind: 'line', x: w - k, y: 0 },
    arc(w - k, k, -Math.PI / 2, w, k),
    { kind: 'line', x: w, y: h - k },
    arc(w - k, h - k, 0, w - k, h),
    { kind: 'line', x: k, y: h },
    arc(k, h - k, Math.PI / 2, 0, h - k),
    { kind: 'line', x: 0, y: k },
    arc(k, k, Math.PI, k, 0),
    { kind: 'close' },
  ]
}

function chartArea(s: Scene, chart: Chart): void {
  const r: Rect = { x: 0, y: 0, w: s.layout.width, h: s.layout.height }
  const seg = chart.roundedCorners ? roundedRect(r.w, r.h) : rectSegments(r)
  fillPath(s, seg, chart.box.fill, r)
  strokePath(s, seg, chart.box.line, r)
}

/**
 * 绘制图表。`frame` 为图形框（EMU），`parent` 为外层坐标（EMU ÷ 9525）到设备坐标的变换。
 * 没有排版设置（缺少字体）时不绘制：图表的布局依赖文字度量。
 */
export function paintChart(scene: ShapeScene, chart: Chart, frame: Frame, parent: Matrix): void {
  const settings = scene.settings
  if (settings === null || frame.width <= 0 || frame.height <= 0) return
  const placed = placeFrame(frame, parent)
  const layout = layoutChart(chart, frame.width / EMU_PER_PX, frame.height / EMU_PER_PX, settings)
  const s: Scene = {
    base: scene,
    settings,
    matrix: multiply(placed.matrix, translation(0.5, 0.5)),
    layout,
    date1904: chart.date1904,
  }
  scene.ctx.save()
  chartArea(s, chart)
  paintBox(s, layout.plot, chart.plot.box)
  paintGridlines(s)
  const spots: LabelSpot[] = []
  for (const g of chart.plot.groups) {
    if (g.type === 'pie' && g.threeD && chart.view3D !== null) {
      paintPie3D(s, g, chart.view3D, spots)
      continue
    }
    if (g.type === 'pie' || g.type === 'doughnut') {
      paintPie(s, g, spots)
      continue
    }
    const m = mapping(s, g)
    if (m === null) continue
    if (g.type === 'bar') paintBars(s, g, m, spots)
    else paintLines(s, g, m, spots, chart.blanks)
  }
  paintAxes(s)
  paintDataLabels(s, spots)
  paintLegend(s, chart)
  const title = layout.title
  if (title !== null && chart.title !== null) {
    paintBox(s, { x: title.x, y: title.y, w: title.width, h: title.height }, chart.title.box)
    paintText(s, title)
  }
  scene.ctx.restore()
}
