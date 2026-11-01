/**
 * Excel 数字格式：编译格式代码并格式化单元格值。
 *
 * 支持：最多四节（正数;负数;零;文本）与条件节（`[>100]`）；颜色（`[Red]`、`[Color10]`）；
 * `0 # ?` 占位、千分位与按千缩放的逗号、百分号、科学计数、分数；`@` 文本占位；
 * 引号文本、`\` 转义、`_x` 留出字符宽度、`*x` 重复填满；日期时间（含 `[h]` 等累计时间、小数秒、
 * `AM/PM`、`上午/下午`、`aaa`/`aaaa` 中文星期）；`[$…-xxx]` 货币符号与区域代码（`F800` 长日期、
 * `F400` 时间、中文区域的月份与星期名）；`[DBNum1]`、`[DBNum2]`、`[DBNum3]` 中文数字。
 *
 * 输出按片段返回：`gap` 与 `fill` 的宽度依赖字体与单元格宽度，由绘制层计算。
 */

import { builtinFormat } from './builtin.ts'
import { dateParts } from './date.ts'
import { fixedParts, toDecimal } from './decimal.ts'
import { generalNumber } from './general.ts'

export interface FormatPart {
  /** `text` 原样显示；`gap` 留出与 `text` 中字符等宽的空白；`fill` 以 `text` 重复填满剩余宽度。 */
  readonly kind: 'text' | 'gap' | 'fill'
  readonly text: string
}

export interface FormattedValue {
  readonly parts: readonly FormatPart[]
  /** 格式节指定的文字颜色，`null` 为不指定。 */
  readonly color: string | null
  /** 值无法按该格式显示（负数日期、超出范围的日期），调用方以 `#` 填满单元格。 */
  readonly invalid: boolean
}

export interface FormatOptions {
  readonly date1904: boolean
  /** 索引色调色板，`[ColorN]` 取第 `N + 7` 项。 */
  readonly palette: readonly string[]
}

type Token =
  | { readonly t: 'lit' | 'gap' | 'fill'; readonly s: string }
  | { readonly t: 'digit'; readonly s: '0' | '#' | '?' }
  | { readonly t: 'point' | 'comma' | 'percent' | 'slash' | 'text' | 'general' }
  | { readonly t: 'exp'; readonly sign: '+' | '-' }
  | { readonly t: 'date'; readonly s: string }
  | { readonly t: 'elapsed'; readonly unit: 'h' | 'm' | 's'; readonly width: number }
  | { readonly t: 'subsec'; readonly width: number }

interface Condition {
  readonly op: '<' | '>' | '=' | '<=' | '>=' | '<>'
  readonly value: number
}

interface Section {
  readonly tokens: readonly Token[]
  readonly kind: 'number' | 'date' | 'text'
  readonly color: string | null
  readonly colorIndex: number | null
  readonly condition: Condition | null
  /** 中文区域代码（804 等）：月份与星期名改用中文。 */
  readonly chinese: boolean
  readonly dbnum: 0 | 1 | 2 | 3
}

export interface CompiledFormat {
  readonly code: string
  /** 整个格式为「常规」：数字显示随列宽调整（见 `general.ts`）。 */
  readonly general: boolean
  /** 含日期或时间节：「常规」对齐时按数字右对齐，宽度不足时显示 `#`。 */
  readonly date: boolean
  readonly sections: readonly Section[]
}

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  white: '#ffffff',
  yellow: '#ffff00',
}

const CHINESE_LOCALES = new Set([0x4, 0x804, 0x404, 0xc04, 0x1004, 0x1404, 0x7804, 0x7c04])
const LONG_DATE = 'yyyy"年"m"月"d"日"'
const LONG_TIME = 'h:mm:ss'

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
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const CN_DIGITS = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']
const CN_WEEK = ['日', '一', '二', '三', '四', '五', '六']

/** 按数字格式编号取得格式代码：`styles.xml` 中的自定义格式优先，其次是内置格式。 */
export function formatCodeFor(id: number, custom: ReadonlyMap<number, string>): string {
  return custom.get(id) ?? builtinFormat(id) ?? 'General'
}

const cache = new Map<string, CompiledFormat>()

export function compileFormat(code: string): CompiledFormat {
  let compiled = cache.get(code)
  if (!compiled) {
    compiled = compile(code)
    cache.set(code, compiled)
  }
  return compiled
}

function compile(code: string): CompiledFormat {
  const trimmed = code.trim()
  if (trimmed === '' || /^general$/i.test(trimmed)) {
    const section = makeSection([{ t: 'general' }], null, null, null, false, 0)
    return { code, general: true, date: false, sections: [section] }
  }
  const sections = splitSections(code).map(compileSection)
  return { code, general: false, date: sections.some((s) => s.kind === 'date'), sections }
}

function splitSections(code: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (ch === '"') {
      const end = code.indexOf('"', i + 1)
      const stop = end < 0 ? code.length : end + 1
      cur += code.slice(i, stop)
      i = stop - 1
    } else if (ch === '\\' || ch === '_' || ch === '*') {
      cur += code.slice(i, i + 2)
      i++
    } else if (ch === '[') {
      const end = code.indexOf(']', i)
      const stop = end < 0 ? code.length : end + 1
      cur += code.slice(i, stop)
      i = stop - 1
    } else if (ch === ';') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function makeSection(
  tokens: Token[],
  color: string | null,
  colorIndex: number | null,
  condition: Condition | null,
  chinese: boolean,
  dbnum: 0 | 1 | 2 | 3,
): Section {
  const isDate = tokens.some((t) => t.t === 'date' || t.t === 'elapsed')
  const isText = !isDate && tokens.some((t) => t.t === 'text')
  return {
    tokens,
    kind: isDate ? 'date' : isText ? 'text' : 'number',
    color,
    colorIndex,
    condition,
    chinese,
    dbnum,
  }
}

function compileSection(src: string): Section {
  const tokens: Token[] = []
  let color: string | null = null
  let colorIndex: number | null = null
  let condition: Condition | null = null
  let chinese = false
  let dbnum: 0 | 1 | 2 | 3 = 0
  // 系统长日期、系统时间：节内其余代码不再生效，整节按系统格式显示。
  let system: string | null = null
  const lower = src.toLowerCase()
  let i = 0
  const lit = (s: string) => {
    const last = tokens[tokens.length - 1]
    if (last && last.t === 'lit') tokens[tokens.length - 1] = { t: 'lit', s: last.s + s }
    else tokens.push({ t: 'lit', s })
  }
  while (i < src.length) {
    const ch = src[i]!
    const lc = lower[i]!
    if (ch === '"') {
      const end = src.indexOf('"', i + 1)
      const stop = end < 0 ? src.length : end
      lit(src.slice(i + 1, stop))
      i = stop + 1
      continue
    }
    if (ch === '\\') {
      if (i + 1 < src.length) lit(src[i + 1]!)
      i += 2
      continue
    }
    if (ch === '_') {
      if (i + 1 < src.length) tokens.push({ t: 'gap', s: src[i + 1]! })
      i += 2
      continue
    }
    if (ch === '*') {
      if (i + 1 < src.length) tokens.push({ t: 'fill', s: src[i + 1]! })
      i += 2
      continue
    }
    if (ch === '[') {
      const end = src.indexOf(']', i)
      const body = src.slice(i + 1, end < 0 ? src.length : end)
      i = end < 0 ? src.length : end + 1
      const b = body.toLowerCase()
      const cond = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+(?:e[+-]?\d+)?)$/.exec(b)
      if (b in NAMED_COLORS) color = NAMED_COLORS[b]!
      else if (/^color\s*\d+$/.test(b)) colorIndex = Number(b.replace(/\D/g, ''))
      else if (cond) condition = { op: cond[1] as Condition['op'], value: Number(cond[2]) }
      else if (/^(h+|m+|s+)$/.test(b)) {
        tokens.push({ t: 'elapsed', unit: b[0] as 'h' | 'm' | 's', width: b.length })
      } else if (/^dbnum[123]$/.test(b)) dbnum = Number(b[5]) as 1 | 2 | 3
      else if (b === '$-x-sysdate' || b === '$-x-systime') {
        system = b.endsWith('date') ? LONG_DATE : LONG_TIME
      } else if (b.startsWith('$')) {
        const dash = body.lastIndexOf('-')
        const symbol = dash > 0 ? body.slice(1, dash) : body.slice(1)
        const locale = dash > 0 ? Number.parseInt(body.slice(dash + 1), 16) : Number.NaN
        if (symbol) lit(symbol)
        const lang = Number.isNaN(locale) ? 0 : locale & 0xffff
        if (lang === 0xf800) system = LONG_DATE
        else if (lang === 0xf400) system = LONG_TIME
        else if (CHINESE_LOCALES.has(lang)) chinese = true
      }
      continue
    }
    if (lower.startsWith('general', i)) {
      tokens.push({ t: 'general' })
      i += 7
      continue
    }
    if (lower.startsWith('am/pm', i)) {
      tokens.push({ t: 'date', s: src[i] === 'a' ? 'am/pm' : 'AM/PM' })
      i += 5
      continue
    }
    if (lower.startsWith('a/p', i)) {
      tokens.push({ t: 'date', s: src[i] === 'a' ? 'a/p' : 'A/P' })
      i += 3
      continue
    }
    if (src.startsWith('上午/下午', i)) {
      tokens.push({ t: 'date', s: '上午/下午' })
      i += 5
      continue
    }
    if (lc === 'a' && lower.startsWith('aaa', i)) {
      const n = runLength(lower, i, 'a')
      tokens.push({ t: 'date', s: n >= 4 ? 'aaaa' : 'aaa' })
      i += n
      continue
    }
    if (lc === 'y' || lc === 'm' || lc === 'd' || lc === 'h' || lc === 's') {
      const n = runLength(lower, i, lc)
      tokens.push({ t: 'date', s: lc.repeat(n) })
      i += n
      continue
    }
    if (lc === 'e' && (src[i + 1] === '+' || src[i + 1] === '-')) {
      tokens.push({ t: 'exp', sign: src[i + 1] as '+' | '-' })
      i += 2
      continue
    }
    if (ch === '0' || ch === '#' || ch === '?') {
      tokens.push({ t: 'digit', s: ch })
      i++
      continue
    }
    if (ch === '.') {
      // 秒之后的 `.0`、`.00`、`.000` 为小数秒。
      const prev = lastDateToken(tokens)
      if (prev && (prev.startsWith('s') || prev === 'elapsed-s') && src[i + 1] === '0') {
        const n = runLength(src, i + 1, '0')
        tokens.push({ t: 'subsec', width: Math.min(n, 3) })
        i += 1 + n
        continue
      }
      tokens.push({ t: 'point' })
      i++
      continue
    }
    if (ch === ',') tokens.push({ t: 'comma' })
    else if (ch === '%') tokens.push({ t: 'percent' })
    else if (ch === '/') tokens.push({ t: 'slash' })
    else if (ch === '@') tokens.push({ t: 'text' })
    else lit(ch)
    i++
  }
  if (system !== null) {
    const base = compileSection(system)
    return { ...base, color, colorIndex, condition }
  }
  const section = makeSection(tokens, color, colorIndex, condition, chinese, dbnum)
  return section.kind === 'date' ? { ...section, tokens: resolveMinutes(tokens) } : section
}

function runLength(s: string, at: number, ch: string): number {
  let n = 0
  while (s[at + n] === ch) n++
  return n
}

function lastDateToken(tokens: readonly Token[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!
    if (t.t === 'date') return t.s
    if (t.t === 'elapsed') return `elapsed-${t.unit}`
    if (t.t === 'digit') return null
  }
  return null
}

/**
 * `m` 与 `mm` 紧跟在小时之后或紧接在秒之前时表示分钟，否则表示月份。
 * 「紧跟」只看相邻的日期时间代码，中间的分隔符不计。分钟改写为 `M` 与 `MM`。
 */
function resolveMinutes(tokens: Token[]): Token[] {
  const out = [...tokens]
  const dateIdx = out.flatMap((t, i) => (t.t === 'date' || t.t === 'elapsed' ? [i] : []))
  for (let k = 0; k < dateIdx.length; k++) {
    const t = out[dateIdx[k]!]!
    if (t.t !== 'date' || !/^m{1,2}$/.test(t.s)) continue
    const prev = k > 0 ? out[dateIdx[k - 1]!]! : null
    const next = k + 1 < dateIdx.length ? out[dateIdx[k + 1]!]! : null
    const afterHour =
      prev !== null &&
      ((prev.t === 'date' && prev.s.startsWith('h')) || (prev.t === 'elapsed' && prev.unit === 'h'))
    const beforeSecond =
      next !== null &&
      ((next.t === 'date' && next.s.startsWith('s')) || (next.t === 'elapsed' && next.unit === 's'))
    if (afterHour || beforeSecond) out[dateIdx[k]!] = { t: 'date', s: t.s.toUpperCase() }
  }
  return out
}

function matches(c: Condition, v: number): boolean {
  switch (c.op) {
    case '<':
      return v < c.value
    case '>':
      return v > c.value
    case '=':
      return v === c.value
    case '<=':
      return v <= c.value
    case '>=':
      return v >= c.value
    case '<>':
      return v !== c.value
  }
}

/**
 * 选取数字使用的节，并给出该节显示的值是否带负号。
 *
 * 没有条件时：一节适用于全部数字，负数加负号；两节时第二节用于负数；三节时第三节用于零。
 * 负数节显示绝对值，负号由格式自身的字面量给出。
 * 有条件时按节的顺序判定条件，没有条件的节承接其余数字；只接受负数的条件节（`[<0]`）显示绝对值，
 * 其余节显示带符号的值。
 */
function pickNumberSection(f: CompiledFormat, v: number): { section: Section; signed: boolean } {
  const numeric = f.sections.filter((s, i) => i < 3 && !(s.kind === 'text' && i > 0))
  if (numeric.some((s) => s.condition !== null)) {
    for (const s of numeric) {
      const c = s.condition
      if (c && !matches(c, v)) continue
      const negativeOnly = c !== null && (c.op === '<' || c.op === '<=') && c.value <= 0
      return { section: s, signed: v < 0 && !negativeOnly }
    }
    return { section: numeric[numeric.length - 1]!, signed: v < 0 }
  }
  const [pos, neg, zero] = numeric
  if (!neg || !pos) return { section: pos ?? f.sections[0]!, signed: true }
  if (v < 0) return { section: neg, signed: false }
  if (v === 0 && zero) return { section: zero, signed: false }
  return { section: pos, signed: false }
}

function sectionColor(s: Section, options: FormatOptions): string | null {
  if (s.color) return s.color
  if (s.colorIndex !== null) return options.palette[s.colorIndex + 7] ?? null
  return null
}

export function formatNumber(value: number, code: string, options: FormatOptions): FormattedValue {
  const f = compileFormat(code)
  const { section, signed } = pickNumberSection(f, value)
  const color = sectionColor(section, options)
  if (section.kind === 'date') {
    const parts = formatDate(section, value, options.date1904)
    return parts ? { parts, color, invalid: false } : { parts: [], color, invalid: true }
  }
  if (section.kind === 'text') {
    // 只有文本节的格式按常规显示数字。
    return { parts: [{ kind: 'text', text: generalNumber(value) }], color, invalid: false }
  }
  const parts = formatNumberSection(section, signed ? value : Math.abs(value), signed)
  return { parts, color, invalid: false }
}

export function formatText(text: string, code: string, options: FormatOptions): FormattedValue {
  const f = compileFormat(code)
  const section = f.sections[3] ?? f.sections.find((s) => s.kind === 'text')
  if (!section) return { parts: [{ kind: 'text', text }], color: null, invalid: false }
  const parts: FormatPart[] = []
  for (const t of section.tokens) {
    if (t.t === 'text') parts.push({ kind: 'text', text })
    else if (t.t === 'lit') parts.push({ kind: 'text', text: t.s })
    else if (t.t === 'gap' || t.t === 'fill') parts.push({ kind: t.t, text: t.s })
  }
  return { parts: mergeText(parts), color: sectionColor(section, options), invalid: false }
}

/** 片段拼成纯文本：`gap` 记为一个空格，`fill` 不计。供比对与测试使用。 */
export function plainText(v: FormattedValue): string {
  let out = ''
  for (const p of v.parts) {
    if (p.kind === 'text') out += p.text
    else if (p.kind === 'gap') out += ' '
  }
  return out
}

function mergeText(parts: FormatPart[]): FormatPart[] {
  const out: FormatPart[] = []
  for (const p of parts) {
    const last = out[out.length - 1]
    if (p.kind === 'text' && last && last.kind === 'text') {
      out[out.length - 1] = { kind: 'text', text: last.text + p.text }
    } else if (p.kind !== 'text' || p.text !== '') {
      out.push(p)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 数字节

interface NumberLayout {
  intDigits: number
  decDigits: number
  grouping: boolean
  scale: number
  percent: number
  exp: number
  fraction: { slash: number } | null
}

function analyze(tokens: readonly Token[]): NumberLayout {
  const expAt = tokens.findIndex((t) => t.t === 'exp')
  const end = expAt < 0 ? tokens.length : expAt
  let pointAt = -1
  for (let i = 0; i < end; i++) {
    if (tokens[i]!.t === 'point') {
      pointAt = i
      break
    }
  }
  const slash = findFractionSlash(tokens)
  const intEnd = pointAt < 0 ? end : pointAt
  let intDigits = 0
  let decDigits = 0
  for (let i = 0; i < end; i++) {
    if (tokens[i]!.t !== 'digit') continue
    if (i < intEnd) intDigits++
    else decDigits++
  }
  // 逗号两侧都有数字占位为千分位；最后一个占位之后的逗号每个缩小 1000 倍。
  let grouping = false
  let scale = 0
  for (let i = 0; i < end; i++) {
    if (tokens[i]!.t !== 'comma') continue
    const before = tokens.slice(0, i).some((t) => t.t === 'digit')
    const after = tokens.slice(i + 1, intEnd).some((t) => t.t === 'digit')
    if (before && after && i < intEnd) grouping = true
    else if (before && !tokens.slice(i + 1, end).some((t) => t.t === 'digit')) scale++
  }
  const percent = tokens.filter((t) => t.t === 'percent').length
  return {
    intDigits,
    decDigits,
    grouping,
    scale,
    percent,
    exp: expAt,
    fraction: slash < 0 ? null : { slash },
  }
}

function findFractionSlash(tokens: readonly Token[]): number {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.t !== 'slash') continue
    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    const nextIsDen = next && (next.t === 'digit' || (next.t === 'lit' && /^\d/.test(next.s)))
    if (prev && prev.t === 'digit' && nextIsDen) return i
  }
  return -1
}

function formatNumberSection(section: Section, value: number, signed: boolean): FormatPart[] {
  const tokens = section.tokens
  const negative = signed && value < 0
  let v = Math.abs(value)
  const layout = analyze(tokens)
  v = (v * 100 ** layout.percent) / 1000 ** layout.scale
  let parts: FormatPart[]
  if (tokens.some((t) => t.t === 'general')) {
    parts = tokens.flatMap((t): FormatPart[] => {
      if (t.t === 'general') return [{ kind: 'text', text: generalNumber(v) }]
      return literalPart(t)
    })
  } else if (layout.fraction) {
    parts = formatFraction(tokens, layout.fraction.slash, v)
  } else if (layout.exp >= 0) {
    parts = formatScientific(tokens, layout, v)
  } else {
    parts = formatFixed(tokens, layout, v)
  }
  if (section.dbnum) parts = applyDbnumToNumber(parts, section.dbnum)
  // 负号随数字输出：没有数字占位的节（如只有引号文本）不加负号。
  const showsNumber = tokens.some((t) => t.t === 'digit' || t.t === 'general')
  if (negative && showsNumber) parts.unshift({ kind: 'text', text: '-' })
  return mergeText(parts)
}

function literalPart(t: Token): FormatPart[] {
  switch (t.t) {
    case 'lit':
      return [{ kind: 'text', text: t.s }]
    case 'gap':
    case 'fill':
      return [{ kind: t.t, text: t.s }]
    case 'percent':
      return [{ kind: 'text', text: '%' }]
    case 'slash':
      return [{ kind: 'text', text: '/' }]
    default:
      return []
  }
}

/** 整数部分各占位对应的文本：自右向左填入数字，多出的数字全部放在最左一个占位。 */
function fillInteger(placeholders: readonly ('0' | '#' | '?')[], digits: string): string[] {
  const out = new Array<string>(placeholders.length).fill('')
  let di = digits.length - 1
  for (let pi = placeholders.length - 1; pi >= 0; pi--) {
    const p = placeholders[pi]!
    if (pi === 0 && di >= 0) {
      out[pi] = digits.slice(0, di + 1)
      di = -1
    } else if (di >= 0) {
      out[pi] = digits[di]!
      di--
    } else {
      out[pi] = p === '0' ? '0' : p === '?' ? ' ' : ''
    }
  }
  return out
}

function group(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return out
}

/** 小数部分：自左向右填入；末尾为 0 的 `#` 占位省略，`?` 占位显示空格。 */
function fillDecimals(placeholders: readonly ('0' | '#' | '?')[], digits: string): string[] {
  const out = placeholders.map((_, i) => digits[i] ?? '0')
  for (let i = placeholders.length - 1; i >= 0; i--) {
    const p = placeholders[i]!
    if (p === '0' || out[i] !== '0') break
    out[i] = p === '?' ? ' ' : ''
  }
  return out
}

function formatFixed(tokens: readonly Token[], layout: NumberLayout, v: number): FormatPart[] {
  const { int, frac } = fixedParts(v, layout.decDigits)
  const pointAt = tokens.findIndex((t) => t.t === 'point')
  const intEnd = pointAt < 0 ? tokens.length : pointAt
  const intPlaceholders: ('0' | '#' | '?')[] = []
  const decPlaceholders: ('0' | '#' | '?')[] = []
  tokens.forEach((t, i) => {
    if (t.t === 'digit') (i < intEnd ? intPlaceholders : decPlaceholders).push(t.s)
  })
  // 整数占位之间没有其他字面量时，整数部分作为一段输出，可加千分位。
  const firstDigit = tokens.findIndex((t) => t.t === 'digit')
  const intTokens = firstDigit < 0 ? [] : tokens.slice(firstDigit, intEnd)
  const lastIntDigit = intTokens.map((t) => t.t).lastIndexOf('digit')
  const interleaved = intTokens
    .slice(0, lastIntDigit + 1)
    .some((t) => t.t !== 'digit' && t.t !== 'comma')
  const intTexts = fillInteger(intPlaceholders, int)
  const decTexts = fillDecimals(decPlaceholders, frac)
  let intText = intTexts.join('')
  if (layout.grouping) {
    const lead = intText.length - intText.trimStart().length
    intText = ' '.repeat(lead) + group(intText.trimStart())
  }
  const parts: FormatPart[] = []
  let ii = 0
  let di = 0
  let intEmitted = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.t === 'digit') {
      if (i < intEnd) {
        if (interleaved) parts.push({ kind: 'text', text: intTexts[ii]! })
        else if (!intEmitted) {
          parts.push({ kind: 'text', text: intText })
          intEmitted = true
        }
        ii++
      } else {
        parts.push({ kind: 'text', text: decTexts[di]! })
        di++
      }
    } else if (t.t === 'point') {
      // 没有整数占位时（如 `.00`），值的整数部分输出在小数点之前。
      if (intPlaceholders.length === 0 && int !== '') parts.push({ kind: 'text', text: int })
      parts.push({ kind: 'text', text: '.' })
    } else if (t.t === 'comma') {
      if (interleaved && i < intEnd && i > firstDigit && i < firstDigit + lastIntDigit) {
        parts.push({ kind: 'text', text: ',' })
      }
    } else {
      parts.push(...literalPart(t))
    }
  }
  return parts
}

function formatScientific(tokens: readonly Token[], layout: NumberLayout, v: number): FormatPart[] {
  const expAt = layout.exp
  const expToken = tokens[expAt] as { t: 'exp'; sign: '+' | '-' }
  const intPlaceholders: ('0' | '#' | '?')[] = []
  const decPlaceholders: ('0' | '#' | '?')[] = []
  const expPlaceholders: ('0' | '#' | '?')[] = []
  const pointAt = tokens.findIndex((t, i) => t.t === 'point' && i < expAt)
  const intEnd = pointAt < 0 ? expAt : pointAt
  tokens.forEach((t, i) => {
    if (t.t !== 'digit') return
    if (i < intEnd) intPlaceholders.push(t.s)
    else if (i < expAt) decPlaceholders.push(t.s)
    else expPlaceholders.push(t.s)
  })
  // 一个整数占位：尾数在 [1, 10)。多个占位且全为 0（`00.0E+0`）：尾数恰有这么多位整数。
  // 多个占位且含 `#`（`##0.0E+0`）：指数取占位数的整数倍。
  const groupSize = Math.max(1, intPlaceholders.length)
  const allZero = intPlaceholders.every((p) => p === '0')
  const step = groupSize > 1 && !allZero ? groupSize : 1
  const decimals = decPlaceholders.length
  let exponent = 0
  let parts0 = { int: '', frac: '0'.repeat(decimals) }
  if (v !== 0) {
    const d = toDecimal(v)
    const e = d.point - 1
    exponent = step > 1 ? Math.floor(e / step) * step : e - (groupSize - 1)
    const mantissa = (exp: number) => fixedParts(Number(`0.${d.digits}e${d.point - exp}`), decimals)
    parts0 = mantissa(exponent)
    // 尾数舍入后进位到下一个指数区间（9.996 → 10.00）时，指数前进一档。
    if (parts0.int.length > groupSize) {
      exponent += step
      parts0 = mantissa(exponent)
    }
  }
  const { int, frac } = parts0
  const intTexts = fillInteger(
    intPlaceholders,
    int === '' && intPlaceholders.length === 0 ? '' : int,
  )
  const decTexts = fillDecimals(decPlaceholders, frac)
  const expDigits = String(Math.abs(exponent))
  const expTexts = fillInteger(expPlaceholders, expDigits)
  const parts: FormatPart[] = []
  let ii = 0
  let di = 0
  let ei = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t.t === 'digit') {
      if (i < intEnd) parts.push({ kind: 'text', text: intTexts[ii++]! })
      else if (i < expAt) parts.push({ kind: 'text', text: decTexts[di++]! })
      else parts.push({ kind: 'text', text: expTexts[ei++]! })
    } else if (t.t === 'point') {
      parts.push({ kind: 'text', text: '.' })
    } else if (t.t === 'exp') {
      const sign = exponent < 0 ? '-' : expToken.sign === '+' ? '+' : ''
      parts.push({ kind: 'text', text: `E${sign}` })
    } else if (t.t !== 'comma') {
      parts.push(...literalPart(t))
    }
  }
  return parts
}

/** 分母不超过 `maxDen` 的最接近分数；误差相同时取较小的分母。 */
function nearestFraction(x: number, maxDen: number): [number, number] {
  let best: [number, number] = [Math.round(x), 1]
  let bestErr = Math.abs(x - best[0])
  for (let q = 2; q <= maxDen && bestErr > 0; q++) {
    const p = Math.round(x * q)
    const err = Math.abs(x - p / q)
    if (err < bestErr - 1e-12) {
      best = [p, q]
      bestErr = err
    }
  }
  return best
}

function formatFraction(tokens: readonly Token[], slash: number, v: number): FormatPart[] {
  // 分子：斜杠前连续的数字占位；分母：斜杠后的数字占位或固定数字。
  let numStart = slash
  while (numStart > 0 && tokens[numStart - 1]!.t === 'digit') numStart--
  let denEnd = slash + 1
  let fixedDen: number | null = null
  const denToken = tokens[slash + 1]!
  if (denToken.t === 'lit') {
    const m = /^\d+/.exec(denToken.s)!
    fixedDen = Number(m[0])
    denEnd = slash + 2
  } else {
    while (denEnd < tokens.length && tokens[denEnd]!.t === 'digit') denEnd++
  }
  const numPlaceholders = tokens.slice(numStart, slash).map((t) => (t as { s: '0' | '#' | '?' }).s)
  const denPlaceholders = tokens
    .slice(slash + 1, denEnd)
    .flatMap((t) => (t.t === 'digit' ? [t.s] : []))
  const intPlaceholders = tokens.slice(0, numStart).flatMap((t) => (t.t === 'digit' ? [t.s] : []))
  const mixed = intPlaceholders.length > 0
  let whole = mixed ? Math.floor(v) : 0
  const rest = v - whole
  let [num, den] =
    fixedDen !== null
      ? [Math.round(rest * fixedDen), fixedDen]
      : nearestFraction(rest, 10 ** Math.max(1, denPlaceholders.length) - 1)
  if (mixed && num === den) {
    whole += 1
    num = 0
  }
  const parts: FormatPart[] = []
  const hideFraction = mixed && num === 0
  const intTexts = fillInteger(intPlaceholders, whole === 0 ? '' : String(whole))
  if (mixed && whole === 0 && num === 0) intTexts[intTexts.length - 1] = '0'
  const numTexts = fillInteger(numPlaceholders, String(num))
  const denText = String(den)
  let ii = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (i < numStart) {
      if (t.t === 'digit') parts.push({ kind: 'text', text: intTexts[ii++]! })
      else if (t.t !== 'comma') parts.push(...literalPart(t))
      continue
    }
    if (i < slash) {
      const text = numTexts[i - numStart]!
      parts.push({ kind: 'text', text: hideFraction ? ' '.repeat(text.length) : text })
      continue
    }
    if (i === slash) {
      parts.push({ kind: 'text', text: hideFraction ? ' ' : '/' })
      continue
    }
    if (i < denEnd) {
      if (fixedDen !== null) {
        const lit = (t as { s: string }).s
        const tail = lit.slice(String(fixedDen).length)
        parts.push({
          kind: 'text',
          text: (hideFraction ? ' '.repeat(denText.length) : denText) + tail,
        })
      } else if (i === slash + 1) {
        const width = denPlaceholders.length
        const padded = denPlaceholders.at(-1) === '?' ? denText.padEnd(width, ' ') : denText
        parts.push({ kind: 'text', text: hideFraction ? ' '.repeat(padded.length) : padded })
      }
      continue
    }
    if (t.t !== 'digit' && t.t !== 'comma') parts.push(...literalPart(t))
  }
  return parts
}

// ---------------------------------------------------------------------------
// 日期节

function formatDate(section: Section, value: number, date1904: boolean): FormatPart[] | null {
  const subsec = section.tokens.reduce((n, t) => (t.t === 'subsec' ? Math.max(n, t.width) : n), 0)
  const d = dateParts(value, date1904, subsec)
  if (!d) return null
  const twelve = section.tokens.some(
    (t) => t.t === 'date' && (/^(am\/pm|a\/p)$/i.test(t.s) || t.s === '上午/下午'),
  )
  const pm = d.hours >= 12
  const hour12 = d.hours % 12 === 0 ? 12 : d.hours % 12
  const cn = section.chinese
  const db = section.dbnum
  const num = (n: number, width: number, digitwise = false): string => {
    if (db) return dbnumDigits(n, db, digitwise)
    return String(n).padStart(width, '0')
  }
  const parts: FormatPart[] = []
  for (const t of section.tokens) {
    if (t.t === 'date') {
      const s = t.s
      let text: string
      if (s.startsWith('y'))
        text = s.length <= 2 ? num(d.year % 100, 2, true) : num(d.year, 4, true)
      else if (s === 'm') text = num(d.month, 1)
      else if (s === 'mm') text = num(d.month, 2)
      else if (s === 'mmm') text = cn ? `${d.month}月` : MONTHS[d.month - 1]!.slice(0, 3)
      else if (s === 'mmmmm') text = cn ? `${d.month}` : MONTHS[d.month - 1]![0]!
      else if (s.startsWith('mmmm'))
        text = cn ? `${chineseNumber(d.month, 1)}月` : MONTHS[d.month - 1]!
      else if (s === 'M') text = num(d.minutes, 1)
      else if (s.startsWith('M')) text = num(d.minutes, 2)
      else if (s === 'd') text = num(d.day, 1)
      else if (s === 'dd') text = num(d.day, 2)
      else if (s === 'ddd') text = cn ? `周${CN_WEEK[d.weekday]}` : DAYS[d.weekday]!.slice(0, 3)
      else if (s.startsWith('dddd')) text = cn ? `星期${CN_WEEK[d.weekday]}` : DAYS[d.weekday]!
      else if (s === 'aaa') text = CN_WEEK[d.weekday]!
      else if (s === 'aaaa') text = `星期${CN_WEEK[d.weekday]}`
      else if (s.startsWith('h')) text = num(twelve ? hour12 : d.hours, s.length >= 2 ? 2 : 1)
      else if (s.startsWith('s')) text = num(d.seconds, s.length >= 2 ? 2 : 1)
      else if (s === 'AM/PM') text = pm ? 'PM' : 'AM'
      else if (s === 'am/pm') text = pm ? 'pm' : 'am'
      else if (s === 'A/P') text = pm ? 'P' : 'A'
      else if (s === 'a/p') text = pm ? 'p' : 'a'
      else if (s === '上午/下午') text = pm ? '下午' : '上午'
      else text = s
      parts.push({ kind: 'text', text })
    } else if (t.t === 'elapsed') {
      const total = d.totalSeconds
      const n =
        t.unit === 'h' ? Math.floor(total / 3600) : t.unit === 'm' ? Math.floor(total / 60) : total
      parts.push({ kind: 'text', text: String(n).padStart(t.width, '0') })
    } else if (t.t === 'subsec') {
      parts.push({ kind: 'text', text: `.${String(d.subseconds).padStart(t.width, '0')}` })
    } else if (t.t === 'digit') {
      parts.push({ kind: 'text', text: t.s === '0' ? '0' : '' })
    } else if (t.t === 'point') {
      parts.push({ kind: 'text', text: '.' })
    } else if (t.t === 'comma') {
      parts.push({ kind: 'text', text: ',' })
    } else {
      parts.push(...literalPart(t))
    }
  }
  return mergeText(parts)
}

// ---------------------------------------------------------------------------
// 中文数字

const CN_UPPER = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const UNITS_LOWER = ['', '十', '百', '千']
const UNITS_UPPER = ['', '拾', '佰', '仟']
const BIG_LOWER = ['', '万', '亿', '兆']

/** 非负整数的中文读法：`style` 1 为小写（一百二十三），2 为大写（壹佰贰拾叁）。 */
function chineseNumber(n: number, style: 1 | 2): string {
  const digits = style === 1 ? CN_DIGITS : CN_UPPER
  const units = style === 1 ? UNITS_LOWER : UNITS_UPPER
  const zero = style === 1 ? '〇' : '零'
  if (n === 0) return zero
  const s = String(Math.floor(n))
  const groups: string[] = []
  for (let end = s.length; end > 0; end -= 4) groups.unshift(s.slice(Math.max(0, end - 4), end))
  let out = ''
  let pendingZero = false
  groups.forEach((g, gi) => {
    const big = BIG_LOWER[groups.length - 1 - gi] ?? ''
    let part = ''
    for (let i = 0; i < g.length; i++) {
      const d = Number(g[i])
      const unit = units[g.length - 1 - i]!
      if (d === 0) {
        pendingZero = part !== '' || out !== ''
        continue
      }
      if (pendingZero) part += zero
      pendingZero = false
      part += digits[d]! + unit
    }
    if (part !== '') out += part + big
  })
  // 十至十九读作「十」开头，不读「一十」。
  if (style === 1 && out.startsWith('一十')) out = out.slice(1)
  return out
}

function dbnumDigits(n: number, style: 1 | 2 | 3, digitwise: boolean): string {
  if (style === 3) {
    return String(n).replace(/\d/g, (c) => String.fromCharCode(0xff10 + Number(c)))
  }
  if (digitwise) {
    const table = style === 1 ? CN_DIGITS : CN_UPPER
    return String(n).replace(/\d/g, (c) => table[Number(c)]!)
  }
  return chineseNumber(n, style)
}

/** 数字节的中文数字：整数部分按读法，小数部分逐位转换。 */
function applyDbnumToNumber(parts: FormatPart[], style: 1 | 2 | 3): FormatPart[] {
  return parts.map((p) => {
    if (p.kind !== 'text') return p
    const text = p.text.replace(/\d+(\.\d+)?/g, (m) => {
      const [i, f] = m.split('.')
      const head = dbnumDigits(Number(i), style, false)
      return f === undefined ? head : `${head}.${dbnumDigits(Number(f), style, true)}`
    })
    return { ...p, text }
  })
}
