/**
 * pptx 解析入口：由文件字节得到 `Presentation`。纯函数，不依赖 DOM，可在 Worker 中运行。
 *
 * - 文件为含 `PowerPoint Document` 流的 CFB 复合文档（.ppt）时交给 `binary/` 解析，结构错误时返回 `corrupt('ppt')`；
 *   其余 CFB 由 ZIP 层分类。
 * - 部件按关系定位：包关系的 `officeDocument` 为演示文稿，其关系给出各幻灯片、母版与表格样式；
 *   幻灯片关系给出版式，版式关系给出母版，母版关系给出主题。版式、母版与主题按部件缓存，部件按顺序读取。
 * - 主文档的内容类型不是演示文稿（含启用宏的演示文稿与模板）、幻灯片关系指向不存在的部件时返回 `corrupt('presentation')`；
 *   部件 XML 结构错误时返回 `corrupt('xml')`。ZIP 与 OPC 层的失败原样返回。
 * - 幻灯片缺少版式或母版、母版缺少主题时按空部件与空主题求值，不视为失败。
 * - 颜色映射：幻灯片的覆盖映射，否则版式的覆盖映射，否则母版的 `clrMap`。
 * - 图表部件、SmartArt 的四个部件与墨迹部件按形状树中的引用读取并按部件缓存，求值时使用所在幻灯片的主题与颜色映射；
 *   图表部件引用主题覆盖（`themeOverride`）时颜色方案与主题字体取自主题覆盖（WPS 演示实测）。
 * - 图片：内容类型不是浏览器可解码位图的图片部件（与缺少内容类型的部件）在幻灯片求值前逐个读取字节，可以绘制的图元文件
 *   不计入 `imageFormat`，其文字的字体列入 `Presentation.metafileFonts`。
 */

import { type RawChart, readChart } from '../drawingml/chart/read.ts'
import { DEFAULT_COLOR_MAP } from '../drawingml/color.ts'
import type { RawDiagram } from '../drawingml/diagram/model.ts'
import { type DiagramParts, readDiagram } from '../drawingml/diagram/read.ts'
import type { ShapeFill } from '../drawingml/fill.ts'
import { decodableImage } from '../drawingml/shape/resolve.ts'
import { EMPTY_THEME, parseTheme, type Theme } from '../drawingml/theme.ts'
import { type Metafile, readMetafile } from '../metafile/index.ts'
import {
  type OpcFailure,
  type OpcPackage,
  openPackage,
  type Relationships,
} from '../opc/package.ts'
import { PartScanner } from '../opc/scanner.ts'
import { XmlSyntaxError } from '../xml/index.ts'
import { openLegacy } from '../zip/index.ts'
import { parsePpt } from './binary/presentation.ts'
import type {
  EmbeddedFont,
  Presentation,
  Slide,
  UnsupportedCounts,
  UnsupportedKind,
} from './model.ts'
import { type RawInkStroke, readInk } from './parse/ink.ts'
import type { RawShape } from './parse/shape.ts'
import { type RawPart, readPresentation, readSlidePart, SLIDE_EXTENSIONS } from './parse/slide.ts'
import { readTableStyles, type TableStyle } from './parse/table.ts'
import type { SlideScope } from './resolve/scope.ts'
import { resolveBackground, ShapeResolver } from './resolve/shape.ts'

export type PptxFailure =
  | OpcFailure
  | { readonly kind: 'corrupt'; readonly reason: 'presentation' | 'xml' | 'ppt' }

export type PptxResult =
  | { readonly ok: true; readonly value: Presentation }
  | { readonly ok: false; readonly failure: PptxFailure }

const PRESENTATION_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
])

class PartError extends Error {
  constructor(readonly failure: PptxFailure) {
    super(failure.kind)
  }
}

function emptyPart(part: string, rels: Relationships): RawPart {
  return {
    part,
    rels,
    hidden: false,
    showMasterShapes: true,
    background: null,
    shapes: [],
    found: [],
    colorMap: null,
    textStyles: null,
  }
}

function addCounts(target: UnsupportedCounts, kinds: readonly UnsupportedKind[]): void {
  for (const k of kinds) target[k] = (target[k] ?? 0) + 1
}

/** 形状树中引用的图表部件名、SmartArt 部件与墨迹部件名（含组合内）。 */
function graphicParts(
  shapes: readonly RawShape[],
  charts: Set<string>,
  diagrams: Map<string, DiagramParts>,
  inks: Set<string>,
): void {
  for (const s of shapes) {
    if (s.kind === 'graphic' && s.chart !== null) charts.add(s.chart)
    else if (s.kind === 'graphic' && s.diagram !== null) diagrams.set(s.diagram.data, s.diagram)
    else if (s.kind === 'ink' && s.part !== null) inks.add(s.part)
    else if (s.kind === 'group') graphicParts(s.children, charts, diagrams, inks)
  }
}

class Loader {
  private readonly parts = new Map<string, RawPart>()
  private readonly themes = new Map<string, Theme>()
  readonly charts = new Map<string, { readonly raw: RawChart; readonly theme: Theme | null }>()
  readonly diagrams = new Map<string, RawDiagram>()
  readonly inks = new Map<string, readonly RawInkStroke[]>()

  constructor(private readonly pkg: OpcPackage) {}

  async text(part: string): Promise<string | null> {
    const r = await this.pkg.text(part)
    if (!r.ok) throw new PartError(r.failure)
    return r.value
  }

  async rels(source: string): Promise<Relationships> {
    const r = await this.pkg.relationships(source)
    if (!r.ok) throw new PartError(r.failure)
    return r.value
  }

  /** 部件不存在时返回 `null`。 */
  async slidePart(part: string | null): Promise<RawPart | null> {
    if (part === null) return null
    const cached = this.parts.get(part)
    if (cached !== undefined) return cached
    const xml = await this.text(part)
    if (xml === null) return null
    const parsed = readSlidePart(
      new PartScanner(xml, SLIDE_EXTENSIONS),
      part,
      await this.rels(part),
    )
    this.parts.set(part, parsed)
    return parsed
  }

  /**
   * 读取各部件形状树引用的图表部件、SmartArt 与墨迹部件；部件不存在的图表与墨迹、数据部件不存在的 SmartArt 不登记。
   */
  async loadGraphics(parts: readonly RawPart[]): Promise<void> {
    const charts = new Set<string>()
    const diagrams = new Map<string, DiagramParts>()
    const inks = new Set<string>()
    for (const p of parts) graphicParts(p.shapes, charts, diagrams, inks)
    const optional = async (part: string | null) => (part === null ? null : await this.text(part))
    for (const part of inks) {
      if (this.inks.has(part)) continue
      const xml = await this.text(part)
      if (xml !== null) this.inks.set(part, readInk(new PartScanner(xml)))
    }
    for (const part of charts) {
      if (this.charts.has(part)) continue
      const xml = await this.text(part)
      if (xml === null) continue
      const rels = await this.rels(part)
      const override = await optional(rels.part('themeOverride'))
      this.charts.set(part, {
        raw: readChart(xml, rels),
        theme: override === null ? null : parseTheme(override),
      })
    }
    for (const [data, d] of diagrams) {
      if (this.diagrams.has(data)) continue
      const xml = await this.text(data)
      if (xml === null) continue
      this.diagrams.set(
        data,
        readDiagram({
          data: xml,
          dataRels: await this.rels(data),
          layout: await optional(d.layout),
          style: await optional(d.style),
          colors: await optional(d.colors),
        }),
      )
    }
  }

  async theme(part: string | null): Promise<Theme> {
    if (part === null) return EMPTY_THEME
    const cached = this.themes.get(part)
    if (cached !== undefined) return cached
    const xml = await this.text(part)
    const theme = xml === null ? EMPTY_THEME : parseTheme(xml, await this.rels(part))
    this.themes.set(part, theme)
    return theme
  }
}

export async function parsePptx(data: Uint8Array<ArrayBuffer>): Promise<PptxResult> {
  const legacy = openLegacy(data)
  if (legacy?.ok && legacy.value.format === 'ppt') return parsePpt(legacy.value.file)
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

async function parsePackage(pkg: OpcPackage): Promise<Presentation> {
  const loader = new Loader(pkg)
  const root = await loader.rels('/')
  const main = root.part('officeDocument')
  if (main === null || !PRESENTATION_TYPES.has(pkg.contentType(main) ?? '')) {
    throw new PartError({ kind: 'corrupt', reason: 'presentation' })
  }
  const xml = await loader.text(main)
  if (xml === null) throw new PartError({ kind: 'corrupt', reason: 'presentation' })
  const mainRels = await loader.rels(main)
  const presentation = readPresentation(new PartScanner(xml), mainRels)

  let tableStyles: ReadonlyMap<string, TableStyle> = new Map()
  const tableStylesPart = mainRels.part('tableStyles')
  const tableStylesXml = tableStylesPart === null ? null : await loader.text(tableStylesPart)
  if (tableStylesPart !== null && tableStylesXml !== null) {
    const rels = await loader.rels(tableStylesPart)
    tableStyles = readTableStyles(new PartScanner(tableStylesXml), { rels, found: [] })
  }

  const metafiles = await readMetafiles(pkg, root)
  const slides: Slide[] = []
  const total: UnsupportedCounts = {}
  for (const [index, id] of presentation.slides.entries()) {
    const rel = mainRels.byId(id)
    const slide = await loader.slidePart(rel === null || rel.external ? null : rel.part)
    if (slide === null) throw new PartError({ kind: 'corrupt', reason: 'presentation' })
    const layoutPart = slide.rels.part('slideLayout')
    const layout = (await loader.slidePart(layoutPart)) ?? emptyPart(layoutPart ?? '', slide.rels)
    const masterPart = layout.rels.part('slideMaster')
    const master = (await loader.slidePart(masterPart)) ?? emptyPart(masterPart ?? '', layout.rels)
    const theme = await loader.theme(master.rels.part('theme'))
    await loader.loadGraphics([slide, layout, master])
    const scope: SlideScope = {
      theme,
      colors: {
        scheme: theme.colors,
        map: slide.colorMap ?? layout.colorMap ?? master.colorMap ?? DEFAULT_COLOR_MAP,
      },
      master,
      layout,
      defaultTextStyle: presentation.defaultTextStyle,
      tableStyles,
      imageDrawable: (part) =>
        pkg.has(part) ? metafiles.has(part) || decodableImage(pkg.contentType(part) ?? '') : null,
      charts: loader.charts,
      diagrams: loader.diagrams,
      inks: loader.inks,
      found: [...slide.found],
    }
    const resolver = new ShapeResolver(scope)
    const decorations = (part: RawPart) => part.shapes.filter((s) => s.placeholder === null)
    const shapes = [
      ...(slide.showMasterShapes && layout.showMasterShapes
        ? resolver.resolve(decorations(master), 'master')
        : []),
      ...(slide.showMasterShapes ? resolver.resolve(decorations(layout), 'layout') : []),
      ...resolver.resolve(slide.shapes, 'slide'),
    ]
    const unsupported: UnsupportedCounts = {}
    addCounts(unsupported, scope.found)
    addCounts(total, scope.found)
    slides.push({
      part: slide.part,
      number: presentation.firstSlideNumber + index,
      hidden: slide.hidden,
      layout: layout.part,
      master: master.part,
      background: background(slide, layout, master, scope),
      shapes,
      unsupported,
    })
  }
  const masters: string[] = []
  for (const id of presentation.masters) {
    const part = mainRels.byId(id)?.part
    if (part !== null && part !== undefined) masters.push(part)
  }
  const embeddedFonts: EmbeddedFont[] = []
  for (const f of presentation.embeddedFonts) {
    const rel = mainRels.byId(f.id)
    if (rel === null || rel.external || rel.part === null) continue
    embeddedFonts.push({ typeface: f.typeface, bold: f.bold, italic: f.italic, part: rel.part })
  }
  return {
    width: presentation.width,
    height: presentation.height,
    firstSlideNumber: presentation.firstSlideNumber,
    embeddedFonts,
    masters,
    slides,
    unsupported: total,
    metafileFonts: [...new Set([...metafiles.values()].flatMap((m) => m.fonts))],
  }
}

/**
 * 包中可以绘制的图元文件，按部件名：内容类型不是浏览器可解码位图的图片部件与缺少内容类型的部件逐个读取字节判定
 * （与 `decodePicture` 相同，按字节识别）。包关系引用的部件（文档缩略图）不是幻灯片中的图片，不读取。
 */
async function readMetafiles(pkg: OpcPackage, root: Relationships): Promise<Map<string, Metafile>> {
  const skip = new Set(root.list.map((r) => r.part))
  const out = new Map<string, Metafile>()
  for (const part of pkg.parts) {
    const type = pkg.contentType(part) ?? ''
    if (skip.has(part) || (type !== '' && !type.startsWith('image/')) || decodableImage(type))
      continue
    const r = await pkg.bytes(part)
    if (!r.ok || r.value === null) continue
    const mf = readMetafile(r.value)
    if (mf !== null && mf.unsupported.length === 0) out.set(part, mf)
  }
  return out
}

function background(
  slide: RawPart,
  layout: RawPart,
  master: RawPart,
  scope: SlideScope,
): ShapeFill | null {
  const spec = slide.background ?? layout.background ?? master.background
  return spec === null ? null : resolveBackground(spec, scope)
}
