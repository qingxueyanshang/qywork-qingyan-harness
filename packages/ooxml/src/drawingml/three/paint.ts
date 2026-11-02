/**
 * 三维对象的绘制：对象先按平面绘制到图层，再逐像素按投影的逆映射从图层取样（双线性，按预乘透明度插值）并施加光照，
 * 得到的图层与外部阴影按普通图层合成。逐像素映射使透视保持直线、相邻区域之间没有接缝；Canvas 2D 只有仿射变换，
 * 分块贴图在块的边界上会因抗锯齿出现细缝。
 *
 * - 坐标：形状局部坐标（像素，原点为形状框左上角）经投影后再经 `placed.matrix` 到设备坐标；形状自身的旋转与翻转
 *   在投影之后施加。
 * - 图层按设备像素分配；平面图层或结果图层超过 `MAX_PIXELS` 时按平面绘制（不投影、不着色）。
 */

import {
  apply,
  invert,
  type Matrix,
  multiply,
  type PaintContext,
  translation,
} from '../paint/context.ts'
import { drawLayerOnto, type OuterShadow, paintShadows } from '../paint/shadow.ts'
import type { Placed, ShapeScene } from '../shape/paint.ts'
import { projector } from './camera.ts'
import type { ThreeD } from './model.ts'

const MAX_PIXELS = 1 << 24

/** 逐像素数据（`ImageData`）：按行排列的非预乘 RGBA，每通道 0–255。 */
export interface PixelData {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

/** 可逐像素读写的图层上下文：浏览器的二维上下文都满足；不满足时按平面绘制。 */
export interface PixelContext extends PaintContext {
  getImageData(x: number, y: number, w: number, h: number): PixelData
  putImageData(data: PixelData, x: number, y: number): void
}

function pixelContext(ctx: PaintContext | null): PixelContext | null {
  return ctx !== null && 'getImageData' in ctx && 'putImageData' in ctx
    ? (ctx as PixelContext)
    : null
}

interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

function boxOf(points: readonly { x: number; y: number }[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  const x = Math.floor(x0)
  const y = Math.floor(y0)
  return { x, y, w: Math.ceil(x1) - x, h: Math.ceil(y1) - y }
}

/**
 * 绘制三维对象。`margin` 为平面内容超出形状框的范围（局部单位，含线宽与箭头）；`draw` 把平面内容画到 `ctx`，
 * `offset` 须左乘到其使用的设备变换上（同 `drawLayer`），`size` 为 `ctx` 的像素尺寸（图层的裁剪范围）。
 * `shadows` 为对象的外部阴影，取投影后的轮廓。
 */
export function paintThreeD(
  scene: ShapeScene,
  three: ThreeD,
  placed: Placed,
  margin: number,
  shadows: readonly OuterShadow[],
  draw: (ctx: PaintContext, offset: Matrix, size: { width: number; height: number }) => void,
): void {
  const { width: w, height: h, matrix: m } = placed
  const local = [
    { x: -margin, y: -margin },
    { x: w + margin, y: -margin },
    { x: w + margin, y: h + margin },
    { x: -margin, y: h + margin },
  ]
  const flat = boxOf(local.map((p) => apply(m, p.x, p.y)))
  const proj = projector(three, w, h)
  const out = boxOf(
    local.map((p) => {
      const q = proj.forward(p.x, p.y)
      return apply(m, q.x, q.y)
    }),
  )
  const left = Math.max(0, out.x)
  const top = Math.max(0, out.y)
  const dest: Box = {
    x: left,
    y: top,
    w: Math.min(scene.canvas.width, out.x + out.w) - left,
    h: Math.min(scene.canvas.height, out.y + out.h) - top,
  }
  if (dest.w <= 0 || dest.h <= 0) return
  const fallback = () => draw(scene.ctx, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, scene.canvas)
  if (flat.w * flat.h > MAX_PIXELS || dest.w * dest.h > MAX_PIXELS || flat.w <= 0 || flat.h <= 0) {
    fallback()
    return
  }
  const source = scene.res.createCanvas(flat.w, flat.h)
  const sc = pixelContext(source.getContext('2d', { willReadFrequently: true }))
  const target = scene.res.createCanvas(dest.w, dest.h)
  const tc = pixelContext(target.getContext('2d', { willReadFrequently: true }))
  if (sc === null || tc === null) {
    fallback()
    return
  }
  draw(sc, translation(-flat.x, -flat.y), { width: flat.w, height: flat.h })
  const src = sc.getImageData(0, 0, flat.w, flat.h)
  const img = tc.getImageData(0, 0, dest.w, dest.h)
  resample(src.data, flat, img.data, dest, m, proj, local[0]!, local[2]!, three)
  tc.putImageData(img, 0, 0)
  if (shadows.length > 0) {
    paintShadows(
      scene.ctx,
      target,
      dest,
      shadows,
      { matrix: m, width: w, height: h, scale: scene.scale },
      scene.canvas,
    )
  }
  drawLayerOnto(scene.ctx, target, dest)
}

/** 结果图层逐像素：像素中心经逆映射回到平面图层，双线性取样后着色。 */
function resample(
  src: Uint8ClampedArray,
  flat: Box,
  dst: Uint8ClampedArray,
  dest: Box,
  m: Matrix,
  proj: ReturnType<typeof projector>,
  lo: { x: number; y: number },
  hi: { x: number; y: number },
  three: ThreeD,
): void {
  const back = invert(m)
  // 局部坐标到平面图层像素（像素中心在 +0.5 处）。
  const toFlat = multiply(translation(-flat.x - 0.5, -flat.y - 0.5), m)
  const { scale, add } = three
  for (let j = 0; j < dest.h; j++) {
    for (let i = 0; i < dest.w; i++) {
      const p = apply(back, dest.x + i + 0.5, dest.y + j + 0.5)
      const q = proj.inverse(p.x, p.y)
      if (q === null || q.u < lo.x || q.u > hi.x || q.v < lo.y || q.v > hi.y) continue
      const s = apply(toFlat, q.u, q.v)
      const x0 = Math.floor(s.x)
      const y0 = Math.floor(s.y)
      const fx = s.x - x0
      const fy = s.y - y0
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let k = 0; k < 4; k++) {
        const x = x0 + (k & 1)
        const y = y0 + (k >> 1)
        if (x < 0 || y < 0 || x >= flat.w || y >= flat.h) continue
        const wgt = (k & 1 ? fx : 1 - fx) * (k >> 1 ? fy : 1 - fy)
        const o = (y * flat.w + x) * 4
        const al = src[o + 3]! * wgt
        r += src[o]! * al
        g += src[o + 1]! * al
        b += src[o + 2]! * al
        a += al
      }
      if (a <= 0) continue
      const o = (j * dest.w + i) * 4
      dst[o] = (r / a) * scale + add
      dst[o + 1] = (g / a) * scale + add
      dst[o + 2] = (b / a) * scale + add
      dst[o + 3] = a
    }
  }
}
