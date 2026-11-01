/**
 * 外部阴影（`outerShdw`）：先把内容绘制到图层，再以图层的不透明度为轮廓绘制阴影，最后绘制图层本身。
 *
 * - 阴影只取内容的轮廓：填充与线条重叠处不重复加深，半透明内容的阴影按其不透明度减淡。
 * - 偏移与缩放、倾斜在幻灯片坐标中施加（`rotWithShape` 为真时随形状旋转）；缩放与倾斜以 `algn`
 *   所指的形状框位置为原点。模糊半径按 Canvas `shadowBlur` 的同值设备像素绘制。
 * - 阴影单独绘制：图层画在画布之外，以同等距离的 `shadowOffsetX` 把阴影移回原位，
 *   因此阴影可以带有与内容不同的变换。
 */

import { type Color, colorToCss } from '../color.ts'
import type { EffectOf } from '../fill.ts'
import type { ShapePath } from '../geometry/path.ts'
import {
  apply,
  IDENTITY,
  invert,
  type Matrix,
  multiply,
  type PaintCanvas,
  type PaintContext,
  scaling,
  setMatrix,
  translation,
} from './context.ts'
import { deviceScale, type PaintResources } from './fill.ts'

export type OuterShadow = Extract<EffectOf<Color>, { readonly kind: 'outerShadow' }>

const EMU_PER_PX = 9525

export interface DeviceRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** 局部矩形经变换后在设备坐标中的整数外接矩形，四周加 `margin` 个设备像素，并限定在画布内。 */
export function deviceBounds(
  matrix: Matrix,
  left: number,
  top: number,
  right: number,
  bottom: number,
  margin: number,
  canvas: { width: number; height: number },
): DeviceRect | null {
  const pts = [
    apply(matrix, left, top),
    apply(matrix, right, top),
    apply(matrix, right, bottom),
    apply(matrix, left, bottom),
  ]
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - margin))
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - margin))
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(...pts.map((p) => p.x)) + margin))
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(...pts.map((p) => p.y)) + margin))
  if (x1 <= x0 || y1 <= y0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * 路径在设备坐标中的整数外接矩形：路径坐标外扩 `margin`（局部单位），并限定在画布内。
 * 弧段按整个椭圆的外接矩形计算。
 */
export function pathBounds(
  paths: readonly ShapePath[],
  matrix: Matrix,
  margin: number,
  clip: { width: number; height: number },
): DeviceRect | null {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  const add = (x: number, y: number) => {
    const dx = matrix.a * x + matrix.c * y + matrix.e
    const dy = matrix.b * x + matrix.d * y + matrix.f
    x0 = Math.min(x0, dx)
    y0 = Math.min(y0, dy)
    x1 = Math.max(x1, dx)
    y1 = Math.max(y1, dy)
  }
  for (const p of paths) {
    for (const s of p.segments) {
      if (s.kind === 'close') continue
      if (s.kind === 'arc') {
        add(s.cx - s.rx, s.cy - s.ry)
        add(s.cx + s.rx, s.cy + s.ry)
        add(s.cx - s.rx, s.cy + s.ry)
        add(s.cx + s.rx, s.cy - s.ry)
        continue
      }
      add(s.x, s.y)
      if (s.kind === 'quad') add(s.x1, s.y1)
      if (s.kind === 'cubic') {
        add(s.x1, s.y1)
        add(s.x2, s.y2)
      }
    }
  }
  if (!Number.isFinite(x0)) return null
  const m = margin * deviceScale(matrix)
  const left = Math.max(0, Math.floor(x0 - m))
  const top = Math.max(0, Math.floor(y0 - m))
  const right = Math.min(clip.width, Math.ceil(x1 + m))
  const bottom = Math.min(clip.height, Math.ceil(y1 + m))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/** 在 `bounds` 大小的图层中绘制；`draw` 收到的 `offset` 须左乘到其使用的设备变换上。 */
export function drawLayer(
  bounds: DeviceRect,
  res: PaintResources,
  draw: (ctx: PaintContext, offset: Matrix) => void,
): PaintCanvas | null {
  const layer = res.createCanvas(bounds.w, bounds.h)
  const c = layer.getContext('2d')
  if (c === null) return null
  draw(c, translation(-bounds.x, -bounds.y))
  return layer
}

/** 对齐点在形状框中的相对位置：`tl`、`t`、`tr`、`l`、`ctr`、`r`、`bl`、`b`、`br`。 */
function alignPoint(align: string): { x: number; y: number } {
  if (align === 'ctr') return { x: 0.5, y: 0.5 }
  const v = align.length === 2 ? align[0] : align === 't' || align === 'b' ? align : ''
  const h = align.length === 2 ? align[1] : align === 'l' || align === 'r' ? align : ''
  return { x: h === 'l' ? 0 : h === 'r' ? 1 : 0.5, y: v === 't' ? 0 : v === 'b' ? 1 : 0.5 }
}

/**
 * 阴影在设备坐标中的变换。`shape` 为形状局部坐标到设备坐标的变换，`width`、`height` 为形状框（局部单位）；
 * `scale` 为每个 96 dpi 像素对应的设备像素数，用于换算以 EMU 计的距离。
 */
export function shadowMatrix(
  shadow: OuterShadow,
  shape: Matrix,
  width: number,
  height: number,
  scale: number,
): Matrix {
  const s = deviceScale(shape)
  const dist = (shadow.distance / EMU_PER_PX) * scale
  const dir = (shadow.direction * Math.PI) / 180
  // 形状自身的旋转（含翻转）：只保留方向，去掉缩放。
  const orient = { a: shape.a / s, b: shape.b / s, c: shape.c / s, d: shape.d / s, e: 0, f: 0 }
  const a = alignPoint(shadow.align)
  const origin = apply(shape, a.x * width, a.y * height)
  let linear = multiply(scaling(shadow.scaleX, shadow.scaleY), {
    a: 1,
    b: Math.tan((shadow.skewY * Math.PI) / 180),
    c: Math.tan((shadow.skewX * Math.PI) / 180),
    d: 1,
    e: 0,
    f: 0,
  })
  let offset = { x: dist * Math.cos(dir), y: dist * Math.sin(dir) }
  if (shadow.rotateWithShape) {
    linear = multiply(orient, multiply(linear, invert(orient)))
    offset = apply(orient, offset.x, offset.y)
  }
  return multiply(
    translation(origin.x + offset.x, origin.y + offset.y),
    multiply(linear, translation(-origin.x, -origin.y)),
  )
}

export interface ShadowFrame {
  /** 形状局部坐标到设备坐标。 */
  readonly matrix: Matrix
  /** 形状框（局部单位），确定 `algn` 的位置。 */
  readonly width: number
  readonly height: number
  /** 每个 96 dpi 像素对应的设备像素数。 */
  readonly scale: number
}

/** 只绘制图层内容的阴影，不绘制图层本身。`bounds` 为图层在设备坐标中的位置。 */
export function paintShadows(
  ctx: PaintContext,
  layer: PaintCanvas,
  bounds: DeviceRect,
  shadows: readonly OuterShadow[],
  frame: ShadowFrame,
  canvas: { width: number; height: number },
): void {
  const away = canvas.width + bounds.x + bounds.w + 1000
  for (const shadow of shadows) {
    const m = shadowMatrix(shadow, frame.matrix, frame.width, frame.height, frame.scale)
    ctx.save()
    setMatrix(ctx, multiply(translation(-away, 0), m))
    ctx.shadowColor = colorToCss(shadow.color)
    ctx.shadowBlur = (shadow.blur / EMU_PER_PX) * frame.scale
    ctx.shadowOffsetX = away
    ctx.shadowOffsetY = 0
    ctx.drawImage(layer, bounds.x, bounds.y)
    ctx.restore()
  }
}

/** 把图层按设备坐标原样画到画布上。 */
export function drawLayerOnto(ctx: PaintContext, layer: PaintCanvas, bounds: DeviceRect): void {
  ctx.save()
  setMatrix(ctx, IDENTITY)
  ctx.drawImage(layer, bounds.x, bounds.y)
  ctx.restore()
}

/**
 * 带外部阴影绘制：`draw` 把内容画到图层（参数同 `drawLayer`），随后依次绘制各阴影与图层本身。
 * `bounds` 为内容在设备坐标中的外接矩形。
 */
export function paintWithShadows(
  ctx: PaintContext,
  shadows: readonly OuterShadow[],
  frame: ShadowFrame,
  bounds: DeviceRect,
  res: PaintResources,
  canvas: { width: number; height: number },
  draw: (ctx: PaintContext, offset: Matrix) => void,
): void {
  const layer = drawLayer(bounds, res, draw)
  if (layer === null) return
  paintShadows(ctx, layer, bounds, shadows, frame, canvas)
  drawLayerOnto(ctx, layer, bounds)
}
