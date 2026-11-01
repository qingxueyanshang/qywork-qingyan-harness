/**
 * 项目符号的文字：自动编号（`buAutoNum` 的 `type`）按编号值生成，字符项目符号在符号字体中换算码位。
 *
 * - 泰文、印地文、希伯来文编号按阿拉伯数字生成；带圈数字超出字符集范围（黑圈 1–20、白圈 1–20）时按阿拉伯数字生成。
 * - 符号字体（如 Wingdings）只有符号编码的 `cmap` 时，字符 U+0020–U+00FF 映射到 U+F020–U+F0FF。
 */

import type { TextFace } from '../../text/index.ts'

const ROMAN: readonly [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function roman(n: number): string {
  let out = ''
  let rest = n
  for (const [v, s] of ROMAN) {
    while (rest >= v) {
      out += s
      rest -= v
    }
  }
  return out
}

/** `a`…`z`、`aa`…`zz`：超过 26 时重复字母。 */
function alpha(n: number): string {
  const letter = String.fromCharCode(97 + ((n - 1) % 26))
  return letter.repeat(Math.floor((n - 1) / 26) + 1)
}

const CHINESE_DIGITS = '〇一二三四五六七八九'

/** 中文小写数字：1–99 按「十」「二十一」的读法，其余逐位。 */
function chinese(n: number): string {
  if (n >= 1 && n < 100) {
    const tens = Math.floor(n / 10)
    const ones = n % 10
    const t = tens === 0 ? '' : tens === 1 ? '十' : `${CHINESE_DIGITS[tens]}十`
    return t + (ones === 0 ? '' : CHINESE_DIGITS[ones]!)
  }
  return [...String(n)].map((d) => CHINESE_DIGITS[Number(d)]).join('')
}

function fullWidth(s: string): string {
  return [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('')
}

function circled(n: number, black: boolean): string {
  if (black) {
    if (n >= 1 && n <= 10) return String.fromCodePoint(0x2776 + n - 1)
    if (n >= 11 && n <= 20) return String.fromCodePoint(0x24eb + n - 11)
  } else if (n >= 1 && n <= 20) {
    return String.fromCodePoint(0x2460 + n - 1)
  }
  return String(n)
}

/** 自动编号的文字（不含其后与正文之间的制表符）。 */
export function autoNumberText(scheme: string, n: number): string {
  const m = /^(alphaLc|alphaUc|arabic|romanLc|romanUc)(ParenBoth|ParenR|Period|Plain)$/.exec(scheme)
  if (m !== null) {
    const kind = m[1]!
    const body = kind === 'arabic' ? String(n) : kind.startsWith('alpha') ? alpha(n) : roman(n)
    const text = kind.endsWith('Uc') ? body.toUpperCase() : body
    switch (m[2]) {
      case 'ParenBoth':
        return `(${text})`
      case 'ParenR':
        return `${text})`
      case 'Period':
        return `${text}.`
      default:
        return text
    }
  }
  switch (scheme) {
    case 'circleNumDbPlain':
    case 'circleNumWdWhitePlain':
      return circled(n, false)
    case 'circleNumWdBlackPlain':
      return circled(n, true)
    case 'arabicDbPeriod':
      return `${fullWidth(String(n))}．`
    case 'arabicDbPlain':
      return fullWidth(String(n))
    case 'ea1ChsPeriod':
    case 'ea1ChtPeriod':
    case 'ea1JpnChsDbPeriod':
    case 'ea1JpnKorPeriod':
      return `${chinese(n)}．`
    case 'ea1ChsPlain':
    case 'ea1ChtPlain':
    case 'ea1JpnKorPlain':
      return chinese(n)
    case 'arabic1Minus':
    case 'arabic2Minus':
    case 'hebrew2Minus':
      return `${n}-`
    default:
      return /Paren(Both)$/.test(scheme)
        ? `(${n})`
        : /ParenR$/.test(scheme)
          ? `${n})`
          : /Period$/.test(scheme)
            ? `${n}.`
            : String(n)
  }
}

/** 字符项目符号在符号字体中的实际码位。 */
export function symbolChar(char: string, face: TextFace): string {
  const cp = char.codePointAt(0)
  if (cp === undefined || cp < 0x20 || cp > 0xff) return char
  if (face.metrics.glyphId(cp) !== 0) return char
  const mapped = 0xf000 + cp
  return face.metrics.glyphId(mapped) !== 0 ? String.fromCodePoint(mapped) : char
}
