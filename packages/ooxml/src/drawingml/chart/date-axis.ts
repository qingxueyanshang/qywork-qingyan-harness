/**
 * 日期轴：分类为日期序列号时，按基本单位（日、月、年）把分类轴等分为若干单位，数据点落在其日期所在的单位上。
 * 规则取自 WPS 对照图（校准文件实测）：
 *
 * - 基本单位未指定时按数据：全部日期的月与日相同为年，日相同为月，否则为日。
 * - 单位数 = 最晚日期与最早日期相差的单位数 + 1；没有数据的单位留空。
 * - 标签从最早日期起每隔主要单位一个（按月、年步进时取同一日，超出当月天数时取月末）。
 * - 主要单位未指定时，按候选单位依次取第一个使相邻标签间距不小于 `fit` 的单位。候选为实测出现过的单位：
 *   基本单位为日时 1、2、7 日与 1、2、3、6 个月，为月时 1、2、3、5 个月，为年时 1、2、3 年；其后按 {1, 2, 5} × 10ⁿ 年。
 *   超出实测范围的候选（日为基本单位时 3 个月以上，月为基本单位时 1 年以上，年为基本单位时 5 年以上）未经核对。
 */

import { dateParts } from '../../numfmt/date.ts'
import { compileFormat } from '../../numfmt/format.ts'

export type TimeUnit = 'days' | 'months' | 'years'

export interface DateStep {
  readonly count: number
  readonly unit: TimeUnit
}

/** 日期轴的排列：`origin` 为最早日期（整数序列号），`slots` 为单位数。 */
export interface DateScale {
  readonly base: TimeUnit
  readonly origin: number
  readonly slots: number
  readonly date1904: boolean
}

const DAY_MS = 86_400_000
/** 一个月、一年的平均天数：按月、年步进的标签间距按此估算。 */
const DAYS: Readonly<Record<TimeUnit, number>> = { days: 1, months: 30.44, years: 365.25 }

const CANDIDATES: Readonly<Record<TimeUnit, readonly DateStep[]>> = {
  days: [
    { count: 1, unit: 'days' },
    { count: 2, unit: 'days' },
    { count: 7, unit: 'days' },
    { count: 1, unit: 'months' },
    { count: 2, unit: 'months' },
    { count: 3, unit: 'months' },
    { count: 6, unit: 'months' },
  ],
  months: [
    { count: 1, unit: 'months' },
    { count: 2, unit: 'months' },
    { count: 3, unit: 'months' },
    { count: 5, unit: 'months' },
  ],
  years: [
    { count: 1, unit: 'years' },
    { count: 2, unit: 'years' },
    { count: 3, unit: 'years' },
  ],
}

/** 格式代码含日期或时间部分。 */
export function isDateFormat(code: string): boolean {
  return compileFormat(code).date
}

function parts(serial: number, date1904: boolean): { year: number; month: number; day: number } {
  return dateParts(Math.floor(serial), date1904, 0) ?? { year: 1900, month: 1, day: 1 }
}

function serialOf(year: number, month: number, day: number, date1904: boolean): number {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  return Math.round((Date.UTC(year, month - 1, day) - base) / DAY_MS)
}

/** 基本单位未指定时按数据推定：见文件头。 */
export function autoBase(serials: readonly number[], date1904: boolean): TimeUnit {
  if (serials.length === 0) return 'days'
  const all = serials.map((s) => parts(s, date1904))
  const first = all[0]!
  if (all.every((p) => p.day === first.day && p.month === first.month)) return 'years'
  if (all.every((p) => p.day === first.day)) return 'months'
  return 'days'
}

/** `serial` 距 `origin` 的单位数（向下取整）。 */
export function unitIndex(serial: number, s: DateScale): number {
  if (s.base === 'days') return Math.floor(serial) - s.origin
  const a = parts(serial, s.date1904)
  const o = parts(s.origin, s.date1904)
  return s.base === 'years' ? a.year - o.year : (a.year - o.year) * 12 + (a.month - o.month)
}

export function dateScale(
  serials: readonly number[],
  base: TimeUnit,
  date1904: boolean,
): DateScale {
  const origin = Math.floor(Math.min(...serials))
  const s: DateScale = { base, origin, slots: 1, date1904 }
  return { ...s, slots: unitIndex(Math.max(...serials), s) + 1 }
}

/** 从 `origin` 起第 `k` 个步长的日期（序列号）。 */
function stepDate(s: DateScale, step: DateStep, k: number): number {
  if (step.unit === 'days') return s.origin + k * step.count
  const o = parts(s.origin, s.date1904)
  const months = (step.unit === 'years' ? 12 : 1) * step.count * k
  const year = o.year + Math.floor((o.month - 1 + months) / 12)
  const month = ((o.month - 1 + months) % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return serialOf(year, month, Math.min(o.day, last), s.date1904)
}

/** 标签日期与所在单位下标，按日期顺序，不超出最后一个单位。 */
export function dateLabels(s: DateScale, step: DateStep): { serial: number; slot: number }[] {
  const out: { serial: number; slot: number }[] = []
  for (let k = 0; k <= s.slots; k++) {
    const serial = stepDate(s, step, k)
    const slot = unitIndex(serial, s)
    if (slot >= s.slots) break
    out.push({ serial, slot })
  }
  return out
}

/** 主要单位未指定时的步长：`band` 为一个基本单位的像素宽度，`fit` 为相邻标签间距的下限。 */
export function autoStep(s: DateScale, band: number, fit: number): DateStep {
  const list = CANDIDATES[s.base]
  for (const step of list) {
    if ((step.count * DAYS[step.unit] * band) / DAYS[s.base] >= fit) return step
  }
  // 候选之后按 {1, 2, 5} × 10ⁿ 年。
  let last: DateStep = list.at(-1)!
  for (let exp = 0; exp < 7; exp++) {
    for (const c of [1, 2, 5]) {
      last = { count: c * 10 ** exp, unit: 'years' }
      if (s.base === 'years' && last.count <= 3) continue
      if ((last.count * DAYS.years * band) / DAYS[s.base] >= fit) return last
    }
  }
  return last
}
