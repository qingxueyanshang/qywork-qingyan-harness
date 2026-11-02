/**
 * 公式绘制：按 WPS 屏幕显示（GDI）的方式把排版结果画到 Canvas 2D 上下文。坐标按 `scale`（像素/磅）换算，96 dpi、100% 时为 4/3。
 *
 * - 文字项：字号取整数像素（ppem = round(字号 × scale)），原点四舍五入到整像素；有字符的按 `fillText` 绘制，
 *   没有码位的变体字形按轮廓填充（同样按 ppem 缩放，原点取整）。
 * - 轮廓项（括号、根号）与矩形项（上下横线、根号横线）：WPS 以路径填充绘制，坐标不取整、不做平滑。本文件按像素左上角
 *   是否落在路径内（非零环绕）逐行填充，与 GDI 的填充结果一致。
 * - 分数线：GDI 方头画笔；线宽取整数像素，端点与中线取整，两端各延伸半个线宽（向下取整），横向多覆盖 1 像素。
 * - 斜线（线性分数）：端点取整到像素，线宽取整数像素。1 像素时按 Bresenham 画线、两端点都着色；更宽时按方头线段的多边形
 *   不平滑填充。WPS 页面图实测（10.5 至 48 磅）：1 像素与 3 像素以上的线与此一致；2 像素的线 WPS 画得更细，约 14% 的像素不同。
 */

import type { GlyphOutlines, OutlineCommand } from '../font/index.ts'
import type { MathGlyph, MathLayout } from './layout.ts'

/** 绘制所需的 Canvas 2D 接口子集。 */
export interface MathCanvas {
  fillStyle: unknown
  font: string
  fillRect(x: number, y: number, w: number, h: number): void
  fillText(text: string, x: number, y: number): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void
  closePath(): void
  fill(): void
}

export interface MathPaintFonts<F> {
  /** CSS 族名，与调用方注册的 `FontFace` 族名相同。 */
  family(font: F): string
  /** 按字形编号绘制所需的轮廓；没有时该字形不绘制。 */
  outlines(font: F): GlyphOutlines | null
  /**
   * 文字项的绘制钩子：返回 `true` 表示已由调用方绘制（如内嵌点阵字形），本文件不再绘制。
   * `x`、`baseline` 为整数像素，`ppem` 为整数像素字号。
   */
  glyph?(item: MathGlyph<F>, x: number, baseline: number, ppem: number): boolean
}

/** 96 dpi、100% 显示时每磅的像素数。 */
export const MATH_SCREEN_SCALE = 4 / 3

function quote(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`
}

/** 在 (`x`, `baseline`) 磅处绘制公式；调用方负责 `textBaseline = 'alphabetic'` 与 `textAlign = 'left'`。 */
export function paintMath<F>(
  ctx: MathCanvas,
  layout: MathLayout<F>,
  x: number,
  baseline: number,
  fonts: MathPaintFonts<F>,
  scale: number = MATH_SCREEN_SCALE,
): void {
  for (const it of layout.items) {
    switch (it.kind) {
      case 'glyph': {
        const ppem = Math.round(it.size * scale)
        const gx = Math.round((x + it.x) * scale)
        const gy = Math.round((baseline + it.y) * scale)
        ctx.fillStyle = it.color
        if (fonts.glyph?.(it, gx, gy, ppem)) break
        if (it.text !== null) {
          const style = `${it.italic ? 'italic ' : ''}${it.bold ? 'bold ' : ''}`
          ctx.font = `${style}${ppem}px ${quote(fonts.family(it.font))}`
          ctx.fillText(it.text, gx, gy)
        } else {
          const o = fonts.outlines(it.font)
          if (o === null) break
          const k = ppem / o.unitsPerEm
          ctx.beginPath()
          trace(ctx, o.outline(it.glyph), (px, py) => [gx + px * k, gy - py * k])
          ctx.fill()
        }
        break
      }
      case 'outline': {
        const o = fonts.outlines(it.font)
        if (o === null) break
        const k = (it.size * scale) / o.unitsPerEm
        const ox = (x + it.x) * scale
        const oy = (baseline + it.y) * scale
        ctx.fillStyle = it.color
        fillAliased(
          ctx,
          flatten(o.outline(it.glyph), (px, py) => [ox + px * k, oy - py * k]),
        )
        break
      }
      case 'rect': {
        const x0 = (x + it.x) * scale
        const y0 = (baseline + it.y) * scale
        const x1 = x0 + it.width * scale
        const y1 = y0 + it.height * scale
        ctx.fillStyle = it.color
        fillAliased(ctx, [
          [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
        ])
        break
      }
      case 'rule': {
        const t = Math.max(1, Math.round(it.thickness * scale))
        const half = Math.floor(t / 2)
        const x0 = Math.round((x + it.x0) * scale)
        const x1 = Math.round((x + it.x1) * scale)
        const yc = Math.round((baseline + it.y) * scale)
        ctx.fillStyle = it.color
        ctx.fillRect(x0 - half, yc - half, x1 - x0 + 2 * half + 1, t)
        break
      }
      case 'slash': {
        const t = Math.max(1, Math.round(it.thickness * scale))
        const x0 = Math.round((x + it.x0) * scale)
        const y0 = Math.round((baseline + it.y0) * scale)
        const x1 = Math.round((x + it.x1) * scale)
        const y1 = Math.round((baseline + it.y1) * scale)
        ctx.fillStyle = it.color
        if (t === 1) strokeThin(ctx, x0, y0, x1, y1)
        else fillAliased(ctx, [squareCapped(x0, y0, x1, y1, t)])
        break
      }
    }
  }
}

/** Bresenham 画线，两端点都着色；同一行相邻的像素合并为一个矩形。 */
function strokeThin(
  ctx: Pick<MathCanvas, 'fillRect'>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const dx = Math.abs(x1 - x0)
  const dy = -Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0
  let y = y0
  let runX = x
  let runY = y
  let runW = 0
  const flush = () => {
    if (runW > 0) ctx.fillRect(sx > 0 ? runX : runX - runW + 1, runY, runW, 1)
  }
  for (;;) {
    if (runW > 0 && y === runY) runW++
    else {
      flush()
      runX = x
      runY = y
      runW = 1
    }
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
  }
  flush()
}

/** 方头线段的多边形：线段两端各沿方向延伸半个线宽。 */
function squareCapped(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
): [number, number][] {
  const len = Math.hypot(x1 - x0, y1 - y0)
  if (len === 0) return []
  const ux = ((x1 - x0) / len) * (width / 2)
  const uy = ((y1 - y0) / len) * (width / 2)
  return [
    [x0 - ux - uy, y0 - uy + ux],
    [x1 + ux - uy, y1 + uy + ux],
    [x1 + ux + uy, y1 + uy - ux],
    [x0 - ux + uy, y0 - uy - ux],
  ]
}

type Map2 = (x: number, y: number) => [number, number]

function trace(ctx: MathCanvas, commands: readonly OutlineCommand[], map: Map2): void {
  for (const c of commands) {
    if (c.op === 'Z') ctx.closePath()
    else if (c.op === 'Q') {
      const [cx, cy] = map(c.cx, c.cy)
      const [x, y] = map(c.x, c.y)
      ctx.quadraticCurveTo(cx, cy, x, y)
    } else {
      const [x, y] = map(c.x, c.y)
      if (c.op === 'M') ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
  }
}

/** 每段二次曲线展开的直线段数：字号 100 像素以内的括号与根号，偏差小于 0.05 像素。 */
const CURVE_STEPS = 12

/** 轮廓展开为多边形（设备像素坐标）。 */
function flatten(commands: readonly OutlineCommand[], map: Map2): [number, number][][] {
  const out: [number, number][][] = []
  let cur: [number, number][] = []
  let last: [number, number] = [0, 0]
  for (const c of commands) {
    if (c.op === 'M') {
      if (cur.length > 2) out.push(cur)
      last = map(c.x, c.y)
      cur = [last]
    } else if (c.op === 'L') {
      last = map(c.x, c.y)
      cur.push(last)
    } else if (c.op === 'Q') {
      const [cx, cy] = map(c.cx, c.cy)
      const [x, y] = map(c.x, c.y)
      const [x0, y0] = last
      for (let i = 1; i <= CURVE_STEPS; i++) {
        const t = i / CURVE_STEPS
        const u = 1 - t
        cur.push([u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y])
      }
      last = [x, y]
    }
  }
  if (cur.length > 2) out.push(cur)
  return out
}

/**
 * 不做平滑的多边形填充（非零环绕）：左上角（整数坐标点）落在多边形内的像素着色，逐行合并为横向线段。
 * 与 GDI 路径填充的结果一致（WPS 的括号与根号经 `FillPath` 绘制，回放到位图时不做平滑）；不要改为按像素中心取样，
 * 那样整体向左上偏半个像素，1 像素宽的横线与斜笔画会落到相邻的行列。
 */
export function fillAliased(
  ctx: Pick<MathCanvas, 'fillRect'>,
  polygons: readonly (readonly (readonly [number, number])[])[],
): void {
  let top = Infinity
  let bottom = -Infinity
  for (const p of polygons)
    for (const [, y] of p) {
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
    }
  if (!(bottom > top)) return
  const crossings: { x: number; dir: number }[] = []
  for (let row = Math.ceil(top); row < bottom; row++) {
    const yc = row
    crossings.length = 0
    for (const p of polygons) {
      for (let i = 0; i < p.length; i++) {
        const [x0, y0] = p[i]!
        const [x1, y1] = p[(i + 1) % p.length]!
        if (y0 === y1) continue
        const up = y1 > y0
        const lo = up ? y0 : y1
        const hi = up ? y1 : y0
        if (yc < lo || yc >= hi) continue
        crossings.push({ x: x0 + ((yc - y0) * (x1 - x0)) / (y1 - y0), dir: up ? 1 : -1 })
      }
    }
    crossings.sort((a, b) => a.x - b.x)
    let winding = 0
    for (let i = 0; i < crossings.length; i++) {
      const c = crossings[i]!
      const before = winding
      winding += c.dir
      if (before === 0 && winding !== 0) {
        let j = i + 1
        let w = winding
        while (j < crossings.length) {
          w += crossings[j]!.dir
          if (w === 0) break
          j++
        }
        const end = crossings[j]?.x ?? c.x
        const x0 = Math.ceil(c.x)
        const x1 = Math.ceil(end)
        if (x1 > x0) ctx.fillRect(x0, row, x1 - x0, 1)
        i = j
        winding = 0
      }
    }
  }
}
