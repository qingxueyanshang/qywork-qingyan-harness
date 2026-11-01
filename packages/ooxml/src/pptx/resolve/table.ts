/**
 * 表格求值：表格样式按区域叠加到单元格的填充、边框与文字，单元格自身的设置覆盖样式。
 *
 * - 区域按优先级从低到高：`wholeTbl`、`band1V`/`band2V`、`band1H`/`band2H`、`lastCol`、`firstCol`、`lastRow`、`firstRow`、
 *   `seCell`、`swCell`、`neCell`、`nwCell`；各区域只在 `tblPr` 打开对应开关时生效。
 *   条带从标题行（列）之后起算，首行（列）与末行（列）不参与条带。
 * - 边框：单元格的某条边位于区域外沿时取该区域的 `left`/`right`/`top`/`bottom`，位于区域内部时取 `insideH`/`insideV`。
 *   条带的区域为单行（单列），角单元格为单个单元格。单元格自身的 `lnL` 等按字段覆盖样式边框。
 * - 样式 ID 在表格样式部件中不存在时（内置样式未写入文件）取 `table-styles.gen.ts` 收录的定义；
 *   也未收录时不应用样式，计入 `tableStyle`。
 * - 单元格文字的列表样式依次为：单元格 `lstStyle`、表格样式的文字、母版 `otherStyle`；不再回落到 `defaultTextStyle`
 *   （WPS 实测：单元格取其他样式的字号，其他样式未指定的字体不取默认文本样式）。
 */

import {
  type FillSpec,
  type Line,
  type LineSpec,
  mergeLine,
  resolveFill,
  resolveLine,
  type ShapeFill,
} from '../../drawingml/fill.ts'
import { matrixFill, matrixLine } from '../../drawingml/shape/resolve.ts'
import type { ListStyleSpec, RawTextBody, RunSpec } from '../../drawingml/text/read.ts'
import { resolveTextBody } from '../../drawingml/text/resolve.ts'
import type { Relationships } from '../../opc/package.ts'
import { PartScanner } from '../../opc/scanner.ts'
import type { TableBorders, TableCell, TableRow } from '../model.ts'
import {
  type BorderSide,
  type RawTable,
  readTableStyles,
  type StyleValue,
  type TableStyle,
  type TableStylePart,
} from '../parse/table.ts'
import type { SlideScope } from './scope.ts'
import { BUILTIN_TABLE_STYLES } from './table-styles.gen.ts'

interface Region {
  readonly part: TableStylePart
  readonly rows: readonly [number, number]
  readonly cols: readonly [number, number]
}

const NONE: ShapeFill = { kind: 'none' }
const EMPTY_TEXT: RawTextBody = { body: {}, listStyle: null, paragraphs: [] }
const SIDES: readonly BorderSide[] = [
  'left',
  'right',
  'top',
  'bottom',
  'diagonalDown',
  'diagonalUp',
]

function regions(
  style: TableStyle,
  raw: RawTable,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): Region[] {
  const lastRow = raw.rows.length - 1
  const lastCol = raw.columns.length - 1
  const f = raw.flags
  const out: Region[] = []
  const add = (name: string, rows: [number, number], cols: [number, number]) => {
    const part = style.parts.get(name)
    if (part !== undefined) out.push({ part, rows, cols })
  }
  const all: [number, number] = [0, Math.max(0, lastRow)]
  const allCols: [number, number] = [0, Math.max(0, lastCol)]
  add('wholeTbl', all, allCols)
  const inFirstCol = f.firstColumn && c0 === 0
  const inLastCol = f.lastColumn && c1 === lastCol
  const inFirstRow = f.firstRow && r0 === 0
  const inLastRow = f.lastRow && r1 === lastRow
  if (f.bandColumns && !inFirstCol && !inLastCol) {
    const band = (c0 - (f.firstColumn ? 1 : 0)) % 2 === 0 ? 'band1V' : 'band2V'
    add(band, all, [c0, c1])
  }
  if (f.bandRows && !inFirstRow && !inLastRow) {
    const band = (r0 - (f.firstRow ? 1 : 0)) % 2 === 0 ? 'band1H' : 'band2H'
    add(band, [r0, r1], allCols)
  }
  if (inLastCol) add('lastCol', all, [lastCol, lastCol])
  if (inFirstCol) add('firstCol', all, [0, 0])
  if (inLastRow) add('lastRow', [lastRow, lastRow], allCols)
  if (inFirstRow) add('firstRow', [0, 0], allCols)
  if (inLastRow && inLastCol) add('seCell', [r0, r1], [c0, c1])
  if (inLastRow && inFirstCol) add('swCell', [r0, r1], [c0, c1])
  if (inFirstRow && inLastCol) add('neCell', [r0, r1], [c0, c1])
  if (inFirstRow && inFirstCol) add('nwCell', [r0, r1], [c0, c1])
  return out
}

function styleBorder(
  list: readonly Region[],
  side: BorderSide,
  r0: number,
  c0: number,
  r1: number,
  c1: number,
): StyleValue<LineSpec> | undefined {
  let found: StyleValue<LineSpec> | undefined
  for (const { part, rows, cols } of list) {
    let key: keyof TableStylePart['borders'] = side
    if (side === 'top' && r0 !== rows[0]) key = 'insideH'
    else if (side === 'bottom' && r1 !== rows[1]) key = 'insideH'
    else if (side === 'left' && c0 !== cols[0]) key = 'insideV'
    else if (side === 'right' && c1 !== cols[1]) key = 'insideV'
    const v = part.borders[key]
    if (v !== undefined) found = v
  }
  return found
}

function border(
  style: StyleValue<LineSpec> | undefined,
  own: LineSpec | undefined,
  scope: SlideScope,
): Line | null {
  if (style === undefined && own === undefined) return null
  let spec: LineSpec = {}
  let colors = scope.colors
  if (style?.kind === 'value') spec = style.value
  else if (style?.kind === 'ref') ({ spec, colors } = matrixLine(scope, style.idx, style.color))
  if (own !== undefined) spec = mergeLine(spec, own)
  return resolveLine(spec, colors)
}

function styleFillValue(v: StyleValue<FillSpec>, scope: SlideScope): ShapeFill {
  if (v.kind === 'ref') return matrixFill(scope, v.idx, v.color)
  const fill = resolveFill(v.value, scope.colors)
  return fill.kind === 'group' ? NONE : fill
}

function textStyle(list: readonly Region[]): ListStyleSpec | null {
  const run: { -readonly [K in keyof RunSpec]: RunSpec[K] } = {}
  let any = false
  for (const { part } of list) {
    const t = part.text
    if (t === null) continue
    any = true
    if (t.bold !== undefined) run.bold = t.bold
    if (t.italic !== undefined) run.italic = t.italic
    if (t.latin !== undefined) run.latin = t.latin
    if (t.ea !== undefined) run.ea = t.ea
    if (t.cs !== undefined) run.cs = t.cs
    if (t.color !== undefined) run.fill = { kind: 'solid', color: t.color }
  }
  if (!any) return null
  return { levels: Array.from({ length: 9 }, () => ({ run })) }
}

const NO_RELATIONSHIPS: Relationships = {
  source: '',
  list: [],
  byId: () => null,
  ofKind: () => [],
  part: () => null,
}
const builtinStyles = new Map<string, TableStyle | null>()

/** 收录的内置表格样式；未收录时为 `null`。解析结果按 ID 缓存。 */
function builtinTableStyle(id: string): TableStyle | null {
  const cached = builtinStyles.get(id)
  if (cached !== undefined) return cached
  const xml = Object.hasOwn(BUILTIN_TABLE_STYLES, id) ? BUILTIN_TABLE_STYLES[id] : undefined
  let style: TableStyle | null = null
  if (xml !== undefined) {
    const doc = `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${xml}</a:tblStyleLst>`
    style =
      readTableStyles(new PartScanner(doc), { rels: NO_RELATIONSHIPS, found: [] }).get(id) ?? null
  }
  builtinStyles.set(id, style)
  return style
}

export interface ResolvedTable {
  readonly rows: readonly TableRow[]
  readonly fill: ShapeFill
  readonly styleId: string | null
}

export function resolveTable(raw: RawTable, scope: SlideScope): ResolvedTable {
  const styleId = raw.styleId
  let style = raw.inlineStyle
  if (style === null && styleId !== null) {
    style = scope.tableStyles.get(styleId) ?? builtinTableStyle(styleId)
    if (style === null) scope.found.push('tableStyle')
  }
  const other = scope.master.textStyles?.other ?? null
  const rows: TableRow[] = raw.rows.map((row, r) => ({
    height: row.height,
    cells: row.cells.map((cell, c): TableCell => {
      const r1 = r + Math.max(1, cell.rowSpan) - 1
      const c1 = c + Math.max(1, cell.gridSpan) - 1
      const list = style === null ? [] : regions(style, raw, r, c, r1, c1)
      const borders = Object.fromEntries(
        SIDES.map((side) => [
          side,
          border(styleBorder(list, side, r, c, r1, c1), cell.borders[side], scope),
        ]),
      ) as unknown as TableBorders
      let fill: ShapeFill = NONE
      if (cell.fill !== null) {
        const own = resolveFill(cell.fill, scope.colors)
        fill = own.kind === 'group' ? NONE : own
      } else {
        for (const { part } of list) if (part.fill !== null) fill = styleFillValue(part.fill, scope)
      }
      const text = resolveTextBody(cell.text ?? EMPTY_TEXT, {
        theme: scope.theme,
        colors: scope.colors,
        listStyles: [textStyle(list), other],
        bodies: [],
      })
      return {
        text,
        gridSpan: cell.gridSpan,
        rowSpan: cell.rowSpan,
        hMerge: cell.hMerge,
        vMerge: cell.vMerge,
        marginLeft: cell.marginLeft,
        marginRight: cell.marginRight,
        marginTop: cell.marginTop,
        marginBottom: cell.marginBottom,
        anchor: cell.anchor,
        anchorCenter: cell.anchorCenter,
        vertical: cell.vertical,
        fill,
        borders,
      }
    }),
  }))
  let fill: ShapeFill = NONE
  if (raw.fill !== null) {
    const own = resolveFill(raw.fill, scope.colors)
    fill = own.kind === 'group' ? NONE : own
  } else if (style?.background) {
    fill = styleFillValue(style.background, scope)
  }
  return { rows, fill, styleId }
}
