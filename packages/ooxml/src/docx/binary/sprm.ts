/**
 * .doc 的属性修改（sprm）：sprm 序列的遍历，字符、段落与节属性的换算。
 *
 * - 操作码的高 3 位（spra）给出操作数长度：0、1 为 1 字节，2、4、5 为 2 字节，3 为 4 字节，7 为 3 字节，6 为变长
 *   （其后 1 字节为长度）。sprmTDefTable 的长度为其后 2 字节的值减 1；sprmPChgTabs 的长度字节为 255 时按其中的
 *   删除数与新增数计算。操作数超出序列末尾时停止遍历。
 * - 字符属性换算为 `RawRunProps`，段落属性换算为 `RawParaProps`，单位与 docx 的原值相同（缇、百分之一字符或行、磅），
 *   继承由 `../resolve/cascade.ts` 解决。字符样式以 istd 的十进制串为样式标识。
 * - 切换属性（粗体等）的操作数 0、1 为绝对值；128 为样式中的值，129 为样式中的值取反，记入 `ChpState.relative`，
 *   由调用方按样式求值。
 * - 颜色：`ico` 为 16 色调色板的下标（0 为自动），COLORREF 的第 4 字节为 0xFF 时为自动。
 */

import { languageTag } from '../../text/index.ts'
import type {
  FontRef,
  RawBorder,
  RawBorders,
  RawFrame,
  RawParaProps,
  RawRunProps,
  RawTab,
  Toggle,
} from '../parse/properties.ts'

export interface Sprm {
  readonly op: number
  readonly data: Uint8Array
}

const TDEF_TABLE = 0xd608
const PCHG_TABS = 0xc615

/** sprm 序列中的各项；操作数不完整的项及其后的内容不列出。 */
export function readSprms(grpprl: Uint8Array): Sprm[] {
  const out: Sprm[] = []
  let p = 0
  while (p + 2 <= grpprl.length) {
    const op = grpprl[p]! | (grpprl[p + 1]! << 8)
    let start = p + 2
    let size: number
    switch (op >> 13) {
      case 0:
      case 1:
        size = 1
        break
      case 2:
      case 4:
      case 5:
        size = 2
        break
      case 3:
        size = 4
        break
      case 7:
        size = 3
        break
      default:
        if (op === TDEF_TABLE) {
          if (start + 2 > grpprl.length) return out
          size = (grpprl[start]! | (grpprl[start + 1]! << 8)) - 1
          start += 2
        } else {
          if (start + 1 > grpprl.length) return out
          size = grpprl[start]!
          start += 1
          if (op === PCHG_TABS && size === 255 && start < grpprl.length) {
            const del = grpprl[start]!
            const add = grpprl[start + 1 + del * 4] ?? 0
            size = 2 + del * 4 + add * 3
          }
        }
    }
    if (size < 0 || start + size > grpprl.length) return out
    out.push({ op, data: grpprl.subarray(start, start + size) })
    p = start + size
  }
  return out
}

export function u16(d: Uint8Array, at = 0): number {
  return (d[at] ?? 0) | ((d[at + 1] ?? 0) << 8)
}

export function i16(d: Uint8Array, at = 0): number {
  const v = u16(d, at)
  return v >= 0x8000 ? v - 0x10000 : v
}

export function u32(d: Uint8Array, at = 0): number {
  return (u16(d, at) + u16(d, at + 2) * 0x10000) >>> 0
}

/** 16 色调色板（`ico` 1–16）；0 为自动颜色。 */
const ICO: readonly (string | null)[] = [
  null,
  '#000000',
  '#0000ff',
  '#00ffff',
  '#00ff00',
  '#ff00ff',
  '#ff0000',
  '#ffff00',
  '#ffffff',
  '#000080',
  '#008080',
  '#008000',
  '#800080',
  '#800000',
  '#808000',
  '#808080',
  '#c0c0c0',
]

export function icoColor(ico: number): string | null {
  return ICO[ico] ?? null
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/** COLORREF：红、绿、蓝各 1 字节，第 4 字节为 0xFF 时为自动颜色（`null`）。 */
export function colorRef(d: Uint8Array, at = 0): string | null {
  if ((d[at + 3] ?? 0) === 0xff) return null
  return `#${hex2(d[at] ?? 0)}${hex2(d[at + 1] ?? 0)}${hex2(d[at + 2] ?? 0)}`
}

/**
 * 底纹的填充色，与 docx 的 `w:shd` 相同的取法：图案为纯色（1）时取前景色，其余取背景色；颜色为自动时为无。
 */
function shadeOf(fore: string | null, back: string | null, pattern: number): string | null {
  return pattern === 1 ? fore : back
}

/** SHD80（2 字节）：前景、背景的 `ico` 与图案。 */
export function shd80(d: Uint8Array, at = 0): string | null {
  const v = u16(d, at)
  return shadeOf(icoColor(v & 0x1f), icoColor((v >> 5) & 0x1f), v >> 10)
}

/** SHD（10 字节）：前景、背景的 COLORREF 与图案；图案为 0xFFFF 时为无底纹。 */
export function shd(d: Uint8Array, at = 0): string | null {
  const pattern = u16(d, at + 8)
  if (pattern === 0xffff) return null
  return shadeOf(colorRef(d, at), colorRef(d, at + 4), pattern)
}

/** 边框类型到 `ST_Border` 的线型；64 起为艺术型边框，记为 `art`。 */
const BORDER_TYPES: Readonly<Record<number, string>> = {
  1: 'single',
  2: 'thick',
  3: 'double',
  5: 'single',
  6: 'dotted',
  7: 'dashed',
  8: 'dotDash',
  9: 'dotDotDash',
  10: 'triple',
  11: 'thinThickSmallGap',
  12: 'thickThinSmallGap',
  13: 'thinThickThinSmallGap',
  14: 'thinThickMediumGap',
  15: 'thickThinMediumGap',
  16: 'thinThickThinMediumGap',
  17: 'thinThickLargeGap',
  18: 'thickThinLargeGap',
  19: 'thinThickThinLargeGap',
  20: 'wave',
  21: 'doubleWave',
  22: 'dashSmallGap',
  23: 'dashDotStroked',
  24: 'threeDEmboss',
  25: 'threeDEngrave',
  26: 'outset',
  27: 'inset',
}

/** 边框类型的线型；0、0xFF（无）与未定义的类型为 `null`。 */
export function borderStyle(type: number): string | null {
  if (type === 0 || type === 0xff) return null
  return type >= 64 ? 'art' : (BORDER_TYPES[type] ?? null)
}

function borderOf(
  width: number,
  type: number,
  color: string | null,
  space: number,
): RawBorder | null {
  const style = borderStyle(type)
  return style === null ? null : { style, width: width / 8, color, space }
}

/** BRC80（4 字节）：线宽（八分之一磅）、类型、`ico` 与间距（磅）；全为 0xFF 时为无。 */
export function brc80(d: Uint8Array, at = 0): RawBorder | null {
  if (u32(d, at) === 0xffffffff) return null
  return borderOf(d[at] ?? 0, d[at + 1] ?? 0, icoColor(d[at + 2] ?? 0), (d[at + 3] ?? 0) & 0x1f)
}

/** BRC（8 字节）：COLORREF、线宽、类型与间距。 */
export function brc(d: Uint8Array, at = 0): RawBorder | null {
  if (u32(d, at + 4) === 0xffffffff) return null
  return borderOf(d[at + 4] ?? 0, d[at + 5] ?? 0, colorRef(d, at), (d[at + 6] ?? 0) & 0x1f)
}

/** 下划线类型到 `ST_Underline`。 */
const UNDERLINES: Readonly<Record<number, string>> = {
  0: 'none',
  1: 'single',
  2: 'words',
  3: 'double',
  4: 'dotted',
  6: 'thick',
  7: 'dash',
  9: 'dotDash',
  10: 'dotDotDash',
  11: 'wave',
  20: 'dottedHeavy',
  23: 'dashedHeavy',
  25: 'dashDotHeavy',
  26: 'dashDotDotHeavy',
  27: 'wavyHeavy',
  39: 'dashLong',
  43: 'wavyDouble',
  55: 'dashLongHeavy',
}

const EMPHASIS = ['none', 'dot', 'comma', 'circle', 'underDot']

/** 字符属性的切换项与操作码。 */
const TOGGLE_SPRMS: ReadonlyMap<number, Toggle> = new Map([
  [0x0835, 'b'],
  [0x0836, 'i'],
  [0x0837, 'strike'],
  [0x0838, 'outline'],
  [0x0839, 'shadow'],
  [0x083a, 'smallCaps'],
  [0x083b, 'caps'],
  [0x083c, 'vanish'],
  [0x0854, 'imprint'],
  [0x0858, 'emboss'],
  [0x085c, 'bCs'],
  [0x085d, 'iCs'],
])

export interface ChpState {
  props: RawRunProps
  /** 操作数为 128（`false`：取样式中的值）或 129（`true`：取反）的切换属性。 */
  readonly relative: Map<Toggle, boolean>
  /** `fSpec`：字符为特殊字符（图片、对象锚点、脚注引用等）。 */
  special: boolean
  /** 删除的修订文字（不显示）。 */
  deleted: boolean
  /** 插入的修订。 */
  inserted: boolean
  /** OLE 对象（`fOle2`）。 */
  ole: boolean
  /** `sprmCSymbol`：以 `font` 绘制的字符 `char`。 */
  symbol: { readonly font: string; readonly char: number } | null
  /** `sprmCPicLocation`：图片字符（0x01）的 PICF 在 `Data` 流中的位置。 */
  picture: number | null
}

export function emptyChp(): ChpState {
  return {
    props: {},
    relative: new Map(),
    special: false,
    deleted: false,
    inserted: false,
    ole: false,
    symbol: null,
    picture: null,
  }
}

/** 字体表下标到字体引用；下标无效时为 `undefined`。 */
function fontRef(fonts: readonly string[], ftc: number): FontRef | undefined {
  const name = fonts[ftc]
  return name === undefined || name === '' ? undefined : { name }
}

/**
 * 字符属性 sprm。`fonts` 为字体表（下标为 ftc）。sprmCPlain 清除此前的直接格式（含字符样式），保留 `special`。
 * 未换算的 sprm 不改变属性。
 */
export function applyChp(s: Sprm, st: ChpState, fonts: readonly string[]): void {
  const d = s.data
  const p = st.props
  const toggle = TOGGLE_SPRMS.get(s.op)
  if (toggle !== undefined) {
    const v = d[0]!
    if (v === 0 || v === 1) {
      p[toggle] = v === 1
      st.relative.delete(toggle)
    } else if (v === 0x80 || v === 0x81) {
      delete p[toggle]
      st.relative.set(toggle, v === 0x81)
    }
    return
  }
  switch (s.op) {
    case 0x2a53:
      p.dstrike = d[0] !== 0
      break
    case 0x2a33:
      st.props = {}
      st.relative.clear()
      break
    case 0x4a30:
      p.style = String(u16(d))
      break
    case 0x4a43:
      p.size = u16(d) / 2
      break
    case 0x4a61:
      p.sizeCs = u16(d) / 2
      break
    case 0x4a4f: {
      const f = fontRef(fonts, u16(d))
      if (f) p.ascii = f
      break
    }
    case 0x4a50: {
      const f = fontRef(fonts, u16(d))
      if (f) p.eastAsia = f
      break
    }
    case 0x4a51: {
      const f = fontRef(fonts, u16(d))
      if (f) p.hAnsi = f
      break
    }
    case 0x4a5e: {
      const f = fontRef(fonts, u16(d))
      if (f) p.cs = f
      break
    }
    case 0x286f:
      p.hint = d[0] === 1 ? 'eastAsia' : 'default'
      break
    case 0x2a42:
      p.color = icoColor(d[0]!)
      break
    case 0x6870:
      p.color = colorRef(d)
      break
    case 0x2a3e:
      p.underline = { style: UNDERLINES[d[0]!] ?? 'single', color: p.underline?.color ?? null }
      break
    case 0x6877:
      p.underline = { style: p.underline?.style ?? 'none', color: colorRef(d) }
      break
    case 0x8840:
      p.spacing = i16(d)
      break
    case 0x4845:
      p.position = i16(d)
      break
    case 0x2a48:
      p.vertAlign = d[0] === 1 ? 'superscript' : d[0] === 2 ? 'subscript' : 'baseline'
      break
    case 0x484b:
      p.kern = u16(d)
      break
    case 0x4852:
      p.scale = u16(d)
      break
    case 0x2a34:
      p.emphasis = EMPHASIS[d[0]! & 7] ?? 'none'
      break
    case 0x2a0c:
      p.highlight = icoColor(d[0]!)
      break
    case 0x4866:
      p.shading = shd80(d)
      break
    case 0xca71:
      p.shading = shd(d)
      break
    case 0x486e:
    case 0x4874:
      p.eastAsiaLanguage = languageTag(u16(d))
      break
    case 0x085a:
      p.rtl = d[0] !== 0
      break
    case 0x0882:
      p.complexScript = d[0] !== 0
      break
    case 0xca76:
      p.fitText = true
      break
    case 0xca78:
      // 中文版式：前两个字节的低 3 位为纵横混排、双行合一与合并字符。
      p.eastAsianLayout = (u16(d) & 0x7) !== 0
      break
    case 0x0855:
      st.special = d[0] !== 0
      break
    case 0x0800:
      st.deleted = d[0] !== 0
      break
    case 0x0801:
      st.inserted = d[0] !== 0
      break
    case 0x080a:
      st.ole = d[0] !== 0
      break
    case 0x6a09: {
      const font = fonts[u16(d)]
      st.symbol = font === undefined ? null : { font, char: u16(d, 2) }
      break
    }
    case 0x6a03:
      st.picture = u32(d)
      break
  }
}

const JUSTIFICATION = [
  'left',
  'center',
  'right',
  'both',
  'distribute',
  'mediumKashida',
  'left',
  'highKashida',
  'lowKashida',
  'thaiDistribute',
]

/** 制表位的对齐与前导符。 */
const TAB_ALIGN = ['left', 'center', 'right', 'decimal', 'bar', 'left', 'left', 'left']
const TAB_LEADER = ['none', 'dot', 'hyphen', 'underscore', 'heavy', 'middleDot', 'none', 'none']

export interface PapState {
  props: RawParaProps
  inTable: boolean
  /** 表格行结束段落（`fTtp`）。 */
  ttp: boolean
  /** 表格嵌套深度；未给出时为 `null`，由 `inTable` 决定。 */
  itap: number | null
  /** 嵌套表格的单元格结束与行结束段落。 */
  innerCell: boolean
  innerTtp: boolean
  /** sprmPHugePapx：`Data` 流中完整 sprm 序列的位置。 */
  huge: number | null
  /** 表格属性 sprm，按出现顺序。 */
  readonly tap: Sprm[]
}

export function emptyPap(istd: number): PapState {
  return {
    props: { style: String(istd) },
    inTable: false,
    ttp: false,
    itap: null,
    innerCell: false,
    innerTtp: false,
    huge: null,
    tap: [],
  }
}

/** sprmPChgTabsPapx 与 sprmPChgTabs：删除的位置记为 `clear`，其后为新增的制表位。 */
function readTabs(s: Sprm): RawTab[] {
  const d = s.data
  const out: RawTab[] = []
  const del = d[0] ?? 0
  let p = 1
  for (let i = 0; i < del; i++) out.push({ val: 'clear', pos: i16(d, p + i * 2), leader: null })
  p += del * (s.op === PCHG_TABS ? 4 : 2)
  const add = d[p] ?? 0
  p += 1
  for (let i = 0; i < add; i++) {
    const tbd = d[p + add * 2 + i] ?? 0
    const pos = i16(d, p + i * 2)
    const leader = TAB_LEADER[(tbd >> 3) & 7]!
    out.push({ val: TAB_ALIGN[tbd & 7]!, pos, leader: leader === 'none' ? null : leader })
  }
  return out
}

/** sprmPPc 的纵向（第 4–5 位）与横向（第 6–7 位）基准；3 为不改变。 */
const FRAME_V_ANCHORS = ['margin', 'page', 'text'] as const
const FRAME_H_ANCHORS = ['text', 'margin', 'page'] as const
/** XAS、YAS 中表示对齐的值。 */
const FRAME_X_ALIGNS = new Map([
  [-4, 'center'],
  [-8, 'right'],
  [-12, 'inside'],
  [-16, 'outside'],
])
const FRAME_Y_ALIGNS = new Map([
  [-4, 'top'],
  [-8, 'center'],
  [-12, 'bottom'],
  [-16, 'inside'],
  [-20, 'outside'],
])
/** sprmPWr 的取值；0 为缺省（`auto`），不记录。 */
const FRAME_WRAPS = ['auto', 'notBeside', 'around', 'none', 'tight', 'through']

/**
 * 图文框 sprm 换算为 `RawFrame` 的项（docx `framePr` 的取值，缇）：sprmPDxaAbs、sprmPDyaAbs 为对齐或偏移，sprmPWHeightAbs 的
 * 第 15 位为最小值、低 15 位为 0 时高度为自动，sprmPDcs 的低 3 位为首字下沉方式。
 */
function framePart(op: number, d: Uint8Array): RawFrame {
  switch (op) {
    case 0x261b: {
      const v = FRAME_V_ANCHORS[(d[0]! >> 4) & 3]
      const h = FRAME_H_ANCHORS[(d[0]! >> 6) & 3]
      return {
        ...(v === undefined ? {} : { vAnchor: v }),
        ...(h === undefined ? {} : { hAnchor: h }),
      }
    }
    case 0x8418: {
      const align = FRAME_X_ALIGNS.get(i16(d))
      return align === undefined ? { x: i16(d) } : { xAlign: align }
    }
    case 0x8419: {
      const align = FRAME_Y_ALIGNS.get(i16(d))
      return align === undefined ? { y: i16(d) } : { yAlign: align }
    }
    case 0x841a:
      return { w: u16(d) }
    case 0x442b: {
      const h = u16(d) & 0x7fff
      return { h, hRule: h === 0 ? 'auto' : u16(d) & 0x8000 ? 'atLeast' : 'exact' }
    }
    case 0x442c: {
      const kind = d[0]! & 7
      return { dropCap: kind === 1 ? 'drop' : kind === 2 ? 'margin' : 'none' }
    }
    case 0x2423: {
      const wrap = FRAME_WRAPS[d[0]!]
      return d[0] === 0 || wrap === undefined ? {} : { wrap }
    }
    case 0x842e:
      return { vSpace: u16(d) }
    default:
      return { hSpace: u16(d) }
  }
}

function setBorder(p: RawParaProps, side: keyof RawBorders, b: RawBorder | null): void {
  p.borders = { ...p.borders, [side]: b }
}

/** 段落属性 sprm；表格属性（sgc 为 5）记入 `tap`。未换算的 sprm 不改变属性。 */
export function applyPap(s: Sprm, st: PapState): void {
  const d = s.data
  const p = st.props
  if (((s.op >> 10) & 7) === 5) {
    st.tap.push(s)
    return
  }
  const flag = d[0] !== 0
  switch (s.op) {
    case 0x4600:
      p.style = String(u16(d))
      break
    case 0x2403:
    case 0x2461:
      p.jc = JUSTIFICATION[d[0]!] ?? 'left'
      break
    case 0x2405:
      p.keepLines = flag
      break
    case 0x2406:
      p.keepNext = flag
      break
    case 0x2407:
      p.pageBreakBefore = flag
      break
    case 0x2431:
      p.widowControl = flag
      break
    case 0x2433:
      p.kinsoku = flag
      break
    case 0x2434:
      p.wordWrap = flag
      break
    case 0x2435:
      p.overflowPunct = flag
      break
    case 0x2437:
      p.autoSpaceDE = flag
      break
    case 0x2438:
      p.autoSpaceDN = flag
      break
    case 0x2447:
      p.snapToGrid = flag
      break
    case 0x246d:
      p.contextualSpacing = flag
      break
    case 0x2441:
      p.bidi = flag
      break
    case 0x260a:
      p.ilvl = d[0]!
      break
    case 0x460b: {
      const ilfo = i16(d)
      p.numId = ilfo > 0 && ilfo < 2047 ? ilfo : 0
      break
    }
    case 0x840e:
    case 0x845d:
      p.ind = { ...p.ind, right: i16(d) }
      break
    case 0x840f:
    case 0x845e:
      p.ind = { ...p.ind, left: i16(d) }
      break
    case 0x8411:
    case 0x8460: {
      const v = i16(d)
      const { firstLine: _f, hanging: _h, ...rest } = p.ind ?? {}
      p.ind = v < 0 ? { ...rest, hanging: -v } : { ...rest, firstLine: v }
      break
    }
    case 0x4455:
      p.ind = { ...p.ind, rightChars: i16(d) }
      break
    case 0x4456:
      p.ind = { ...p.ind, leftChars: i16(d) }
      break
    case 0x4457: {
      const v = i16(d)
      const { firstLineChars: _f, hangingChars: _h, ...rest } = p.ind ?? {}
      p.ind = v < 0 ? { ...rest, hangingChars: -v } : { ...rest, firstLineChars: v }
      break
    }
    case 0xa413:
      p.spacing = { ...p.spacing, before: u16(d) }
      break
    case 0xa414:
      p.spacing = { ...p.spacing, after: u16(d) }
      break
    case 0x4458:
      p.spacing = { ...p.spacing, beforeLines: i16(d) }
      break
    case 0x4459:
      p.spacing = { ...p.spacing, afterLines: i16(d) }
      break
    case 0x245b:
      p.spacing = { ...p.spacing, beforeAuto: flag }
      break
    case 0x245c:
      p.spacing = { ...p.spacing, afterAuto: flag }
      break
    case 0x6412: {
      const line = i16(d)
      const multiple = i16(d, 2) === 1
      p.spacing = {
        ...p.spacing,
        line: multiple ? line : Math.abs(line),
        lineRule: multiple ? 'auto' : line < 0 ? 'exact' : 'atLeast',
      }
      break
    }
    case 0xc60d:
    case PCHG_TABS:
      p.tabs = [...(p.tabs ?? []), ...readTabs(s)]
      break
    case 0x442d:
      p.shading = shd80(d)
      break
    case 0xc64d:
      p.shading = shd(d)
      break
    case 0x6424:
      setBorder(p, 'top', brc80(d))
      break
    case 0x6425:
      setBorder(p, 'left', brc80(d))
      break
    case 0x6426:
      setBorder(p, 'bottom', brc80(d))
      break
    case 0x6427:
      setBorder(p, 'right', brc80(d))
      break
    case 0xc64e:
      setBorder(p, 'top', brc(d))
      break
    case 0xc64f:
      setBorder(p, 'left', brc(d))
      break
    case 0xc650:
      setBorder(p, 'bottom', brc(d))
      break
    case 0xc651:
      setBorder(p, 'right', brc(d))
      break
    case 0x261b:
    case 0x8418:
    case 0x8419:
    case 0x841a:
    case 0x442b:
    case 0x442c:
    case 0x2423:
    case 0x842e:
    case 0x842f:
      p.frame = { ...p.frame, ...framePart(s.op, d) }
      break
    case 0x443a:
      if (u16(d) !== 0) p.textDirection = 'tbRl'
      break
    case 0x2416:
      st.inTable = flag
      break
    case 0x2417:
      st.ttp = flag
      break
    case 0x6649:
      st.itap = u32(d)
      break
    case 0x244b:
      st.innerCell = flag
      break
    case 0x244c:
      st.innerTtp = flag
      break
    case 0x6646:
      st.huge = u32(d)
      break
  }
}

/** 节属性：缺少的项取标准节属性（Letter 纵向，左右 1800、上下 1440 缇，页眉页脚 720 缇）。 */
export interface SepState {
  start: number
  titlePage: boolean
  columns: number
  columnSpace: number
  evenlySpaced: boolean
  columnWidths: Map<number, number>
  columnSpacings: Map<number, number>
  numberFormat: number
  numberStart: number
  restart: boolean
  lineNumbers: boolean
  pageWidth: number
  pageHeight: number
  left: number
  right: number
  top: number
  bottom: number
  gutter: number
  header: number
  footer: number
  gridType: number
  linePitch: number
  textFlow: number
  borders: {
    top?: RawBorder | null
    left?: RawBorder | null
    bottom?: RawBorder | null
    right?: RawBorder | null
  }
  borderOptions: number
}

export function emptySep(): SepState {
  return {
    start: 2,
    titlePage: false,
    columns: 1,
    columnSpace: 720,
    evenlySpaced: true,
    columnWidths: new Map(),
    columnSpacings: new Map(),
    numberFormat: 0,
    numberStart: 1,
    restart: false,
    lineNumbers: false,
    pageWidth: 12240,
    pageHeight: 15840,
    left: 1800,
    right: 1800,
    top: 1440,
    bottom: 1440,
    gutter: 0,
    header: 720,
    footer: 720,
    gridType: 0,
    linePitch: 0,
    textFlow: 0,
    borders: {},
    borderOptions: 0,
  }
}

export function applySep(s: Sprm, st: SepState): void {
  const d = s.data
  switch (s.op) {
    case 0x3009:
      st.start = d[0]!
      break
    case 0x300a:
      st.titlePage = d[0] !== 0
      break
    case 0x500b:
      st.columns = u16(d) + 1
      break
    case 0x900c:
      st.columnSpace = i16(d)
      break
    case 0x3005:
      st.evenlySpaced = d[0] !== 0
      break
    case 0xf203:
      st.columnWidths.set(d[0]!, i16(d, 1))
      break
    case 0xf204:
      st.columnSpacings.set(d[0]!, i16(d, 1))
      break
    case 0x300e:
      st.numberFormat = d[0]!
      break
    case 0x501c:
      st.numberStart = u16(d)
      break
    case 0x3011:
      st.restart = d[0] !== 0
      break
    case 0x5015:
      st.lineNumbers = u16(d) !== 0
      break
    case 0xb01f:
      st.pageWidth = u16(d)
      break
    case 0xb020:
      st.pageHeight = u16(d)
      break
    case 0xb021:
      st.left = i16(d)
      break
    case 0xb022:
      st.right = i16(d)
      break
    case 0x9023:
      st.top = i16(d)
      break
    case 0x9024:
      st.bottom = i16(d)
      break
    case 0xb025:
      st.gutter = u16(d)
      break
    case 0xb017:
      st.header = u16(d)
      break
    case 0xb018:
      st.footer = u16(d)
      break
    case 0x5032:
      st.gridType = u16(d)
      break
    case 0x9031:
      st.linePitch = i16(d)
      break
    case 0x5033:
      st.textFlow = u16(d)
      break
    case 0x702b:
      st.borders.top = brc80(d)
      break
    case 0x702c:
      st.borders.left = brc80(d)
      break
    case 0x702d:
      st.borders.bottom = brc80(d)
      break
    case 0x702e:
      st.borders.right = brc80(d)
      break
    case 0xd234:
      st.borders.top = brc(d)
      break
    case 0xd235:
      st.borders.left = brc(d)
      break
    case 0xd236:
      st.borders.bottom = brc(d)
      break
    case 0xd237:
      st.borders.right = brc(d)
      break
    case 0x522f:
      st.borderOptions = u16(d)
      break
  }
}
