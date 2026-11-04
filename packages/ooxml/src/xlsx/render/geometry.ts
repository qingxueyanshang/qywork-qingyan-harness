/**
 * 行高与列宽换算为像素（96 dpi，缩放 100%）。
 *
 * - 列宽：Excel 字符宽度单位按默认字体的最大数字宽度（MDW）换算，`px = ⌊(256w + ⌊128/MDW⌋)/256 × MDW⌋`。
 *   MDW 为「常规」字体在整数像素字号（磅换算后四舍五入）下数字 0–9 的最大前进宽度，四舍五入为整数。
 *   未指定 `defaultColWidth` 时见 `defaultColumnPixels`。
 * - 行高：指定了 `customHeight` 的行按磅值（缺少 `ht` 时为标准行高）换算后向下取整；文件中没有的行取标准行高。
 *   其余行按内容推算，保存的 `ht` 与默认行高的 `customHeight` 都不参与（WPS 实测：默认行高带 `customHeight` 的工作表中，
 *   文件中有的行同样按内容推算，只有文件中没有的行取默认行高），取以下各项的最大值再加边框增量：
 *   文件中写出的单元格（含没有值的单元格）不换行时为主字体的单行行高（`lineBox`），自动换行时为各行行高之和
 *   （`lineBoxOf`）；未写出的单元格按其样式（行样式优先，其次列样式，其余为样式 0）取单行行高。
 *   标准行高不是下限：写出的单元格字体较小时，行高可低于标准行高。
 * - 标准行高见 `standardRowHeight`；`defaultRowHeight` 只在带 `customHeight` 时使用。
 */

import type {
  BorderLine,
  BorderLineStyle,
  Cell,
  CellRange,
  CellStyle,
  FontStyle,
  Workbook,
  Worksheet,
} from '../model.ts'
import { Axis, type AxisRun } from './axis.ts'
import { type FaceChain, type FontSet, pixelSize } from './fonts.ts'
import { lineBox, lineBoxOf, lineMetrics, makeRun, wrapRuns } from './text.ts'

export interface SheetGeometry {
  readonly cols: Axis
  readonly rows: Axis
  /** 默认字体的最大数字宽度，像素。 */
  readonly mdw: number
}

/** 文字到左、右网格线的留白（像素），以及决定留白的最大数字宽度。 */
export interface TextPadding {
  readonly left: number
  readonly right: number
  readonly digit: number
}

/**
 * 单元格文字的留白，由单元格字体（含粗体）的最大数字宽度 w 决定：左留白 ⌊5(w + 6)/19⌋，右留白比左留白少 1。
 * 经验拟合（机制未查明）：WPS 屏幕显示中 8 种字体 ppem 8–55（w 为 4–35）的靠左与靠右文字全部一致，宋体 11 磅（w = 8）为 3 与 2；
 * 粗体按粗体的数字宽度（合成粗体加 1）计算，语料中宋体 18 磅与 Times New Roman 14 磅粗体的位置据此一致。
 * 自动换行的行宽、溢出与各种对齐共用此留白；居中不受留白影响（左右之差恒为 1）。
 */
export function textPadding(font: FontStyle, fonts: FontSet): TextPadding {
  const w = widestDigit(fonts.chain(font.name, font.bold, font.italic), pixelSize(font.size))
  const left = Math.floor((5 * (w + 6)) / 19)
  return { left, right: left - 1, digit: w }
}

/** 列宽换算所用的最大数字宽度：常规字形。 */
export function maxDigitWidth(font: FontStyle, fonts: FontSet): number {
  return widestDigit(fonts.chain(font.name, false, false), pixelSize(font.size))
}

function widestDigit(chain: FaceChain, ppem: number): number {
  if (chain.faces.length === 0) return Math.round(ppem / 2)
  let max = 0
  for (let d = 0; d <= 9; d++) max = Math.max(max, chain.width(String(d), ppem))
  return Math.round(max)
}

export function columnPixels(width: number, mdw: number): number {
  return Math.floor(((256 * width + Math.floor(128 / mdw)) / 256) * mdw)
}

/** 文件中没有 `sheetFormatPr` 时的默认列宽（像素）。 */
const UNDECLARED_COLUMN_PIXELS = 72

/**
 * 默认列宽（像素）。未指定 `defaultColWidth` 时按 `baseColWidth + 1` 个字符换算；文件中没有 `sheetFormatPr` 时
 * 固定为 72 像素，与字体无关。WPS 实测（构造文件经 `Range.CopyPicture`）：有 `sheetFormatPr` 时 MDW 6、7、8、10、12、14、
 * 16、19 与 `baseColWidth` 为 10 的列宽全部一致；没有时 MDW 6、7、8、10 均为 72。不要改为「数字宽度加 5 像素后取整到
 * 8 的倍数」：MDW 为 7 时得 64，WPS 为 63。
 */
export function defaultColumnPixels(sheet: Worksheet, mdw: number): number {
  const f = sheet.format
  if (f.defaultColWidth !== null) return columnPixels(f.defaultColWidth, mdw)
  if (!f.declared) return UNDECLARED_COLUMN_PIXELS
  return columnPixels(f.baseColWidth + 1, mdw)
}

/**
 * 缩进一级的像素宽度 `2·MDW + 2·⌈MDW/12⌉`，MDW 为默认字体的最大数字宽度，与单元格字体无关。
 * 经验拟合（机制未查明）：WPS 屏幕显示中以宋体、Calibri、Arial 为默认字体的 22 种字号（MDW 6–19、24、32），
 * 每种 4–16 个缩进级数全部一致，靠左与靠右的缩进相同。
 */
export function indentPixels(mdw: number): number {
  return 2 * mdw + 2 * Math.ceil(mdw / 12)
}

/** 指定行高（磅）换算为像素，向下取整。 */
export function rowPixels(pt: number): number {
  return Math.floor((pt * 4) / 3 + 1e-9)
}

/** 单行文字的行高（像素），见 `lineBox`。 */
export function fontLineHeight(font: FontStyle, fonts: FontSet): number {
  return lineBox(fonts.chain(font.name, font.bold, font.italic).faces[0], font.size).height
}

/**
 * 参与行高推算的最后一列：网格的末列不参与（WPS 实测 xlsx：列样式覆盖第 1–16383 列时，标准行高只取列样式的字体）。
 * 网格列数取 `Workbook.gridSize`：xls 只有 256 列，按 xlsx 的列数推算时第 257 列起取样式 0（WPS 实测：
 * 列样式覆盖第 11–257 列、样式 0 字号较大的 xls，行高按列样式的字体）。xls 中末列是否参与未实测。
 */
function lastHeightCol(wb: Workbook): number {
  return wb.gridSize.cols - 2
}

/** 默认样式相同的一段连续列，`height` 为该样式字体的单行行高。 */
interface ColumnDefault {
  readonly from: number
  readonly to: number
  readonly height: number
}

function styleLineHeight(wb: Workbook, style: number, fonts: FontSet): number {
  return fontLineHeight((wb.styles[style] ?? wb.styles[0]!).font, fonts)
}

/** 第 0 列至 `lastHeightCol` 列按列默认样式分段，升序且无间隙；`<col>` 未指定样式与未列出的列取样式 0。 */
function columnDefaults(wb: Workbook, sheet: Worksheet, fonts: FontSet): ColumnDefault[] {
  const normal = styleLineHeight(wb, 0, fonts)
  const last = lastHeightCol(wb)
  const out: ColumnDefault[] = []
  let next = 0
  for (const c of sheet.cols) {
    if (c.min > last) break
    if (c.min > next) out.push({ from: next, to: c.min - 1, height: normal })
    const to = Math.min(c.max, last)
    out.push({
      from: c.min,
      to,
      height: c.style === null ? normal : styleLineHeight(wb, c.style, fonts),
    })
    next = to + 1
  }
  if (next <= last) out.push({ from: next, to: last, height: normal })
  return out
}

/**
 * 标准行高（像素）：文件中没有的行的行高。默认行高带 `customHeight` 时取默认行高；
 * 否则为各列默认样式字体的单行行高的最大值（含隐藏列与宽度为 0 的列），与 `defaultRowHeight` 无关。
 */
export function standardRowHeight(wb: Workbook, sheet: Worksheet, fonts: FontSet): number {
  if (sheet.format.customHeight) return rowPixels(sheet.format.defaultRowHeight)
  let max = 0
  for (const d of columnDefaults(wb, sheet, fonts)) max = Math.max(max, d.height)
  return max
}

/** 边框线宽（像素）：medium 类为 2，thick 与 double 为 3，其余为 1。 */
const LINE_WIDTH: Partial<Record<BorderLineStyle, number>> = {
  medium: 2,
  mediumDashed: 2,
  mediumDashDot: 2,
  mediumDashDotDot: 2,
  slantDashDot: 2,
  thick: 3,
  double: 3,
}

function lineWidth(line: BorderLine | null): number {
  return line ? (LINE_WIDTH[line.style] ?? 1) : 0
}

type Line = ReadonlyMap<number, Cell> | undefined

/** 一行单元格中 `side` 边框的最大线宽。 */
function widestEdge(wb: Workbook, line: Line, side: 'top' | 'bottom'): number {
  let w = 0
  for (const cell of line?.values() ?? []) {
    w = Math.max(w, lineWidth((wb.styles[cell.style] ?? wb.styles[0]!).border?.[side] ?? null))
  }
  return w
}

/**
 * 边框使行高增加的像素数。两行之间的横线取上行底边与下行顶边中最宽的线宽 w，使上行增加 ⌊w/2⌋、下行增加 ⌊(w − 1)/2⌋；
 * 本行的增量为下方与上方两条横线的增量之和。即中粗线使上行加 1，粗线与双线使上下两行各加 1。
 * 下行顶边计入上行、上行底边计入下行是按 WPS 逐行行高拟合的经验规则（机制未查明）：未参与拟合的 12 份文件
 * 按内容推算的 14848 行中 14786 行与 WPS 一致，只计本行边框时为 14622 行。
 */
function borderIncrement(wb: Workbook, above: Line, line: Line, below: Line): number {
  const bottom = Math.max(widestEdge(wb, line, 'bottom'), widestEdge(wb, below, 'top'))
  const top = Math.max(widestEdge(wb, line, 'top'), widestEdge(wb, above, 'bottom'))
  return Math.floor(bottom / 2) + Math.floor(Math.max(0, top - 1) / 2)
}

function rangesByRow(merges: readonly CellRange[]): Map<number, CellRange[]> {
  const out = new Map<number, CellRange[]>()
  for (const m of merges) {
    for (let r = m.top; r <= m.bottom; r++) {
      const list = out.get(r) ?? []
      list.push(m)
      out.set(r, list)
    }
  }
  return out
}

export function buildGeometry(wb: Workbook, sheet: Worksheet, fonts: FontSet): SheetGeometry {
  const mdw = maxDigitWidth(wb.defaultFont, fonts)
  const defaultCol = defaultColumnPixels(sheet, mdw)
  const colRuns: AxisRun[] = sheet.cols.map((c) => ({
    from: c.min,
    to: c.max,
    size: c.hidden ? 0 : c.width === null ? defaultCol : columnPixels(c.width, mdw),
  }))
  const cols = new Axis([], defaultCol, colRuns, wb.gridSize.cols)

  const defaults = columnDefaults(wb, sheet, fonts)
  const standard = standardRowHeight(wb, sheet, fonts)
  const defaultRow = sheet.format.zeroHeight ? 0 : standard
  const merged = rangesByRow(sheet.merges)
  let lastRow = sheet.maxRow
  for (const r of sheet.rows.keys()) lastRow = Math.max(lastRow, r)
  const heights = new Float64Array(lastRow + 1)
  for (let r = 0; r <= lastRow; r++) {
    const spec = sheet.rows.get(r)
    if (!spec) heights[r] = defaultRow
    else if (spec.hidden) heights[r] = 0
    else if (spec.custom) heights[r] = spec.height === null ? standard : rowPixels(spec.height)
    else heights[r] = autoRowHeight(wb, sheet, r, spec.style, cols, fonts, merged.get(r), defaults)
  }
  const rows = new Axis(heights, defaultRow, [], wb.gridSize.rows)
  return { cols, rows, mdw }
}

/** 本行未写出的单元格中最高的单行行高：有行样式时取行样式，否则取各段列中仍有未写出单元格的那些段的默认样式。 */
function absentHeight(
  wb: Workbook,
  line: ReadonlyMap<number, Cell> | undefined,
  rowStyle: number | null,
  defaults: readonly ColumnDefault[],
  fonts: FontSet,
): number {
  const written = new Uint32Array(defaults.length)
  const last = lastHeightCol(wb)
  let total = 0
  for (const col of line?.keys() ?? []) {
    if (col > last) continue
    total++
    let lo = 0
    let hi = defaults.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (defaults[mid]!.from <= col) lo = mid
      else hi = mid - 1
    }
    written[lo]!++
  }
  if (rowStyle !== null) return total <= last ? styleLineHeight(wb, rowStyle, fonts) : 0
  let height = 0
  defaults.forEach((d, i) => {
    if (written[i]! < d.to - d.from + 1) height = Math.max(height, d.height)
  })
  return height
}

function autoRowHeight(
  wb: Workbook,
  sheet: Worksheet,
  row: number,
  rowStyle: number | null,
  cols: Axis,
  fonts: FontSet,
  merges: readonly CellRange[] | undefined,
  defaults: readonly ColumnDefault[],
): number {
  const line = sheet.cells.get(row)
  let height = absentHeight(wb, line, rowStyle, defaults, fonts)
  for (const [col, cell] of line ?? []) {
    const merge = merges?.find((m) => col >= m.left && col <= m.right)
    // 跨行合并的单元格不参与推算；合并区域内除左上角外的单元格同样不参与。
    if (merge && (merge.top !== merge.bottom || col !== merge.left)) continue
    const style: CellStyle = wb.styles[cell.style] ?? wb.styles[0]!
    const v = cell.value
    const runs =
      v?.type === 'string' && v.runs
        ? v.runs.map((r) => makeRun(r.text, r.font ?? style.font, fonts))
        : [makeRun(v?.type === 'string' || v?.type === 'formula' ? v.value : '', style.font, fonts)]
    // 隐藏列（宽度为 0）中的文字不换行。
    const colWidth = cols.size(col)
    if (
      v &&
      style.alignment.wrap &&
      !merge &&
      colWidth > 0 &&
      (v.type === 'string' || v.type === 'formula')
    ) {
      const pad = textPadding(style.font, fonts)
      const width = colWidth - pad.left - pad.right
      let total = 0
      for (const l of wrapRuns(runs, Math.max(1, width))) total += lineBoxOf(l).height
      height = Math.max(height, total)
    } else {
      height = Math.max(height, lineMetrics(runs).height)
    }
  }
  return height + borderIncrement(wb, sheet.cells.get(row - 1), line, sheet.cells.get(row + 1))
}
