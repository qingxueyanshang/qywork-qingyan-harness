/**
 * 页面绘制：把一页分页结果绘制到 Canvas 2D 上下文。坐标按 `scale`（像素/磅）换算，96 dpi、100% 时为 4/3。
 *
 * 文字按 WPS 屏幕显示（GDI）的方式绘制：
 * - 字号取整数像素（ppem = round(字号 × scale)）；逐字绘制，不交给浏览器连续排列（浏览器按线性宽度排列，与排版位置
 *   逐字偏离）。字形按组取整：组为 WPS 的一次文字输出，即一个片段（片段按字段、字体与字体槽划分，被压缩的标点单独成为片段，
 *   见 `../../text/layout.ts`）中空格之间的字（空格不输出）；组的第一个字的排版坐标换算后四舍五入到整像素，组内各字为该像素
 *   加相对第一个字的距离换算后四舍五入。WPS 页面 EMF 中 15 页 12 000 个字的像素位置：逐字四舍五入有 1894 个不一致，按组取整
 *   为 472 个。不要把属性相同的相邻字段并为一组：WPS 有时合并、有时不合并，合并后为 482 个。
 * - 字体在该 ppem 处于点阵模式（`EmbeddedBitmaps.screenMode`）时以单色字形绘制，不做平滑：strike 中的点阵，
 *   没有点阵的字形为提示后光栅化的轮廓，仿斜体为倾斜的轮廓；仿粗体按 GDI 的方式加粗。
 * - 其余字号在 `paintPage` 的 `clearType` 不为 `null` 时以 ClearType 字形写入画布像素（`../../glyph/cleartype/`，
 *   自然宽度方式，仿粗体、仿斜体按 GDI 的方式合成）；一组为一段，段内各字的覆盖相加后混合。CFF 轮廓与可变字体、
 *   字体中没有的字以 `fillText` 绘制。`clearType` 为 `null`（主机不使用 ClearType）时平滑字号一律以 `fillText` 绘制。
 * - ClearType 字形段暂存，在下一次非文字绘制（填充、底纹、线、边框、公式、图片、图表与浮动对象）之前一并混合
 *   （`flush`）：每次混合读写一次像素，读写的次数决定绘制耗时。新增非文字绘制时，在其前调用 `flush`。
 *   点阵字形与 `fillText` 直接绘制，不等待暂存的字形段：两者与 ClearType 字形只在相邻字的边缘像素重叠，同色时结果与
 *   混合顺序无关。
 * 页面的绘制顺序：白底、页面背景（底色与整页图片）、衬于文字下方的浮动对象、页面边框、页眉页脚与正文、其余浮动对象。
 * 段落内：段落底纹、字符填充（突出显示与底纹）、文字、公式、下划线与删除线、段落边框、图片、图表与 SmartArt。
 * 图片（位图与图元文件）经 `../../drawingml/paint/picture.ts` 绘制：嵌入式图片按裁剪比例拉伸到对象框（取整到像素），
 * 浮动对象与页面背景中的图片同样可以是图元文件；图元文件文字在点阵模式的字号下以单色字形绘制，其余以 `fillText` 绘制，
 * 不使用 ClearType 字形。
 * 公式经 `../../math/` 绘制：括号与根号按数学字体的轮廓填充，文字项与正文文字同样按点阵或 ClearType 字形绘制；
 * 公式的轮廓与文字项交错绘制，ClearType 字形逐字立即混合。
 * 表格：单元格底纹、单元格内容、边框线；没有边框的边画表格虚框（WPS 屏幕显示：1 像素 #c8c8c8，按页面像素坐标
 * 每 4 像素中的第 4 个留空）。浮动对象的形状、图片、图表与 SmartArt 经 `../../drawingml/` 绘制（图表与 SmartArt
 * 的文字见 `graphic.ts`），文本框的内容按本文件的规则绘制，裁剪到 `PageTextBox.clip`。
 */

import { paintChart } from '../../drawingml/chart/paint.ts'
import { paintDiagram } from '../../drawingml/diagram/paint.ts'
import type { CreateCanvas, Matrix, PaintContext } from '../../drawingml/paint/context.ts'
import { IDENTITY, multiply, scaling, translation } from '../../drawingml/paint/context.ts'
import { drawPicture, type PaintPicture, pictureSize } from '../../drawingml/paint/picture.ts'
import { SCREEN_RESOLUTION } from '../../drawingml/paint/resolution.ts'
import { paintAutoShape, paintGroup, type ShapeScene } from '../../drawingml/shape/paint.ts'
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
import { type MathPaintFonts, paintMath } from '../../math/index.ts'
import type { MetafileFace, MetafileFonts } from '../../metafile/index.ts'
import type { DrawingNode } from '../model.ts'
import type {
  BorderLine,
  FaceRef,
  GraphicFonts,
  Page,
  PageEdge,
  PageFloat,
  PageFragment,
  PageItem,
  PageParagraph,
  PageTextBox,
} from '../page/model.ts'
import type { DocxFace } from './fonts.ts'
import { chartImages, graphicSettings, namedFontKey } from './graphic.ts'

/** 绘制所需的 Canvas 2D 接口：与 DrawingML 形状绘制共用。 */
export type PageContext = PaintContext

/** 绘制用的图片与图层。 */
export interface PageResources {
  /** 与 `DocumentPages.images` 一一对应：已解码的图片（`decodePicture`）；未加载或无法解码时为 `null`。 */
  readonly images: readonly (PaintPicture | null)[]
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

/**
 * 文字的 ClearType 绘制：`display` 为显示器的 ClearType 设置，`target` 为 `paintPage` 的绘制上下文本身，
 * 字形按设备坐标读写其像素（画布宜以 `willReadFrequently: true` 创建）。
 */
export interface PageClearType {
  readonly display: ClearTypeDisplay
  readonly target: PageContext & PixelCanvas
}

/**
 * 暂存的 ClearType 字形段与字形段的裁剪范围（设备像素）：页面为整页，文本框为页面与其裁剪范围的交集，与页面共用 `runs`。
 * ClearType 字形直接写入画布像素，不受画布裁剪路径约束，裁剪由 `bounds` 实现。
 */
interface GlyphBatch {
  readonly clearType: PageClearType
  readonly bounds: DeviceRect
  readonly runs: GlyphRun[]
}

/** 混合暂存的字形段；没有时不读写像素。每次非文字绘制之前调用。 */
function flush(batch: GlyphBatch | null): void {
  if (batch === null || batch.runs.length === 0) return
  paintGlyphRuns(batch.clearType.target, batch.runs, batch.clearType.display)
  batch.runs.length = 0
}

/** 以 `baseline` 为基线的字形段的裁剪范围：超出 GDI 上下沿（`tmAscent`、`tmDescent`）的行不绘制。 */
function textClip(face: DocxFace, ppem: number, baseline: number, batch: GlyphBatch): DeviceRect {
  const v = face.pixelVertical(ppem)
  const b = batch.bounds
  return {
    left: b.left,
    top: Math.max(b.top, baseline - v.ascent),
    right: b.right,
    bottom: Math.min(b.bottom, baseline + v.descent),
  }
}

/** 字体在 `ppem` 下的 ClearType 字形；点阵模式的字号、CFF 轮廓与可变字体为 `null`。 */
function smoothGlyphs(face: DocxFace, ppem: number): DocxFace['clearType'] {
  return face.bitmaps?.screenMode(ppem) ? null : face.clearType
}

const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 }

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
      else {
        for (const im of it.images) out.add(im.image)
        for (const g of it.graphics) node(g.graphic)
      }
    }
  }
  const node = (n: DrawingNode) => {
    if (n.kind === 'group') {
      for (const c of n.children) node(c)
      return
    }
    if (n.kind === 'chart') {
      chartImages(n.chart, parts, out)
      return
    }
    if (n.kind === 'diagram') return
    const part = n.fill.kind === 'picture' ? n.fill.image.part : null
    const i = part === null ? -1 : parts.indexOf(part)
    if (i >= 0) out.add(i)
  }
  for (const list of [page.header, page.body, page.footer]) items(list)
  for (const f of page.floats) {
    for (const t of f.texts) items(t.items)
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

/** `clearType` 为 `null` 时平滑字号以 `fillText` 绘制；不为 `null` 时其 `target` 须为 `ctx`。 */
export function paintPage(
  ctx: PageContext,
  page: Page,
  fonts: PageFonts,
  res: PageResources,
  scale: number = SCREEN_SCALE,
  clearType: PageClearType | null = null,
): void {
  const width = Math.ceil(page.width * scale)
  const height = Math.ceil(page.height * scale)
  const batch: GlyphBatch | null =
    clearType === null
      ? null
      : { clearType, bounds: { left: 0, top: 0, right: width, bottom: height }, runs: [] }
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  if ('fontKerning' in ctx) ctx.fontKerning = 'none'
  const metafile = metafileFonts(page.graphicFonts, fonts)
  const bg = page.background
  if (bg !== null) {
    if (bg.color !== null) {
      ctx.fillStyle = bg.color
      ctx.fillRect(0, 0, width, height)
    }
    const picture = bg.image === null ? null : (res.images[bg.image] ?? null)
    const size = picture === null ? null : pictureSize(picture)
    if (picture !== null && size !== null && size.width > 0 && size.height > 0) {
      const dpi = bg.tile ? size.resolution : SCREEN_RESOLUTION
      const tw = Math.max(1, Math.round((size.width * 96) / dpi.x)) * 0.75 * scale
      const th = Math.max(1, Math.round((size.height * 96) / dpi.y)) * 0.75 * scale
      for (let ty = 0; ty < height; ty += th) {
        for (let tx = 0; tx < width; tx += tw) {
          const rect = {
            x: Math.round(tx),
            y: Math.round(ty),
            width: Math.round(tw),
            height: Math.round(th),
          }
          drawPicture(ctx, picture, NO_CROP, rect, IDENTITY, 'low', metafile)
        }
      }
    }
  }
  // 形状文字由本文件按文档规则绘制（`paintNode` 不传入文字）；图表与 SmartArt 的文字按 `graphicSettings`。
  const scene: ShapeScene = {
    ctx,
    res: {
      image: (part) => {
        const i = res.parts.indexOf(part)
        return i < 0 ? null : (res.images[i] ?? null)
      },
      createCanvas: res.createCanvas,
      metafileFonts: metafile,
    },
    scale: scale * 0.75,
    canvas: { width, height },
    settings:
      page.graphicFonts === null ? null : graphicSettings(page.graphicFonts, fonts, clearType),
  }
  const pictures: PictureFonts = { res, fonts: metafile }
  const text: PageText = { fonts, batch }
  for (const f of page.floats) if (f.behind) paintFloat(scene, f, text, pictures, scale)
  flush(batch)
  if (page.borders !== null) paintPageBorders(ctx, page.borders, scale)
  for (const items of [page.header, page.footer, page.body])
    paintItems(scene, items, text, pictures, scale)
  for (const f of page.floats) if (!f.behind) paintFloat(scene, f, text, pictures, scale)
  flush(batch)
  ctx.restore()
}

/** 文字的字体与暂存的 ClearType 字形段（主机不使用 ClearType 时为 `null`）。 */
interface PageText {
  readonly fonts: PageFonts
  readonly batch: GlyphBatch | null
}

/** 对象框左上角在 (`x`, `y`) 磅处时，对象局部坐标（96 dpi 像素）到设备坐标的变换。 */
function objectMatrix(x: number, y: number, scale: number) {
  return multiply(translation(x * scale, y * scale), scaling(scale * 0.75, scale * 0.75))
}

/** 浮动对象：形状与图片的局部坐标为 96 dpi 像素，原点为对象框左上角。 */
function paintFloat(
  scene: ShapeScene,
  f: PageFloat,
  text: PageText,
  pictures: PictureFonts,
  scale: number,
): void {
  if (f.drawing !== null) {
    flush(text.batch)
    paintObject(scene, f.drawing, f.x, f.y, scale)
  }
  for (const t of f.texts) paintTextBox(scene, t, text, pictures, scale)
}

/**
 * 文本框的内容：画布按裁剪范围（取整到像素）裁剪，ClearType 字形段另按 `GlyphBatch.bounds` 裁剪。文字随形状旋转时画布绕旋转中心
 * 旋转，平滑字号以 `fillText` 绘制（ClearType 字形按设备像素写入，不能旋转）。未实现：其中的嵌入式图片、图表与 SmartArt
 * 按单位变换绘制，不随之旋转，`paintObject` 绘制之后同一文本框中其余的内容同样不再旋转。
 */
function paintTextBox(
  scene: ShapeScene,
  t: PageTextBox,
  text: PageText,
  pictures: PictureFonts,
  scale: number,
): void {
  const ctx = scene.ctx
  const px = (v: number) => Math.round(v * scale)
  const rect = {
    left: px(t.clip.x),
    top: px(t.clip.y),
    right: px(t.clip.x + t.clip.width),
    bottom: px(t.clip.y + t.clip.height),
  }
  const outer = text.batch
  flush(outer)
  ctx.save()
  const turn = t.rotation
  if (turn !== null) {
    ctx.translate(turn.x * scale, turn.y * scale)
    ctx.rotate((turn.angle * Math.PI) / 180)
    ctx.translate(-turn.x * scale, -turn.y * scale)
  }
  ctx.beginPath()
  ctx.rect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)
  ctx.clip()
  const batch =
    outer === null || turn !== null
      ? null
      : {
          ...outer,
          bounds: {
            left: Math.max(outer.bounds.left, rect.left),
            top: Math.max(outer.bounds.top, rect.top),
            right: Math.min(outer.bounds.right, rect.right),
            bottom: Math.min(outer.bounds.bottom, rect.bottom),
          },
        }
  paintItems(scene, t.items, { fonts: text.fonts, batch }, pictures, scale)
  flush(batch)
  ctx.restore()
}

/** 对象框左上角在 (`x`, `y`) 磅处的对象；绘制后恢复单位变换。 */
function paintObject(scene: ShapeScene, n: DrawingNode, x: number, y: number, scale: number): void {
  scene.ctx.save()
  paintNode(scene, n, objectMatrix(x, y, scale))
  scene.ctx.restore()
  scene.ctx.setTransform(1, 0, 0, 1, 0, 0)
}

function paintNode(scene: ShapeScene, n: DrawingNode, parent: Matrix): void {
  if (n.kind === 'group') {
    paintGroup(scene, n, parent, (inner, m) => {
      for (const c of n.children) paintNode(inner, c, m)
    })
    return
  }
  if (n.kind === 'chart') {
    paintChart(scene, n.chart, n.frame, parent)
    return
  }
  if (n.kind === 'diagram') {
    paintDiagram(scene, n.diagram, n.frame, parent)
    return
  }
  paintAutoShape(scene, { ...n, text: null }, parent)
}

function paintItems(
  scene: ShapeScene,
  items: readonly PageItem[],
  text: PageText,
  pictures: PictureFonts,
  scale: number,
): void {
  const ctx = scene.ctx
  const { fonts, batch } = text
  const px = (v: number) => Math.round(v * scale)
  for (const item of items) {
    if (item.kind === 'table') {
      if (item.fills.length > 0) flush(batch)
      for (const fill of item.fills) {
        ctx.fillStyle = fill.color
        ctx.fillRect(
          px(fill.x),
          px(fill.y),
          px(fill.x + fill.width) - px(fill.x),
          px(fill.y + fill.height) - px(fill.y),
        )
      }
      paintItems(scene, item.items, text, pictures, scale)
      if (item.edges.length > 0) flush(batch)
      for (const e of item.edges) if (e.line === null) paintGridline(ctx, e, scale)
      for (const e of item.edges) if (e.line !== null) paintEdge(ctx, e, e.line, scale)
      continue
    }
    if (item.box?.fill) {
      const b = item.box
      flush(batch)
      ctx.fillStyle = b.fill
      ctx.fillRect(px(b.x), px(b.y), px(b.x + b.width) - px(b.x), px(b.y + b.height) - px(b.y))
    }
    paintFills(ctx, item, scale, batch)
    for (const line of item.lines)
      for (const f of line.fragments) paintText(ctx, f, fonts, scale, batch)
    if (item.formulas.length > 0) flush(batch)
    for (const m of item.formulas)
      paintMath(ctx, m.layout, m.x, m.baseline, mathFonts(ctx, fonts, batch), scale)
    for (const line of item.lines)
      for (const f of line.fragments) paintDecorations(ctx, f, fonts, scale, batch)
    if (item.box) {
      flush(batch)
      paintBorders(ctx, item, scale)
    }
    for (const im of item.images) {
      const picture = pictures.res.images[im.image]
      if (picture == null) continue
      const box = {
        x: px(im.x),
        y: px(im.y),
        width: px(im.x + im.width) - px(im.x),
        height: px(im.y + im.height) - px(im.y),
      }
      if (box.width > 0 && box.height > 0) {
        flush(batch)
        drawPicture(ctx, picture, im.crop, box, IDENTITY, 'low', pictures.fonts)
      }
    }
    for (const g of item.graphics) {
      flush(batch)
      paintObject(scene, g.graphic, g.x, g.y, scale)
    }
  }
}

/** 嵌入式图片的绘制所需：已解码的图片与图元文件文字的字体（`metafileFonts`）。 */
interface PictureFonts {
  readonly res: PageResources
  readonly fonts: MetafileFonts | null
}

/**
 * 图元文件文字的字体：按 `GraphicFonts` 中的字体名取得登记的字形（主机没有的字体名为 `null`，由图元文件按其替代规则另取），
 * `fallback` 为文档的回退字体；请求粗体或斜体而字体没有该字形时仿粗体、仿斜体。本页没有字体表或回退字体没有绘制度量时为 `null`。
 *
 * WPS 文字把图元文件栅格化为单色或灰度的蒙版（页面 EMF 中的 ALPHABLEND 位图），文字不用 ClearType：字体对象的逻辑字高
 * 不小于 `SMOOTH_HEIGHT` 且 `gasp` 在该 ppem 要求灰度平滑时平滑（按族名交给浏览器），否则为单色字形（有该 ppem 的点阵时
 * 取点阵，否则取提示后的轮廓；仿粗体按 GDI 的方式加粗）。字体中没有该字时按族名交给浏览器。
 */
function metafileFonts(table: GraphicFonts | null, fonts: PageFonts): MetafileFonts | null {
  if (table === null) return null
  const entry = (index: number) => {
    const ref = fonts.faces[index]
    const face = ref === undefined ? null : fonts.draw(ref)
    return ref === undefined || face === null ? null : { ref, face }
  }
  const fallback = entry(table.fallback)
  if (fallback === null) return null
  const named = new Map<string, { ref: FaceRef; face: DocxFace }>()
  for (const n of table.named) {
    const e = entry(n.face)
    if (e !== null) named.set(namedFontKey(n.name, n.bold, n.italic), e)
  }
  const cache = new Map<string, MetafileFace>()
  const resolve = (
    key: string,
    face: { ref: FaceRef; face: DocxFace },
    bold: boolean,
    italic: boolean,
  ): MetafileFace => {
    const known = cache.get(key)
    if (known !== undefined) return known
    const out = metafileFace(face, bold, italic)
    cache.set(key, out)
    return out
  }
  return {
    face: (name, bold, italic) => {
      const key = namedFontKey(name, bold, italic)
      const found = named.get(key)
      return found === undefined ? null : resolve(key, found, bold, italic)
    },
    fallback: (bold, italic) => resolve(`\u0000${bold}${italic}`, fallback, bold, italic),
  }
}

/** 登记的字形按图元文件文字的规则绘制（见 `metafileFonts`）。 */
function metafileFace(
  { ref: base, face }: { ref: FaceRef; face: DocxFace },
  bold: boolean,
  italic: boolean,
): MetafileFace {
  const ref: FaceRef = {
    ...base,
    syntheticBold: bold && !base.bold,
    syntheticItalic: italic && !base.italic,
  }
  const v = face.text.vertical
  return {
    vertical: (ppem) => face.pixelVertical(ppem),
    emPerCell: v.unitsPerEm / (v.winAscent + v.winDescent || v.unitsPerEm),
    averageWidth: v.averageWidth / v.unitsPerEm,
    symbol: ((v.codePages ?? 0) & SYMBOL_CODE_PAGE) !== 0,
    advance: (cp, ppem) => face.pixelAdvance(cp, ppem) ?? face.text.metrics.advance(cp, ppem),
    draw: (c, text, x, baseline, ppem, height) => {
      const glyph = face.text.metrics.glyphId(text.codePointAt(0)!)
      const mono =
        glyph === 0 || (height >= SMOOTH_HEIGHT && face.grayscale(ppem))
          ? null
          : monochromeGlyph(face, ref, glyph, ppem)
      if (mono !== null) {
        const { ascent, descent } = face.pixelVertical(ppem)
        fillBitmap(c, mono, x, baseline, ascent, descent)
        return
      }
      c.font = cssFont(ref, ppem)
      c.fillText(text, x, baseline)
    },
  }
}

/**
 * 图元文件文字平滑的最小逻辑字高（`lfHeight` 的绝对值）。WPS 文字实测（构造文件，Times New Roman 与 Symbol）：
 * 逻辑字高 49 及以下为单色，50 及以上在 `gasp` 要求灰度的 ppem 平滑，与每英寸逻辑单位数（96、192、480–4800）无关。
 */
const SMOOTH_HEIGHT = 50

/** `OS/2.ulCodePageRange1` 的第 31 位：符号字符集。 */
const SYMBOL_CODE_PAGE = 0x80000000

/** 单色字形：该 ppem 有点阵时取点阵，否则取提示后光栅化的轮廓；字体没有 TrueType 轮廓时为 `null`。 */
function monochromeGlyph(face: DocxFace, ref: FaceRef, glyph: number, ppem: number) {
  const raw =
    face.bitmaps?.glyph(ppem, glyph, ref.syntheticItalic) ??
    face.hinting?.glyph(glyph, ppem, ref.syntheticItalic) ??
    null
  return raw === null ? null : ref.syntheticBold ? emboldenBitmap(raw) : raw
}

/** 突出显示与字符底纹：覆盖行的全高，横向为片段的范围。 */
function paintFills(
  ctx: PageContext,
  item: PageParagraph,
  scale: number,
  batch: GlyphBatch | null,
): void {
  const px = (v: number) => Math.round(v * scale)
  for (const line of item.lines) {
    for (const f of line.fragments) {
      if (f.fill === null) continue
      flush(batch)
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

/**
 * 字体在该 ppem 处于点阵模式时以单色字形绘制（`EmbeddedBitmaps.glyph`：点阵、提示后的轮廓、仿斜体的倾斜轮廓；
 * 仿粗体按 GDI 的方式加粗），返回是否已绘制。`x`、`baseline` 为整数像素。
 */
function paintBitmapGlyph(
  ctx: PageContext,
  face: DocxFace | null,
  ref: FaceRef,
  glyph: number,
  x: number,
  baseline: number,
  ppem: number,
): boolean {
  if (!face?.bitmaps?.screenMode(ppem)) return false
  const raw = face.bitmaps.glyph(ppem, glyph, ref.syntheticItalic)
  if (!raw) return false
  const vertical = face.pixelVertical(ppem)
  fillBitmap(
    ctx,
    ref.syntheticBold ? emboldenBitmap(raw) : raw,
    x,
    baseline,
    vertical.ascent,
    vertical.descent,
  )
  return true
}

function paintText(
  ctx: PageContext,
  f: PageFragment,
  fonts: PageFonts,
  scale: number,
  batch: GlyphBatch | null,
): void {
  const ref = fonts.faces[f.face]
  if (ref === undefined) return
  const face = fonts.draw(ref)
  const ppem = Math.round(f.size * scale)
  const baseline = Math.round(f.baseline * scale)
  ctx.fillStyle = f.color
  ctx.font = cssFont(ref, ppem)
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'
  const smooth = batch === null || face === null ? null : smoothGlyphs(face, ppem)
  let x = f.x
  let k = 0
  /** 当前组的第一个字（排版坐标与像素）；空格之后为 `null`。 */
  let origin: { readonly x: number; readonly px: number } | null = null
  /** 当前组的 ClearType 字形段；空格之后为 `null`。 */
  let run: PlacedGlyph[] | null = null
  for (const ch of f.text) {
    const cp = ch.codePointAt(0)!
    const advance = f.advances[k++] ?? 0
    if (cp === 0x20) {
      origin = null
      run = null
      x += advance
      continue
    }
    origin ??= { x, px: Math.round(x * scale) }
    const gx = origin.px + Math.round((x - origin.x) * scale)
    x += advance
    if (cp < 32) continue
    const glyph = face?.text.metrics.glyphId(cp) ?? 0
    if (paintBitmapGlyph(ctx, face, ref, glyph, gx, baseline, ppem)) continue
    if (smooth !== null && glyph !== 0) {
      if (run === null) {
        run = []
        batch!.runs.push({
          glyphs: run,
          color: f.color,
          clip: textClip(face!, ppem, baseline, batch!),
        })
      }
      run.push({
        glyph: smooth.glyph(glyph, ppem, ref.syntheticBold, ref.syntheticItalic),
        x: gx,
        baseline,
      })
      continue
    }
    ctx.fillText(ch, gx, baseline)
  }
}

/**
 * 公式绘制所用的字体：族名与轮廓按 `DocumentPages.faces` 的下标取得，文字项经 `paintBitmapGlyph`，
 * 其余字号有 ClearType 字形时立即混合。调用前须已混合暂存的字形段（`flush`）。
 */
function mathFonts(
  ctx: PageContext,
  fonts: PageFonts,
  batch: GlyphBatch | null,
): MathPaintFonts<number> {
  const face = (i: number) => {
    const ref = fonts.faces[i]
    return ref === undefined ? null : { ref, face: fonts.draw(ref) }
  }
  return {
    family: (i) => fonts.faces[i]?.family ?? '',
    outlines: (i) => face(i)?.face?.math?.outlines ?? null,
    glyph: (it, x, baseline, ppem) => {
      const f = face(it.font)
      if (f === null) return false
      if (paintBitmapGlyph(ctx, f.face, f.ref, it.glyph, x, baseline, ppem)) return true
      const smooth = batch === null || f.face === null ? null : smoothGlyphs(f.face, ppem)
      if (smooth === null || it.glyph === 0) return false
      const glyph = smooth.glyph(it.glyph, ppem, f.ref.syntheticBold, f.ref.syntheticItalic)
      const clip = textClip(f.face!, ppem, baseline, batch!)
      paintGlyphRuns(
        batch!.clearType.target,
        [{ glyphs: [{ glyph, x, baseline }], color: it.color, clip }],
        batch!.clearType.display,
      )
      return true
    },
  }
}

/** 下划线与删除线：位置与粗细取字号的比例，单线为 1 像素。 */
function paintDecorations(
  ctx: PageContext,
  f: PageFragment,
  fonts: PageFonts,
  scale: number,
  batch: GlyphBatch | null,
): void {
  if (f.underline === null && f.strike === null) return
  flush(batch)
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

/** 一条线在线组中的位置（像素）。 */
interface PixelStroke {
  readonly offset: number
  readonly size: number
}

/**
 * 线组的各条线换算为像素：线与间距的边界按累计的磅值四舍五入，每条线与每个间距至少 1 像素（WPS 屏幕 EMF 实测：
 * 0.75 磅线宽的 `MediumGap` 为 1、1、1 像素，双线 0.5 磅为 1、1、1 像素，1 磅为 1、2、1 像素）。
 */
function strokePixels(l: BorderLine, scale: number): PixelStroke[] {
  const out: PixelStroke[] = []
  let edge = 0
  for (const [k, st] of l.strokes.entries()) {
    const start = k === 0 ? 0 : Math.max(edge + 1, Math.round(st.offset * scale))
    edge = Math.max(start + 1, Math.round((st.offset + st.size) * scale))
    out.push({ offset: start, size: edge - start })
  }
  return out
}

function strokeTotal(strokes: readonly PixelStroke[]): number {
  const last = strokes[strokes.length - 1]
  return last === undefined ? 0 : last.offset + last.size
}

/** 一组线：横线自 `y` 向下排列，竖线自 `x` 向右排列，长度为 `length` 像素。 */
function strokeRun(
  ctx: PageContext,
  line: BorderLine,
  strokes: readonly PixelStroke[],
  x: number,
  y: number,
  length: number,
  vertical: boolean,
): void {
  ctx.fillStyle = line.color
  for (const st of strokes) {
    if (vertical) dashRun(ctx, x + st.offset, y, length, st.size, true, line.style)
    else dashRun(ctx, x, y + st.offset, length, st.size, false, line.style)
  }
}

/** 段落边框：上下边框外扩 `space`，左右边框位于缩进之外 `space` 处。 */
function paintBorders(ctx: PageContext, item: PageParagraph, scale: number): void {
  const b = item.box!
  const px = (v: number) => Math.round(v * scale)
  const left = b.left ? b.x - b.left.space : b.x
  const right = b.right ? b.x + b.width + b.right.space : b.x + b.width
  if (b.top) {
    const st = strokePixels(b.top, scale)
    strokeRun(
      ctx,
      b.top,
      st,
      px(left),
      px(b.y - b.top.space) - strokeTotal(st),
      px(right) - px(left),
      false,
    )
  }
  if (b.bottom) {
    const st = strokePixels(b.bottom, scale)
    strokeRun(
      ctx,
      b.bottom,
      st,
      px(left),
      px(b.y + b.height + b.bottom.space),
      px(right) - px(left),
      false,
    )
  }
  const top = b.top ? b.y - b.top.space : b.y
  const bottom = b.bottom ? b.y + b.height + b.bottom.space : b.y + b.height
  if (b.left) {
    const st = strokePixels(b.left, scale)
    strokeRun(ctx, b.left, st, px(left) - strokeTotal(st), px(top), px(bottom) - px(top), true)
  }
  if (b.right) {
    const st = strokePixels(b.right, scale)
    strokeRun(ctx, b.right, st, px(right), px(top), px(bottom) - px(top), true)
  }
}

/**
 * 表格边框的一条线覆盖的像素 `[start, start + size)`（`from` 为线的起点，`size` 为线宽，单位为像素）。WPS 屏幕 EMF
 * 实测（语料 5 份 1012 处表格边框）：每条线画为宽度为线宽取整到像素（至少 1 像素）加 1 缇的矩形，覆盖左上角落在矩形内的
 * 像素，即起点向上取整、终点向上取整后不含。线起点为整数像素时 1.5 磅的线占 3 像素，起点在 0.8 像素处时占 2 像素。
 */
function edgePixels(from: number, size: number, scale: number): PixelStroke {
  const start = Math.ceil(from - PIXEL_EPSILON)
  const end = Math.ceil(from + lineWidth(size) + scale / 20 - PIXEL_EPSILON)
  return { offset: start, size: Math.max(1, end - start) }
}

/** 线宽取整到像素，至少 1 像素。 */
function lineWidth(size: number): number {
  return Math.max(1, Math.round(size))
}

const PIXEL_EPSILON = 1e-6

/** 表格的边框线：横线自 `y` 向下占线组宽度，竖线以 `x` 为中线（按取整到像素的线组宽度居中）。 */
function paintEdge(ctx: PageContext, e: PageEdge, line: BorderLine, scale: number): void {
  const px = (v: number) => Math.round(v * scale)
  const last = line.strokes[line.strokes.length - 1]
  const total = last === undefined ? 0 : (last.offset + last.size) * scale
  const origin = e.vertical ? e.x * scale - lineWidth(total) / 2 : e.y * scale
  ctx.fillStyle = line.color
  for (const s of line.strokes) {
    const p = edgePixels(origin + s.offset * scale, s.size * scale, scale)
    if (e.vertical)
      dashRun(ctx, p.offset, px(e.y), px(e.y + e.length) - px(e.y), p.size, true, line.style)
    else dashRun(ctx, px(e.x), p.offset, px(e.x + e.length) - px(e.x), p.size, false, line.style)
  }
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

/**
 * 一边页面边框的各条线：距线外缘的偏移与粗细（像素），自外缘向内。线组按屏幕顺序排列（`strokePixels`），
 * 下边与右边的外缘在线组末端。
 */
function outerStrokes(l: BorderLine | null, scale: number, reversed: boolean): PixelStroke[] {
  if (l === null) return []
  const st = strokePixels(l, scale)
  if (!reversed) return st
  const total = strokeTotal(st)
  return st.map((x) => ({ offset: total - x.offset - x.size, size: x.size })).reverse()
}

/**
 * 页面边框：`inside` 为真时线画在矩形内侧，否则外侧。同一序号的线（双线的外线与内线）四边相接围成矩形
 * （WPS 实测：四角填满，双线的内线在内角相接）。
 */
function paintPageBorders(ctx: PageContext, b: NonNullable<Page['borders']>, scale: number): void {
  const px = (v: number) => Math.round(v * scale)
  const sides = {
    top: outerStrokes(b.top, scale, false),
    bottom: outerStrokes(b.bottom, scale, true),
    left: outerStrokes(b.left, scale, false),
    right: outerStrokes(b.right, scale, true),
  }
  const total = (s: readonly { offset: number; size: number }[]) => {
    const last = s[s.length - 1]
    return last === undefined ? 0 : last.offset + last.size
  }
  const out = b.inside ? 0 : 1
  const x0 = px(b.x) - out * total(sides.left)
  const y0 = px(b.y) - out * total(sides.top)
  const x1 = px(b.x + b.width) + out * total(sides.right)
  const y1 = px(b.y + b.height) + out * total(sides.bottom)
  const inset = (s: readonly { offset: number }[], k: number) => s[k]?.offset ?? 0
  const draw = (
    line: BorderLine,
    x: number,
    y: number,
    length: number,
    thick: number,
    vertical: boolean,
  ) => {
    ctx.fillStyle = line.color
    dashRun(ctx, x, y, length, thick, vertical, line.style)
  }
  for (const [k, s] of sides.top.entries()) {
    const l = x0 + inset(sides.left, k)
    draw(b.top!, l, y0 + s.offset, x1 - inset(sides.right, k) - l, s.size, false)
  }
  for (const [k, s] of sides.bottom.entries()) {
    const l = x0 + inset(sides.left, k)
    draw(b.bottom!, l, y1 - s.offset - s.size, x1 - inset(sides.right, k) - l, s.size, false)
  }
  for (const [k, s] of sides.left.entries()) {
    const t = y0 + inset(sides.top, k)
    draw(b.left!, x0 + s.offset, t, y1 - inset(sides.bottom, k) - t, s.size, true)
  }
  for (const [k, s] of sides.right.entries()) {
    const t = y0 + inset(sides.top, k)
    draw(b.right!, x1 - s.offset - s.size, t, y1 - inset(sides.bottom, k) - t, s.size, true)
  }
}
