/**
 * BIFF8 工作簿全局子流：工作表目录、共享字符串、字体、数字格式、XF 与 XFEXT、调色板、主题、日期系统与活动工作表。
 *
 * - XF 表中混有样式 XF（`fStyle` 为 1）与单元格 XF。`styles` 只含单元格 XF，按出现顺序编号，`styleIndex` 由 XF 序号
 *   换算：绘制把样式 0 当作未写出单元格的缺省样式，BIFF 中这一角色是第一个单元格 XF（通常为 XF 15），不是 XF 0。
 *   指向样式 XF 或越界的序号取 0。
 * - 字体序号 4 不存在：序号不小于 4 时减 1 才是 FONT 记录的下标。
 * - 调色板：0–7 固定，PALETTE 替换 8 起的 56 色，64 与 65 为系统前景色与背景色。颜色在读完全部记录后换算：PALETTE 在 XF 之后。
 * - XFEXT 覆盖其 XF 的填充色、边框色、文字色与缩进。颜色为主题色而没有可用主题、或为未设置时沿用 XF 中的调色板颜色。
 *   XFCRC 校验不实现：WPS 是否在校验不一致时忽略 XFEXT 未实测。
 * - 主题只读取 THEME 记录中内嵌的主题包（ZIP）；只有版本号、没有内嵌包时为 `null`。
 * - 三维引用的工作表：EXTERNSHEET 的序号指向 SUPBOOK 与工作表序号；只解析指向本工作簿单张工作表的项（`sheetName`）。
 * - SST 的字符串可跨 CONTINUE 记录：字符数据被截断时，下一记录开头另有一个字节给出后续字符的宽度；
 *   富文本段与扩展数据被截断时没有该字节。
 */

import { parseTheme, type Theme } from '../../drawingml/theme.ts'
import { formatCodeFor } from '../../numfmt/format.ts'
import { openZip } from '../../zip/index.ts'
import type {
  BorderLine,
  BorderLineStyle,
  CellAlignment,
  CellBorder,
  CellFill,
  CellStyle,
  FontStyle,
  HorizontalAlign,
  PatternType,
  RichRun,
  UnderlineStyle,
  VerticalAlign,
} from '../model.ts'
import {
  type ColorContext,
  DEFAULT_PALETTE,
  type RawColor,
  resolveRawColor,
} from '../parse/color.ts'
import type { SharedString } from '../parse/shared-strings.ts'
import {
  type BiffRecord,
  Bytes,
  RT,
  readChars,
  shortString,
  unicodeString,
  withContinues,
} from './records.ts'

export interface SheetEntry {
  readonly name: string
  readonly state: 'visible' | 'hidden' | 'veryHidden'
  /** BOUNDSHEET 的 `dt`：0 为工作表或对话框表，1 为宏表，2 为图表工作表，6 为 VBA 模块。 */
  readonly type: number
  /** 子流 BOF 在工作簿流中的偏移。 */
  readonly offset: number
}

export interface Globals {
  readonly sheets: readonly SheetEntry[]
  readonly strings: readonly SharedString[]
  readonly styles: readonly CellStyle[]
  /** XF 序号换算为 `styles` 的下标。 */
  styleIndex(xf: number): number
  readonly defaultFont: FontStyle
  readonly palette: readonly string[]
  readonly theme: Theme | null
  readonly date1904: boolean
  /** WINDOW1 的活动工作表，`sheets` 的下标。 */
  readonly activeTab: number
  readonly fontNames: readonly string[]
  /** MSODRAWINGGROUP 及其 CONTINUE 的数据拼接；没有时为 `null`。 */
  readonly drawingGroup: Uint8Array | null
  /** FONT 表中的字体，序号同 XF 与 FontX（序号 4 不存在）。 */
  fontAt(index: number): FontStyle | undefined
  /** FORMAT 记录的自定义数字格式。 */
  readonly formats: ReadonlyMap<number, string>
  numberFormat(ifmt: number): string
  /** EXTERNSHEET 序号对应的本工作簿工作表名；外部工作簿、多张工作表与无效序号为 `null`。 */
  sheetName(ixti: number): string | null
}

interface RawXf {
  readonly font: number
  readonly format: number
  readonly style: boolean
  readonly data: Bytes
}

type ExtColors = Map<number, RawColor | 'auto'>

/** SUPBOOK 的 `cch` 为该值时表示本工作簿。 */
const SELF_REFERENCE = 0x0401

const HORIZONTAL: readonly HorizontalAlign[] = [
  'general',
  'left',
  'center',
  'right',
  'fill',
  'justify',
  'centerContinuous',
  'distributed',
]
const VERTICAL: readonly VerticalAlign[] = ['top', 'center', 'bottom', 'justify', 'distributed']
export const BORDER_STYLES: readonly (BorderLineStyle | null)[] = [
  null,
  'thin',
  'medium',
  'dashed',
  'dotted',
  'thick',
  'double',
  'hair',
  'mediumDashed',
  'dashDot',
  'mediumDashDot',
  'dashDotDot',
  'mediumDashDotDot',
  'slantDashDot',
]
export const PATTERNS: readonly (PatternType | null)[] = [
  null,
  'solid',
  'mediumGray',
  'darkGray',
  'lightGray',
  'darkHorizontal',
  'darkVertical',
  'darkDown',
  'darkUp',
  'darkGrid',
  'darkTrellis',
  'lightHorizontal',
  'lightVertical',
  'lightDown',
  'lightUp',
  'lightGrid',
  'lightTrellis',
  'gray125',
  'gray0625',
]
export const UNDERLINES: Readonly<Record<number, UnderlineStyle>> = {
  1: 'single',
  2: 'double',
  33: 'singleAccounting',
  34: 'doubleAccounting',
}
const AUTO_COLOR = 0x7fff
/** XFEXT 的扩展类型：填充前景、填充背景、四边与对角线边框、文字颜色、缩进。 */
const EXT_FILL_FG = 4
const EXT_FILL_BG = 5
const EXT_TOP = 7
const EXT_BOTTOM = 8
const EXT_LEFT = 9
const EXT_RIGHT = 10
const EXT_DIAGONAL = 11
const EXT_TEXT = 13
const EXT_INDENT = 15
const FALLBACK_FONT: FontStyle = {
  name: 'Arial',
  size: 10,
  bold: false,
  italic: false,
  underline: 'none',
  strike: false,
  color: null,
  vertAlign: 'baseline',
}

export async function readGlobals(list: readonly BiffRecord[], end: number): Promise<Globals> {
  const sheets: SheetEntry[] = []
  const rawFonts: Bytes[] = []
  const formats = new Map<number, string>()
  const xfs: RawXf[] = []
  const exts = new Map<number, { colors: ExtColors; indent: number | null }>()
  let normalXf = 0
  let customPalette: string[] = []
  let theme: Theme | null = null
  let date1904 = false
  let activeTab = 0
  let sstParts: Uint8Array[] = []
  const group: Uint8Array[] = []
  const supbooks: boolean[] = []
  let externSheet: Bytes | null = null

  for (let i = 0; i < end; i++) {
    const r = list[i]!
    const b = new Bytes(r.data)
    switch (r.id) {
      case RT.BOUNDSHEET: {
        const state = b.u8(4) & 3
        sheets.push({
          name: shortString(b, 6).text,
          state: state === 1 ? 'hidden' : state === 2 ? 'veryHidden' : 'visible',
          type: b.u8(5),
          offset: b.u32(0),
        })
        break
      }
      case RT.WINDOW1:
        activeTab = b.u16(10)
        break
      case RT.DATEMODE:
        date1904 = b.u16(0) === 1
        break
      case RT.FONT:
        rawFonts.push(b)
        break
      case RT.FORMAT:
        formats.set(b.u16(0), unicodeString(b, 2).text)
        break
      case RT.XF:
        xfs.push({ font: b.u16(0), format: b.u16(2), style: (b.u16(4) & 4) !== 0, data: b })
        break
      case RT.XFEXT:
        exts.set(b.u16(14), readXfExt(b))
        break
      case RT.STYLE: {
        const v = b.u16(0)
        if ((v & 0x8000) !== 0 && b.u8(2) === 0) normalXf = v & 0x0fff
        break
      }
      case RT.PALETTE: {
        customPalette = []
        for (let k = 0; k < b.u16(0); k++) customPalette.push(rgbHex(b, 2 + k * 4))
        break
      }
      case RT.SST:
        sstParts = withContinues(list, i).parts
        break
      case RT.THEME:
        if (b.u32(12) === 0 || r.data.length > 16) theme = await readTheme(r.data.subarray(16))
        break
      case RT.MSODRAWINGGROUP:
        group.push(...withContinues(list, i).parts)
        break
      case RT.SUPBOOK:
        supbooks.push(b.u16(2) === SELF_REFERENCE)
        break
      case RT.EXTERNSHEET:
        externSheet = new Bytes(concat(withContinues(list, i).parts))
        break
    }
  }

  const palette = [
    ...DEFAULT_PALETTE.slice(0, 8),
    ...DEFAULT_PALETTE.slice(8, 64).map((c, k) => customPalette[k] ?? c),
    ...DEFAULT_PALETTE.slice(64),
  ]
  const ctx: ColorContext = { palette, theme }
  const icv = (index: number): string | null =>
    index === AUTO_COLOR ? null : (palette[index] ?? null)
  const fonts = rawFonts.map((b) => readFont(b, icv))
  const fontAt = (index: number): FontStyle | undefined => fonts[index < 4 ? index : index - 1]
  const defaultFont = fontAt(xfs[normalXf]?.font ?? 0) ?? fonts[0] ?? FALLBACK_FONT

  const styles: CellStyle[] = []
  const indexOf = new Map<number, number>()
  xfs.forEach((xf, k) => {
    if (xf.style) return
    indexOf.set(k, styles.length)
    const ext = exts.get(k) ?? null
    const color = (type: number, fallback: string | null): string | null => {
      const raw = ext?.colors.get(type)
      if (raw === undefined) return fallback
      if (raw === 'auto') return null
      return resolveRawColor(raw, ctx) ?? fallback
    }
    styles.push(
      readXf(
        xf,
        fontAt(xf.font) ?? defaultFont,
        formatCodeFor(xf.format, formats),
        icv,
        color,
        ext,
      ),
    )
  })
  if (styles.length === 0) styles.push(defaultStyle(defaultFont))

  return {
    sheets,
    strings: readSst(sstParts, fontAt),
    styles,
    styleIndex: (xf) => indexOf.get(xf) ?? 0,
    defaultFont,
    palette,
    theme,
    date1904,
    activeTab,
    fontNames: [...new Set([defaultFont.name, ...fonts.map((f) => f.name)])],
    drawingGroup: group.length === 0 ? null : concat(group),
    fontAt,
    formats,
    numberFormat: (ifmt) => formatCodeFor(ifmt, formats),
    sheetName: (ixti) => {
      const e = externSheet
      if (e === null || ixti >= e.u16(0)) return null
      const p = 2 + ixti * 6
      const first = e.u16(p + 2)
      if (!supbooks[e.u16(p)] || first !== e.u16(p + 4)) return null
      return sheets[first]?.name ?? null
    },
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

function hex2(v: number): string {
  return v.toString(16).padStart(2, '0')
}

/** 4 字节的 R、G、B 与保留字节。 */
function rgbHex(b: Bytes, p: number): string {
  return `#${hex2(b.u8(p))}${hex2(b.u8(p + 1))}${hex2(b.u8(p + 2))}`
}

/** 内嵌主题包中的主题部件；包无法读取时为 `null`。 */
async function readTheme(bytes: Uint8Array): Promise<Theme | null> {
  const zip = openZip(bytes.slice())
  if (!zip.ok) return null
  const part = zip.value.paths.find((p) => /^theme\/theme\/theme\d*\.xml$/i.test(p))
  if (part === undefined) return null
  const xml = await zip.value.text(part)
  if (!xml.ok || xml.value === null) return null
  try {
    return parseTheme(xml.value)
  } catch {
    return null
  }
}

function readFont(b: Bytes, icv: (index: number) => string | null): FontStyle {
  const flags = b.u16(2)
  const script = b.u16(8)
  return {
    name: shortString(b, 14).text,
    size: b.u16(0) / 20,
    bold: b.u16(6) >= 700,
    italic: (flags & 0x0002) !== 0,
    underline: UNDERLINES[b.u8(10)] ?? 'none',
    strike: (flags & 0x0008) !== 0,
    color: icv(b.u16(4)),
    vertAlign: script === 1 ? 'superscript' : script === 2 ? 'subscript' : 'baseline',
  }
}

/** XFEXT 中的颜色与缩进。颜色为 FullColorExt：类型、色调（/32767）、值。 */
function readXfExt(b: Bytes): { colors: ExtColors; indent: number | null } {
  const colors: ExtColors = new Map()
  let indent: number | null = null
  let p = 20
  for (let k = 0; k < b.u16(18) && p + 4 <= b.length; k++) {
    const type = b.u16(p)
    const size = b.u16(p + 2)
    if (size < 4) break
    if (type === EXT_INDENT) indent = b.u16(p + 4)
    else if (
      type === EXT_FILL_FG ||
      type === EXT_FILL_BG ||
      (type >= EXT_TOP && type <= EXT_DIAGONAL) ||
      type === EXT_TEXT
    ) {
      const color = readFullColor(b, p + 4)
      if (color !== null) colors.set(type, color)
    }
    p += size
  }
  return { colors, indent }
}

/** 类型 0 为自动，1 为调色板序号，2 为 RGB，3 为主题色序号，4（未设置）返回 `null`。 */
function readFullColor(b: Bytes, p: number): RawColor | 'auto' | null {
  const type = b.u16(p)
  const tint = b.i16(p + 2) / 32767
  const value = b.u32(p + 4)
  const base = { auto: false, rgb: null, theme: null, indexed: null, tint }
  switch (type) {
    case 0:
      return 'auto'
    case 1:
      return { ...base, indexed: value }
    case 2:
      return { ...base, rgb: rgbHex(b, p + 4).slice(1) }
    case 3:
      return { ...base, theme: value }
    default:
      return null
  }
}

function defaultStyle(font: FontStyle): CellStyle {
  return {
    font,
    fill: null,
    border: null,
    alignment: {
      horizontal: 'general',
      vertical: 'bottom',
      wrap: false,
      shrink: false,
      rotation: 0,
      indent: 0,
    },
    numFmt: 'General',
  }
}

/** XF 的 20 字节：对齐 6–9，四边与对角线 10–17，填充 17–19（位域见各字段）。 */
function readXf(
  xf: RawXf,
  font: FontStyle,
  numFmt: string,
  icv: (index: number) => string | null,
  color: (type: number, fallback: string | null) => string | null,
  ext: { colors: ExtColors; indent: number | null } | null,
): CellStyle {
  const b = xf.data
  const a = b.u8(6)
  const indent = b.u8(8)
  const alignment: CellAlignment = {
    horizontal: HORIZONTAL[a & 7] ?? 'general',
    vertical: VERTICAL[(a >> 4) & 7] ?? 'bottom',
    wrap: (a & 8) !== 0,
    shrink: (indent & 0x10) !== 0,
    rotation: b.u8(7),
    indent: ext?.indent ?? indent & 0x0f,
  }
  const lines = b.u32(10)
  const more = b.u32(14)
  const side = (style: number, index: number, type: number): BorderLine | null => {
    const s = BORDER_STYLES[style] ?? null
    return s === null ? null : { style: s, color: color(type, icv(index)) ?? '#000000' }
  }
  const diagonal = side((more >>> 21) & 15, (more >>> 14) & 127, EXT_DIAGONAL)
  const grbitDiag = (lines >>> 30) & 3
  const border: CellBorder = {
    left: side(lines & 15, (lines >>> 16) & 127, EXT_LEFT),
    right: side((lines >>> 4) & 15, (lines >>> 23) & 127, EXT_RIGHT),
    top: side((lines >>> 8) & 15, more & 127, EXT_TOP),
    bottom: side((lines >>> 12) & 15, (more >>> 7) & 127, EXT_BOTTOM),
    diagonalDown: grbitDiag & 1 ? diagonal : null,
    diagonalUp: grbitDiag & 2 ? diagonal : null,
  }
  const hasBorder = Object.values(border).some((v) => v !== null)
  const pattern = PATTERNS[(more >>> 26) & 63] ?? null
  const colors = b.u16(18)
  let fill: CellFill | null = null
  if (pattern !== null) {
    const fg = color(EXT_FILL_FG, icv(colors & 127)) ?? '#000000'
    const bg = color(EXT_FILL_BG, icv((colors >>> 7) & 127)) ?? '#ffffff'
    fill = { kind: 'pattern', pattern, fg, bg: pattern === 'solid' ? fg : bg }
  }
  const text = ext?.colors.has(EXT_TEXT) ? color(EXT_TEXT, font.color) : font.color
  return {
    font: text === font.color ? font : { ...font, color: text },
    fill,
    border: hasBorder ? border : null,
    alignment,
    numFmt,
  }
}

/**
 * 共享字符串表：`parts` 为 SST 与其后的 CONTINUE 记录。富文本段（字符位置、字体序号）换算为 `RichRun`，
 * 第一段之前的文字沿用单元格字体；扩展数据（注音）不计入显示文本。
 */
function readSst(
  parts: readonly Uint8Array[],
  fontAt: (index: number) => FontStyle | undefined,
): SharedString[] {
  if (parts.length === 0) return []
  const c = new Cursor(parts)
  c.skip(4)
  const count = c.u32()
  const out: SharedString[] = []
  for (let k = 0; k < count && !c.done; k++) {
    const cch = c.u16()
    const flags = c.u8()
    const runCount = flags & 0x08 ? c.u16() : 0
    const extSize = flags & 0x04 ? c.u32() : 0
    const text = c.chars(cch, (flags & 1) === 1)
    const runs: { at: number; font: FontStyle | null }[] = []
    for (let r = 0; r < runCount; r++) {
      const at = c.u16()
      const font = fontAt(c.u16()) ?? null
      runs.push({ at, font })
    }
    c.skip(extSize)
    out.push({ text, runs: toRuns(text, runs) })
  }
  return out
}

function toRuns(
  text: string,
  runs: readonly { at: number; font: FontStyle | null }[],
): RichRun[] | null {
  const sorted = runs.filter((r) => r.at < text.length).sort((x, y) => x.at - y.at)
  if (sorted.length === 0) return null
  const out: RichRun[] = []
  if (sorted[0]!.at > 0) out.push({ text: text.slice(0, sorted[0]!.at), font: null })
  sorted.forEach((r, i) => {
    const to = sorted[i + 1]?.at ?? text.length
    if (to > r.at) out.push({ text: text.slice(r.at, to), font: r.font })
  })
  return out
}

/** 跨记录读取：数值字段直接跨到下一记录；字符数据跨记录时，下一记录开头的一个字节给出字符宽度。 */
class Cursor {
  private part = 0
  private pos = 0
  private bytes: Bytes
  constructor(private readonly parts: readonly Uint8Array[]) {
    this.bytes = new Bytes(parts[0]!)
  }
  get done(): boolean {
    return this.part >= this.parts.length - 1 && this.pos >= this.bytes.length
  }
  private advance(): boolean {
    if (this.part + 1 >= this.parts.length) return false
    this.part++
    this.pos = 0
    this.bytes = new Bytes(this.parts[this.part]!)
    return true
  }
  private byte(): number {
    if (this.pos >= this.bytes.length && !this.advance()) return 0
    return this.bytes.u8(this.pos++)
  }
  u8(): number {
    return this.byte()
  }
  u16(): number {
    return this.byte() | (this.byte() << 8)
  }
  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  skip(n: number): void {
    for (let k = 0; k < n; k++) this.byte()
  }
  chars(count: number, wide: boolean): string {
    let text = ''
    let rest = count
    let w = wide
    while (rest > 0) {
      if (this.pos >= this.bytes.length) {
        if (!this.advance()) break
        w = (this.bytes.u8(this.pos++) & 1) === 1
      }
      const room = Math.floor((this.bytes.length - this.pos) / (w ? 2 : 1))
      const n = Math.min(rest, room)
      if (n === 0) {
        this.pos = this.bytes.length
        continue
      }
      const read = readChars(this.bytes, this.pos, n, w)
      text += read.text
      this.pos = read.end
      rest -= n
    }
    return text
  }
}
