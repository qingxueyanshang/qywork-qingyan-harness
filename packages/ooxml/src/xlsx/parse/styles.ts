/**
 * 样式表（`styles.xml`）解析为逐项求值后的单元格样式表。
 *
 * - 单元格样式取 `cellXfs` 中该项自身的 `fontId`、`fillId`、`borderId`、`numFmtId` 与 `alignment`，
 *   不按 `apply*` 属性回退到 `cellStyleXfs`：Excel 写入时已把生效的值写在 `cellXfs` 中，
 *   `apply*` 只记录用户是否改过该项。没有 `alignment` 子元素时为默认对齐（常规、靠下）。
 * - 颜色在整个样式表读完后再换算：`indexedColors` 位于样式表末尾，而字体与填充在其前引用索引色。
 * - `dxf` 中的纯色填充颜色写在 `bgColor`（与 `cellXfs` 的 `fgColor` 相反），缺失 `patternType` 时按纯色处理。
 * - 「常规」样式：`cellStyles` 中 `builtinId="0"` 的条目所指的 `cellStyleXfs` 的字体；没有时取第一个字体。
 * - 带 `scheme` 的字体（含富文本的 `rPr`）换为主题字体：`minor` 取正文字体、`major` 取标题字体，依次取 `Hans` 文种、
 *   `ea`、`latin` 中第一个非空的字体名，`name` 不参与。WPS 实测：Calibri（`scheme="minor"`、主题 `Hans` 为宋体）
 *   的西文与汉字都以宋体绘制，行高也按宋体；主题没有 `Hans` 文种且 `ea` 为空时按 `latin`。
 */

import type { Theme } from '../../drawingml/index.ts'
import { formatCodeFor } from '../../numfmt/format.ts'
import { XmlScanner } from '../../xml/index.ts'
import type {
  BorderLine,
  BorderLineStyle,
  CellAlignment,
  CellBorder,
  CellFill,
  CellStyle,
  DifferentialStyle,
  FontStyle,
  GradientStop,
  HorizontalAlign,
  PatternType,
  UnderlineStyle,
  VerticalAlign,
} from '../model.ts'
import {
  type ColorContext,
  DEFAULT_PALETTE,
  type RawColor,
  readRawColor,
  resolveRawColor,
} from './color.ts'
import { boolAttr, boolVal, numAttr, type Scanner } from './xml-util.ts'

export interface StyleSheet {
  readonly styles: readonly CellStyle[]
  readonly dxfs: readonly DifferentialStyle[]
  readonly defaultFont: FontStyle
  readonly palette: readonly string[]
  /** 供共享字符串的富文本换算颜色。 */
  readonly colors: ColorContext
  readonly fontNames: readonly string[]
}

/** 字体元素原文。布尔项与下划线缺失时为 `null`：差异样式据此区分「未指定」与「明确取消」。 */
export interface RawFont {
  name: string | null
  size: number | null
  bold: boolean | null
  italic: boolean | null
  underline: UnderlineStyle | null
  strike: boolean | null
  color: RawColor | null
  vertAlign: FontStyle['vertAlign']
  scheme: 'major' | 'minor' | null
}

type RawFill =
  | { kind: 'pattern'; pattern: string | null; fg: RawColor | null; bg: RawColor | null }
  | {
      kind: 'gradient'
      type: 'linear' | 'path'
      degree: number
      left: number
      right: number
      top: number
      bottom: number
      stops: { position: number; color: RawColor | null }[]
    }

type RawBorderSide = { style: BorderLineStyle; color: RawColor | null } | null

interface RawBorder {
  left: RawBorderSide
  right: RawBorderSide
  top: RawBorderSide
  bottom: RawBorderSide
  diagonal: RawBorderSide
  up: boolean
  down: boolean
}

interface RawXf {
  numFmtId: number
  fontId: number
  fillId: number
  borderId: number
  alignment: CellAlignment
}

interface RawDxf {
  font: RawFont | null
  fill: RawFill | null
  border: RawBorder | null
  numFmt: string | null
}

const DEFAULT_ALIGNMENT: CellAlignment = {
  horizontal: 'general',
  vertical: 'bottom',
  wrap: false,
  shrink: false,
  rotation: 0,
  indent: 0,
}

const FALLBACK_FONT: FontStyle = {
  name: 'Calibri',
  size: 11,
  bold: false,
  italic: false,
  underline: 'none',
  strike: false,
  color: null,
  vertAlign: 'baseline',
}

const BORDER_STYLES = new Set<string>([
  'thin',
  'medium',
  'thick',
  'dashed',
  'dotted',
  'double',
  'hair',
  'mediumDashed',
  'dashDot',
  'mediumDashDot',
  'dashDotDot',
  'mediumDashDotDot',
  'slantDashDot',
])

const PATTERNS = new Set<string>([
  'solid',
  'darkGray',
  'mediumGray',
  'lightGray',
  'gray125',
  'gray0625',
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
])

const HORIZONTAL = new Set<string>([
  'general',
  'left',
  'center',
  'right',
  'fill',
  'justify',
  'centerContinuous',
  'distributed',
])
const VERTICAL = new Set<string>(['top', 'center', 'bottom', 'justify', 'distributed'])

export function readFont(x: Scanner): RawFont {
  const font: RawFont = {
    name: null,
    size: null,
    bold: null,
    italic: null,
    underline: null,
    strike: null,
    color: null,
    vertAlign: 'baseline',
    scheme: null,
  }
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.depth !== depth + 1) continue
    switch (x.local) {
      case 'name':
      case 'rFont':
        font.name = x.attr('val')
        break
      case 'sz':
        font.size = numAttr(x, 'val')
        break
      case 'b':
        font.bold = boolVal(x)
        break
      case 'i':
        font.italic = boolVal(x)
        break
      case 'strike':
        font.strike = boolVal(x)
        break
      case 'u': {
        const v = x.attr('val') ?? 'single'
        font.underline =
          v === 'double' || v === 'singleAccounting' || v === 'doubleAccounting'
            ? v
            : v === 'none'
              ? 'none'
              : 'single'
        break
      }
      case 'color':
        font.color = readRawColor((n) => x.attr(n))
        break
      case 'vertAlign': {
        const v = x.attr('val')
        font.vertAlign = v === 'superscript' || v === 'subscript' ? v : 'baseline'
        break
      }
      case 'scheme': {
        const v = x.attr('val')
        font.scheme = v === 'major' || v === 'minor' ? v : null
        break
      }
    }
  }
  return font
}

function readFill(x: Scanner): RawFill | null {
  const depth = x.depth
  let fill: RawFill | null = null
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    const local = x.local
    if (local === 'patternFill') {
      fill = { kind: 'pattern', pattern: x.attr('patternType'), fg: null, bg: null }
    } else if (local === 'gradientFill') {
      const type = x.attr('type') === 'path' ? 'path' : 'linear'
      fill = {
        kind: 'gradient',
        type,
        degree: numAttr(x, 'degree') ?? 0,
        left: numAttr(x, 'left') ?? 0,
        right: numAttr(x, 'right') ?? 0,
        top: numAttr(x, 'top') ?? 0,
        bottom: numAttr(x, 'bottom') ?? 0,
        stops: [],
      }
    } else if (local === 'stop' && fill?.kind === 'gradient') {
      fill.stops.push({ position: numAttr(x, 'position') ?? 0, color: null })
    } else if (local === 'color' && fill?.kind === 'gradient') {
      const stop = fill.stops.at(-1)
      if (stop) stop.color = readRawColor((n) => x.attr(n))
    } else if (local === 'fgColor' && fill?.kind === 'pattern') {
      fill.fg = readRawColor((n) => x.attr(n))
    } else if (local === 'bgColor' && fill?.kind === 'pattern') {
      fill.bg = readRawColor((n) => x.attr(n))
    }
  }
  return fill
}

function readBorder(x: Scanner): RawBorder {
  const border: RawBorder = {
    left: null,
    right: null,
    top: null,
    bottom: null,
    diagonal: null,
    up: boolAttr(x, 'diagonalUp', false),
    down: boolAttr(x, 'diagonalDown', false),
  }
  const depth = x.depth
  let side: 'left' | 'right' | 'top' | 'bottom' | 'diagonal' | null = null
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    if (x.depth === depth + 1) {
      const local = x.local
      side =
        local === 'left' || local === 'start'
          ? 'left'
          : local === 'right' || local === 'end'
            ? 'right'
            : local === 'top' || local === 'bottom' || local === 'diagonal'
              ? local
              : null
      const style = x.attr('style')
      if (side && style && BORDER_STYLES.has(style)) {
        border[side] = { style: style as BorderLineStyle, color: null }
      } else {
        side = null
      }
    } else if (x.local === 'color' && side) {
      const current = border[side]
      if (current) current.color = readRawColor((n) => x.attr(n))
    }
  }
  return border
}

function readAlignment(x: Scanner): CellAlignment {
  const h = x.attr('horizontal') ?? 'general'
  const v = x.attr('vertical') ?? 'bottom'
  return {
    horizontal: (HORIZONTAL.has(h) ? h : 'general') as HorizontalAlign,
    vertical: (VERTICAL.has(v) ? v : 'bottom') as VerticalAlign,
    wrap: boolAttr(x, 'wrapText', false),
    shrink: boolAttr(x, 'shrinkToFit', false),
    rotation: numAttr(x, 'textRotation') ?? 0,
    indent: numAttr(x, 'indent') ?? 0,
  }
}

function readXf(x: Scanner): RawXf {
  const xf: RawXf = {
    numFmtId: numAttr(x, 'numFmtId') ?? 0,
    fontId: numAttr(x, 'fontId') ?? 0,
    fillId: numAttr(x, 'fillId') ?? 0,
    borderId: numAttr(x, 'borderId') ?? 0,
    alignment: DEFAULT_ALIGNMENT,
  }
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'start' && x.local === 'alignment') xf.alignment = readAlignment(x)
  }
  return xf
}

function readDxf(x: Scanner, numFmts: Map<number, string>): RawDxf {
  const dxf: RawDxf = { font: null, fill: null, border: null, numFmt: null }
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.depth !== depth + 1) continue
    switch (x.local) {
      case 'font':
        dxf.font = readFont(x)
        break
      case 'fill':
        dxf.fill = readFill(x)
        break
      case 'border':
        dxf.border = readBorder(x)
        break
      case 'numFmt': {
        const code = x.attr('formatCode')
        const id = numAttr(x, 'numFmtId')
        dxf.numFmt = code ?? (id === null ? null : formatCodeFor(id, numFmts))
        break
      }
    }
  }
  return dxf
}

export function parseStyles(xml: string | null, theme: Theme | null): StyleSheet {
  const numFmts = new Map<number, string>()
  const fonts: RawFont[] = []
  const fills: (RawFill | null)[] = []
  const borders: RawBorder[] = []
  const styleXfs: RawXf[] = []
  const cellXfs: RawXf[] = []
  const dxfs: RawDxf[] = []
  let normalXf: number | null = null
  let palette: string[] | null = null

  if (xml !== null) {
    const x = new XmlScanner(xml)
    let list = ''
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t !== 'start') continue
      const depth = x.depth
      if (depth === 2) {
        list = x.local
        continue
      }
      if (depth !== 3) continue
      const local = x.local
      if (list === 'numFmts' && local === 'numFmt') {
        const id = numAttr(x, 'numFmtId')
        const code = x.attr('formatCode')
        if (id !== null && code !== null) numFmts.set(id, code)
      } else if (list === 'fonts' && local === 'font') fonts.push(readFont(x))
      else if (list === 'fills' && local === 'fill') fills.push(readFill(x))
      else if (list === 'borders' && local === 'border') borders.push(readBorder(x))
      else if (list === 'cellStyleXfs' && local === 'xf') styleXfs.push(readXf(x))
      else if (list === 'cellXfs' && local === 'xf') cellXfs.push(readXf(x))
      else if (list === 'dxfs' && local === 'dxf') dxfs.push(readDxf(x, numFmts))
      else if (list === 'cellStyles' && local === 'cellStyle') {
        if (x.attr('builtinId') === '0' && normalXf === null) normalXf = numAttr(x, 'xfId')
      } else if (list === 'colors' && local === 'indexedColors') {
        palette = readPalette(x)
      }
    }
  }

  const fullPalette = palette
    ? [...palette, ...DEFAULT_PALETTE.slice(palette.length)]
    : DEFAULT_PALETTE
  const ctx: ColorContext = { palette: fullPalette, theme }
  const defaultSource = fonts[styleXfs[normalXf ?? 0]?.fontId ?? 0] ?? fonts[0]
  const defaultFont = defaultSource ? resolveFont(defaultSource, FALLBACK_FONT, ctx) : FALLBACK_FONT
  const resolvedFonts = fonts.map((f) => resolveFont(f, defaultFont, ctx))
  const resolvedFills = fills.map((f) => resolveFill(f, ctx, false))
  const resolvedBorders = borders.map((b) => resolveBorder(b, ctx))
  const xfs = cellXfs.length > 0 ? cellXfs : [readDefaultXf()]
  const styles = xfs.map(
    (xf): CellStyle => ({
      font: resolvedFonts[xf.fontId] ?? defaultFont,
      fill: resolvedFills[xf.fillId] ?? null,
      border: resolvedBorders[xf.borderId] ?? null,
      alignment: xf.alignment,
      numFmt: formatCodeFor(xf.numFmtId, numFmts),
    }),
  )
  const names = new Set<string>([defaultFont.name, ...resolvedFonts.map((f) => f.name)])
  return {
    styles,
    dxfs: dxfs.map((d) => resolveDxf(d, ctx)),
    defaultFont,
    palette: fullPalette,
    colors: ctx,
    fontNames: [...names],
  }
}

function readDefaultXf(): RawXf {
  return { numFmtId: 0, fontId: 0, fillId: 0, borderId: 0, alignment: DEFAULT_ALIGNMENT }
}

function readPalette(x: Scanner): string[] {
  const out: string[] = []
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t === 'start' && x.local === 'rgbColor') {
      const rgb = x.attr('rgb') ?? 'FF000000'
      out.push(`#${(rgb.length === 8 ? rgb.slice(2) : rgb).toLowerCase()}`)
    }
  }
  return out
}

/** 主题字体名，见文件头；没有主题或各项均为空时为 `null`。 */
function schemeFont(scheme: 'major' | 'minor', theme: Theme | null): string | null {
  if (theme === null) return null
  const set = scheme === 'major' ? theme.fonts.major : theme.fonts.minor
  return set.scripts.get('Hans') || set.ea || set.latin || null
}

/** 富文本的 `rPr` 同样经此换算：缺失的字体名与字号取 `base`。 */
export function resolveFont(raw: RawFont, base: FontStyle, ctx: ColorContext): FontStyle {
  const themed = raw.scheme === null ? null : schemeFont(raw.scheme, ctx.theme)
  return {
    name: themed ?? raw.name ?? base.name,
    size: raw.size ?? base.size,
    bold: raw.bold ?? false,
    italic: raw.italic ?? false,
    underline: raw.underline ?? 'none',
    strike: raw.strike ?? false,
    color: resolveRawColor(raw.color, ctx),
    vertAlign: raw.vertAlign,
  }
}

function resolveFill(
  raw: RawFill | null,
  ctx: ColorContext,
  differential: boolean,
): CellFill | null {
  if (raw === null) return null
  if (raw.kind === 'gradient') {
    const stops: GradientStop[] = raw.stops.map((s) => ({
      position: s.position,
      color: resolveRawColor(s.color, ctx) ?? '#ffffff',
    }))
    if (stops.length === 0) return null
    return {
      kind: 'gradient',
      type: raw.type,
      degree: raw.degree,
      left: raw.left,
      right: raw.right,
      top: raw.top,
      bottom: raw.bottom,
      stops,
    }
  }
  const pattern = raw.pattern ?? (differential ? 'solid' : 'none')
  if (!PATTERNS.has(pattern)) return null
  const fg = resolveRawColor(raw.fg, ctx)
  const bg = resolveRawColor(raw.bg, ctx)
  if (pattern === 'solid') {
    // 单元格样式取前景色；差异样式取背景色。缺失的一方用另一方补齐。
    const color = differential ? (bg ?? fg) : (fg ?? bg)
    return { kind: 'pattern', pattern: 'solid', fg: color ?? '#000000', bg: color ?? '#000000' }
  }
  return {
    kind: 'pattern',
    pattern: pattern as PatternType,
    fg: fg ?? '#000000',
    bg: bg ?? '#ffffff',
  }
}

function resolveSide(side: RawBorderSide, ctx: ColorContext): BorderLine | null {
  if (side === null) return null
  return { style: side.style, color: resolveRawColor(side.color, ctx) ?? '#000000' }
}

function resolveBorder(raw: RawBorder, ctx: ColorContext): CellBorder | null {
  const diagonal = resolveSide(raw.diagonal, ctx)
  const border: CellBorder = {
    left: resolveSide(raw.left, ctx),
    right: resolveSide(raw.right, ctx),
    top: resolveSide(raw.top, ctx),
    bottom: resolveSide(raw.bottom, ctx),
    diagonalUp: raw.up ? diagonal : null,
    diagonalDown: raw.down ? diagonal : null,
  }
  const empty =
    !border.left &&
    !border.right &&
    !border.top &&
    !border.bottom &&
    !border.diagonalUp &&
    !border.diagonalDown
  return empty ? null : border
}

function resolveDxf(raw: RawDxf, ctx: ColorContext): DifferentialStyle {
  const font = raw.font
  return {
    bold: font?.bold ?? null,
    italic: font?.italic ?? null,
    strike: font?.strike ?? null,
    underline: font?.underline ?? null,
    color: font ? resolveRawColor(font.color, ctx) : null,
    fill: resolveFill(raw.fill, ctx, true),
    border: raw.border ? resolveBorder(raw.border, ctx) : null,
    numFmt: raw.numFmt,
  }
}
