/**
 * 主文档正文与页眉页脚部件：段落、字段与域、表格、浮动对象与文本框、节的划分，以及未实现元素的计数。
 *
 * - 块级容器（`sdt`、`customXml`、插入与移入的修订）展开为其中的段落与表格；删除与移出的修订不显示。
 * - 表格可以嵌套：单元格与文本框（`txbxContent`）的内容同正文一样读取为段落与表格。单元格中的段落按所在表格的
 *   表格样式与条件格式（`../resolve/table.ts`）解决属性。
 * - 域：`fldChar` 的开始与结束跨字段、跨段落配对，可以嵌套；只有所有未结束的域都处在结果部分时文字才显示，
 *   域代码（`instrText`）不显示。`fldSimple` 显示其中的结果字段；页码域（`PAGE`、`NUMPAGES`、`SECTIONPAGES`）
 *   没有结果字段时补一个空字段，由分页按页填入页码；页眉页脚中的 `STYLEREF` 合并为一个字段（`Run.styleRef`），
 *   由分页按页求出文字。字段记录最内层域的域名（`Run.field`）。目录域（`TOC`）结果中的字段不取名为 `Hyperlink` 的
 *   字符样式，其他字符样式与直接格式照常（WPS 实测：目录项不显示超链接样式的颜色与下划线，直接给出的颜色照常显示）。
 * - `w:t` 没有 `xml:space="preserve"` 时去掉首尾空白，中间的空白保留（WPS 实测）。
 * - `w:br` 与 `w:cr` 为换行（`\n`），分页符为 `\f`，分栏符为 `\v`（单元格中两者不输出）；`w:noBreakHyphen` 为 U+2011，`w:softHyphen` 不显示，
 *   `w:sym` 以其 `w:font` 作为四类字体输出 `w:char` 指定的字符。
 * - 嵌入式对象（`wp:inline`、`w:object`）记录其后第一个字段的下标与对象框，对象之后的文字另起字段；有图片部件的图片与可绘制的
 *   图表、SmartArt（见 `BodyEnv.chart`、`BodyEnv.diagram`）不计数，其余按种类计数。`w:object` 的对象框为其中 VML 形状的宽高。
 *   浮动对象（`wp:anchor`、绝对定位的 VML）记入段落的 `anchors`（见 `drawing.ts`）。
 * - 段落中的 `sectPr` 结束其所在的节（只在正文顶层），该段落属于这一节；正文末尾的 `sectPr` 为最后一节。
 * - 表格与文本框中的段落不悬挂行尾标点；表格中的段落不对齐行网格，除非设置了 `adjustLineHeightInTable`
 *   （均为 WPS 实测，见 `placeProps`）。
 * - 公式：每个 `m:oMath`（含 `m:oMathPara` 中的各个）为一个字段（`Run.math`），文字为空串；公式中的 `w:rPr` 按所在
 *   段落解决为字段属性。显示公式的判定见 `RunMath.display`。
 */

import type { Chart } from '../../drawingml/chart/model.ts'
import type { Diagram } from '../../drawingml/diagram/model.ts'
import { type DiagramParts, readDiagramParts } from '../../drawingml/diagram/read.ts'
import { readRelativeRect, ZERO_RECT } from '../../drawingml/fill.ts'
import type { StyleScope } from '../../drawingml/shape/resolve.ts'
import { type MathJustification, readMath, readMathParagraph } from '../../math/index.ts'
import type { Relationships } from '../../opc/package.ts'
import type {
  Anchor,
  Background,
  Block,
  DrawingGraphic,
  DrawingNode,
  InlineImage,
  Numbering,
  Paragraph,
  ParagraphProps,
  Run,
  RunMath,
  RunProps,
  Section,
  StyleRef,
  TableBlock,
  UnsupportedKind,
} from '../model.ts'
import {
  mergeRun,
  type ParagraphContext,
  paragraphProps,
  type Resolver,
  type TableLayer,
} from '../resolve/cascade.ts'
import {
  cellBorders,
  cellFormat,
  edges,
  mergeTableProps,
  type TableStyleChain,
  tableBorders,
  tableStyleChain,
} from '../resolve/table.ts'
import {
  CHART_URI,
  DIAGRAM_URI,
  type DrawingContext,
  graphicFrame,
  type PendingAnchor,
  type PendingNode,
  readAnchor,
  readObjectShape,
  readVml,
} from './drawing.ts'
import {
  hexColor,
  type RawParaProps,
  type RawRunProps,
  readParaProps,
  readRunProps,
} from './properties.ts'
import { DEFAULT_SECTION, readSection } from './section.ts'
import type { Styles, TableFormat } from './styles.ts'
import {
  type RawCellProps,
  type RawRowProps,
  type RawTableProps,
  readCellProps,
  readRowProps,
  readTableProps,
} from './table.ts'
import { eachChild, readText, type Scanner, skip, wAttr } from './xml.ts'

/** 打开文档时由应用重新计算结果的域。 */
const DYNAMIC_FIELDS = new Set(['DATE', 'TIME', 'PAGE', 'NUMPAGES', 'SECTIONPAGES', 'SECTION'])
/** 由分页按页生成文字的域。 */
const PAGE_FIELDS = new Set(['PAGE', 'NUMPAGES', 'SECTIONPAGES'])

const INLINE_KINDS: readonly (readonly [string, UnsupportedKind])[] = [
  ['/drawingml/2006/picture', 'picture'],
  ['/drawingml/2006/chart', 'chart'],
  ['/drawing/2014/chartex', 'chart'],
  ['/drawingml/2006/diagram', 'smartArt'],
  ['/wordprocessingShape', 'shape'],
  ['/wordprocessingGroup', 'group'],
  ['/wordprocessingCanvas', 'canvas'],
]

const RUN_CONTAINERS = new Set([
  'hyperlink',
  'smartTag',
  'customXml',
  'dir',
  'bdo',
  'sdtContent',
  'rubyBase',
])

const XML_WHITESPACE = /^[ \t\r\n]+|[ \t\r\n]+$/g
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const EMU_PER_POINT = 12700
const ZERO_EDGES = { left: 0, top: 0, right: 0, bottom: 0 }

interface Field {
  result: boolean
  instr: string
  /** 结果部分已有显示的文字。 */
  shown: boolean
  /** 结果部分开始处：所在段落的字段数组与其中的下标；尚未进入结果部分时为 `null`。 */
  start: { readonly runs: Run[]; readonly index: number } | null
}

/** 段落中第一个有内容的字段：`object` 为对象所在的字段（嵌入式或浮动对象）。 */
interface FirstContent {
  readonly props: RunProps
  readonly object: boolean
}

interface PendingParagraph {
  readonly ctx: ParagraphContext
  readonly runs: readonly Run[]
  readonly mark: RunProps
  readonly numbering: Numbering | null
  readonly first: FirstContent | null
  readonly images: readonly InlineImage[]
  readonly anchors: readonly {
    readonly offset: number
    readonly anchor: PendingAnchor<Pending[]>
  }[]
}

interface PendingCell {
  props: RawCellProps
  format: TableFormat | null
  readonly content: Pending[]
}

interface PendingRow {
  props: RawRowProps
  readonly cells: PendingCell[]
}

interface PendingTable {
  props: RawTableProps
  chain: TableStyleChain
  readonly grid: number[]
  readonly rows: PendingRow[]
}

type Pending =
  | { readonly kind: 'paragraph'; readonly p: PendingParagraph }
  | { readonly kind: 'table'; readonly t: PendingTable }

export interface BodyResult {
  readonly body: readonly Block[]
  readonly sections: readonly Section[]
  readonly background: Background | null
}

/** 正文解析的环境：样式、关系、主题与图片部件的登记。 */
export interface BodyEnv {
  readonly styles: Styles
  readonly rels: Relationships
  readonly scope: StyleScope
  /** 图片部件在 `DocxDocument.media` 中的下标，首次出现时登记；部件不存在时为 -1。 */
  readonly media: (part: string) => number
  /**
   * 图表部件的求值结果，每次引用调用一次（图表中图片填充的部件随之登记）；部件不存在或含未实现内容时为 `null`。
   */
  readonly chart: (part: string) => Chart | null
  /** SmartArt 的求值结果，每次引用调用一次；数据部件不存在或含未实现内容时为 `null`。 */
  readonly diagram: (parts: DiagramParts) => Diagram | null
  /** `adjustLineHeightInTable`。 */
  readonly gridInTables: boolean
  /** 显示公式的缺省对齐方式（`m:defJc`）。 */
  readonly mathJustification: MathJustification
}

export class BodyReader {
  private readonly blocks: Block[] = []
  private readonly sections: Section[] = []
  /** 尚未确定所在节的顶层块。 */
  private pending: Pending[] = []
  /** 当前读取的块的去处：正文顶层、单元格或文本框。 */
  private target: Pending[] = this.pending
  /** 当前所在单元格的表格样式层；不在表格中（含文本框）时为 `null`。 */
  private layer: TableLayer | null = null
  private readonly fields: Field[] = []
  private deleted = 0
  /** 当前段落的第一个有内容的字段（见 `noteContent`）、嵌入式对象、浮动对象与已读文字的长度。 */
  private first: FirstContent | null = null
  private images: InlineImage[] = []
  private anchors: { offset: number; anchor: PendingAnchor<Pending[]> }[] = []
  private textLength = 0
  /** 当前段落中 `m:oMathPara` 与不在其中的 `m:oMath` 的个数，以及最后一个 `m:oMathPara` 的 `jc`。 */
  private mathParagraphs = 0
  private bareMath = 0
  private formulaJustification: MathJustification | null = null
  /** 正在读取页眉页脚部件（`readStory`）。 */
  private story = false
  private readonly drawing: DrawingContext<Pending[]>

  constructor(
    private readonly x: Scanner,
    private readonly resolver: Resolver,
    private readonly count: (kind: UnsupportedKind) => void,
    private readonly env: BodyEnv,
  ) {
    this.drawing = {
      rels: env.rels,
      scope: env.scope,
      count,
      image: (part) => {
        env.media(part)
      },
      content: () => this.readNested(null),
      chart: (id) => this.chart(id),
      diagram: env.diagram,
    }
  }

  /** 关系标识引用的图表。 */
  private chart(id: string): Chart | null {
    const rel = this.env.rels.byId(id)
    return rel?.part == null || rel.external ? null : this.env.chart(rel.part)
  }

  /** 嵌入式对象中可绘制的图表或 SmartArt，对象框为 `wp:extent`。 */
  private graphic(
    chartId: string | null,
    parts: DiagramParts | null,
    width: number,
    height: number,
  ): DrawingGraphic | null {
    const frame = graphicFrame(width, height)
    const chart = chartId === null ? null : this.chart(chartId)
    if (chart !== null) return { kind: 'chart', frame, chart }
    const diagram = parts === null ? null : this.env.diagram(parts)
    return diagram === null ? null : { kind: 'diagram', frame, diagram }
  }

  /** 根元素为 `document` 的部件。 */
  read(): BodyResult {
    const x = this.x
    let background: Background | null = null
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t !== 'start' || x.depth !== 2) continue
      if (x.local === 'background') background = this.readBackground()
      else if (x.local === 'body') eachChild(x, (local) => this.readBlock(local))
    }
    if (this.pending.length > 0 || this.sections.length === 0) this.endSection(DEFAULT_SECTION)
    return { body: this.blocks, sections: this.sections, background }
  }

  /** 根元素为 `hdr` 或 `ftr` 的部件：其中的块按 `section` 的版面解决属性。 */
  readStory(section: Section): Block[] {
    this.story = true
    const x = this.x
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'start' && x.depth === 1) {
        eachChild(x, (local) => this.readBlock(local))
        break
      }
    }
    this.endSection(section)
    return this.blocks
  }

  /**
   * `w:background`：颜色与 `v:background/v:fill` 的图片。WPS 实测：都自页面左上角平铺，不缩放到页面（1055×1491 像素的
   * 图片在 A4 页面上右下部分超出页面）；`frame` 按图片的像素尺寸，`tile` 按图片文件记录的分辨率换算（构造文档 w11bg：
   * 200×100 像素、150 dpi 的 PNG 与 JPEG 平铺单元为 128×64 像素，`frame` 时为 200×100 像素）。
   * 渐变等其他填充计为 `vml`，只保留颜色。
   */
  private readBackground(): Background | null {
    const x = this.x
    const color = hexColor(wAttr(x, 'color'))
    let part: string | null = null
    let image = false
    let tile = false
    const depth = x.depth
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'end' && x.depth === depth) break
      if (t !== 'start' || x.local !== 'fill') continue
      const type = x.attr('type')
      image = type === 'frame' || type === 'tile'
      tile = type === 'tile'
      const id = x.attrNs(RELATIONSHIPS, 'id')
      const rel = id === null ? null : this.env.rels.byId(id)
      if (rel !== null && !rel.external) part = rel.part ?? null
    }
    if (part !== null && image && this.env.media(part) >= 0)
      return { kind: 'image', part, color, tile }
    if (part !== null) this.count('vml')
    return color === null ? null : { kind: 'color', color }
  }

  private endSection(section: Section): void {
    const index = this.sections.length
    this.sections.push(section)
    for (const b of this.pending) this.blocks.push(this.resolveBlock(b, index, section, 'body'))
    this.pending = []
    this.target = this.pending
  }

  /** `place`：块所在的容器，段落属性按 `placeProps` 调整。 */
  private resolveBlock(b: Pending, index: number, section: Section, place: BlockPlace): Block {
    if (b.kind === 'paragraph') return this.resolveParagraph(b.p, index, section, place)
    return this.resolveTable(b.t, index, section)
  }

  /**
   * 单元格与文本框中段落的排版规则（WPS 实测）：不悬挂行尾标点，越界的标点与其前一字移到下一行（兼容模式 14 与 15
   * 相同，单元格中显式设置 `overflowPunct` 也不悬挂；文本框见构造文档 w11d）；单元格中未设置 `adjustLineHeightInTable`
   * 时不对齐行网格。
   */
  private placeProps(props: ParagraphProps, place: BlockPlace): ParagraphProps {
    if (place === 'body') return props
    if (place === 'textbox') return { ...props, overflowPunct: false }
    return { ...props, overflowPunct: false, snapToGrid: props.snapToGrid && this.env.gridInTables }
  }

  private resolveParagraph(
    pp: PendingParagraph,
    index: number,
    section: Section,
    place: BlockPlace,
  ): Paragraph {
    const { ctx, runs, mark, numbering, images } = pp
    // 首行缩进的字符单位取段落第一个有内容的字段的字号加两倍字符间距，对象所在的字段不加间距；没有这样的字段时取
    // 段落标记的属性。WPS 实测（构造文档 w13 a1）：文字 12 磅、间距 1 磅时两个字符为 28 磅；12 磅字段中的图片在前、
    // 段落标记 18 磅时为 24 磅，间距 1 磅时仍为 24 磅；隐藏文字与浮动对象所在的字段同样计入，空字段与只有
    // `lastRenderedPageBreak` 的字段不计入。上下标字段按原字号计算。
    const first = pp.first?.props ?? mark
    const spacing = pp.first?.object === true ? 0 : first.spacing
    const unit = (first.complexScript ? first.sizeCs : first.size) + 2 * spacing
    const props = paragraphProps(ctx, section, unit, this.count)
    return {
      kind: 'paragraph',
      section: index,
      style: ctx.style,
      props: this.placeProps(props, place),
      runs,
      mark,
      numbering,
      images,
      anchors: pp.anchors.map(
        (a): Anchor => ({
          offset: a.offset,
          horizontal: a.anchor.horizontal,
          vertical: a.anchor.vertical,
          width: a.anchor.width,
          height: a.anchor.height,
          effect: a.anchor.effect,
          wrap: a.anchor.wrap,
          behind: a.anchor.behind,
          z: a.anchor.z,
          drawing:
            a.anchor.drawing === null ? null : this.resolveNode(a.anchor.drawing, index, section),
        }),
      ),
    }
  }

  private resolveNode(n: PendingNode<Pending[]>, index: number, section: Section): DrawingNode {
    if (n.kind === 'chart' || n.kind === 'diagram') return n
    if (n.kind === 'group') {
      return {
        kind: 'group',
        frame: n.frame,
        effects: n.effects,
        children: n.children.map((c) => this.resolveNode(c, index, section)),
      }
    }
    return {
      ...n,
      text:
        n.text === null
          ? null
          : {
              content: n.text.content.map((b) => this.resolveBlock(b, index, section, 'textbox')),
              inset: n.text.inset,
              anchor: n.text.anchor,
              autoFit: n.text.autoFit,
              wrap: n.text.wrap,
            },
    }
  }

  private resolveTable(t: PendingTable, index: number, section: Section): TableBlock {
    const tbl = mergeTableProps(t.chain.whole.tblPr, t.props)
    const margins = edges(tbl.margins, ZERO_EDGES)
    if (tbl.float !== undefined) this.count('floatingTable')
    const last = t.rows.length - 1
    return {
      kind: 'table',
      section: index,
      grid: t.grid,
      width: tbl.width ?? null,
      layout: tbl.layout ?? 'autofit',
      indent: tbl.indent ?? 0,
      align: tbl.align ?? 'left',
      borders: tableBorders(tbl.borders),
      margins,
      float: tbl.float ?? null,
      rows: t.rows.map((row, r) => ({
        height: row.props.height ?? null,
        header: row.props.header ?? false,
        cantSplit: row.props.cantSplit ?? false,
        gridBefore: row.props.gridBefore ?? 0,
        cells: row.cells.map((cell, c) => {
          const own = cell.props
          const format = cell.format ?? cellFormat(t.chain, (row.props.cnf ?? 0) | (own.cnf ?? 0))
          const style = format.tcPr
          return {
            span: own.span ?? 1,
            vMerge: own.vMerge ?? null,
            content: cell.content.map((b) => this.resolveBlock(b, index, section, 'cell')),
            width: own.width ?? null,
            borders: cellBorders(own.borders, style.borders, {
              first: c === 0,
              last: c === row.cells.length - 1,
              top: r === 0,
              bottom: r === last,
            }),
            shading:
              own.shading !== undefined
                ? own.shading
                : style.shading !== undefined
                  ? style.shading
                  : (tbl.shading ?? null),
            margins: edges(own.margins, edges(style.margins, margins)),
            vAlign: own.vAlign ?? style.vAlign ?? 'top',
            noWrap: own.noWrap ?? false,
          }
        }),
      })),
    }
  }

  /** 读取当前元素的子块到新的去处（单元格或文本框），返回读到的块。 */
  private readNested(layer: TableLayer | null): Pending[] {
    const out: Pending[] = []
    const target = this.target
    const outer = this.layer
    this.target = out
    this.layer = layer
    eachChild(this.x, (local) => this.readBlock(local))
    this.target = target
    this.layer = outer
    return out
  }

  /** 块级元素：段落、表格与块级容器。 */
  private readBlock(local: string): void {
    const x = this.x
    switch (local) {
      case 'p':
        this.readParagraph()
        return
      case 'tbl':
        this.readTable()
        return
      case 'sdtContent':
      case 'customXml':
      case 'sdt':
        eachChild(x, (inner) => this.readBlock(inner))
        return
      case 'ins':
      case 'moveTo':
        this.count('revision')
        eachChild(x, (inner) => this.readBlock(inner))
        return
      case 'del':
      case 'moveFrom':
        this.count('revision')
        break
      case 'altChunk':
        this.count('altChunk')
        break
      case 'sectPr':
        if (this.target === this.pending) {
          this.endSection(readSection(x, this.count))
          return
        }
        break
    }
    skip(x)
  }

  private readTable(): void {
    const x = this.x
    const styles = this.env.styles
    const table: PendingTable = {
      props: {},
      chain: tableStyleChain(styles, styles.defaultTableStyle),
      grid: [],
      rows: [],
    }
    this.target.push({ kind: 'table', t: table })
    eachChild(x, (local) => {
      if (local === 'tblPr') {
        table.props = readTableProps(x)
        table.chain = tableStyleChain(styles, table.props.style ?? styles.defaultTableStyle)
      } else if (local === 'tblGrid') {
        eachChild(x, (col) => {
          if (col === 'gridCol') table.grid.push(Math.max(0, (Number(wAttr(x, 'w')) || 0) / 20))
          skip(x)
        })
      } else if (local === 'tr') this.readRow(table)
      else skip(x)
    })
  }

  private readRow(table: PendingTable): void {
    const x = this.x
    const row: PendingRow = { props: {}, cells: [] }
    table.rows.push(row)
    eachChild(x, (local) => {
      if (local === 'trPr') row.props = readRowProps(x)
      else if (local === 'tc') this.readCell(table, row)
      else skip(x)
    })
  }

  private readCell(table: PendingTable, row: PendingRow): void {
    const x = this.x
    const cell: PendingCell = { props: {}, format: null, content: [] }
    row.cells.push(cell)
    const target = this.target
    const outer = this.layer
    this.target = cell.content
    const format = () => {
      cell.format ??= cellFormat(table.chain, (row.props.cnf ?? 0) | (cell.props.cnf ?? 0))
      this.layer = { pPr: cell.format.pPr, rPr: cell.format.rPr }
    }
    eachChild(x, (local) => {
      if (local === 'tcPr') {
        cell.props = readCellProps(x)
        return
      }
      format()
      this.readBlock(local)
    })
    this.target = target
    this.layer = outer
  }

  private readParagraph(): void {
    const x = this.x
    const saved = {
      first: this.first,
      images: this.images,
      anchors: this.anchors,
      textLength: this.textLength,
      mathParagraphs: this.mathParagraphs,
      bareMath: this.bareMath,
      formulaJustification: this.formulaJustification,
    }
    let direct: RawParaProps = {}
    let directMark: RawRunProps = {}
    let section: Section | null = null
    let ctx: ParagraphContext | null = null
    const runs: Run[] = []
    this.first = null
    this.images = []
    this.anchors = []
    this.textLength = 0
    this.mathParagraphs = 0
    this.bareMath = 0
    this.formulaJustification = null
    const layer = this.layer
    eachChild(x, (local) => {
      if (local === 'pPr') {
        direct = readParaProps(x, {
          mark: (m) => {
            directMark = m
          },
          section: () => {
            section = readSection(x, this.count)
          },
        })
        return
      }
      ctx ??= this.resolver.paragraph(direct, layer)
      this.readInline(local, ctx, runs)
    })
    ctx ??= this.resolver.paragraph(direct, layer)
    const r = this.resolver
    const markRaw = r.effectiveRun(ctx, directMark)
    let numbering: Numbering | null = null
    if (ctx.numbering !== null) {
      const n = r.numbering.next(ctx.numbering.numId, ctx.numbering.ilvl)
      if (n !== null) {
        numbering = {
          text: n.text,
          props: r.runProps(mergeRun(markRaw, n.level.rPr)),
          suffix: n.level.suffix,
          align: n.level.align,
        }
      }
    }
    const p = ctx.pPr
    if (p.frame === true) this.count('frame')
    if (p.bidi === true) this.count('rtl')
    if (p.textDirection !== undefined && p.textDirection !== 'lrTb' && p.textDirection !== 'tb')
      this.count('textDirection')
    const pending: PendingParagraph = {
      ctx,
      runs: this.displayFormula(runs),
      mark: r.runProps(markRaw),
      numbering,
      first: this.first,
      images: this.images,
      anchors: this.anchors,
    }
    this.first = saved.first
    this.images = saved.images
    this.anchors = saved.anchors
    this.textLength = saved.textLength
    this.mathParagraphs = saved.mathParagraphs
    this.bareMath = saved.bareMath
    this.formulaJustification = saved.formulaJustification
    const top = this.target === this.pending
    this.target.push({ kind: 'paragraph', p: pending })
    if (section !== null && top) this.endSection(section)
  }

  /**
   * 段落中只有公式、没有其他文字与嵌入式对象，且公式为一个 `m:oMathPara` 或若干个不在 `m:oMathPara` 中的 `m:oMath` 时，
   * 其中的公式为显示公式（见 `RunMath.display`；WPS 实测：同一段落中的两个 `m:oMath` 与一个 `m:oMathPara` 中的两个位置相同）。
   */
  private displayFormula(runs: Run[]): Run[] {
    const single = this.mathParagraphs === 1 ? this.bareMath === 0 : this.mathParagraphs === 0
    if (
      !single ||
      runs.length === 0 ||
      this.images.length > 0 ||
      runs.some((r) => r.math === undefined)
    )
      return runs
    const display = this.formulaJustification ?? this.env.mathJustification
    return runs.map((r) => ({ ...r, math: { zone: r.math!.zone, display } }))
  }

  /** `m:oMath` 或 `m:oMathPara`：每个 `m:oMath` 记为一个字段。返回时位于其结束标签。 */
  private readFormula(local: string, ctx: ParagraphContext, runs: Run[]): void {
    const r = this.resolver
    const read = (x: Scanner) => r.runProps(r.effectiveRun(ctx, readRunProps(x)))
    let zones: RunMath[]
    if (local === 'oMath') {
      zones = [{ zone: readMath(this.x, read), display: null }]
      this.bareMath++
    } else {
      const para = readMathParagraph(this.x, read)
      this.formulaJustification = para.justification
      zones = para.zones.map((zone) => ({ zone, display: null }))
      this.mathParagraphs++
    }
    const props = r.runProps(r.effectiveRun(ctx, {}))
    this.noteContent(props, false)
    const field = this.fieldName()
    const f = this.fields.at(-1)
    for (const math of zones) {
      if (f !== undefined) f.shown = true
      runs.push({ text: '', props, field, math })
    }
  }

  /** 段落内的元素：字段与包含字段的容器。 */
  private readInline(local: string, ctx: ParagraphContext, runs: Run[]): void {
    const x = this.x
    if (local === 'r') {
      this.readRun(ctx, runs)
      return
    }
    if (RUN_CONTAINERS.has(local) || local === 'sdt') {
      eachChild(x, (inner) => this.readInline(inner, ctx, runs))
      return
    }
    switch (local) {
      case 'fldSimple': {
        const instr = wAttr(x, 'instr') ?? ''
        const hidden = this.hidden()
        if (!hidden) this.dynamic(instr)
        const field: Field = {
          result: true,
          instr,
          shown: false,
          start: { runs, index: runs.length },
        }
        this.fields.push(field)
        eachChild(x, (inner) => this.readInline(inner, ctx, runs))
        this.fields.pop()
        if (!hidden) this.endField(field, ctx, runs, runs.length > field.start!.index)
        return
      }
      case 'ins':
      case 'moveTo':
        this.count('revision')
        eachChild(x, (inner) => this.readInline(inner, ctx, runs))
        return
      case 'del':
      case 'moveFrom':
        this.count('revision')
        this.deleted++
        eachChild(x, (inner) => this.readInline(inner, ctx, runs))
        this.deleted--
        return
      case 'ruby':
        this.count('ruby')
        eachChild(x, (inner) => {
          if (inner === 'rubyBase') eachChild(x, (b) => this.readInline(b, ctx, runs))
          else skip(x)
        })
        return
      case 'oMath':
      case 'oMathPara':
        if (this.hidden()) break
        this.readFormula(local, ctx, runs)
        return
      case 'subDoc':
        this.count('subDocument')
        break
    }
    skip(x)
  }

  /** 域结束：页眉页脚中的 STYLEREF 合并结果字段（见 `styleRef`），没有结果字段的页码域补一个空字段。 */
  private endField(f: Field, ctx: ParagraphContext, runs: Run[], shown: boolean): void {
    const name = fieldNameOf(f.instr)
    if (this.story && name === 'STYLEREF' && f.start?.runs === runs) this.styleRef(f, ctx, runs)
    else if (!shown) this.pageFieldPlaceholder(name, ctx, runs)
  }

  /**
   * 页眉页脚中的 STYLEREF 域：结果字段合并为一个带 `styleRef` 的字段，字段属性取第一个结果字段，文字由分页按页求出；
   * 样式参数无效时显示 WPS 的错误文字。结果部分跨段落时不合并。
   */
  private styleRef(f: Field, ctx: ParagraphContext, runs: Run[]): void {
    const index = f.start!.index
    const props = runs[index]?.props ?? this.resolver.runProps(this.resolver.effectiveRun(ctx, {}))
    const cached = runs
      .slice(index)
      .map((r) => r.text)
      .join('')
    runs.splice(index)
    const ref = styleRefOf(f.instr, this.env.styles)
    runs.push(
      ref === null
        ? { text: STYLE_UNDEFINED, props, field: 'STYLEREF' }
        : { text: cached, props, field: 'STYLEREF', styleRef: ref },
    )
  }

  /** 没有结果字段的页码域：补一个空字段，字段属性取段落标记之外的缺省字段属性。 */
  private pageFieldPlaceholder(name: string, ctx: ParagraphContext, runs: Run[]): void {
    if (!PAGE_FIELDS.has(name)) return
    const props = this.resolver.runProps(this.resolver.effectiveRun(ctx, {}))
    this.noteContent(props, false)
    runs.push({ text: '', props, field: name })
  }

  /** 记下段落中第一个有内容的字段，供首行缩进的字符单位（见 `resolveParagraph`）。 */
  private noteContent(props: RunProps, object: boolean): void {
    this.first ??= { props, object }
  }

  /** 打开时重新计算的域计入 `dynamicField`；页眉页脚中的页码域由分页按页生成，不计入。 */
  private dynamic(instr: string): void {
    const name = fieldNameOf(instr)
    if (DYNAMIC_FIELDS.has(name) && !(this.story && PAGE_FIELDS.has(name)))
      this.count('dynamicField')
  }

  /** 最内层处于结果部分的域的域名。 */
  private fieldName(): string | null {
    const f = this.fields.at(-1)
    return f === undefined || !f.result ? null : fieldNameOf(f.instr)
  }

  private hidden(): boolean {
    if (this.deleted > 0) return true
    for (const f of this.fields) if (!f.result) return true
    return false
  }

  /** 目录域结果中的字段去掉超链接字符样式（见文件头）。 */
  private tocRun(direct: RawRunProps): RawRunProps {
    if (direct.style === undefined) return direct
    if (!this.fields.some((f) => f.result && fieldNameOf(f.instr) === 'TOC')) return direct
    if (this.env.styles.byId.get(direct.style)?.name.toLowerCase() !== 'hyperlink') return direct
    const { style: _, ...rest } = direct
    return rest
  }

  private readRun(ctx: ParagraphContext, runs: Run[]): void {
    const x = this.x
    const r = this.resolver
    let direct: RawRunProps = {}
    let raw: RawRunProps | null = null
    let props: RunProps | null = null
    let counted = false
    let last: { text: string; props: RunProps; field: string | null } | null = null
    const effective = (): RawRunProps => {
      raw ??= r.effectiveRun(ctx, this.tocRun(direct))
      return raw
    }
    const resolved = (): RunProps => {
      props ??= r.runProps(effective())
      return props
    }
    const emit = (text: string, override?: RawRunProps) => {
      if (text === '' || this.hidden()) return
      const eff = effective()
      const base = resolved()
      this.noteContent(base, false)
      if (eff.vanish === true) return
      if (!counted) {
        counted = true
        this.countRun(eff)
      }
      const p = override ? r.runProps(mergeRun(eff, override)) : base
      const field = this.fieldName()
      const f = this.fields.at(-1)
      if (f !== undefined) f.shown = true
      this.textLength += text.length
      if (last !== null && last.props === p && last.field === field) {
        last.text += text
        runs[runs.length - 1] = { text: last.text, props: p, field }
        return
      }
      last = { text, props: p, field }
      runs.push({ text, props: p, field })
    }
    eachChild(x, (local) => {
      switch (local) {
        case 'rPr':
          direct = readRunProps(x)
          return
        case 't': {
          const preserve = x.attr('xml:space') === 'preserve'
          const text = readText(x)
          emit(preserve ? text : text.replace(XML_WHITESPACE, ''))
          return
        }
        case 'tab':
          emit('\t')
          break
        case 'br': {
          // 单元格中的分页符与分栏符不起作用、不占宽度（WPS 实测，构造文档 w11h）；换行符照常。
          const type = wAttr(x, 'type')
          if (type === 'page' || type === 'column') {
            if (this.layer === null) emit(type === 'page' ? '\f' : '\v')
          } else emit('\n')
          break
        }
        case 'cr':
          emit('\n')
          break
        case 'noBreakHyphen':
          emit('‑')
          break
        case 'softHyphen':
          if (!this.hidden()) this.count('softHyphen')
          break
        case 'sym': {
          const font = wAttr(x, 'font')
          const code = Number.parseInt(wAttr(x, 'char') ?? '', 16)
          if (Number.isFinite(code) && code > 0) {
            const ref = font === null ? undefined : { name: font }
            emit(
              String.fromCodePoint(code),
              ref === undefined ? undefined : { ascii: ref, hAnsi: ref, eastAsia: ref, cs: ref },
            )
          }
          break
        }
        case 'ptab':
          this.count('ptab')
          emit('\t')
          break
        case 'fldChar':
          this.fieldChar(wAttr(x, 'fldCharType'), ctx, runs)
          break
        case 'instrText': {
          const f = this.fields.at(-1)
          const text = readText(x)
          if (f !== undefined && !f.result) f.instr += text
          return
        }
        case 'drawing':
          if (!this.hidden()) {
            const eff = effective()
            this.noteContent(resolved(), true)
            this.readDrawing(eff.vanish === true, runs, resolved().position)
            last = null
          } else skip(x)
          return
        case 'pict':
          if (!this.hidden()) {
            this.noteContent(resolved(), true)
            const a = readVml(x, this.drawing)
            if (a !== null) this.anchors.push({ offset: this.textLength, anchor: a })
          } else skip(x)
          return
        case 'object':
          if (!this.hidden()) {
            const eff = effective()
            this.noteContent(resolved(), true)
            this.readObject(eff.vanish === true, runs.length, resolved().position)
            last = null
          } else skip(x)
          return
        case 'footnoteReference':
          if (!this.hidden()) this.count('footnote')
          break
        case 'endnoteReference':
          if (!this.hidden()) this.count('endnote')
          break
        case 'commentReference':
          this.count('comment')
          break
        case 'contentPart':
          if (!this.hidden()) this.count('contentPart')
          break
      }
      skip(x)
    })
  }

  private fieldChar(type: string | null, ctx: ParagraphContext, runs: Run[]): void {
    if (type === 'begin') {
      this.fields.push({ result: false, instr: '', shown: false, start: null })
    } else if (type === 'separate') {
      const f = this.fields.at(-1)
      if (f !== undefined && !f.result) {
        f.result = true
        f.start = { runs, index: runs.length }
        if (!this.hidden()) this.dynamic(f.instr)
      }
    } else if (type === 'end') {
      const f = this.fields.pop()
      if (f !== undefined && !this.hidden()) this.endField(f, ctx, runs, f.shown)
    }
  }

  private countRun(eff: RawRunProps): void {
    if (eff.scale !== undefined && eff.scale !== 100) this.count('characterScale')
    if (eff.emphasis !== undefined && eff.emphasis !== 'none') this.count('emphasisMark')
    if (eff.smallCaps === true) this.count('smallCaps')
    if (eff.eastAsianLayout === true) this.count('eastAsianLayout')
    if (eff.fitText === true) this.count('fitText')
    if (eff.rtl === true) this.count('rtl')
  }

  /**
   * `w:drawing`：浮动对象交给 `readAnchor`；嵌入式对象按 `graphicData/@uri` 分类，记入段落的 `images`（字段隐藏时不记），
   * 有图片部件的图片不计数。返回时位于其结束标签。
   */
  private readDrawing(vanish: boolean, runs: readonly Run[], raise: number): void {
    const x = this.x
    eachChild(x, (local) => {
      if (local === 'anchor') {
        const a = readAnchor(x, this.drawing)
        if (!vanish) this.anchors.push({ offset: this.textLength, anchor: a })
      } else if (local === 'inline') this.readInlineObject(vanish, runs.length, raise)
      else skip(x)
    })
  }

  /**
   * `w:object`：按其中 VML 形状的宽高作为嵌入式对象，图片为 `v:imagedata`；没有形状或图片部件时计为 `ole`
   * （有形状时仍占行高）。
   */
  private readObject(vanish: boolean, run: number, raise: number): void {
    const shape = readObjectShape(this.x, this.env.rels)
    if (vanish) return
    if (shape === null || shape.width <= 0 || shape.height <= 0) {
      this.count('ole')
      return
    }
    const media = shape.picture === null ? -1 : this.env.media(shape.picture)
    const effect = { left: 0, top: 0, right: 0, bottom: 0 }
    this.images.push({
      run,
      raise,
      media,
      graphic: null,
      width: shape.width,
      height: shape.height,
      effect,
      crop: shape.crop,
    })
    if (media < 0) this.count('ole')
  }

  private readInlineObject(vanish: boolean, run: number, raise: number): void {
    const x = this.x
    const depth = x.depth
    let uri = ''
    let width = 0
    let height = 0
    const effect = { left: 0, top: 0, right: 0, bottom: 0 }
    let embed: string | null = null
    let crop = ZERO_RECT
    let chartId: string | null = null
    let diagram: DiagramParts | null = null
    const points = (attr: string) => Number(x.attr(attr) ?? 0) / EMU_PER_POINT
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'end' && x.depth === depth) break
      if (t !== 'start') continue
      if (x.depth === depth + 1 && x.local === 'extent') {
        width = points('cx')
        height = points('cy')
      } else if (x.depth === depth + 1 && x.local === 'effectExtent') {
        effect.left = points('l')
        effect.top = points('t')
        effect.right = points('r')
        effect.bottom = points('b')
      } else if (x.local === 'graphicData' && uri === '') uri = x.attr('uri') ?? ''
      else if (x.local === 'blip' && embed === null) embed = x.attrNs(RELATIONSHIPS, 'embed')
      else if (x.local === 'srcRect' && embed !== null) crop = readRelativeRect(x)
      else if (x.local === 'chart' && chartId === null && uri.endsWith(CHART_URI))
        chartId = x.attrNs(RELATIONSHIPS, 'id')
      else if (x.local === 'relIds' && diagram === null && uri.endsWith(DIAGRAM_URI))
        diagram = readDiagramParts(x, this.env.rels)
    }
    let kind: UnsupportedKind = 'drawing'
    for (const [suffix, k] of INLINE_KINDS) if (uri.endsWith(suffix)) kind = k
    if (!vanish && width > 0 && height > 0) {
      const rel = kind === 'picture' && embed !== null ? this.env.rels.byId(embed) : null
      const media = rel?.part != null && !rel.external ? this.env.media(rel.part) : -1
      const graphic = this.graphic(chartId, diagram, width, height)
      this.images.push({ run, raise, media, graphic, width, height, effect, crop })
      if (media >= 0 || graphic !== null) return
    }
    this.count(kind)
  }
}

/** 块所在的容器：正文（含页眉页脚）、表格单元格或文本框。 */
type BlockPlace = 'body' | 'cell' | 'textbox'

/** 域代码的域名（第一个词，大写）。 */
function fieldNameOf(instr: string): string {
  return instr.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? ''
}

/** STYLEREF 的样式参数无效时 WPS 显示的文字。 */
const STYLE_UNDEFINED = '错误！未定义样式。'

/**
 * STYLEREF 的样式参数（WPS 12.1 实测）：`1`–`9` 与「标题 1」至「标题 9」为内置标题样式（样式名为 `heading N`，文档中
 * 没有该样式时 `style` 为 `null`），其余参数按自定样式的样式名匹配；内置样式的英文名（如 `heading 1`）、样式标识与
 * 去掉空格的「标题1」均无效。参数无效时返回 `null`。其他开关不影响结果。
 */
function styleRefOf(instr: string, styles: Styles): StyleRef | null {
  const m = /^\s*\S+\s+(?:"([^"]*)"|(\S+))(.*)$/s.exec(instr)
  if (m === null) return null
  const arg = (m[1] ?? m[2] ?? '').trim()
  const last = /\\l(?![a-z])/i.test(m[3] ?? '')
  const level = /^(?:标题 )?([1-9])$/.exec(arg)
  const find = (name: string, custom: boolean) => {
    for (const s of styles.byId.values())
      if (s.type === 'paragraph' && s.custom === custom && s.name.toLowerCase() === name)
        return s.id
    return null
  }
  if (level !== null) return { style: find(`heading ${level[1]}`, false), last }
  const style = find(arg.toLowerCase(), true)
  return style === null ? null : { style, last }
}
