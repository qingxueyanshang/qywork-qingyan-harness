/**
 * 行高与基线：单倍行高由字体纵向度量决定，再按行距规则换算。长度单位为磅。
 *
 * - 单倍行高取 `usWinAscent + usWinDescent`（GDI 的字符高度），不取 `sTypo*`：
 *   代码页含中日韩的字体乘以 1.3 并按字体单位向下取整，其余字体加 GDI 的外部行距。
 *   宋体 10.5 磅为 13.62 磅、Times New Roman 10.5 磅为 12.07 磅。
 * - 中日韩字体乘 1.3 增加的部分一半加在上沿之上、一半加在下沿之下；外部行距加在上沿之上。
 *   一行的上沿、下沿分别取行内各字体的最大值，两者之和为该行的单倍行高：
 *   宋体与等线同在一行时，行高大于两者各自的单倍行高。
 */

import type { VerticalMetrics } from '../font/vertical.ts'

const EAST_ASIAN_FACTOR = 1.3
/** 固定行高时基线距行顶的比例，与字体无关。 */
const EXACT_BASELINE = 0.8
/** 浮点误差容差：单倍行高恰为网格行距的整数倍时不多占一格。 */
const GRID_EPSILON = 1e-6

export type LineSpacing =
  /** 单倍行高的倍数；1 为单倍。 */
  | { readonly rule: 'multiple'; readonly value: number }
  /** 固定行高（磅），内容超出时不扩大。 */
  | { readonly rule: 'exact'; readonly value: number }
  /** 最小行高（磅），内容更高时取内容高度。 */
  | { readonly rule: 'atLeast'; readonly value: number }
  /**
   * 行内最大单倍行高的倍数，增加（或减少）的部分在文字上方；不对齐网格。DrawingML 的百分比行距（`spcPct`）：
   * 行高不随行内字体的上下沿组合而增大。
   */
  | { readonly rule: 'proportional'; readonly value: number }
  /** 固定行高（磅），与行内最大单倍行高之差加在文字上方；不对齐网格。DrawingML 的磅值行距（`spcPts`）。 */
  | { readonly rule: 'fixed'; readonly value: number }

/** `hhea.lineGap` 超出 Windows 上下沿与 `hhea` 上下沿之差的部分，不小于 0。 */
function externalLeading(v: VerticalMetrics): number {
  const win = v.winAscent + v.winDescent
  const hhea = v.hheaAscender - v.hheaDescender
  return Math.max(0, v.hheaLineGap - (win - hhea))
}

/** 单倍行高，单位与 `size` 相同。 */
export function singleLineHeight(v: VerticalMetrics, size: number): number {
  const e = faceExtent(v, size)
  return e.ascent + e.descent
}

export interface FaceExtent {
  /** 基线以上的高度，含行距余量。 */
  readonly ascent: number
  /** 基线以下的高度，含行距余量。 */
  readonly descent: number
  readonly single: number
}

/** 一种字体在给定字号下的上下沿与单倍行高。 */
export function faceExtent(v: VerticalMetrics, size: number): FaceExtent {
  const scale = size / v.unitsPerEm
  const win = v.winAscent + v.winDescent
  if (v.eastAsianCodePage) {
    const half = (Math.floor(win * EAST_ASIAN_FACTOR) - win) / 2
    const ascent = (v.winAscent + half) * scale
    const descent = (v.winDescent + half) * scale
    return { ascent, descent, single: ascent + descent }
  }
  const ascent = (v.winAscent + externalLeading(v)) * scale
  const descent = v.winDescent * scale
  return { ascent, descent, single: ascent + descent }
}

export interface LineBox {
  readonly height: number
  /** 基线距行顶的距离。 */
  readonly baseline: number
}

/**
 * 由行内各字体的上下沿求行高与基线。`gridPitch` 为行网格的行距，`null` 为不对齐网格。
 *
 * - 多倍：行高为单倍行高加（倍数 − 1）× 行内最大的单倍行高，增加部分在文字下方。
 *   有网格时行高为单倍行高向上取整到网格行距的整数倍与倍数 × 网格行距中的较大者，文字在行内上下居中。
 * - 最小值：行高为设定值与单倍行高（有网格时为取整后的高度）中的较大者，增加部分在文字上方。
 * - 固定：行高为设定值，不受网格影响，基线位于行高的 80% 处。
 * - 比例：行高为倍数 × 行内最大的单倍行高（不取各字体上下沿之和），增加部分在文字上方，不受网格影响。
 * - 固定（DrawingML）：行高为设定值，与行内最大单倍行高之差在文字上方，不受网格影响。
 */
export function lineBox(
  extents: readonly FaceExtent[],
  spacing: LineSpacing,
  gridPitch: number | null,
): LineBox {
  let ascent = 0
  let descent = 0
  let largest = 0
  for (const e of extents) {
    ascent = Math.max(ascent, e.ascent)
    descent = Math.max(descent, e.descent)
    largest = Math.max(largest, e.single)
  }
  const single = ascent + descent
  const snapped =
    gridPitch === null
      ? single
      : Math.max(1, Math.ceil(single / gridPitch - GRID_EPSILON)) * gridPitch
  switch (spacing.rule) {
    case 'multiple': {
      if (gridPitch === null)
        return { height: single + (spacing.value - 1) * largest, baseline: ascent }
      const height = Math.max(snapped, spacing.value * gridPitch)
      return { height, baseline: ascent + (height - single) / 2 }
    }
    case 'exact':
      return { height: spacing.value, baseline: spacing.value * EXACT_BASELINE }
    case 'atLeast': {
      const height = Math.max(spacing.value, snapped)
      return { height, baseline: ascent + height - single }
    }
    case 'proportional': {
      const extra = (spacing.value - 1) * largest
      return { height: largest + extra, baseline: ascent + extra }
    }
    case 'fixed':
      return { height: spacing.value, baseline: ascent + spacing.value - largest }
  }
}
