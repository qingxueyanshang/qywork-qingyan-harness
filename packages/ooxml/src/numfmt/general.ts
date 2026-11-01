/**
 * 「常规」格式下数字的显示文本。
 *
 * 默认列宽下最多显示 11 个字符（不计负号）：整数超过 11 位或绝对值小于 0.0001 时改用科学计数，
 * 小数位数按剩余字符数舍入并去掉末尾的 0。列宽不足时 `generalFit` 依次减少字符数，
 * 先减少小数位，再改用科学计数；仍无法容纳时返回 `null`，调用方显示 `#`。
 */

import { type Decimal, roundDecimal, roundSignificant, toDecimal } from './decimal.ts'

const MAX_CHARS = 11

function fixed(d: Decimal, decimals: number): string {
  const r = roundDecimal(d, decimals)
  if (r.digits === '') return '0'
  const int = r.point <= 0 ? '0' : r.digits.slice(0, r.point).padEnd(r.point, '0')
  const frac = r.point >= 0 ? r.digits.slice(r.point) : '0'.repeat(-r.point) + r.digits
  return frac === '' ? int : `${int}.${frac}`
}

function scientific(d: Decimal, maxChars: number): string | null {
  // 尾数一位整数；指数至少两位。
  let exp = d.point - 1
  for (let decimals = Math.max(0, maxChars - 6); decimals >= 0; decimals--) {
    const r = roundSignificant(d, decimals + 1)
    exp = r.point - 1
    const mant = r.digits[0] ?? '0'
    const rest = r.digits.slice(1, decimals + 1)
    const expText = `E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
    const text = (rest === '' ? mant : `${mant}.${rest}`) + expText
    if (text.length <= maxChars) return text
  }
  return null
}

/** 绝对值的常规文本，最多 `maxChars` 个字符；无法放下时返回 `null`。 */
function generalAbs(x: number, maxChars: number): string | null {
  if (x === 0) return '0'
  const d = toDecimal(x)
  const exp = d.point - 1
  if (exp >= -4 && exp < MAX_CHARS) {
    const intDigits = Math.max(1, d.point)
    if (intDigits <= maxChars) {
      const decimals = Math.max(0, maxChars - intDigits - 1)
      const text = fixed(d, decimals)
      // 舍入进位可使整数位增加（9.99… → 10），超出时改用科学计数。
      if (text.length <= maxChars && text !== '0') return text
    }
  }
  return scientific(d, maxChars)
}

export function generalNumber(value: number): string {
  const text = generalAbs(Math.abs(value), MAX_CHARS) ?? '0'
  return value < 0 ? `-${text}` : text
}

/**
 * 按可用宽度选取常规文本：`fits` 判断文本能否放入单元格。全部候选都无法容纳时返回 `null`。
 */
export function generalFit(value: number, fits: (text: string) => boolean): string | null {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  for (let chars = MAX_CHARS; chars >= 1; chars--) {
    const text = generalAbs(abs, chars)
    if (text === null) continue
    if (fits(sign + text)) return sign + text
  }
  return null
}
