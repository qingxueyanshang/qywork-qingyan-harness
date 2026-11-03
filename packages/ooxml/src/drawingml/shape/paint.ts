/**
 * DrawingML 形状绘制：自选图形（填充、线条、外部阴影、文字）、连接线与组合的变换，绘制到 Canvas 2D 上下文。
 *
 * - 坐标：`Frame` 为 EMU；形状局部坐标以 96 dpi 像素为单位（1 px = 9525 EMU），原点为形状框左上角。
 *   `parent` 为外层坐标（EMU ÷ 9525）到设备坐标的变换，`ShapeScene.scale` 为每个 96 dpi 像素对应的设备像素数。
 * - 变换：形状绕自身中心旋转与翻转；组合的旋转与翻转以组合框中心为原点作用于全部后代。
 *   文字不随水平翻转镜像：变换含镜像时，文字在形状框内另施加一次水平翻转，垂直翻转因此表现为旋转 180°。
 * - 形状内的绘制顺序：各路径的填充与明暗修饰、内部阴影（填充区域内，见 `../paint/shadow.ts` 的 `paintInnerShadows`）、
 *   线条、文字。
 * - 外部阴影、发光、柔化边缘与映像（见 `../paint/effects.ts`）：形状有填充或线条时作用于填充与线条（不含文字）；都没有时
 *   外部阴影作用于文字，映像与柔化边缘作用于文字图层并以形状框为准（映像以形状框底边为对称轴），发光不绘制（WPS 演示实测：
 *   没有填充与线条的文本框，形状的发光不显示，映像为整个文本框的镜像）。组合的效果取全部后代。
 * - 锚定居中与底端：内容高度另加首行的 `BodyLayout.overhang`。
 * - 自动调整：`normAutofit` 的缩放见 `../text/body.ts`；`spAutoFit` 不改变形状尺寸，按文件中保存的尺寸绘制。
 * - 竖排：`vert` 与 `eaVert` 顺时针转 90°、`vert270` 逆时针转 90° 绘制，`eaVert` 的东亚文字直立（见 `../text/body.ts`）；
 *   不绘制竖排方式为 `wordArtVert` 等的文字（求值时已登记）。
 */

import type { Effect, Line, ShapeFill } from '../fill.ts'
import type { Geometry } from '../geometry/model.ts'
import { type ShapeOutline, shapeOutline } from '../geometry/path.ts'
import {
  IDENTITY,
  type Matrix,
  multiply,
  type PaintContext,
  rotation,
  scaling,
  setMatrix,
  translation,
} from '../paint/context.ts'
import {
  hasLayerEffects,
  type LayerEffects,
  layerEffects,
  NO_EFFECTS,
  paintWithEffects,
} from '../paint/effects.ts'
import {
  appendPath,
  type PaintResources,
  paintFill,
  paintFillModifier,
  tracePath,
} from '../paint/fill.ts'
import { lineWidth, paintLine } from '../paint/line.ts'
import {
  deviceBounds,
  type InnerShadow,
  type OuterShadow,
  paintInnerShadows,
  pathBounds,
} from '../paint/shadow.ts'
import { layoutBody, paintBody, type TextSettings } from '../text/body.ts'
import type { TextBody } from '../text/model.ts'
import type { ThreeD } from '../three/model.ts'
import { paintThreeD } from '../three/paint.ts'
import type { Frame } from './model.ts'

export const EMU_PER_PX = 9525
const PX_PER_PT = 4 / 3
/** 按旋转绘制的文字方向；其余竖排方式不绘制。 */
const ROTATED_TEXT: Readonly<Record<string, number>> = {
  horz: 0,
  vert: 90,
  vert270: -90,
  eaVert: 90,
}

export interface ShapeScene {
  readonly ctx: PaintContext
  readonly res: PaintResources
  readonly scale: number
  /** 设备像素中的绘制范围（从原点起），图层的边界以此裁剪。 */
  readonly canvas: { width: number; height: number }
  /** 形状文字的排版设置；没有可用字体时为 `null`，形状文字不绘制。 */
  readonly settings: TextSettings | null
}

/** 形状框（像素）与局部坐标到设备坐标的变换。 */
export interface Placed {
  readonly width: number
  readonly height: number
  readonly matrix: Matrix
}

/** 自选图形的绘制属性。 */
export interface PaintableShape {
  readonly frame: Frame
  readonly geometry: Geometry
  readonly fill: ShapeFill
  readonly line: Line | null
  readonly effects: readonly Effect[]
  readonly text: TextBody | null
}

/** 连接线的绘制属性：只有线条。 */
export interface PaintableConnector {
  readonly frame: Frame
  readonly geometry: Geometry
  readonly line: Line | null
}

export function placeFrame(frame: Frame, parent: Matrix): Placed {
  const width = frame.width / EMU_PER_PX
  const height = frame.height / EMU_PER_PX
  const cx = frame.x / EMU_PER_PX + width / 2
  const cy = frame.y / EMU_PER_PX + height / 2
  const local = multiply(
    translation(cx, cy),
    multiply(
      rotation((frame.rotation * Math.PI) / 180),
      multiply(
        scaling(frame.flipH ? -1 : 1, frame.flipV ? -1 : 1),
        translation(-width / 2, -height / 2),
      ),
    ),
  )
  return { width, height, matrix: multiply(parent, local) }
}

/** 组合对后代施加的变换：以组合框中心为原点旋转与翻转。 */
export function groupMatrix(frame: Frame, parent: Matrix): Matrix {
  const cx = (frame.x + frame.width / 2) / EMU_PER_PX
  const cy = (frame.y + frame.height / 2) / EMU_PER_PX
  const local = multiply(
    translation(cx, cy),
    multiply(
      rotation((frame.rotation * Math.PI) / 180),
      multiply(scaling(frame.flipH ? -1 : 1, frame.flipV ? -1 : 1), translation(-cx, -cy)),
    ),
  )
  return multiply(parent, local)
}

export function shadowsOf(effects: readonly Effect[]): OuterShadow[] {
  return effects.filter((e): e is OuterShadow => e.kind === 'outerShadow')
}

export function innerShadowsOf(effects: readonly Effect[]): InnerShadow[] {
  return effects.filter((e): e is InnerShadow => e.kind === 'innerShadow')
}

/** 内部阴影画在全部有填充的路径合成的区域内。 */
export function paintInnerShadowsOf(
  ctx: PaintContext,
  outline: ShapeOutline,
  inner: readonly InnerShadow[],
  placed: Placed,
  scale: number,
): void {
  if (inner.length === 0) return
  const filled = outline.paths.filter((p) => p.fill !== 'none')
  const append = () => {
    for (const p of filled) appendPath(ctx, p.segments)
  }
  paintInnerShadows(ctx, append, inner, { ...placed, scale })
}

export function outlineOf(shape: { geometry: Geometry; frame: Frame }): ShapeOutline {
  return shapeOutline(shape.geometry, shape.frame.width, shape.frame.height, 1 / EMU_PER_PX)
}

/** 填充与线条（不含文字）超出路径的范围（局部单位）：线宽与最大的箭头，另加 2 像素的抗锯齿余量。 */
export function strokeMargin(shape: { line: Line | null }, placed: Placed): number {
  const w = shape.line === null ? 0 : lineWidth(shape.line, placed.matrix)
  return w * 2 + Math.max(w, 2) * 5 + 2
}

/** `fill` 为 `null` 时只画线条（连接线）；`inner` 为内部阴影，形状有填充时绘制。 */
function paintGeometry(
  scene: ShapeScene,
  ctx: PaintContext,
  fill: ShapeFill | null,
  line: Line | null,
  outline: ShapeOutline,
  placed: Placed,
  inner: readonly InnerShadow[],
): void {
  const area = { width: placed.width, height: placed.height, matrix: placed.matrix }
  if (fill !== null) {
    for (const path of outline.paths) {
      if (path.fill === 'none') continue
      const trace = () => tracePath(ctx, path.segments)
      setMatrix(ctx, placed.matrix)
      paintFill(ctx, trace, fill, area, scene.res)
      if (fill.kind !== 'none') paintFillModifier(ctx, trace, path.fill)
    }
    if (fill.kind !== 'none') paintInnerShadowsOf(ctx, outline, inner, placed, scene.scale)
  }
  if (line !== null) paintLine(ctx, outline.paths, line, area, scene.res, scene.canvas)
}

function hasGeometryPaint(shape: PaintableShape): boolean {
  return shape.fill.kind !== 'none' || shape.line !== null
}

export function paintAutoShape(scene: ShapeScene, shape: PaintableShape, parent: Matrix): void {
  const placed = placeFrame(shape.frame, parent)
  const outline = outlineOf(shape)
  const effects = layerEffects(shape.effects)
  const inner = innerShadowsOf(shape.effects)
  const frame = {
    matrix: placed.matrix,
    width: placed.width,
    height: placed.height,
    scale: scene.scale,
  }
  const geometry = hasGeometryPaint(shape)
  if (geometry && hasLayerEffects(effects)) {
    const bounds = pathBounds(
      outline.paths,
      placed.matrix,
      strokeMargin(shape, placed),
      scene.canvas,
    )
    if (bounds !== null) {
      paintWithEffects(scene.ctx, effects, frame, bounds, scene.res, scene.canvas, (c, offset) =>
        paintGeometry(
          scene,
          c,
          shape.fill,
          shape.line,
          outline,
          { ...placed, matrix: multiply(offset, placed.matrix) },
          inner,
        ),
      )
    }
  } else {
    paintGeometry(scene, scene.ctx, shape.fill, shape.line, outline, placed, inner)
  }
  if (shape.text === null || scene.settings === null) return
  const settings = scene.settings
  const text = shape.text
  if (geometry) {
    paintShapeText(scene, settings, text, outline, placed, [])
    return
  }
  const box: LayerEffects = {
    ...NO_EFFECTS,
    softEdge: effects.softEdge,
    reflection: effects.reflection,
  }
  if (!hasLayerEffects(box)) {
    paintShapeText(scene, settings, text, outline, placed, effects.shadows)
    return
  }
  // 文字可能超出形状框：图层取形状框外扩一个框的大小。
  const bounds = deviceBounds(
    placed.matrix,
    0,
    0,
    placed.width,
    placed.height,
    (placed.width + placed.height) * scene.scale,
    scene.canvas,
  )
  if (bounds === null) return
  paintWithEffects(scene.ctx, box, frame, bounds, scene.res, scene.canvas, (c, offset) =>
    paintShapeText(
      { ...scene, ctx: c },
      settings,
      text,
      outline,
      { ...placed, matrix: multiply(offset, placed.matrix) },
      effects.shadows,
    ),
  )
}

/**
 * 带三维效果的自选图形（见 `../three/paint.ts`）：填充、线条与文字按平面画到图层后投影并着色，外部阴影取投影后的轮廓
 * （形状没有填充与线条时阴影作用于文字，在投影之前画出）。
 */
export function paintAutoShapeThreeD(
  scene: ShapeScene,
  shape: PaintableShape,
  three: ThreeD,
  parent: Matrix,
): void {
  const placed = placeFrame(shape.frame, parent)
  const outline = outlineOf(shape)
  const shadows = shadowsOf(shape.effects)
  const geometry = hasGeometryPaint(shape)
  paintThreeD(
    scene,
    three,
    placed,
    strokeMargin(shape, placed),
    geometry ? shadows : [],
    (c, offset, size) => {
      const inner: ShapeScene = { ...scene, ctx: c, canvas: size }
      const p = { ...placed, matrix: multiply(offset, placed.matrix) }
      paintGeometry(inner, c, shape.fill, shape.line, outline, p, innerShadowsOf(shape.effects))
      if (shape.text !== null && scene.settings !== null)
        paintShapeText(inner, scene.settings, shape.text, outline, p, geometry ? [] : shadows)
    },
  )
}

/** 文本框的文字：边距、旋转（`bodyPr/@rot` 与 `vert`、`vert270`）、锚定与 `anchorCtr`。 */
function paintShapeText(
  scene: ShapeScene,
  settings: TextSettings,
  text: TextBody,
  outline: ShapeOutline,
  placed: Placed,
  shadows: readonly OuterShadow[],
): void {
  const body = text.body
  const turn = ROTATED_TEXT[body.vertical]
  if (turn === undefined) return
  const r = outline.textRect
  const left = r.left + body.insetLeft / EMU_PER_PX
  const top = r.top + body.insetTop / EMU_PER_PX
  const w = r.right - r.left - (body.insetLeft + body.insetRight) / EMU_PER_PX
  const h = r.bottom - r.top - (body.insetTop + body.insetBottom) / EMU_PER_PX
  const vertical = turn !== 0
  const aw = vertical ? h : w
  const ah = vertical ? w : h
  const layout = layoutBody(text, aw / PX_PER_PT, settings)
  const free = ah / PX_PER_PT - layout.height - layout.overhang
  const dy = body.anchor === 'ctr' ? free / 2 : body.anchor === 'b' ? free : 0
  let dx = 0
  if (body.anchorCenter) {
    let right = 0
    for (const p of layout.paragraphs) {
      p.block.lines.forEach((l, i) => {
        right = Math.max(right, p.x + l.left + l.width + (p.shifts[i] ?? 0))
      })
    }
    dx = (aw / PX_PER_PT - right) / 2
  }
  const m = placed.matrix
  const mirrored = m.a * m.d - m.b * m.c < 0
  const unmirror = mirrored ? multiply(translation(placed.width, 0), scaling(-1, 1)) : IDENTITY
  const angle = ((turn + body.rotation) * Math.PI) / 180
  const matrix = multiply(
    m,
    multiply(
      unmirror,
      multiply(
        translation(left + w / 2, top + h / 2),
        multiply(
          rotation(angle),
          multiply(
            translation(-aw / 2, -ah / 2),
            multiply(scaling(PX_PER_PT, PX_PER_PT), translation(dx, dy)),
          ),
        ),
      ),
    ),
  )
  paintBody(
    scene.ctx,
    layout,
    { matrix, width: aw / PX_PER_PT, height: ah / PX_PER_PT, scale: scene.scale },
    settings.faces,
    scene.res,
    scene.canvas,
    shadows,
  )
}

export function paintConnector(scene: ShapeScene, shape: PaintableConnector, parent: Matrix): void {
  const placed = placeFrame(shape.frame, parent)
  paintGeometry(scene, scene.ctx, null, shape.line, outlineOf(shape), placed, [])
}

/**
 * 组合：`paintChildren` 以组合对后代施加的变换绘制全部子形状。组合有图层效果（外部阴影、发光、柔化边缘、映像）时，
 * 子形状先画到图层，效果取图层中全部后代。
 */
export function paintGroup<S extends ShapeScene>(
  scene: S,
  group: { readonly frame: Frame; readonly effects: readonly Effect[] },
  parent: Matrix,
  paintChildren: (scene: S, inner: Matrix) => void,
): void {
  const inner = groupMatrix(group.frame, parent)
  const effects = layerEffects(group.effects)
  if (!hasLayerEffects(effects)) {
    paintChildren(scene, inner)
    return
  }
  const placed = placeFrame(group.frame, parent)
  const bounds = deviceBounds(
    placed.matrix,
    0,
    0,
    placed.width,
    placed.height,
    (Math.max(placed.width, placed.height) + 20) * scene.scale,
    scene.canvas,
  )
  if (bounds === null) return
  paintWithEffects(
    scene.ctx,
    effects,
    { matrix: placed.matrix, width: placed.width, height: placed.height, scale: scene.scale },
    bounds,
    scene.res,
    scene.canvas,
    (c, offset) => paintChildren({ ...scene, ctx: c }, multiply(offset, inner)),
  )
}
