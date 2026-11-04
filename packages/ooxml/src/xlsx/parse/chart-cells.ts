/**
 * 工作表图表的求值（xlsx 与 .xls 两个入口共用）与系列引用（`c:f`）的单元格取值：WPS 表格按单元格显示图表数据，不用图表缓存。
 *
 * - 引用形如 `Sheet1!$A$2:$A$6`、`'数据 表'!$B$1`，多区域写为 `(区域,区域)`，按区域顺序连接；整列与整行引用（到达工作簿网格的
 *   末行或末列，见 `Workbook.gridSize`）截到含内容的范围。
 *   外部工作簿（`[1]Sheet1!…`）、名称、缺少工作表名与二维区域无法解析，返回 `null`，调用方改用缓存值。
 * - `visibleOnly` 为真时略去隐藏行（含未列出且 `zeroHeight` 为真的行、行高为 0 的行）与隐藏列中的单元格。
 * - 没有缓存值的公式单元格按空单元格处理（WPS 会重新计算该公式，此处不计算）。
 */

import type { RawChart } from '../../drawingml/chart/read.ts'
import {
  type CellDatum,
  type ChartCells,
  collectChartFonts,
  collectChartImages,
  resolveChart,
} from '../../drawingml/chart/resolve.ts'
import { EMPTY_THEME, type Theme } from '../../drawingml/theme.ts'
import type {
  CellRange,
  CellStyle,
  DrawingAnchor,
  SheetChart,
  UnsupportedCounts,
  Workbook,
  Worksheet,
} from '../model.ts'
import { parseRange } from './refs.ts'

interface Area {
  readonly sheet: Worksheet
  readonly range: CellRange
}

/** 按逗号拆分多区域引用；引号内的逗号不拆分。 */
function splitAreas(ref: string): string[] {
  let s = ref.trim()
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1)
  const out: string[] = []
  let start = 0
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "'") quoted = !quoted
    else if (c === ',' && !quoted) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.map((a) => a.trim())
}

function parseArea(
  text: string,
  sheets: ReadonlyMap<string, Worksheet>,
  grid: Workbook['gridSize'],
): Area | null {
  const bang = text.lastIndexOf('!')
  if (bang <= 0) return null
  let name = text.slice(0, bang)
  if (name.startsWith("'") && name.endsWith("'") && name.length >= 2) {
    name = name.slice(1, -1).replaceAll("''", "'")
  }
  if (name.startsWith('[')) return null
  const sheet = sheets.get(name)
  const range = parseRange(text.slice(bang + 1))
  if (sheet === undefined || range === null) return null
  if (range.bottom > range.top && range.right > range.left) return null
  // 整列、整行引用截到含内容的范围。
  const bottom = range.bottom >= grid.rows - 1 ? Math.max(range.top, sheet.maxRow) : range.bottom
  const right = range.right >= grid.cols - 1 ? Math.max(range.left, sheet.maxCol) : range.right
  return { sheet, range: { ...range, bottom, right } }
}

function rowHidden(sheet: Worksheet, row: number): boolean {
  const spec = sheet.rows.get(row)
  if (spec === undefined) return sheet.format.zeroHeight
  return spec.hidden || spec.height === 0
}

function colHidden(sheet: Worksheet, col: number): boolean {
  return sheet.cols.some((c) => c.hidden && c.min <= col && col <= c.max)
}

function datum(
  sheet: Worksheet,
  styles: readonly CellStyle[],
  row: number,
  col: number,
): CellDatum {
  const cell = sheet.cells.get(row)?.get(col)
  const v = cell?.value ?? null
  if (v === null || v.type === 'formula') return { kind: 'empty' }
  if (v.type === 'number') {
    return { kind: 'number', value: v.value, format: styles[cell!.style]?.numFmt ?? 'General' }
  }
  if (v.type === 'boolean') return { kind: 'boolean', value: v.value }
  if (v.type === 'error') return { kind: 'error', text: v.value }
  return { kind: 'text', text: v.value }
}

/** 工作簿的图表单元格取值；`sheets` 为全部已解析的工作表（含隐藏的工作表），`grid` 为网格的行数与列数。 */
export function workbookCells(
  sheets: readonly Worksheet[],
  styles: readonly CellStyle[],
  grid: Workbook['gridSize'],
): ChartCells {
  const byName = new Map(sheets.map((s) => [s.name, s]))
  return {
    read(ref, visibleOnly) {
      const areas: Area[] = []
      for (const text of splitAreas(ref)) {
        const area = parseArea(text, byName, grid)
        if (area === null) return null
        areas.push(area)
      }
      const out: CellDatum[] = []
      for (const { sheet, range } of areas) {
        for (let r = range.top; r <= range.bottom; r++) {
          if (visibleOnly && rowHidden(sheet, r)) continue
          for (let c = range.left; c <= range.right; c++) {
            if (visibleOnly && colHidden(sheet, c)) continue
            out.push(datum(sheet, styles, r, c))
          }
        }
      }
      return out
    },
  }
}

/**
 * 已读取、待求值的图表：求值需要全部工作表的单元格，在全部工作表解析之后进行。`raw` 为 `null` 时部件缺失；
 * `theme` 为图表部件引用的主题覆盖，没有时为 `null`。
 */
export interface PendingChart {
  readonly anchor: DrawingAnchor
  readonly order: number
  readonly raw: RawChart | null
  readonly theme: Theme | null
}

/** 一张工作表的待求值图表；求值结果加入 `charts`，未绘制的计入 `counts`。 */
export interface SheetCharts {
  readonly charts: SheetChart[]
  readonly counts: UnsupportedCounts
  readonly items: readonly PendingChart[]
}

/**
 * 求值全部工作表的图表。图表按工作簿主题求值，引用主题覆盖时颜色方案与主题字体取自主题覆盖（WPS 表格实测）；
 * 数据按引用从单元格取；部件缺失或含不支持的内容时计入 `chart`。图片填充不绘制，引用的图片按部件计入 `image`。
 * 图表用到的字体加入 `fontNames`，计数同时加入工作簿的 `unsupported`。
 */
export function resolveSheetCharts(
  pending: readonly SheetCharts[],
  sheets: readonly Worksheet[],
  styles: readonly CellStyle[],
  grid: Workbook['gridSize'],
  theme: Theme | null,
  fontNames: Set<string>,
  unsupported: UnsupportedCounts,
): void {
  const cells = workbookCells(sheets, styles, grid)
  for (const p of pending) {
    for (const c of p.items) {
      const own = c.theme ?? theme ?? EMPTY_THEME
      const chart =
        c.raw === null
          ? null
          : resolveChart(c.raw, {
              theme: own,
              colors: { scheme: own.colors },
              host: 'sheet',
              cells,
            })
      if (chart === null) {
        p.counts.chart = (p.counts.chart ?? 0) + 1
        unsupported.chart = (unsupported.chart ?? 0) + 1
        continue
      }
      collectChartFonts(fontNames, chart)
      const fills = new Set<string>()
      collectChartImages(fills, chart)
      if (fills.size > 0) {
        p.counts.image = (p.counts.image ?? 0) + fills.size
        unsupported.image = (unsupported.image ?? 0) + fills.size
      }
      p.charts.push({ anchor: c.anchor, order: c.order, chart })
    }
  }
}
