/**
 * 工作表绘制：给定工作表上的一块像素区域，绘制到 Canvas 2D 上下文。只访问区域内（以及可能溢出进来的）单元格。
 *
 * 坐标：第 c 列的左网格线位于 x = X_c（`cols.offset(c)`），该列占 [X_c, X_{c+1})；行同理。
 * 绘制顺序与覆盖规则（对照 WPS 屏幕显示）：
 * 1. 白色底。
 * 2. 网格线（`showGridLines` 为真时），颜色 `#e6e6e6`。与有填充的单元格相邻的线段、合并区域内部的线段、
 *    被溢出文字覆盖的竖线段不画。
 * 3. 填充：覆盖单元格内部及其右侧、下侧网格线；左侧（上侧）相邻单元格也有填充时同时覆盖左侧（上侧）网格线。
 *    按行优先顺序绘制，两个填充单元格之间的线取后绘制者的颜色。
 * 4. 数据条，5. 边框（同一条边两侧都指定时取较粗者），6. 文字，7. 绘图对象（图片、形状与图表，按锚点在绘图部件中的顺序，
 *    形状见 `shapes.ts`，图表见 `../../drawingml/chart/paint.ts`，图表区即锚点矩形），8. 自动筛选按钮。
 */

import { paintChart } from '../../drawingml/chart/paint.ts'
import {
  type CreateCanvas,
  type PaintContext as DrawingContext,
  type Matrix,
  multiply,
  type PaintImage,
  translation,
} from '../../drawingml/paint/context.ts'
import { deviceScale } from '../../drawingml/paint/fill.ts'
import type { ShapeScene } from '../../drawingml/shape/paint.ts'
import type { FaceCache } from '../../drawingml/text/fonts.ts'
import { emboldenBitmap } from '../../font/index.ts'
import { fillBitmap } from '../../glyph/bitmap.ts'
import type {
  BorderLine,
  BorderLineStyle,
  Cell,
  CellBorder,
  CellFill,
  CellRange,
  CellStyle,
  DrawingAnchor,
  FontStyle,
  SheetChart,
  Workbook,
  Worksheet,
} from '../model.ts'
import { type CellBox, type CellTextLayout, cellContent, layoutCell } from './cell-text.ts'
import { type CfEffect, ConditionalFormats } from './conditional.ts'
import type { FaceSegment, FontSet, LoadedFace } from './fonts.ts'
import { buildGeometry, type SheetGeometry } from './geometry.ts'
import {
  chartFaces,
  type PlacedShape,
  paintShapeNode,
  placeShape,
  type Rect,
  shapeFaces,
} from './shapes.ts'
import type { TextRun } from './text.ts'

/**
 * 绘制所需的 Canvas 2D 接口子集；浏览器的 `CanvasRenderingContext2D` 与 `OffscreenCanvasRenderingContext2D` 都满足。
 * `getTransform` 取得调用方设置的缩放与设备像素比：形状按绝对变换绘制，须以它为基准。
 */
export interface PaintContext extends DrawingContext {
  getTransform(): Matrix
}

export interface SheetResources {
  /** 与 `sheet.images` 逐项对应的已解码图片（`ImageBitmap`、`HTMLImageElement` 等），未解码完成或无法解码的为 `null`。 */
  readonly images: readonly (PaintImage | null)[]
  /** 形状的阴影、图案与复合线条所需的图层；浏览器中为 `(w, h) => new OffscreenCanvas(w, h)`。 */
  readonly createCanvas: CreateCanvas
}

/** 绘图对象按上下次序排列：图片为 `sheet.images` 的下标，形状已换算到工作表坐标，图表附锚点矩形（工作表像素）。 */
export type SheetDrawing =
  | { readonly kind: 'image'; readonly index: number }
  | { readonly kind: 'shape'; readonly shape: PlacedShape }
  | { readonly kind: 'chart'; readonly chart: SheetChart; readonly rect: Rect }

export interface SheetScene {
  readonly workbook: Workbook
  readonly sheet: Worksheet
  readonly geometry: SheetGeometry
  readonly fonts: FontSet
  readonly conditional: ConditionalFormats
  /** 单元格所在的合并区域。 */
  mergeAt(row: number, col: number): CellRange | null
  /** 单元格的生效样式下标：单元格自身、行默认样式、列默认样式依次取第一个指定的。 */
  styleAt(row: number, col: number): number
  readonly drawings: readonly SheetDrawing[]
  /** 形状文字的字体；字体集中没有可用字体时为 `null`，形状文字不绘制。 */
  readonly faces: FaceCache | null
  /** 图表文字的字体（见 `chartFaces`）；为 `null` 时图表不绘制。 */
  readonly chartFaces: FaceCache | null
}

const GRID_COLOR = '#e6e6e6'
const WHITE = '#ffffff'
const EMU_PER_PX = 9525
/** 溢出文字向两侧最多查找的列数，与 `cell-text.ts` 的上限一致。 */
const SPILL_WINDOW = 64

export function createScene(workbook: Workbook, sheet: Worksheet, fonts: FontSet): SheetScene {
  const geometry = buildGeometry(workbook, sheet, fonts)
  const merges = new Map<number, CellRange[]>()
  for (const m of sheet.merges) {
    for (let r = m.top; r <= m.bottom; r++) {
      const list = merges.get(r) ?? []
      list.push(m)
      merges.set(r, list)
    }
  }
  const colStyles = sheet.cols.filter((c) => c.style !== null)
  const faces = sheet.shapes.length > 0 ? shapeFaces(workbook, fonts) : null
  const chartText = sheet.charts.length > 0 ? chartFaces(workbook, fonts) : null
  const rectOf = (anchor: DrawingAnchor) => anchorRect(geometry, anchor)
  const ordered: { order: number; drawing: SheetDrawing }[] = [
    ...sheet.images.map((img, index) => ({
      order: img.order,
      drawing: { kind: 'image' as const, index },
    })),
    ...sheet.shapes.map((s) => ({
      order: s.order,
      drawing: { kind: 'shape' as const, shape: placeShape(s, rectOf) },
    })),
    ...sheet.charts.map((c) => ({
      order: c.order,
      drawing: { kind: 'chart' as const, chart: c, rect: rectOf(c.anchor) },
    })),
  ]
  ordered.sort((a, b) => a.order - b.order)
  return {
    workbook,
    sheet,
    geometry,
    fonts,
    drawings: ordered.map((d) => d.drawing),
    faces,
    chartFaces: chartText,
    conditional: new ConditionalFormats(workbook, sheet),
    mergeAt(row, col) {
      const list = merges.get(row)
      if (!list) return null
      for (const m of list) if (col >= m.left && col <= m.right) return m
      return null
    },
    styleAt(row, col) {
      const cell = sheet.cells.get(row)?.get(col)
      if (cell) return cell.style
      const rowStyle = sheet.rows.get(row)?.style
      if (rowStyle !== null && rowStyle !== undefined) return rowStyle
      for (const c of colStyles) if (col >= c.min && col <= c.max) return c.style!
      return 0
    },
  }
}

export interface PaintRegion {
  /** 工作表像素坐标中的区域。 */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface CellInfo {
  readonly style: CellStyle
  readonly fill: CellFill | null
  readonly border: CellBorder | null
  readonly effect: CfEffect | null
  readonly merge: CellRange | null
  readonly cell: Cell | undefined
}

/**
 * 把工作表区域 `region` 绘制到画布上 `(originX, originY)` 起的位置，绘制范围为区域宽高再加 1 像素
 * （包含右侧与下侧的网格线）。坐标按调用方设置的变换（缩放与设备像素比）施加。
 */
export function paintRegion(
  ctx: PaintContext,
  scene: SheetScene,
  region: PaintRegion,
  res: SheetResources,
  originX = 0,
  originY = 0,
): void {
  const { cols, rows } = scene.geometry
  const { sheet } = scene
  const base = ctx.getTransform()
  const tx = (x: number) => originX + x - region.x
  const ty = (y: number) => originY + y - region.y
  const c0 = cols.indexAt(region.x)
  const c1 = cols.indexAt(region.x + region.width)
  const r0 = rows.indexAt(region.y)
  const r1 = rows.indexAt(region.y + region.height)

  ctx.save()
  ctx.beginPath()
  ctx.rect(originX, originY, region.width + 1, region.height + 1)
  ctx.clip()
  if ('fontKerning' in ctx) ctx.fontKerning = 'none'
  ctx.fillStyle = WHITE
  ctx.fillRect(originX, originY, region.width + 1, region.height + 1)

  // 区域外一圈的单元格也取信息：相邻填充决定网格线，相邻边框参与同一条边的取舍。
  const info = new Map<number, CellInfo>()
  const key = (r: number, c: number) => r * 16_384 + c
  const infoAt = (r: number, c: number): CellInfo => {
    const k = key(r, c)
    let v = info.get(k)
    if (!v) {
      v = cellInfo(scene, r, c)
      info.set(k, v)
    }
    return v
  }
  const filled = (r: number, c: number) => r >= 0 && c >= 0 && infoAt(r, c).fill !== null

  // 文字布局先于网格线：溢出的文字覆盖其越过的竖线。
  const layouts: CellTextLayout[] = []
  const covered = new Map<number, [number, number][]>()
  for (let r = r0; r <= r1; r++) {
    if (rows.size(r) <= 0) continue
    const line = sheet.cells.get(r)
    if (!line) continue
    for (const [c, cell] of line) {
      if (c < c0 - SPILL_WINDOW || c > c1 + SPILL_WINDOW || !cell.value) continue
      if (cols.size(c) <= 0) continue
      const m = scene.mergeAt(r, c)
      if (m && (m.top !== r || m.left !== c)) continue
      const layout = layoutText(scene, infoAt(r, c), r, c, m)
      if (!layout) continue
      if (layout.lastCol < c0 || layout.firstCol > c1) continue
      layouts.push(layout)
      if (layout.lastCol > layout.firstCol) {
        const spans = covered.get(r) ?? []
        spans.push([layout.firstCol, layout.lastCol])
        covered.set(r, spans)
      }
    }
  }
  // 合并区域的左上角在区域之上或之左时，其文字仍需绘制。
  for (const m of sheet.merges) {
    if (m.bottom < r0 || m.top > r1 || m.right < c0 || m.left > c1) continue
    if (m.top >= r0 && m.left >= c0) continue
    const cell = sheet.cells.get(m.top)?.get(m.left)
    if (!cell?.value) continue
    const layout = layoutText(scene, infoAt(m.top, m.left), m.top, m.left, m)
    if (layout) layouts.push(layout)
  }

  if (sheet.view.showGridLines) {
    drawGridLines(ctx, scene, { r0, r1, c0, c1 }, filled, covered, tx, ty)
  }
  drawFills(ctx, scene, { r0, r1, c0, c1 }, infoAt, filled, tx, ty)
  drawBorders(ctx, scene, { r0, r1, c0, c1 }, infoAt, tx, ty)
  for (const layout of layouts) drawText(ctx, layout, tx, ty)
  drawDrawings(ctx, scene, res, { base, region, originX, originY })
  if (sheet.autoFilter) drawFilterButtons(ctx, scene, sheet.autoFilter, { r0, r1, c0, c1 }, tx, ty)
  ctx.restore()
}

export interface PaintView {
  /** 可滚动窗格相对其起点（冻结行列之后）的滚动量，工作表像素。 */
  readonly scrollX: number
  readonly scrollY: number
  /** 可见区域的宽高，工作表像素。缩放与设备像素比由调用方以画布变换施加。 */
  readonly width: number
  readonly height: number
}

/** 打开工作表时的滚动量：可滚动窗格的左上角为 `view.topLeft`。 */
export function initialScroll(scene: SheetScene): { scrollX: number; scrollY: number } {
  const { cols, rows } = scene.geometry
  const v = scene.sheet.view
  return {
    scrollX: Math.max(0, cols.offset(v.topLeft.col) - cols.offset(v.frozenCols)),
    scrollY: Math.max(0, rows.offset(v.topLeft.row) - rows.offset(v.frozenRows)),
  }
}

const FREEZE_LINE = '#9e9e9e'

/**
 * 按冻结窗格分四块绘制可见区域：冻结的行与列固定，其余随滚动量移动；冻结边界画一条细线。
 */
export function paintView(
  ctx: PaintContext,
  scene: SheetScene,
  view: PaintView,
  res: SheetResources,
): void {
  const { cols, rows } = scene.geometry
  const { frozenRows, frozenCols } = scene.sheet.view
  const fw = Math.min(view.width, cols.offset(frozenCols))
  const fh = Math.min(view.height, rows.offset(frozenRows))
  const restW = Math.max(0, view.width - fw)
  const restH = Math.max(0, view.height - fh)
  const scrollLeft = cols.offset(frozenCols) + view.scrollX
  const scrollTop = rows.offset(frozenRows) + view.scrollY
  if (restW > 0 && restH > 0) {
    paintRegion(
      ctx,
      scene,
      { x: scrollLeft, y: scrollTop, width: restW, height: restH },
      res,
      fw,
      fh,
    )
  }
  if (fh > 0 && restW > 0) {
    paintRegion(ctx, scene, { x: scrollLeft, y: 0, width: restW, height: fh }, res, fw, 0)
  }
  if (fw > 0 && restH > 0) {
    paintRegion(ctx, scene, { x: 0, y: scrollTop, width: fw, height: restH }, res, 0, fh)
  }
  if (fw > 0 && fh > 0) paintRegion(ctx, scene, { x: 0, y: 0, width: fw, height: fh }, res, 0, 0)
  ctx.fillStyle = FREEZE_LINE
  if (fh > 0) ctx.fillRect(0, fh, view.width, 1)
  if (fw > 0) ctx.fillRect(fw, 0, 1, view.height)
}

function cellInfo(scene: SheetScene, r: number, c: number): CellInfo {
  const { workbook, sheet } = scene
  const merge = scene.mergeAt(r, c)
  // 合并区域的填充取左上角单元格；边框按各单元格自身的样式（Excel 把边框写在边缘的每个单元格上）。
  const anchorRow = merge ? merge.top : r
  const anchorCol = merge ? merge.left : c
  const cell = sheet.cells.get(r)?.get(c)
  const own = workbook.styles[scene.styleAt(r, c)] ?? workbook.styles[0]!
  const anchorStyle = merge ? (workbook.styles[scene.styleAt(anchorRow, anchorCol)] ?? own) : own
  const anchorCell = merge ? sheet.cells.get(anchorRow)?.get(anchorCol) : cell
  const effect = scene.conditional.empty
    ? null
    : scene.conditional.at(anchorRow, anchorCol, anchorCell?.value ?? null)
  return {
    style: anchorStyle,
    fill: effect?.fill ?? anchorStyle.fill,
    border: mergeBorder(own.border, effect?.border ?? null),
    effect,
    merge,
    cell: anchorCell,
  }
}

function mergeBorder(base: CellBorder | null, over: CellBorder | null): CellBorder | null {
  if (!over) return base
  if (!base) return over
  return {
    left: over.left ?? base.left,
    right: over.right ?? base.right,
    top: over.top ?? base.top,
    bottom: over.bottom ?? base.bottom,
    diagonalUp: over.diagonalUp ?? base.diagonalUp,
    diagonalDown: over.diagonalDown ?? base.diagonalDown,
  }
}

function effectiveFont(style: CellStyle, effect: CfEffect | null): FontStyle {
  if (!effect) return style.font
  return {
    ...style.font,
    bold: effect.bold ?? style.font.bold,
    italic: effect.italic ?? style.font.italic,
    strike: effect.strike ?? style.font.strike,
    underline: effect.underline ?? style.font.underline,
  }
}

function layoutText(
  scene: SheetScene,
  info: CellInfo,
  r: number,
  c: number,
  merge: CellRange | null,
): CellTextLayout | null {
  const { cols, rows, mdw } = scene.geometry
  const value = info.cell?.value
  if (!value) return null
  const numFmt = info.effect?.numFmt ?? info.style.numFmt
  const content = cellContent(value, numFmt, scene.workbook)
  const lastCol = merge ? merge.right : c
  const lastRow = merge ? merge.bottom : r
  const sheet = scene.sheet
  const box: CellBox = {
    left: cols.offset(c),
    right: cols.offset(lastCol + 1),
    top: rows.offset(r),
    bottom: rows.offset(lastRow + 1),
    col: c,
    lastCol,
    merged: merge !== null,
    colLeft: (k) => cols.offset(k),
    colRight: (k) => cols.offset(k + 1),
    spillable: (k) => {
      if (k < 0) return false
      const other = sheet.cells.get(r)?.get(k)
      return !other?.value && scene.mergeAt(r, k) === null
    },
  }
  return layoutCell(
    {
      content,
      alignment: info.style.alignment,
      font: effectiveFont(info.style, info.effect),
      colorOverride: info.effect?.color ?? null,
      fonts: scene.fonts,
      indentUnit: 3 * mdw,
    },
    box,
  )
}

interface Range {
  readonly r0: number
  readonly r1: number
  readonly c0: number
  readonly c1: number
}

function insideMerge(m: CellRange | null, r: number, c: number): boolean {
  return m !== null && r >= m.top && r <= m.bottom && c >= m.left && c <= m.right
}

function drawGridLines(
  ctx: PaintContext,
  scene: SheetScene,
  range: Range,
  filled: (r: number, c: number) => boolean,
  covered: Map<number, [number, number][]>,
  tx: (x: number) => number,
  ty: (y: number) => number,
): void {
  const { cols, rows } = scene.geometry
  ctx.fillStyle = GRID_COLOR
  // 横线：第 r 行上沿，按列分段。
  for (let r = range.r0; r <= range.r1 + 1; r++) {
    const y = ty(rows.offset(r))
    for (let c = range.c0; c <= range.c1; c++) {
      const w = cols.size(c)
      if (w <= 0) continue
      if (filled(r - 1, c) || filled(r, c)) continue
      const m = scene.mergeAt(r, c)
      if (m && r > m.top && insideMerge(m, r - 1, c)) continue
      ctx.fillRect(tx(cols.offset(c)), y, w + 1, 1)
    }
  }
  // 竖线：第 c 列左沿，按行分段。
  for (let c = range.c0; c <= range.c1 + 1; c++) {
    const x = tx(cols.offset(c))
    for (let r = range.r0; r <= range.r1; r++) {
      const h = rows.size(r)
      if (h <= 0) continue
      if (filled(r, c - 1) || filled(r, c)) continue
      const m = scene.mergeAt(r, c)
      if (m && c > m.left && insideMerge(m, r, c - 1)) continue
      const spans = covered.get(r)
      if (spans?.some(([a, b]) => c > a && c <= b)) continue
      ctx.fillRect(x, ty(rows.offset(r)), 1, h + 1)
    }
  }
}

const PATTERN_DENSITY: Record<string, number> = {
  darkGray: 0.75,
  mediumGray: 0.5,
  lightGray: 0.25,
  gray125: 0.125,
  gray0625: 0.0625,
  darkHorizontal: 0.5,
  darkVertical: 0.5,
  darkDown: 0.5,
  darkUp: 0.5,
  darkGrid: 0.5,
  darkTrellis: 0.75,
  lightHorizontal: 0.25,
  lightVertical: 0.25,
  lightDown: 0.25,
  lightUp: 0.25,
  lightGrid: 0.4,
  lightTrellis: 0.4,
}

function mix(bg: string, fg: string, t: number): string {
  const a = Number.parseInt(bg.slice(1), 16)
  const b = Number.parseInt(fg.slice(1), 16)
  const ch = (s: number) => Math.round(((a >> s) & 0xff) * (1 - t) + ((b >> s) & 0xff) * t)
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}

/**
 * 图案填充以前景色按图案的覆盖比例与背景色混合后的纯色近似：像素级图案在 100% 缩放下与混合色的平均亮度一致。
 */
function fillStyleOf(
  ctx: PaintContext,
  fill: CellFill,
  x: number,
  y: number,
  w: number,
  h: number,
): unknown {
  if (fill.kind === 'pattern') {
    return fill.pattern === 'solid'
      ? fill.fg
      : mix(fill.bg, fill.fg, PATTERN_DENSITY[fill.pattern] ?? 0.5)
  }
  if (fill.type === 'path') {
    const stops = fill.stops
    return stops[stops.length - 1]?.color ?? WHITE
  }
  const rad = (fill.degree * Math.PI) / 180
  const cx = x + w / 2
  const cy = y + h / 2
  const dx = (Math.cos(rad) * w) / 2
  const dy = (Math.sin(rad) * h) / 2
  const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy)
  for (const s of fill.stops) g.addColorStop(Math.min(1, Math.max(0, s.position)), s.color)
  return g
}

function drawFills(
  ctx: PaintContext,
  scene: SheetScene,
  range: Range,
  infoAt: (r: number, c: number) => CellInfo,
  filled: (r: number, c: number) => boolean,
  tx: (x: number) => number,
  ty: (y: number) => number,
): void {
  const { cols, rows } = scene.geometry
  const done = new Set<CellRange>()
  for (let r = range.r0; r <= range.r1; r++) {
    if (rows.size(r) <= 0) continue
    for (let c = range.c0; c <= range.c1; c++) {
      if (cols.size(c) <= 0) continue
      const info = infoAt(r, c)
      const m = info.merge
      if (m) {
        if (done.has(m)) continue
        done.add(m)
      }
      const top = m ? m.top : r
      const left = m ? m.left : c
      const bottom = m ? m.bottom : r
      const right = m ? m.right : c
      if (info.fill) {
        const x0 = cols.offset(left) + (filled(top, left - 1) ? 0 : 1)
        const y0 = rows.offset(top) + (filled(top - 1, left) ? 0 : 1)
        const x1 = cols.offset(right + 1)
        const y1 = rows.offset(bottom + 1)
        const x = tx(x0)
        const y = ty(y0)
        ctx.fillStyle = fillStyleOf(ctx, info.fill, x, y, x1 - x0 + 1, y1 - y0 + 1)
        ctx.fillRect(x, y, x1 - x0 + 1, y1 - y0 + 1)
      }
      const bar = info.effect?.bar
      if (bar)
        drawDataBar(
          ctx,
          bar,
          tx(cols.offset(left)),
          ty(rows.offset(top)),
          cols.offset(right + 1) - cols.offset(left),
          rows.offset(bottom + 1) - rows.offset(top),
        )
    }
  }
}

/** 数据条：长度为单元格宽度的 10%–90%，自左向右由条形色渐变为白色。 */
function drawDataBar(
  ctx: PaintContext,
  bar: { ratio: number; color: string },
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const length = Math.max(1, (w - 4) * (0.1 + 0.8 * bar.ratio))
  const g = ctx.createLinearGradient(x + 2, 0, x + 2 + length, 0)
  g.addColorStop(0, bar.color)
  g.addColorStop(1, WHITE)
  ctx.fillStyle = g
  ctx.fillRect(x + 2, y + 2, length, Math.max(1, h - 3))
}

const STYLE_RANK: Record<BorderLineStyle, number> = {
  hair: 1,
  dotted: 2,
  dashDotDot: 3,
  dashDot: 4,
  dashed: 5,
  thin: 6,
  mediumDashDotDot: 7,
  slantDashDot: 8,
  mediumDashDot: 9,
  mediumDashed: 10,
  medium: 11,
  thick: 12,
  double: 13,
}

function stronger(a: BorderLine | null, b: BorderLine | null): BorderLine | null {
  if (!a) return b
  if (!b) return a
  return STYLE_RANK[b.style] > STYLE_RANK[a.style] ? b : a
}

/** 线宽与相对网格线像素的起始偏移。 */
function lineGeometry(style: BorderLineStyle): { width: number; offset: number } {
  switch (style) {
    case 'medium':
    case 'mediumDashed':
    case 'mediumDashDot':
    case 'mediumDashDotDot':
    case 'slantDashDot':
      return { width: 2, offset: 0 }
    case 'thick':
    case 'double':
      return { width: 3, offset: -1 }
    default:
      return { width: 1, offset: 0 }
  }
}

/** 虚线图案：交替的实线与空白长度（像素），空数组为实线。 */
function dashPattern(style: BorderLineStyle): number[] {
  switch (style) {
    case 'hair':
    case 'dotted':
      return [1, 1]
    case 'dashed':
      return [3, 1]
    case 'mediumDashed':
      return [9, 3]
    case 'dashDot':
      return [9, 3, 3, 3]
    case 'mediumDashDot':
    case 'slantDashDot':
      return [9, 3, 3, 3]
    case 'dashDotDot':
    case 'mediumDashDotDot':
      return [9, 3, 3, 3, 3, 3]
    default:
      return []
  }
}

/** 画一条水平或竖直的边框线；`x`、`y` 为网格线像素，`length` 沿线方向。 */
function drawLine(
  ctx: PaintContext,
  line: BorderLine,
  horizontal: boolean,
  x: number,
  y: number,
  length: number,
): void {
  ctx.fillStyle = line.color
  const { width, offset } = lineGeometry(line.style)
  if (line.style === 'double') {
    for (const d of [-1, 1]) {
      if (horizontal) ctx.fillRect(x, y + d, length, 1)
      else ctx.fillRect(x + d, y, 1, length)
    }
    return
  }
  const dash = dashPattern(line.style)
  if (dash.length === 0) {
    if (horizontal) ctx.fillRect(x, y + offset, length, width)
    else ctx.fillRect(x + offset, y, width, length)
    return
  }
  let pos = 0
  let i = 0
  while (pos < length) {
    const seg = Math.min(dash[i % dash.length]!, length - pos)
    if (i % 2 === 0) {
      if (horizontal) ctx.fillRect(x + pos, y + offset, seg, width)
      else ctx.fillRect(x + offset, y + pos, width, seg)
    }
    pos += dash[i % dash.length]!
    i++
  }
}

function drawBorders(
  ctx: PaintContext,
  scene: SheetScene,
  range: Range,
  infoAt: (r: number, c: number) => CellInfo,
  tx: (x: number) => number,
  ty: (y: number) => number,
): void {
  const { cols, rows } = scene.geometry
  const borderOf = (r: number, c: number): CellBorder | null =>
    r < 0 || c < 0 ? null : infoAt(r, c).border
  // 横边：第 r 行上沿。
  for (let r = range.r0; r <= range.r1 + 1; r++) {
    const y = ty(rows.offset(r))
    for (let c = range.c0; c <= range.c1; c++) {
      const w = cols.size(c)
      if (w <= 0) continue
      const m = scene.mergeAt(r, c)
      if (m && r > m.top && insideMerge(m, r - 1, c)) continue
      const line = stronger(borderOf(r - 1, c)?.bottom ?? null, borderOf(r, c)?.top ?? null)
      if (line) drawLine(ctx, line, true, tx(cols.offset(c)), y, w + 1)
    }
  }
  // 竖边：第 c 列左沿。
  for (let c = range.c0; c <= range.c1 + 1; c++) {
    const x = tx(cols.offset(c))
    for (let r = range.r0; r <= range.r1; r++) {
      const h = rows.size(r)
      if (h <= 0) continue
      const m = scene.mergeAt(r, c)
      if (m && c > m.left && insideMerge(m, r, c - 1)) continue
      const line = stronger(borderOf(r, c - 1)?.right ?? null, borderOf(r, c)?.left ?? null)
      if (line) drawLine(ctx, line, false, x, ty(rows.offset(r)), h + 1)
    }
  }
  // 对角线：按合并区域或单元格的矩形。
  for (let r = range.r0; r <= range.r1; r++) {
    for (let c = range.c0; c <= range.c1; c++) {
      const b = borderOf(r, c)
      if (!b || (!b.diagonalUp && !b.diagonalDown)) continue
      const m = infoAt(r, c).merge
      if (m && (m.top !== r || m.left !== c)) continue
      const x0 = tx(cols.offset(c)) + 0.5
      const y0 = ty(rows.offset(r)) + 0.5
      const x1 = tx(cols.offset((m ? m.right : c) + 1)) + 0.5
      const y1 = ty(rows.offset((m ? m.bottom : r) + 1)) + 0.5
      for (const [line, up] of [
        [b.diagonalUp, true],
        [b.diagonalDown, false],
      ] as const) {
        if (!line) continue
        ctx.strokeStyle = line.color
        ctx.lineWidth = lineGeometry(line.style).width
        ctx.beginPath()
        ctx.moveTo(x0, up ? y1 : y0)
        ctx.lineTo(x1, up ? y0 : y1)
        ctx.stroke()
      }
    }
  }
}

function fontCss(font: FontStyle, px: number, css: string): string {
  return `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${px}px ${css}`
}

function drawText(
  ctx: PaintContext,
  layout: CellTextLayout,
  tx: (x: number) => number,
  ty: (y: number) => number,
): void {
  const { clip } = layout
  ctx.save()
  ctx.beginPath()
  ctx.rect(
    tx(clip.left) + 1,
    ty(clip.top) + 1,
    clip.right - clip.left - 1,
    clip.bottom - clip.top - 1,
  )
  ctx.clip()
  if (layout.rotate) {
    const { angle, cx, cy } = layout.rotate
    ctx.translate(tx(cx), ty(cy))
    ctx.rotate((-angle * Math.PI) / 180)
    ctx.translate(-tx(cx), -ty(cy))
  }
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  for (const f of layout.fragments) {
    const { run } = f
    const shift =
      run.font.vertAlign === 'superscript'
        ? -run.px * 0.6
        : run.font.vertAlign === 'subscript'
          ? run.px * 0.25
          : 0
    ctx.fillStyle = f.color
    // 字形起点取整到像素，与 WPS 的像素对齐排版一致。
    const x = Math.round(tx(f.x))
    const y = ty(f.y) + shift
    // 逐段指定字体：缺字回退与合成粗体的加宽都按排版测宽的结果放置，不交给浏览器的回退。
    let sx = x
    const ppem = Math.round(run.px)
    for (const seg of run.chain.segments(f.text, run.px)) {
      const face = seg.face
      if (face?.bitmaps && !layout.rotate && face.bitmaps.screenMode(ppem, run.font.italic)) {
        drawBitmapSegment(ctx, run, seg, face, Math.round(sx), Math.round(y), ppem)
      } else if (face && !layout.rotate && hasPixelAdvances(face, seg.text, ppem)) {
        drawPositioned(ctx, run, seg, Math.round(sx), y)
      } else {
        ctx.font = fontCss(run.font, run.px, seg.css)
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${seg.letterSpacing}px`
        ctx.fillText(seg.text, Math.round(sx), y)
      }
      sx += seg.width
    }
    const u = run.font.underline
    if (u !== 'none') {
      const uy = Math.round(y + Math.max(1, run.px * 0.1))
      ctx.fillRect(x, uy, f.width, 1)
      if (u === 'double' || u === 'doubleAccounting') ctx.fillRect(x, uy + 2, f.width, 1)
    }
    if (run.font.strike) ctx.fillRect(x, Math.round(y - run.px * 0.3), f.width, 1)
  }
  ctx.restore()
}

/**
 * 以内嵌点阵逐字绘制一段文字（WPS 经 GDI 在 ClearType 下的点阵模式，见 `EmbeddedBitmaps.screenMode`）。
 * 字符位置按排版宽度累加，与测宽一致；字体没有粗体字形时点阵按 GDI 的方式加粗。
 * strike 中没有点阵的字形以 `fillText` 绘制：GDI 此时不做平滑，Canvas 无法关闭文字平滑，两者不一致。
 */
function drawBitmapSegment(
  ctx: PaintContext,
  run: TextRun,
  seg: FaceSegment,
  face: LoadedFace,
  x0: number,
  baseline: number,
  ppem: number,
): void {
  const bitmaps = face.bitmaps!
  const { ascent, descent } = face.vertical(ppem)
  const embolden = run.font.bold && !face.bold
  let x = x0
  for (const ch of seg.text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32) continue
    const raw = bitmaps.glyph(ppem, face.metrics.glyphId(cp))
    if (raw) {
      fillBitmap(
        ctx,
        embolden ? emboldenBitmap(raw) : raw,
        Math.round(x),
        baseline,
        ascent,
        descent,
      )
    } else {
      ctx.font = fontCss(run.font, run.px, seg.css)
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${seg.letterSpacing}px`
      ctx.fillText(ch, Math.round(x), baseline)
    }
    x += run.chain.charWidth(cp, run.px)
  }
}

/** 这一段的每个字符都有整数前进宽度（见 `LoadedFace.pixelAdvance`）。 */
function hasPixelAdvances(face: LoadedFace, text: string, ppem: number): boolean {
  for (const ch of text) if (face.pixelAdvance(ch.codePointAt(0)!, ppem) === null) return false
  return true
}

/**
 * 逐字绘制在整数前进宽度累加得到的位置上（GDI 的字形位置）。不要改为整段 `fillText`：浏览器按线性宽度连续排列字形，
 * 与整数宽度累加的位置逐字偏离。
 */
function drawPositioned(
  ctx: PaintContext,
  run: TextRun,
  seg: FaceSegment,
  x0: number,
  y: number,
): void {
  ctx.font = fontCss(run.font, run.px, seg.css)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  let x = x0
  for (const ch of seg.text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32) continue
    ctx.fillText(ch, x, y)
    x += run.chain.charWidth(cp, run.px)
  }
}

/** 锚点换算为工作表像素矩形。 */
export function anchorRect(geometry: SheetGeometry, a: DrawingAnchor): Rect {
  const { cols, rows } = geometry
  if (a.kind === 'absolute') {
    return {
      x: a.x / EMU_PER_PX,
      y: a.y / EMU_PER_PX,
      width: a.width / EMU_PER_PX,
      height: a.height / EMU_PER_PX,
    }
  }
  const x = cols.offset(a.from.col) + a.from.colOff / EMU_PER_PX
  const y = rows.offset(a.from.row) + a.from.rowOff / EMU_PER_PX
  if (a.kind === 'oneCell')
    return { x, y, width: a.width / EMU_PER_PX, height: a.height / EMU_PER_PX }
  const x2 = cols.offset(a.to.col) + a.to.colOff / EMU_PER_PX
  const y2 = rows.offset(a.to.row) + a.to.rowOff / EMU_PER_PX
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) }
}

/** 区域在画布上的位置与调用方设置的变换。 */
interface Placement {
  readonly base: Matrix
  readonly region: PaintRegion
  readonly originX: number
  readonly originY: number
}

function intersects(a: Rect, region: PaintRegion): boolean {
  return (
    a.x <= region.x + region.width + 1 &&
    a.x + a.width >= region.x &&
    a.y <= region.y + region.height + 1 &&
    a.y + a.height >= region.y
  )
}

function drawDrawings(
  ctx: PaintContext,
  scene: SheetScene,
  res: SheetResources,
  at: Placement,
): void {
  const dx = at.originX - at.region.x
  const dy = at.originY - at.region.y
  let shapes: { scene: ShapeScene; parent: Matrix } | null = null
  let charts: { scene: ShapeScene; parent: Matrix } | null = null
  for (const d of scene.drawings) {
    if (d.kind === 'image') {
      drawImage(ctx, scene, d.index, res.images[d.index] ?? null, dx, dy)
      continue
    }
    if (d.kind === 'chart') {
      if (!intersects(d.rect, at.region)) continue
      charts ??= shapeScene(ctx, res, at, scene.chartFaces)
      const r = d.rect
      const frame = {
        x: r.x * EMU_PER_PX,
        y: r.y * EMU_PER_PX,
        width: r.width * EMU_PER_PX,
        height: r.height * EMU_PER_PX,
        rotation: 0,
        flipH: false,
        flipV: false,
      }
      paintChart(charts.scene, d.chart.chart, frame, charts.parent)
      continue
    }
    if (!intersects(d.shape.bounds, at.region)) continue
    shapes ??= shapeScene(ctx, res, at, scene.faces)
    paintShapeNode(shapes.scene, d.shape.node, shapes.parent)
  }
}

/**
 * 形状绘制的上下文：工作表像素经区域平移与调用方的变换换算为设备坐标；图层边界以区域右下角的设备坐标为限。
 * 形状的图片填充不绘制（已计入未显示的图片）。
 */
function shapeScene(
  ctx: PaintContext,
  res: SheetResources,
  at: Placement,
  faces: FaceCache | null,
): { scene: ShapeScene; parent: Matrix } {
  const { base, region, originX, originY } = at
  const right = originX + region.width + 1
  const bottom = originY + region.height + 1
  return {
    scene: {
      ctx,
      res: { image: () => null, createCanvas: res.createCanvas },
      scale: deviceScale(base),
      canvas: {
        width: Math.ceil(base.a * right + base.c * bottom + base.e),
        height: Math.ceil(base.b * right + base.d * bottom + base.f),
      },
      settings: faces === null ? null : { faces, slideNumber: null },
    },
    parent: multiply(base, translation(originX - region.x, originY - region.y)),
  }
}

function drawImage(
  ctx: PaintContext,
  scene: SheetScene,
  index: number,
  img: PaintImage | null,
  dx: number,
  dy: number,
): void {
  const spec = scene.sheet.images[index]
  if (!spec || !img || img.width === 0 || img.height === 0) return
  const rect = anchorRect(scene.geometry, spec.anchor)
  if (rect.width <= 0 || rect.height <= 0) return
  const { left, top, right, bottom } = spec.crop
  const sx = img.width * left
  const sy = img.height * top
  const sw = img.width * Math.max(0, 1 - left - right)
  const sh = img.height * Math.max(0, 1 - top - bottom)
  if (sw <= 0 || sh <= 0) return
  ctx.drawImage(img, sx, sy, sw, sh, rect.x + dx, rect.y + dy, rect.width, rect.height)
}

/** 自动筛选按钮：15 像素见方，位于标题行每个单元格的右下角，灰色边框、白底、向下的三角形。 */
function drawFilterButtons(
  ctx: PaintContext,
  scene: SheetScene,
  area: CellRange,
  range: Range,
  tx: (x: number) => number,
  ty: (y: number) => number,
): void {
  const { cols, rows } = scene.geometry
  const r = area.top
  if (r < range.r0 || r > range.r1 || rows.size(r) <= 0) return
  const size = 15
  for (let c = Math.max(area.left, range.c0); c <= Math.min(area.right, range.c1); c++) {
    if (cols.size(c) <= 0) continue
    const x = tx(cols.offset(c + 1)) - size
    const y = ty(rows.offset(r + 1)) - size
    ctx.fillStyle = '#dbdbdb'
    ctx.fillRect(x, y, size, size)
    ctx.fillStyle = WHITE
    ctx.fillRect(x + 1, y + 1, size - 2, size - 2)
    ctx.fillStyle = '#109968'
    ctx.beginPath()
    ctx.moveTo(x + 4, y + 6)
    ctx.lineTo(x + 11, y + 6)
    ctx.lineTo(x + 7.5, y + 9.5)
    ctx.closePath()
    ctx.fill()
  }
}
