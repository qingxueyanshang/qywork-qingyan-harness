/**
 * 页码文字：按节的页码格式（`pgNumType/@w:fmt`）显示页码值。格式与编号格式（`numFmt`）共用取值与规则，
 * 未实现的格式按十进制显示。
 */

import { formatNumber } from '../resolve/number-format.ts'

export function pageNumberText(value: number, format: string): string {
  return formatNumber(value, format) ?? String(value)
}
