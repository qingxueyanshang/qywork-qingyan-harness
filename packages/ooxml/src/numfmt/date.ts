/**
 * 日期序列号换算为年月日时分秒。
 *
 * - 1900 日期系统：序列号 1 为 1900-01-01，60 为不存在的 1900-02-29（与 Excel 一致），0 显示为 1900-01-00。
 * - 1904 日期系统：序列号 0 为 1904-01-01。
 * - 全程使用 UTC 运算：本地时区在 1900 年前后的历史偏移会使整数天落到前一天。
 */

export interface DateParts {
  readonly year: number
  readonly month: number
  readonly day: number
  /** 0 为星期日。 */
  readonly weekday: number
  readonly hours: number
  readonly minutes: number
  readonly seconds: number
  /** 秒的小数部分，按 `subsecondDigits` 位取整后的整数。 */
  readonly subseconds: number
  /** 自序列号 0 起的总秒数（不含小数部分），供 `[h]`、`[m]`、`[s]` 使用。 */
  readonly totalSeconds: number
}

const DAY_MS = 86_400_000
const MAX_1900 = 2_958_465
const MAX_1904 = 2_957_003

/**
 * 先按显示的秒精度舍入，再拆分各部分：23:59:59.6 在不显示小数秒时进位为次日 0:00:00。
 * 负数与超过 9999-12-31 的序列号返回 `null`，调用方按无法显示处理。
 */
export function dateParts(
  serial: number,
  date1904: boolean,
  subsecondDigits: number,
): DateParts | null {
  if (!Number.isFinite(serial) || serial < 0) return null
  const scale = 10 ** subsecondDigits
  const unit = 86_400 * scale
  const total = Math.round(serial * unit)
  const days = Math.floor(total / unit)
  if (days > (date1904 ? MAX_1904 : MAX_1900)) return null
  const rest = total - days * unit
  const secondsOfDay = Math.floor(rest / scale)
  const subseconds = rest - secondsOfDay * scale
  const time = {
    hours: Math.floor(secondsOfDay / 3600),
    minutes: Math.floor((secondsOfDay % 3600) / 60),
    seconds: secondsOfDay % 60,
    subseconds,
    totalSeconds: days * 86_400 + secondsOfDay,
  }
  if (date1904) {
    const d = new Date(Date.UTC(1904, 0, 1) + days * DAY_MS)
    return { ...ymd(d), weekday: (days + 5) % 7, ...time }
  }
  const weekday = (days + 6) % 7
  if (days === 0) return { year: 1900, month: 1, day: 0, weekday, ...time }
  if (days === 60) return { year: 1900, month: 2, day: 29, weekday, ...time }
  const base = days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30)
  return { ...ymd(new Date(base + days * DAY_MS)), weekday, ...time }
}

function ymd(d: Date): { year: number; month: number; day: number } {
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** ISO 8601 日期时间文本（单元格类型 `d`）换算为序列号；无法解析时返回 `null`。 */
export function serialFromIso(text: string, date1904: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?/.exec(
    text.trim(),
  )
  if (!m) return null
  const ms = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
    Math.round(Number(m[7] ?? 0) * 1000),
  )
  if (date1904) return (ms - Date.UTC(1904, 0, 1)) / DAY_MS
  const serial = (ms - Date.UTC(1899, 11, 30)) / DAY_MS
  // 1900-03-01 之前的日期需扣除不存在的 1900-02-29。
  return serial < 61 ? serial - 1 : serial
}
