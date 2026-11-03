/**
 * 工作表上的形状：锚点换算为工作表坐标，按 `../../drawingml/shape/paint.ts` 绘制。
 *
 * - 坐标：顶层节点的 `frame`（旋转接近 90° 或 270° 时宽高互换，即形状在工作表上所占的矩形）线性映射到锚点矩形，
 *   树中全部 `frame` 经同一映射由 `frameOf` 换算（接近竖直的形状横纵比例互换）。换算结果仍为 EMU，1 像素 = 9525 EMU。
 * - 文字：排版与字体规则与演示文稿相同（`../../drawingml/text/`），单倍行高见 `SHEET_SINGLE_LINE`，行高、基线与点阵
 *   按屏幕显示（`screenText`）。字体取自工作表的 `FontSet`；缺字与缺少字体时依次取 `fallbackFonts(workbook)` 与文档字体中第一个可用的字体，都没有时不绘制形状文字。
 *   显示器使用 ClearType 时形状与图表文字的平滑字号以 ClearType 字形绘制（`sheetClearType`），对比度与单元格文字相同。
 *   图片中图元文件的文字取同样的字体（`metafileFonts`）。
 * - 绘制范围：旋转后的外接矩形加上线条、箭头与外部阴影的余量，用于跳过区域外的形状。超出形状框的文字不计入。
 */

import type { Effect, Line } from '../../drawingml/fill.ts'
import type { Matrix } from '../../drawingml/paint/context.ts'
import type { Frame } from '../../drawingml/shape/model.ts'
import {
  EMU_PER_PX,
  paintAutoShape,
  paintConnector,
  paintGroup,
  type ShapeScene,
} from '../../drawingml/shape/paint.ts'
import { frameOf, nearVertical, type Transform } from '../../drawingml/shape/resolve.ts'
import {
  FaceCache,
  type ScreenGlyph,
  type ScreenText,
  SINGLE_LINE,
  type SlideFont,
  type TextClearType,
} from '../../drawingml/text/fonts.ts'
import { emboldenBitmap } from '../../font/index.ts'
import { fillBitmap } from '../../glyph/bitmap.ts'
import {
  type ClearTypeDisplay,
  type DeviceRect,
  paintGlyphRuns,
} from '../../glyph/cleartype/index.ts'
import type { MetafileFace, MetafileFonts } from '../../metafile/index.ts'
import type { DrawingAnchor, ShapeNode, SheetShape, Workbook } from '../model.ts'
import { type FontSet, fallbackFonts, type LoadedFace } from './fonts.ts'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface PlacedShape {
  /** `frame` 已换算为工作表坐标（EMU）。 */
  readonly node: ShapeNode
  /** 工作表像素中的绘制范围。 */
  readonly bounds: Rect
}

function slideFont(f: LoadedFace): SlideFont {
  return { face: f.text, family: f.family, bold: f.bold, italic: f.italic }
}

/**
 * 形状文字的单倍行高与字号之比。经验拟合（机制未查明）：WPS 表格屏幕显示中宋体、微软雅黑、等线、Arial、Calibri、
 * Times New Roman 9–28 磅的段间行距与字体无关，为字号的 1.2953–1.2976 倍。
 * 小数字号按整数部分计算，百分比与固定行距的分配见 `../../drawingml/text/body.ts` 的 `hostBlock`。
 */
const SHEET_SINGLE_LINE = 1.296

/**
 * 形状文字按屏幕显示绘制（`ScreenText`）：WPS 表格对宋体 9–12 磅的形状文字使用内嵌点阵（14 磅起为轮廓），
 * 使用条件与单元格文字相同（`EmbeddedBitmaps.screenMode`），没有点阵的字形与合成斜体取单色字形（`EmbeddedBitmaps.glyph`）；
 * 字体没有粗体字形时按 GDI 的方式加粗。
 */
function screenText(fonts: FontSet): ScreenText {
  return {
    bitmap: (face, codePoint, ppem) =>
      screenBitmap(fonts, face.family, face.bold, face.italic, codePoint, ppem),
  }
}

function screenBitmap(
  fonts: FontSet,
  family: string,
  bold: boolean,
  italic: boolean,
  codePoint: number,
  ppem: number,
): ScreenGlyph | null {
  const f = fonts.face(family, bold, italic)
  if (!f?.bitmaps?.screenMode(ppem)) return null
  const raw = f.bitmaps.glyph(ppem, f.metrics.glyphId(codePoint), italic && !f.italic)
  if (raw === null) return null
  const { ascent, descent } = f.vertical(ppem)
  return { glyph: bold && !f.bold ? emboldenBitmap(raw) : raw, ascent, descent }
}

/** 缺少字体时使用的字体：`fallbackFonts(workbook)` 与文档字体中第一个可用的字体；都没有时为 `null`。 */
function fallbackFace(workbook: Workbook, fonts: FontSet): LoadedFace | null {
  for (const name of [...fallbackFonts(workbook), ...workbook.fontNames]) {
    const f = fonts.face(name, false, false)
    if (f !== null) return f
  }
  return null
}

function faceSource(workbook: Workbook, fonts: FontSet) {
  const fallback = fallbackFace(workbook, fonts)
  if (fallback === null) return null
  return {
    face(name: string, bold: boolean, italic: boolean) {
      const f = fonts.face(name, bold, italic)
      return f === null ? null : slideFont(f)
    },
    fallback: slideFont(fallback),
  }
}

/**
 * 形状与图表文字的 ClearType 字形（`TextClearType`）：字形与单元格文字相同（`LoadedFace.clearType`），字体没有
 * TrueType 轮廓或没有该字时为 `null`；请求粗体或斜体而字体没有该字形时按 GDI 的方式合成。每段文字立即混合，
 * 像素只写入 `clip`（设备像素，绘制区域）之内：像素的读写不受裁剪路径约束。
 */
export function sheetClearType(
  fonts: FontSet,
  display: ClearTypeDisplay,
  target: TextClearType['target'],
  clip: DeviceRect,
): TextClearType {
  return {
    target,
    paint(runs) {
      paintGlyphRuns(
        target,
        runs.map((r) => ({
          ...r,
          clip: {
            left: Math.max(r.clip.left, clip.left),
            top: Math.max(r.clip.top, clip.top),
            right: Math.min(r.clip.right, clip.right),
            bottom: Math.min(r.clip.bottom, clip.bottom),
          },
        })),
        display,
      )
    },
    flush() {},
    glyph(face, codePoint, ppem) {
      const f = fonts.face(face.family, face.bold, face.italic)
      const glyphs = f?.clearType
      if (!f || !glyphs) return null
      const id = f.metrics.glyphId(codePoint)
      if (id === 0) return null
      const { ascent, descent } = f.vertical(ppem)
      return {
        glyph: glyphs.glyph(id, ppem, face.bold && !f.bold, face.italic && !f.italic),
        ascent,
        descent,
      }
    },
  }
}

/**
 * 形状文字的字体缓存；字体集中没有任何可用字体时为 `null`。`clearType` 为 `null` 时平滑字号以 `fillText` 绘制。
 */
export function shapeFaces(
  workbook: Workbook,
  fonts: FontSet,
  clearType: TextClearType | null,
): FaceCache | null {
  const source = faceSource(workbook, fonts)
  if (source === null) return null
  const screen = screenText(fonts)
  return new FaceCache(source, SHEET_SINGLE_LINE, screen, screen, clearType)
}

/**
 * 图表文字的字体缓存：行高与基线按演示文稿的规则，字形按屏幕显示绘制（`screenText`）。WPS 表格中图表文字的位置与
 * WPS 演示一致（校准文件实测：按形状文字的行高排版时分类标签与数值轴底端标签分别高 2 与 4 像素），只有单倍行高
 * 与形状文字相同，按整数字号计算（`FaceCache.wholeSizeLine`）；宋体 9–13 磅的图表文字不做平滑、按内嵌点阵绘制，
 * 14 磅平滑（校准文件实测，与 GDI 的点阵条件相同）。`clearType` 同 `shapeFaces`。
 */
export function chartFaces(
  workbook: Workbook,
  fonts: FontSet,
  clearType: TextClearType | null,
): FaceCache | null {
  const source = faceSource(workbook, fonts)
  return source === null
    ? null
    : new FaceCache(source, SINGLE_LINE, null, screenText(fonts), clearType, true)
}

/**
 * 图片中图元文件文字的字体：按字体名与字形取得字体集中的字体，没有时为 `null`（由图元文件按其替代规则另取），`fallback` 为
 * `fallbackFace`。字形按形状文字的点阵条件绘制（`screenBitmap`），其余按族名交给浏览器；请求粗体或斜体而字体没有该字形时
 * 由点阵或浏览器合成。字体集中没有可用字体时为 `null`。
 */
export function metafileFonts(workbook: Workbook, fonts: FontSet): MetafileFonts | null {
  const fallback = fallbackFace(workbook, fonts)
  if (fallback === null) return null
  const cache = new Map<string, MetafileFace>()
  const resolve = (key: string, f: LoadedFace, bold: boolean, italic: boolean): MetafileFace => {
    const known = cache.get(key)
    if (known !== undefined) return known
    const v = f.text.vertical
    const css = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}`
    const out: MetafileFace = {
      vertical: (ppem) => f.vertical(ppem),
      emPerCell: v.unitsPerEm / (v.winAscent + v.winDescent || v.unitsPerEm),
      averageWidth: v.averageWidth / v.unitsPerEm,
      // `OS/2.ulCodePageRange1` 的第 31 位：符号字符集。
      symbol: ((v.codePages ?? 0) & 0x80000000) !== 0,
      advance: (cp, ppem) => f.pixelAdvance(cp, ppem) ?? f.metrics.advance(cp, ppem),
      draw: (c, text, x, baseline, ppem) => {
        const g = screenBitmap(fonts, f.family, bold, italic, text.codePointAt(0)!, ppem)
        if (g !== null) {
          fillBitmap(c, g.glyph, x, baseline, g.ascent, g.descent)
          return
        }
        c.font = `${css}${ppem}px "${f.family.replace(/["\\]/g, '')}"`
        c.fillText(text, x, baseline)
      },
    }
    cache.set(key, out)
    return out
  }
  return {
    face(name, bold, italic) {
      const f = fonts.face(name, bold, italic)
      return f === null ? null : resolve(`${name}|${bold}|${italic}`, f, bold, italic)
    },
    fallback: (bold, italic) => resolve(`\u0000|${bold}|${italic}`, fallback, bold, italic),
  }
}

/** 顶层节点所在坐标系（EMU）到工作表坐标（EMU）的映射：顶层节点在工作表上所占的矩形对齐锚点矩形 `rect`（像素）。 */
function sheetTransform(top: Frame, rect: Rect): Transform {
  const swap = nearVertical(top.rotation)
  const bw = swap ? top.height : top.width
  const bh = swap ? top.width : top.height
  const sx = bw > 0 ? (rect.width * EMU_PER_PX) / bw : 1
  const sy = bh > 0 ? (rect.height * EMU_PER_PX) / bh : 1
  return {
    sx,
    sy,
    tx: (rect.x + rect.width / 2) * EMU_PER_PX - sx * (top.x + top.width / 2),
    ty: (rect.y + rect.height / 2) * EMU_PER_PX - sy * (top.y + top.height / 2),
  }
}

function mapNode(n: ShapeNode, t: Transform): ShapeNode {
  const frame = frameOf({ ...n.frame, child: null }, t)
  if (n.kind === 'group') return { ...n, frame, children: n.children.map((c) => mapNode(c, t)) }
  return { ...n, frame }
}

function lineMargin(line: Line | null): number {
  if (line === null) return 0
  const w = line.width / EMU_PER_PX
  return w * 2 + Math.max(w, 2) * 5
}

/**
 * 外部阴影、发光与映像超出形状框的最大范围（像素）。映像以对齐点翻转，与形状框不重叠，按缩放后的整个尺寸外扩；
 * 发光的模糊范围小于其半径（`../../drawingml/paint/effects.ts`）。
 */
function effectMargin(effects: readonly Effect[], frame: Frame): number {
  const size = Math.max(frame.width, frame.height) / EMU_PER_PX
  let out = 0
  for (const e of effects) {
    if (e.kind === 'glow') out = Math.max(out, e.radius / EMU_PER_PX)
    if (e.kind === 'outerShadow') {
      const grow = Math.max(0, Math.abs(e.scaleX) - 1, Math.abs(e.scaleY) - 1)
      out = Math.max(out, (e.distance + e.blur) / EMU_PER_PX + grow * size)
    }
    if (e.kind === 'reflection') {
      const scale = Math.max(Math.abs(e.scaleX), Math.abs(e.scaleY))
      out = Math.max(out, (e.distance + e.blur) / EMU_PER_PX + scale * size)
    }
  }
  return out
}

/** 线条、箭头、外部阴影、发光与映像超出形状框的最大范围（像素）。 */
function margin(n: ShapeNode): number {
  const own = effectMargin(n.effects, n.frame)
  if (n.kind === 'group') return Math.max(own, ...n.children.map(margin))
  return Math.max(own, lineMargin(n.line))
}

/** 旋转后的形状框的外接矩形（像素）。 */
function rotatedBox(f: Frame): Rect {
  const w = f.width / EMU_PER_PX
  const h = f.height / EMU_PER_PX
  const a = (f.rotation * Math.PI) / 180
  const bw = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))
  const bh = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a))
  const cx = f.x / EMU_PER_PX + w / 2
  const cy = f.y / EMU_PER_PX + h / 2
  return { x: cx - bw / 2, y: cy - bh / 2, width: bw, height: bh }
}

/** 按锚点矩形换算工作表上的形状。`rectOf` 为锚点到工作表像素矩形的换算。 */
export function placeShape(
  shape: SheetShape,
  rectOf: (anchor: DrawingAnchor) => Rect,
): PlacedShape {
  const node = mapNode(shape.shape, sheetTransform(shape.shape.frame, rectOf(shape.anchor)))
  const box = rotatedBox(node.frame)
  const m = margin(node) + 2
  return {
    node,
    bounds: { x: box.x - m, y: box.y - m, width: box.width + 2 * m, height: box.height + 2 * m },
  }
}

/** 绘制一个节点及其后代；`parent` 为工作表坐标（像素）到设备坐标的变换。 */
export function paintShapeNode(scene: ShapeScene, n: ShapeNode, parent: Matrix): void {
  scene.ctx.save()
  switch (n.kind) {
    case 'shape':
      paintAutoShape(scene, n, parent)
      break
    case 'connector':
      paintConnector(scene, n, parent)
      break
    case 'group':
      paintGroup(scene, n, parent, (sub, inner) => {
        for (const c of n.children) paintShapeNode(sub, c, inner)
      })
      break
  }
  scene.ctx.restore()
}
