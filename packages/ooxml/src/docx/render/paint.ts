/**
 * 页面绘制：把一页分页结果绘制到 Canvas 2D 上下文。坐标按 `scale`（像素/磅）换算，96 dpi、100% 时为 4/3。
 *
 * 文字按 WPS 屏幕显示（GDI）的方式绘制：
 * - 字号取整数像素（ppem = round(字号 × scale)）；每个字形的位置为排版坐标换算后四舍五入到整像素，逐字绘制，
 *   不交给浏览器连续排列（浏览器按线性宽度排列，与排版位置逐字偏离）。
 * - 字体在该 ppem 有内嵌点阵且处于点阵模式（`EmbeddedBitmaps.screenMode`）时以点阵绘制，仿粗体按 GDI 的方式加粗；
 *   strike 中没有的字形以轮廓绘制。
 * 页面的绘制顺序：白底、页面背景（底色与整页图片）、衬于文字下方的浮动对象、页面边框、页眉页脚与正文、其余浮动对象。
 * 段落内：段落底纹、字符填充（突出显示与底纹）、文字、下划线与删除线、段落边框、图片。
 * 表格：单元格底纹、单元格内容、边框线；没有边框的边画表格虚框（WPS 屏幕显示：1 像素 #c8c8c8，按页面像素坐标
 * 每 4 像素中的第 4 个留空）。浮动对象的形状与图片经 `../../drawingml/` 绘制，文本框的文字按本文件的规则绘制。
 */

import type { CreateCanvas, PaintContext, PaintImage } from '../../drawingml/paint/context.ts'
import { multiply, scaling, translation } from '../../drawingml/paint/context.ts'
import { paintAutoShape, paintGroup, type ShapeScene } from '../../drawingml/shape/paint.ts'
import { emboldenBitmap } from '../../font/index.ts'
import { fillBitmap } from '../../glyph/bitmap.ts'
import type { DrawingNode } from '../model.ts'
import type {
  BorderLine,
  FaceRef,
  Page,
  PageEdge,
  PageFloat,
  PageFragment,
  PageItem,
  PageParagraph,
} from '../page/model.ts'
import type { DocxFace } from './fonts.ts'

/** 绘制所需的 Canvas 2D 接口：与 DrawingML 形状绘制共用。 */
export type PageContext = PaintContext

/** 已解码的图片（`ImageBitmap` 等），尺寸为像素。 */
export type PageBitmap = PaintImage

/** 绘制用的图片与图层。 */
export interface PageResources {
  /** 与 `DocumentPages.images` 一一对应；未加载或无法解码时为 `null`。 */
  readonly images: readonly (PageBitmap | null)[]
  /** 与 `images` 对应的图片部件名。 */
  readonly parts: readonly string[]
  readonly createCanvas: CreateCanvas
}

export interface PageFonts {
  /** 分页结果中字形的登记表（`DocumentPages.faces`）。 */
  readonly faces: readonly FaceRef[]
  /** 按登记的族名与字形取得绘制用的字体；主机没有时为 `null`，该字形按族名交给浏览器绘制。 */
  draw(ref: FaceRef): DocxFace | null
}

/** 96 dpi、100% 显示时每磅的像素数。 */
export const SCREEN_SCALE = 4 / 3

/**
 * `paintPage` 绘制该页时读取的图片（`PageResources.images` 的下标）：页面背景、段落与单元格中的图片、
 * 浮动对象（含组合内）的图片填充与文本框中的图片。修改 `paintPage` 读取图片的范围时同步修改此处。
 */
export function pageImages(page: Page, parts: readonly string[]): number[] {
  const out = new Set<number>()
  if (page.background?.image != null) out.add(page.background.image)
  const items = (list: readonly PageItem[]) => {
    for (const it of list) {
      if (it.kind === 'table') items(it.items)
      else for (const im of it.images) out.add(im.image)
    }
  }
  const node = (n: DrawingNode) => {
    if (n.kind === 'group') {
      for (const c of n.children) node(c)
      return
    }
    const part = n.fill.kind === 'picture' ? n.fill.image.part : null
    const i = part === null ? -1 : parts.indexOf(part)
    if (i >= 0) out.add(i)
  }
  for (const list of [page.header, page.body, page.footer]) items(list)
  for (const f of page.floats) {
    items(f.items)
    if (f.drawing !== null) node(f.drawing)
  }
  return [...out]
}

function quote(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`
}

function cssFont(ref: FaceRef, ppem: number): string {
  const italic = ref.italic || ref.syntheticItalic ? 'italic ' : ''
  const bold = ref.bold || ref.syntheticBold ? 'bold ' : ''
  return `${italic}${bold}${ppem}px ${quote(ref.family)}`
}

export function paintPage(
  ctx: PageContext,
  page: Page,
  fonts: PageFonts,
  res: PageResources,
  scale: number = SCREEN_SCALE,
): void {
  const width = Math.ceil(page.width * scale)
  const height = Math.ceil(page.height * scale)
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  if ('fontKerning' in ctx) ctx.fontKerning = 'none'
  const bg = page.background
  if (bg !== null) {
    if (bg.color !== null) {
      ctx.fillStyle = bg.color
      ctx.fillRect(0, 0, width, height)
    }
    const bmp = bg.image === null ? null : res.images[bg.image]
    if (bmp && bmp.width > 0 && bmp.height > 0) {
      const tw = bmp.width * 0.75 * scale
      const th = bmp.height * 0.75 * scale
      for (let ty = 0; ty < height; ty += th)
        for (let tx = 0; tx < width; tx += tw)
          ctx.drawImage(bmp, Math.round(tx), Math.round(ty), Math.round(tw), Math.round(th))
    }
  }
  const scene: ShapeScene = {
    ctx,
    res: {
      image: (part) => {
        const i = res.parts.indexOf(part)
        return i < 0 ? null : (res.images[i] ?? null)
      },
      createCanvas: res.createCanvas,
    },
    scale: scale * 0.75,
    canvas: { width, height },
    settings: null,
  }
  for (const f of page.floats) if (f.behind) paintFloat(scene, f, fonts, res, scale)
  if (page.borders !== null) paintPageBorders(ctx, page.borders, scale)
  for (const items of [page.header, page.footer, page.body])
    paintItems(ctx, items, fonts, res, scale)
  for (const f of page.floats) if (!f.behind) paintFloat(scene, f, fonts, res, scale)
  ctx.restore()
}

/** 浮动对象：形状与图片的局部坐标为 96 dpi 像素，原点为对象框左上角。 */
function paintFloat(
  scene: ShapeScene,
  f: PageFloat,
  fonts: PageFonts,
  res: PageResources,
  scale: number,
): void {
  const ctx = scene.ctx
  if (f.drawing !== null) {
    ctx.save()
    const parent = multiply(
      translation(f.x * scale, f.y * scale),
      scaling(scale * 0.75, scale * 0.75),
    )
    paintNode(scene, f.drawing, parent)
    ctx.restore()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
  paintItems(ctx, f.items, fonts, res, scale)
}

function paintNode(
  scene: ShapeScene,
  n: DrawingNode,
  parent: ReturnType<typeof translation>,
): void {
  if (n.kind === 'group') {
    paintGroup(scene, n, parent, (inner, m) => {
      for (const c of n.children) paintNode(inner, c, m)
    })
    return
  }
  paintAutoShape(scene, { ...n, text: null }, parent)
}

function paintItems(
  ctx: PageContext,
  items: readonly PageItem[],
  fonts: PageFonts,
  res: PageResources,
  scale: number,
): void {
  const px = (v: number) => Math.round(v * scale)
  for (const item of items) {
    if (item.kind === 'table') {
      for (const fill of item.fills) {
        ctx.fillStyle = fill.color
        ctx.fillRect(
          px(fill.x),
          px(fill.y),
          px(fill.x + fill.width) - px(fill.x),
          px(fill.y + fill.height) - px(fill.y),
        )
      }
      paintItems(ctx, item.items, fonts, res, scale)
      for (const e of item.edges) if (e.line === null) paintGridline(ctx, e, scale)
      for (const e of item.edges) if (e.line !== null) paintEdge(ctx, e, e.line, scale)
      continue
    }
    if (item.box?.fill) {
      const b = item.box
      ctx.fillStyle = b.fill
      ctx.fillRect(px(b.x), px(b.y), px(b.x + b.width) - px(b.x), px(b.y + b.height) - px(b.y))
    }
    paintFills(ctx, item, scale)
    for (const line of item.lines) for (const f of line.fragments) paintText(ctx, f, fonts, scale)
    for (const line of item.lines)
      for (const f of line.fragments) paintDecorations(ctx, f, fonts, scale)
    if (item.box) paintBorders(ctx, item, scale)
    for (const im of item.images) {
      const bmp = res.images[im.image]
      if (!bmp || bmp.width === 0 || bmp.height === 0) continue
      ctx.drawImage(
        bmp,
        px(im.x),
        px(im.y),
        px(im.x + im.width) - px(im.x),
        px(im.y + im.height) - px(im.y),
      )
    }
  }
}

/** 突出显示与字符底纹：覆盖行的全高，横向为片段的范围。 */
function paintFills(ctx: PageContext, item: PageParagraph, scale: number): void {
  const px = (v: number) => Math.round(v * scale)
  for (const line of item.lines) {
    for (const f of line.fragments) {
      if (f.fill === null) continue
      const width = f.advances.reduce((a, b) => a + b, 0)
      ctx.fillStyle = f.fill
      ctx.fillRect(
        px(f.x),
        px(line.top),
        px(f.x + width) - px(f.x),
        px(line.top + line.height) - px(line.top),
      )
    }
  }
}

function paintText(ctx: PageContext, f: PageFragment, fonts: PageFonts, scale: number): void {
  const ref = fonts.faces[f.face]
  if (ref === undefined) return
  const face = fonts.draw(ref)
  const ppem = Math.round(f.size * scale)
  const baseline = Math.round(f.baseline * scale)
  ctx.fillStyle = f.color
  const bitmapMode = face?.bitmaps?.screenMode(ppem, ref.italic || ref.syntheticItalic)
  const vertical = bitmapMode ? face!.pixelVertical(ppem) : null
  ctx.font = cssFont(ref, ppem)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  let x = f.x
  let k = 0
  for (const ch of f.text) {
    const cp = ch.codePointAt(0)!
    const advance = f.advances[k++] ?? 0
    const gx = Math.round(x * scale)
    x += advance
    if (cp < 32) continue
    if (bitmapMode) {
      const raw = face!.bitmaps!.glyph(ppem, face!.text.metrics.glyphId(cp))
      if (raw) {
        fillBitmap(
          ctx,
          ref.syntheticBold ? emboldenBitmap(raw) : raw,
          gx,
          baseline,
          vertical!.ascent,
          vertical!.descent,
        )
        continue
      }
    }
    ctx.fillText(ch, gx, baseline)
  }
}

/** 下划线与删除线：位置与粗细取字号的比例，单线为 1 像素。 */
function paintDecorations(
  ctx: PageContext,
  f: PageFragment,
  fonts: PageFonts,
  scale: number,
): void {
  if (f.underline === null && f.strike === null) return
  const width = f.advances.reduce((a, b) => a + b, 0)
  const x0 = Math.round(f.x * scale)
  const x1 = Math.round((f.x + width) * scale)
  const ppem = Math.round(f.size * scale)
  const baseline = Math.round(f.baseline * scale)
  const ref = fonts.faces[f.face]
  const face = ref ? fonts.draw(ref) : null
  const descent = face ? face.pixelVertical(ppem).descent : Math.round(ppem * 0.2)
  if (f.underline !== null) {
    const u = f.underline
    const thick = u.style === 'thick' ? Math.max(2, Math.round(ppem / 12)) : 1
    const y = baseline + Math.max(1, Math.round(descent / 2))
    ctx.fillStyle = u.color
    ctx.fillRect(x0, y, x1 - x0, thick)
    if (u.style === 'double') ctx.fillRect(x0, y + 2, x1 - x0, 1)
  }
  if (f.strike !== null) {
    const y = baseline - Math.round(ppem * 0.3)
    ctx.fillStyle = f.color
    ctx.fillRect(x0, y, x1 - x0, 1)
    if (f.strike === 'double') ctx.fillRect(x0, y + 2, x1 - x0, 1)
  }
}

function borderWidth(b: BorderLine, scale: number): number {
  return Math.max(1, Math.round(b.width * scale))
}

/** 段落边框：上下边框外扩 `space`，左右边框位于缩进之外 `space` 处。 */
function paintBorders(ctx: PageContext, item: PageParagraph, scale: number): void {
  const b = item.box!
  const px = (v: number) => Math.round(v * scale)
  const left = b.left ? b.x - b.left.space : b.x
  const right = b.right ? b.x + b.width + b.right.space : b.x + b.width
  if (b.top) {
    ctx.fillStyle = b.top.color
    ctx.fillRect(
      px(left),
      px(b.y - b.top.space) - borderWidth(b.top, scale),
      px(right) - px(left),
      borderWidth(b.top, scale),
    )
  }
  if (b.bottom) {
    ctx.fillStyle = b.bottom.color
    ctx.fillRect(
      px(left),
      px(b.y + b.height + b.bottom.space),
      px(right) - px(left),
      borderWidth(b.bottom, scale),
    )
  }
  const top = b.top ? b.y - b.top.space : b.y
  const bottom = b.bottom ? b.y + b.height + b.bottom.space : b.y + b.height
  if (b.left) {
    ctx.fillStyle = b.left.color
    ctx.fillRect(
      px(left) - borderWidth(b.left, scale),
      px(top),
      borderWidth(b.left, scale),
      px(bottom) - px(top),
    )
  }
  if (b.right) {
    ctx.fillStyle = b.right.color
    ctx.fillRect(px(right), px(top), borderWidth(b.right, scale), px(bottom) - px(top))
  }
}

/** 表格的边框线：横线自 `y` 向下占线宽，竖线以 `x` 为中线；双线为两条线宽的线中间隔一个线宽。 */
function paintEdge(ctx: PageContext, e: PageEdge, line: BorderLine, scale: number): void {
  const px = (v: number) => Math.round(v * scale)
  const w = Math.max(1, Math.round(line.width * scale))
  const total = line.style === 'double' ? Math.max(3, Math.round(line.width * 3 * scale)) : w
  ctx.fillStyle = line.color
  const strokes = line.style === 'double' ? [0, total - w] : [0]
  if (!e.vertical) {
    const x0 = px(e.x)
    const x1 = px(e.x + e.length)
    const y = px(e.y)
    for (const off of strokes) dashRun(ctx, x0, y + off, x1 - x0, w, false, line.style)
    return
  }
  const y0 = px(e.y)
  const y1 = px(e.y + e.length)
  const x = Math.round(e.x * scale - total / 2)
  for (const off of strokes) dashRun(ctx, x + off, y0, y1 - y0, w, true, line.style)
}

/** 一段线：实线一次填充，虚线与点线按线宽分段。 */
function dashRun(
  ctx: PageContext,
  x: number,
  y: number,
  length: number,
  thick: number,
  vertical: boolean,
  style: BorderLine['style'],
): void {
  if (length <= 0) return
  if (style !== 'dashed' && style !== 'dotted') {
    if (vertical) ctx.fillRect(x, y, thick, length)
    else ctx.fillRect(x, y, length, thick)
    return
  }
  const on = style === 'dashed' ? thick * 3 : thick
  const off = thick
  for (let p = 0; p < length; p += on + off) {
    const run = Math.min(on, length - p)
    if (vertical) ctx.fillRect(x, y + p, thick, run)
    else ctx.fillRect(x + p, y, run, thick)
  }
}

const GRIDLINE = '#c8c8c8'

/** 表格虚框：1 像素，按页面像素坐标每 4 像素留空 1 像素。 */
function paintGridline(ctx: PageContext, e: PageEdge, scale: number): void {
  ctx.fillStyle = GRIDLINE
  if (!e.vertical) {
    const y = Math.round(e.y * scale)
    const x0 = Math.round(e.x * scale)
    const x1 = Math.round((e.x + e.length) * scale)
    for (let x = x0; x <= x1; x++) if (x % 4 !== 3) ctx.fillRect(x, y, 1, 1)
    return
  }
  const x = Math.round(e.x * scale)
  const y0 = Math.round(e.y * scale)
  const y1 = Math.round((e.y + e.length) * scale)
  for (let y = y0; y <= y1; y++) if (y % 4 !== 3) ctx.fillRect(x, y, 1, 1)
}

/** 页面边框：四边的线画在矩形外侧（上、左边框向外占线宽）。 */
function paintPageBorders(ctx: PageContext, b: NonNullable<Page['borders']>, scale: number): void {
  const px = (v: number) => Math.round(v * scale)
  const wide = (l: BorderLine) => Math.max(1, Math.round(l.width * scale))
  if (b.top) {
    ctx.fillStyle = b.top.color
    ctx.fillRect(px(b.x), px(b.y) - wide(b.top), px(b.x + b.width) - px(b.x), wide(b.top))
  }
  if (b.bottom) {
    ctx.fillStyle = b.bottom.color
    ctx.fillRect(px(b.x), px(b.y + b.height), px(b.x + b.width) - px(b.x), wide(b.bottom))
  }
  if (b.left) {
    ctx.fillStyle = b.left.color
    ctx.fillRect(px(b.x) - wide(b.left), px(b.y), wide(b.left), px(b.y + b.height) - px(b.y))
  }
  if (b.right) {
    ctx.fillStyle = b.right.color
    ctx.fillRect(px(b.x + b.width), px(b.y), wide(b.right), px(b.y + b.height) - px(b.y))
  }
}
