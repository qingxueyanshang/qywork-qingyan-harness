/**
 * 标点挤压（WPS 实测，宋体与微软雅黑）：相邻标点的固定压缩，以及压缩标点设置下按行宽压缩标点。
 *
 * - 相邻压缩与压缩标点设置无关，只在两字所在字段都开启字距调整（`TextRun.kern`）时发生：
 *   前一字属于 `ADJACENT_FIRST`、后一字属于 `ADJACENT_SECOND` 时前一字去掉右半；
 *   两字都属于 `OPENING` 时后一字去掉左半。`？`、`…`、`—` 不参与。
 * - 压缩标点：行宽不足时压缩行内属于 `COMPRESSIBLE` 的标点，每个至多压缩到原宽度的一半；行首的开启类标点不压缩。
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

/**
 * 压缩标点设置下，加入一个字符使行宽超出 `overflow` 时是否以压缩行内 `count` 个标点容纳它（另需容量足够）：
 * 每个标点的压缩量按 0.25 磅四舍五入后须小于 `slack`，即不容纳它、在最近的断点断行时该行的剩余宽度。
 * 这是对 WPS 的经验拟合，机制未查明：12 磅时 1 至 6 个与 8 个逗号的分界依次为超出 6、8、9、9.5、10、10.25、10.75 磅
 * （等于该值时拒绝，低 0.1 至 0.25 磅时接受），10.5 磅两个逗号为 7 磅，均与此一致；断点因禁则前移时 `slack` 随之增大。
 */
export function acceptsCompression(overflow: number, count: number, slack: number): boolean {
  const share = Math.round((overflow / count) * 4 + EPSILON) / 4
  return share < slack - EPSILON
}
