/**
 * 断行规则：断点判定、行首行尾禁则字符与行尾悬挂标点。
 *
 * 判定顺序（先命中者生效）：
 * 1. 组合附加符号之前不断；`wordWrap` 开启时空格之前不断。
 * 2. 禁则开启时，行首禁则字符之前、行尾禁则字符之后不断。
 * 3. 空格之后、制表符两侧可断；连字符与破折号之后可断。
 * 4. 连字符与破折号之前不断（汉字与破折号之间也不断）。
 * 5. 两侧任一为东亚字符时可断；两侧都是西文时不断（单词保持完整），`wordWrap` 为 `false` 时可断。
 *
 * `wordWrap` 为 `false` 时空格是普通字符：可以在其前断行，排不下时移到下一行行首（WPS 实测）。
 */

import { isEastAsian } from './classify.ts'

/** 字符串中各字符的码位集合。 */
export function codePointSet(chars: string): ReadonlySet<number> {
  const set = new Set<number>()
  for (const ch of chars) set.add(ch.codePointAt(0)!)
  return set
}

/**
 * 简体中文默认的行首禁则字符（ISO/IEC 29500-1 `kinsoku` 的缺省表）。
 * 不要换成 WPS 自动化接口 `Document.NoLineBreakBefore` 返回的表：后者缺少 `%`、`°`、`℃` 等，
 * 多出 `々`，而 WPS 实际排版不让 `%`、`℃` 位于行首，允许 `々` 位于行首。
 */
export const DEFAULT_NO_LINE_BREAK_BEFORE = codePointSet(
  '!%),.:;>?]}¢¨°·ˇˉ―‖’”…‰′″›℃∶、。〃〉》」』】〕〗〞︶︺︾﹀﹄﹚﹜﹞！＂％＇），．：；？］｀｜｝～￠',
)

/** 简体中文默认的行尾禁则字符（ISO/IEC 29500-1 `kinsoku` 的缺省表）。 */
export const DEFAULT_NO_LINE_BREAK_AFTER = codePointSet(
  '$([{£¥·‘“〈《「『【〔〖〝﹙﹛﹝＄（．［｛￡￥',
)

/**
 * 允许越过行宽悬挂在行尾的标点（段落的 `overflowPunct`），与禁则开关无关。
 * 只悬挂一个字符；悬挂后下一个字符仍不得位于行首时不悬挂，改按断点回退。
 * 不要由禁则表推导：同为行首禁则字符，`，`、`！`、`）` 悬挂，`？`、`…`、`％` 不悬挂（与 WPS 一致）。
 */
export const HANGING_PUNCTUATION = codePointSet('!),.:;?]}ˇ’”∶、。〉》」』】〕〗！＂＇），：；］￠')

/** 其后可断、其前不断的字符：连字符、短破折号、长破折号。 */
const DASHES = codePointSet('-–—')

const SPACE = 0x20
const TAB = 0x09
const COMBINING = /\p{M}/u

export interface BreakRules {
  readonly kinsoku: boolean
  /** 为 `false` 时西文单词内部也可断（`w:wordWrap` 为 off）。 */
  readonly wordWrap: boolean
  readonly noLineBreakBefore: ReadonlySet<number>
  readonly noLineBreakAfter: ReadonlySet<number>
}

/** 码位 `before` 与 `after` 之间能否断行。强制换行由调用方处理，不经过本函数。 */
export function canBreakBetween(before: number, after: number, rules: BreakRules): boolean {
  if (COMBINING.test(String.fromCodePoint(after)) || (after === SPACE && rules.wordWrap))
    return false
  if (rules.kinsoku && (rules.noLineBreakBefore.has(after) || rules.noLineBreakAfter.has(before))) {
    return false
  }
  if (before === SPACE || before === TAB || after === TAB || DASHES.has(before)) return true
  if (DASHES.has(after)) return false
  if (isEastAsian(before) || isEastAsian(after)) return true
  return !rules.wordWrap
}
