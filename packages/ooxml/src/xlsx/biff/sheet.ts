/**
 * BIFF8 工作表子流：单元格、行列、合并、视图，以及绘图对象的原始数据与计数。
 *
 * - 子流自 BOF 起、至同层的 EOF 止；嵌入图表的子流（内层 BOF 至 EOF）不在此读取，记下其范围与所属的 OBJ，由调用方读取。
 * - 公式显示缓存值：缓存为字符串时值在其后的 STRING 记录中；BIFF 的公式记录总带缓存值。
 * - 列宽单位为字符宽度的 1/256，与 xlsx 的 `width` 乘以 256 相同；行高单位为缇。
 * - 有单元格而没有 ROW 记录的行按内容推算行高（WPS 实测：题库文件没有 ROW 记录，换行文字的行按内容加高），
 *   等同于 xlsx 中没有属性的 `<row>`：xlsx 的单元格总在 `<row>` 之内，BIFF 的单元格记录与 ROW 记录相互独立。
 * - 冻结窗格（WINDOW2 的 `fFrozen`）时 PANE 的 `x`、`y` 为冻结的列数与行数，其左上单元格为打开时的滚动位置；
 *   未冻结时滚动位置取 WINDOW2 的首行首列。
 * - 条件格式：CONDFMT 与其后的 CF 记录见 `conditional.ts`；无法换算与求值器不支持的规则计入 `conditionalFormat`，
 *   CF12（Excel 2007 的规则）逐条计入。
 */

import type {
  Cell,
  CellRange,
  CellValue,
  ColumnSpec,
  ConditionalFormat,
  RowSpec,
  SheetFormat,
  SheetView,
  UnsupportedCounts,
  UnsupportedKind,
} from '../model.ts'
import { formulasEvaluable } from '../parse/worksheet.ts'
import { readRanges, readRule } from './conditional.ts'
import type { Globals } from './globals.ts'
import { type BiffRecord, Bytes, RT, unicodeString } from './records.ts'

export interface ParsedSheet {
  readonly cells: Map<number, Map<number, Cell>>
  readonly rows: Map<number, RowSpec>
  readonly cols: ColumnSpec[]
  readonly format: SheetFormat
  readonly merges: CellRange[]
  readonly view: SheetView
  readonly maxRow: number
  readonly maxCol: number
  /** 对话框表（WSBOOL 的 `fDialog`），调用方计入 `otherSheet`。 */
  readonly dialog: boolean
  /** MSODRAWING 记录的数据，按出现顺序；拼接后为该表的绘图容器。 */
  readonly drawing: Uint8Array[]
  /** OBJ 记录的对象类型与编号，按出现顺序，与绘图容器中带客户数据的形状一一对应。 */
  readonly objects: { readonly type: number; readonly id: number }[]
  /** 嵌入图表的子流：所属 OBJ 在 `objects` 中的下标，与子流 BOF、EOF 之间的记录在 `list` 中的范围（不含两端）。 */
  readonly charts: { readonly object: number; readonly start: number; readonly end: number }[]
  readonly conditionalFormats: ConditionalFormat[]
  readonly unsupported: UnsupportedCounts
}

const ERRORS: Readonly<Record<number, string>> = {
  0: '#NULL!',
  7: '#DIV/0!',
  15: '#VALUE!',
  23: '#REF!',
  29: '#NAME?',
  36: '#NUM!',
  42: '#N/A',
  43: '#GETTING_DATA',
}

/** OBJ 的对象类型：组合、批注、图表与图片另行处理，表单控件计入 `control`，其余计入 `graphic`。 */
const OBJ_GROUP = 0
export const OBJ_CHART = 5
export const OBJ_PICTURE = 8
const OBJ_NOTE = 25
const OBJ_CONTROLS = new Set([7, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])

/** BOF 的子流类型：图表。 */
const CHART_STREAM = 0x0020

/** RK 编码的数值：第 0 位为除以 100，第 1 位为 30 位有符号整数，否则为双精度数的高 30 位。 */
export function decodeRk(rk: number): number {
  let value: number
  if (rk & 2) value = (rk | 0) >> 2
  else {
    const view = new DataView(new ArrayBuffer(8))
    view.setUint32(4, rk & 0xfffffffc, true)
    value = view.getFloat64(0, true)
  }
  return rk & 1 ? value / 100 : value
}

export function readSheet(list: readonly BiffRecord[], start: number, g: Globals): ParsedSheet {
  const cells = new Map<number, Map<number, Cell>>()
  const rows = new Map<number, RowSpec>()
  const cols: ColumnSpec[] = []
  const merges: CellRange[] = []
  const drawing: Uint8Array[] = []
  const objects: { type: number; id: number }[] = []
  const charts: { object: number; start: number; end: number }[] = []
  const conditionalFormats: ConditionalFormat[] = []
  let block: {
    ranges: CellRange[]
    rules: ConditionalFormat['rules'][number][]
    left: number
  } | null = null
  let priority = 0
  let chartStart = -1
  const unsupported: UnsupportedCounts = {}
  const count = (kind: UnsupportedKind) => {
    unsupported[kind] = (unsupported[kind] ?? 0) + 1
  }
  let format: SheetFormat = {
    defaultRowHeight: 15,
    zeroHeight: false,
    customHeight: false,
    defaultColWidth: null,
    baseColWidth: 8,
    declared: true,
  }
  let window2: Bytes | null = null
  let pane: Bytes | null = null
  let zoom = 100
  let dialog = false
  let maxRow = -1
  let maxCol = -1
  let pendingString: { row: number; col: number; style: number } | null = null

  const put = (row: number, col: number, xf: number, value: CellValue | null) => {
    const style = g.styleIndex(xf)
    let line = cells.get(row)
    if (!line) {
      line = new Map()
      cells.set(row, line)
    }
    line.set(col, { value, style })
    if (value !== null || style !== 0) {
      if (row > maxRow) maxRow = row
      if (col > maxCol) maxCol = col
    }
  }

  let depth = 0
  for (let i = start; i < list.length; i++) {
    const r = list[i]!
    if (r.id === RT.BOF) {
      depth++
      if (depth === 2 && new Bytes(r.data).u16(2) === CHART_STREAM) chartStart = i + 1
      continue
    }
    if (r.id === RT.EOF) {
      depth--
      if (depth === 1 && chartStart >= 0) {
        charts.push({ object: objects.length - 1, start: chartStart, end: i })
        chartStart = -1
      }
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    const b = new Bytes(r.data)
    switch (r.id) {
      case RT.LABELSST: {
        const s = g.strings[b.u32(6)]
        put(
          b.u16(0),
          b.u16(2),
          b.u16(4),
          s ? { type: 'string', value: s.text, runs: s.runs } : null,
        )
        break
      }
      case RT.LABEL:
        put(b.u16(0), b.u16(2), b.u16(4), {
          type: 'string',
          value: unicodeString(b, 6).text,
          runs: null,
        })
        break
      case RT.NUMBER:
        put(b.u16(0), b.u16(2), b.u16(4), { type: 'number', value: b.f64(6) })
        break
      case RT.RK:
        put(b.u16(0), b.u16(2), b.u16(4), { type: 'number', value: decodeRk(b.u32(6)) })
        break
      case RT.MULRK: {
        const row = b.u16(0)
        const first = b.u16(2)
        for (let k = 0; 4 + k * 6 + 6 <= b.length - 2; k++) {
          const p = 4 + k * 6
          put(row, first + k, b.u16(p), { type: 'number', value: decodeRk(b.u32(p + 2)) })
        }
        break
      }
      case RT.BLANK:
        put(b.u16(0), b.u16(2), b.u16(4), null)
        break
      case RT.MULBLANK: {
        const row = b.u16(0)
        const first = b.u16(2)
        for (let k = 0; 4 + k * 2 + 2 <= b.length - 2; k++)
          put(row, first + k, b.u16(4 + k * 2), null)
        break
      }
      case RT.BOOLERR: {
        const v = b.u8(6)
        put(
          b.u16(0),
          b.u16(2),
          b.u16(4),
          b.u8(7) === 1
            ? { type: 'error', value: ERRORS[v] ?? '#N/A' }
            : { type: 'boolean', value: v !== 0 },
        )
        break
      }
      case RT.FORMULA: {
        const row = b.u16(0)
        const col = b.u16(2)
        const xf = b.u16(4)
        pendingString = null
        if (b.u16(12) !== 0xffff) {
          put(row, col, xf, { type: 'number', value: b.f64(6) })
          break
        }
        const kind = b.u8(6)
        if (kind === 0) {
          pendingString = { row, col, style: xf }
          put(row, col, xf, null)
        } else if (kind === 1) put(row, col, xf, { type: 'boolean', value: b.u8(8) !== 0 })
        else if (kind === 2) put(row, col, xf, { type: 'error', value: ERRORS[b.u8(8)] ?? '#N/A' })
        else put(row, col, xf, { type: 'string', value: '', runs: null })
        break
      }
      case RT.STRING:
        if (pendingString !== null) {
          const { row, col, style } = pendingString
          put(row, col, style, { type: 'string', value: unicodeString(b, 0).text, runs: null })
          pendingString = null
        }
        break
      case RT.ROW: {
        const flags = b.u16(12)
        rows.set(b.u16(0), {
          height: (b.u16(6) & 0x7fff) / 20,
          custom: (flags & 0x40) !== 0,
          hidden: (flags & 0x20) !== 0,
          style: flags & 0x80 ? g.styleIndex(b.u16(14) & 0x0fff) : null,
        })
        break
      }
      case RT.COLINFO:
        cols.push({
          min: b.u16(0),
          max: Math.min(b.u16(2), 16_383),
          width: b.u16(4) / 256,
          hidden: (b.u16(8) & 1) !== 0,
          style: g.styleIndex(b.u16(6)),
        })
        break
      case RT.DEFCOLWIDTH:
        format = { ...format, baseColWidth: b.u16(0) }
        break
      case RT.STANDARDWIDTH:
        format = { ...format, defaultColWidth: b.u16(0) / 256 }
        break
      case RT.DEFAULTROWHEIGHT: {
        const flags = b.u16(0)
        format = {
          ...format,
          defaultRowHeight: b.u16(2) / 20,
          customHeight: (flags & 1) !== 0,
          zeroHeight: (flags & 2) !== 0,
        }
        break
      }
      case RT.MERGECELLS:
        for (let k = 0; k < b.u16(0) && 2 + k * 8 + 8 <= b.length; k++) {
          const p = 2 + k * 8
          merges.push({
            top: b.u16(p),
            bottom: b.u16(p + 2),
            left: b.u16(p + 4),
            right: b.u16(p + 6),
          })
        }
        break
      case RT.WINDOW2:
        window2 = b
        break
      case RT.PANE:
        pane = b
        break
      case RT.SCL:
        if (b.u16(2) > 0) zoom = Math.round((b.u16(0) * 100) / b.u16(2))
        break
      case RT.WSBOOL:
        dialog = (b.u8(0) & 0x10) !== 0
        break
      case RT.NOTE:
        count('comment')
        break
      case RT.CONDFMT: {
        block = { ranges: readRanges(b), rules: [], left: b.u16(0) }
        conditionalFormats.push({ ranges: block.ranges, rules: block.rules })
        break
      }
      case RT.CF: {
        const rule =
          block !== null && block.left > 0
            ? readRule(b, block.ranges, priority++, { palette: g.palette, formats: g.formats })
            : null
        if (block !== null) block.left--
        if (rule !== null) block!.rules.push(rule)
        if (rule === null || !formulasEvaluable(rule)) count('conditionalFormat')
        break
      }
      case RT.CF12:
        count('conditionalFormat')
        break
      case RT.MSODRAWING:
        drawing.push(r.data)
        break
      case RT.OBJ:
        if (b.u16(0) === 0x15) {
          const type = b.u16(4)
          objects.push({ type, id: b.u16(6) })
          if (OBJ_CONTROLS.has(type)) count('control')
          else if (![OBJ_GROUP, OBJ_NOTE, OBJ_PICTURE, OBJ_CHART].includes(type)) count('graphic')
        }
        break
    }
  }
  for (const row of cells.keys()) {
    if (!rows.has(row)) rows.set(row, { height: null, custom: false, hidden: false, style: null })
  }
  cols.sort((a, b) => a.min - b.min)
  return {
    cells,
    rows,
    cols,
    format,
    merges,
    view: readView(window2, pane, zoom, g.palette),
    maxRow,
    maxCol,
    dialog,
    drawing,
    objects,
    charts,
    conditionalFormats: conditionalFormats.filter((cf) => cf.rules.length > 0),
    unsupported,
  }
}

/** WINDOW2 的标志位：第 1 位显示网格线，第 3 位冻结，第 5 位网格线取缺省颜色，第 6 位右到左。 */
function readView(
  w: Bytes | null,
  pane: Bytes | null,
  zoom: number,
  palette: readonly string[],
): SheetView {
  const flags = w?.u16(0) ?? 0x02b6
  const frozen = (flags & 0x08) !== 0 && pane !== null
  return {
    showGridLines: (flags & 0x02) !== 0,
    gridColor: flags & 0x20 ? null : (palette[w?.u16(6) ?? 64] ?? null),
    zoom,
    rightToLeft: (flags & 0x40) !== 0,
    frozenRows: frozen ? pane.u16(2) : 0,
    frozenCols: frozen ? pane.u16(0) : 0,
    topLeft: frozen
      ? { row: pane.u16(4), col: pane.u16(6) }
      : { row: w?.u16(2) ?? 0, col: w?.u16(4) ?? 0 },
  }
}
