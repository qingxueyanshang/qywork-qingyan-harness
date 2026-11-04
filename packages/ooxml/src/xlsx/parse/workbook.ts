/**
 * xlsx 解析入口：由文件字节得到 `Workbook`。纯函数，不依赖 DOM，可在 Worker 中运行。
 *
 * - 部件按关系定位：包关系的 `officeDocument` 为工作簿，工作簿关系给出主题、样式、共享字符串与各工作表，
 *   工作表关系给出绘图、批注、表格、数据透视表、控件与嵌入对象。部件按顺序读取（并发读取 ZIP 成员更慢）。
 * - ActiveX 控件按其替代图片显示（WPS 表格实测：复选框与文本控件显示替代图片），作为图片排在绘图部件的对象之后；
 *   没有替代图片或锚点的计入 `control`。表单控件按关系计数。
 * - 文件为含 `Workbook` 流的 CFB 复合文档（.xls）时交给 `../biff/` 解析，记录结构错误时返回 `corrupt('biff')`；
 *   其余 CFB 由 ZIP 层分类。
 * - 主文档的内容类型不是 SpreadsheetML 工作簿时返回 `corrupt('workbook')`；部件 XML 结构错误时返回 `corrupt('xml')`。
 *   ZIP 与 OPC 层的失败原样返回。
 * - 已识别但未实现的内容逐项计入 `unsupported`，见 `model.ts` 的 `UnsupportedKind`。
 * - 可以绘制的图元文件图片中文字的字体加入 `fontNames`；位图能否解码由调用方解码时判定（`decodePicture`）。
 */

import { readChart } from '../../drawingml/chart/read.ts'
import { EMPTY_THEME, parseTheme, type Theme } from '../../drawingml/theme.ts'
import { readMetafile } from '../../metafile/index.ts'
import {
  type OpcFailure,
  type OpcPackage,
  openPackage,
  type Relationships,
} from '../../opc/index.ts'
import { XmlScanner, XmlSyntaxError } from '../../xml/index.ts'
import { openLegacy } from '../../zip/index.ts'
import { parseBiff } from '../biff/workbook.ts'
import type {
  SheetImage,
  SheetShape,
  UnsupportedCounts,
  UnsupportedKind,
  Workbook,
  Worksheet,
} from '../model.ts'
import { type PendingChart, resolveSheetCharts, type SheetCharts } from './chart-cells.ts'
import { parseDrawing, type RawControl, readControls } from './drawing.ts'
import { MAX_COL, MAX_ROW } from './refs.ts'
import { parseSharedStrings } from './shared-strings.ts'
import { parseStyles } from './styles.ts'
import { parseWorksheet } from './worksheet.ts'
import { boolAttr, numAttr, relAttr } from './xml-util.ts'

export type XlsxFailure =
  | OpcFailure
  | { readonly kind: 'corrupt'; readonly reason: 'workbook' | 'xml' | 'biff' }

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
  const legacy = openLegacy(data)
  if (legacy?.ok && legacy.value.format === 'xls') return parseBiff(legacy.value.file)
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
  const pending: SheetCharts[] = []
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
      dxfs: sheet.dxfs,
      numFmts: sheet.numFmts,
    })
    const counts: UnsupportedCounts = { ...parsed.unsupported }
    const sheetRels = await readRels(pkg, rel.part)
    const controls = sheetRels.ofKind('control').length > 0 ? readControls(xml) : []
    const drawing = await readDrawing(
      pkg,
      sheetRels,
      parsed.drawingId,
      controls,
      theme ?? EMPTY_THEME,
      fontNames,
      counts,
    )
    const charts: SheetCharts['charts'] = []
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
  const gridSize = { rows: MAX_ROW + 1, cols: MAX_COL + 1 }
  resolveSheetCharts(pending, sheets, sheet.styles, gridSize, theme, fontNames, unsupported)
  return {
    sheets,
    styles: sheet.styles,
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
    gridSize,
    fontNames: [...fontNames],
    unsupported,
  }
}

/** 图片部件的字节；部件缺失或无法读取时为 `null`。可以绘制的图元文件中文字的字体加入 `fontNames`。 */
async function imageBytes(
  pkg: OpcPackage,
  part: string | null,
  fontNames: Set<string>,
): Promise<Uint8Array | null> {
  const r = part === null ? null : await pkg.bytes(part)
  if (r === null || !r.ok || r.value === null) return null
  const mf = readMetafile(r.value)
  if (mf !== null && mf.unsupported.length === 0) for (const name of mf.fonts) fontNames.add(name)
  return r.value
}

/** 绘图部件中的对象与 ActiveX 控件的替代图片（`controls` 为工作表部件中的控件）。 */
async function readDrawing(
  pkg: OpcPackage,
  sheetRels: Relationships,
  drawingId: string | null,
  controls: readonly RawControl[],
  theme: Theme,
  fontNames: Set<string>,
  counts: UnsupportedCounts,
): Promise<{ images: SheetImage[]; shapes: SheetShape[]; charts: PendingChart[] }> {
  const drawingPart = drawingId === null ? null : (sheetRels.byId(drawingId)?.part ?? null)
  const xml = await readText(pkg, drawingPart)
  const drawing =
    drawingPart === null || xml === null
      ? null
      : parseDrawing(xml, await readRels(pkg, drawingPart), theme, fontNames)
  if (drawing !== null) addCounts(counts, drawing.unsupported)
  const images: SheetImage[] = []
  for (const pic of drawing?.pictures ?? []) {
    const bytes = await imageBytes(pkg, pic.part, fontNames)
    if (pic.part === null || bytes === null) {
      counts.image = (counts.image ?? 0) + 1
      continue
    }
    images.push({
      anchor: pic.anchor,
      order: pic.order,
      contentType: pkg.contentType(pic.part) ?? 'application/octet-stream',
      bytes,
      crop: pic.crop,
    })
  }
  let order = drawing?.anchors ?? 0
  for (const c of controls) {
    if (c.control === null || sheetRels.byId(c.control)?.kind !== 'control') continue
    const part = c.image === null ? null : (sheetRels.byId(c.image)?.part ?? null)
    const bytes = await imageBytes(pkg, part, fontNames)
    if (part === null || bytes === null || c.anchor === null) {
      counts.control = (counts.control ?? 0) + 1
      continue
    }
    images.push({
      anchor: c.anchor,
      order: order++,
      contentType: pkg.contentType(part) ?? 'application/octet-stream',
      bytes,
      crop: NO_CROP,
    })
  }
  if (drawing === null) return { images, shapes: [], charts: [] }
  const charts: PendingChart[] = []
  for (const c of drawing.charts) {
    const chartXml = await readText(pkg, c.part)
    const chartRels = chartXml === null ? null : await readRels(pkg, c.part)
    const raw = chartXml === null || chartRels === null ? null : readChart(chartXml, chartRels)
    const override =
      chartRels === null ? null : await readText(pkg, chartRels.part('themeOverride'))
    charts.push({
      anchor: c.anchor,
      order: c.order,
      raw,
      theme: override === null ? null : parseTheme(override),
    })
  }
  return { images, shapes: drawing.shapes, charts }
}

const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 }
