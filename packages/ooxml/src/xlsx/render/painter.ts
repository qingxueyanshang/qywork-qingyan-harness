/**
 * 工作表绘制：给定工作表上的一块像素区域，绘制到 Canvas 2D 上下文。只访问区域内（以及可能溢出进来的）单元格。
 *
 * 坐标：第 c 列的左网格线位于 x = X_c（`cols.offset(c)`），该列占 [X_c, X_{c+1})；行同理。
 * 绘制顺序与覆盖规则（对照 WPS 屏幕显示）：
 * 1. 白色底。
 * 2. 网格线（`showGridLines` 为真时），颜色 `#e6e6e6`。与有填充的单元格相邻的线段、合并区域内部的线段、
 *    被溢出文字覆盖的竖线段不画。
 * 3. 填充：覆盖单元格内部及其四周的网格线，区域左沿（上沿）恰为网格线时不覆盖该线。按填充分组绘制，
 *    组的先后为区域内按行优先首次出现的先后，两种填充之间的线因此取后出现者的颜色（与两格的左右上下位置无关）。
 * 4. 数据条，5. 边框（同一条边两侧都指定时取较粗者），6. 文字，7. 绘图对象（图片、形状与图表，按锚点在绘图部件中的顺序，
 *    形状见 `shapes.ts`，图表见 `../../drawingml/chart/paint.ts`，图表区即锚点矩形），8. 自动筛选按钮。
 * 图片（位图与图元文件）按 `../../drawingml/paint/picture.ts` 的 `drawPicture` 绘制到锚点矩形，位图的插值质量为 `medium`。
 */

import { paintChart } from '../../drawingml/chart/paint.ts'
import {
  type CreateCanvas,
  type PaintContext as DrawingContext,
  type Matrix,
  multiply,
  translation,
} from '../../drawingml/paint/context.ts'
import { deviceScale } from '../../drawingml/paint/fill.ts'
import { drawPicture, type PaintPicture } from '../../drawingml/paint/picture.ts'
import type { ShapeScene } from '../../drawingml/shape/paint.ts'
import type { FaceCache } from '../../drawingml/text/fonts.ts'
import { emboldenBitmap } from '../../font/index.ts'
import { fillBitmap } from '../../glyph/bitmap.ts'
import {
  type ClearTypeDisplay,
  type DeviceRect,
  type GlyphRun,
  type PixelCanvas,
  type PlacedGlyph,
  paintGlyphRuns,
} from '../../glyph/cleartype/index.ts'
import type { MetafileFonts } from '../../metafile/index.ts'
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
  metafileFonts,
  type PlacedShape,
  paintShapeNode,
  placeShape,
  type Rect,
  shapeFaces,
  sheetClearType,
} from './shapes.ts'
import type { TextRun } from './text.ts'

/**
 * 绘制所需的 Canvas 2D 接口子集；浏览器的 `CanvasRenderingContext2D` 与 `OffscreenCanvasRenderingContext2D` 都满足。
 * `getTransform` 取得调用方设置的缩放与设备像素比：形状按绝对变换绘制，须以它为基准。
 * `SheetResources.clearType` 不为 `null` 时单元格、形状与图表文字读写画布像素（`getImageData`、`putImageData`），
 * 画布宜以 `willReadFrequently: true` 创建。
 */
export interface PaintContext extends DrawingContext, PixelCanvas {
  getTransform(): Matrix
}

export interface SheetResources {
  /** 与 `sheet.images` 逐项对应的已解码图片（`decodePicture`），未解码完成或无法解码的为 `null`。 */
  readonly images: readonly (PaintPicture | null)[]
  /** 形状的阴影、图案与复合线条所需的图层；浏览器中为 `(w, h) => new OffscreenCanvas(w, h)`。 */
  readonly createCanvas: CreateCanvas
  /**
   * 显示器的 ClearType 设置。不为 `null` 时 TrueType 字体的单元格文字（见 `clearTypeRun`）与形状、图表文字的平滑字号
   * （见 `./shapes.ts` 的 `sheetClearType`）以 ClearType 字形绘制，为 `null` 时以浏览器字体绘制。
   */
  readonly clearType: ClearTypeDisplay | null
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
  /** 图片中图元文件文字的字体（见 `metafileFonts`）；为 `null` 时含文字的图元文件不绘制。 */
  readonly metafileFonts: MetafileFonts | null
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
  const pictureText = sheet.images.length > 0 ? metafileFonts(workbook, fonts) : null
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
    metafileFonts: pictureText,
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
  drawFills(ctx, scene, { r0, r1, c0, c1 }, region, infoAt, tx, ty)
  drawBorders(ctx, scene, { r0, r1, c0, c1 }, infoAt, tx, ty, originX, originY)
  // ClearType 字形读写画布像素：各单元格的字形收集后一次混合，在边框之后、绘图对象之前。
  const runs: GlyphRun[] | null = res.clearType ? [] : null
  const bounds: DeviceRect = {
    left: originX,
    top: originY,
    right: originX + region.width + 1,
    bottom: originY + region.height + 1,
  }
  for (const layout of layouts) drawText(ctx, layout, tx, ty, bounds, runs)
  if (runs && runs.length > 0) paintGlyphRuns(ctx, runs, res.clearType!)
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

/**
 * 填充按 `CellFill` 对象分组，组按首次出现的先后绘制（`Map` 保持插入顺序）。不要改回逐格绘制：
 * 两种填充之间的线归后出现的那一组，与哪一格在左（上）无关，逐格绘制总是归右（下）侧。
 * WPS 屏幕显示实测（构造文件经 `Range.CopyPicture`）：交换两格位置、交换 fillId 与 xf 的顺序、改变缩放比例、
 * 隐藏网格线都不改变归属，只有改变区域内首次出现的先后才改变。
 * 边界：一行中多种填充连续相间（构造文件中整行逐列轮换三种颜色）时 WPS 的竖线归左侧单元格，不符合本规则，机制未查明。
 * 数据条在全部填充之后绘制，位于单元格内侧 2 像素以内，不受相邻填充覆盖。
 */
function drawFills(
  ctx: PaintContext,
  scene: SheetScene,
  range: Range,
  region: PaintRegion,
  infoAt: (r: number, c: number) => CellInfo,
  tx: (x: number) => number,
  ty: (y: number) => number,
): void {
  const { cols, rows } = scene.geometry
  const done = new Set<CellRange>()
  const groups = new Map<CellFill, { x0: number; y0: number; x1: number; y1: number }[]>()
  const bars: {
    bar: { ratio: number; color: string }
    left: number
    top: number
    right: number
    bottom: number
  }[] = []
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
        const x0 = cols.offset(left)
        const y0 = rows.offset(top)
        const rects = groups.get(info.fill) ?? []
        rects.push({
          x0: x0 === region.x ? x0 + 1 : x0,
          y0: y0 === region.y ? y0 + 1 : y0,
          x1: cols.offset(right + 1),
          y1: rows.offset(bottom + 1),
        })
        groups.set(info.fill, rects)
      }
      const bar = info.effect?.bar
      if (bar) bars.push({ bar, left, top, right, bottom })
    }
  }
  for (const [fill, rects] of groups) {
    for (const { x0, y0, x1, y1 } of rects) {
      const x = tx(x0)
      const y = ty(y0)
      ctx.fillStyle = fillStyleOf(ctx, fill, x, y, x1 - x0 + 1, y1 - y0 + 1)
      ctx.fillRect(x, y, x1 - x0 + 1, y1 - y0 + 1)
    }
  }
  for (const { bar, left, top, right, bottom } of bars) {
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

/**
 * 线宽与相对网格线像素的起始偏移。WPS 屏幕显示实测（四条边相同）：中粗类线占网格线及其上方或左方 1 像素，
 * 粗线与双线以网格线为中心，其余占网格线。
 */
function lineGeometry(style: BorderLineStyle): { width: number; offset: number } {
  switch (style) {
    case 'medium':
    case 'mediumDashed':
    case 'mediumDashDot':
    case 'mediumDashDotDot':
    case 'slantDashDot':
      return { width: 2, offset: -1 }
    case 'thick':
    case 'double':
      return { width: 3, offset: -1 }
    default:
      return { width: 1, offset: 0 }
  }
}

/** 虚线图案：周期与周期内的实线段 `[起点, 长度]`（像素），`null` 为实线。 */
interface Dash {
  readonly period: number
  readonly on: readonly (readonly [number, number])[]
}

/** 斜点划线的下一行（竖线为右一列）：上一行各段左移 1 像素并缩短 1 像素，形成斜切的段端。 */
const SLANT_LOWER: Dash = {
  period: 18,
  on: [
    [-1, 10],
    [11, 4],
  ],
}

/**
 * WPS 屏幕显示实测（构造文件经 `Range.CopyPicture`）：图案沿整条线连续，不在单元格边界重新开始；
 * 相位以绘制区域的左沿（竖线为上沿）之后 1 像素为周期起点，与工作表坐标无关（同一条线换一个区域起点，图案随之平移）。
 * 斜点划线上一行（左一列）的图案与点划线相同，下一行见 `SLANT_LOWER`。
 */
function dashOf(style: BorderLineStyle): Dash | null {
  switch (style) {
    case 'hair':
      return { period: 2, on: [[1, 1]] }
    case 'dotted':
      return { period: 4, on: [[0, 2]] }
    case 'dashed':
      return { period: 4, on: [[0, 3]] }
    case 'mediumDashed':
      return { period: 12, on: [[0, 9]] }
    case 'dashDot':
    case 'mediumDashDot':
    case 'slantDashDot':
      return {
        period: 18,
        on: [
          [0, 9],
          [12, 3],
        ],
      }
    case 'dashDotDot':
    case 'mediumDashDotDot':
      return {
        period: 24,
        on: [
          [0, 9],
          [12, 3],
          [18, 3],
        ],
      }
    default:
      return null
  }
}

/** 线段 `[from, from + length)` 中属于图案实线段的部分；`origin` 为周期起点。 */
function dashRuns(dash: Dash, from: number, length: number, origin: number): [number, number][] {
  const runs: [number, number][] = []
  const end = from + length
  for (const [s, l] of dash.on) {
    for (let k = Math.floor((from - origin - s - l) / dash.period); ; k++) {
      const a = origin + s + k * dash.period
      if (a >= end) break
      const lo = Math.max(a, from)
      const hi = Math.min(a + l, end)
      if (hi > lo) runs.push([lo, hi - lo])
    }
  }
  return runs
}

/**
 * 画一条水平或竖直的边框线；`x`、`y` 为网格线像素，`length` 沿线方向，`origin` 为绘制区域沿线方向的起点像素。
 * 粗线两端各延长 1 像素（实测：单独一条粗线的墨迹比网格线两端各长 1 像素）。
 */
function drawLine(
  ctx: PaintContext,
  line: BorderLine,
  horizontal: boolean,
  x: number,
  y: number,
  length: number,
  origin: number,
): void {
  ctx.fillStyle = line.color
  const { width, offset } = lineGeometry(line.style)
  const rect = (along: number, across: number, size: number, thickness: number) => {
    if (horizontal) ctx.fillRect(along, y + across, size, thickness)
    else ctx.fillRect(x + across, along, thickness, size)
  }
  const start = horizontal ? x : y
  if (line.style === 'double') {
    rect(start, -1, length, 1)
    rect(start, 1, length, 1)
    return
  }
  if (line.style === 'thick') {
    rect(start - 1, offset, length + 2, width)
    return
  }
  const dash = dashOf(line.style)
  if (!dash) {
    rect(start, offset, length, width)
    return
  }
  if (line.style === 'slantDashDot') {
    for (const [a, n] of dashRuns(dash, start, length, origin + 1)) rect(a, -1, n, 1)
    for (const [a, n] of dashRuns(SLANT_LOWER, start, length, origin + 1)) rect(a, 0, n, 1)
    return
  }
  for (const [a, n] of dashRuns(dash, start, length, origin + 1)) rect(a, offset, n, width)
}

function drawBorders(
  ctx: PaintContext,
  scene: SheetScene,
  range: Range,
  infoAt: (r: number, c: number) => CellInfo,
  tx: (x: number) => number,
  ty: (y: number) => number,
  originX: number,
  originY: number,
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
      if (line) drawLine(ctx, line, true, tx(cols.offset(c)), y, w + 1, originX)
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
      if (line) drawLine(ctx, line, false, x, ty(rows.offset(r)), h + 1, originY)
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

function fontCss(font: FontStyle, px: number, css: string, bold = font.bold): string {
  return `${font.italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${css}`
}

/**
 * 字体没有粗体字形而要求粗体时，以常规字形在原位与右移 1 像素处各绘制一次（GDI 的合成粗体），不交给浏览器合成：
 * 浏览器的合成粗体向两侧加粗，墨迹左缘比 WPS 靠左 1 像素。经验规则：对比基准中宋体 8–22 磅、楷体 8–28 磅、
 * Times New Roman 14 磅粗体单元格的 SSIM 损失均下降；深色填充上的白色楷体 11 磅与宋体 9 磅粗体数字上升，原因未查明。
 */
function fillGlyphs(
  ctx: PaintContext,
  text: string,
  x: number,
  y: number,
  synthetic: boolean,
): void {
  ctx.fillText(text, x, y)
  if (synthetic) ctx.fillText(text, x + 1, y)
}

/** 画布矩形（调用方坐标）按变换 `m` 换算为设备像素矩形；`m` 只含缩放与平移。 */
function deviceRect(m: Matrix, r: DeviceRect): DeviceRect {
  return {
    left: m.a * r.left + m.e,
    top: m.d * r.top + m.f,
    right: m.a * r.right + m.e,
    bottom: m.d * r.bottom + m.f,
  }
}

function intersect(a: DeviceRect, b: DeviceRect): DeviceRect {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
}

/**
 * 绘制一个单元格的文字。`runs` 不为 `null` 时 ClearType 字形不在此绘制，按排版位置加入 `runs`，由调用方一次混合到画布像素；
 * `bounds` 为区域的裁剪矩形（调用方坐标）：像素的读写不受裁剪路径约束，按它与单元格的裁剪矩形另行裁剪。
 */
function drawText(
  ctx: PaintContext,
  layout: CellTextLayout,
  tx: (x: number) => number,
  ty: (y: number) => number,
  bounds: DeviceRect,
  runs: GlyphRun[] | null,
): void {
  const { clip } = layout
  const cell: DeviceRect = {
    left: tx(clip.left) + 1,
    top: ty(clip.top) + 1,
    right: tx(clip.right),
    bottom: ty(clip.bottom),
  }
  ctx.save()
  ctx.beginPath()
  ctx.rect(cell.left, cell.top, cell.right - cell.left, cell.bottom - cell.top)
  ctx.clip()
  if (layout.rotate) {
    const { angle, cx, cy } = layout.rotate
    ctx.translate(tx(cx), ty(cy))
    ctx.rotate((-angle * Math.PI) / 180)
    ctx.translate(-tx(cx), -ty(cy))
  }
  // 旋转的文字以浏览器字体绘制：ClearType 字形按设备像素的整数位置放置，不旋转。
  const glyphRuns = layout.rotate ? null : runs
  const m = ctx.getTransform()
  const deviceClip = glyphRuns ? intersect(deviceRect(m, cell), deviceRect(m, bounds)) : null
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
      if (face?.bitmaps && !layout.rotate && face.bitmaps.screenMode(ppem)) {
        drawBitmapSegment(ctx, run, seg, face, Math.round(sx), Math.round(y), ppem)
      } else if (glyphRuns && face?.clearType) {
        glyphRuns.push(clearTypeRun(m, { run, seg, face, x: sx, y, color: f.color }, deviceClip!))
      } else if (face && !layout.rotate && hasPixelAdvances(face, seg.text, ppem)) {
        drawPositioned(ctx, run, seg, Math.round(sx), y)
      } else {
        const synthetic = run.font.bold && face !== null && !face.bold
        ctx.font = fontCss(run.font, run.px, seg.css, run.font.bold && !synthetic)
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${seg.letterSpacing}px`
        fillGlyphs(ctx, seg.text, Math.round(sx), y, synthetic)
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
 * 以单色字形逐字绘制一段文字（WPS 经 GDI 在 ClearType 下的点阵模式，见 `EmbeddedBitmaps.screenMode`）：
 * strike 中的点阵、提示后光栅化的轮廓，要求斜体而字体没有斜体字形时为倾斜的轮廓。
 * 字符位置按排版宽度累加，与测宽一致；字体没有粗体字形时按 GDI 的方式加粗。
 * 取不到单色字形（字体没有 TrueType 轮廓）的字以 `fillText` 绘制。
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
  const oblique = run.font.italic && !face.italic
  let x = x0
  for (const ch of seg.text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32) continue
    const raw = bitmaps.glyph(ppem, face.metrics.glyphId(cp), oblique)
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
      ctx.font = fontCss(run.font, run.px, seg.css, run.font.bold && !embolden)
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
      fillGlyphs(ctx, ch, Math.round(x), baseline, embolden)
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
  const synthetic = run.font.bold && seg.face !== null && !seg.face.bold
  ctx.font = fontCss(run.font, run.px, seg.css, run.font.bold && !synthetic)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  let x = x0
  for (const ch of seg.text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32) continue
    fillGlyphs(ctx, ch, x, y, synthetic)
    x += run.chain.charWidth(cp, run.px)
  }
}

/** 一段同一字体的文字：排版位置 (`x`, `y`) 为调用方坐标，`color` 为 `#rrggbb`。 */
interface SegmentPlacement {
  readonly run: TextRun
  readonly seg: FaceSegment
  readonly face: LoadedFace
  readonly x: number
  readonly y: number
  readonly color: string
}

/**
 * 一段文字的 ClearType 字形（WPS 经 GDI 在平滑字号下的文字），见 `../../glyph/cleartype/`。
 * 字形按设备像素光栅化：ppem 为字号乘以变换的缩放后取整，字符原点为排版位置换算到设备像素后取整；单元格裁剪矩形之外、
 * 基线以上 `ascent`、以下 `descent` 之外的像素不绘制（与 GDI 相同）。字体没有粗体（斜体）字形时按 GDI 的方式合成。
 */
function clearTypeRun(m: Matrix, s: SegmentPlacement, clip: DeviceRect): GlyphRun {
  const { run, face } = s
  const glyphs = face.clearType!
  const ppem = Math.round(run.px * m.a)
  const { ascent, descent } = face.vertical(ppem)
  const bold = run.font.bold && !face.bold
  const oblique = run.font.italic && !face.italic
  const baseline = Math.round(m.d * s.y + m.f)
  const placed: PlacedGlyph[] = []
  let x = s.x
  for (const ch of s.seg.text) {
    const cp = ch.codePointAt(0)!
    if (cp < 32) continue
    placed.push({
      glyph: glyphs.glyph(face.metrics.glyphId(cp), ppem, bold, oblique),
      x: Math.round(m.a * x + m.e),
      baseline,
    })
    x += run.chain.charWidth(cp, run.px)
  }
  return {
    glyphs: placed,
    color: s.color,
    clip: intersect(clip, {
      left: -Infinity,
      top: baseline - ascent,
      right: Infinity,
      bottom: baseline + descent,
    }),
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

/**
 * 按上下次序绘制图片、形状与图表。形状文字与图表文字的字体（`shapeFaces`、`chartFaces`）在区域内第一个形状与图表处
 * 取得，字体集中没有可用字体时形状文字与图表不绘制；显示器使用 ClearType 时两者的平滑字号以 ClearType 字形绘制，
 * 像素裁到区域之内。
 */
function drawDrawings(
  ctx: PaintContext,
  scene: SheetScene,
  res: SheetResources,
  at: Placement,
): void {
  const dx = at.originX - at.region.x
  const dy = at.originY - at.region.y
  const { workbook, fonts } = scene
  const clearType =
    res.clearType === null
      ? null
      : sheetClearType(
          fonts,
          res.clearType,
          ctx,
          deviceRect(at.base, {
            left: at.originX,
            top: at.originY,
            right: at.originX + at.region.width + 1,
            bottom: at.originY + at.region.height + 1,
          }),
        )
  let shapes: { scene: ShapeScene; parent: Matrix } | null = null
  let charts: { scene: ShapeScene; parent: Matrix } | null = null
  for (const d of scene.drawings) {
    if (d.kind === 'image') {
      drawImage(ctx, scene, d.index, res.images[d.index] ?? null, dx, dy, at.base)
      continue
    }
    if (d.kind === 'chart') {
      if (!intersects(d.rect, at.region)) continue
      charts ??= shapeScene(ctx, res, at, chartFaces(workbook, fonts, clearType))
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
    shapes ??= shapeScene(ctx, res, at, shapeFaces(workbook, fonts, clearType))
    paintShapeNode(shapes.scene, d.shape.node, shapes.parent)
  }
}

/**
 * 形状绘制的上下文：工作表像素经区域平移与调用方的变换换算为设备坐标；图层边界以区域右下角的设备坐标为限。
 * 形状与图表的图片填充不绘制（已计入未显示的图片）。
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
      res: { image: () => null, createCanvas: res.createCanvas, metafileFonts: null },
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

/** 图片绘制到锚点矩形平移 (`dx`, `dy`) 处；`base` 为调用方设置的变换，即绘制时上下文的当前变换。 */
function drawImage(
  ctx: PaintContext,
  scene: SheetScene,
  index: number,
  picture: PaintPicture | null,
  dx: number,
  dy: number,
  base: Matrix,
): void {
  const spec = scene.sheet.images[index]
  if (!spec || !picture) return
  const rect = anchorRect(scene.geometry, spec.anchor)
  if (rect.width <= 0 || rect.height <= 0) return
  const target = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height }
  drawPicture(ctx, picture, spec.crop, target, base, 'medium', scene.metafileFonts)
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
