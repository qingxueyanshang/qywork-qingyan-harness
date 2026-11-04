/**
 * .doc 表流中的定义：字体表（SttbfFfn）、样式表（STSH）与编号（LST、LFO），换算为 docx 的 `Styles`、字体表条目与
 * `NumberingDefs`，继承与编号计数沿用 `../resolve/`。
 *
 * - 字体表：字体在表中的下标（ftc）即字符属性中引用的编号；条目名后可另有替代字体名（`ixchSzAlt`）。
 * - 样式以 istd 的十进制串为标识。段落样式有段落与字符两组差异（UPX），字符样式只有字符差异，表格样式有表格、段落、
 *   字符三组；每组是相对 `istdBase` 的差异，与 docx 的 `basedOn` 继承相同。缺省段落样式为 istd 0，缺省字符样式为 istd 10。
 * - 文档默认的字符属性：字号 10 磅，三类字体取 STSHI 的标准字体（复杂文种字体取 `ftcBi`）。
 * - 文档默认的段落属性只含单倍行距与孤行控制（标准段落属性），其余均为假：中文排版的开关由样式给出。
 * - 样式中操作数为 129 的切换属性取基准样式链中该项的反值，128 取基准样式链中的值。
 * - 编号：LFO 的序号（自 1 起）为 `numId`，LST 为抽象编号；LFO 中覆盖起始值或格式的级别按 `lvlOverride` 处理。
 *   编号文字中的占位符（值为 0–8 的字符，位置由 `rgbxchNums` 给出）换算为 `%1`–`%9`。
 */

import type { FontTableEntry } from '../model.ts'
import type {
  AbstractNum,
  Level,
  LevelOverride,
  NumberingDefs,
  NumInstance,
} from '../parse/numbering.ts'
import type { RawParaProps, RawRunProps, Toggle } from '../parse/properties.ts'
import type { StyleDef, Styles, StyleType } from '../parse/styles.ts'
import type { RawTableProps } from '../parse/table.ts'
import { applyChp, applyPap, emptyChp, emptyPap, readSprms, u16, u32 } from './sprm.ts'
import { applyTableStyle } from './table.ts'

export interface FontTable {
  /** 按 ftc 的字体名。 */
  readonly names: readonly string[]
  readonly entries: Map<string, FontTableEntry>
}

/** SttbfFfn：计数与额外数据长度之后是各 FFN；FFN 的首字节为其余部分的长度，字体名自第 40 字节起。 */
export function readFonts(table: Uint8Array, fc: number, lcb: number): FontTable {
  const names: string[] = []
  const entries = new Map<string, FontTableEntry>()
  const end = Math.min(table.length, fc + lcb)
  let p = fc
  if (u16(table, p) === 0xffff) p += 2
  const count = u16(table, p)
  p += 4
  for (let i = 0; i < count && p < end; i++) {
    const size = table[p]! + 1
    const ffn = table.subarray(p, Math.min(end, p + size))
    p += size
    const strings: string[] = []
    let s = ''
    for (let q = 40; q + 1 < ffn.length; q += 2) {
      const c = u16(ffn, q)
      if (c === 0) {
        strings.push(s)
        s = ''
      } else s += String.fromCharCode(c)
    }
    if (s !== '') strings.push(s)
    const name = strings[0] ?? ''
    names.push(name)
    const alt = (ffn[5] ?? 0) === 0 ? '' : (strings[1] ?? '').trim()
    if (name !== '' && !entries.has(name))
      entries.set(name, { altName: alt, charset: ffn[4] ?? null })
  }
  return { names, entries }
}

const STK_TYPES: Readonly<Record<number, StyleType>> = {
  1: 'paragraph',
  2: 'character',
  3: 'table',
  4: 'numbering',
}
const ISTD_NIL = 0x0fff
const ISTD_NORMAL = 0
const ISTD_NORMAL_CHAR = 10
const STI_USER = 0x0ffe
/** 段落样式与表格样式缺省的标识：Normal（istd 0）与 Table Normal（sti 105）。 */
const STI_TABLE_NORMAL = 105

interface RawStyle {
  readonly istd: number
  readonly sti: number
  readonly type: StyleType
  readonly base: number
  readonly name: string
  readonly pPr: RawParaProps
  readonly rPr: RawRunProps
  /** 操作数为 128、129 的切换属性。 */
  readonly relative: Map<Toggle, boolean>
  readonly tblPr: RawTableProps
}

/** 各组差异（UPX）：长度（2 字节）之后为内容，每组从 STD 内的偶数偏移开始。 */
function readUpxs(std: Uint8Array, start: number, count: number): Uint8Array[] {
  const out: Uint8Array[] = []
  let p = start
  for (let i = 0; i < count && p + 2 <= std.length; i++) {
    const size = u16(std, p)
    out.push(std.subarray(p + 2, Math.min(std.length, p + 2 + size)))
    p += 2 + size
    if (p % 2 === 1) p++
  }
  return out
}

function readStd(
  std: Uint8Array,
  istd: number,
  baseSize: number,
  fonts: readonly string[],
): RawStyle | null {
  if (std.length < Math.min(baseSize, 10)) return null
  const sti = u16(std, 0) & 0x0fff
  const stk = u16(std, 2) & 0x0f
  const base = u16(std, 2) >> 4
  const cupx = u16(std, 4) & 0x0f
  const type = STK_TYPES[stk]
  if (type === undefined) return null
  let p = baseSize
  const cch = u16(std, p)
  let name = ''
  for (let i = 0; i < cch && p + 2 + i * 2 + 1 < std.length; i++)
    name += String.fromCharCode(u16(std, p + 2 + i * 2))
  p += 2 + (cch + 1) * 2
  const upx = readUpxs(std, p, cupx)
  const pap = emptyPap(istd)
  const chp = emptyChp()
  let tblPr: RawTableProps = {}
  const papx = (bytes: Uint8Array | undefined) => {
    if (bytes === undefined || bytes.length < 2) return
    for (const s of readSprms(bytes.subarray(2))) applyPap(s, pap)
  }
  const chpx = (bytes: Uint8Array | undefined) => {
    if (bytes === undefined) return
    for (const s of readSprms(bytes)) applyChp(s, chp, fonts)
  }
  if (type === 'paragraph') {
    papx(upx[0])
    chpx(upx[1])
  } else if (type === 'character') chpx(upx[0])
  else if (type === 'table') {
    if (upx[0] !== undefined) tblPr = applyTableStyle(readSprms(upx[0]))
    papx(upx[1])
    chpx(upx[2])
  } else papx(upx[0])
  const { style: _, ...pPr } = pap.props
  const { style: __, ...rPr } = chp.props
  return { istd, sti, type, base, name, pPr, rPr, relative: chp.relative, tblPr }
}

/**
 * STSH：STSHI（含标准字体）之后是各样式的 STD，长度为 0 的项为空位。`fonts` 为 `readFonts` 的字体名。
 * 结构不完整时返回空样式表，文档默认仍按标准字符属性。
 */
export function readStyles(
  table: Uint8Array,
  fc: number,
  lcb: number,
  fonts: readonly string[],
): Styles {
  const end = Math.min(table.length, fc + lcb)
  const stshiSize = u16(table, fc)
  const stshi = table.subarray(fc + 2, Math.min(end, fc + 2 + stshiSize))
  const count = u16(stshi, 0)
  const baseSize = u16(stshi, 2) || 10
  const font = (at: number) => (at + 2 <= stshi.length ? fonts[u16(stshi, at)] : fonts[0])
  const defaultRun: RawRunProps = { size: 10, sizeCs: 10 }
  const fontAt = (slot: 'ascii' | 'eastAsia' | 'hAnsi' | 'cs', at: number) => {
    const name = font(at)
    if (name !== undefined && name !== '') defaultRun[slot] = { name }
  }
  fontAt('ascii', 12)
  fontAt('eastAsia', 14)
  fontAt('hAnsi', 16)
  fontAt('cs', 18)

  const raw = new Map<number, RawStyle>()
  let p = fc + 2 + stshiSize
  for (let istd = 0; istd < count && p + 2 <= end; istd++) {
    const size = u16(table, p)
    const std = table.subarray(p + 2, Math.min(end, p + 2 + size))
    p += 2 + size
    if (size === 0) continue
    const style = readStd(std, istd, baseSize, fonts)
    if (style !== null) raw.set(istd, style)
  }

  const byId = new Map<string, StyleDef>()
  /** 基准样式链中切换属性的值（含 128、129 的求值），按 istd 缓存。 */
  const toggles = new Map<number, Partial<Record<Toggle, boolean>>>()
  const chainToggles = (istd: number, seen: Set<number>): Partial<Record<Toggle, boolean>> => {
    const cached = toggles.get(istd)
    if (cached !== undefined) return cached
    const s = raw.get(istd)
    if (s === undefined || seen.has(istd)) return {}
    seen.add(istd)
    const base =
      s.base !== ISTD_NIL && raw.get(s.base)?.type === s.type ? chainToggles(s.base, seen) : {}
    const out: Partial<Record<Toggle, boolean>> = { ...base }
    for (const [k, v] of Object.entries(s.rPr) as [Toggle, unknown][]) {
      if (typeof v === 'boolean') out[k] = v
    }
    for (const [k, negate] of s.relative) out[k] = negate ? !(base[k] === true) : base[k] === true
    toggles.set(istd, out)
    return out
  }
  let defaultTableStyle: string | null = null
  for (const s of raw.values()) {
    const rPr: RawRunProps = { ...s.rPr }
    if (s.relative.size > 0) {
      const own = chainToggles(s.istd, new Set())
      for (const k of s.relative.keys()) rPr[k] = own[k] === true
    }
    const id = String(s.istd)
    byId.set(id, {
      id,
      name: s.name.split(',')[0] ?? '',
      custom: s.sti === STI_USER,
      type: s.type,
      basedOn: s.base === ISTD_NIL ? null : String(s.base),
      pPr: s.pPr,
      rPr,
      tblPr: s.tblPr,
      tcPr: {},
      conditions: {},
    })
    if (s.type === 'table' && s.sti === STI_TABLE_NORMAL && defaultTableStyle === null)
      defaultTableStyle = id
  }
  return {
    defaultRun,
    defaultParagraph: {},
    byId,
    defaultParagraphStyle: raw.get(ISTD_NORMAL)?.type === 'paragraph' ? String(ISTD_NORMAL) : null,
    defaultCharacterStyle:
      raw.get(ISTD_NORMAL_CHAR)?.type === 'character' ? String(ISTD_NORMAL_CHAR) : null,
    defaultTableStyle,
  }
}

/** 编号格式代码（nfc）到 `ST_NumberFormat`，按代码顺序。 */
const NUMBER_FORMATS = [
  'decimal',
  'upperRoman',
  'lowerRoman',
  'upperLetter',
  'lowerLetter',
  'ordinal',
  'cardinalText',
  'ordinalText',
  'hex',
  'chicago',
  'ideographDigital',
  'japaneseCounting',
  'aiueo',
  'iroha',
  'decimalFullWidth',
  'decimalHalfWidth',
  'japaneseLegal',
  'japaneseDigitalTenThousand',
  'decimalEnclosedCircle',
  'decimalFullWidth2',
  'aiueoFullWidth',
  'irohaFullWidth',
  'decimalZero',
  'bullet',
  'ganada',
  'chosung',
  'decimalEnclosedFullstop',
  'decimalEnclosedParen',
  'decimalEnclosedCircleChinese',
  'ideographEnclosedCircle',
  'ideographTraditional',
  'ideographZodiac',
  'ideographZodiacTraditional',
  'taiwaneseCounting',
  'ideographLegalTraditional',
  'taiwaneseCountingThousand',
  'taiwaneseDigital',
  'chineseCounting',
  'chineseLegalSimplified',
  'chineseCountingThousand',
  'koreanDigital',
  'koreanCounting',
  'koreanLegal',
  'koreanDigital2',
  'vietnameseCounting',
  'russianLower',
  'russianUpper',
  'none',
  'numberInDash',
  'hebrew1',
  'hebrew2',
  'arabicAlpha',
  'arabicAbjad',
  'hindiVowels',
  'hindiConsonants',
  'hindiNumbers',
  'hindiCounting',
  'thaiLetters',
  'thaiNumbers',
  'thaiCounting',
]

const LSTF_SIZE = 28
const LVLF_SIZE = 28
const LFO_SIZE = 16
const SUFFIXES: readonly Level['suffix'][] = ['tab', 'space', 'nothing']
const ALIGNS: readonly Level['align'][] = ['left', 'center', 'right', 'left']

/** 一个 LVL（LVLF、段落 sprm、字符 sprm、编号文字）；返回级别与其后的位置。 */
function readLevel(
  table: Uint8Array,
  p: number,
  styleOf: string | null,
  fonts: readonly string[],
): { level: Level; next: number } | null {
  if (p + LVLF_SIZE > table.length) return null
  const lvlf = table.subarray(p, p + LVLF_SIZE)
  const start = u32(lvlf, 0) | 0
  const nfc = lvlf[4]!
  const flags = lvlf[5]!
  const placeholders = [...lvlf.subarray(6, 15)]
  const follow = lvlf[15]!
  const cbChpx = lvlf[24]!
  const cbPapx = lvlf[25]!
  const restartLimit = lvlf[26]!
  let q = p + LVLF_SIZE
  const pap = emptyPap(0)
  for (const s of readSprms(table.subarray(q, q + cbPapx))) applyPap(s, pap)
  q += cbPapx
  const chp = emptyChp()
  for (const s of readSprms(table.subarray(q, q + cbChpx))) applyChp(s, chp, fonts)
  q += cbChpx
  if (q + 2 > table.length) return null
  const cch = u16(table, q)
  q += 2
  const chars: string[] = []
  for (let i = 0; i < cch && q + i * 2 + 1 < table.length; i++)
    chars.push(String.fromCharCode(u16(table, q + i * 2)))
  q += cch * 2
  for (const pos of placeholders) {
    if (pos === 0 || pos > chars.length) continue
    const code = chars[pos - 1]!.charCodeAt(0)
    if (code < 9) chars[pos - 1] = `%${code + 1}`
  }
  const { style: _, ...pPr } = pap.props
  const { style: __, ...rPr } = chp.props
  return {
    level: {
      start,
      format: nfc === 0xff ? 'none' : (NUMBER_FORMATS[nfc] ?? 'decimal'),
      text: chars.join(''),
      restart: flags & 0x08 ? restartLimit : null,
      legal: (flags & 0x04) !== 0,
      suffix: SUFFIXES[follow] ?? 'tab',
      align: ALIGNS[flags & 3]!,
      style: styleOf,
      pPr,
      rPr,
    },
    next: q,
  }
}

/**
 * PlfLst（列表数与各 LSTF，其后为全部 LVL）与 PlfLfo（LFO 数与各 LFO，其后为各 LFO 的覆盖数据）。
 * 结构不完整的部分不读取。
 */
export function readLists(
  table: Uint8Array,
  lst: { fc: number; lcb: number },
  lfo: { fc: number; lcb: number },
  fonts: readonly string[],
): NumberingDefs {
  const abstracts = new Map<number, AbstractNum>()
  const nums = new Map<number, NumInstance>()
  const byLsid = new Map<number, number>()
  if (lst.lcb >= 2 && lst.fc + lst.lcb <= table.length) {
    const count = u16(table, lst.fc)
    let p = lst.fc + 2 + count * LSTF_SIZE
    for (let i = 0; i < count; i++) {
      const lstf = table.subarray(lst.fc + 2 + i * LSTF_SIZE, lst.fc + 2 + (i + 1) * LSTF_SIZE)
      if (lstf.length < LSTF_SIZE) break
      const simple = (lstf[26]! & 1) !== 0
      const levels = new Map<number, Level>()
      for (let k = 0; k < (simple ? 1 : 9); k++) {
        const istd = u16(lstf, 8 + k * 2)
        const read = readLevel(table, p, istd === ISTD_NIL ? null : String(istd), fonts)
        if (read === null) break
        levels.set(k, read.level)
        p = read.next
      }
      abstracts.set(i, { levels, numStyleLink: null })
      byLsid.set(u32(lstf, 0), i)
    }
  }
  if (lfo.lcb >= 4 && lfo.fc + lfo.lcb <= table.length) {
    const count = u32(table, lfo.fc)
    let p = lfo.fc + 4 + count * LFO_SIZE
    for (let i = 0; i < count && lfo.fc + 4 + (i + 1) * LFO_SIZE <= table.length; i++) {
      const at = lfo.fc + 4 + i * LFO_SIZE
      const abstractId = byLsid.get(u32(table, at))
      const levels = table[at + 12]!
      const overrides = new Map<number, LevelOverride>()
      // 各 LFO 的覆盖数据：字符位置（4 字节）之后为各级别的 LFOLVL（8 字节），覆盖格式时其后为 LVL。
      // 同时覆盖起始值与格式时起始值取 LVL 中的值。
      p += 4
      for (let k = 0; k < levels && p + 8 <= table.length; k++) {
        const startAt = u32(table, p) | 0
        const bits = u32(table, p + 4)
        p += 8
        let level: Level | null = null
        if (bits & 0x20) {
          const read = readLevel(table, p, null, fonts)
          if (read === null) break
          level = read.level
          p = read.next
        }
        const start = bits & 0x10 ? (level?.start ?? startAt) : null
        overrides.set(bits & 0x0f, { start, level })
      }
      if (abstractId !== undefined) nums.set(i + 1, { abstractId, overrides })
    }
  }
  return { abstracts, nums }
}
