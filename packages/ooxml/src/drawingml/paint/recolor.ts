/**
 * 图片效果（`ImageEffect`）的像素运算：作用于图片的非预乘 RGB，透明度不变（透明色除外）。
 *
 * - 运算顺序与文档中的顺序无关（WPS 演示实测，构造文件中交换元素顺序结果相同）：先按原图像素去掉透明色，再取一种
 *   颜色模式，最后施加亮度与对比度。颜色模式按黑白、灰度、双色调的优先级只取一种：黑白与双色调同时出现时只按黑白，
 *   灰度与双色调同时出现时只按灰度。
 * - 结果按图片缓存（每张图片、每组效果一份），图层由调用方的 `createCanvas` 提供；图层不能逐像素读写时按原图绘制。
 */

import type { ImageEffect } from '../fill.ts'
import { type CreateCanvas, type PaintImage, pixelContext } from './context.ts'

/**
 * 灰度：`(55 R + 183 G + 18 B) >> 8`，三个通道相同。WPS 演示实测：256 级灰阶与两条色相带（饱和度 100% 与 50%）
 * 的 8 万个像素逐一相同。
 */
function gray(r: number, g: number, b: number): number {
  return (55 * r + 183 * g + 18 * b) >> 8
}

/** 亮度与对比度按 2% 取整（WPS 演示实测：亮度 0.11–0.12 与 0.13 结果相同，取整后 347 组网格的平均误差由 0.36 级降到 0.27 级）。 */
function step(v: number): number {
  return Math.floor(v * 50 + 0.5) / 50
}

/**
 * 亮度与对比度的映射表。对比度 `c` 为斜率：`c ≥ 0` 时为 `1 / (1 − c)`，绕 127.5 拉伸（`c` 为 1 时为阶跃）；`c < 0` 时为 `1 + c`，
 * 绕 127 压缩。
 * 亮度 `b` 的偏移量 `B`：`b > 0` 时为 `256 b − 1`，否则为 `255 b`；偏移量的一半加在对比度之前、一半加在之后。
 * 亮度为正而对比度为负时改为 `k · v + B + 38.5 (1 − k)`。WPS 演示实测（256 级灰阶，亮度 −1–0.96 与对比度 −0.95–0.95 的
 * 347 组组合）：平均误差 0.27 级，最大 5 级。
 */
function luminanceTable(bright: number, contrast: number): Uint8ClampedArray {
  const b = step(bright)
  const c = step(contrast)
  const k = c >= 0 ? 1 / Math.max(1e-6, 1 - c) : 1 + c
  const offset = b > 0 ? 256 * b - 1 : 255 * b
  const pivot = c >= 0 ? 127.5 : 127
  const table = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) {
    const y =
      b > 0 && c < 0
        ? k * v + offset + 38.5 * (1 - k)
        : k * (v - pivot) + pivot + (offset * (1 + k)) / 2
    table[v] = Math.round(y)
  }
  return table
}

type Mode = Extract<ImageEffect, { kind: 'biLevel' | 'grayscale' | 'duotone' }>

const MODE_RANK: Readonly<Record<Mode['kind'], number>> = { biLevel: 0, grayscale: 1, duotone: 2 }

/** 逐像素施加效果（`data` 为非预乘的 RGBA，原地修改）。`other` 不改变像素。 */
export function recolorPixels(data: Uint8ClampedArray, effects: readonly ImageEffect[]): void {
  let mode: Mode | null = null
  let lum: Uint8ClampedArray | null = null
  const changes: { r: number; g: number; b: number }[] = []
  for (const e of effects) {
    if (e.kind === 'luminance') lum = luminanceTable(e.bright, e.contrast)
    else if (e.kind === 'colorChange') {
      const { r, g, b } = e.from
      changes.push({ r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) })
    } else if (e.kind !== 'other' && (mode === null || MODE_RANK[e.kind] < MODE_RANK[mode.kind]))
      mode = e
  }
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    // 透明色：不透明且三个通道与之相差都不超过 1 的像素（WPS 演示实测：FFFFFF 去掉 FEFEFE、FFFFFE，不去掉 FDFDFD）。
    if (
      data[i + 3] === 255 &&
      changes.some(
        (c) => Math.abs(r - c.r) <= 1 && Math.abs(g - c.g) <= 1 && Math.abs(b - c.b) <= 1,
      )
    ) {
      data[i + 3] = 0
      continue
    }
    if (mode !== null) {
      if (mode.kind === 'biLevel') {
        // 黑白：灰度不低于 `thresh × 256` 为白色（实测阈值 25%、50%、75% 的分界为 64、128、192）。
        const v = gray(r, g, b) >= mode.threshold * 256 ? 255 : 0
        data[i] = data[i + 1] = data[i + 2] = v
      } else if (mode.kind === 'grayscale') {
        data[i] = data[i + 1] = data[i + 2] = gray(r, g, b)
      } else {
        // 双色调：两种颜色之间按灰度（不取整）线性插值后向下取整。
        const t = (55 * r + 183 * g + 18 * b) / 256 / 255
        const d = mode.dark
        const l = mode.light
        data[i] = Math.floor((d.r + (l.r - d.r) * t) * 255)
        data[i + 1] = Math.floor((d.g + (l.g - d.g) * t) * 255)
        data[i + 2] = Math.floor((d.b + (l.b - d.b) * t) * 255)
      }
    }
    if (lum !== null) {
      data[i] = lum[data[i]!]!
      data[i + 1] = lum[data[i + 1]!]!
      data[i + 2] = lum[data[i + 2]!]!
    }
  }
}

/** 是否有改变像素的效果：取整后亮度与对比度都为 0 的 `lum` 不改变像素。 */
export function recolors(effects: readonly ImageEffect[]): boolean {
  return effects.some(
    (e) =>
      e.kind !== 'other' &&
      !(e.kind === 'luminance' && step(e.bright) === 0 && step(e.contrast) === 0),
  )
}

const cache = new WeakMap<PaintImage, Map<string, PaintImage>>()

/**
 * 施加效果后的图片。`effects` 没有改变像素的效果，或图层不能逐像素读写时返回原图。
 */
export function recolorImage(
  image: PaintImage,
  effects: readonly ImageEffect[],
  createCanvas: CreateCanvas,
): PaintImage {
  if (!recolors(effects) || image.width === 0 || image.height === 0) return image
  const key = JSON.stringify(effects)
  let entries = cache.get(image)
  const hit = entries?.get(key)
  if (hit !== undefined) return hit
  const canvas = createCanvas(image.width, image.height)
  const c = pixelContext(canvas.getContext('2d', { willReadFrequently: true }))
  if (c === null) return image
  c.drawImage(image, 0, 0)
  const pixels = c.getImageData(0, 0, image.width, image.height)
  recolorPixels(pixels.data, effects)
  c.putImageData(pixels, 0, 0)
  if (entries === undefined) {
    entries = new Map()
    cache.set(image, entries)
  }
  entries.set(key, canvas)
  return canvas
}
