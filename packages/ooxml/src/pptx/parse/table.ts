/**
 * 表格：`a:tbl` 的列宽、行高、单元格（文字、合并、边距、填充、边框）与表格样式部件（`tableStyles.xml`）。
 *
 * - 只记录文档中的定义，表格样式按区域叠加到单元格在 `resolve/table.ts` 中完成。
 * - 表格样式中的边框与填充既可直接给出（`ln`、`fill`），也可引用主题格式方案（`lnRef`、`fillRef`），两者都记录为 `StyleValue`。
 */

import { type ColorSpec, isColorElement, readColor } from '../../drawingml/color.ts'
import {
  type FillSpec,
  isFillElement,
  type LineSpec,
  readFill,
  readLine,
} from '../../drawingml/fill.ts'
import { type RawTextBody, readTextBody, type TextContext } from '../../drawingml/text/read.ts'
import { bool, eachChild, int, readText, type Scanner, skip } from '../../opc/read.ts'
import type { TableFlags } from '../model.ts'

/** 直接给出的值，或主题格式方案的引用（`idx` 与替换 `phClr` 的颜色）。 */
export type StyleValue<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'ref'; readonly idx: number; readonly color: ColorSpec | null }

export type BorderSide = 'left' | 'right' | 'top' | 'bottom' | 'diagonalDown' | 'diagonalUp'

export interface RawCell {
  readonly text: RawTextBody | null
  readonly gridSpan: number
  readonly rowSpan: number
  readonly hMerge: boolean
  readonly vMerge: boolean
  readonly marginLeft: number
  readonly marginRight: number
  readonly marginTop: number
  readonly marginBottom: number
  readonly anchor: string
  readonly anchorCenter: boolean
  readonly vertical: string
  readonly fill: FillSpec | null
  readonly borders: Partial<Record<BorderSide, LineSpec>>
}

export interface RawRow {
  readonly height: number
  readonly cells: readonly RawCell[]
}

export interface RawTable {
  readonly columns: readonly number[]
  readonly rows: readonly RawRow[]
  readonly styleId: string | null
  /** `tblPr` 中内嵌的表格样式（`tableStyle`）。 */
  readonly inlineStyle: TableStyle | null
  readonly flags: TableFlags
  readonly fill: FillSpec | null
}

export type StyleBorderSide = BorderSide | 'insideH' | 'insideV'

/** `tcTxStyle`：`bold`、`italic` 缺失表示不指定；字体为字体名原文或 `fontRef` 的 `major`、`minor`。 */
export interface TableTextStyle {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly latin?: string
  readonly ea?: string
  readonly cs?: string
  readonly color?: ColorSpec | null
}

export interface TableStylePart {
  readonly text: TableTextStyle | null
  readonly borders: Partial<Record<StyleBorderSide, StyleValue<LineSpec>>>
  readonly fill: StyleValue<FillSpec> | null
}

/** 区域名：`wholeTbl`、`band1H`、`band2H`、`band1V`、`band2V`、`firstRow`、`lastRow`、`firstCol`、`lastCol`、`nwCell` 等。 */
export interface TableStyle {
  readonly id: string
  readonly background: StyleValue<FillSpec> | null
  readonly parts: ReadonlyMap<string, TableStylePart>
}

const CELL_BORDERS: Record<string, BorderSide> = {
  lnL: 'left',
  lnR: 'right',
  lnT: 'top',
  lnB: 'bottom',
  lnTlToBr: 'diagonalDown',
  lnBlToTr: 'diagonalUp',
}

const STYLE_BORDERS: Record<string, StyleBorderSide> = {
  left: 'left',
  right: 'right',
  top: 'top',
  bottom: 'bottom',
  insideH: 'insideH',
  insideV: 'insideV',
  tl2br: 'diagonalDown',
  tr2bl: 'diagonalUp',
}

function readColorChild(x: Scanner): ColorSpec | null {
  let color: ColorSpec | null = null
  let found = false
  eachChild(x, (local) => {
    if (found || !isColorElement(local)) return
    found = true
    color = readColor(x)
  })
  return color
}

function readRef(x: Scanner): { kind: 'ref'; idx: number; color: ColorSpec | null } {
  const idx = int(x, 'idx', 0)
  return { kind: 'ref', idx, color: readColorChild(x) }
}

function readCell(x: Scanner, cx: TextContext): RawCell {
  const gridSpan = int(x, 'gridSpan', 1)
  const rowSpan = int(x, 'rowSpan', 1)
  const hMerge = bool(x, 'hMerge') ?? false
  const vMerge = bool(x, 'vMerge') ?? false
  let text: RawTextBody | null = null
  let marginLeft = 91440
  let marginRight = 91440
  let marginTop = 45720
  let marginBottom = 45720
  let anchor = 't'
  let anchorCenter = false
  let vertical = 'horz'
  let fill: FillSpec | null = null
  const borders: Partial<Record<BorderSide, LineSpec>> = {}
  eachChild(x, (local) => {
    if (local === 'txBody') text = readTextBody(x, cx)
    else if (local === 'tcPr') {
      marginLeft = int(x, 'marL', marginLeft)
      marginRight = int(x, 'marR', marginRight)
      marginTop = int(x, 'marT', marginTop)
      marginBottom = int(x, 'marB', marginBottom)
      anchor = x.attr('anchor') ?? anchor
      anchorCenter = bool(x, 'anchorCtr') ?? anchorCenter
      vertical = x.attr('vert') ?? vertical
      eachChild(x, (child) => {
        const side = CELL_BORDERS[child]
        if (side !== undefined) borders[side] = readLine(x, cx.rels)
        else if (isFillElement(child)) fill = readFill(x, cx.rels)
        else if (child === 'cell3D') cx.found.push('effect3d')
      })
    }
  })
  return {
    text,
    gridSpan,
    rowSpan,
    hMerge,
    vMerge,
    marginLeft,
    marginRight,
    marginTop,
    marginBottom,
    anchor,
    anchorCenter,
    vertical,
    fill,
    borders,
  }
}

/** 在 `a:tbl` 的开始标签处调用。 */
export function readTable(x: Scanner, cx: TextContext): RawTable {
  const columns: number[] = []
  const rows: RawRow[] = []
  let styleId: string | null = null
  let inlineStyle: TableStyle | null = null
  let flags: TableFlags = {
    firstRow: false,
    firstColumn: false,
    lastRow: false,
    lastColumn: false,
    bandRows: false,
    bandColumns: false,
    rtl: false,
  }
  let fill: FillSpec | null = null
  eachChild(x, (local) => {
    if (local === 'tblPr') {
      flags = {
        firstRow: bool(x, 'firstRow') ?? false,
        firstColumn: bool(x, 'firstCol') ?? false,
        lastRow: bool(x, 'lastRow') ?? false,
        lastColumn: bool(x, 'lastCol') ?? false,
        bandRows: bool(x, 'bandRow') ?? false,
        bandColumns: bool(x, 'bandCol') ?? false,
        rtl: bool(x, 'rtl') ?? false,
      }
      eachChild(x, (child) => {
        if (child === 'tableStyleId') styleId = readText(x).trim()
        else if (child === 'tableStyle') inlineStyle = readTableStyle(x, cx)
        else if (isFillElement(child)) fill = readFill(x, cx.rels)
      })
    } else if (local === 'tblGrid') {
      eachChild(x, (col) => {
        if (col === 'gridCol') columns.push(int(x, 'w', 0))
      })
    } else if (local === 'tr') {
      const height = int(x, 'h', 0)
      const cells: RawCell[] = []
      eachChild(x, (tc) => {
        if (tc === 'tc') cells.push(readCell(x, cx))
      })
      rows.push({ height, cells })
    }
  })
  return { columns, rows, styleId, inlineStyle, flags, fill }
}

function readOnOff(x: Scanner, name: string): boolean | undefined {
  const v = x.attr(name)
  return v === 'on' ? true : v === 'off' ? false : undefined
}

function readTextStyle(x: Scanner): TableTextStyle {
  const out: { -readonly [K in keyof TableTextStyle]: TableTextStyle[K] } = {}
  const bold = readOnOff(x, 'b')
  if (bold !== undefined) out.bold = bold
  const italic = readOnOff(x, 'i')
  if (italic !== undefined) out.italic = italic
  eachChild(x, (local) => {
    if (local === 'font') {
      eachChild(x, (face) => {
        if (face !== 'latin' && face !== 'ea' && face !== 'cs') return
        const typeface = x.attr('typeface')
        if (typeface !== null) out[face] = typeface
      })
    } else if (local === 'fontRef') {
      const idx = x.attr('idx')
      const prefix = idx === 'major' ? '+mj' : idx === 'minor' ? '+mn' : null
      if (prefix !== null) {
        out.latin = `${prefix}-lt`
        out.ea = `${prefix}-ea`
        out.cs = `${prefix}-cs`
      }
      const color = readColorChild(x)
      if (color !== null) out.color = color
    } else if (isColorElement(local)) {
      out.color = readColor(x)
    }
  })
  return out
}

function readStylePart(x: Scanner, cx: TextContext): TableStylePart {
  let text: TableTextStyle | null = null
  const borders: Partial<Record<StyleBorderSide, StyleValue<LineSpec>>> = {}
  let fill: StyleValue<FillSpec> | null = null
  eachChild(x, (local) => {
    if (local === 'tcTxStyle') text = readTextStyle(x)
    else if (local === 'tcStyle') {
      eachChild(x, (child) => {
        if (child === 'tcBdr') {
          eachChild(x, (edge) => {
            const side = STYLE_BORDERS[edge]
            if (side === undefined) return
            eachChild(x, (line) => {
              if (line === 'ln') borders[side] = { kind: 'value', value: readLine(x, cx.rels) }
              else if (line === 'lnRef') borders[side] = readRef(x)
            })
          })
        } else if (child === 'fill') {
          eachChild(x, (f) => {
            if (isFillElement(f)) fill = { kind: 'value', value: readFill(x, cx.rels) }
          })
        } else if (child === 'fillRef') {
          fill = readRef(x)
        } else if (child === 'cell3D') {
          cx.found.push('effect3d')
        }
      })
    }
  })
  return { text, borders, fill }
}

/** 在 `tblStyle` 或 `tableStyle` 的开始标签处调用。 */
export function readTableStyle(x: Scanner, cx: TextContext): TableStyle {
  const id = x.attr('styleId') ?? ''
  let background: StyleValue<FillSpec> | null = null
  const parts = new Map<string, TableStylePart>()
  eachChild(x, (local) => {
    if (local === 'tblBg') {
      eachChild(x, (child) => {
        if (isFillElement(child)) background = { kind: 'value', value: readFill(x, cx.rels) }
        else if (child === 'fillRef') background = readRef(x)
        else skip(x)
      })
    } else if (local !== 'extLst') {
      parts.set(local, readStylePart(x, cx))
    }
  })
  return { id, background, parts }
}

/** `tableStyles.xml`：样式 ID 到样式。 */
export function readTableStyles(x: Scanner, cx: TextContext): Map<string, TableStyle> {
  const out = new Map<string, TableStyle>()
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 1) continue
    eachChild(x, (local) => {
      if (local !== 'tblStyle') return
      const style = readTableStyle(x, cx)
      if (!out.has(style.id)) out.set(style.id, style)
    })
    break
  }
  return out
}
