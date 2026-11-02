/**
 * docx 解析入口：由文件字节得到 `DocxDocument`。纯函数，不依赖 DOM，可在 Worker 中运行。
 *
 * - 部件按关系定位：包关系的 `officeDocument` 为主文档，其关系给出样式、编号、设置、字体表与主题；
 *   缺少的部件按空部件处理。
 * - 主文档的内容类型不是 WordprocessingML 文档（含启用宏的文档与模板）或主文档不存在时返回 `corrupt('document')`；
 *   部件 XML 结构错误或元素嵌套过深（`parse/xml.ts` 的 `MAX_DEPTH`）时返回 `corrupt('xml')`。ZIP 与 OPC 层的失败原样返回。
 * - `AlternateContent` 选择 WordprocessingML 2010 扩展、绘图形状、组合与画布的分支，使其中的对象按 DrawingML 计数。
 * - 各节引用的页眉页脚部件按引用它的第一节的版面解析；图片（嵌入式图片、浮动对象、页面背景）按所在部件的关系
 *   取得部件字节，同一部件只读取一次。部件不存在时该页眉页脚没有内容，图片的 `media` 为 -1。
 *   引用浏览器无法解码的图片格式时每次引用计一次 `imageFormat`，与其他种类相同；可以绘制的图元文件
 *   （`../metafile/` 读取后没有未实现的内容）不计。
 * - 每个页眉页脚部件只读取一次，其中的未实现元素与正文按同一口径计入 `unsupported`（每个部件计一次，不按页重复）。
 * - 形状的颜色按主题与缺省颜色映射求值；没有主题部件时按空主题。
 * - 图表：主文档与页眉页脚部件引用的图表部件在读取其内容之前读取并求值（`loadCharts`），图表中图片填充的部件
 *   随引用登记为图片部件。
 * - SmartArt：主文档与页眉页脚部件引用的数据、布局、样式、颜色部件在读取其内容之前读取文字（`loadDiagramParts`），
 *   读到 `dgm:relIds` 时按其中的四个部件名读取并按文档主题求值。
 * - 页面背景（颜色与整页图片）只在设置开启 `displayBackgroundShape` 时保留（WPS 实测：未开启时颜色与图片都不显示）。
 */

import type { Chart } from '../drawingml/chart/model.ts'
import { readChart } from '../drawingml/chart/read.ts'
import { type ChartScope, collectChartImages, resolveChart } from '../drawingml/chart/resolve.ts'
import { type DiagramParts, readDiagram } from '../drawingml/diagram/read.ts'
import { resolveDiagram } from '../drawingml/diagram/resolve.ts'
import { countImage, drawableImage } from '../drawingml/shape/resolve.ts'
import { EMPTY_THEME, parseTheme } from '../drawingml/theme.ts'
import {
  type OpcFailure,
  type OpcPackage,
  openPackage,
  type Relationships,
} from '../opc/package.ts'
import { PartScanner } from '../opc/scanner.ts'
import { XmlSyntaxError } from '../xml/index.ts'
import type { Block, DocxDocument, MediaPart, UnsupportedCounts, UnsupportedKind } from './model.ts'
import { type BodyEnv, BodyReader } from './parse/body.ts'
import { EMPTY_NUMBERING, readNumbering } from './parse/numbering.ts'
import { DEFAULT_SETTINGS, readFontTable, readSettings } from './parse/settings.ts'
import { EMPTY_STYLES, readStyles } from './parse/styles.ts'
import { NestingError } from './parse/xml.ts'
import { Resolver } from './resolve/cascade.ts'
import { NumberingState } from './resolve/numbering.ts'

export type DocxFailure =
  | OpcFailure
  | { readonly kind: 'corrupt'; readonly reason: 'document' | 'xml' }

export type DocxResult =
  | { readonly ok: true; readonly value: DocxDocument }
  | { readonly ok: false; readonly failure: DocxFailure }

const DOCUMENT_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  'application/vnd.ms-word.document.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml',
  'application/vnd.ms-word.template.macroEnabledTemplate.main+xml',
])

const SUPPORTED_NAMESPACES = [
  'http://schemas.microsoft.com/office/word/2010/wordml',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
  'http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing',
]

/**
 * 图表的宿主规则（`Chart.host`）：WPS 文字与 WPS 表格相同（构造文档实测：未写出格式的图表区有 0.75 磅 `#898989` 边框；
 * 9 磅标签、140 像素高的数值轴取 2 为单位，10 磅与 10.5 磅标签、约 170 像素高时取 1）。
 */
const CHART_HOST: Chart['host'] = 'sheet'

class PartError extends Error {
  constructor(readonly failure: DocxFailure) {
    super(failure.kind)
  }
}

async function partText(pkg: OpcPackage, part: string | null): Promise<string | null> {
  if (part === null) return null
  const r = await pkg.text(part)
  if (!r.ok) throw new PartError(r.failure)
  return r.value
}

/**
 * `rels` 引用的图表部件读取并求值后加入 `into`；部件不存在或含未实现内容时为 `null`。
 * 图表部件引用主题覆盖（`themeOverride`）时颜色与主题字体取自它（WPS 实测：图表的方案颜色按主题覆盖显示）。
 */
async function loadCharts(
  pkg: OpcPackage,
  rels: Relationships,
  scope: ChartScope,
  into: Map<string, Chart | null>,
): Promise<void> {
  for (const rel of rels.ofKind('chart')) {
    const part = rel.part
    if (part === null || rel.external || into.has(part)) continue
    const xml = await partText(pkg, part)
    const chartRels = xml === null ? null : await pkg.relationships(part)
    if (chartRels !== null && !chartRels.ok) throw new PartError(chartRels.failure)
    if (xml === null || chartRels === null) {
      into.set(part, null)
      continue
    }
    const override = await partText(pkg, chartRels.value.part('themeOverride'))
    const theme = override === null ? null : parseTheme(override)
    const own = theme === null ? scope : { ...scope, theme, colors: { scheme: theme.colors } }
    into.set(part, resolveChart(readChart(xml, chartRels.value), own))
  }
}

const DIAGRAM_PARTS = ['diagramData', 'diagramLayout', 'diagramQuickStyle', 'diagramColors']

/** SmartArt 部件的文字（部件不存在时为 `null`）与数据部件的关系表，按部件名。 */
interface DiagramTexts {
  readonly texts: Map<string, string | null>
  readonly dataRels: Map<string, Relationships>
}

/** `rels` 引用的 SmartArt 部件读取文字后加入 `into`。 */
async function loadDiagramParts(
  pkg: OpcPackage,
  rels: Relationships,
  into: DiagramTexts,
): Promise<void> {
  for (const kind of DIAGRAM_PARTS) {
    for (const rel of rels.ofKind(kind)) {
      const part = rel.part
      if (part === null || rel.external || into.texts.has(part)) continue
      const text = await partText(pkg, part)
      into.texts.set(part, text)
      if (kind !== 'diagramData' || text === null) continue
      const dataRels = await pkg.relationships(part)
      if (!dataRels.ok) throw new PartError(dataRels.failure)
      into.dataRels.set(part, dataRels.value)
    }
  }
}

export async function parseDocx(data: Uint8Array<ArrayBuffer>): Promise<DocxResult> {
  const opened = await openPackage(data)
  if (!opened.ok) return opened
  try {
    return { ok: true, value: await parsePackage(opened.value) }
  } catch (e) {
    if (e instanceof PartError) return { ok: false, failure: e.failure }
    if (e instanceof XmlSyntaxError || e instanceof NestingError)
      return { ok: false, failure: { kind: 'corrupt', reason: 'xml' } }
    throw e
  }
}

async function parsePackage(pkg: OpcPackage): Promise<DocxDocument> {
  const root = await pkg.relationships('/')
  if (!root.ok) throw new PartError(root.failure)
  const main = root.value.part('officeDocument')
  if (main === null || !DOCUMENT_TYPES.has(pkg.contentType(main) ?? '')) {
    throw new PartError({ kind: 'corrupt', reason: 'document' })
  }
  const xml = await partText(pkg, main)
  if (xml === null) throw new PartError({ kind: 'corrupt', reason: 'document' })
  const rels = await pkg.relationships(main)
  if (!rels.ok) throw new PartError(rels.failure)
  const part = (kind: string) => partText(pkg, rels.value.part(kind))

  const stylesXml = await part('styles')
  const styles = stylesXml === null ? EMPTY_STYLES : readStyles(new PartScanner(stylesXml))
  const numberingXml = await part('numbering')
  const numbering =
    numberingXml === null ? EMPTY_NUMBERING : readNumbering(new PartScanner(numberingXml))
  const settingsXml = await part('settings')
  const settings =
    settingsXml === null ? DEFAULT_SETTINGS : readSettings(new PartScanner(settingsXml))
  const fontTableXml = await part('fontTable')
  const fontTable = fontTableXml === null ? new Map() : readFontTable(new PartScanner(fontTableXml))
  const themeXml = await part('theme')
  const theme = themeXml === null ? null : parseTheme(themeXml)

  const unsupported: UnsupportedCounts = {}
  const count = (kind: UnsupportedKind) => {
    unsupported[kind] = (unsupported[kind] ?? 0) + 1
  }
  const state = new NumberingState(numbering, styles, () => count('numberFormat'))
  const resolver = new Resolver(styles, state, {
    scheme: theme?.fonts ?? null,
    eastAsiaLanguage: settings.eastAsiaLanguage,
    bidiLanguage: settings.bidiLanguage,
  })
  const mediaParts: string[] = []
  const media = (part: string): number => {
    if (!pkg.has(part)) return -1
    const known = mediaParts.indexOf(part)
    if (known >= 0) return known
    mediaParts.push(part)
    return mediaParts.length - 1
  }
  const colors = { scheme: (theme ?? EMPTY_THEME).colors }
  const chartScope: ChartScope = {
    theme: theme ?? EMPTY_THEME,
    colors,
    host: CHART_HOST,
    cells: null,
  }
  const charts = new Map<string, Chart | null>()
  const diagrams: DiagramTexts = { texts: new Map(), dataRels: new Map() }
  const text = (part: string | null) => (part === null ? null : (diagrams.texts.get(part) ?? null))
  const diagram = (parts: DiagramParts) => {
    const data = text(parts.data)
    const dataRels = diagrams.dataRels.get(parts.data)
    if (data === null || dataRels === undefined) return null
    const raw = readDiagram({
      data,
      dataRels,
      layout: text(parts.layout),
      style: text(parts.style),
      colors: text(parts.colors),
    })
    return resolveDiagram(raw, { theme: theme ?? EMPTY_THEME, colors })
  }
  /** 图片的每次引用：部件字节读取后判定格式，按引用计数。 */
  const references: { part: string; found: (kind: UnsupportedKind) => void }[] = []
  const env = (source: Relationships, found: (kind: UnsupportedKind) => void): BodyEnv => {
    const image = (part: string) => {
      const index = media(part)
      if (index >= 0) references.push({ part, found })
      return index
    }
    return {
      styles,
      rels: source,
      scope: { theme: theme ?? EMPTY_THEME, colors, found: { push: () => {} } },
      media: image,
      chart: (part) => {
        const chart = charts.get(part) ?? null
        if (chart !== null) {
          const images = new Set<string>()
          collectChartImages(images, chart)
          for (const p of images) image(p)
        }
        return chart
      },
      diagram,
      gridInTables: settings.adjustLineHeightInTable,
      mathJustification: settings.math.defaultJustification,
    }
  }
  const scan = (text: string) => new PartScanner(text, SUPPORTED_NAMESPACES)
  await loadCharts(pkg, rels.value, chartScope, charts)
  await loadDiagramParts(pkg, rels.value, diagrams)
  const body = new BodyReader(scan(xml), resolver, count, env(rels.value, count)).read()
  const parts: Record<string, readonly Block[]> = {}
  for (const section of body.sections) {
    const { headers, footers } = section
    for (const id of [
      headers.default,
      headers.first,
      headers.even,
      footers.default,
      footers.first,
      footers.even,
    ]) {
      if (id === null || id in parts) continue
      const part = rels.value.byId(id)?.part ?? null
      const text = await partText(pkg, part)
      const partRels = part === null ? null : await pkg.relationships(part)
      if (partRels !== null && !partRels.ok) throw new PartError(partRels.failure)
      if (partRels !== null) {
        await loadCharts(pkg, partRels.value, chartScope, charts)
        await loadDiagramParts(pkg, partRels.value, diagrams)
      }
      parts[id] =
        text === null || partRels === null
          ? []
          : new BodyReader(scan(text), resolver, count, env(partRels.value, count)).readStory(
              section,
            )
    }
  }
  const mediaList: MediaPart[] = []
  for (const part of mediaParts) {
    const r = await pkg.bytes(part)
    if (!r.ok) throw new PartError(r.failure)
    mediaList.push({
      part,
      contentType: pkg.contentType(part) ?? '',
      bytes: r.value === null ? new Uint8Array(0) : new Uint8Array(r.value),
    })
  }
  for (const ref of references) {
    const bytes = mediaList[mediaParts.indexOf(ref.part)]!.bytes
    countImage(drawableImage(pkg.contentType(ref.part) ?? '', bytes), {
      push: () => ref.found('imageFormat'),
    })
  }
  return {
    sections: body.sections,
    body: body.body,
    settings: {
      defaultTabStop: settings.defaultTabStop / 20,
      expandLineBreak: !settings.doNotExpandShiftReturn,
      noLineBreakBefore: settings.noLineBreakBefore,
      noLineBreakAfter: settings.noLineBreakAfter,
      compressPunctuation: settings.compressPunctuation,
      balanceSingleByte: settings.balanceSingleByte,
      compatibilityMode: settings.compatibilityMode,
      evenAndOddHeaders: settings.evenAndOddHeaders,
      gridInTables: settings.adjustLineHeightInTable,
      math: settings.math,
    },
    fontTable,
    unsupported,
    parts,
    media: mediaList,
    background: settings.displayBackgroundShape ? body.background : null,
  }
}
