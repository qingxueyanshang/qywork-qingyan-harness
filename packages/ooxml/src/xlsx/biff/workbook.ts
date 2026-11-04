/**
 * .xls（BIFF8）解析入口：由 CFB 中的 `Workbook` 流得到与 xlsx 相同的 `Workbook` 模型。由 `parseXlsx` 在打开 ZIP 之前调用。
 *
 * - 有 FILEPASS 时按缺省密码解密（`crypto.ts`），不能解密时返回已加密。
 * - 首条记录须为 BIFF8（版本 0x0600）工作簿全局子流的 BOF，否则为已损坏（`biff`）：`Workbook` 流只存放 BIFF8，
 *   BIFF5 位于 `Book` 流，在 CFB 分类时已判为无法识别。
 * - 工作表按 BOUNDSHEET 的子流位置读取，宏表、VBA 模块、对话框表与位置无效的子流计入 `otherSheet`。
 * - 图表工作表：图表区见 `chart.ts` 的 `chartsheetAnchor`，缩放比例取子流中的 SCL；没有 Chart 记录时计入 `chart`。
 * - 自动筛选与数据有效性不读取。条件格式见 `conditional.ts`。
 * - 图片见 `drawing.ts`；未绘制的图片对象计入 `image`。图元文件图片（只含可以绘制的）中文字的字体加入 `fontNames`（与 xlsx 相同）。
 * - 嵌入图表与图表工作表的图表由 `chart.ts` 读为规格，全部工作表读完后与 xlsx 经同一个 `resolveSheetCharts` 求值；
 *   组合内的图表、没有子流的图表对象计入 `chart`，图表子流中的其他图形对象计入 `graphic`。
 */

import { readMetafile } from '../../metafile/index.ts'
import type { CfbFile } from '../../zip/cfb.ts'
import type {
  AbsoluteAnchor,
  Sheet,
  SheetChart,
  UnsupportedCounts,
  UnsupportedKind,
  Workbook,
} from '../model.ts'
import { type PendingChart, resolveSheetCharts, type SheetCharts } from '../parse/chart-cells.ts'
import type { XlsxResult } from '../parse/workbook.ts'
import { chartsheetAnchor, readBiffChart } from './chart.ts'
import { decryptWorkbook, findFilepass } from './crypto.ts'
import { readBlips, readDrawing } from './drawing.ts'
import { readGlobals } from './globals.ts'
import { type BiffRecord, Bytes, RT, readRecords } from './records.ts'
import { OBJ_CHART, OBJ_PICTURE, readSheet, scaleZoom } from './sheet.ts'

const BIFF8 = 0x0600
const GLOBALS = 0x0005
const SHEET_WORKSHEET = 0
const SHEET_CHART = 2
/** BIFF8 工作表的行数与列数。 */
const GRID_SIZE = { rows: 65_536, cols: 256 }

function add(target: UnsupportedCounts, kind: UnsupportedKind, n = 1): void {
  target[kind] = (target[kind] ?? 0) + n
}

/** 图表子流中的图形对象（OBJ 的对象类型不为 0），计入 `graphic`。 */
function chartShapes(records: readonly BiffRecord[]): number {
  return records.filter((r) => r.id === RT.OBJ && new Bytes(r.data).u16(4) !== 0).length
}

/** 子流自 `start`（BOF）起，返回同层 EOF 的下标；没有时为记录总数。 */
function substreamEnd(list: readonly BiffRecord[], start: number): number {
  let depth = 0
  for (let i = start; i < list.length; i++) {
    if (list[i]!.id === RT.BOF) depth++
    else if (list[i]!.id === RT.EOF && --depth === 0) return i
  }
  return list.length
}

export async function parseBiff(file: CfbFile): Promise<XlsxResult> {
  const raw = file.stream('Workbook')
  if (raw === null) return { ok: false, failure: { kind: 'corrupt', reason: 'biff' } }
  const filepass = findFilepass(raw)
  const stream = filepass < 0 ? raw : decryptWorkbook(raw, filepass)
  if (stream === null) return { ok: false, failure: { kind: 'encrypted' } }
  const list = readRecords(stream)
  const bof = list[0]
  const head = bof ? new Bytes(bof.data) : null
  if (bof?.id !== RT.BOF || head?.u16(0) !== BIFF8 || head.u16(2) !== GLOBALS) {
    return { ok: false, failure: { kind: 'corrupt', reason: 'biff' } }
  }
  const globalsEnd = list.findIndex((r) => r.id === RT.EOF)
  const g = await readGlobals(list, globalsEnd < 0 ? list.length : globalsEnd)
  const at = new Map(list.map((r, i) => [r.offset, i]))
  const blips = await readBlips(g.drawingGroup)
  const fontNames = new Set(g.fontNames)

  const unsupported: UnsupportedCounts = {}
  const sheets: Sheet[] = []
  const pending: SheetCharts[] = []
  let activeSheet = 0
  for (const [index, entry] of g.sheets.entries()) {
    const start = at.get(entry.offset)
    const known = entry.type === SHEET_WORKSHEET || entry.type === SHEET_CHART
    if (!known || start === undefined || list[start]!.id !== RT.BOF) {
      add(unsupported, 'otherSheet')
      continue
    }
    if (entry.type === SHEET_CHART) {
      const records = list.slice(start + 1, substreamEnd(list, start))
      const counts: UnsupportedCounts = {}
      const shapes = chartShapes(records)
      if (shapes > 0) add(counts, 'graphic', shapes)
      const anchor = chartsheetAnchor(records)
      if (anchor === null) add(counts, 'chart')
      const items: PendingChart<AbsoluteAnchor>[] =
        anchor === null ? [] : [{ anchor, order: 0, raw: readBiffChart(records, g), theme: null }]
      const scl = records.find((r) => r.id === RT.SCL)
      const zoom = scl === undefined ? null : scaleZoom(new Bytes(scl.data))
      const charts: SheetChart<AbsoluteAnchor>[] = []
      pending.push({ charts, counts, items })
      if (index === g.activeTab) activeSheet = sheets.length
      sheets.push({
        kind: 'chartsheet',
        name: entry.name,
        state: entry.state,
        view: { zoom: zoom ?? 100 },
        charts,
        unsupported: counts,
      })
      for (const [kind, n] of Object.entries(counts) as [UnsupportedKind, number][]) {
        add(unsupported, kind, n)
      }
      continue
    }
    const parsed = readSheet(list, start, g)
    if (parsed.dialog) {
      add(unsupported, 'otherSheet')
      continue
    }
    const counts: UnsupportedCounts = { ...parsed.unsupported }
    const drawing = readDrawing(parsed.drawing, parsed.objects, blips)
    const images = drawing.images
    const pictures = parsed.objects.filter((o) => o.type === OBJ_PICTURE).length
    if (pictures > images.length) add(counts, 'image', pictures - images.length)
    for (const image of images) {
      for (const name of readMetafile(image.bytes)?.fonts ?? []) fontNames.add(name)
    }
    const items: PendingChart[] = []
    for (const c of drawing.charts) {
      const stream = parsed.charts.find((s) => s.object === c.object)
      if (stream === undefined) continue
      const records = list.slice(stream.start, stream.end)
      const shapes = chartShapes(records)
      if (shapes > 0) add(counts, 'graphic', shapes)
      items.push({ anchor: c.anchor, order: c.order, raw: readBiffChart(records, g), theme: null })
    }
    const chartObjects = parsed.objects.filter((o) => o.type === OBJ_CHART).length
    if (chartObjects > items.length) add(counts, 'chart', chartObjects - items.length)
    const charts: SheetCharts['charts'] = []
    pending.push({ charts, counts, items })
    if (index === g.activeTab) activeSheet = sheets.length
    sheets.push({
      kind: 'worksheet',
      name: entry.name,
      state: entry.state,
      cells: parsed.cells,
      rows: parsed.rows,
      cols: parsed.cols,
      format: parsed.format,
      merges: parsed.merges,
      view: parsed.view,
      conditionalFormats: parsed.conditionalFormats,
      images,
      shapes: [],
      charts,
      autoFilter: null,
      maxRow: parsed.maxRow,
      maxCol: parsed.maxCol,
      unsupported: counts,
    })
    for (const [kind, n] of Object.entries(counts) as [UnsupportedKind, number][]) {
      add(unsupported, kind, n)
    }
  }
  resolveSheetCharts(pending, sheets, g.styles, GRID_SIZE, g.theme, fontNames, unsupported)
  const workbook: Workbook = {
    sheets,
    styles: g.styles,
    defaultFont: g.defaultFont,
    minorFont: g.theme
      ? {
          latin: g.theme.fonts.minor.latin,
          eastAsian: g.theme.fonts.minor.scripts.get('Hans') ?? g.theme.fonts.minor.ea,
        }
      : null,
    date1904: g.date1904,
    palette: g.palette,
    activeSheet,
    gridSize: GRID_SIZE,
    fontNames: [...fontNames],
    unsupported,
  }
  return { ok: true, value: workbook }
}
