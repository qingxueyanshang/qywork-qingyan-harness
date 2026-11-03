/**
 * 断行规则：断点判定、行首行尾禁则字符与行尾悬挂标点。
 *
 * 判定顺序（先命中者生效）：
 * 1. 组合附加符号之前不断；`wordWrap` 开启时空格之前不断。
 * 2. 禁则开启时，行首禁则字符之前、行尾禁则字符之后不断。
 * 3. 空格之后、制表符两侧可断；连字符与破折号之后可断。
 * 4. `wordWrap` 开启时连字符与破折号之前不断；不压缩标点时汉字与破折号之间也不断，压缩标点时东亚字符与其后的
 *    连字符、破折号之间可断（WPS 实测：只随压缩标点设置变化，与兼容模式、对齐方式、字距调整无关）。
 * 5. 两侧任一为东亚字符时可断；两侧都是西文时不断（单词保持完整），`wordWrap` 为 `false` 时可断。希腊字母按东亚字符判定
 *    （WPS 实测：表格单元格中「激活α1/β」可在 α 之后断开；文字中东亚提示使希腊字母落在东亚字体时，「α1/β」可在 α 之后、
 *    β 之前断开）；文字中落在西文字体的希腊字母不断开（「α1/β」与「a1/b」相同），由调用方按 `western` 传入。
 *
 * `wordWrap` 为 `false` 时空格是普通字符：可以在其前断行，排不下时移到下一行行首（WPS 实测）。
 * 行内对象按其断行类别（`BreakUnit`）判定：不属于任何禁则表，不是空格、制表符或连字符。
 */

import { isEastAsian, isGreek } from './classify.ts'

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
  /** 压缩标点（WordprocessingML 的 `characterSpacingControl`）：行宽不足时压缩标点（见 `layout.ts`），并改变规则 4。缺省为 `false`。 */
  readonly compressPunctuation?: boolean
}

/**
 * 断行判定的一方：字符的码位，或行内对象的断行类别（WPS 实测）：`ideographic` 按汉字判定（嵌入式对象两侧可断），
 * `western` 按西文字母判定（公式与相邻的西文之间不断开）。
 */
export type BreakUnit = number | 'ideographic' | 'western'

function eastAsian(u: BreakUnit): boolean {
  return typeof u === 'number' ? isEastAsian(u) || isGreek(u) : u === 'ideographic'
}

/**
 * 最小内容宽度（`layout.ts` 的 `contentWidths`）所用的断点：与 `canBreakBetween` 有两处不同（WPS 实测，构造文档 w10d）。
 * - 东亚字符与其后的连字符、破折号之间总可断，与压缩标点设置无关（「汉-汉汉」的最小宽度为一个汉字宽）。
 * - 压缩标点时，连字符、破折号与其后的西文字符之间不断（「-15.0%」的最小宽度为整个字符串宽，不压缩标点时为「15.0%」宽）。
 * 排版的断行仍按 `canBreakBetween`：同一文档中「-15.0%」排不下时在连字符之后断开。
 */
export function canBreakForWidth(before: BreakUnit, after: BreakUnit, rules: BreakRules): boolean {
  const b = typeof before === 'number' ? before : -1
  const a = typeof after === 'number' ? after : -1
  if (DASHES.has(b) && rules.compressPunctuation === true && !eastAsian(after)) return false
  if (DASHES.has(a) && eastAsian(before))
    return !(rules.kinsoku && (rules.noLineBreakBefore.has(a) || rules.noLineBreakAfter.has(b)))
  return canBreakBetween(before, after, rules)
}

/** `before` 与 `after` 之间能否断行。强制换行由调用方处理，不经过本函数。 */
export function canBreakBetween(before: BreakUnit, after: BreakUnit, rules: BreakRules): boolean {
  // 对象没有码位：-1 不属于任何字符集合。
  const b = typeof before === 'number' ? before : -1
  const a = typeof after === 'number' ? after : -1
  if ((a >= 0 && COMBINING.test(String.fromCodePoint(a))) || (a === SPACE && rules.wordWrap))
    return false
  if (rules.kinsoku && (rules.noLineBreakBefore.has(a) || rules.noLineBreakAfter.has(b))) {
    return false
  }
  if (b === SPACE || b === TAB || a === TAB || DASHES.has(b)) return true
  if (DASHES.has(a) && rules.wordWrap && !(rules.compressPunctuation === true && eastAsian(before)))
    return false
  if (eastAsian(before) || eastAsian(after)) return true
  return !rules.wordWrap
}
