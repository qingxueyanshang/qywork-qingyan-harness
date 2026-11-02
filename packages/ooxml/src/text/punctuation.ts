/**
 * 标点挤压（WPS 实测，宋体与微软雅黑）：相邻标点的固定压缩，以及压缩标点设置下按行宽压缩标点。
 *
 * - 相邻压缩与压缩标点设置无关，只在两字所在字段都开启字距调整（`TextRun.kern`）时发生：
 *   前一字属于 `ADJACENT_FIRST`、后一字属于 `ADJACENT_SECOND` 时前一字去掉右半；
 *   两字都属于 `OPENING` 时后一字去掉左半。`？`、`…`、`—` 不参与。
 * - 压缩标点：行宽不足时压缩行内属于 `COMPRESSIBLE` 且使用东亚字体的标点，每个至多压缩到原宽度的一半；
 *   行首的开启类标点不压缩。无东亚提示的 `“”` 使用西文字体，不压缩。是否压缩由 `acceptsCompression` 判定。
 */

import { codePointSet } from './breaking.ts'

/** 相邻压缩中去掉右半的前一字：句末点号、闭合类标点与间隔号。 */
export const ADJACENT_FIRST = codePointSet('，。、：；！”’）》】」』〉〕〗·．')

/** 使前一字去掉右半的后一字。 */
export const ADJACENT_SECOND = codePointSet('，。、：；！“”‘’（）《》【】「」·')

/** 开启类标点：左侧为空白，压缩时去掉左侧。 */
export const OPENING = codePointSet('“‘（《【「『〈〔〖')

/** 压缩标点设置下可压缩的标点。`？`、`…`、`—`、`～`、`％` 不压缩。 */
export const COMPRESSIBLE = codePointSet('，、。：；！“”‘’（）《》【】「」『』〈〉〔〕〖〗·．')

/** 相邻压缩：`after` 使 `before` 去掉右半时为 `'first'`，`before` 使 `after` 去掉左半时为 `'second'`。 */
export function adjacentSqueeze(before: number, after: number): 'first' | 'second' | null {
  if (ADJACENT_FIRST.has(before) && ADJACENT_SECOND.has(after)) return 'first'
  if (OPENING.has(before) && OPENING.has(after)) return 'second'
  return null
}

const EPSILON = 1e-6

/** 两端对齐的普通字间在压缩判定中的伸展量：前一字字号的 1/64。中西文间距的伸展量为其宽度。 */
export const SLOT_STRETCH = 1 / 64

/**
 * 兼容模式 15 及以上，越过行宽的字符（连同其后不能断开的字符）以压缩标点排入本行的条件：
 * `overflow / shrink ≤ slack / stretch`，即排入时的收缩比例不大于不排入、在最近的断点断行时的伸展比例。
 *
 * - `overflow`：排入后超出行宽的量；`slack`：在最近的断点断行时该行的剩余宽度。
 * - `shrink`：排入后的行中可压缩标点的容量之和，加上每个中西文间距宽度的一半；
 *   该行最后一字不得位于行首时（句号、逗号、问号等），以其全部宽度代替它的容量。
 * - `stretch`：在断点断行时该行各字间的伸展量之和（见 `SLOT_STRETCH`）。
 *
 * WPS 实测（宋体 12 与 10.5 磅，正文与单元格）：阈值随断行后的字间数增加而降低，随中西文间距增加而降低，
 * 与单双字节宽度协调、连续字母或数字的个数无关。中西文间距一侧为 Times New Roman 数字时，阈值与实测差约 0.05 磅。
 */
export function acceptsCompression(
  overflow: number,
  shrink: number,
  slack: number,
  stretch: number,
): boolean {
  return overflow * stretch <= slack * shrink + EPSILON
}

/**
 * 兼容模式 14 及以下：越过行宽的字符本身超出行宽的量（它是可压缩标点时减去它自身的容量）不超过其字号的一半时排入，
 * 与标点个数、行长和其后须连排的字符无关（WPS 实测）。
 */
export function acceptsCompressionBelow15(overflow: number, size: number): boolean {
  return overflow <= size / 2 + EPSILON
}
