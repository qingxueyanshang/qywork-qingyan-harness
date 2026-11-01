/**
 * 工作表上的形状：锚点换算为工作表坐标，按 `../../drawingml/shape/paint.ts` 绘制。
 *
 * - 坐标：顶层节点的 `frame`（旋转接近 90° 或 270° 时宽高互换，即形状在工作表上所占的矩形）线性映射到锚点矩形，
 *   树中全部 `frame` 经同一映射由 `frameOf` 换算（接近竖直的形状横纵比例互换）。换算结果仍为 EMU，1 像素 = 9525 EMU。
 * - 文字：排版与字体规则与演示文稿相同（`../../drawingml/text/`），单倍行高见 `SHEET_SINGLE_LINE`，行高、基线与点阵
 *   按屏幕显示（`screenText`）。字体取自工作表的 `FontSet`；缺字与缺少字体时依次取 `fallbackFonts(workbook)` 与文档字体中第一个可用的字体，都没有时不绘制形状文字。
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
import { FaceCache, type ScreenText, type SlideFont } from '../../drawingml/text/fonts.ts'
import { emboldenBitmap } from '../../font/index.ts'
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
 * 小数字号按整数部分计算，百分比与固定行距的分配见 `../../drawingml/text/body.ts` 的 `screenBlock`。
 */
const SHEET_SINGLE_LINE = 1.296

/**
 * 形状文字按屏幕显示绘制（`ScreenText`）：WPS 表格对宋体 9–12 磅的形状文字使用内嵌点阵（14 磅起为轮廓），
 * 使用条件与单元格文字相同（`EmbeddedBitmaps.screenMode`）；字体没有粗体字形时点阵按 GDI 的方式加粗。
 */
function screenText(fonts: FontSet): ScreenText {
  return {
    bitmap(face, codePoint, ppem) {
      const f = fonts.face(face.family, face.bold, face.italic)
      if (!f?.bitmaps?.screenMode(ppem, face.italic)) return null
      const raw = f.bitmaps.glyph(ppem, f.metrics.glyphId(codePoint))
      if (raw === null) return null
      const { ascent, descent } = f.vertical(ppem)
      return { glyph: face.bold && !f.bold ? emboldenBitmap(raw) : raw, ascent, descent }
    },
  }
}

function faceSource(workbook: Workbook, fonts: FontSet) {
  let fallback: LoadedFace | null = null
  for (const name of [...fallbackFonts(workbook), ...workbook.fontNames]) {
    fallback = fonts.face(name, false, false)
    if (fallback !== null) break
  }
  if (fallback === null) return null
  return {
    face(name: string, bold: boolean, italic: boolean) {
      const f = fonts.face(name, bold, italic)
      return f === null ? null : slideFont(f)
    },
    fallback: slideFont(fallback),
  }
}

/** 形状文字的字体缓存；字体集中没有任何可用字体时为 `null`。 */
export function shapeFaces(workbook: Workbook, fonts: FontSet): FaceCache | null {
  const source = faceSource(workbook, fonts)
  return source === null ? null : new FaceCache(source, SHEET_SINGLE_LINE, screenText(fonts))
}

/**
 * 图表文字的字体缓存：单倍行高与演示文稿相同，不用点阵。WPS 表格中图表文字的位置与 WPS 演示一致（校准文件实测：
 * 按形状文字的行高排版时分类标签与数值轴底端标签分别高 2 与 4 像素）。
 */
export function chartFaces(workbook: Workbook, fonts: FontSet): FaceCache | null {
  const source = faceSource(workbook, fonts)
  return source === null ? null : new FaceCache(source)
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

function shadowMargin(effects: readonly Effect[], frame: Frame): number {
  let out = 0
  for (const e of effects) {
    if (e.kind !== 'outerShadow') continue
    const grow = Math.max(0, Math.abs(e.scaleX) - 1, Math.abs(e.scaleY) - 1)
    const size = Math.max(frame.width, frame.height) / EMU_PER_PX
    out = Math.max(out, (e.distance + e.blur) / EMU_PER_PX + grow * size)
  }
  return out
}

/** 线条、箭头与外部阴影超出形状框的最大范围（像素）。 */
function margin(n: ShapeNode): number {
  const own = shadowMargin(n.effects, n.frame)
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
