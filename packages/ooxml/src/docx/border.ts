/**
 * 边框线型：各线型由哪几条线与间距组成。段落、表格与页面边框共用。
 *
 * WPS 12.1 实测（段落下边框与页面边框的屏幕 EMF，线宽 0.75、1.5、3 磅）：线与间距按屏幕顺序（自上而下、自左而右）排列，
 * 与所在的边无关；`thinThick` 类粗线在前，`thickThin` 类细线在前。`w` 为 `w:sz` 换算的线宽：
 * - `double`：w、w、w；`triple`：w、w、w、w、w。
 * - `SmallGap`：粗线 w，间距与细线各 0.75 磅。`MediumGap`：粗线 w，间距与细线各 w/2。`LargeGap`：粗线 1.5 磅，间距 w，
 *   细线 0.75 磅。`thinThickThin` 类为细、间距、粗、间距、细。
 * - 其余线型（含点线与虚线）为一条线宽 w 的线。
 */

import type { Border } from './model.ts'

/** 一条线：距线组起点的偏移与粗细（磅）。 */
export interface BorderStroke {
  readonly offset: number
  readonly size: number
}

const THIN = 0.75
const LARGE_THICK = 1.5

/** 线与间距的粗细，按屏幕顺序交替排列（线、间距、线……）。 */
function parts(style: string, w: number): number[] {
  if (style === 'none' || style === 'nil') return []
  if (style === 'double') return [w, w, w]
  if (style === 'triple') return [w, w, w, w, w]
  const gap = /^(thinThickThin|thinThick|thickThin)(Small|Medium|Large)Gap$/.exec(style)
  if (gap === null) return [w]
  const [thick, space, thin] =
    gap[2] === 'Small'
      ? [w, THIN, THIN]
      : gap[2] === 'Medium'
        ? [w, w / 2, w / 2]
        : [LARGE_THICK, w, THIN]
  if (gap[1] === 'thinThick') return [thick, space, thin]
  if (gap[1] === 'thickThin') return [thin, space, thick]
  return [thin, space, thick, space, thin]
}

/** 线型 `style`、线宽 `width`（磅）的各条线；`none` 为空。 */
export function borderStrokes(style: string, width: number): BorderStroke[] {
  const out: BorderStroke[] = []
  let offset = 0
  parts(style, width).forEach((size, k) => {
    if (k % 2 === 0) out.push({ offset, size })
    offset += size
  })
  return out
}

/** 边框在排版中占用的宽度：各条线与间距之和。 */
export function borderSpace(b: Border | null | undefined): number {
  if (b == null) return 0
  return parts(b.style, b.width).reduce((a, c) => a + c, 0)
}
