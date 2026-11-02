/**
 * OpenType `MATH` 表：排版常量、斜体校正、上方重音附着点、纵横两向的字形变体与拼装。数值一律为字体单位。
 *
 * 不读取 `MathKernInfo`（按角的字距）与设备表：本模块的排版不使用这两项。
 */

import {
  FontFormatError,
  type GlyphOutlines,
  readFaces,
  readGlyphOutlines,
  readMetrics,
  readVerticalMetrics,
  type SfntFace,
  tableBytes,
} from '../font/index.ts'
import type { TextFace } from '../text/index.ts'

/** `MathConstants` 中按顺序排列的 `MathValueRecord` 字段。 */
const VALUE_FIELDS = [
  'mathLeading',
  'axisHeight',
  'accentBaseHeight',
  'flattenedAccentBaseHeight',
  'subscriptShiftDown',
  'subscriptTopMax',
  'subscriptBaselineDropMin',
  'superscriptShiftUp',
  'superscriptShiftUpCramped',
  'superscriptBottomMin',
  'superscriptBaselineDropMax',
  'subSuperscriptGapMin',
  'superscriptBottomMaxWithSubscript',
  'spaceAfterScript',
  'upperLimitGapMin',
  'upperLimitBaselineRiseMin',
  'lowerLimitGapMin',
  'lowerLimitBaselineDropMin',
  'stackTopShiftUp',
  'stackTopDisplayStyleShiftUp',
  'stackBottomShiftDown',
  'stackBottomDisplayStyleShiftDown',
  'stackGapMin',
  'stackDisplayStyleGapMin',
  'stretchStackTopShiftUp',
  'stretchStackBottomShiftDown',
  'stretchStackGapAboveMin',
  'stretchStackGapBelowMin',
  'fractionNumeratorShiftUp',
  'fractionNumeratorDisplayStyleShiftUp',
  'fractionDenominatorShiftDown',
  'fractionDenominatorDisplayStyleShiftDown',
  'fractionNumeratorGapMin',
  'fractionNumDisplayStyleGapMin',
  'fractionRuleThickness',
  'fractionDenominatorGapMin',
  'fractionDenomDisplayStyleGapMin',
  'skewedFractionHorizontalGap',
  'skewedFractionVerticalGap',
  'overbarVerticalGap',
  'overbarRuleThickness',
  'overbarExtraAscender',
  'underbarVerticalGap',
  'underbarRuleThickness',
  'underbarExtraDescender',
  'radicalVerticalGap',
  'radicalDisplayStyleVerticalGap',
  'radicalRuleThickness',
  'radicalExtraAscender',
  'radicalKernBeforeDegree',
  'radicalKernAfterDegree',
] as const

export type MathConstantName =
  | (typeof VALUE_FIELDS)[number]
  | 'scriptPercentScaleDown'
  | 'scriptScriptPercentScaleDown'
  | 'delimitedSubFormulaMinHeight'
  | 'displayOperatorMinHeight'
  | 'radicalDegreeBottomRaisePercent'

export type MathConstants = Readonly<Record<MathConstantName, number>>

export interface GlyphVariant {
  readonly glyph: number
  /** 变体在伸展方向上的尺寸，字体单位。 */
  readonly advance: number
}

export interface GlyphPart {
  readonly glyph: number
  readonly startConnector: number
  readonly endConnector: number
  readonly fullAdvance: number
  /** 可重复的延伸段。 */
  readonly extender: boolean
}

export interface GlyphConstruction {
  /** 按尺寸升序，第一项通常是字形本身。 */
  readonly variants: readonly GlyphVariant[]
  /** 拼装：纵向自下而上、横向自左而右排列。没有拼装时为 `null`。 */
  readonly assembly: { readonly italic: number; readonly parts: readonly GlyphPart[] } | null
}

export interface MathTable {
  readonly constants: MathConstants
  readonly minConnectorOverlap: number
  /** 没有记录时为 0。 */
  italicCorrection(glyph: number): number
  /** 没有记录时为 `null`：调用方取墨迹宽度的一半。 */
  topAccentAttachment(glyph: number): number | null
  vertical(glyph: number): GlyphConstruction | null
  horizontal(glyph: number): GlyphConstruction | null
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Coverage 表：字形编号 → 覆盖序号；不在表中为 -1。 */
function coverage(v: DataView, at: number): (glyph: number) => number {
  const format = v.getUint16(at)
  if (format === 1) {
    const count = v.getUint16(at + 2)
    const glyphs = new Map<number, number>()
    for (let i = 0; i < count; i++) glyphs.set(v.getUint16(at + 4 + 2 * i), i)
    return (g) => glyphs.get(g) ?? -1
  }
  if (format === 2) {
    const count = v.getUint16(at + 2)
    const ranges: [number, number, number][] = []
    for (let i = 0; i < count; i++) {
      const r = at + 4 + 6 * i
      ranges.push([v.getUint16(r), v.getUint16(r + 2), v.getUint16(r + 4)])
    }
    return (g) => {
      for (const [start, end, index] of ranges) if (g >= start && g <= end) return index + g - start
      return -1
    }
  }
  throw new FontFormatError(`不支持的 Coverage 格式 ${format}`)
}

function valueTable(v: DataView, at: number): (glyph: number) => number | null {
  const cover = coverage(v, at + v.getUint16(at))
  const count = v.getUint16(at + 2)
  return (g) => {
    const i = cover(g)
    return i < 0 || i >= count ? null : v.getInt16(at + 4 + 4 * i)
  }
}

function construction(v: DataView, at: number): GlyphConstruction {
  const assemblyOffset = v.getUint16(at)
  const count = v.getUint16(at + 2)
  const variants: GlyphVariant[] = []
  for (let i = 0; i < count; i++) {
    const r = at + 4 + 4 * i
    variants.push({ glyph: v.getUint16(r), advance: v.getUint16(r + 2) })
  }
  let assembly: GlyphConstruction['assembly'] = null
  if (assemblyOffset !== 0) {
    const a = at + assemblyOffset
    const partCount = v.getUint16(a + 4)
    const parts: GlyphPart[] = []
    for (let i = 0; i < partCount; i++) {
      const r = a + 6 + 10 * i
      parts.push({
        glyph: v.getUint16(r),
        startConnector: v.getUint16(r + 2),
        endConnector: v.getUint16(r + 4),
        fullAdvance: v.getUint16(r + 6),
        extender: (v.getUint16(r + 8) & 1) !== 0,
      })
    }
    assembly = { italic: v.getInt16(a), parts }
  }
  return { variants, assembly }
}

/** `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。字体没有 `MATH` 表时返回 `null`。 */
export function readMathTable(bytes: Uint8Array, face: SfntFace): MathTable | null {
  if (!face.tables.has('MATH')) return null
  const table = tableBytes(bytes, face, 'MATH')
  if (table.byteLength < 10) throw new FontFormatError('MATH 表长度不足')
  const v = view(table)
  const constantsAt = v.getUint16(4)
  const infoAt = v.getUint16(6)
  const variantsAt = v.getUint16(8)
  if (constantsAt + 8 + 4 * VALUE_FIELDS.length + 2 > table.byteLength) {
    throw new FontFormatError('MathConstants 超出表范围')
  }
  const constants: Record<string, number> = {
    scriptPercentScaleDown: v.getInt16(constantsAt),
    scriptScriptPercentScaleDown: v.getInt16(constantsAt + 2),
    delimitedSubFormulaMinHeight: v.getUint16(constantsAt + 4),
    displayOperatorMinHeight: v.getUint16(constantsAt + 6),
  }
  VALUE_FIELDS.forEach((name, i) => {
    constants[name] = v.getInt16(constantsAt + 8 + 4 * i)
  })
  constants.radicalDegreeBottomRaisePercent = v.getInt16(constantsAt + 8 + 4 * VALUE_FIELDS.length)

  const info = (field: number): ((g: number) => number | null) => {
    const offset = infoAt === 0 ? 0 : v.getUint16(infoAt + field)
    return offset === 0 ? () => null : valueTable(v, infoAt + offset)
  }
  const italic = info(0)
  const accent = info(2)

  let vertical: (g: number) => GlyphConstruction | null = () => null
  let horizontal: (g: number) => GlyphConstruction | null = () => null
  let minConnectorOverlap = 0
  if (variantsAt !== 0) {
    const at = variantsAt
    minConnectorOverlap = v.getUint16(at)
    const vCover = coverage(v, at + v.getUint16(at + 2))
    const hCover = coverage(v, at + v.getUint16(at + 4))
    const vCount = v.getUint16(at + 6)
    const hCount = v.getUint16(at + 8)
    const cache = new Map<number, GlyphConstruction>()
    const read = (index: number, count: number, base: number) => {
      if (index < 0 || index >= count) return null
      const offset = at + v.getUint16(base + 2 * index)
      let c = cache.get(offset)
      if (c === undefined) {
        c = construction(v, offset)
        cache.set(offset, c)
      }
      return c
    }
    vertical = (g) => read(vCover(g), vCount, at + 10)
    horizontal = (g) => read(hCover(g), hCount, at + 10 + 2 * vCount)
  }
  return {
    constants: constants as MathConstants,
    minConnectorOverlap,
    italicCorrection: (g) => italic(g) ?? 0,
    topAccentAttachment: accent,
    vertical,
    horizontal,
  }
}

/** 数学字体：度量、轮廓与 `MATH` 表。`font` 为调用方的绘制引用，原样写入排版结果。 */
export interface MathFont<F> {
  readonly face: TextFace
  readonly outlines: GlyphOutlines
  readonly table: MathTable
  readonly font: F
}

/**
 * 读取字体文件（或 TTC 中的第 `index` 个字体）为数学字体。没有 `MATH` 表或没有 TrueType 轮廓（CFF 字体）时返回 `null`：
 * 变体字形没有码位，只能按轮廓绘制。没有 `MATH` 表时不读取轮廓，`glyf` 与 `loca` 不完整的字体同样返回 `null`；
 * 有 `MATH` 表而结构不完整时抛出 `FontFormatError`。
 */
export function readMathFont<F>(bytes: Uint8Array, index: number, font: F): MathFont<F> | null {
  const face = readFaces(bytes)[index]
  if (!face) throw new RangeError(`字体文件中没有第 ${index} 个字体`)
  const table = readMathTable(bytes, face)
  if (table === null) return null
  const outlines = readGlyphOutlines(bytes, face)
  if (outlines === null) return null
  return {
    face: { metrics: readMetrics(bytes, face), vertical: readVerticalMetrics(bytes, face) },
    outlines,
    table,
    font,
  }
}
