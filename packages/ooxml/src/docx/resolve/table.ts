/**
 * 表格样式：`basedOn` 链的合并、条件格式的叠加与表格、单元格属性的最终值。
 *
 * - 条件格式只按 `cnfStyle` 生效（WPS 实测：只有 `tblLook` 而没有 `cnfStyle` 的表格不显示任何条件格式；行的
 *   `cnfStyle` 使首行、末行与横向条带生效，单元格的 `cnfStyle` 使全部种类生效，段落的 `cnfStyle` 不起作用）。
 *   单元格的条件取所在行与自身 `cnfStyle` 的并集，按 `CONDITIONS` 的顺序叠加在整表格式之上。
 * - 表格属性与单元格属性逐项合并，边框与边距逐边合并；段落与字段属性按 `cascade.ts` 的合并规则。
 * - 段落属性中表格样式位于文档默认之后、段落样式之前（WPS 实测：表格样式的段后 0、单倍行距不覆盖 Normal 的
 *   段后 10 磅、1.15 倍行距，表格样式的居中对齐在 Normal 未指定对齐时生效）。
 */

import type { CellBorders, Edges, TableBorders } from '../model.ts'
import type { StyleDef, Styles, TableFormat } from '../parse/styles.ts'
import {
  CONDITIONS,
  type Condition,
  conditionBit,
  type RawCellProps,
  type RawEdges,
  type RawTableBorders,
  type RawTableProps,
} from '../parse/table.ts'
import { border, mergePara, mergeRun } from './cascade.ts'

export interface TableStyleChain {
  readonly whole: TableFormat
  readonly conditions: Partial<Record<Condition, TableFormat>>
}

const EMPTY_FORMAT: TableFormat = { pPr: {}, rPr: {}, tblPr: {}, tcPr: {} }

function mergeSides<T extends object>(base: T | undefined, over: T | undefined): T | undefined {
  if (over === undefined) return base
  return { ...base, ...over }
}

export function mergeTableProps(base: RawTableProps, over: RawTableProps): RawTableProps {
  const out: RawTableProps = { ...base, ...over }
  const borders = mergeSides<RawTableBorders>(base.borders, over.borders)
  if (borders !== undefined) out.borders = borders
  const margins = mergeSides<RawEdges>(base.margins, over.margins)
  if (margins !== undefined) out.margins = margins
  return out
}

export function mergeCellProps(base: RawCellProps, over: RawCellProps): RawCellProps {
  const out: RawCellProps = { ...base, ...over }
  const borders = mergeSides<RawTableBorders>(base.borders, over.borders)
  if (borders !== undefined) out.borders = borders
  const margins = mergeSides<RawEdges>(base.margins, over.margins)
  if (margins !== undefined) out.margins = margins
  return out
}

function mergeFormat(base: TableFormat, over: TableFormat): TableFormat {
  return {
    pPr: mergePara(base.pPr, over.pPr),
    rPr: mergeRun(base.rPr, over.rPr),
    tblPr: mergeTableProps(base.tblPr, over.tblPr),
    tcPr: mergeCellProps(base.tcPr, over.tcPr),
  }
}

/** 表格样式链自根至该样式依次合并；样式不存在或不是表格样式时为空链。链中出现环时在重复处截断。 */
export function tableStyleChain(styles: Styles, id: string | null): TableStyleChain {
  const list: StyleDef[] = []
  const seen = new Set<string>()
  for (let s = id === null ? undefined : styles.byId.get(id); s !== undefined; ) {
    if (s.type !== 'table' || seen.has(s.id)) break
    seen.add(s.id)
    list.unshift(s)
    s = s.basedOn === null ? undefined : styles.byId.get(s.basedOn)
  }
  let whole = EMPTY_FORMAT
  const conditions: Partial<Record<Condition, TableFormat>> = {}
  for (const s of list) {
    whole = mergeFormat(whole, { pPr: s.pPr, rPr: s.rPr, tblPr: s.tblPr, tcPr: s.tcPr })
    for (const c of CONDITIONS) {
      const own = s.conditions[c]
      if (own !== undefined) conditions[c] = mergeFormat(conditions[c] ?? EMPTY_FORMAT, own)
    }
  }
  return { whole, conditions }
}

/** 条件位集 `bits`（`conditionBit`）下单元格的样式层：条件格式依次叠加在整表格式之上。 */
export function cellFormat(chain: TableStyleChain, bits: number): TableFormat {
  let out = chain.whole
  for (const c of CONDITIONS) {
    const f = chain.conditions[c]
    if (f !== undefined && (bits & conditionBit(c)) !== 0) out = mergeFormat(out, f)
  }
  return out
}

export function tableBorders(raw: RawTableBorders | undefined): TableBorders {
  return {
    top: border(raw?.top),
    left: border(raw?.left),
    bottom: border(raw?.bottom),
    right: border(raw?.right),
    insideH: border(raw?.insideH),
    insideV: border(raw?.insideV),
  }
}

export function edges(raw: RawEdges | undefined, base: Edges): Edges {
  return {
    left: raw?.left ?? base.left,
    top: raw?.top ?? base.top,
    right: raw?.right ?? base.right,
    bottom: raw?.bottom ?? base.bottom,
  }
}

/**
 * 单元格明确给出的边框：直接格式逐边优先于样式层（含条件格式）。样式层的 `insideH`、`insideV` 作用于不在表格外沿的边。
 */
export function cellBorders(
  direct: RawTableBorders | undefined,
  style: RawTableBorders | undefined,
  position: { first: boolean; last: boolean; top: boolean; bottom: boolean },
): CellBorders {
  const out: { -readonly [K in keyof CellBorders]: CellBorders[K] } = {}
  const pick = (
    side: 'top' | 'left' | 'bottom' | 'right',
    inside: 'insideH' | 'insideV',
    outer: boolean,
  ) => {
    const own = direct?.[side]
    if (own !== undefined) {
      out[side] = border(own)
      return
    }
    const fromStyle = style?.[side] ?? (outer ? undefined : style?.[inside])
    if (fromStyle !== undefined) out[side] = border(fromStyle)
  }
  pick('top', 'insideH', position.top)
  pick('bottom', 'insideH', position.bottom)
  pick('left', 'insideV', position.first)
  pick('right', 'insideV', position.last)
  return out
}
