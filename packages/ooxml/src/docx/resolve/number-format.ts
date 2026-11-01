/**
 * 编号格式（`numFmt`）：把计数值转换为编号文字。各格式的取值与 WPS 12.1 逐项实测结果一致。
 *
 * - 中文计数（`chineseCounting` 等六种）：零写作「〇」，连续的零只写一个，末尾的零不写；首位为「一十」时省去「一」
 *   （10 为「十」，110 为「一百一十」）。`ideographDigital` 在 WPS 中同样按中文计数显示，不逐位转写。
 * - 大写数字（`chineseLegalSimplified` 等三种）：零写作「零」，不省去「壹」（10 为「壹拾」）。
 * - 日文计数（`japaneseCounting`）：不写零，「十」「百」「千」之前不写「一」。
 * - 罗马数字只用于 1 至 1000，带圈、带括号与天干地支只用于各自字符的范围，超出范围时按十进制显示。
 * - 字母编号为双射二十六进制（27 为 `AA`，53 为 `BA`）。
 * - `chicago`、`koreanCounting`、`ganada`、`chosung`、`russianLower` 在 WPS 中按中文计数显示，此处相同。
 *   其余未列出的格式返回 `null`，由调用方计数并按中文计数显示。
 */

const CHINESE_DIGITS = '〇一二三四五六七八九'
const LEGAL_DIGITS = '零壹贰叁肆伍陆柒捌玖'
const CHINESE_UNITS = ['', '十', '百', '千']
const LEGAL_UNITS = ['', '拾', '佰', '仟']
const GROUP_UNITS = ['', '万', '亿']
const ROMAN: readonly (readonly [number, string])[] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]
const STEMS = '甲乙丙丁戊己庚辛壬癸'
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥'
/** 中文计数可表示的上限（亿位为四位）。 */
const COUNTING_LIMIT = 1e12

interface Counting {
  readonly digits: string
  readonly units: readonly string[]
  /** 不写零（日文计数）。 */
  readonly noZero: boolean
  /** 「十」「百」「千」之前的「一」：`all` 都写，`leadingTen` 只省去首位「一十」的「一」，`never` 都不写。 */
  readonly one: 'all' | 'leadingTen' | 'never'
}

const CHINESE: Counting = {
  digits: CHINESE_DIGITS,
  units: CHINESE_UNITS,
  noZero: false,
  one: 'leadingTen',
}
const LEGAL: Counting = { digits: LEGAL_DIGITS, units: LEGAL_UNITS, noZero: false, one: 'all' }
const JAPANESE: Counting = {
  digits: CHINESE_DIGITS,
  units: CHINESE_UNITS,
  noZero: true,
  one: 'never',
}

function counting(n: number, c: Counting): string {
  if (n <= 0 || n >= COUNTING_LIMIT) return String(n)
  const groups: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 10000)) groups.push(v % 10000)
  let out = ''
  let zero = false
  for (let g = groups.length - 1; g >= 0; g--) {
    const value = groups[g]!
    if (value === 0) {
      if (out !== '') zero = true
      continue
    }
    for (let p = 3; p >= 0; p--) {
      const d = Math.floor(value / 10 ** p) % 10
      if (d === 0) {
        if (out !== '') zero = true
        continue
      }
      if (zero && !c.noZero) out += c.digits[0]
      zero = false
      if (!(d === 1 && p > 0 && c.one === 'never')) out += c.digits[d]
      out += c.units[p]
    }
    out += GROUP_UNITS[g]
  }
  if (c.one === 'leadingTen' && out.startsWith(`${c.digits[1]}${c.units[1]}`)) out = out.slice(1)
  return out
}

function roman(n: number): string {
  if (n < 1 || n > 1000) return String(n)
  let out = ''
  let v = n
  for (const [value, symbol] of ROMAN) {
    while (v >= value) {
      out += symbol
      v -= value
    }
  }
  return out
}

function letters(n: number): string {
  if (n < 1) return String(n)
  let out = ''
  for (let v = n; v > 0; v = Math.floor((v - 1) / 26)) {
    out = String.fromCharCode(65 + ((v - 1) % 26)) + out
  }
  return out
}

function ordinal(n: number): string {
  const tens = n % 100
  const ones = n % 10
  const suffix =
    tens >= 11 && tens <= 13
      ? 'th'
      : ones === 1
        ? 'st'
        : ones === 2
          ? 'nd'
          : ones === 3
            ? 'rd'
            : 'th'
  return `${n}${suffix}`
}

/** `first` 为 1 对应的字符；超出 `count` 个时按十进制。 */
function enclosed(n: number, first: number, count: number): string {
  return n >= 1 && n <= count ? String.fromCodePoint(first + n - 1) : String(n)
}

function fromList(n: number, list: string): string {
  return n >= 1 && n <= list.length ? list[n - 1]! : String(n)
}

function fullWidth(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d)))
}

const FORMATS: Readonly<Record<string, (n: number) => string>> = {
  decimal: String,
  decimalHalfWidth: String,
  decimalZero: (n) => (n >= 0 && n < 10 ? `0${n}` : String(n)),
  upperRoman: roman,
  lowerRoman: (n) => roman(n).toLowerCase(),
  upperLetter: letters,
  lowerLetter: (n) => letters(n).toLowerCase(),
  ordinal,
  decimalEnclosedCircle: (n) => enclosed(n, 0x2460, 20),
  decimalEnclosedCircleChinese: (n) => enclosed(n, 0x2460, 20),
  decimalEnclosedFullstop: (n) => enclosed(n, 0x2488, 20),
  decimalEnclosedParen: (n) => enclosed(n, 0x2474, 20),
  ideographEnclosedCircle: (n) => enclosed(n, 0x3220, 10),
  ideographTraditional: (n) => fromList(n, STEMS),
  ideographZodiac: (n) => fromList(n, BRANCHES),
  decimalFullWidth: fullWidth,
  decimalFullWidth2: fullWidth,
  hex: (n) => n.toString(16).toUpperCase(),
  numberInDash: (n) => `- ${n} -`,
  none: () => '',
  bullet: String,
  chineseCounting: (n) => counting(n, CHINESE),
  chineseCountingThousand: (n) => counting(n, CHINESE),
  ideographDigital: (n) => counting(n, CHINESE),
  taiwaneseCounting: (n) => counting(n, CHINESE),
  taiwaneseCountingThousand: (n) => counting(n, CHINESE),
  japaneseDigitalTenThousand: (n) => counting(n, CHINESE),
  chicago: (n) => counting(n, CHINESE),
  koreanCounting: (n) => counting(n, CHINESE),
  ganada: (n) => counting(n, CHINESE),
  chosung: (n) => counting(n, CHINESE),
  russianLower: (n) => counting(n, CHINESE),
  chineseLegalSimplified: (n) => counting(n, LEGAL),
  ideographLegalTraditional: (n) => counting(n, LEGAL),
  taiwaneseDigital: (n) => counting(n, LEGAL),
  japaneseCounting: (n) => counting(n, JAPANESE),
}

/** 未实现的格式返回 `null`。 */
export function formatNumber(value: number, format: string): string | null {
  const f = FORMATS[format]
  return f === undefined ? null : f(value)
}

/** 未实现格式的显示：WPS 对其不支持的格式按中文计数显示。 */
export function fallbackNumber(value: number): string {
  return counting(value, CHINESE)
}
