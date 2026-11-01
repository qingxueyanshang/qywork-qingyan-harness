/**
 * 表格属性（`tblPr`、`trPr`、`tcPr`）与条件格式标记（`cnfStyle`）的读取：只记录元素中出现的项，单位换算为磅。
 * 表格样式的继承与条件格式的叠加在 `../resolve/table.ts` 中解决。
 *
 * - 宽度（`tblW`、`tcW`、`tblInd`、边距）：`dxa` 为缇；`pct` 为五十分之一百分数，带 `%` 时为百分数；`auto` 与 `nil` 的值为 0。
 * - `cnfStyle` 的 `w:val` 为 12 位标记串，另有同名的各项属性；两者都给出时属性优先。
 */

import type { TableFloat, TableWidth } from '../model.ts'
import { type BorderSide, type RawBorder, readBorderSides, readShading } from './properties.ts'
import { eachChild, onOff, type Scanner, skip, wAttr, wNum } from './xml.ts'

export interface RawEdges {
  left?: number
  top?: number
  right?: number
  bottom?: number
}

export type RawTableBorders = Partial<Record<BorderSide, RawBorder | null>>

export interface RawTableProps {
  style?: string
  width?: TableWidth
  layout?: 'fixed' | 'autofit'
  indent?: number
  align?: 'left' | 'center' | 'right'
  borders?: RawTableBorders
  margins?: RawEdges
  shading?: string | null
  float?: TableFloat
}

export interface RawRowProps {
  height?: { rule: 'atLeast' | 'exact'; value: number } | null
  header?: boolean
  cantSplit?: boolean
  gridBefore?: number
  cnf?: number
}

export interface RawCellProps {
  width?: TableWidth
  span?: number
  vMerge?: 'restart' | 'continue'
  borders?: RawTableBorders
  shading?: string | null
  margins?: RawEdges
  vAlign?: 'top' | 'center' | 'bottom'
  noWrap?: boolean
  cnf?: number
}

/** 条件格式的种类（`tblStylePr/@w:type`），按叠加顺序从低到高排列。 */
export const CONDITIONS = [
  'band1Vert',
  'band2Vert',
  'band1Horz',
  'band2Horz',
  'firstCol',
  'lastCol',
  'firstRow',
  'lastRow',
  'neCell',
  'nwCell',
  'seCell',
  'swCell',
] as const

export type Condition = (typeof CONDITIONS)[number]

/** `cnfStyle` 标记串各位对应的条件格式与属性名。 */
const CNF_BITS: readonly (readonly [string, Condition])[] = [
  ['firstRow', 'firstRow'],
  ['lastRow', 'lastRow'],
  ['firstColumn', 'firstCol'],
  ['lastColumn', 'lastCol'],
  ['oddVBand', 'band1Vert'],
  ['evenVBand', 'band2Vert'],
  ['oddHBand', 'band1Horz'],
  ['evenHBand', 'band2Horz'],
  ['firstRowFirstColumn', 'nwCell'],
  ['firstRowLastColumn', 'neCell'],
  ['lastRowFirstColumn', 'swCell'],
  ['lastRowLastColumn', 'seCell'],
]

/** 条件格式在位集中的位。 */
export function conditionBit(c: Condition): number {
  return 1 << CONDITIONS.indexOf(c)
}

/** 读取 `cnfStyle`，返回条件格式的位集（`conditionBit`）。 */
function readCnf(x: Scanner): number {
  const val = wAttr(x, 'val') ?? ''
  let bits = 0
  CNF_BITS.forEach(([attr, cond], i) => {
    const own = wAttr(x, attr)
    const on = own !== null ? own === '1' || own === 'true' || own === 'on' : val[i] === '1'
    if (on) bits |= conditionBit(cond)
  })
  return bits
}

/** `tblW`、`tcW` 等：`w:w` 与 `w:type`。 */
function readWidth(x: Scanner): TableWidth {
  const type = wAttr(x, 'type') ?? 'dxa'
  const raw = wAttr(x, 'w') ?? '0'
  if (type === 'pct') {
    const pct = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw) / 5000
    return { type: 'pct', value: Number.isFinite(pct) ? pct : 0 }
  }
  if (type === 'auto' || type === 'nil') return { type, value: 0 }
  const n = Number(raw)
  return { type: 'dxa', value: Number.isFinite(n) ? n / 20 : 0 }
}

/** `tblCellMar`、`tcMar`：只取按缇给出的边。 */
function readMargins(x: Scanner): RawEdges {
  const out: RawEdges = {}
  eachChild(x, (local) => {
    const w = readWidth(x)
    const side = local === 'start' ? 'left' : local === 'end' ? 'right' : (local as keyof RawEdges)
    if (
      (side === 'left' || side === 'right' || side === 'top' || side === 'bottom') &&
      w.type === 'dxa'
    )
      out[side] = w.value
    skip(x)
  })
  return out
}

const ALIGN: Readonly<Record<string, 'left' | 'center' | 'right'>> = {
  left: 'left',
  start: 'left',
  center: 'center',
  right: 'right',
  end: 'right',
}

/** 读取当前 `tblPr` 元素，返回时位于其结束标签。 */
export function readTableProps(x: Scanner): RawTableProps {
  const out: RawTableProps = {}
  eachChild(x, (local) => {
    switch (local) {
      case 'tblStyle': {
        const v = wAttr(x, 'val')
        if (v !== null) out.style = v
        break
      }
      case 'tblW':
        out.width = readWidth(x)
        break
      case 'tblLayout':
        out.layout = wAttr(x, 'type') === 'fixed' ? 'fixed' : 'autofit'
        break
      case 'tblInd': {
        const w = readWidth(x)
        if (w.type === 'dxa') out.indent = w.value
        break
      }
      case 'jc': {
        const v = ALIGN[wAttr(x, 'val') ?? '']
        if (v !== undefined) out.align = v
        break
      }
      case 'tblBorders':
        out.borders = readBorderSides(x)
        return
      case 'tblCellMar':
        out.margins = readMargins(x)
        return
      case 'shd':
        out.shading = readShading(x)
        break
      case 'tblpPr': {
        const anchor = wAttr(x, 'horzAnchor')
        out.float = {
          from: anchor === 'page' ? 'page' : anchor === 'margin' ? 'margin' : 'text',
          x: (wNum(x, 'tblpX') ?? 0) / 20,
        }
        break
      }
    }
    skip(x)
  })
  return out
}

/** 读取当前 `trPr` 元素，返回时位于其结束标签。 */
export function readRowProps(x: Scanner): RawRowProps {
  const out: RawRowProps = {}
  eachChild(x, (local) => {
    switch (local) {
      case 'trHeight': {
        const value = (wNum(x, 'val') ?? 0) / 20
        const rule = wAttr(x, 'hRule') === 'exact' ? 'exact' : 'atLeast'
        out.height = value > 0 ? { rule, value } : null
        break
      }
      case 'tblHeader':
        out.header = onOff(x)
        break
      case 'cantSplit':
        out.cantSplit = onOff(x)
        break
      case 'gridBefore':
        out.gridBefore = Math.max(0, wNum(x, 'val') ?? 0)
        break
      case 'cnfStyle':
        out.cnf = readCnf(x)
        break
    }
    skip(x)
  })
  return out
}

const V_ALIGN: Readonly<Record<string, 'top' | 'center' | 'bottom'>> = {
  top: 'top',
  center: 'center',
  bottom: 'bottom',
}

/** 读取当前 `tcPr` 元素，返回时位于其结束标签。 */
export function readCellProps(x: Scanner): RawCellProps {
  const out: RawCellProps = {}
  eachChild(x, (local) => {
    switch (local) {
      case 'tcW':
        out.width = readWidth(x)
        break
      case 'gridSpan':
        out.span = Math.max(1, wNum(x, 'val') ?? 1)
        break
      case 'vMerge':
        out.vMerge = wAttr(x, 'val') === 'restart' ? 'restart' : 'continue'
        break
      case 'tcBorders':
        out.borders = readBorderSides(x)
        return
      case 'shd':
        out.shading = readShading(x)
        break
      case 'tcMar':
        out.margins = readMargins(x)
        return
      case 'vAlign': {
        const v = V_ALIGN[wAttr(x, 'val') ?? '']
        if (v !== undefined) out.vAlign = v
        break
      }
      case 'noWrap':
        out.noWrap = onOff(x)
        break
      case 'cnfStyle':
        out.cnf = readCnf(x)
        break
    }
    skip(x)
  })
  return out
}
