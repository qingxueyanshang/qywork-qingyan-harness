/**
 * ClearType 覆盖与画布像素的混合，与 GDI 相同：逐子像素按覆盖 k（0–6）取 alpha = `ALPHA[k]`，在伽马解码后的亮度上
 * 线性混合文字颜色与原有像素，再编码回 8 位。
 *
 * - 解码 `dec(v) = round(16383 × (v / 255)^γ)`，混合 `x = (dec(文字) × alpha + dec(原像素) × (255 − alpha)) / 255`，
 *   编码 `round(255 × (x / 16383)^(1/γ))`；k 为 0 时保持原像素，k 为 6 时取文字颜色。
 * - γ 为系统 ClearType 对比度（`ClearTypeDisplay.contrast`）除以 1000。对比度为 1000 时同一公式与 WPS 表格 13 种文字颜色 ×
 *   11 种填充色的全部 938 个组合逐值一致；对比度为 1200 时 WPS 黑字白底的各级亮度为 219、182、144、102、58。
 * - 同一段文字的字形先把覆盖相加（上限 6）再混合：GDI 把整段文字的取样点合并后滤波，相邻字形的覆盖区不重叠时两者相同。
 */

import type { CoverageGlyph } from './coverage.ts'

/** 显示器的 ClearType 设置。 */
export interface ClearTypeDisplay {
  /** 系统 ClearType 对比度（Windows `SPI_GETFONTSMOOTHINGCONTRAST`），1000–2200。 */
  readonly contrast: number
}

/** 覆盖 0–6 对应的 alpha。 */
const ALPHA = [0, 43, 85, 127, 170, 212, 255] as const
const DECODE_MAX = 16383

/** 一种对比度下各文字分量 f 的混合表：`tables[f][k × 256 + b]` 为原像素分量 b、覆盖 k 时的结果。按需建立。 */
interface Blender {
  readonly gamma: number
  readonly decode: Float64Array
  readonly tables: (Uint8Array | undefined)[]
}

const blenders = new Map<number, Blender>()

function blenderFor(contrast: number): Blender {
  let b = blenders.get(contrast)
  if (b === undefined) {
    const gamma = contrast / 1000
    b = {
      gamma,
      decode: Float64Array.from({ length: 256 }, (_, v) =>
        Math.round(DECODE_MAX * (v / 255) ** gamma),
      ),
      tables: [],
    }
    blenders.set(contrast, b)
  }
  return b
}

function tableFor(blender: Blender, f: number): Uint8Array {
  let t = blender.tables[f]
  if (t === undefined) {
    const { decode, gamma } = blender
    t = new Uint8Array(256 * 7)
    for (let b = 0; b < 256; b++) {
      t[b] = b
      t[6 * 256 + b] = f
      for (let k = 1; k < 6; k++) {
        const a = ALPHA[k]!
        const x = (decode[f]! * a + decode[b]! * (255 - a)) / 255
        t[k * 256 + b] = Math.round(255 * (x / DECODE_MAX) ** (1 / gamma))
      }
    }
    blender.tables[f] = t
  }
  return t
}

/**
 * 字形中覆盖不为 0 的像素：`x`、`y` 为图像内的列与行，`k` 为三个通道的覆盖 R | G << 8 | B << 16。
 * 由 `CoverageGlyph.coverage` 导出，按字形对象缓存。
 */
interface Ink {
  readonly x: Uint16Array
  readonly y: Uint16Array
  readonly k: Int32Array
}

const inks = new WeakMap<CoverageGlyph, Ink>()

function inkOf(g: CoverageGlyph): Ink {
  let ink = inks.get(g)
  if (ink === undefined) {
    const c = g.coverage
    let n = 0
    for (let i = 0; i < c.length; i += 3) if (c[i] || c[i + 1] || c[i + 2]) n++
    const x = new Uint16Array(n)
    const y = new Uint16Array(n)
    const k = new Int32Array(n)
    let j = 0
    for (let r = 0, i = 0; r < g.height; r++)
      for (let col = 0; col < g.width; col++, i += 3) {
        if (!(c[i] || c[i + 1] || c[i + 2])) continue
        x[j] = col
        y[j] = r
        k[j] = c[i]! | (c[i + 1]! << 8) | (c[i + 2]! << 16)
        j++
      }
    ink = { x, y, k }
    inks.set(g, ink)
  }
  return ink
}

/** 一段文字的覆盖之和（每像素 R | G << 8 | B << 16）与改动过的像素，按需加长；用后清零改动过的像素。 */
let sums = new Int32Array(0)
let touched = new Int32Array(0)
let areaAt = new Int32Array(0)

/** 各通道取不超过 6。 */
function clampLanes(s: number): number {
  return Math.min(s & 0xff, 6) | (Math.min((s >> 8) & 0xff, 6) << 8) | (Math.min(s >> 16, 6) << 16)
}

/** 合并读取时外接矩形允许多出的像素数（见 `paintGlyphRuns`）。 */
const GROUP_SLACK = 4096

/** 读写画布像素所需的 Canvas 2D 接口子集。 */
export interface PixelCanvas {
  getImageData(sx: number, sy: number, sw: number, sh: number): PixelData
  putImageData(data: PixelData, dx: number, dy: number): void
}

export interface PixelData {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
}

/** 放在设备像素坐标上的字形：`x` 为原点，`baseline` 为基线，均为整数。 */
export interface PlacedGlyph {
  readonly glyph: CoverageGlyph
  readonly x: number
  readonly baseline: number
}

/** 设备像素矩形 [left, right) × [top, bottom)。 */
export interface DeviceRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** `#rrggbb` 的三个分量；格式不符时为黑色。 */
function parseColor(color: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [0, 0, 0]
}

/** 一段文字：同一颜色的字形，只改动 `clip`（设备像素）内的像素。 */
export interface GlyphRun {
  readonly glyphs: readonly PlacedGlyph[]
  /** `#rrggbb`。 */
  readonly color: string
  readonly clip: DeviceRect
}

/** 一段文字的像素范围（字形图像的并集与裁剪矩形之交）；为空时返回 `null`。 */
function bounds(run: GlyphRun): DeviceRect | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const { glyph: g, x, baseline } of run.glyphs) {
    if (g.width === 0 || g.height === 0) continue
    left = Math.min(left, x + g.bearingX)
    right = Math.max(right, x + g.bearingX + g.width)
    top = Math.min(top, baseline - g.bearingY)
    bottom = Math.max(bottom, baseline - g.bearingY + g.height)
  }
  left = Math.max(left, Math.ceil(run.clip.left))
  top = Math.max(top, Math.ceil(run.clip.top))
  right = Math.min(right, Math.floor(run.clip.right))
  bottom = Math.min(bottom, Math.floor(run.clip.bottom))
  return right > left && bottom > top ? { left, top, right, bottom } : null
}

/** 把一段文字混合到 `px`（`area` 范围的 RGBA 像素）中，`box` 为这段文字的像素范围（在 `area` 之内）。 */
function blendRun(
  run: GlyphRun,
  box: DeviceRect,
  px: Uint8ClampedArray,
  area: DeviceRect,
  blender: Blender,
): void {
  const w = box.right - box.left
  const h = box.bottom - box.top
  if (sums.length < w * h) {
    sums = new Int32Array(Math.max(w * h, 2 * sums.length))
    touched = new Int32Array(sums.length)
    areaAt = new Int32Array(sums.length)
  }
  const stride = area.right - area.left
  const dx = box.left - area.left
  const dy = box.top - area.top
  let n = 0
  for (const { glyph: g, x, baseline } of run.glyphs) {
    if (g.width === 0 || g.height === 0) continue
    const gx = x + g.bearingX - box.left
    const gy = baseline - g.bearingY - box.top
    const ink = inkOf(g)
    for (let i = 0; i < ink.k.length; i++) {
      const cx = gx + ink.x[i]!
      const cy = gy + ink.y[i]!
      if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue
      const at = cy * w + cx
      const before = sums[at]!
      if (before === 0) {
        touched[n] = at
        areaAt[n++] = 4 * ((cy + dy) * stride + cx + dx)
      }
      let sum = before + ink.k[i]!
      if (sum & 0x080808) sum = clampLanes(sum)
      sums[at] = sum
    }
  }
  const [fr, fg, fb] = parseColor(run.color)
  const tr = tableFor(blender, fr)
  const tg = tableFor(blender, fg)
  const tb = tableFor(blender, fb)
  for (let i = 0; i < n; i++) {
    const at = touched[i]!
    const s = sums[at]!
    sums[at] = 0
    const kr = Math.min(s & 0xff, 6)
    const kg = Math.min((s >> 8) & 0xff, 6)
    const kb = Math.min(s >> 16, 6)
    const p = areaAt[i]!
    px[p] = tr[(kr << 8) | px[p]!]!
    px[p + 1] = tg[(kg << 8) | px[p + 1]!]!
    px[p + 2] = tb[(kb << 8) | px[p + 2]!]!
  }
}

/**
 * 按顺序把各段文字混合到画布上：相邻的若干段合为一组，读取一组的外接矩形、依次混合后写回。像素以设备坐标读写，
 * 不受画布当前的变换与裁剪路径影响；调用方须在其下的内容（填充、边框）画完之后、其上的内容画之前调用。
 * 只合并顺序相邻的段，不改变混合顺序。外接矩形的面积不超过各段面积之和的 2 倍加 `GROUP_SLACK` 时合并：画布读取的耗时
 * 随面积增长，整屏的并集比逐段读取慢；每次读取另有固定开销（Edge 实测，1600×900 的工作表视图）。
 */
export function paintGlyphRuns(
  ctx: PixelCanvas,
  runs: readonly GlyphRun[],
  display: ClearTypeDisplay,
): void {
  const blender = blenderFor(display.contrast)
  const boxes: DeviceRect[] = []
  const members: GlyphRun[] = []
  let left = 0
  let top = 0
  let right = 0
  let bottom = 0
  let area = 0
  const flush = () => {
    if (members.length === 0) return
    const all = { left, top, right, bottom }
    const img = ctx.getImageData(left, top, right - left, bottom - top)
    for (let i = 0; i < members.length; i++)
      blendRun(members[i]!, boxes[i]!, img.data, all, blender)
    ctx.putImageData(img, left, top)
    members.length = 0
    boxes.length = 0
  }
  for (const run of runs) {
    const box = bounds(run)
    if (box === null) continue
    const a = (box.right - box.left) * (box.bottom - box.top)
    if (members.length > 0) {
      const l = Math.min(left, box.left)
      const t = Math.min(top, box.top)
      const r = Math.max(right, box.right)
      const b = Math.max(bottom, box.bottom)
      if ((r - l) * (b - t) <= 2 * (area + a) + GROUP_SLACK) {
        left = l
        top = t
        right = r
        bottom = b
        area += a
        members.push(run)
        boxes.push(box)
        continue
      }
      flush()
    }
    left = box.left
    top = box.top
    right = box.right
    bottom = box.bottom
    area = a
    members.push(run)
    boxes.push(box)
  }
  flush()
}
