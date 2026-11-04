/**
 * 日期字段（`a:fld` 的 `datetime`、`datetime1`–`datetime13`）显示的文字：WPS 演示显示当前的日期与时间，不显示文件中
 * 保存的文字。日期由调用方传入（`TextSettings.date`），本模块不读取系统时钟。
 *
 * - 格式按字段的语言分组：`ja` 开头为日语，`zh-TW`、`zh-HK`、`zh-MO` 为繁体中文，其余 `zh` 开头为简体中文，其他语言与
 *   没有语言为英语。`datetime` 与 `datetime1` 相同。没有核对过的格式（繁体中文的 7 种）显示文件中保存的文字。
 * - WPS 演示实测（构造文件，2026-11-03 17:29 与 18:05）：简体中文、英语、日语各 14 种，繁体中文、韩语与没有语言各 6 种
 *   （韩语、没有语言与英语相同）。日语的和历只实现令和；简体中文与日语「时分」格式中一位数的分钟是否补零未核对。
 */

/** 显示日期字段所用的日期与时间（本地时间）。 */
export interface FieldDate {
  readonly year: number
  /** 1–12。 */
  readonly month: number
  readonly day: number
  /** 0 为星期日。 */
  readonly weekday: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

/** `Date` 的本地时间。 */
export function fieldDate(d: Date): FieldDate {
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    weekday: d.getDay(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DIGITS = '〇一二三四五六七八九'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 1–99 的汉字数字（十一、二十、三十一）。 */
function kanji(n: number): string {
  const tens = Math.floor(n / 10)
  const ones = n % 10
  const head = tens === 0 ? '' : `${tens === 1 ? '' : DIGITS[tens]}十`
  return head + (ones === 0 && tens > 0 ? '' : DIGITS[ones])
}

type Format = (d: FieldDate) => string

const zh: readonly Format[] = (() => {
  const week = (d: FieldDate) => `星期${'日一二三四五六'[d.weekday]}`
  const date = (d: FieldDate) => `${d.year}年${d.month}月${d.day}日`
  const noon = (d: FieldDate) =>
    `${d.hour < 12 ? '上午' : '下午'}${d.hour % 12 || 12}时${d.minute}分`
  return [
    (d) => `${d.year}-${d.month}-${d.day}`,
    (d) => `${d.year}-${d.month}-${d.day}`,
    date,
    (d) => date(d) + week(d),
    (d) => date(d) + week(d),
    (d) => `${d.year}/${d.month}/${d.day}`,
    (d) => `${d.year}年${d.month}月`,
    (d) => `${pad(d.year % 100)}.${d.month}.${d.day}`,
    (d) => `${date(d)}${d.hour}时${d.minute}分`,
    (d) => `${date(d)}${week(d)}${d.hour}时${d.minute}分${d.second}秒`,
    (d) => `${d.hour}:${pad(d.minute)}`,
    (d) => `${d.hour}:${pad(d.minute)}:${pad(d.second)}`,
    noon,
    (d) => `${noon(d)}${d.second}秒`,
  ]
})()

const en: readonly Format[] = (() => {
  const short = (d: FieldDate) => `${d.month}/${d.day}/${d.year}`
  const mon = (d: FieldDate) => MONTHS[d.month - 1]!
  const ampm = (d: FieldDate) => (d.hour < 12 ? 'AM' : 'PM')
  const h12 = (d: FieldDate) => d.hour % 12 || 12
  return [
    short,
    short,
    (d) => `${WEEKDAYS[d.weekday]}, ${mon(d)} ${pad(d.day)}, ${d.year}`,
    (d) => `${d.day} ${mon(d)} ${d.year}`,
    (d) => `${mon(d)} ${d.day}, ${d.year}`,
    (d) => `${d.day}-${mon(d).slice(0, 3)}-${pad(d.year % 100)}`,
    (d) => `${mon(d)} ${pad(d.year % 100)}`,
    (d) => `${mon(d).slice(0, 3)}-${pad(d.year % 100)}`,
    (d) => `${short(d)} ${h12(d)}:${pad(d.minute)} ${ampm(d)}`,
    (d) => `${short(d)} ${h12(d)}:${pad(d.minute)}:${pad(d.second)} ${ampm(d)}`,
    (d) => `${d.hour}:${pad(d.minute)}`,
    (d) => `${d.hour}:${pad(d.minute)}:${pad(d.second)}`,
    (d) => `${h12(d)}:${pad(d.minute)} ${ampm(d)}`,
    (d) => `${h12(d)}:${pad(d.minute)}:${pad(d.second)} ${ampm(d)}`,
  ]
})()

const ja: readonly Format[] = (() => {
  /** 令和元年为 2019 年。 */
  const era = (d: FieldDate) => d.year - 2018
  const date = (d: FieldDate) => `${d.year}年${d.month}月${d.day}日`
  const short = (d: FieldDate) => `${pad(d.year % 100)}/${d.month}/${d.day}`
  return [
    (d) => `${d.year}/${d.month}/${d.day}`,
    (d) => `${d.year}/${d.month}/${d.day}`,
    (d) => `${date(d)}(${'日月火水木金土'[d.weekday]})`,
    (d) => `令和${era(d)}年${d.month}月${d.day}日`,
    date,
    (d) => `${d.year}/${pad(d.month)}/${pad(d.day)}`,
    (d) => `令和${era(d)}年${d.month}月`,
    (d) => `令和${kanji(era(d))}年${kanji(d.month)}月${kanji(d.day)}日`,
    (d) => `${short(d)} ${d.hour}時${d.minute}分`,
    (d) => `${short(d)} ${d.hour}時${d.minute}分${d.second}秒`,
    (d) => `${d.hour}:${pad(d.minute)}`,
    (d) => `${d.hour}:${pad(d.minute)}:${pad(d.second)}`,
    (d) => `${d.hour}時${d.minute}分`,
    (d) => `${d.hour}時${d.minute}分${d.second}秒`,
  ]
})()

/** 繁体中文：下标为 `datetime` 的序号，未核对的格式为 `undefined`。 */
const zhTW: readonly (Format | undefined)[] = (() => {
  /** 年份逐位、月日按十进位的汉字数字（二〇二六年十一月三日）。 */
  const digits = (n: number) => [...String(n)].map((c) => DIGITS[Number(c)]).join('')
  return [
    undefined,
    (d) => `${d.year}/${d.month}/${d.day}`,
    (d) => `${d.year}年${d.month}月${d.day}日`,
    (d) => `${d.month}/${d.day}/${d.year}`,
    undefined,
    (d) => `${d.year}年${d.month}月${d.day}日星期${'日一二三四五六'[d.weekday]}`,
    undefined,
    undefined,
    (d) => `${digits(d.year)}年${kanji(d.month)}月${kanji(d.day)}日`,
    undefined,
    undefined,
    undefined,
    (d) => `${pad(d.hour % 12 || 12)}:${pad(d.minute)} ${d.hour < 12 ? '上午' : '下午'}`,
  ]
})()

const TRADITIONAL = new Set(['zh-TW', 'zh-HK', 'zh-MO'])

/** 日期字段的文字；`type` 不是日期字段或格式未核对时为 `null`。 */
export function dateFieldText(type: string, lang: string, date: FieldDate): string | null {
  const m = /^datetime(\d*)$/.exec(type)
  const index = m === null ? -1 : m[1] === '' ? 0 : Number(m[1])
  const formats = lang.startsWith('ja')
    ? ja
    : TRADITIONAL.has(lang)
      ? zhTW
      : lang.startsWith('zh')
        ? zh
        : en
  const format = formats[index]
  return format === undefined ? null : format(date)
}
