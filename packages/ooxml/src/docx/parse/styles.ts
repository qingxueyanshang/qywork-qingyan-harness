/**
 * 样式部件：`docDefaults` 与各样式的 `basedOn`、`pPr`、`rPr`。继承链在 `../resolve/cascade.ts` 中展开。
 *
 * - 同一标识出现多次时取第一个；`w:default` 为真的第一个段落样式与字符样式为缺省样式。
 * - 不读取 `w:link`：段落样式的标识用作 `rStyle`、字符样式的标识用作 `pStyle` 时，WPS 均按未指定样式处理
 *   （实测），链接关系不参与属性解决。
 * - 表格样式另读取表格、单元格属性与各种条件格式（`tblStylePr`）；`w:default` 为真的第一个表格样式为缺省表格样式。
 */

import { type RawParaProps, type RawRunProps, readParaProps, readRunProps } from './properties.ts'
import {
  CONDITIONS,
  type Condition,
  type RawCellProps,
  type RawTableProps,
  readCellProps,
  readTableProps,
} from './table.ts'
import { eachChild, onOff, type Scanner, skip, wAttr } from './xml.ts'

export type StyleType = 'paragraph' | 'character' | 'table' | 'numbering'

/** 表格样式中的一层格式：整表或一种条件格式。 */
export interface TableFormat {
  readonly pPr: RawParaProps
  readonly rPr: RawRunProps
  readonly tblPr: RawTableProps
  readonly tcPr: RawCellProps
}

export interface StyleDef {
  readonly id: string
  readonly type: StyleType
  readonly basedOn: string | null
  readonly pPr: RawParaProps
  readonly rPr: RawRunProps
  /** 表格样式的表格与单元格属性；其他类型为空。 */
  readonly tblPr: RawTableProps
  readonly tcPr: RawCellProps
  readonly conditions: Partial<Record<Condition, TableFormat>>
}

export interface Styles {
  readonly defaultRun: RawRunProps
  readonly defaultParagraph: RawParaProps
  readonly byId: ReadonlyMap<string, StyleDef>
  readonly defaultParagraphStyle: string | null
  readonly defaultCharacterStyle: string | null
  readonly defaultTableStyle: string | null
}

export const EMPTY_STYLES: Styles = {
  defaultRun: {},
  defaultParagraph: {},
  byId: new Map(),
  defaultParagraphStyle: null,
  defaultCharacterStyle: null,
  defaultTableStyle: null,
}

const CONDITION_SET = new Set<string>(CONDITIONS)

function readTableFormat(x: Scanner): TableFormat {
  let pPr: RawParaProps = {}
  let rPr: RawRunProps = {}
  let tblPr: RawTableProps = {}
  let tcPr: RawCellProps = {}
  eachChild(x, (local) => {
    if (local === 'pPr') pPr = readParaProps(x)
    else if (local === 'rPr') rPr = readRunProps(x)
    else if (local === 'tblPr') tblPr = readTableProps(x)
    else if (local === 'tcPr') tcPr = readCellProps(x)
    else skip(x)
  })
  return { pPr, rPr, tblPr, tcPr }
}

const STYLE_TYPES = new Set<string>(['paragraph', 'character', 'table', 'numbering'])

function readStyle(x: Scanner): StyleDef | null {
  const id = wAttr(x, 'styleId')
  const type = wAttr(x, 'type') ?? 'paragraph'
  let basedOn: string | null = null
  let pPr: RawParaProps = {}
  let rPr: RawRunProps = {}
  let tblPr: RawTableProps = {}
  let tcPr: RawCellProps = {}
  const conditions: Partial<Record<Condition, TableFormat>> = {}
  eachChild(x, (local) => {
    if (local === 'basedOn') {
      basedOn = wAttr(x, 'val')
      skip(x)
    } else if (local === 'pPr') pPr = readParaProps(x)
    else if (local === 'rPr') rPr = readRunProps(x)
    else if (local === 'tblPr') tblPr = readTableProps(x)
    else if (local === 'tcPr') tcPr = readCellProps(x)
    else if (local === 'tblStylePr') {
      const kind = wAttr(x, 'type') ?? ''
      const format = readTableFormat(x)
      if (CONDITION_SET.has(kind)) conditions[kind as Condition] = format
    } else skip(x)
  })
  if (id === null || !STYLE_TYPES.has(type)) return null
  return { id, type: type as StyleType, basedOn, pPr, rPr, tblPr, tcPr, conditions }
}

/** 根元素为 `styles` 的部件。 */
export function readStyles(x: Scanner): Styles {
  let defaultRun: RawRunProps = {}
  let defaultParagraph: RawParaProps = {}
  const byId = new Map<string, StyleDef>()
  let defaultParagraphStyle: string | null = null
  let defaultCharacterStyle: string | null = null
  let defaultTableStyle: string | null = null
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2) continue
    if (x.local === 'docDefaults') {
      eachChild(x, (local) => {
        eachChild(x, (inner) => {
          if (local === 'rPrDefault' && inner === 'rPr') defaultRun = readRunProps(x)
          else if (local === 'pPrDefault' && inner === 'pPr') defaultParagraph = readParaProps(x)
          else skip(x)
        })
      })
    } else if (x.local === 'style') {
      const isDefault = wAttr(x, 'default') !== null && onOff(x, 'default')
      const style = readStyle(x)
      if (style === null || byId.has(style.id)) continue
      byId.set(style.id, style)
      if (isDefault && style.type === 'paragraph' && defaultParagraphStyle === null)
        defaultParagraphStyle = style.id
      if (isDefault && style.type === 'character' && defaultCharacterStyle === null)
        defaultCharacterStyle = style.id
      if (isDefault && style.type === 'table' && defaultTableStyle === null)
        defaultTableStyle = style.id
    }
  }
  return {
    defaultRun,
    defaultParagraph,
    byId,
    defaultParagraphStyle,
    defaultCharacterStyle,
    defaultTableStyle,
  }
}
