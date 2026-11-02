/**
 * 字段属性（`rPr`）与段落属性（`pPr`）的读取：只记录元素中出现的项，继承在 `../resolve/cascade.ts` 中解决。
 *
 * - 单位保持文件原值：缩进、间距、制表位为缇（1/20 磅），`*Chars` 与 `*Lines` 为百分之一字符或行，字号为磅。
 * - `rFonts` 的同一类字体同时给出字体名与主题字体时取主题字体；四类字体逐类记录，逐类继承。
 * - 颜色只取 `w:val` 的六位十六进制值（`auto` 与主题颜色名之外的写法为 `null`）；底纹 `solid` 取前景色，其余取填充色。
 * - 影响排版但未实现的属性读出后由正文解析计数。
 */

import { eachChild, onOff, type Scanner, skip, wAttr, wNum } from './xml.ts'

export type ThemeFont =
  | 'majorAscii'
  | 'majorHAnsi'
  | 'majorEastAsia'
  | 'majorBidi'
  | 'minorAscii'
  | 'minorHAnsi'
  | 'minorEastAsia'
  | 'minorBidi'

export type FontRef = { readonly theme: ThemeFont } | { readonly name: string }

/** 切换属性（ISO/IEC 29500-1 §17.7.3）：样式之间按异或叠加，直接格式取绝对值。 */
export const TOGGLES = [
  'b',
  'bCs',
  'i',
  'iCs',
  'caps',
  'smallCaps',
  'strike',
  'dstrike',
  'emboss',
  'imprint',
  'outline',
  'shadow',
  'vanish',
] as const

export type Toggle = (typeof TOGGLES)[number]

export type FontSlotName = 'ascii' | 'hAnsi' | 'eastAsia' | 'cs'

export type RawRunProps = {
  -readonly [K in Toggle]?: boolean
} & {
  style?: string
  ascii?: FontRef
  hAnsi?: FontRef
  eastAsia?: FontRef
  cs?: FontRef
  hint?: 'default' | 'eastAsia' | 'cs'
  size?: number
  sizeCs?: number
  complexScript?: boolean
  rtl?: boolean
  /** 字符间距（缇）。 */
  spacing?: number
  /** 字符缩放（百分数）。 */
  scale?: number
  vertAlign?: string
  /** 基线提升（半磅）。 */
  position?: number
  /** 字距调整的最小字号（半磅）；0 为不调整。 */
  kern?: number
  /** `w:lang/@w:eastAsia`。 */
  eastAsiaLanguage?: string
  /** `#rrggbb`；`null` 为自动颜色。 */
  color?: string | null
  underline?: { style: string; color: string | null }
  highlight?: string | null
  shading?: string | null
  emphasis?: string
  fitText?: boolean
  eastAsianLayout?: boolean
}

export interface RawIndent {
  left?: number
  right?: number
  firstLine?: number
  hanging?: number
  leftChars?: number
  rightChars?: number
  firstLineChars?: number
  hangingChars?: number
}

export interface RawSpacing {
  before?: number
  after?: number
  beforeLines?: number
  afterLines?: number
  beforeAuto?: boolean
  afterAuto?: boolean
  line?: number
  lineRule?: string
}

export interface RawTab {
  /** `left`、`start`、`center`、`right`、`end`、`decimal`、`bar`、`num`、`clear`。 */
  readonly val: string
  readonly pos: number
  readonly leader: string | null
}

export interface RawParaProps {
  style?: string
  numId?: number
  ilvl?: number
  jc?: string
  ind?: RawIndent
  spacing?: RawSpacing
  contextualSpacing?: boolean
  kinsoku?: boolean
  wordWrap?: boolean
  overflowPunct?: boolean
  autoSpaceDE?: boolean
  autoSpaceDN?: boolean
  snapToGrid?: boolean
  bidi?: boolean
  pageBreakBefore?: boolean
  keepNext?: boolean
  keepLines?: boolean
  widowControl?: boolean
  shading?: string | null
  borders?: RawBorders
  frame?: boolean
  textDirection?: string
  tabs?: readonly RawTab[]
}

export interface RawBorder {
  style: string
  /** 磅。 */
  width: number
  color: string | null
  /** 磅。 */
  space: number
}

/** 各边：`null` 为该边明确无边框，缺少的边沿用继承值。 */
export interface RawBorders {
  top?: RawBorder | null
  bottom?: RawBorder | null
  left?: RawBorder | null
  right?: RawBorder | null
}

/** `ST_HighlightColor` 的取值。 */
const HIGHLIGHT: Readonly<Record<string, string>> = {
  black: '#000000',
  blue: '#0000ff',
  cyan: '#00ffff',
  green: '#00ff00',
  magenta: '#ff00ff',
  red: '#ff0000',
  yellow: '#ffff00',
  white: '#ffffff',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#c0c0c0',
}

const HEX_COLOR = /^[0-9a-fA-F]{6}$/

/** 六位十六进制颜色转为 `#rrggbb`；`auto` 等其他写法为 `null`。 */
export function hexColor(v: string | null): string | null {
  return v !== null && HEX_COLOR.test(v) ? `#${v.toLowerCase()}` : null
}

/** 底纹：`nil` 为无，`solid` 取前景色，其余取填充色；颜色为 `auto` 时为无。 */
export function readShading(x: Scanner): string | null {
  const val = wAttr(x, 'val') ?? 'clear'
  if (val === 'nil') return null
  return hexColor(val === 'solid' ? wAttr(x, 'color') : wAttr(x, 'fill'))
}

/** 边框的边：`start`、`end` 为 `left`、`right` 的别名。 */
export type BorderSide = 'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV'

const SIDE_NAMES: Readonly<Record<string, BorderSide>> = {
  top: 'top',
  left: 'left',
  start: 'left',
  bottom: 'bottom',
  right: 'right',
  end: 'right',
  insideH: 'insideH',
  insideV: 'insideV',
}

/**
 * 读取 `pBdr`、`tblBorders`、`tcBorders`、`pgBorders` 的各边，返回时位于其结束标签。`none` 与 `nil` 为明确无边框（`null`）；
 * `spaced` 为真（段落边框）时带非零 `space` 的 `none` 记为线型 `none`、线宽 0 的边框，保留其占用的高度（见
 * `../layout.ts` 的 `borderExtents`）。线宽 `sz` 为八分之一磅；艺术型边框（`w:val` 为艺术图案名）同样记录其名称与宽度。
 */
export function readBorderSides(
  x: Scanner,
  spaced = false,
): Partial<Record<BorderSide, RawBorder | null>> {
  const out: Partial<Record<BorderSide, RawBorder | null>> = {}
  eachChild(x, (local) => {
    const side = SIDE_NAMES[local]
    if (side !== undefined) {
      const val = wAttr(x, 'val') ?? 'none'
      const space = wNum(x, 'space') ?? 0
      const none = val === 'none' || val === 'nil'
      out[side] =
        none && !(spaced && space > 0)
          ? null
          : {
              style: none ? 'none' : val,
              width: none ? 0 : (wNum(x, 'sz') ?? 4) / 8,
              color: hexColor(wAttr(x, 'color')),
              space,
            }
    }
    skip(x)
  })
  return out
}

function readBorders(x: Scanner): RawBorders {
  const sides = readBorderSides(x, true)
  const out: RawBorders = {}
  for (const side of ['top', 'bottom', 'left', 'right'] as const) {
    const b = sides[side]
    if (b !== undefined) out[side] = b
  }
  return out
}

const THEME_FONTS = new Set<string>([
  'majorAscii',
  'majorHAnsi',
  'majorEastAsia',
  'majorBidi',
  'minorAscii',
  'minorHAnsi',
  'minorEastAsia',
  'minorBidi',
])

const FONT_ATTRS: readonly (readonly [FontSlotName, string, string])[] = [
  ['ascii', 'ascii', 'asciiTheme'],
  ['hAnsi', 'hAnsi', 'hAnsiTheme'],
  ['eastAsia', 'eastAsia', 'eastAsiaTheme'],
  ['cs', 'cs', 'cstheme'],
]

const TOGGLE_SET = new Set<string>(TOGGLES)

function isToggle(local: string): local is Toggle {
  return TOGGLE_SET.has(local)
}

function readFonts(x: Scanner, out: RawRunProps): void {
  for (const [slot, nameAttr, themeAttr] of FONT_ATTRS) {
    const theme = wAttr(x, themeAttr)
    const name = wAttr(x, nameAttr)
    if (theme !== null && THEME_FONTS.has(theme)) out[slot] = { theme: theme as ThemeFont }
    else if (name !== null) out[slot] = { name }
  }
  const hint = wAttr(x, 'hint')
  if (hint === 'default' || hint === 'eastAsia' || hint === 'cs') out.hint = hint
}

/** 读取当前 `rPr` 元素，返回时位于其结束标签。 */
export function readRunProps(x: Scanner): RawRunProps {
  const out: RawRunProps = {}
  eachChild(x, (local) => {
    if (isToggle(local)) {
      out[local] = onOff(x)
      skip(x)
      return
    }
    switch (local) {
      case 'rStyle': {
        const v = wAttr(x, 'val')
        if (v !== null) out.style = v
        break
      }
      case 'rFonts':
        readFonts(x, out)
        break
      case 'sz': {
        const v = wNum(x, 'val')
        if (v !== null) out.size = v / 2
        break
      }
      case 'szCs': {
        const v = wNum(x, 'val')
        if (v !== null) out.sizeCs = v / 2
        break
      }
      case 'cs':
        out.complexScript = onOff(x)
        break
      case 'rtl':
        out.rtl = onOff(x)
        break
      case 'spacing': {
        const v = wNum(x, 'val')
        if (v !== null) out.spacing = v
        break
      }
      case 'w': {
        const v = wNum(x, 'val')
        if (v !== null) out.scale = v
        break
      }
      case 'vertAlign': {
        const v = wAttr(x, 'val')
        if (v !== null) out.vertAlign = v
        break
      }
      case 'position': {
        const v = wNum(x, 'val')
        if (v !== null) out.position = v
        break
      }
      case 'kern': {
        const v = wNum(x, 'val')
        if (v !== null) out.kern = v
        break
      }
      case 'lang': {
        const v = wAttr(x, 'eastAsia')
        if (v !== null) out.eastAsiaLanguage = v
        break
      }
      case 'em': {
        const v = wAttr(x, 'val')
        if (v !== null) out.emphasis = v
        break
      }
      case 'fitText':
        out.fitText = true
        break
      case 'color':
        if (wAttr(x, 'val') !== null) out.color = hexColor(wAttr(x, 'val'))
        break
      case 'u':
        out.underline = { style: wAttr(x, 'val') ?? 'single', color: hexColor(wAttr(x, 'color')) }
        break
      case 'highlight': {
        const v = wAttr(x, 'val')
        if (v !== null) out.highlight = HIGHLIGHT[v] ?? null
        break
      }
      case 'shd':
        out.shading = readShading(x)
        break
      case 'eastAsianLayout':
        out.eastAsianLayout = wAttr(x, 'combine') !== null || wAttr(x, 'vert') !== null
        break
    }
    skip(x)
  })
  return out
}

function readIndent(x: Scanner): RawIndent {
  const out: RawIndent = {}
  const pairs: readonly (readonly [keyof RawIndent, string, string | null])[] = [
    ['left', 'left', 'start'],
    ['right', 'right', 'end'],
    ['firstLine', 'firstLine', null],
    ['hanging', 'hanging', null],
    ['leftChars', 'leftChars', 'startChars'],
    ['rightChars', 'rightChars', 'endChars'],
    ['firstLineChars', 'firstLineChars', null],
    ['hangingChars', 'hangingChars', null],
  ]
  for (const [key, name, alias] of pairs) {
    const v = wNum(x, name) ?? (alias === null ? null : wNum(x, alias))
    if (v !== null) out[key] = v
  }
  return out
}

function readSpacing(x: Scanner): RawSpacing {
  const out: RawSpacing = {}
  for (const key of ['before', 'after', 'beforeLines', 'afterLines', 'line'] as const) {
    const v = wNum(x, key)
    if (v !== null) out[key] = v
  }
  const rule = wAttr(x, 'lineRule')
  if (rule !== null) out.lineRule = rule
  if (wAttr(x, 'beforeAutospacing') !== null) out.beforeAuto = onOff(x, 'beforeAutospacing')
  if (wAttr(x, 'afterAutospacing') !== null) out.afterAuto = onOff(x, 'afterAutospacing')
  return out
}

function readTabs(x: Scanner): RawTab[] {
  const tabs: RawTab[] = []
  eachChild(x, (local) => {
    if (local !== 'tab') return
    const val = wAttr(x, 'val')
    const pos = wNum(x, 'pos')
    if (val !== null && pos !== null) tabs.push({ val, pos, leader: wAttr(x, 'leader') })
  })
  return tabs
}

const PARA_FLAGS = [
  'contextualSpacing',
  'kinsoku',
  'wordWrap',
  'overflowPunct',
  'autoSpaceDE',
  'autoSpaceDN',
  'snapToGrid',
  'bidi',
  'pageBreakBefore',
  'keepNext',
  'keepLines',
  'widowControl',
] as const

type ParaFlag = (typeof PARA_FLAGS)[number]

const PARA_FLAG_SET = new Set<string>(PARA_FLAGS)

function isParaFlag(local: string): local is ParaFlag {
  return PARA_FLAG_SET.has(local)
}

export interface ParagraphPropertiesHandlers {
  /** `pPr/rPr`：段落标记的字段属性。 */
  mark?: (props: RawRunProps) => void
  /** `pPr/sectPr`：回调须读到其结束标签为止。 */
  section?: () => void
}

/** 读取当前 `pPr` 元素，返回时位于其结束标签。 */
export function readParaProps(
  x: Scanner,
  handlers: ParagraphPropertiesHandlers = {},
): RawParaProps {
  const out: RawParaProps = {}
  eachChild(x, (local) => {
    if (isParaFlag(local)) {
      out[local] = onOff(x)
      skip(x)
      return
    }
    switch (local) {
      case 'pStyle': {
        const v = wAttr(x, 'val')
        if (v !== null) out.style = v
        break
      }
      case 'numPr':
        eachChild(x, (inner) => {
          const v = wNum(x, 'val')
          if (v === null) return
          if (inner === 'numId') out.numId = v
          else if (inner === 'ilvl') out.ilvl = v
        })
        return
      case 'jc': {
        const v = wAttr(x, 'val')
        if (v !== null) out.jc = v
        break
      }
      case 'ind':
        out.ind = readIndent(x)
        break
      case 'spacing':
        out.spacing = readSpacing(x)
        break
      case 'tabs':
        out.tabs = readTabs(x)
        return
      case 'framePr':
        out.frame = true
        break
      case 'shd':
        out.shading = readShading(x)
        break
      case 'pBdr':
        out.borders = readBorders(x)
        return
      case 'textDirection': {
        const v = wAttr(x, 'val')
        if (v !== null) out.textDirection = v
        break
      }
      case 'rPr':
        if (handlers.mark) {
          handlers.mark(readRunProps(x))
          return
        }
        break
      case 'sectPr':
        if (handlers.section) {
          handlers.section()
          return
        }
        break
    }
    skip(x)
  })
  return out
}
