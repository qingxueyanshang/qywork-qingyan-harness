/**
 * 分页入口：逐段排版、表格排版、页眉页脚排版、浮动对象的定位与环绕、分页，并把结果整理为纯数据的 `DocumentPages`。
 *
 * - 页眉页脚：节未引用某类部件时沿用上一节同类的部件；首页部件只在节设置 `titlePg` 时用于节的第一页，
 *   偶数页部件只在 `evenAndOddHeaders` 时用于页码为偶数的页（含重新编号），其余页用缺省部件；所需部件不存在时该处为空。
 * - 页眉自页面顶边下 `header` 处向下排列，页脚的底边位于页面底边上 `footer` 处；宽度为版心宽度（不分栏）。
 * - 正文区：页眉底边超过上边距时正文自页眉底边开始，页脚顶边高于下边距时正文在页脚顶边结束。
 * - 页码域（`PAGE`、`NUMPAGES`、`SECTIONPAGES`）按页重新生成文字后排版：`PAGE` 按节的页码格式，其余为十进制；
 *   STYLEREF 域按页取正文中该样式的段落文字（见 `styleRefText`）。
 * - 嵌入式对象：图片、图表与 SmartArt 绘制在排版给出的位置（`ParagraphLayout.images`：对象框左端与底边），其余嵌入式对象
 *   已在解析时按种类计入 `unsupported`。
 * - 公式位于排版给出的位置（左端与基线），不生成文字片段；没有排版结果的公式计入 `Page.hiddenMath`（页眉页脚部件中的只在
 *   使用该部件的第一页计入）。
 * - 浮动对象（WPS 12.1 实测）：对象的位置按锚定段落在不受该对象影响时的位置求得（相对段落时取段落顶边：上一段的
 *   段后间距之下、本段超出该间距的段前间距之上），之后本页与对象重叠的各行（含锚定段落之前的段落）避让，对象不随锚定段落
 *   移动。段落的第一行下移到上下型对象下方时，本段超出上一段段后间距的段前间距加在对象底边之下（构造文档 w11f、w11g）。环绕方式：
 *   避让矩形为对象框加 `effectExtent` 与距正文的距离（WPS 实测：effectExtent 底边 0.9 磅的上下型 SmartArt 使其下的行
 *   再下移 0.9 磅）。上下型（`topAndBottom`）使与矩形重叠的行（行底恰好接触矩形顶边的行见 `overlaps`）下移到其下方；
 *   四周型、紧密型与穿越型按矩形避让，一行依次排入对象两侧宽度足够的区段（不足 `MIN_SEGMENT`
 *   的区段不用），没有可用区段时下移到对象下方；衬于文字下方（`behindDoc`）不改变环绕；`wrapNone` 不避让。
 *   锚定段落的行不因本段的四周型、紧密型与穿越型对象移出正文区（留在原处与对象重叠）；与本段上下型对象重叠的行
 *   照常下移，本页容纳不下时移到下一页（WPS 实测：语料中图片位于第一行之下，其余各行移到下一页）。结束一节且没有
 *   文字的段落不避让（WPS 实测：整页图片之后的分节段落留在原处，节中的空段落照常下移）。
 *   对象属于锚定字符所在的行：相对段落定位时，基准为段落顶边（行在段落的第一部分中）或该行所在部分第一行的行顶；
 *   段落被本页已有的上下型对象推下时，基准取只下移一次后的位置（WPS 实测：段落先移到图片下方，不再计紧接其下的
 *   图注文本框，段内组合的位置按此求得；该段落的行最终仍移到图注与组合之下）。
 *   影响环绕、相对段落或行按偏移定位的对象的纵向位置按页面调整，见 `keepOnPage`。锚定在第一行的上下型对象
 *   （按调整后的位置）使第一行下移到对象下方后本页容纳不下时，锚定段落连同对象移到下一页，段落已在页首时不移
 *   （WPS 实测：150 磅图片位于正文区底边以上 3 磅处，段落与其前的同页标题一起移到下一页；兼容模式 15 中顶边在正文区
 *   底边之下的对象上移后高于段落顶边，段落移到下一页）。四周型、紧密型与穿越型对象不使段落移页。
 *   段落均不因此改变位置以外的排版。
 *   影响环绕的对象横向不超出页面：右边超出页面右边缘时右对齐页面右边缘，左边在页面左边缘之外时左对齐页面左边缘
 *   （WPS 实测：四周型与紧密型、相对栏与相对页面均如此，衬于文字下方不影响；`wrapNone` 不移动）。宽度超过页面时
 *   左对齐（未验证）。
 *   单元格、文本框与页眉页脚中的对象只绘制，不使正文避让。
 * - 页面背景：纯色铺满整页；图片按像素尺寸自页面左上角平铺（见 `Background`）。
 * - 页面边框（WPS 实测）：`offsetFrom` 为 `page` 时线的外缘距页面边缘 `space` 磅，线向内；为 `text` 时线的内缘距正文区
 *   （页边距）`space` 磅，线向外。
 */

import { collectChartFonts } from '../../drawingml/chart/resolve.ts'
import { collectDiagramFonts } from '../../drawingml/diagram/resolve.ts'
import { MISSING_LATIN } from '../../drawingml/text/fonts.ts'
import { type MathItem, type MathLayout, mathText } from '../../math/index.ts'
import { readMetafile } from '../../metafile/index.ts'
import type { LineArea, TextFace, TextLine } from '../../text/index.ts'
import { borderStrokes } from '../border.ts'
import {
  contextSpacing,
  lineAt,
  numberingText,
  type ParagraphLayout,
  ParagraphLayouter,
  upper,
} from '../layout.ts'
import type {
  Anchor,
  AnchorPosition,
  Block,
  Border,
  DocxDocument,
  DrawingGraphic,
  DrawingNode,
  Paragraph,
  PartRefs,
  Run,
  RunProps,
  Section,
  StyleRef,
} from '../model.ts'
import { blockFonts, type DocxFonts } from '../render/fonts.ts'
import {
  alignOffset,
  layoutStack,
  layoutTable,
  type Stack,
  type TableContext,
  type TableLayout,
} from '../table/layout.ts'
import type {
  BorderLine,
  DocumentPages,
  GraphicFace,
  GraphicFonts,
  Page,
  PageBackground,
  PageBorderBox,
  PageEdge,
  PageFill,
  PageFloat,
  PageFormula,
  PageFragment,
  PageGraphic,
  PageImage,
  PageItem,
  PageLine,
  PageParagraph,
  PageTable,
  ParagraphBox,
  Underline,
} from './model.ts'
import {
  type AnchorSite,
  type BodyArea,
  type Exclusion,
  FIT_EPSILON,
  type LinePlacement,
  lineNeed,
  type ObjectBox,
  overlaps,
  type PageKind,
  type PlacedAnchor,
  paginate,
  type TablePlacement,
} from './paginate.ts'

/** 四周型环绕中可排入文字的最小区段宽度（磅）：WPS 实测 15.3 磅的空隙不排、20 磅的排入。 */
const MIN_SEGMENT = 18
const EMU_PER_POINT = 12700

interface PartLayout {
  readonly blocks: readonly Block[]
  readonly stack: Stack
}

/** 第 `section` 节 `kind` 类页面的页眉或页脚部件标识：本节未引用该类部件时沿用之前最近一节同类的部件。 */
export function partRef(
  doc: DocxDocument,
  section: number,
  kind: PageKind,
  which: 'headers' | 'footers',
): string | null {
  const slot: keyof PartRefs = kind === 'first' ? 'first' : kind === 'even' ? 'even' : 'default'
  for (let s = section; s >= 0; s--) {
    const id = doc.sections[s]![which][slot]
    if (id !== null) return id
  }
  return null
}

function fullWidth(section: Section): number {
  return section.pageWidth - section.marginLeft - section.marginRight - section.gutter
}

interface FieldValues {
  readonly page: string
  readonly pages: string
  readonly sectionPages: string
  /** STYLEREF 域在本页显示的文字（见 `styleRefText`）。 */
  readonly styleRef: (ref: StyleRef) => string
}

/** STYLEREF 在正文中未找到该样式的段落时 WPS 显示的文字。 */
const STYLE_NOT_FOUND = '文档中未找到关联章节样式'

/**
 * STYLEREF 域在第 `page` 页显示的文字（WPS 12.1 实测）：本页正文中第一个（`\l` 时最后一个）该样式的段落；本页没有时取
 * 之前最后一个，之前也没有时取之后第一个；都没有时为 `STYLE_NOT_FOUND`。段落文字不含编号，不含分页符与分栏符；公式按
 * `mathText` 写出。
 * `pageBlocks` 为各页正文中段落的块下标（跨页的段落在每页各列一次）。
 */
function styleRefText(
  doc: DocxDocument,
  pageBlocks: readonly (readonly number[])[],
  page: number,
  ref: StyleRef,
): string {
  if (ref.style === null) return STYLE_NOT_FOUND
  const match = (b: number) => (doc.body[b] as Paragraph).style === ref.style
  const text = (b: number) =>
    (doc.body[b] as Paragraph).runs
      .map((r) => (r.math === undefined ? r.text : mathText(r.math.zone)))
      .join('')
      .replace(/[\f\v]/g, '')
  const here = pageBlocks[page]?.filter(match) ?? []
  const own = ref.last ? here.at(-1) : here[0]
  if (own !== undefined) return text(own)
  for (let k = page - 1; k >= 0; k--) {
    const b = pageBlocks[k]!.filter(match).at(-1)
    if (b !== undefined) return text(b)
  }
  for (let k = page + 1; k < pageBlocks.length; k++) {
    const b = pageBlocks[k]!.find(match)
    if (b !== undefined) return text(b)
  }
  return STYLE_NOT_FOUND
}

/** 块中 STYLEREF 域的字段（含表格与文本框中的段落），按出现顺序。 */
function styleRefsIn(blocks: readonly Block[], out: StyleRef[] = []): StyleRef[] {
  for (const b of blocks) {
    if (b.kind === 'table') {
      for (const r of b.rows) for (const c of r.cells) styleRefsIn(c.content, out)
      continue
    }
    for (const r of b.runs) if (r.styleRef !== undefined) out.push(r.styleRef)
    for (const a of b.anchors) if (a.drawing !== null) nodeRefs(a.drawing, out)
  }
  return out
}

function nodeRefs(n: DrawingNode, out: StyleRef[]): void {
  if (n.kind === 'group') for (const c of n.children) nodeRefs(c, out)
  else if (n.kind === 'shape' && n.text !== null) styleRefsIn(n.text.content, out)
}

const PAGE_FIELDS = new Set(['PAGE', 'NUMPAGES', 'SECTIONPAGES'])
/** 没有文字或只含分页符、分栏符与换行符的字段文字。 */
const BREAKS_ONLY = /^[\f\v\n]*$/

/** 字段为页码域的结果文字时返回域名。 */
function pageField(run: Run): 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES' | null {
  return run.field !== null && PAGE_FIELDS.has(run.field)
    ? (run.field as 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES')
    : null
}

/** 块中页码域与 STYLEREF 域的字段按 `values` 替换文字（含表格与文本框中的段落）。 */
function withFields(blocks: readonly Block[], values: FieldValues): Block[] {
  return blocks.map((b): Block => {
    if (b.kind === 'table') {
      return {
        ...b,
        rows: b.rows.map((r) => ({
          ...r,
          cells: r.cells.map((c) => ({ ...c, content: withFields(c.content, values) })),
        })),
      }
    }
    return {
      ...b,
      runs: b.runs.map((r) => {
        if (r.styleRef !== undefined) return { ...r, text: values.styleRef(r.styleRef) }
        const f = pageField(r)
        if (f === null) return r
        const text =
          f === 'PAGE' ? values.page : f === 'NUMPAGES' ? values.pages : values.sectionPages
        return { ...r, text }
      }),
      anchors: b.anchors.map((a) => ({
        ...a,
        drawing: a.drawing === null ? null : nodeFields(a.drawing, values),
      })),
    }
  })
}

function nodeFields(n: DrawingNode, values: FieldValues): DrawingNode {
  if (n.kind === 'group') return { ...n, children: n.children.map((c) => nodeFields(c, values)) }
  if (n.kind !== 'shape' || n.text === null) return n
  return { ...n, text: { ...n.text, content: withFields(n.text.content, values) } }
}

/**
 * 文档中可绘制的图表与 SmartArt（嵌入式对象与浮动对象：正文、表格、文本框与页眉页脚中的），以及可绘制的图元文件
 * （`DocxDocument.media` 的下标，嵌入式图片、浮动对象与页面背景中的）。
 */
function documentGraphics(doc: DocxDocument): {
  graphics: DrawingGraphic[]
  metafiles: Set<number>
} {
  const graphics: DrawingGraphic[] = []
  const metafiles = new Set<number>()
  const visit = (blocks: readonly Block[]) => {
    for (const b of blocks) {
      if (b.kind === 'table') {
        for (const r of b.rows) for (const c of r.cells) visit(c.content)
        continue
      }
      for (const im of b.images) if (im.graphic !== null) graphics.push(im.graphic)
      for (const a of b.anchors) if (a.drawing !== null) visitNode(a.drawing)
    }
  }
  const visitNode = (n: DrawingNode) => {
    if (n.kind === 'group') for (const c of n.children) visitNode(c)
    else if (n.kind !== 'shape') graphics.push(n)
    else if (n.text !== null) visit(n.text.content)
  }
  visit(doc.body)
  for (const part of Object.values(doc.parts)) visit(part)
  doc.media.forEach((m, i) => {
    const mf = readMetafile(m.bytes)
    if (mf !== null && mf.unsupported.length === 0) metafiles.add(i)
  })
  return { graphics, metafiles }
}

/** 图元文件中文字的字体名。 */
function metafileFontNames(doc: DocxDocument, metafiles: ReadonlySet<number>): string[] {
  const out = new Set<string>()
  for (const i of metafiles)
    for (const name of readMetafile(doc.media[i]!.bytes)!.fonts) out.add(name)
  return [...out]
}

/**
 * 图表与 SmartArt 文字用到的字体名；有这两种对象时末项为 `MISSING_LATIN`（主机没有西文字体时其文字的西文字符改用它）。
 */
function graphicFontNames(graphics: readonly DrawingGraphic[]): string[] {
  if (graphics.length === 0) return []
  const out = new Set<string>()
  for (const g of graphics) {
    if (g.kind === 'chart') collectChartFonts(out, g.chart)
    else collectDiagramFonts(out, g.diagram)
  }
  out.delete(MISSING_LATIN)
  out.add(MISSING_LATIN)
  return [...out]
}

/**
 * 文档所需的全部字体名：正文、表格、文本框、各节引用的页眉页脚、图表、SmartArt 与图元文件。调用方据此预先取得字体文件。
 */
export function requiredFonts(doc: DocxDocument): string[] {
  const names = new Set<string>()
  const visit = (blocks: readonly Block[]) => {
    blockFonts(blocks, doc.settings.math.font, names)
    for (const b of blocks) {
      if (b.kind === 'table') {
        for (const r of b.rows) for (const c of r.cells) visit(c.content)
        continue
      }
      for (const a of b.anchors) if (a.drawing !== null) visitNode(a.drawing)
    }
  }
  const visitNode = (n: DrawingNode) => {
    if (n.kind === 'group') for (const c of n.children) visitNode(c)
    else if (n.kind === 'shape' && n.text !== null) visit(n.text.content)
  }
  visit(doc.body)
  for (const part of Object.values(doc.parts)) visit(part)
  const { graphics, metafiles } = documentGraphics(doc)
  for (const name of graphicFontNames(graphics)) names.add(name)
  for (const name of metafileFontNames(doc, metafiles)) names.add(name)
  return [...names]
}

/**
 * 图表、SmartArt 与图元文件文字的字体：三者用到的字体名各取四种字形中主机有的字体（见 `GraphicFonts`）。
 * 文档中没有这三种对象时为 `null`。
 */
function graphicFonts(
  doc: DocxDocument,
  fonts: DocxFonts,
  objects: ReturnType<typeof documentGraphics>,
): GraphicFonts | null {
  const names = [
    ...new Set([
      ...graphicFontNames(objects.graphics),
      ...metafileFontNames(doc, objects.metafiles),
    ]),
  ]
  if (objects.graphics.length === 0 && objects.metafiles.size === 0) return null
  const named: GraphicFace[] = []
  for (const name of names) {
    for (const bold of [false, true]) {
      for (const italic of [false, true]) {
        const face = fonts.named(name, bold, italic)
        if (face !== null) named.push({ name, bold, italic, face })
      }
    }
  }
  const fallback = fonts.named(fonts.fallback.family, false, false)!
  return { named, fallback }
}

export interface PagesResult {
  readonly pages: DocumentPages
  /** 正文顶层段落的排版（未计环绕）。 */
  readonly layout: readonly ParagraphLayout[]
  /** 排版时缺少的字体名。 */
  readonly missingFonts: readonly string[]
}

/** 段落在页面中的放置：供浮动对象定位。 */
interface Placed {
  readonly paragraph: Paragraph
  readonly layout: ParagraphLayout
  /** 本页第一行在整段中的序号与各行行顶（页面坐标）。 */
  readonly first: number
  readonly tops: readonly number[]
  /** 段落顶边（含段前间距）。 */
  readonly top: number
  /** 所在区域（栏、单元格文字区等）的左边与宽度。 */
  readonly regionLeft: number
  readonly regionWidth: number
}

/** 段落的一部分按 `site` 放置时的位置：相对段落的对象以 `site.top` 为基准，各行行顶自 `site.lineTop` 起。 */
function placedAt(p: Paragraph, site: AnchorSite, section: Section): Placed {
  const lines = site.layout.text.lines
  const base = lines[site.first]?.top ?? 0
  return {
    paragraph: p,
    layout: site.layout,
    first: 0,
    tops: lines.map((line) => site.lineTop + line.top - base),
    top: site.top,
    regionLeft: site.x,
    regionWidth: section.columns[0]!.width,
  }
}

/** 页面的几何：浮动对象的定位基准。 */
interface PageFrame {
  readonly section: Section
  readonly columnLeft: number
  readonly columnWidth: number
  /** `DocumentSettings.compatibilityMode`：超出底边的对象的规则按此区分（见 `keepOnPage`）。 */
  readonly compatibilityMode: number
}

/**
 * 浮动对象的纵向位置 `y` 按页面调整（WPS 12.1 实测，构造文档 21 例）：兼容模式 15 及以上，对象限于正文区之内，底边超出
 * 正文区底边时上移至底边对齐，顶边高于正文区顶边时下移至顶边对齐，两者冲突时顶边对齐；低于 15 时只有底边超出页面底边
 * 才上移，至底边与页面底边对齐。锚定段落均不随之移动。
 */
function keepOnPage(y: number, height: number, area: BodyArea, mode: number, page: number): number {
  if (mode >= 15) return Math.max(Math.min(y, area.bottom - height), area.top)
  return y + height > page ? page - height : y
}

/** 浮动对象的对象框（页面坐标）。`area` 为本页的正文区，不为 `null` 时超出底边的对象按 `keepOnPage` 上移。 */
function anchorRect(
  a: Anchor,
  placed: Placed,
  frame: PageFrame,
  area: BodyArea | null = null,
): { x: number; y: number; width: number; height: number } {
  const s = frame.section
  const line = (() => {
    const shift = numberingText(placed.paragraph).length
    const k = lineAt(placed.layout.text.lines, a.offset + shift) - placed.first
    return Math.min(Math.max(0, k), placed.tops.length - 1)
  })()
  const textWidth = s.pageWidth - s.marginLeft - s.marginRight - s.gutter
  const base = (pos: AnchorPosition, horizontal: boolean): { start: number; size: number } => {
    if (horizontal) {
      switch (pos.from) {
        case 'page':
          return { start: 0, size: s.pageWidth }
        case 'margin':
        case 'insideMargin':
        case 'outsideMargin':
          return { start: s.marginLeft + s.gutter, size: textWidth }
        case 'leftMargin':
          return { start: 0, size: s.marginLeft + s.gutter }
        case 'rightMargin':
          return { start: s.pageWidth - s.marginRight, size: s.marginRight }
        case 'character': {
          const l = placed.layout.text.lines[placed.first + line]
          return { start: placed.regionLeft + placed.layout.left + (l?.left ?? 0), size: 0 }
        }
        default:
          return { start: frame.columnLeft, size: frame.columnWidth }
      }
    }
    switch (pos.from) {
      case 'page':
        return { start: 0, size: s.pageHeight }
      case 'margin':
      case 'insideMargin':
      case 'outsideMargin':
        return { start: s.marginTop, size: s.pageHeight - s.marginTop - s.marginBottom }
      case 'topMargin':
        return { start: 0, size: s.marginTop }
      case 'bottomMargin':
        return { start: s.pageHeight - s.marginBottom, size: s.marginBottom }
      case 'line':
        return { start: placed.tops[line] ?? 0, size: 0 }
      default:
        return { start: placed.top, size: 0 }
    }
  }
  const place = (pos: AnchorPosition, horizontal: boolean, extent: number): number => {
    const b = base(pos, horizontal)
    switch (pos.align) {
      case 'left':
      case 'top':
      case 'inside':
        return b.start
      case 'center':
        return b.start + (b.size - extent) / 2
      case 'right':
      case 'bottom':
      case 'outside':
        return b.start + b.size - extent
      default:
        return b.start + pos.offset
    }
  }
  let y = place(a.vertical, false, a.height)
  const flowing = a.vertical.from === 'paragraph' || a.vertical.from === 'line'
  if (area !== null && flowing && a.wrap.type !== 'none' && a.vertical.align === null)
    y = keepOnPage(y, a.height, area, frame.compatibilityMode, s.pageHeight)
  let x = place(a.horizontal, true, a.width)
  if (a.wrap.type !== 'none') x = Math.max(0, Math.min(x, s.pageWidth - a.width))
  return { x, y, width: a.width, height: a.height }
}

function exclusionOf(
  a: Anchor,
  r: { x: number; y: number; width: number; height: number },
  owner: number,
): Exclusion | null {
  if (a.wrap.type === 'none') return null
  const d = a.wrap.distance
  const e = a.effect
  return {
    left: r.x - e.left - d.left,
    right: r.x + r.width + e.right + d.right,
    top: r.y - e.top - d.top,
    bottom: r.y + r.height + e.bottom + d.bottom,
    topAndBottom: a.wrap.type === 'topAndBottom',
    side: a.wrap.side,
    owner,
  }
}

/**
 * 环绕查询：段落 `block` 第一行行顶在 `top`、区域左边在 `x`、宽度 `region`、正文区底边在 `limit` 时各行的可用区段
 * （见文件头）。行下移后再检查新位置上的对象；`once` 为真时上下型只下移一次，不再检查新位置。`exempt` 为假时
 * 本段的四周型等对象同样避让（判定段落是否移页用）。第一行下移到上下型对象下方时，行顶在对象底边之下 `before`
 * （本段自身的段前间距，见 `PaginateOptions.wrap`）。
 */
function wrapArea(
  exclusions: readonly Exclusion[],
  block: number,
  x: number,
  region: number,
  top: number,
  limit: number,
  once: boolean,
  before: number,
  exempt = true,
) {
  return (lineTop: number, height: number): LineArea => {
    const gap = lineTop === 0 ? before : 0
    let y = top + lineTop
    for (let guard = 0; guard < 2 * exclusions.length + 2; guard++) {
      const bottom = y + height
      const hit = exclusions.filter(
        (e) =>
          overlaps(e, y, bottom, block) &&
          !(exempt && e.owner === block && !e.topAndBottom && e.bottom + height > limit + 0.01),
      )
      const tb = hit.filter((e) => e.topAndBottom)
      if (tb.length > 0) {
        y = Math.max(...tb.map((e) => e.bottom)) + gap
        if (once) return { top: y - top, segments: [{ left: 0, width: region }] }
        continue
      }
      let segments = [{ left: x, right: x + region }]
      for (const e of hit) {
        const next: { left: number; right: number }[] = []
        for (const g of segments) {
          const leftPart = { left: g.left, right: Math.min(g.right, e.left) }
          const rightPart = { left: Math.max(g.left, e.right), right: g.right }
          const leftOk = leftPart.right - leftPart.left
          const rightOk = rightPart.right - rightPart.left
          const keepLeft = e.side !== 'right' && (e.side !== 'largest' || leftOk >= rightOk)
          const keepRight = e.side !== 'left' && (e.side !== 'largest' || rightOk > leftOk)
          if (keepLeft && leftOk > 0) next.push(leftPart)
          if (keepRight && rightOk > 0) next.push(rightPart)
        }
        segments = next
      }
      const usable = segments.filter((g) => g.right - g.left >= MIN_SEGMENT)
      if (usable.length === 0 && hit.length > 0) {
        y = Math.min(...hit.map((e) => e.bottom))
        continue
      }
      return {
        top: y - top,
        segments: usable.map((g) => ({ left: g.left - x, width: g.right - g.left })),
      }
    }
    return { top: y - top, segments: [{ left: 0, width: region }] }
  }
}

/**
 * 根据文字调整大小的文本框（顶层形状的 `autoFit`）：形状高度取内容高度加上下内缩（WPS 实测：记录高度为 0.05 磅的
 * 图注文本框按一行文字的高度避让）；文字不换行（`TextBox.wrap` 为假）时宽度另取内容不换行的宽度加左右内缩，对齐方式
 * 按调整后的宽度求位置（WPS 实测：记录宽度 144 磅、内容为两位数字的页码文本框相对页边距居中时，数字居中）。
 * 其余对象原样返回。
 */
function fitAnchor(a: Anchor, cx: TableContext, cache: Map<Anchor, Anchor>): Anchor {
  const known = cache.get(a)
  if (known !== undefined) return known
  let out = a
  const n = a.drawing
  if (n !== null && n.kind === 'shape' && n.text !== null && n.text.autoFit) {
    const inset = n.text.inset
    const inner = n.text.wrap
      ? Math.max(0, n.frame.width / EMU_PER_POINT - inset.left - inset.right)
      : unwrappedWidth(n.text.content, cx)
    const width = n.text.wrap ? a.width : inner + inset.left + inset.right
    const height = layoutStack(n.text.content, inner, cx).height + inset.top + inset.bottom
    out = {
      ...a,
      width,
      height,
      drawing: {
        ...n,
        frame: { ...n.frame, width: width * EMU_PER_POINT, height: height * EMU_PER_POINT },
      },
    }
  }
  cache.set(a, out)
  return out
}

/** 一组块不换行时的宽度：段落取不断行的内容宽度（含左右缩进），表格取网格宽度。 */
function unwrappedWidth(blocks: readonly Block[], cx: TableContext): number {
  let w = 0
  for (const b of blocks)
    w = Math.max(
      w,
      b.kind === 'paragraph'
        ? cx.layouter.contentWidths(b).max
        : b.grid.reduce((sum, g) => sum + g, 0),
    )
  return w
}

export function layoutPages(doc: DocxDocument, fonts: DocxFonts): PagesResult {
  const layouter = new ParagraphLayouter(doc, fonts.source)
  const mode = doc.settings.compatibilityMode
  const cx: TableContext = { layouter, compatibilityMode: mode }
  const fitted = new Map<Anchor, Anchor>()
  const fit = (a: Anchor) => fitAnchor(a, cx, fitted)
  const layout: ParagraphLayout[] = []
  doc.body.forEach((p, block) => {
    if (p.kind !== 'paragraph') return
    const section = doc.sections[p.section]!
    layout.push(
      layouter.layout(p, block, section.columns[0]!.width, contextSpacing(doc.body, block)),
    )
  })
  const tables = new Map<number, TableLayout>()
  const tableAt = (block: number): TableLayout => {
    let t = tables.get(block)
    if (t === undefined) {
      const b = doc.body[block]
      if (b === undefined || b.kind !== 'table') throw new RangeError('不是表格')
      t = layoutTable(b, doc.sections[b.section]!.columns[0]!.width, cx)
      if (b.float !== null) {
        const s = doc.sections[b.section]!
        const origin = b.float.from === 'page' ? -(s.marginLeft + s.gutter) : 0
        const indent = mode >= 15 ? 0 : b.indent - b.margins.left
        t = { ...t, x: origin + b.float.x + indent }
      }
      tables.set(block, t)
    }
    return t
  }

  const partCache = new Map<string, PartLayout>()
  const partRefs = new Map<string, StyleRef[]>()
  const partLayout = (
    id: string,
    section: number,
    values: FieldValues | null,
  ): PartLayout | null => {
    const source = doc.parts[id]
    if (source === undefined || source.length === 0) return null
    let refs = partRefs.get(id)
    if (refs === undefined) {
      refs = styleRefsIn(source)
      partRefs.set(id, refs)
    }
    const fields =
      values === null
        ? ''
        : [values.page, values.pages, values.sectionPages, ...refs.map(values.styleRef)].join(
            '\u0001',
          )
    const key = `${id}\u0000${section}\u0000${fields}`
    const cached = partCache.get(key)
    if (cached !== undefined) return cached
    const blocks = (values === null ? source : withFields(source, values)).map((b) => ({
      ...b,
      section,
    }))
    const result = { blocks, stack: layoutStack(blocks, fullWidth(doc.sections[section]!), cx) }
    partCache.set(key, result)
    return result
  }
  const area = (s: number, kind: PageKind): BodyArea => {
    const sec = doc.sections[s]!
    const h = partRef(doc, s, kind, 'headers')
    const f = partRef(doc, s, kind, 'footers')
    const hh = h === null ? 0 : (partLayout(h, s, null)?.stack.height ?? 0)
    const fh = f === null ? 0 : (partLayout(f, s, null)?.stack.height ?? 0)
    return {
      top: Math.max(sec.marginTop, sec.header + hh),
      bottom: Math.min(sec.pageHeight - sec.marginBottom, sec.pageHeight - sec.footer - fh),
    }
  }

  const byBlock = new Map<number, ParagraphLayout>()
  for (const p of layout) byBlock.set(p.block, p)
  const frameAt = (section: Section, x: number): PageFrame => {
    let columnLeft = section.marginLeft + section.gutter
    let columnWidth = section.columns[0]!.width
    for (const c of section.columns) {
      if (x < columnLeft + c.width + c.space - 0.01) {
        columnWidth = c.width
        break
      }
      columnLeft += c.width + c.space
    }
    return { section, columnLeft, columnWidth, compatibilityMode: mode }
  }

  // 浮动对象的位置：段落在一页中第一次放置时求得，同一页中不再改变（`PageFlow.anchors`，见 `paginate.ts`）。
  const flows = paginate(
    doc,
    { paragraphs: layout, missingFonts: [] },
    {
      area,
      table: tableAt,
      wrap: (block, x, top, bottom, list, once, before) => {
        const p = doc.body[block] as Paragraph
        const endsSection = doc.body[block + 1]?.section !== p.section
        if (endsSection && p.runs.every((r) => BREAKS_ONLY.test(r.text))) return null
        if (!list.some((e) => e.bottom > top)) return null
        const region = doc.sections[p.section]!.columns[0]!.width
        return layouter.layout(
          p,
          block,
          region,
          contextSpacing(doc.body, block),
          wrapArea(list, block, x, region, top, bottom, once, before),
        )
      },
      anchored: (block, site) => {
        const p = doc.body[block] as Paragraph
        if (p.anchors.length === 0) return []
        const section = doc.sections[site.section]!
        const lines = site.layout.text.lines
        const placed = placedAt(p, site, section)
        const tops = placed.tops
        const frame = frameAt(section, site.x)
        const shift = numberingText(p).length
        const out: PlacedAnchor[] = []
        const bottomOf = (j: number) => (tops[j] ?? 0) + lineNeed(site.layout, p.props, j)
        p.anchors.forEach((raw, k) => {
          const line = lineAt(lines, raw.offset + shift)
          // 锚定在前一部分或（按未环绕的位置）本页容纳不下的行中的对象留给其所在的页。
          if (
            line < site.first ||
            (line > site.first && bottomOf(line) > site.area.bottom + FIT_EPSILON)
          )
            return
          const a = fit(raw)
          const box = anchorRect(a, placed, frame, site.area)
          out.push({ key: `${block}:${k}`, box, exclusion: exclusionOf(a, box, block) })
        })
        return out
      },
      mustMove: (block, site) => {
        const p = doc.body[block] as Paragraph
        const lines = site.layout.text.lines
        const first = lines[0]
        if (first === undefined) return false
        const shift = numberingText(p).length
        const section = doc.sections[site.section]!
        const placed = placedAt(p, site, section)
        const frame = frameAt(section, site.x)
        const region = section.columns[0]!.width
        return p.anchors.some((raw) => {
          const a = fit(raw)
          if (a.vertical.align !== null) return false
          if (a.vertical.from !== 'paragraph' && a.vertical.from !== 'line') return false
          if (lineAt(lines, raw.offset + shift) !== 0) return false
          const e = exclusionOf(a, anchorRect(a, placed, frame, site.area), block)
          if (e === null) return false
          const area = wrapArea(
            [e],
            block,
            site.x,
            region,
            site.lineTop,
            site.area.bottom,
            false,
            site.lineTop - site.top,
            false,
          )
          const moved = area(0, first.height).top
          return site.lineTop + moved + first.height > site.area.bottom + FIT_EPSILON
        })
      },
    },
  )

  /**
   * 浮动对象绘制在记录它的最后一页（对象标识 → 页下标与位置）：锚定的行在记录之后移到下一页时，前一页的记录不绘制。
   */
  const recorded = new Map<string, { page: number; box: ObjectBox }>()
  flows.forEach((f, i) => {
    for (const a of f.anchors) recorded.set(a.key, { page: i, box: a.box })
  })
  const sectionTotals = new Map<number, number>()
  for (const f of flows) sectionTotals.set(f.section, (sectionTotals.get(f.section) ?? 0) + 1)
  const sectionFirst = new Map<number, number>()
  flows.forEach((f, i) => {
    if (!sectionFirst.has(f.section)) sectionFirst.set(f.section, i)
  })
  const imageIndex = new Map<string, number>()
  doc.media.forEach((m, i) => {
    imageIndex.set(m.part, i)
  })
  const objects = documentGraphics(doc)
  const graphicFaces = graphicFonts(doc, fonts, objects)
  const countedParts = new Set<string>()
  const pageBlocks = flows.map((f) => {
    const out: number[] = []
    for (const it of f.items)
      if (it.kind === 'paragraph' && out.at(-1) !== it.block) out.push(it.block)
    return out
  })

  const pages: Page[] = flows.map((flow, pageIndex) => {
    const sec = doc.sections[flow.section]!
    const x0 = sec.marginLeft + sec.gutter
    const values: FieldValues = {
      page: flow.numberText,
      pages: String(flows.length),
      sectionPages: String(sectionTotals.get(flow.section) ?? 0),
      styleRef: (ref) => styleRefText(doc, pageBlocks, pageIndex, ref),
    }
    const out = new PageBuilder(fonts, cx, (x) => frameAt(sec, x), fit)
    const header: PageItem[] = []
    const footer: PageItem[] = []
    // 页眉页脚另用一组绘制项：其中未绘制的公式只在使用该部件的第一页计入 `Page.hiddenMath`。
    const story = (id: string | null, into: PageItem[], top: (l: PartLayout) => number) => {
      const layout = id === null ? null : partLayout(id, flow.section, values)
      if (id === null || layout === null) return
      const part = new PageBuilder(fonts, cx, (x) => frameAt(sec, x), fit)
      part.stackItems(into, layout.stack, x0, top(layout), fullWidth(sec), null)
      out.floats.push(...part.floats)
      if (!countedParts.has(id)) out.hiddenMath += part.hiddenMath
      countedParts.add(id)
    }
    if (!flow.blank) {
      story(partRef(doc, flow.section, flow.kind, 'headers'), header, () => sec.header)
      story(
        partRef(doc, flow.section, flow.kind, 'footers'),
        footer,
        (l) => sec.pageHeight - sec.footer - l.stack.height,
      )
    }
    const body: PageItem[] = []
    for (const item of flow.items) {
      if (item.kind === 'table') {
        body.push(out.tableItem(item))
        continue
      }
      const p = doc.body[item.block] as Paragraph
      body.push(
        out.paragraph(p, item, (k) => {
          const at = recorded.get(`${item.block}:${k}`)
          return at === undefined ? undefined : at.page === pageIndex ? at.box : null
        }),
      )
    }
    const background = pageBackground(doc, imageIndex)
    const floats = out.floats.sort((a, b) => a.z - b.z).map(({ z: _, ...f }) => f)
    return {
      section: flow.section,
      width: sec.pageWidth,
      height: sec.pageHeight,
      number: flow.numberText,
      header,
      body,
      footer,
      floats,
      background,
      borders: pageBorders(sec, pageIndex === sectionFirst.get(flow.section)),
      graphicFonts: hasGraphic([header, body, footer], floats, background, objects.metafiles, doc)
        ? graphicFaces
        : null,
      hiddenMath: out.hiddenMath,
    }
  })
  return {
    pages: {
      faces: fonts.refs.slice(),
      images: doc.media.map((m) => ({ part: m.part, contentType: m.contentType, bytes: m.bytes })),
      pages,
    },
    layout,
    missingFonts: layouter.missingFonts,
  }
}

/**
 * 页面中是否有图表、SmartArt 或图元文件：段落中的嵌入式对象（含表格与文本框中的）与浮动对象中的图表与 SmartArt，
 * 嵌入式图片、浮动对象（含组合内）的图片填充与页面背景中的图元文件（`metafiles` 为其图片下标）。
 */
function hasGraphic(
  lists: readonly (readonly PageItem[])[],
  floats: readonly PageFloat[],
  background: PageBackground | null,
  metafiles: ReadonlySet<number>,
  doc: DocxDocument,
): boolean {
  const inItems = (items: readonly PageItem[]): boolean =>
    items.some((it) =>
      it.kind === 'table'
        ? inItems(it.items)
        : it.graphics.length > 0 || it.images.some((im) => metafiles.has(im.image)),
    )
  const inNode = (n: DrawingNode): boolean => {
    if (n.kind === 'group') return n.children.some(inNode)
    if (n.kind !== 'shape') return true
    const part = n.fill.kind === 'picture' ? n.fill.image.part : null
    return part !== null && metafiles.has(doc.media.findIndex((m) => m.part === part))
  }
  return (
    lists.some(inItems) ||
    floats.some((f) => inItems(f.items) || (f.drawing !== null && inNode(f.drawing))) ||
    (background?.image != null && metafiles.has(background.image))
  )
}

function pageBackground(
  doc: DocxDocument,
  images: ReadonlyMap<string, number>,
): PageBackground | null {
  const b = doc.background
  if (b === null) return null
  if (b.kind === 'color') return { color: b.color, image: null, tile: false }
  return { color: b.color, image: images.get(b.part) ?? null, tile: b.tile }
}

function pageBorders(s: Section, first: boolean): PageBorderBox | null {
  const b = s.pageBorders
  if (b === null) return null
  if ((b.display === 'firstPage' && !first) || (b.display === 'notFirstPage' && first)) return null
  const space = (x: Border | null) => x?.space ?? 0
  let left: number
  let top: number
  let right: number
  let bottom: number
  if (b.offsetFrom === 'page') {
    left = space(b.left)
    top = space(b.top)
    right = s.pageWidth - space(b.right)
    bottom = s.pageHeight - space(b.bottom)
  } else {
    left = s.marginLeft + s.gutter - space(b.left)
    top = s.marginTop - space(b.top)
    right = s.pageWidth - s.marginRight + space(b.right)
    bottom = s.pageHeight - s.marginBottom + space(b.bottom)
  }
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    inside: b.offsetFrom === 'page',
    top: borderLine(b.top),
    bottom: borderLine(b.bottom),
    left: borderLine(b.left),
    right: borderLine(b.right),
  }
}

/**
 * 未以表格最后一行结束的页面部分，底边线上沿高于该部分底边的距离（磅）。WPS 屏幕 EMF 实测（语料 32c9f4a4 第 32 页
 * 0.25 磅线、0824436d 第 25 页 1.5 磅线）：均为 0.75 磅，与线宽无关；表格结束处的底边框不上移。
 */
const SPLIT_BOTTOM_RAISE = 0.75

/** 一页的绘制项：段落、表格、浮动对象与未绘制公式的计数。 */
class PageBuilder {
  readonly floats: (PageFloat & { z: number })[] = []
  /** 本页已放置的浮动对象：段落在同一页分为几部分（如分栏符之后）时，对象只放置一次。 */
  private readonly placed = new Set<Anchor>()
  hiddenMath = 0

  constructor(
    private readonly fonts: DocxFonts,
    private readonly cx: TableContext,
    private readonly frame: (x: number) => PageFrame,
    private readonly fit: (a: Anchor) => Anchor,
  ) {}

  /**
   * 正文段落的绘制项。`rectOf` 给出第 `k` 个浮动对象在分页中求得的位置：在其他页时为 `null`，分页中未求过时为
   * `undefined`（在段落第一部分所在页按本页的位置绘制）。
   */
  paragraph(
    p: Paragraph,
    placement: LinePlacement,
    rectOf: (
      k: number,
    ) => { x: number; y: number; width: number; height: number } | null | undefined,
  ): PageParagraph {
    const lay = placement.layout
    const placed: Placed = {
      paragraph: p,
      layout: lay,
      first: placement.first,
      tops: placement.tops,
      top: (placement.tops[0] ?? 0) - placement.space,
      regionLeft: placement.x - lay.left,
      regionWidth: lay.width + p.props.left + p.props.right,
    }
    p.anchors.forEach((raw, k) => {
      const r = rectOf(k)
      if (r === null || (r === undefined && placement.first !== 0) || this.placed.has(raw)) return
      this.placed.add(raw)
      const a = this.fit(raw)
      this.addFloat(a, r ?? anchorRect(a, placed, this.frame(placement.x)))
    })
    return this.paragraphItem(p, lay, placement.block, placement.first, placement.tops, placement.x)
  }

  private addFloat(a: Anchor, r: { x: number; y: number; width: number; height: number }): void {
    const items: PageItem[] = []
    if (a.drawing !== null) this.textBoxes(items, a.drawing, r.x, r.y)
    this.floats.push({ ...r, behind: a.behind, drawing: a.drawing, items, z: a.z })
  }

  /** 文本框的内容：文字区为形状框减去内缩，内容按 `anchor` 纵向对齐；形状的旋转不作用于文字。 */
  private textBoxes(out: PageItem[], n: DrawingNode, x: number, y: number): void {
    if (n.kind === 'group') {
      for (const c of n.children) this.textBoxes(out, c, x, y)
      return
    }
    if (n.kind !== 'shape' || n.text === null) return
    const f = n.frame
    const inset = n.text.inset
    const left = x + f.x / EMU_PER_POINT + inset.left
    const top = y + f.y / EMU_PER_POINT + inset.top
    const width = Math.max(0, f.width / EMU_PER_POINT - inset.left - inset.right)
    const height = Math.max(0, f.height / EMU_PER_POINT - inset.top - inset.bottom)
    const stack = layoutStack(n.text.content, width, this.cx)
    const free = height - stack.height
    const dy =
      free <= 0 ? 0 : n.text.anchor === 'center' ? free / 2 : n.text.anchor === 'bottom' ? free : 0
    this.stackItems(out, stack, left, top + dy, width, null)
  }

  /**
   * 一组块（单元格、文本框、页眉页脚的内容）的绘制项，原点为文字区左上角（页面坐标）。`window` 不为 `null` 时
   * 只放入纵向位于 `[from, to)` 的行与嵌套表格，并把 `from` 对齐到原点。
   */
  stackItems(
    out: PageItem[],
    stack: Stack,
    x: number,
    y: number,
    region: number,
    window: { from: number; to: number } | null,
  ): void {
    const from = window?.from ?? 0
    const to = window?.to ?? Number.POSITIVE_INFINITY
    for (const it of stack.items) {
      if (it.kind === 'table') {
        const t = it.table
        if (it.top + 0.01 < from || it.top >= to) continue
        out.push(this.wholeTable(t, x + t.x, y + it.top - from, it.block))
        continue
      }
      const lines = it.layout.text.lines
      let first = -1
      const tops: number[] = []
      lines.forEach((line, k) => {
        const lt = it.top + line.top
        if (lt + 0.01 < from || lt + line.height > to + 0.01) return
        if (first < 0) first = k
        tops.push(y + lt - from)
      })
      if (first < 0) continue
      const px = x + it.layout.left
      if (first === 0) {
        const placed: Placed = {
          paragraph: it.paragraph,
          layout: it.layout,
          first: 0,
          tops,
          top: (tops[0] ?? 0) - it.space,
          regionLeft: x,
          regionWidth: region,
        }
        it.paragraph.anchors.forEach((raw) => {
          const a = this.fit(raw)
          this.addFloat(a, anchorRect(a, placed, this.frame(x)))
        })
      }
      out.push(this.paragraphItem(it.paragraph, it.layout, it.block, first, tops, px))
    }
  }

  /** 不切分的表格（嵌套表格）：全部行。 */
  private wholeTable(t: TableLayout, x: number, top: number, block: number): PageTable {
    let y = top
    const segments = t.rows.map((row, r) => {
      const s = {
        row: r,
        top: y,
        height: row.height,
        from: row.cells.map(() => 0),
        to: row.cells.map(() => Number.POSITIVE_INFINITY),
        repeat: false,
        pageTop: false,
        border: row.border,
      }
      y += row.height
      return s
    })
    return this.tableItem({
      kind: 'table',
      block,
      layout: t,
      x,
      top,
      height: t.height,
      segments,
      end: true,
    })
  }

  tableItem(placement: TablePlacement): PageTable {
    const t = placement.layout
    const x0 = placement.x
    const fills: PageFill[] = []
    const items: PageItem[] = []
    const edges: PageEdge[] = []
    const segs = placement.segments
    /** 第 `r` 行在本页的最后一段之后的纵坐标。 */
    const rowEnd = new Map<number, number>()
    for (const s of segs) rowEnd.set(s.row, s.top + s.height)
    const columns = t.columns
    const cols = columns.length - 1
    segs.forEach((seg, si) => {
      const row = t.rows[seg.row]!
      row.cells.forEach((cell, k) => {
        let bottom = seg.top + seg.height
        for (let r = seg.row + 1; r < seg.row + cell.rowSpan; r++) {
          const end = rowEnd.get(r)
          if (end !== undefined && !segs.slice(0, si).some((s) => s.row === r))
            bottom = Math.max(bottom, end)
        }
        const x = x0 + cell.x
        if (cell.cell.shading !== null)
          fills.push({
            x,
            y: seg.top,
            width: cell.width,
            height: bottom - seg.top,
            color: cell.cell.shading,
          })
        const m = cell.cell.margins
        const whole = seg.from[k] === 0 && seg.to[k] === Number.POSITIVE_INFINITY
        const space = bottom - seg.top - seg.border - m.top - m.bottom
        const dy = whole ? alignOffset(cell, space) : 0
        this.stackItems(
          items,
          cell.content,
          x + m.left,
          seg.top + seg.border + m.top + dy,
          cell.width - m.left - m.right,
          whole ? null : { from: seg.from[k]!, to: seg.to[k]! },
        )
      })
      // 横向边框：本段上沿。
      const line = (seg.pageTop ? t.pageTop : t.horizontal)[seg.row] ?? []
      for (let c = 0; c < cols; c++) {
        const b = line[c]
        if (b === undefined) continue
        edges.push({
          vertical: false,
          x: x0 + columns[c]!,
          y: seg.top,
          length: columns[c + 1]! - columns[c]!,
          line: b === null ? null : borderLine(b),
        })
      }
      // 纵向边框。
      const vline = t.vertical[seg.row] ?? []
      for (let c = 0; c <= cols; c++) {
        const b = vline[c]
        if (b === undefined) continue
        edges.push({
          vertical: true,
          x: x0 + columns[c]!,
          y: seg.top,
          length: seg.height,
          line: b === null ? null : borderLine(b),
        })
      }
    })
    // 本页部分的底边：表格结束时为底边框，否则按表格的最后一行求取（见 `../table/layout.ts`），线的上沿比该部分底边
    // 高 `SPLIT_BOTTOM_RAISE`。
    const last = segs[segs.length - 1]
    if (last !== undefined) {
      const lineBelow = (placement.end ? t.horizontal[t.rows.length] : t.pageBottom[last.row]) ?? []
      const y = last.top + last.height - (placement.end ? 0 : SPLIT_BOTTOM_RAISE)
      for (let c = 0; c < cols; c++) {
        const b = lineBelow[c]
        if (b === undefined) continue
        edges.push({
          vertical: false,
          x: x0 + columns[c]!,
          y,
          length: columns[c + 1]! - columns[c]!,
          line: b === null ? null : borderLine(b),
        })
      }
    }
    return {
      kind: 'table',
      block: placement.block,
      rows: [...new Set(segs.filter((g) => !g.repeat).map((g) => g.row))],
      top: placement.top,
      height: placement.height,
      fills,
      items,
      edges,
    }
  }

  private paragraphItem(
    p: Paragraph,
    lay: ParagraphLayout,
    block: number,
    first: number,
    tops: readonly number[],
    x: number,
  ): PageParagraph {
    const lines: PageLine[] = []
    tops.forEach((top, k) => {
      const line = lay.text.lines[first + k]!
      // 环绕下移的部分不属于该行：行顶取文字所在处。
      const skip = line.skip ?? 0
      lines.push({
        top: top + skip,
        height: line.height - skip,
        fragments: fragments(p, lay, line, x, top, this.fonts),
      })
    })
    const formulas: PageFormula[] = []
    for (const f of lay.formulas) {
      const k = f.line - first
      if (k < 0 || k >= tops.length) continue
      if (f.layout === null) {
        this.hiddenMath++
        continue
      }
      const dy = tops[k]! - lay.text.lines[f.line]!.top
      formulas.push({
        x: x + f.x,
        baseline: f.baseline + dy,
        layout: mathFaces(f.layout, this.fonts),
      })
    }
    const images: PageImage[] = []
    const graphics: PageGraphic[] = []
    p.images.forEach((im, i) => {
      const w = lay.images[i]!
      const k = w.line - first
      if (k < 0 || k >= tops.length || (im.media < 0 && im.graphic === null)) return
      const bottom = w.baseline + tops[k]! - lay.text.lines[w.line]!.top
      const at = {
        x: x + w.x + im.effect.left,
        y: bottom - im.effect.bottom - im.height,
        width: im.width,
        height: im.height,
      }
      if (im.graphic !== null) graphics.push({ graphic: im.graphic, ...at })
      else images.push({ image: im.media, crop: im.crop, ...at })
    })
    const style = boxStyle(p)
    let box: ParagraphBox | null = null
    if (style !== null && lines.length > 0) {
      const f = lines[0]!
      const l = lines[lines.length - 1]!
      box = { x, y: f.top, width: lay.width, height: l.top + l.height - f.top, ...style }
    }
    return { kind: 'paragraph', block, firstLine: first, lines, box, images, graphics, formulas }
  }
}

/** 公式排版结果中的字体换算为 `DocumentPages.faces` 的下标。 */
function mathFaces(m: MathLayout<TextFace>, fonts: DocxFonts): MathLayout<number> {
  const items = m.items.map(
    (it): MathItem<number> => ('font' in it ? { ...it, font: fonts.ref(it.font) } : it),
  )
  return { ...m, items }
}

function fragments(
  p: Paragraph,
  lay: ParagraphLayout,
  line: TextLine,
  x0: number,
  top: number,
  fonts: DocxFonts,
): PageFragment[] {
  const out: PageFragment[] = []
  const dy = top - line.top
  for (const f of line.fragments) {
    const src = lay.runs[f.run]!
    const props = src < 0 ? p.numbering!.props : p.runs[src]!.props
    const runText = src < 0 ? numberingText(p) : p.runs[src]!.text
    const paint = runPaint(props)
    out.push({
      face: fonts.ref(f.face),
      size: f.size,
      x: x0 + f.x,
      baseline: f.baseline + dy,
      text: (props.caps ? upper(runText) : runText).slice(f.start, f.end),
      advances: f.advances,
      color: paint.color,
      underline: paint.underline,
      strike: paint.strike,
      fill: paint.fill,
    })
  }
  for (const l of line.leaders) {
    const src = lay.runs[l.run]!
    const props = src < 0 ? p.numbering!.props : p.runs[src]!.props
    const advance = l.face.metrics.advance(l.char.codePointAt(0)!, l.size)
    const count = advance > 0 ? Math.floor(l.width / advance + 1e-6) : 0
    if (count === 0) continue
    out.push({
      face: fonts.ref(l.face),
      size: l.size,
      x: x0 + l.x + l.width - count * advance,
      baseline: line.baseline + dy,
      text: l.char.repeat(count),
      advances: Array.from({ length: count }, () => advance),
      color: runPaint(props).color,
      underline: null,
      strike: null,
      fill: null,
    })
  }
  return out
}

/** `ST_Underline` 归并为绘制支持的线型。 */
const UNDERLINES: Readonly<Record<string, Underline['style']>> = {
  single: 'single',
  words: 'words',
  double: 'double',
  thick: 'thick',
  dotted: 'dotted',
  dottedHeavy: 'dotted',
  dash: 'dash',
  dashedHeavy: 'dash',
  dashLong: 'dash',
  dashLongHeavy: 'dash',
  dotDash: 'dotDash',
  dashDotHeavy: 'dotDash',
  dotDotDash: 'dotDotDash',
  dashDotDotHeavy: 'dotDotDash',
  wave: 'wave',
  wavyHeavy: 'wave',
  wavyDouble: 'wave',
}

/** 字段的绘制属性：自动颜色为黑色；突出显示优先于字符底纹。 */
function runPaint(props: RunProps): Pick<PageFragment, 'color' | 'underline' | 'strike' | 'fill'> {
  const color = props.color ?? '#000000'
  const u = props.underline
  return {
    color,
    underline:
      u === null ? null : { style: UNDERLINES[u.style] ?? 'single', color: u.color ?? color },
    strike: props.doubleStrike ? 'double' : props.strike ? 'single' : null,
    fill: props.highlight ?? props.shading,
  }
}

function borderLine(b: Border | null): BorderLine | null {
  if (b === null || b.style === 'none') return null
  const style =
    b.style === 'dotted'
      ? 'dotted'
      : b.style.startsWith('dash') || b.style === 'dotDash' || b.style === 'dotDotDash'
        ? 'dashed'
        : 'solid'
  return {
    strokes: borderStrokes(b.style, b.width),
    color: b.color ?? '#000000',
    style,
    space: b.space,
  }
}

/** 段落底纹与边框；都没有时为 `null`。 */
function boxStyle(p: Paragraph): Omit<ParagraphBox, 'x' | 'y' | 'width' | 'height'> | null {
  const q = p.props
  if (q.shading === null && q.borders === null) return null
  return {
    fill: q.shading,
    top: borderLine(q.borders?.top ?? null),
    bottom: borderLine(q.borders?.bottom ?? null),
    left: borderLine(q.borders?.left ?? null),
    right: borderLine(q.borders?.right ?? null),
  }
}
