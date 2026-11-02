/**
 * 行高与基线：单倍行高由字体纵向度量决定，再按行距规则换算。长度单位为磅。
 *
 * - 单倍行高取 `usWinAscent + usWinDescent`（GDI 的字符高度），不取 `sTypo*`：
 *   代码页含中日韩的字体乘以 1.3 并按字体单位向下取整，其余字体加 GDI 的外部行距。
 *   宋体 10.5 磅为 13.62 磅、Times New Roman 10.5 磅为 12.07 磅。
 * - 代码页不含中日韩、设置了 `USE_TYPO_METRICS` 的字体取 `hhea` 的上沿减下沿加行距，行距加在上沿之上（WPS 实测，构造
 *   文档 w9-face：Cambria Math、Cascadia Code、Sitka Text、Gabriola 10.5 磅为 12.30、12.20、13.10、17.85 磅；未设置该位的
 *   Segoe UI Emoji、Calibri 等 `hhea` 小于 Windows 上下沿时仍取后者）。
 * - 中日韩字体乘 1.3 增加的部分一半加在上沿之上、一半加在下沿之下；外部行距加在上沿之上。
 *   一行的上沿、下沿分别取行内各字体的最大值，两者之和为该行的单倍行高：
 *   宋体与等线同在一行时，行高大于两者各自的单倍行高。
 */

import type { VerticalMetrics } from '../font/vertical.ts'

const EAST_ASIAN_FACTOR = 1.3
/** 固定行高时基线距行顶的比例，与字体无关。 */
const EXACT_BASELINE = 0.8
/** 多倍行距小于 1 且不对齐网格时，减少的行高中取自基线以上的比例，其余取自基线以下。 */
const REDUCED_ABOVE = 0.8
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
   * 行内最大单倍行高的倍数，行高不随行内字体的上下沿组合而增大；不对齐网格。只由 DrawingML 的百分比行距（`spcPct`）
   * 产生：有片段的行由 `drawingml/text/body.ts` 的 `hostBlock` 按宿主规则另求行高与基线，本规则的结果只用于没有片段的行
   * （空段落），以及倍数为 1 时的单倍行高；WordprocessingML 不使用。
   */
  | { readonly rule: 'proportional'; readonly value: number }
  /** 固定行高（磅）；不对齐网格。只由 DrawingML 的磅值行距（`spcPts`）产生，使用范围同 `proportional`。 */
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
  if (v.useTypoMetrics === true) {
    const ascent = (v.hheaAscender + v.hheaLineGap) * scale
    const descent = -v.hheaDescender * scale
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

/** 一行内容的纵向范围：上沿与下沿（基线以上、以下），以及多倍、比例与 DrawingML 固定行距的基数。 */
export interface LineExtent {
  readonly ascent: number
  readonly descent: number
  readonly base: number
}

/**
 * 由行内各字体的上下沿求行高与基线。`gridPitch` 为行网格的行距，`null` 为不对齐网格。
 *
 * - 多倍：行高为单倍行高加（倍数 − 1）× 行内最大的单倍行高，增加部分在文字下方；倍数小于 1 时减少部分的 80% 取自
 *   文字上方（WPS 实测，构造文档 w11c：宋体 10.5 与 18 磅、微软雅黑 10.5 磅，倍数 0.5 至 0.92）。
 *   有网格时行高为单倍行高向上取整到网格行距的整数倍与倍数 × 网格行距中的较大者，文字在行内上下居中。
 * - 最小值：设定值不小于单倍行高（有网格时为取整后的高度）时行高为设定值，增加部分在文字上方；小于时与单倍行距相同，
 *   有网格时文字在取整后的行内上下居中（WPS 实测，网格行距 15.6 磅：宋体 10.5 磅最小值 6 至 15 磅时基线距行顶
 *   (15.6 − 单倍) / 2 加上沿，15.6 磅及以上时为设定值减下沿；微软雅黑 10.5 磅最小值 30 磅时行高 31.2 磅、文字居中）。
 * - 固定：行高为设定值，不受网格影响，基线位于行高的 80% 处。
 * - 比例（DrawingML）：行高为倍数 × 行内最大的单倍行高（不取各字体上下沿之和），与单倍行高之差计在基线之上，不受网格影响。
 * - 固定（DrawingML）：行高为设定值，与行内最大单倍行高之差计在基线之上，不受网格影响。
 *   这两条规则的基线只决定没有片段的行（空段落）；有片段的行由宿主另求（见 `LineSpacing`）。
 */
export function lineBox(
  extents: readonly FaceExtent[],
  spacing: LineSpacing,
  gridPitch: number | null,
): LineBox {
  let ascent = 0
  let descent = 0
  let base = 0
  for (const e of extents) {
    ascent = Math.max(ascent, e.ascent)
    descent = Math.max(descent, e.descent)
    base = Math.max(base, e.single)
  }
  return extentBox({ ascent, descent, base }, spacing, gridPitch)
}

/** 由一行内容的纵向范围求行高与基线，规则同 `lineBox`；行内最大的单倍行高为 `base`。 */
export function extentBox(
  { ascent, descent, base: largest }: LineExtent,
  spacing: LineSpacing,
  gridPitch: number | null,
): LineBox {
  const single = ascent + descent
  const snapped =
    gridPitch === null
      ? single
      : Math.max(1, Math.ceil(single / gridPitch - GRID_EPSILON)) * gridPitch
  switch (spacing.rule) {
    case 'multiple': {
      if (gridPitch === null) {
        const extra = (spacing.value - 1) * largest
        return {
          height: single + extra,
          baseline: extra < 0 ? ascent + extra * REDUCED_ABOVE : ascent,
        }
      }
      const height = Math.max(snapped, spacing.value * gridPitch)
      return { height, baseline: ascent + (height - single) / 2 }
    }
    case 'exact':
      return { height: spacing.value, baseline: spacing.value * EXACT_BASELINE }
    case 'atLeast':
      if (spacing.value < snapped)
        return { height: snapped, baseline: ascent + (snapped - single) / 2 }
      return { height: spacing.value, baseline: ascent + spacing.value - single }
    case 'proportional': {
      const extra = (spacing.value - 1) * largest
      return { height: largest + extra, baseline: ascent + extra }
    }
    case 'fixed':
      return { height: spacing.value, baseline: ascent + spacing.value - largest }
  }
}
