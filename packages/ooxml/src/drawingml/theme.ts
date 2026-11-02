/**
 * 主题部件的颜色方案、字体方案与格式方案。
 *
 * - 只读取 `themeElements` 下的 `clrScheme`、`fontScheme` 与 `fmtScheme`；`extraClrSchemeLst` 与 `objectDefaults` 不读取。
 * - 元素按本地名匹配，不限定前缀；`AlternateContent` 取 `Fallback`。
 * - 颜色槽位取其中第一个颜色元素并施加变换。槽位缺失、颜色无法解析或引用主题色（`schemeClr`）时为 `null`。
 * - 字体只取字体名：`latin`、`ea`、`cs` 的 `typeface`，缺失时为空串；按文种的 `font` 记入 `scripts`（`script` → `typeface`），
 *   同一文种出现多次时取第一个。
 * - 格式方案的样式保留 `ColorSpec`：其中的 `phClr` 由引用处（`fillRef`、`lnRef`、`effectRef`、`bgRef`）的颜色决定，
 *   引用时按 `styleFill`、`styleLine`、`styleEffect` 取出后再求值。图片填充按传入的主题关系表解析图片部件。
 * - XML 结构错误时抛出 `XmlSyntaxError`，由调用方归入文件损坏。
 */

import type { Relationships } from '../opc/package.ts'
import { PartScanner } from '../opc/scanner.ts'
import {
  applyTransforms,
  type Color,
  type ColorScheme,
  isColorElement,
  readColor,
  SCHEME_SLOTS,
  type SchemeSlot,
} from './color.ts'
import {
  type EffectSpec,
  type FillSpec,
  isFillElement,
  type LineSpec,
  type Reader,
  readEffects,
  readFill,
  readLine,
} from './fill.ts'
import type { Scene3D, Shape3D } from './three/model.ts'
import { readScene3D, readShape3D } from './three/read.ts'

export interface FontCollection {
  readonly latin: string
  readonly ea: string
  readonly cs: string
  /** 文种代码（如 `Hans`、`Jpan`、`Arab`）到字体名。 */
  readonly scripts: ReadonlyMap<string, string>
}

export interface FontScheme {
  readonly name: string
  readonly major: FontCollection
  readonly minor: FontCollection
}

export interface EffectStyle {
  readonly effects: readonly EffectSpec[]
  /** 样式中的 `scene3d` 与 `sp3d`；未写出时为 `null`。 */
  readonly scene3d: Scene3D | null
  readonly shape3d: Shape3D | null
}

/** 各列表按文档顺序；`fmtScheme` 缺失时均为空。 */
export interface FormatScheme {
  readonly name: string
  readonly fills: readonly FillSpec[]
  readonly lines: readonly LineSpec[]
  readonly effects: readonly EffectStyle[]
  readonly backgroundFills: readonly FillSpec[]
}

export interface Theme {
  readonly name: string
  readonly colorSchemeName: string
  readonly colors: ColorScheme
  readonly fonts: FontScheme
  readonly formats: FormatScheme
}

/** 没有主题部件时求值所用的主题：颜色槽位均为 `null`，字体名为空串，格式方案为空。 */
export const EMPTY_THEME: Theme = {
  name: '',
  colorSchemeName: '',
  colors: Object.fromEntries(SCHEME_SLOTS.map((s) => [s, null])) as unknown as ColorScheme,
  fonts: {
    name: '',
    major: { latin: '', ea: '', cs: '', scripts: new Map() },
    minor: { latin: '', ea: '', cs: '', scripts: new Map() },
  },
  formats: { name: '', fills: [], lines: [], effects: [], backgroundFills: [] },
}

interface MutableFonts {
  latin: string
  ea: string
  cs: string
  scripts: Map<string, string>
}

const SLOT_SET = new Set<string>(SCHEME_SLOTS)

function emptyFonts(): MutableFonts {
  return { latin: '', ea: '', cs: '', scripts: new Map() }
}

function readEffectStyle(x: Reader): EffectStyle {
  const depth = x.depth
  let effects: EffectSpec[] = []
  let scene3d: Scene3D | null = null
  let shape3d: Shape3D | null = null
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.depth !== depth + 1) continue
    if (x.local === 'effectLst') effects = readEffects(x)
    else if (x.local === 'effectDag') effects = [{ kind: 'other', name: 'effectDag' }]
    else if (x.local === 'scene3d') scene3d = readScene3D(x)
    else if (x.local === 'sp3d') shape3d = readShape3D(x)
  }
  return { effects, scene3d, shape3d }
}

/**
 * 读取主题部件，或图表的主题覆盖部件（根元素为 `themeOverride`，结构相同而没有 `themeElements` 一层）。
 * `relationships` 为主题部件的关系表，只用于格式方案中的图片填充；缺省时图片部件为 `null`。
 */
export function parseTheme(xml: string, relationships: Relationships | null = null): Theme {
  const x = new PartScanner(xml)
  let name = ''
  let colorSchemeName = ''
  let fontSchemeName = ''
  let formatSchemeName = ''
  const colors = Object.fromEntries(SCHEME_SLOTS.map((s) => [s, null])) as Record<
    SchemeSlot,
    Color | null
  >
  const seen = new Set<string>()
  const major = emptyFonts()
  const minor = emptyFonts()
  const fills: FillSpec[] = []
  const lines: LineSpec[] = []
  const effects: EffectStyle[] = []
  const backgroundFills: FillSpec[] = []
  // 每层最近一个开始标签的本地名：处理某个元素时，`at[1..depth-1]` 即其祖先。
  const at: string[] = []
  // 主题覆盖（`a:themeOverride`）的三种方案直接位于根元素之下：按多一层 `themeElements` 处理。
  let shift = 0
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start') continue
    const local = x.local
    if (x.depth === 1) {
      name = x.attr('name') ?? ''
      if (local === 'themeOverride') {
        shift = 1
        at[2] = 'themeElements'
      }
      continue
    }
    const depth = x.depth + shift
    at[depth] = local
    if (depth < 3 || at[2] !== 'themeElements') continue
    const section = at[3]
    if (depth === 3) {
      if (local === 'clrScheme') colorSchemeName = x.attr('name') ?? ''
      else if (local === 'fontScheme') fontSchemeName = x.attr('name') ?? ''
      else if (local === 'fmtScheme') formatSchemeName = x.attr('name') ?? ''
    } else if (depth === 5 && section === 'clrScheme') {
      const slot = at[4]!
      if (!SLOT_SET.has(slot) || seen.has(slot) || !isColorElement(local)) continue
      seen.add(slot)
      const spec = readColor(x)
      colors[slot as SchemeSlot] =
        spec?.kind === 'rgb' ? applyTransforms(spec.color, spec.transforms) : null
    } else if (depth === 5 && section === 'fontScheme') {
      const fonts = at[4] === 'majorFont' ? major : at[4] === 'minorFont' ? minor : null
      if (fonts === null) continue
      const typeface = x.attr('typeface') ?? ''
      if (local === 'latin') fonts.latin = typeface
      else if (local === 'ea') fonts.ea = typeface
      else if (local === 'cs') fonts.cs = typeface
      else if (local === 'font') {
        const script = x.attr('script')
        if (script !== null && !fonts.scripts.has(script)) fonts.scripts.set(script, typeface)
      }
    } else if (depth === 5 && section === 'fmtScheme') {
      const list = at[4]
      if (list === 'fillStyleLst' && isFillElement(local)) fills.push(readFill(x, relationships))
      else if (list === 'bgFillStyleLst' && isFillElement(local))
        backgroundFills.push(readFill(x, relationships))
      else if (list === 'lnStyleLst' && local === 'ln') lines.push(readLine(x, relationships))
      else if (list === 'effectStyleLst' && local === 'effectStyle')
        effects.push(readEffectStyle(x))
    }
  }
  return {
    name,
    colorSchemeName,
    colors,
    fonts: { name: fontSchemeName, major, minor },
    formats: { name: formatSchemeName, fills, lines, effects, backgroundFills },
  }
}

/**
 * 样式矩阵索引（`fillRef` 与 `bgRef` 的 `idx`）对应的填充：0 与 1000 为无填充，1–999 为 `fillStyleLst` 的第 idx 项，
 * 1001 起为 `bgFillStyleLst` 的第 idx − 1000 项。无填充或索引超出列表时为 `null`。
 */
export function styleFill(formats: FormatScheme, idx: number): FillSpec | null {
  if (idx >= 1001) return formats.backgroundFills[idx - 1001] ?? null
  if (idx >= 1 && idx <= 999) return formats.fills[idx - 1] ?? null
  return null
}

/** `lnRef` 的 `idx`：0 为无线条，1 起为 `lnStyleLst` 的第 idx 项；超出列表时为 `null`。 */
export function styleLine(formats: FormatScheme, idx: number): LineSpec | null {
  return idx >= 1 ? (formats.lines[idx - 1] ?? null) : null
}

/** `effectRef` 的 `idx`：0 为无效果，1 起为 `effectStyleLst` 的第 idx 项；超出列表时为 `null`。 */
export function styleEffect(formats: FormatScheme, idx: number): EffectStyle | null {
  return idx >= 1 ? (formats.effects[idx - 1] ?? null) : null
}
