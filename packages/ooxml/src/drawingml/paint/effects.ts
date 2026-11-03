/**
 * 图层效果：外部阴影、发光（`glow`）、柔化边缘（`softEdge`）与映像（`reflection`）。内容先画到图层，效果按图层计算。
 *
 * - 发光：图层的不透明度以圆形结构元膨胀 `d = max(1, ⌊0.425 r⌋)` 个设备像素后高斯模糊，乘以发光颜色，画在内容之下
 *   （`r` 为半径的设备像素数）。柔化边缘：不透明度以同样的结构元腐蚀 `⌊0.83 r⌋` 个设备像素后高斯模糊，再乘到内容上。
 *   两者的模糊 σ 只取决于该整数：σ = 0.325 d + 0.27。WPS 演示实测（导出图，矩形、椭圆、圆角矩形、只有线条的矩形与图片，
 *   发光 2–28 磅、柔化边缘 2–24 磅）：边缘剖面按膨胀或腐蚀加高斯模糊拟合，均方根误差约 1/255，拟合的膨胀与腐蚀量都是整数，
 *   相同整数的 σ 相同；转角处圆形结构元的误差小于方形。发光在形状内部同样存在（半透明填充之下可见）。
 * - 映像：内容按与外部阴影相同的变换（`shadowMatrix`：缩放、倾斜、对齐点与距离）画出；不透明度沿映像自对称轴向外，
 *   在 `stPos` 处为 `stA`、`endPos` 处为 `endA`，其间线性变化，位置以映像的高度计（`sy` 为 −50% 时渐变范围随之减半）。
 *   模糊 σ 为 `blurRad` 设备像素数的三分之一。WPS 演示实测（160 × 100 像素矩形，距离、模糊、起止位置与透明度、`sy`）。
 * - 合成顺序自下而上：映像、外部阴影、发光、内容。柔化边缘先作用于内容，映像、阴影与发光都取柔化后的内容。
 * 图层不能逐像素读写时（`pixelContext` 为 `null`）不绘制发光，柔化边缘与映像的模糊不施加。
 */

import type { Color } from '../color.ts'
import type { EffectOf } from '../fill.ts'
import {
  IDENTITY,
  type Matrix,
  multiply,
  type PaintCanvas,
  type PaintContext,
  type PixelContext,
  pixelContext,
  setMatrix,
  translation,
} from './context.ts'
import type { PaintResources } from './fill.ts'
import {
  type DeviceRect,
  drawLayerOnto,
  type OuterShadow,
  paintShadows,
  type ShadowFrame,
  shadowMatrix,
} from './shadow.ts'

export type Glow = Extract<EffectOf<Color>, { readonly kind: 'glow' }>
export type SoftEdge = Extract<EffectOf<Color>, { readonly kind: 'softEdge' }>
export type Reflection = Extract<EffectOf<Color>, { readonly kind: 'reflection' }>

const EMU_PER_PX = 9525

/** 图层上的效果：外部阴影可有多个，其余各取第一个。 */
export interface LayerEffects {
  readonly shadows: readonly OuterShadow[]
  readonly glow: Glow | null
  readonly softEdge: SoftEdge | null
  readonly reflection: Reflection | null
}

export const NO_EFFECTS: LayerEffects = {
  shadows: [],
  glow: null,
  softEdge: null,
  reflection: null,
}

export function layerEffects(effects: readonly EffectOf<Color>[]): LayerEffects {
  return {
    shadows: effects.filter((e): e is OuterShadow => e.kind === 'outerShadow'),
    glow: effects.find((e): e is Glow => e.kind === 'glow') ?? null,
    softEdge: effects.find((e): e is SoftEdge => e.kind === 'softEdge') ?? null,
    reflection: effects.find((e): e is Reflection => e.kind === 'reflection') ?? null,
  }
}

export function hasLayerEffects(e: LayerEffects): boolean {
  return e.shadows.length > 0 || e.glow !== null || e.softEdge !== null || e.reflection !== null
}

/** 发光的膨胀量（设备像素）；`radius` 为半径的设备像素数。 */
export function glowSpread(radius: number): number {
  return Math.max(1, Math.floor(0.425 * radius))
}

/** 柔化边缘的腐蚀量（设备像素）。 */
export function softEdgeInset(radius: number): number {
  return Math.floor(0.83 * radius)
}

/** 膨胀或腐蚀 `d` 个像素后的高斯模糊 σ。 */
export function morphSigma(d: number): number {
  return 0.325 * d + 0.27
}

/** 高斯模糊在一侧扩展的像素数。 */
function blurReach(sigma: number): number {
  return Math.ceil(3 * sigma) + 1
}

/**
 * 每行按半宽 `half` 取窗口内的最大值（`max` 为真）或最小值，窗口之外按 0 计。单调队列，每行线性时间。
 */
function rowExtreme(
  src: Float32Array,
  w: number,
  h: number,
  half: number,
  max: boolean,
): Float32Array {
  const out = new Float32Array(w * h)
  const queue = new Int32Array(w)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let head = 0
    let tail = 0
    let next = 0
    for (let x = 0; x < w; x++) {
      const right = x + half
      while (next <= right && next < w) {
        const v = src[row + next]!
        while (
          tail > head &&
          (max ? src[row + queue[tail - 1]!]! <= v : src[row + queue[tail - 1]!]! >= v)
        )
          tail--
        queue[tail++] = next
        next++
      }
      while (head < tail && queue[head]! < x - half) head++
      let v = src[row + queue[head]!]!
      // 窗口超出行首或行尾时，超出部分按 0 计。
      if (!max && (x - half < 0 || right >= w)) v = 0
      out[row + x] = v
    }
  }
  return out
}

/**
 * 以半径 `d` 的圆形结构元（`dx² + dy² ≤ (d + 0.5)²`）膨胀（`max` 为真）或腐蚀不透明度，图层之外按 0 计。
 */
export function morph(
  src: Float32Array,
  w: number,
  h: number,
  d: number,
  max: boolean,
): Float32Array {
  if (d <= 0) return src.slice()
  const out = new Float32Array(w * h).fill(max ? 0 : 1)
  const limit = (d + 0.5) * (d + 0.5)
  const halves = new Map<number, number[]>()
  for (let dy = -d; dy <= d; dy++) {
    const half = Math.floor(Math.sqrt(limit - dy * dy))
    const list = halves.get(half) ?? []
    list.push(dy)
    halves.set(half, list)
  }
  for (const [half, offsets] of halves) {
    const rows = rowExtreme(src, w, h, half, max)
    for (const dy of offsets) {
      for (let y = 0; y < h; y++) {
        const sy = y + dy
        const o = y * w
        if (sy < 0 || sy >= h) {
          if (!max) out.fill(0, o, o + w)
          continue
        }
        const s = sy * w
        for (let x = 0; x < w; x++) {
          const v = rows[s + x]!
          if (max ? v > out[o + x]! : v < out[o + x]!) out[o + x] = v
        }
      }
    }
  }
  return out
}

/** 可分离的高斯模糊（原地），图层之外按 0 计。 */
export function gaussianBlur(values: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma <= 0) return
  const reach = Math.ceil(3 * sigma)
  const kernel = new Float32Array(2 * reach + 1)
  let sum = 0
  for (let i = -reach; i <= reach; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + reach] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum
  const tmp = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = 0
      const from = Math.max(0, x - reach)
      const to = Math.min(w - 1, x + reach)
      for (let k = from; k <= to; k++) acc += values[row + k]! * kernel[k - x + reach]!
      tmp[row + x] = acc
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let acc = 0
      const from = Math.max(0, y - reach)
      const to = Math.min(h - 1, y + reach)
      for (let k = from; k <= to; k++) acc += tmp[k * w + x]! * kernel[k - y + reach]!
      values[y * w + x] = acc
    }
  }
}

/** 发光的不透明度（0–1，不含发光颜色的不透明度）。 */
export function glowAlpha(alpha: Float32Array, w: number, h: number, spread: number): Float32Array {
  const out = morph(alpha, w, h, spread, true)
  gaussianBlur(out, w, h, morphSigma(spread))
  return out
}

/** 柔化边缘的遮罩（0–1），乘到内容的不透明度上。 */
export function softEdgeMask(
  alpha: Float32Array,
  w: number,
  h: number,
  inset: number,
): Float32Array {
  const out = morph(alpha, w, h, inset, false)
  gaussianBlur(out, w, h, morphSigma(inset))
  return out
}

function alphaOf(c: PixelContext, w: number, h: number): Float32Array {
  const data = c.getImageData(0, 0, w, h).data
  const out = new Float32Array(w * h)
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3]! / 255
  return out
}

function pixelLayer(
  res: PaintResources,
  w: number,
  h: number,
): { canvas: PaintCanvas; ctx: PixelContext } | null {
  const canvas = res.createCanvas(w, h)
  const ctx = pixelContext(canvas.getContext('2d', { willReadFrequently: true }))
  return ctx === null ? null : { canvas, ctx }
}

/** 柔化边缘：按 `inset` 腐蚀后模糊的遮罩乘到图层的不透明度上。 */
function soften(c: PixelContext, w: number, h: number, inset: number): void {
  const pixels = c.getImageData(0, 0, w, h)
  const alpha = new Float32Array(w * h)
  for (let i = 0; i < alpha.length; i++) alpha[i] = pixels.data[i * 4 + 3]! / 255
  const mask = softEdgeMask(alpha, w, h, inset)
  for (let i = 0; i < alpha.length; i++) pixels.data[i * 4 + 3] = pixels.data[i * 4 + 3]! * mask[i]!
  c.putImageData(pixels, 0, 0)
}

/** 发光图层：与 `layer` 同位置同尺寸，按 `spread` 膨胀后模糊并着色。 */
function glowLayer(
  layer: PixelContext,
  w: number,
  h: number,
  color: Color,
  spread: number,
  res: PaintResources,
): PaintCanvas | null {
  const out = pixelLayer(res, w, h)
  if (out === null) return null
  const a = glowAlpha(alphaOf(layer, w, h), w, h, spread)
  const pixels = out.ctx.getImageData(0, 0, w, h)
  const r = Math.round(color.r * 255)
  const g = Math.round(color.g * 255)
  const b = Math.round(color.b * 255)
  for (let i = 0; i < a.length; i++) {
    pixels.data[i * 4] = r
    pixels.data[i * 4 + 1] = g
    pixels.data[i * 4 + 2] = b
    pixels.data[i * 4 + 3] = Math.min(1, a[i]!) * color.a * 255
  }
  out.ctx.putImageData(pixels, 0, 0)
  return out.canvas
}

/** 把发光画在 `ctx` 上（图层位于 `bounds`）。`spread` 为膨胀量；图层不能逐像素读写时不绘制。 */
export function paintGlow(
  ctx: PaintContext,
  layer: PaintCanvas,
  bounds: DeviceRect,
  color: Color,
  spread: number,
  res: PaintResources,
): void {
  const c = pixelContext(layer.getContext('2d', { willReadFrequently: true }))
  if (c === null) return
  const glow = glowLayer(c, bounds.w, bounds.h, color, spread, res)
  if (glow !== null) drawLayerOnto(ctx, glow, bounds)
}

/** 发光扩展到内容之外的像素数。 */
export function glowReach(spread: number): number {
  return spread + blurReach(morphSigma(spread))
}

/** 渐变方向：`fadeDir` 在映像中的方向换回内容的局部坐标（翻转的轴取反）。 */
function fadeVector(r: Reflection): { x: number; y: number } {
  const a = (r.fadeDirection * Math.PI) / 180
  return { x: Math.cos(a) * Math.sign(r.scaleX || 1), y: Math.sin(a) * Math.sign(r.scaleY || 1) }
}

/**
 * 映像：`layer` 位于设备坐标 `bounds`，`frame` 为内容的局部框（对齐点、渐变范围与距离的依据）。
 * 渐变在局部坐标中施加（随映像一起变换），模糊在变换之前施加。
 */
export function paintReflection(
  ctx: PaintContext,
  layer: PaintCanvas,
  bounds: DeviceRect,
  reflection: Reflection,
  frame: ShadowFrame,
  res: PaintResources,
): void {
  const sigma = ((reflection.blur / EMU_PER_PX) * frame.scale) / 3
  const pad = sigma > 0 ? blurReach(sigma) : 0
  const w = bounds.w + 2 * pad
  const h = bounds.h + 2 * pad
  const copy = res.createCanvas(w, h)
  const c = copy.getContext('2d', { willReadFrequently: sigma > 0 })
  if (c === null) return
  c.drawImage(layer, pad, pad)
  // 渐变的起止点：局部框四角在方向向量上的投影的最小值与最大值。
  const u = fadeVector(reflection)
  const corners = [
    { x: 0, y: 0 },
    { x: frame.width, y: 0 },
    { x: 0, y: frame.height },
    { x: frame.width, y: frame.height },
  ]
  const proj = corners.map((p) => p.x * u.x + p.y * u.y)
  const lo = Math.min(...proj)
  const hi = Math.max(...proj)
  const start = corners[proj.indexOf(lo)]!
  const span = hi - lo
  c.save()
  setMatrix(c, multiply(translation(pad - bounds.x, pad - bounds.y), frame.matrix))
  const g = c.createLinearGradient(start.x, start.y, start.x + u.x * span, start.y + u.y * span)
  const stop = (pos: number, alpha: number) =>
    g.addColorStop(Math.min(1, Math.max(0, pos)), `rgba(0,0,0,${Math.min(1, Math.max(0, alpha))})`)
  stop(reflection.startPosition, reflection.startAlpha)
  stop(Math.max(reflection.startPosition, reflection.endPosition), reflection.endAlpha)
  c.globalCompositeOperation = 'destination-in'
  c.fillStyle = g
  const big = (frame.width + frame.height) * 4 + w + h
  c.fillRect(-big, -big, frame.width + 2 * big, frame.height + 2 * big)
  c.restore()
  if (sigma > 0) {
    const px = pixelContext(c)
    if (px !== null) blurPixels(px, w, h, sigma)
  }
  const m = shadowMatrix(reflection, frame.matrix, frame.width, frame.height, frame.scale)
  ctx.save()
  setMatrix(ctx, m)
  ctx.drawImage(copy, bounds.x - pad, bounds.y - pad)
  ctx.restore()
}

/** 按预乘颜色模糊 RGBA 像素。 */
function blurPixels(c: PixelContext, w: number, h: number, sigma: number): void {
  const pixels = c.getImageData(0, 0, w, h)
  const d = pixels.data
  const n = w * h
  const channels = [0, 1, 2, 3].map(() => new Float32Array(n))
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3]! / 255
    channels[0]![i] = d[i * 4]! * a
    channels[1]![i] = d[i * 4 + 1]! * a
    channels[2]![i] = d[i * 4 + 2]! * a
    channels[3]![i] = a
  }
  for (const ch of channels) gaussianBlur(ch, w, h, sigma)
  for (let i = 0; i < n; i++) {
    const a = channels[3]![i]!
    d[i * 4 + 3] = a * 255
    if (a <= 0) continue
    d[i * 4] = channels[0]![i]! / a
    d[i * 4 + 1] = channels[1]![i]! / a
    d[i * 4 + 2] = channels[2]![i]! / a
  }
  c.putImageData(pixels, 0, 0)
}

/**
 * 带图层效果绘制：`draw` 把内容画到图层（`offset` 须左乘到其使用的设备变换上），随后按映像、外部阴影、发光、内容的
 * 顺序画到 `ctx`。`bounds` 为内容在设备坐标中的外接矩形；有发光时图层向四周扩展发光的范围。
 */
export function paintWithEffects(
  ctx: PaintContext,
  effects: LayerEffects,
  frame: ShadowFrame,
  bounds: DeviceRect,
  res: PaintResources,
  canvas: { width: number; height: number },
  draw: (ctx: PaintContext, offset: Matrix) => void,
): void {
  const glow = effects.glow
  const spread = glow === null ? 0 : glowSpread((glow.radius / EMU_PER_PX) * frame.scale)
  const inset =
    effects.softEdge === null
      ? 0
      : softEdgeInset((effects.softEdge.radius / EMU_PER_PX) * frame.scale)
  // 图层四周外扩发光与柔化边缘的作用范围，可以超出画布：`bounds` 已裁到画布之内，画布之外紧邻的内容同样参与运算，
  // 不扩展时柔化边缘会把画布边缘当作内容的边缘。
  const reach = Math.max(
    glow === null ? 0 : glowReach(spread),
    inset > 0 ? inset + blurReach(morphSigma(inset)) : 0,
  )
  const at: DeviceRect = {
    x: bounds.x - reach,
    y: bounds.y - reach,
    w: bounds.w + 2 * reach,
    h: bounds.h + 2 * reach,
  }
  const pixels = glow !== null || inset > 0
  const layer = res.createCanvas(at.w, at.h)
  const c = layer.getContext('2d', { willReadFrequently: pixels })
  if (c === null) return
  draw(c, translation(-at.x, -at.y))
  const px = pixels ? pixelContext(c) : null
  if (inset > 0 && px !== null) soften(px, at.w, at.h, inset)
  if (effects.reflection !== null) paintReflection(ctx, layer, at, effects.reflection, frame, res)
  paintShadows(ctx, layer, at, effects.shadows, frame, canvas)
  if (glow !== null && px !== null) {
    const g = glowLayer(px, at.w, at.h, glow.color, spread, res)
    if (g !== null) drawLayerOnto(ctx, g, at)
  }
  ctx.save()
  setMatrix(ctx, IDENTITY)
  ctx.drawImage(layer, at.x, at.y)
  ctx.restore()
}
