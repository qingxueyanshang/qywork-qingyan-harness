/**
 * xlsx 解析入口：由文件字节得到 `Workbook`。纯函数，不依赖 DOM，可在 Worker 中运行。
 *
 * - 部件按关系定位：包关系的 `officeDocument` 为工作簿，工作簿关系给出主题、样式、共享字符串与各工作表，
 *   工作表关系给出绘图、批注、表格、数据透视表、控件与嵌入对象。部件按顺序读取（并发读取 ZIP 成员更慢）。
 * - 主文档的内容类型不是 SpreadsheetML 工作簿时返回 `corrupt('workbook')`；部件 XML 结构错误时返回 `corrupt('xml')`。
 *   ZIP 与 OPC 层的失败原样返回。
 * - 已识别但未实现的内容逐项计入 `unsupported`，见 `model.ts` 的 `UnsupportedKind`。
 */

import { type RawChart, readChart } from '../../drawingml/chart/read.ts'
import { collectChartFonts, resolveChart } from '../../drawingml/chart/resolve.ts'
import { EMPTY_THEME, parseTheme, type Theme } from '../../drawingml/theme.ts'
import {
  type OpcFailure,
  type OpcPackage,
  openPackage,
  type Relationships,
} from '../../opc/index.ts'
import { XmlScanner, XmlSyntaxError } from '../../xml/index.ts'
import type {
  DrawingAnchor,
  SheetChart,
  SheetImage,
  SheetShape,
  UnsupportedCounts,
  UnsupportedKind,
  Workbook,
  Worksheet,
} from '../model.ts'
import { workbookCells } from './chart-cells.ts'
import { parseDrawing } from './drawing.ts'
import { parseSharedStrings } from './shared-strings.ts'
import { parseStyles } from './styles.ts'
import { parseWorksheet } from './worksheet.ts'
import { boolAttr, numAttr, relAttr } from './xml-util.ts'

export type XlsxFailure =
  | OpcFailure
  | { readonly kind: 'corrupt'; readonly reason: 'workbook' | 'xml' }

export type XlsxResult =
  | { readonly ok: true; readonly value: Workbook }
  | { readonly ok: false; readonly failure: XlsxFailure }

const WORKBOOK_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
  'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  'application/vnd.ms-excel.template.macroEnabled.main+xml',
])

/** 工作表关系中按部件计数的种类：一个关系计一项。 */
const COUNTED_RELATIONSHIPS: Record<string, UnsupportedKind> = {
  table: 'table',
  pivotTable: 'pivotTable',
  ctrlProp: 'control',
  oleObject: 'oleObject',
  package: 'oleObject',
}

class PartError extends Error {
  constructor(readonly failure: XlsxFailure) {
    super(failure.kind)
  }
}

function addCounts(target: UnsupportedCounts, source: UnsupportedCounts): void {
  for (const [kind, n] of Object.entries(source) as [UnsupportedKind, number][]) {
    target[kind] = (target[kind] ?? 0) + n
  }
}

async function readText(pkg: OpcPackage, part: string | null): Promise<string | null> {
  if (part === null) return null
  const r = await pkg.text(part)
  if (!r.ok) throw new PartError(r.failure)
  return r.value
}

async function readRels(pkg: OpcPackage, source: string): Promise<Relationships> {
  const r = await pkg.relationships(source)
  if (!r.ok) throw new PartError(r.failure)
  return r.value
}

/** 已读取、待求值的图表：求值需要全部工作表的单元格，在全部工作表解析之后进行。`raw` 为 `null` 时部件缺失。 */
interface PendingChart {
  readonly anchor: DrawingAnchor
  readonly order: number
  readonly raw: RawChart | null
}

interface SheetEntry {
  readonly name: string
  readonly state: Worksheet['state']
  readonly relId: string
}

function readWorkbookXml(xml: string): {
  sheets: SheetEntry[]
  date1904: boolean
  activeTab: number
} {
  const x = new XmlScanner(xml)
  const sheets: SheetEntry[] = []
  let date1904 = false
  let activeTab = 0
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start') continue
    const local = x.local
    if (local === 'workbookPr') date1904 = boolAttr(x, 'date1904', false)
    else if (local === 'workbookView' && x.depth === 3) activeTab = numAttr(x, 'activeTab') ?? 0
    else if (local === 'sheet') {
      const state = x.attr('state')
      sheets.push({
        name: x.attr('name') ?? '',
        state: state === 'hidden' || state === 'veryHidden' ? state : 'visible',
        relId: relAttr(x, 'id') ?? '',
      })
    }
  }
  return { sheets, date1904, activeTab }
}

function countComments(xml: string): number {
  const x = new XmlScanner(xml)
  let n = 0
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'start' && x.local === 'comment') n++
  }
  return n
}

export async function parseXlsx(data: Uint8Array<ArrayBuffer>): Promise<XlsxResult> {
  const opened = await openPackage(data)
  if (!opened.ok) return opened
  try {
    return { ok: true, value: await parsePackage(opened.value) }
  } catch (e) {
    if (e instanceof PartError) return { ok: false, failure: e.failure }
    if (e instanceof XmlSyntaxError)
      return { ok: false, failure: { kind: 'corrupt', reason: 'xml' } }
    throw e
  }
}

async function parsePackage(pkg: OpcPackage): Promise<Workbook> {
  const root = await readRels(pkg, '/')
  const workbookPart = root.part('officeDocument')
  if (workbookPart === null || !WORKBOOK_TYPES.has(pkg.contentType(workbookPart) ?? '')) {
    throw new PartError({ kind: 'corrupt', reason: 'workbook' })
  }
  const workbookXml = await readText(pkg, workbookPart)
  if (workbookXml === null) throw new PartError({ kind: 'corrupt', reason: 'workbook' })
  const rels = await readRels(pkg, workbookPart)
  const info = readWorkbookXml(workbookXml)

  const themeXml = await readText(pkg, rels.part('theme'))
  const theme: Theme | null = themeXml === null ? null : parseTheme(themeXml)
  const sheet = parseStyles(await readText(pkg, rels.part('styles')), theme)
  const fontNames = new Set(sheet.fontNames)
  const strings = parseSharedStrings(
    await readText(pkg, rels.part('sharedStrings')),
    sheet.defaultFont,
    sheet.colors,
    fontNames,
  )

  const unsupported: UnsupportedCounts = {}
  const sheets: Worksheet[] = []
  const pending: { charts: SheetChart[]; counts: UnsupportedCounts; items: PendingChart[] }[] = []
  let activeSheet = 0
  for (const [index, entry] of info.sheets.entries()) {
    const rel = rels.byId(entry.relId)
    const kind = rel?.kind ?? ''
    if (kind === 'chartsheet') {
      unsupported.chartsheet = (unsupported.chartsheet ?? 0) + 1
      continue
    }
    if (kind !== 'worksheet' || !rel?.part) {
      unsupported.otherSheet = (unsupported.otherSheet ?? 0) + 1
      continue
    }
    const xml = await readText(pkg, rel.part)
    if (xml === null) {
      unsupported.otherSheet = (unsupported.otherSheet ?? 0) + 1
      continue
    }
    const parsed = parseWorksheet(xml, {
      strings,
      styleCount: sheet.styles.length,
      date1904: info.date1904,
      defaultFont: sheet.defaultFont,
      colors: sheet.colors,
      fontNames,
    })
    const counts: UnsupportedCounts = { ...parsed.unsupported }
    const sheetRels = await readRels(pkg, rel.part)
    const drawing = await readDrawing(
      pkg,
      sheetRels,
      parsed.drawingId,
      theme ?? EMPTY_THEME,
      fontNames,
      counts,
    )
    const charts: SheetChart[] = []
    pending.push({ charts, counts, items: drawing.charts })
    for (const r of sheetRels.list) {
      const counted =
        COUNTED_RELATIONSHIPS[r.kind] ?? (r.kind.endsWith('/slicer') ? 'slicer' : null)
      if (counted) counts[counted] = (counts[counted] ?? 0) + 1
      if (r.kind === 'comments' && r.part) {
        const xmlText = await readText(pkg, r.part)
        if (xmlText !== null) counts.comment = (counts.comment ?? 0) + countComments(xmlText)
      }
    }
    if (index === info.activeTab) activeSheet = sheets.length
    sheets.push({
      name: entry.name,
      state: entry.state,
      cells: parsed.cells,
      rows: parsed.rows,
      cols: parsed.cols,
      format: parsed.format,
      merges: parsed.merges,
      view: parsed.view,
      conditionalFormats: parsed.conditionalFormats,
      images: drawing.images,
      shapes: drawing.shapes,
      charts,
      autoFilter: parsed.autoFilter,
      maxRow: parsed.maxRow,
      maxCol: parsed.maxCol,
      unsupported: counts,
    })
    addCounts(unsupported, counts)
  }
  // 图表按工作簿主题求值，数据按引用从单元格取；部件缺失或含不支持的内容时计入 `chart`。
  const cells = workbookCells(sheets, sheet.styles)
  for (const p of pending) {
    for (const c of p.items) {
      const chart =
        c.raw === null
          ? null
          : resolveChart(c.raw, {
              theme: theme ?? EMPTY_THEME,
              colors: { scheme: (theme ?? EMPTY_THEME).colors },
              host: 'sheet',
              cells,
            })
      if (chart === null) {
        p.counts.chart = (p.counts.chart ?? 0) + 1
        unsupported.chart = (unsupported.chart ?? 0) + 1
        continue
      }
      collectChartFonts(fontNames, chart)
      p.charts.push({ anchor: c.anchor, order: c.order, chart })
    }
  }
  return {
    sheets,
    styles: sheet.styles,
    dxfs: sheet.dxfs,
    defaultFont: sheet.defaultFont,
    minorFont: theme
      ? {
          latin: theme.fonts.minor.latin,
          eastAsian: theme.fonts.minor.scripts.get('Hans') ?? theme.fonts.minor.ea,
        }
      : null,
    date1904: info.date1904,
    palette: sheet.palette,
    activeSheet,
    fontNames: [...fontNames],
    unsupported,
  }
}

async function readDrawing(
  pkg: OpcPackage,
  sheetRels: Relationships,
  drawingId: string | null,
  theme: Theme,
  fontNames: Set<string>,
  counts: UnsupportedCounts,
): Promise<{ images: SheetImage[]; shapes: SheetShape[]; charts: PendingChart[] }> {
  const drawingPart = drawingId === null ? null : (sheetRels.byId(drawingId)?.part ?? null)
  const xml = await readText(pkg, drawingPart)
  if (drawingPart === null || xml === null) return { images: [], shapes: [], charts: [] }
  const drawing = parseDrawing(xml, await readRels(pkg, drawingPart), theme, fontNames)
  addCounts(counts, drawing.unsupported)
  const images: SheetImage[] = []
  for (const pic of drawing.pictures) {
    const bytes = pic.part === null ? null : await pkg.bytes(pic.part)
    if (pic.part === null || bytes === null || !bytes.ok || bytes.value === null) {
      counts.image = (counts.image ?? 0) + 1
      continue
    }
    images.push({
      anchor: pic.anchor,
      order: pic.order,
      contentType: pkg.contentType(pic.part) ?? 'application/octet-stream',
      bytes: bytes.value,
      crop: pic.crop,
    })
  }
  const charts: PendingChart[] = []
  for (const c of drawing.charts) {
    const chartXml = await readText(pkg, c.part)
    const raw = chartXml === null ? null : readChart(chartXml, await readRels(pkg, c.part))
    charts.push({ anchor: c.anchor, order: c.order, raw })
  }
  return { images, shapes: drawing.shapes, charts }
}
