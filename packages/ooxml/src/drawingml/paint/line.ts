/**
 * 线条绘制：宽度、虚线、端点、连接、对齐、复合线与箭头，绘制在形状局部坐标中（单位为 96 dpi 像素）。
 *
 * - 线宽不足 1 个设备像素（含宽度为 0）时按 1 个设备像素绘制。
 * - 预设虚线的线段与间隔为线宽的倍数；自定义虚线（`custDash`）的比例同样乘以线宽。圆形与方形端点的虚线另见
 *   `dashPattern` 与 `setStroke`。
 * - `algn` 为 `in` 时线条位于路径内侧：裁剪到路径内部并以两倍线宽描边。
 * - 复合线：`dbl` 为 1 : 1 : 1 的两条线，`tri` 为 1 : 1 : 1 : 1 : 1 的三条线；`thickThin` 与 `thinThick`
 *   按 `dbl` 绘制（两侧粗细不同的线需要区分路径内外两侧，开放路径没有内外之分）。
 * - 箭头只画在开放路径上：`headEnd` 在第一条描边路径的起点，`tailEnd` 在最后一条描边路径的终点。
 *   箭头的宽与长为线宽的 2、3、5 倍（`sm`、`med`、`lg`），线宽小于 2 像素时按 2 像素计算；
 *   三角形、燕尾与开放箭头处的线条缩短到箭头底部，菱形与椭圆处不缩短。
 * - 线条填充不是纯色时，先在图层中描出线条，再以填充覆盖（`source-in`）；填充范围为形状框向外扩展半个线宽。
 */

import { colorToCss } from '../color.ts'
import type { Fill, Line, LineEnd } from '../fill.ts'
import { pathEnds, type Segment, type ShapePath, type Tangent } from '../geometry/path.ts'
import {
  IDENTITY,
  type Matrix,
  multiply,
  type PaintContext,
  setMatrix,
  translation,
} from './context.ts'
import {
  deviceScale,
  type FillArea,
  type PaintResources,
  paintFill,
  tracePath,
  traceRect,
} from './fill.ts'
import { pathBounds } from './shadow.ts'

const EMU_PER_PX = 9525

const DASHES: Readonly<Record<string, readonly number[]>> = {
  solid: [],
  dot: [1, 3],
  dash: [4, 3],
  lgDash: [8, 3],
  dashDot: [4, 3, 1, 3],
  lgDashDot: [8, 3, 1, 3],
  lgDashDotDot: [8, 3, 1, 3, 1, 3],
  sysDash: [3, 1],
  sysDot: [1, 1],
  sysDashDot: [3, 1, 1, 1],
  sysDashDotDot: [3, 1, 1, 1, 1, 1],
}

const END_SIZE = { sm: 2, med: 3, lg: 5 } as const
const MIN_END_BASE = 2

/** 线宽（局部单位），不小于 1 个设备像素。 */
export function lineWidth(line: Line, matrix: Matrix): number {
  return Math.max(line.width / EMU_PER_PX, 1 / deviceScale(matrix))
}

/**
 * Canvas 的虚线数组。圆形端点时每段连同两端的半圆仍为原长度、起点不变：线段缩短一个线宽、间隔加长一个线宽，
 * `sysDot` 因此是以线段起点为圆心、直径为线宽的圆点（WPS 演示实测 1–8 像素线宽的 6 种预设虚线）。
 * 不要直接用原长度：Canvas 把半圆加在每段两端之外，`sysDot` 的间隔被填满，画成实线。
 */
export function dashPattern(line: Line, width: number): number[] {
  const d = line.dash
  const unit =
    d.kind === 'preset' ? (DASHES[d.name] ?? []) : d.stops.flatMap((s) => [s.dash, s.space])
  const lengths = unit.map((v) => v * width)
  if (line.cap !== 'rnd') return lengths
  return lengths.map((v, i) => (i % 2 === 0 ? Math.max(0, v - width) : v + width))
}

function isClosed(segments: readonly Segment[]): boolean {
  return segments.at(-1)?.kind === 'close'
}

/**
 * 端点：方形端点只加在路径两端，虚线中各段两端平直（WPS 演示实测），虚线时改用 `butt`；Canvas 的 `square`
 * 会加在每一段上。未实现：方形端点的虚线在路径起点另向外延伸半个线宽。
 */
function setStroke(ctx: PaintContext, line: Line, width: number): void {
  const dash = dashPattern(line, width)
  ctx.lineWidth = width
  ctx.lineCap =
    line.cap === 'rnd' ? 'round' : line.cap === 'sq' && dash.length === 0 ? 'square' : 'butt'
  ctx.lineJoin = line.join
  ctx.miterLimit = line.miterLimit ?? 10
  ctx.setLineDash(dash)
}

interface EndShape {
  readonly tangent: Tangent
  readonly end: LineEnd
  /** 箭头指向的方向（弧度）。 */
  readonly angle: number
}

/** 线条缩短的距离（局部单位）。 */
function inset(end: LineEnd, width: number): number {
  const base = Math.max(width, MIN_END_BASE)
  const length = END_SIZE[end.length] * base
  if (end.type === 'triangle' || end.type === 'arrow') return length
  if (end.type === 'stealth') return length / 2
  return 0
}

/** 把路径首段（或末段）为直线时的端点沿线条方向移动 `d`。 */
function shorten(segments: readonly Segment[], atStart: boolean, d: number): Segment[] {
  const out = segments.slice()
  if (d <= 0) return out
  if (atStart) {
    const m = out[0]
    const next = out[1]
    if (m?.kind !== 'move' || next?.kind !== 'line') return out
    const len = Math.hypot(next.x - m.x, next.y - m.y)
    if (len <= d) return out
    out[0] = {
      kind: 'move',
      x: m.x + ((next.x - m.x) * d) / len,
      y: m.y + ((next.y - m.y) * d) / len,
    }
    return out
  }
  const last = out.at(-1)
  const prev = out.at(-2)
  if (last?.kind !== 'line' || prev === undefined || !('x' in prev)) return out
  const len = Math.hypot(last.x - prev.x, last.y - prev.y)
  if (len <= d) return out
  out[out.length - 1] = {
    kind: 'line',
    x: last.x - ((last.x - prev.x) * d) / len,
    y: last.y - ((last.y - prev.y) * d) / len,
  }
  return out
}

function traceEnd(ctx: PaintContext, shape: EndShape, width: number): 'fill' | 'stroke' {
  const base = Math.max(width, MIN_END_BASE)
  const w = END_SIZE[shape.end.width] * base
  const l = END_SIZE[shape.end.length] * base
  const { x, y } = shape.tangent
  const cos = Math.cos(shape.angle)
  const sin = Math.sin(shape.angle)
  // 箭头坐标系：尖端在原点，沿 +x 指向外侧。
  const at = (u: number, v: number): [number, number] => [
    x + u * cos - v * sin,
    y + u * sin + v * cos,
  ]
  ctx.beginPath()
  const poly = (pts: [number, number][]) => {
    for (const [i, [px, py]] of pts.entries()) {
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
  }
  switch (shape.end.type) {
    case 'triangle':
      poly([at(0, 0), at(-l, -w / 2), at(-l, w / 2)])
      ctx.closePath()
      return 'fill'
    case 'stealth':
      poly([at(0, 0), at(-l, -w / 2), at(-l / 2, 0), at(-l, w / 2)])
      ctx.closePath()
      return 'fill'
    case 'diamond':
      poly([at(l / 2, 0), at(0, -w / 2), at(-l / 2, 0), at(0, w / 2)])
      ctx.closePath()
      return 'fill'
    case 'oval':
      ctx.ellipse(x, y, l / 2, w / 2, shape.angle, 0, 2 * Math.PI, false)
      return 'fill'
    default:
      poly([at(-l, -w / 2), at(0, 0), at(-l, w / 2)])
      return 'stroke'
  }
}

/** 线条图形在局部坐标中描出（实色），供直接描边或作为图层遮罩。 */
function drawStroke(
  ctx: PaintContext,
  paths: readonly ShapePath[],
  line: Line,
  width: number,
  color: string,
): void {
  const stroked = paths.filter((p) => p.stroke && p.segments.length > 0)
  const firstPath = stroked[0]
  const lastPath = stroked.at(-1)
  const ends: EndShape[] = []
  const shortened = new Map<ShapePath, readonly Segment[]>()
  if (line.head && firstPath && !isClosed(firstPath.segments)) {
    const e = pathEnds(firstPath.segments)
    if (e !== null) {
      ends.push({ tangent: e.start, end: line.head, angle: e.start.angle + Math.PI })
      shortened.set(firstPath, shorten(firstPath.segments, true, inset(line.head, width)))
    }
  }
  if (line.tail && lastPath && !isClosed(lastPath.segments)) {
    const e = pathEnds(lastPath.segments)
    if (e !== null) {
      ends.push({ tangent: e.end, end: line.tail, angle: e.end.angle })
      const base = shortened.get(lastPath) ?? lastPath.segments
      shortened.set(lastPath, shorten(base, false, inset(line.tail, width)))
    }
  }
  ctx.strokeStyle = color
  ctx.fillStyle = color
  const compound = line.compound
  for (const p of stroked) {
    const segments = shortened.get(p) ?? p.segments
    if (line.align === 'in' && isClosed(segments)) {
      ctx.save()
      tracePath(ctx, segments)
      ctx.clip()
      strokeCompound(ctx, segments, line, width * 2, compound)
      ctx.restore()
    } else {
      strokeCompound(ctx, segments, line, width, compound)
    }
  }
  ctx.setLineDash([])
  for (const e of ends) {
    const mode = traceEnd(ctx, e, width)
    if (mode === 'fill') ctx.fill()
    else {
      ctx.lineWidth = width
      ctx.stroke()
    }
  }
}

function strokeCompound(
  ctx: PaintContext,
  segments: readonly Segment[],
  line: Line,
  width: number,
  compound: string,
): void {
  setStroke(ctx, line, width)
  tracePath(ctx, segments)
  ctx.stroke()
  if (compound === 'sng') return
  const gap = compound === 'tri' ? (width * 3) / 5 : width / 3
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.lineWidth = gap
  ctx.stroke()
  ctx.restore()
  if (compound === 'tri') {
    ctx.lineWidth = width / 5
    ctx.stroke()
  }
}

/**
 * 描绘形状的线条。`area` 为形状框与局部坐标到设备坐标的变换；`device` 为画布像素尺寸，
 * 用于限定图层大小。
 */
export function paintLine(
  ctx: PaintContext,
  paths: readonly ShapePath[],
  line: Line,
  area: FillArea,
  res: PaintResources,
  device: { width: number; height: number },
): void {
  const width = lineWidth(line, area.matrix)
  const fill: Fill = line.fill
  const solid = fill.kind === 'solid' ? colorToCss(fill.color) : null
  if (solid !== null && line.compound === 'sng') {
    setMatrix(ctx, area.matrix)
    drawStroke(ctx, paths, line, width, solid)
    return
  }
  const margin = width * 2 + Math.max(width, MIN_END_BASE) * END_SIZE.lg
  const box = pathBounds(paths, area.matrix, margin, device)
  if (box === null) return
  const layer = res.createCanvas(box.w, box.h)
  const c = layer.getContext('2d')
  if (c === null) return
  const local = multiply(translation(-box.x, -box.y), area.matrix)
  setMatrix(c, local)
  drawStroke(c, paths, line, width, solid ?? '#000')
  if (solid === null) {
    const fillLayer = res.createCanvas(box.w, box.h)
    const f = fillLayer.getContext('2d')
    if (f === null) return
    // 填充范围为形状框向外扩展半个线宽：水平或竖直的直线框高或框宽为 0，渐变仍有长度。
    const half = width / 2
    const fm = multiply(local, translation(-half, -half))
    setMatrix(f, fm)
    const fw = area.width + width
    const fh = area.height + width
    paintFill(
      f,
      () => traceRect(f, fw, fh, margin),
      fill,
      { width: fw, height: fh, matrix: fm },
      res,
    )
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.globalCompositeOperation = 'source-in'
    c.drawImage(fillLayer, 0, 0)
  }
  ctx.save()
  setMatrix(ctx, IDENTITY)
  ctx.drawImage(layer, box.x, box.y)
  ctx.restore()
}
