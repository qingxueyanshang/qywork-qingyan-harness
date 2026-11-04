/**
 * 工作表部件解析：单元格、行列、合并、视图、条件格式、自动筛选，以及指向绘图等部件的关系 ID。
 *
 * - 用 `XmlScanner` 逐个事件读取，不建树；元素按本地名匹配。读取的元素都不在 `AlternateContent` 之内，
 *   控件与嵌入对象按关系计数（见 `workbook.ts`），不读取工作表中的对应元素。
 * - 单元格缺少 `r` 时按前一个单元格的下一列计；行缺少 `r` 时按前一行的下一行计。
 * - 公式：有缓存值时显示缓存值；没有缓存值时显示 `=` 加公式文本。共享公式的从属单元格没有公式文本，
 *   按与主单元格的行列差平移主单元格的公式。`t="str"` 的空 `<v>` 是缓存的空字符串，不是缺少缓存值。
 */

import { serialFromIso } from '../../numfmt/date.ts'
import { XmlScanner } from '../../xml/index.ts'
import { canEvaluate } from '../formula.ts'
import type {
  Cell,
  CellRange,
  CellValue,
  CfRule,
  CfRuleKind,
  CfThreshold,
  ColumnSpec,
  ConditionalFormat,
  DifferentialStyle,
  FontStyle,
  RowSpec,
  SheetFormat,
  SheetView,
  UnsupportedCounts,
} from '../model.ts'
import { type ColorContext, readRawColor, resolveRawColor } from './color.ts'
import { parseCellRef, parseRange, parseRangeList, shiftFormula } from './refs.ts'
import { readStringItem, type SharedString } from './shared-strings.ts'
import { readDifferentialStyle } from './styles.ts'
import {
  boolAttr,
  decodeEscapes,
  numAttr,
  readText,
  relAttr,
  type Scanner,
  skipElement,
} from './xml-util.ts'

export interface WorksheetContext {
  readonly strings: readonly SharedString[]
  readonly styleCount: number
  readonly date1904: boolean
  readonly defaultFont: FontStyle
  readonly colors: ColorContext
  readonly fontNames: Set<string>
  /** 条件格式规则按 `dxfId` 引用的差异样式。 */
  readonly dxfs: readonly DifferentialStyle[]
  readonly numFmts: ReadonlyMap<number, string>
}

export interface ParsedWorksheet {
  readonly cells: Map<number, Map<number, Cell>>
  readonly rows: Map<number, RowSpec>
  readonly cols: ColumnSpec[]
  readonly format: SheetFormat
  readonly merges: CellRange[]
  readonly view: SheetView
  readonly conditionalFormats: ConditionalFormat[]
  readonly autoFilter: CellRange | null
  readonly maxRow: number
  readonly maxCol: number
  /** `drawing` 元素的关系 ID；图片、图表与形状在该绘图部件中。 */
  readonly drawingId: string | null
  readonly unsupported: UnsupportedCounts
}

const DEFAULT_VIEW: SheetView = {
  showGridLines: true,
  gridColor: null,
  zoom: 100,
  rightToLeft: false,
  frozenRows: 0,
  frozenCols: 0,
  topLeft: { row: 0, col: 0 },
}

const CF_OPERATORS = new Set([
  'lessThan',
  'lessThanOrEqual',
  'equal',
  'notEqual',
  'greaterThanOrEqual',
  'greaterThan',
  'between',
  'notBetween',
])

function add(counts: UnsupportedCounts, kind: keyof UnsupportedCounts, n = 1): void {
  counts[kind] = (counts[kind] ?? 0) + n
}

export function parseWorksheet(xml: string, ctx: WorksheetContext): ParsedWorksheet {
  const x = new XmlScanner(xml)
  const cells = new Map<number, Map<number, Cell>>()
  const rows = new Map<number, RowSpec>()
  const cols: ColumnSpec[] = []
  const merges: CellRange[] = []
  const conditionalFormats: ConditionalFormat[] = []
  const unsupported: UnsupportedCounts = {}
  const shared = new Map<string, { formula: string; row: number; col: number }>()
  let format: SheetFormat = {
    defaultRowHeight: 15,
    zeroHeight: false,
    customHeight: false,
    defaultColWidth: null,
    baseColWidth: 8,
    declared: false,
  }
  let view: SheetView | null = null
  let autoFilter: CellRange | null = null
  let drawingId: string | null = null
  let maxRow = -1
  let maxCol = -1
  let rowIndex = -1
  let colIndex = -1

  const clampStyle = (s: number | null): number =>
    s !== null && s >= 0 && s < ctx.styleCount ? s : 0

  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start') continue
    const local = x.local
    switch (local) {
      case 'row': {
        const r = numAttr(x, 'r')
        rowIndex = r !== null ? r - 1 : rowIndex + 1
        colIndex = -1
        const ht = numAttr(x, 'ht')
        const style = boolAttr(x, 'customFormat', false) ? clampStyle(numAttr(x, 's')) : null
        rows.set(rowIndex, {
          height: ht,
          custom: boolAttr(x, 'customHeight', false),
          hidden: boolAttr(x, 'hidden', false),
          style,
        })
        break
      }
      case 'c': {
        const ref = x.attr('r')
        const pos = ref ? parseCellRef(ref) : null
        if (pos) {
          rowIndex = pos.row
          colIndex = pos.col
        } else {
          colIndex++
        }
        const row = rowIndex
        const col = colIndex
        const style = clampStyle(numAttr(x, 's'))
        const value = readCell(x, x.attr('t'), row, col, ctx, shared, unsupported)
        // 没有值也没有样式的单元格同样保留：它以样式 0 取代行样式与列样式，参与行高推算。
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
        break
      }
      case 'col': {
        const min = numAttr(x, 'min')
        const max = numAttr(x, 'max')
        if (min === null || max === null) break
        const style = numAttr(x, 'style')
        cols.push({
          min: min - 1,
          max: Math.min(max, 16_384) - 1,
          width: numAttr(x, 'width'),
          hidden: boolAttr(x, 'hidden', false),
          style: style === null ? null : clampStyle(style),
        })
        break
      }
      case 'sheetFormatPr':
        format = {
          defaultRowHeight: numAttr(x, 'defaultRowHeight') ?? 15,
          zeroHeight: boolAttr(x, 'zeroHeight', false),
          customHeight: boolAttr(x, 'customHeight', false),
          defaultColWidth: numAttr(x, 'defaultColWidth'),
          baseColWidth: numAttr(x, 'baseColWidth') ?? 8,
          declared: true,
        }
        break
      case 'sheetView':
        if (view === null) view = readView(x, ctx.colors.palette)
        else skipElement(x)
        break
      case 'mergeCell': {
        const r = parseRange(x.attr('ref') ?? '')
        if (r) merges.push(r)
        break
      }
      case 'conditionalFormatting':
        conditionalFormats.push(readConditionalFormatting(x, ctx, unsupported))
        break
      case 'autoFilter':
        if (x.depth === 2) autoFilter = parseRange(x.attr('ref') ?? '')
        skipElement(x)
        break
      case 'drawing':
        drawingId = relAttr(x, 'id')
        break
      case 'extLst':
        readExtensions(x, ctx, conditionalFormats, unsupported)
        break
    }
  }
  cols.sort((a, b) => a.min - b.min)
  return {
    cells,
    rows,
    cols,
    format,
    merges,
    view: view ?? DEFAULT_VIEW,
    conditionalFormats,
    autoFilter,
    maxRow,
    maxCol,
    drawingId,
    unsupported,
  }
}

function readCell(
  x: Scanner,
  type: string | null,
  row: number,
  col: number,
  ctx: WorksheetContext,
  shared: Map<string, { formula: string; row: number; col: number }>,
  unsupported: UnsupportedCounts,
): CellValue | null {
  const depth = x.depth
  let v: string | null = null
  let formula: string | null = null
  let inline: SharedString | null = null
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    const local = x.local
    if (local === 'v') v = readText(x)
    else if (local === 'is') inline = readStringItem(x, ctx.defaultFont, ctx.colors, ctx.fontNames)
    else if (local === 'f') {
      const si = x.attr('si')
      const isShared = x.attr('t') === 'shared'
      const text = readText(x)
      if (isShared && si !== null) {
        if (text !== '') shared.set(si, { formula: text, row, col })
        else {
          const master = shared.get(si)
          formula = master ? shiftFormula(master.formula, row - master.row, col - master.col) : null
          continue
        }
      }
      formula = text
    }
  }
  if (formula !== null && /\bDISPIMG\s*\(/i.test(formula)) add(unsupported, 'cellImage')
  if (type === 'inlineStr') {
    if (inline) return { type: 'string', value: inline.text, runs: inline.runs }
    return v === null ? null : { type: 'string', value: decodeEscapes(v), runs: null }
  }
  if (v === null || (v === '' && type !== 'str')) {
    return formula ? { type: 'formula', value: `=${formula}` } : null
  }
  switch (type) {
    case 's': {
      const item = ctx.strings[Number(v)]
      return item ? { type: 'string', value: item.text, runs: item.runs } : null
    }
    case 'str':
      return { type: 'string', value: decodeEscapes(v), runs: null }
    case 'b':
      return { type: 'boolean', value: v === '1' || v === 'true' }
    case 'e':
      return { type: 'error', value: v }
    case 'd': {
      const serial = serialFromIso(v, ctx.date1904)
      return serial === null
        ? { type: 'string', value: v, runs: null }
        : { type: 'number', value: serial }
    }
    default: {
      const n = Number(v)
      return Number.isFinite(n)
        ? { type: 'number', value: n }
        : { type: 'string', value: v, runs: null }
    }
  }
}

function readView(x: Scanner, palette: readonly string[]): SheetView {
  const topLeft = parseCellRef(x.attr('topLeftCell') ?? 'A1') ?? { row: 0, col: 0 }
  const colorId = numAttr(x, 'colorId')
  let view: SheetView = {
    showGridLines: boolAttr(x, 'showGridLines', true),
    gridColor: colorId === null ? null : (palette[colorId] ?? null),
    zoom: numAttr(x, 'zoomScale') ?? 100,
    rightToLeft: boolAttr(x, 'rightToLeft', false),
    frozenRows: 0,
    frozenCols: 0,
    topLeft,
  }
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.local !== 'pane') continue
    const state = x.attr('state')
    // `split` 状态的 xSplit/ySplit 是以 1/20 磅计的拆分位置，不是冻结的行列数。
    if (state === 'frozen' || state === 'frozenSplit') {
      const paneTopLeft = parseCellRef(x.attr('topLeftCell') ?? '')
      view = {
        ...view,
        frozenRows: numAttr(x, 'ySplit') ?? 0,
        frozenCols: numAttr(x, 'xSplit') ?? 0,
        topLeft: paneTopLeft ?? view.topLeft,
      }
    }
  }
  return view
}

function readThreshold(x: Scanner): CfThreshold {
  const type = x.attr('type') ?? 'min'
  const raw = x.attr('val')
  const n = raw === null ? Number.NaN : Number(raw)
  const known = ['min', 'max', 'num', 'percent', 'percentile', 'formula', 'autoMin', 'autoMax']
  return {
    type: (known.includes(type) ? type : 'min') as CfThreshold['type'],
    value: Number.isFinite(n) ? n : null,
  }
}

function readConditionalFormatting(
  x: Scanner,
  ctx: WorksheetContext,
  unsupported: UnsupportedCounts,
): ConditionalFormat {
  const ranges = parseRangeList(x.attr('sqref') ?? '')
  const rules: CfRule[] = []
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start' || x.local !== 'cfRule') continue
    const rule = readRule(x, ctx)
    if (rule) rules.push(rule)
    // 无法表示的规则与公式无法求值的规则都计入；后者保留在模型中，求值时不命中。
    if (!rule || !formulasEvaluable(rule)) add(unsupported, 'conditionalFormat')
  }
  return { ranges, rules }
}

/** 规则引用的公式都能求值；.xls 的条件格式（`../biff/sheet.ts`）按同一规则计数。 */
export function formulasEvaluable(rule: CfRule): boolean {
  if (rule.type === 'expression') return canEvaluate(rule.formula)
  if (rule.type === 'cellIs') return rule.formulas.every(canEvaluate)
  return true
}

/**
 * 读取一条规则：`cfRule` 的差异样式按 `dxfId` 引用，2010 扩展的 `x14:cfRule` 内嵌 `x14:dxf`，
 * 公式分别写在 `formula` 与 `xm:f` 中（只取规则的直接子元素，`x14:cfvo` 内的 `xm:f` 是阈值）。
 */
function readRule(x: Scanner, ctx: WorksheetContext): CfRule | null {
  const type = x.attr('type') ?? ''
  const dxfId = numAttr(x, 'dxfId')
  let dxf = dxfId === null ? null : (ctx.dxfs[dxfId] ?? null)
  const priority = numAttr(x, 'priority') ?? Number.MAX_SAFE_INTEGER
  const stopIfTrue = boolAttr(x, 'stopIfTrue', false)
  const operator = x.attr('operator') ?? ''
  const text = x.attr('text') ?? ''
  const attrs = {
    rank: numAttr(x, 'rank') ?? 10,
    percent: boolAttr(x, 'percent', false),
    bottom: boolAttr(x, 'bottom', false),
    above: boolAttr(x, 'aboveAverage', true),
    equal: boolAttr(x, 'equalAverage', false),
    stdDev: numAttr(x, 'stdDev'),
  }
  const formulas: string[] = []
  const thresholds: CfThreshold[] = []
  const colors: string[] = []
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    const child = x.depth === depth + 1
    if (child && (x.local === 'formula' || x.local === 'f')) formulas.push(readText(x))
    else if (child && x.local === 'dxf') dxf = readDifferentialStyle(x, ctx.numFmts, ctx.colors)
    else if (x.local === 'cfvo') thresholds.push(readThreshold(x))
    else if (x.local === 'color') {
      colors.push(
        resolveRawColor(
          readRawColor((n) => x.attr(n)),
          ctx.colors,
        ) ?? '#000000',
      )
    }
  }
  let kind: CfRuleKind | null = null
  switch (type) {
    case 'cellIs':
      if (CF_OPERATORS.has(operator)) {
        kind = {
          type,
          operator: operator as Extract<CfRuleKind, { type: 'cellIs' }>['operator'],
          formulas,
        }
      }
      break
    case 'expression':
      kind = formulas[0] !== undefined ? { type, formula: formulas[0] } : null
      break
    case 'colorScale':
      kind = { type, thresholds, colors }
      break
    case 'dataBar':
      kind = { type, thresholds, color: colors[0] ?? '#638ec6' }
      break
    case 'top10':
      kind = { type, rank: attrs.rank, percent: attrs.percent, bottom: attrs.bottom }
      break
    case 'aboveAverage':
      kind = attrs.stdDev === null ? { type, above: attrs.above, equal: attrs.equal } : null
      break
    case 'duplicateValues':
    case 'uniqueValues':
    case 'containsBlanks':
    case 'notContainsBlanks':
    case 'containsErrors':
    case 'notContainsErrors':
      kind = { type }
      break
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith':
      kind = { type, text }
      break
  }
  return kind ? { ...kind, priority, stopIfTrue, dxf } : null
}

/**
 * `extLst` 中的 2010 扩展：迷你图计数；扩展条件格式（`x14:conditionalFormatting`，引用其他工作表的规则写在这里）
 * 与 `conditionalFormatting` 同样读入，区域在规则之后的 `xm:sqref` 中。数据条扩展只补充主规则的外观，不单独读入与计数。
 */
function readExtensions(
  x: Scanner,
  ctx: WorksheetContext,
  out: ConditionalFormat[],
  unsupported: UnsupportedCounts,
): void {
  const depth = x.depth
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    if (x.local === 'sparkline') add(unsupported, 'sparkline')
    else if (x.local === 'conditionalFormatting') {
      const rules: CfRule[] = []
      let ranges: CellRange[] = []
      const own = x.depth
      for (let u = x.next(); u !== null; u = x.next()) {
        if (u === 'end' && x.depth === own) break
        if (u !== 'start') continue
        const name: string = x.local
        if (name === 'sqref') ranges = parseRangeList(readText(x))
        else if (name === 'cfRule') {
          if (x.attr('type') === 'dataBar') {
            skipElement(x)
            continue
          }
          const rule = readRule(x, ctx)
          if (rule) rules.push(rule)
          if (!rule || !formulasEvaluable(rule)) add(unsupported, 'conditionalFormat')
        }
      }
      if (rules.length > 0) out.push({ ranges, rules })
    }
  }
}
