/**
 * 十进制数字串运算：数字格式的舍入与取位在十进制数字串上完成，不在二进制浮点上完成。
 *
 * Excel 先把值舍入为 15 位有效数字，再按显示位数四舍五入（逢 5 进位）。
 * 直接调用 `toFixed` 会在二进制表示上舍入：`1.005.toFixed(2)` 为 `1.00`，Excel 显示 `1.01`。
 */

/** 非负数的十进制表示：值为 `0.digits × 10^point`，即小数点位于 `digits` 第 `point` 位之前。 */
export interface Decimal {
  /** 去掉首尾 0 的有效数字；值为 0 时为空串。 */
  readonly digits: string
  readonly point: number
}

const ZERO: Decimal = { digits: '', point: 0 }

/** `x` 须为非负有限数。 */
export function toDecimal(x: number): Decimal {
  if (x === 0) return ZERO
  const s = x.toPrecision(15)
  const e = s.indexOf('e')
  const mant = e < 0 ? s : s.slice(0, e)
  const exp = e < 0 ? 0 : Number(s.slice(e + 1))
  const dot = mant.indexOf('.')
  let digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1)
  let point = (dot < 0 ? mant.length : dot) + exp
  let lead = 0
  while (lead < digits.length && digits[lead] === '0') lead++
  digits = digits.slice(lead)
  point -= lead
  let end = digits.length
  while (end > 0 && digits[end - 1] === '0') end--
  digits = digits.slice(0, end)
  return digits === '' ? ZERO : { digits, point }
}

/** 保留小数点后 `decimals` 位，第 `decimals + 1` 位逢 5 进位。 */
export function roundDecimal(d: Decimal, decimals: number): Decimal {
  const keep = d.point + decimals
  if (keep >= d.digits.length) return d
  if (keep < 0) return ZERO
  const up = d.digits.charCodeAt(keep) >= 53
  let head = d.digits.slice(0, keep)
  let point = d.point
  if (up) {
    const chars = head.split('')
    let i = chars.length - 1
    while (i >= 0 && chars[i] === '9') {
      chars[i] = '0'
      i--
    }
    if (i < 0) {
      chars.unshift('1')
      point++
    } else {
      chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1)
    }
    head = chars.join('')
  }
  let end = head.length
  while (end > 0 && head[end - 1] === '0') end--
  head = head.slice(0, end)
  return head === '' ? ZERO : { digits: head, point }
}

/** 保留 `significant` 位有效数字。 */
export function roundSignificant(d: Decimal, significant: number): Decimal {
  return roundDecimal(d, significant - d.point)
}

/**
 * 定点表示：`int` 为不带前导 0 的整数部分（值小于 1 时为空串），`frac` 恰为 `decimals` 位。
 */
export function fixedParts(x: number, decimals: number): { int: string; frac: string } {
  const d = roundDecimal(toDecimal(x), decimals)
  if (d.digits === '') return { int: '', frac: '0'.repeat(decimals) }
  const int =
    d.point <= 0
      ? ''
      : d.point >= d.digits.length
        ? d.digits + '0'.repeat(d.point - d.digits.length)
        : d.digits.slice(0, d.point)
  const fracDigits =
    d.point >= 0
      ? d.digits.slice(Math.min(d.point, d.digits.length))
      : '0'.repeat(-d.point) + d.digits
  return { int, frac: fracDigits.padEnd(decimals, '0').slice(0, decimals) }
}
