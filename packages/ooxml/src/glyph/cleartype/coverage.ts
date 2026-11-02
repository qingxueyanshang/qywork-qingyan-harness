/**
 * ClearType 的子像素覆盖（Windows GDI 实测，RGB 排列）：提示后的轮廓 x 方向放大 6 倍、y 方向放大 `rows` 倍，按单色扫描转换的
 * 规则逐个取样点光栅化（每像素横向 6 个、纵向 `rows` 个取样点）。每个子像素取以它为中心、宽 1 像素的取样窗口：
 * 像素 p 的 R、G、B 依次取横向取样点 [6p − 2, 6p + 4)、[6p, 6p + 6)、[6p + 2, 6p + 8) 与该像素的全部纵向取样点。
 * 纵向取样点按 `ROW_WEIGHTS` 加权，覆盖为加权的着墨个数除以权重之和后四舍五入，取值 0–6。y 方向平滑时 `rows` 为 5，
 * 否则为 1（见 `ClearTypeRange.smoothY`）。权重与取样数为 GDI 实测：构造字体中横边与竖边各在 1/12 像素的位置时
 * 各通道的覆盖，等权平均与之不符。
 */

import { type HintedOutline, rasterize } from '../../font/index.ts'

/** 每像素的横向取样点数。 */
export const SAMPLES = 6
/** y 方向平滑时每像素的纵向取样点数。 */
export const SMOOTH_ROWS = 5
/** y 方向平滑时像素内各纵向取样点的权重，自上而下（对称）。 */
const ROW_WEIGHTS = [1, 2, 3, 2, 1]
const ROW_WEIGHT_SUM = 9

/** 一个字形的子像素覆盖。 */
export interface CoverageGlyph {
  readonly width: number
  readonly height: number
  /** 原点到图像左边的像素数，向右为正。 */
  readonly bearingX: number
  /** 基线到图像上边的像素数，向上为正。 */
  readonly bearingY: number
  /** 逐行排列，每像素 R、G、B 三个字节，取值 0–6；长度为 `3 × width × height`。 */
  readonly coverage: Uint8Array
}

/** 取样点阵：每个取样点一个字节，1 为着墨；`bearingX`、`bearingY` 以取样点计。 */
export interface SampleRaster {
  readonly width: number
  readonly height: number
  readonly bearingX: number
  readonly bearingY: number
  readonly pixels: Uint8Array
}

export const EMPTY_GLYPH: CoverageGlyph = {
  width: 0,
  height: 0,
  bearingX: 0,
  bearingY: 0,
  coverage: new Uint8Array(0),
}

/** 单色取样：x 坐标放大 `SAMPLES` 倍、y 坐标放大 `rows` 倍后光栅化。 */
export function sampleOutline(o: HintedOutline, rows: number): SampleRaster {
  const n = o.xs.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    xs[i] = o.xs[i]! * SAMPLES
    ys[i] = o.ys[i]! * rows
  }
  return rasterize({ ...o, xs, ys, advance: o.advance * SAMPLES })
}

/**
 * GDI 的合成粗体：取样点阵与其右移 1 像素（`SAMPLES` 个取样点）的副本取并集。GDI 实测（构造字体的竖条与斜边、
 * 楷体与宋体 ppem 16–60 的前进宽度）：加宽恒为 1 像素，与字号无关。
 */
export function emboldenSamples(s: SampleRaster): SampleRaster {
  if (s.width === 0) return s
  const width = s.width + SAMPLES
  const pixels = new Uint8Array(width * s.height)
  for (let y = 0; y < s.height; y++) {
    const from = y * s.width
    const to = y * width
    for (let x = 0; x < s.width; x++) {
      if (!s.pixels[from + x]) continue
      pixels[to + x] = 1
      pixels[to + x + SAMPLES] = 1
    }
  }
  return { ...s, width, pixels }
}

/** 前缀和两端补零的取样点数：取样窗口最多越出点阵 9 个取样点。 */
const PAD = 10

/** 由取样点阵计算子像素覆盖。`rows` 为每像素的纵向取样点数。 */
export function filterSamples(s: SampleRaster, rows: number): CoverageGlyph {
  if (s.width === 0 || s.height === 0) return EMPTY_GLYPH
  const first = s.bearingX
  const last = s.bearingX + s.width - 1
  // 像素 p 的取样窗口为 [6p − 2, 6p + 8)：R 的起点最左，B 的终点最右。
  const p0 = Math.ceil((first - 7) / SAMPLES)
  const p1 = Math.floor((last + 2) / SAMPLES)
  const width = p1 - p0 + 1
  // 取样行 y（自上而下）的上沿在基线以上 bearingY − y 个取样点处；上沿 u 所在的像素行的上沿为 ⌈u / rows⌉。
  const top = Math.ceil(s.bearingY / rows)
  const height = top - Math.floor((s.bearingY - s.height) / rows)
  const sums = new Int32Array(3 * width * height)
  // 同一像素行的各取样行按权重相加为 `weighted`，再按前缀和取各窗口之和：
  // prefix[PAD + k] 为第 0 至 k − 1 个取样点的加权和，点阵之外按未着墨计。
  const sw = s.width
  const weighted = new Int32Array(sw)
  const prefix = new Int32Array(sw + 2 * PAD)
  // 像素 p0 的 G 窗口起点相对点阵左边的取样点数。
  const origin = SAMPLES * p0 - first + PAD
  const pixels = s.pixels
  let y = 0
  while (y < s.height) {
    // 第 y 行起属于同一像素行的取样行。
    const pixelTop = Math.ceil((s.bearingY - y) / rows)
    let inked = 0
    for (; y < s.height && Math.ceil((s.bearingY - y) / rows) === pixelTop; y++) {
      const w = rows === 1 ? 1 : ROW_WEIGHTS[pixelTop * rows - (s.bearingY - y)]!
      const row = y * sw
      for (let x = 0; x < sw; x++) {
        const v = pixels[row + x]!
        weighted[x] = weighted[x]! + w * v
        inked |= v
      }
    }
    if (inked === 0) continue
    let n = 0
    for (let x = 0; x < sw; x++) {
      n += weighted[x]!
      prefix[PAD + x + 1] = n
    }
    prefix.fill(n, PAD + sw + 1)
    weighted.fill(0)
    let out = 3 * (top - pixelTop) * width
    for (let i = 0, at = origin; i < width; i++, at += SAMPLES, out += 3) {
      sums[out] = prefix[at + 4]! - prefix[at - 2]!
      sums[out + 1] = prefix[at + 6]! - prefix[at]!
      sums[out + 2] = prefix[at + 8]! - prefix[at + 2]!
    }
  }
  const norm = rows === 1 ? 1 : ROW_WEIGHT_SUM
  const coverage = new Uint8Array(sums.length)
  for (let i = 0; i < sums.length; i++) coverage[i] = Math.round(sums[i]! / norm)
  return { width, height, bearingX: p0, bearingY: top, coverage }
}
