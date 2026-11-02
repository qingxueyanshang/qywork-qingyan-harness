/**
 * 填充绘制：纯色、线性与路径渐变、图片（拉伸与平铺）、图案，绘制在形状局部坐标中。
 *
 * - 调用前上下文的变换已设为形状局部坐标到设备坐标（`FillArea.matrix`），本模块按需临时修改并恢复。
 * - 填充区域为形状框 `[0, width] × [0, height]`；渐变的起止与图片的拉伸区域都相对形状框计算。
 * - 线性渐变：角度为颜色变化方向，顺时针；`scaled` 时角度在单位正方形中定义再随形状框拉伸。
 *   渐变长度为形状框在该方向上的投影长度。
 * - 色标间的颜色按 `addStops` 插值：只有位于 0 与 1 的两个色标时颜色通道不按线性变化。
 * - 路径渐变：色标位置 0 位于 `fillToRect` 所指的焦点区域，1 位于形状框边缘。`circle` 在单位正方形中
 *   以焦点中心到最远角的距离为半径，再随形状框拉伸；`rect` 与 `shape` 均按矩形绘制（`shape` 不沿形状轮廓）。
 * - `rotWithShape` 为假时，渐变方向与平铺图片按幻灯片坐标轴绘制，不随形状旋转。
 * - 图片的解码与按裁剪比例绘制见 `picture.ts`（位图与图元文件）。
 * - 平铺的单元尺寸为图片像素数按图片文件记录的分辨率换算为 96 dpi 像素后四舍五入（图元文件为图片框按 96 dpi 的尺寸，
 *   先栅格化），再乘以 `sx`、`sy`。实测（WPS 演示导出图）：120 × 90 的图片在 150 dpi 时单元为 77 × 58 像素，150 × 75 dpi 时为
 *   77 × 115 像素。
 */

import type { MetafileFonts } from '../../metafile/index.ts'
import { type Color, colorToCss } from '../color.ts'
import type { Fill, GradientStop, ImageFill, RelativeRect } from '../fill.ts'
import type { Segment } from '../geometry/path.ts'
import {
  type CreateCanvas,
  invert,
  type Matrix,
  multiply,
  type PaintContext,
  type PaintGradient,
  type PaintImage,
  scaling,
  translation,
} from './context.ts'
import { patternBits } from './pattern.ts'
import {
  drawCropped,
  drawPicture,
  type PaintPicture,
  pictureRaster,
  pictureSize,
} from './picture.ts'

export interface FillArea {
  readonly width: number
  readonly height: number
  /** 形状局部坐标到设备坐标。 */
  readonly matrix: Matrix
}

export interface PaintResources {
  /** 图片部件；未加载或无法解码时为 `null`。 */
  image(part: string): PaintPicture | null
  readonly createCanvas: CreateCanvas
  /** 图元文件中文字的字体；没有时含文字的图元文件不绘制。 */
  readonly metafileFonts?: MetafileFonts
}

/** 局部坐标中每单位对应的设备像素数（取两个方向的平均值）。 */
export function deviceScale(m: Matrix): number {
  return (Math.hypot(m.a, m.b) + Math.hypot(m.c, m.d)) / 2
}

/** 在当前路径上追加路径段，不开始新路径。 */
export function appendPath(ctx: PaintContext, segments: readonly Segment[]): void {
  for (const s of segments) {
    switch (s.kind) {
      case 'move':
        ctx.moveTo(s.x, s.y)
        break
      case 'line':
        ctx.lineTo(s.x, s.y)
        break
      case 'arc':
        ctx.ellipse(s.cx, s.cy, s.rx, s.ry, 0, s.start, s.end, s.anticlockwise)
        break
      case 'quad':
        ctx.quadraticCurveTo(s.x1, s.y1, s.x, s.y)
        break
      case 'cubic':
        ctx.bezierCurveTo(s.x1, s.y1, s.x2, s.y2, s.x, s.y)
        break
      case 'close':
        ctx.closePath()
        break
    }
  }
}

export function tracePath(ctx: PaintContext, segments: readonly Segment[]): void {
  ctx.beginPath()
  appendPath(ctx, segments)
}

/** 形状框向外扩展 `margin` 的矩形。 */
export function traceRect(ctx: PaintContext, width: number, height: number, margin = 0): void {
  ctx.beginPath()
  ctx.rect(-margin, -margin, width + 2 * margin, height + 2 * margin)
}

/**
 * 只有位于 0 与 1 的两个色标时，颜色通道在四分点处的取值占两端之差的比例（通道增大时；减小时取其镜像，
 * 即偏向较大的一端），四分点之间线性；透明度线性。实测（WPS 演示导出图，线性 0° 与 90°、circle 与 rect
 * 路径渐变，黑白、灰白、红蓝与 5 组彩色）：黑 → 白在 1/4、1/2、3/4 处为 107、185、235，白 → 黑为 235、185、108，
 * 灰 128 → 白为 181、220、245。三个以上的色标、色标不在两端（20% 与 80%）时为线性插值。
 */
const RISE = [0, 0.42, 0.7245, 0.92, 1] as const

function riseChannel(from: number, to: number, k: number): number {
  return from <= to ? from + (to - from) * RISE[k]! : to + (from - to) * RISE[4 - k]!
}

function addStops(g: PaintGradient, stops: readonly GradientStop<Color>[]): void {
  const [a, b] = stops
  if (stops.length === 2 && a!.position === 0 && b!.position === 1) {
    const x = a!.color
    const y = b!.color
    for (let k = 0; k <= 4; k++) {
      const c: Color = {
        r: riseChannel(x.r, y.r, k),
        g: riseChannel(x.g, y.g, k),
        b: riseChannel(x.b, y.b, k),
        a: x.a + ((y.a - x.a) * k) / 4,
      }
      g.addColorStop(k / 4, colorToCss(c))
    }
    return
  }
  for (const s of stops) g.addColorStop(Math.min(1, Math.max(0, s.position)), colorToCss(s.color))
}

/** 局部坐标中的方向：`rotWithShape` 为假时，把设备坐标中的方向换算回局部坐标。 */
function localDirection(
  angle: number,
  area: FillArea,
  rotateWithShape: boolean,
): { x: number; y: number } {
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  if (rotateWithShape) return { x: dx, y: dy }
  const m = area.matrix
  const s = deviceScale(m)
  const inv = invert({ a: m.a / s, b: m.b / s, c: m.c / s, d: m.d / s, e: 0, f: 0 })
  return { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy }
}

/** 线性渐变的起点与终点（局部坐标）。 */
export function linearGradientLine(
  angleDegrees: number,
  scaled: boolean,
  width: number,
  height: number,
  direction?: (angle: number) => { x: number; y: number },
): { x0: number; y0: number; x1: number; y1: number } {
  const theta = (angleDegrees * Math.PI) / 180
  let d = direction ? direction(theta) : { x: Math.cos(theta), y: Math.sin(theta) }
  if (scaled) d = { x: height * d.x, y: width * d.y }
  const len = Math.hypot(d.x, d.y)
  const ux = len === 0 ? 1 : d.x / len
  const uy = len === 0 ? 0 : d.y / len
  const half = (Math.abs(ux) * width + Math.abs(uy) * height) / 2
  const cx = width / 2
  const cy = height / 2
  return { x0: cx - ux * half, y0: cy - uy * half, x1: cx + ux * half, y1: cy + uy * half }
}

/** 路径渐变焦点区域（局部坐标）。 */
export function focusRect(
  focus: RelativeRect,
  width: number,
  height: number,
): { left: number; top: number; right: number; bottom: number } {
  const left = focus.left * width
  const right = width - focus.right * width
  const top = focus.top * height
  const bottom = height - focus.bottom * height
  return {
    left: Math.min(left, right),
    right: Math.max(left, right),
    top: Math.min(top, bottom),
    bottom: Math.max(top, bottom),
  }
}

/** 填充已描绘的当前路径（调用方先 `tracePath`）。 */
export function paintFill(
  ctx: PaintContext,
  trace: () => void,
  fill: Fill,
  area: FillArea,
  res: PaintResources,
): void {
  const { width, height } = area
  switch (fill.kind) {
    case 'none':
    case 'group':
      return
    case 'solid':
      trace()
      ctx.fillStyle = colorToCss(fill.color)
      ctx.fill()
      return
    case 'gradient': {
      if (fill.stops.length === 1) {
        trace()
        ctx.fillStyle = colorToCss(fill.stops[0]!.color)
        ctx.fill()
        return
      }
      const shade = fill.shade
      if (shade.kind === 'linear') {
        const line = linearGradientLine(shade.angle, shade.scaled, width, height, (a) =>
          localDirection(a, area, fill.rotateWithShape),
        )
        const g = ctx.createLinearGradient(line.x0, line.y0, line.x1, line.y1)
        addStops(g, fill.stops)
        trace()
        ctx.fillStyle = g
        ctx.fill()
        return
      }
      ctx.save()
      trace()
      ctx.clip()
      if (shade.path === 'circle') paintCircleGradient(ctx, fill.stops, shade.focus, width, height)
      else paintRectGradient(ctx, fill.stops, shade.focus, width, height)
      ctx.restore()
      return
    }
    case 'picture':
      ctx.save()
      trace()
      ctx.clip()
      paintImageFill(ctx, fill.image, area, res)
      ctx.restore()
      return
    case 'pattern': {
      const tile = patternTile(fill.foreground, fill.background, fill.preset, res.createCanvas)
      const pattern = tile === null ? null : ctx.createPattern(tile, 'repeat')
      trace()
      if (pattern === null) {
        ctx.fillStyle = colorToCss(fill.background)
        ctx.fill()
        return
      }
      ctx.save()
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = pattern
      ctx.fill()
      ctx.restore()
      return
    }
  }
}

function paintCircleGradient(
  ctx: PaintContext,
  stops: readonly GradientStop<Color>[],
  focus: RelativeRect,
  width: number,
  height: number,
): void {
  if (width <= 0 || height <= 0) return
  const f = focusRect(focus, 1, 1)
  const cx = (f.left + f.right) / 2
  const cy = (f.top + f.bottom) / 2
  const r = Math.max(
    Math.hypot(cx, cy),
    Math.hypot(1 - cx, cy),
    Math.hypot(cx, 1 - cy),
    Math.hypot(1 - cx, 1 - cy),
  )
  ctx.transform(width, 0, 0, height, 0, 0)
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  addStops(g, stops)
  ctx.fillStyle = g
  ctx.fillRect(-1, -1, 3, 3)
}

/**
 * 矩形路径渐变：颜色只随到最近一条形状框边的相对距离变化，焦点区域内为位置 0 的颜色。
 *
 * 绘制顺序：焦点区域（外扩 1 个单位）、上下两条整宽的竖直渐变带、左右两个梯形的水平渐变。
 * 梯形的斜边与焦点区域的边都画在已有颜色之上，抗锯齿的边缘不露出底色。
 */
function paintRectGradient(
  ctx: PaintContext,
  stops: readonly GradientStop<Color>[],
  focus: RelativeRect,
  width: number,
  height: number,
): void {
  const f = focusRect(focus, width, height)
  ctx.fillStyle = colorToCss(stops.at(-1)!.color)
  ctx.fillRect(-width, -height, 3 * width, 3 * height)
  ctx.fillStyle = colorToCss(stops[0]!.color)
  ctx.fillRect(f.left - 1, f.top - 1, f.right - f.left + 2, f.bottom - f.top + 2)
  const band = (from: number, to: number, y: number, h: number) => {
    if (from === to) return
    const g = ctx.createLinearGradient(0, from, 0, to)
    addStops(g, stops)
    ctx.fillStyle = g
    ctx.fillRect(0, y, width, h)
  }
  band(f.top, 0, 0, f.top)
  band(f.bottom, height, f.bottom, height - f.bottom)
  const side = (from: number, to: number, pts: [number, number][]) => {
    if (from === to) return
    const g = ctx.createLinearGradient(from, 0, to, 0)
    addStops(g, stops)
    ctx.beginPath()
    for (const [i, [x, y]] of pts.entries()) {
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fillStyle = g
    ctx.fill()
  }
  side(f.left, 0, [
    [0, 0],
    [f.left, f.top],
    [f.left, f.bottom],
    [0, height],
  ])
  side(f.right, width, [
    [width, 0],
    [f.right, f.top],
    [f.right, f.bottom],
    [width, height],
  ])
}

/** 图片填充：拉伸到 `fillRect` 所指区域，或按 `tile` 平铺。调用方已裁剪到形状路径。 */
export function paintImageFill(
  ctx: PaintContext,
  image: ImageFill,
  area: FillArea,
  res: PaintResources,
): void {
  const picture = image.part === null ? null : res.image(image.part)
  if (picture === null) return
  const fonts = res.metafileFonts ?? null
  const { width, height } = area
  ctx.globalAlpha *= image.alpha
  if (image.tile === null) {
    const r = image.stretch ?? { left: 0, top: 0, right: 0, bottom: 0 }
    const x = r.left * width
    const y = r.top * height
    const rect = {
      x,
      y,
      width: width - r.right * width - x,
      height: height - r.bottom * height - y,
    }
    drawPicture(ctx, picture, image.crop, rect, area.matrix, 'high', fonts)
    return
  }
  const tile = image.tile
  const bitmap = pictureRaster(picture, res.createCanvas, fonts)
  if (bitmap === null) return
  const source = tileSource(bitmap, image.crop, tile.flip, res.createCanvas)
  if (source === null) return
  const pattern = ctx.createPattern(source.canvas, 'repeat')
  if (pattern === null) return
  const { width: pw, height: ph, resolution } = pictureSize(picture)
  const kx = Math.max(1, Math.round((pw * 96) / resolution.x)) / bitmap.width
  const ky = Math.max(1, Math.round((ph * 96) / resolution.y)) / bitmap.height
  const sx = tile.scaleX * kx
  const sy = tile.scaleY * ky
  const tw = (source.width * sx) / (tile.flip === 'x' || tile.flip === 'xy' ? 2 : 1)
  const th = (source.height * sy) / (tile.flip === 'y' || tile.flip === 'xy' ? 2 : 1)
  const { x: ax, y: ay } = alignTile(tile.align, width - tw, height - th)
  const ox = ax + tile.offsetX / EMU_PER_PX
  const oy = ay + tile.offsetY / EMU_PER_PX
  let m = multiply(translation(ox, oy), scaling(sx, sy))
  if (!image.rotateWithShape) {
    const s = deviceScale(area.matrix)
    const am = area.matrix
    const undo = invert({ a: am.a / s, b: am.b / s, c: am.c / s, d: am.d / s, e: 0, f: 0 })
    m = multiply(undo, m)
  }
  pattern.setTransform({ a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f })
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, width, height)
}

const EMU_PER_PX = 9525

/** 平铺起点：`free` 为形状框与单元尺寸之差；对齐方式为 `tl`、`t`、`tr`、`l`、`ctr`、`r`、`bl`、`b`、`br`。 */
function alignTile(align: string, freeX: number, freeY: number): { x: number; y: number } {
  const [v, h] =
    align === 'ctr'
      ? ['', '']
      : align.length === 2
        ? [align[0], align[1]]
        : align === 'l' || align === 'r'
          ? ['', align]
          : [align, '']
  return {
    x: h === 'l' ? 0 : h === 'r' ? freeX : freeX / 2,
    y: v === 't' ? 0 : v === 'b' ? freeY : freeY / 2,
  }
}

/** 平铺的单元：裁剪后的图片，`flip` 时为 2 × 1、1 × 2 或 2 × 2 的镜像拼接。 */
function tileSource(
  bitmap: PaintImage,
  crop: RelativeRect,
  flip: string,
  createCanvas: CreateCanvas,
): { canvas: PaintImage; width: number; height: number } | null {
  const plain =
    flip === 'none' && crop.left === 0 && crop.top === 0 && crop.right === 0 && crop.bottom === 0
  if (plain) return { canvas: bitmap, width: bitmap.width, height: bitmap.height }
  const w = Math.max(1, Math.round(bitmap.width * (1 - crop.left - crop.right)))
  const h = Math.max(1, Math.round(bitmap.height * (1 - crop.top - crop.bottom)))
  const fx = flip === 'x' || flip === 'xy' ? 2 : 1
  const fy = flip === 'y' || flip === 'xy' ? 2 : 1
  const canvas = createCanvas(w * fx, h * fy)
  const c = canvas.getContext('2d')
  if (c === null) return null
  for (let i = 0; i < fx; i++) {
    for (let j = 0; j < fy; j++) {
      c.setTransform(
        i === 1 ? -1 : 1,
        0,
        0,
        j === 1 ? -1 : 1,
        i === 1 ? 2 * w : 0,
        j === 1 ? 2 * h : 0,
      )
      drawCropped(c, bitmap, 'high', crop, 0, 0, w, h)
    }
  }
  return { canvas, width: w * fx, height: h * fy }
}

function patternTile(
  foreground: Color,
  background: Color,
  preset: string,
  createCanvas: CreateCanvas,
): PaintImage | null {
  const canvas = createCanvas(8, 8)
  const c = canvas.getContext('2d')
  if (c === null) return null
  const bits = patternBits(preset)
  c.fillStyle = colorToCss(background)
  c.fillRect(0, 0, 8, 8)
  c.fillStyle = colorToCss(foreground)
  for (let y = 0; y < 8; y++) {
    const row = bits[y] ?? 0
    for (let x = 0; x < 8; x++) if (row & (0x80 >> x)) c.fillRect(x, y, 1, 1)
  }
  return canvas
}

/** 路径填充的明暗修饰（`lighten`、`darken` 等）：在填充之上叠加半透明的白色或黑色。 */
export function paintFillModifier(ctx: PaintContext, trace: () => void, mode: string): void {
  const overlay: Readonly<Record<string, string>> = {
    lighten: 'rgba(255,255,255,0.4)',
    lightenLess: 'rgba(255,255,255,0.2)',
    darken: 'rgba(0,0,0,0.4)',
    darkenLess: 'rgba(0,0,0,0.2)',
  }
  const style = overlay[mode]
  if (style === undefined) return
  trace()
  ctx.fillStyle = style
  ctx.fill()
}
