/**
 * 分页入口：逐段排版、表格排版、页眉页脚排版、浮动对象的定位与环绕、分页，并把结果整理为纯数据的 `DocumentPages`。
 *
 * - 页眉页脚：节未引用某类部件时沿用上一节同类的部件；首页部件只在节设置 `titlePg` 时用于节的第一页，
 *   偶数页部件只在 `evenAndOddHeaders` 时用于页码为偶数的页（含重新编号），其余页用缺省部件；所需部件不存在时该处为空。
 * - 页眉自页面顶边下 `header` 处向下排列，页脚的底边位于页面底边上 `footer` 处；宽度为版心宽度（不分栏）。
 * - 正文区：页眉底边超过上边距时正文自页眉底边开始，页脚顶边高于下边距时正文在页脚顶边结束。
 * - 页码域（`PAGE`、`NUMPAGES`、`SECTIONPAGES`）按页重新生成文字后排版：`PAGE` 按节的页码格式，其余为十进制。
 * - 嵌入式对象：只有独占一行的图片按段落对齐方式绘制，底边位于行底；与文字同行的图片计入 `Page.hidden`，
 *   其余嵌入式对象已在解析时按种类计入 `unsupported`。
 * - 浮动对象（WPS 12.1 实测）：对象的位置按锚定段落在不受该对象影响时的位置求得（相对段落时取段落顶边，
 *   含段前间距），之后本页与对象重叠的各行（含锚定段落之前的段落）避让，对象不随锚定段落移动。环绕方式：
 *   上下型（`topAndBottom`）使与对象及其上下距离范围重叠的行（行底恰好接触对象顶边的行同样计入）下移到其下方；
 *   四周型、紧密型与穿越型按对象框加左右距离的矩形避让，一行依次排入对象两侧宽度足够的区段（不足 `MIN_SEGMENT`
 *   的区段不用），没有可用区段时下移到对象下方；衬于文字下方（`behindDoc`）不改变环绕；`wrapNone` 不避让。
 *   锚定段落的行不因本段的对象移出正文区（留在原处与对象重叠）；结束一节且没有文字的段落不避让（WPS 实测：
 *   整页图片之后的分节段落留在原处，节中的空段落照常下移）。
 *   对象属于锚定字符所在的行：相对段落定位时，基准为段落顶边（行在段落的第一部分中）或该行所在部分第一行的行顶；
 *   段落被本页已有的上下型对象推下时，基准取只下移一次后的位置（WPS 实测：段落先移到图片下方，不再计紧接其下的
 *   图注文本框，段内组合的位置按此求得；该段落的行最终仍移到图注与组合之下）。
 *   底边超出正文区底边的对象（只限影响环绕、相对段落或行按偏移定位的对象）：顶边已在正文区之下时，对象底边与页面
 *   底边对齐；顶边在正文区内时，对象上移至其底边与正文区底边对齐，上移后高于段落顶边则锚定段落连同对象移到下一页
 *   （段落已在页首时不移）。段落均不因此改变位置以外的排版。
 *   单元格、文本框与页眉页脚中的对象只绘制，不使正文避让。
 * - 页面背景：纯色铺满整页；图片按像素尺寸自页面左上角平铺（见 `Background`）。
 * - 页面边框：`offsetFrom` 为 `page` 时各边距页面边缘 `space` 磅，为 `text` 时距正文区（页边距）`space` 磅。
 */

import type { LineArea, TextLine } from '../../text/index.ts'
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
  DrawingNode,
  Paragraph,
  PartRefs,
  Run,
  RunProps,
  Section,
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
  Page,
  PageBackground,
  PageBorderBox,
  PageEdge,
  PageFill,
  PageFloat,
  PageFragment,
  PageImage,
  PageItem,
  PageLine,
  PageParagraph,
  PageTable,
  ParagraphBox,
  Underline,
} from './model.ts'
import {
  type BodyArea,
  type Exclusion,
  type LinePlacement,
  type PageKind,
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

/** 块中页码域的字段按 `values` 替换文字（含表格与文本框中的段落）。 */
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
  if (n.text === null) return n
  return { ...n, text: { ...n.text, content: withFields(n.text.content, values) } }
}

/** 文档所需的全部字体名：正文、表格、文本框与各节引用的页眉页脚。调用方据此预先取得字体文件。 */
export function requiredFonts(doc: DocxDocument): string[] {
  const names = new Set<string>()
  const visit = (blocks: readonly Block[]) => {
    blockFonts(blocks, names)
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
    else if (n.text !== null) visit(n.text.content)
  }
  visit(doc.body)
  for (const part of Object.values(doc.parts)) visit(part)
  return [...names]
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

/** 页面的几何：浮动对象的定位基准。 */
interface PageFrame {
  readonly section: Section
  readonly columnLeft: number
  readonly columnWidth: number
}

/** 浮动对象的对象框（页面坐标）。 */
function anchorRect(
  a: Anchor,
  placed: Placed,
  frame: PageFrame,
  limit = Number.POSITIVE_INFINITY,
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
  if (flowing && a.wrap.type !== 'none' && a.vertical.align === null) {
    if (y >= limit) y = s.pageHeight - a.height
    else if (y + a.height > limit && limit - a.height >= placed.top) y = limit - a.height
  }
  return { x: place(a.horizontal, true, a.width), y, width: a.width, height: a.height }
}

function exclusionOf(
  a: Anchor,
  r: { x: number; y: number; width: number; height: number },
  owner: number,
): Exclusion | null {
  if (a.wrap.type === 'none') return null
  const d = a.wrap.distance
  return {
    left: r.x - d.left,
    right: r.x + r.width + d.right,
    top: r.y - d.top,
    bottom: r.y + r.height + d.bottom,
    topAndBottom: a.wrap.type === 'topAndBottom',
    side: a.wrap.side,
    owner,
  }
}

/**
 * 环绕查询：段落 `block` 第一行行顶在 `top`、区域左边在 `x`、宽度 `region`、正文区底边在 `limit` 时各行的可用区段
 * （见文件头）。行下移后再检查新位置上的对象；`once` 为真时上下型只下移一次，不再检查新位置。
 */
function wrapArea(
  exclusions: readonly Exclusion[],
  block: number,
  x: number,
  region: number,
  top: number,
  limit: number,
  once: boolean,
) {
  return (lineTop: number, height: number): LineArea => {
    let y = top + lineTop
    for (let guard = 0; guard < 2 * exclusions.length + 2; guard++) {
      const bottom = y + height
      const hit = exclusions.filter(
        (e) =>
          (e.topAndBottom
            ? bottom > e.top - 0.01 && y < e.bottom
            : bottom > e.top + 0.01 && y < e.bottom) &&
          !(e.owner === block && e.bottom + height > limit + 0.01),
      )
      const tb = hit.filter((e) => e.topAndBottom)
      if (tb.length > 0) {
        y = Math.max(...tb.map((e) => e.bottom))
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
 * 图注文本框按一行文字的高度避让）。其余对象原样返回。
 */
function fitAnchor(a: Anchor, cx: TableContext, cache: Map<Anchor, Anchor>): Anchor {
  const known = cache.get(a)
  if (known !== undefined) return known
  let out = a
  const n = a.drawing
  if (n !== null && n.kind === 'shape' && n.text !== null && n.text.autoFit) {
    const width = Math.max(
      0,
      n.frame.width / EMU_PER_POINT - n.text.inset.left - n.text.inset.right,
    )
    const height =
      layoutStack(n.text.content, width, cx).height + n.text.inset.top + n.text.inset.bottom
    out = {
      ...a,
      height,
      drawing: { ...n, frame: { ...n.frame, height: height * EMU_PER_POINT } },
    }
  }
  cache.set(a, out)
  return out
}

export function layoutPages(doc: DocxDocument, fonts: DocxFonts): PagesResult {
  const layouter = new ParagraphLayouter(doc, fonts.source)
  const cx: TableContext = { layouter, compatibilityMode: doc.settings.compatibilityMode }
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
      if (b.float !== null && b.float.from !== 'text') {
        const s = doc.sections[b.section]!
        const origin = b.float.from === 'page' ? 0 : s.marginLeft + s.gutter
        t = { ...t, x: origin + b.float.x - (s.marginLeft + s.gutter) }
      }
      tables.set(block, t)
    }
    return t
  }

  const partCache = new Map<string, PartLayout>()
  const partLayout = (
    id: string,
    section: number,
    values: FieldValues | null,
  ): PartLayout | null => {
    const source = doc.parts[id]
    if (source === undefined || source.length === 0) return null
    const key = `${id}\u0000${section}\u0000${values === null ? '' : `${values.page}|${values.pages}|${values.sectionPages}`}`
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
    return { section, columnLeft, columnWidth }
  }

  // 浮动对象的位置：段落在一页中第一次放置时求得，同一页中不再改变（见 `paginate.ts`）。
  const rects = new Map<
    string,
    { page: number; rect: { x: number; y: number; width: number; height: number } }
  >()
  const flows = paginate(
    doc,
    { paragraphs: layout, missingFonts: [] },
    {
      area,
      table: tableAt,
      wrap: (block, x, top, bottom, list, once) => {
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
          wrapArea(list, block, x, region, top, bottom, once),
        )
      },
      anchored: (block, page, site) => {
        const p = doc.body[block] as Paragraph
        if (p.anchors.length === 0) return []
        const section = doc.sections[site.section]!
        const lines = site.layout.text.lines
        const base = lines[site.first]?.top ?? 0
        const tops = lines.map((line) => site.lineTop + line.top - base)
        const placed: Placed = {
          paragraph: p,
          layout: site.layout,
          first: 0,
          tops,
          top: site.top,
          regionLeft: site.x,
          regionWidth: section.columns[0]!.width,
        }
        const frame = frameAt(section, site.x)
        const shift = numberingText(p).length
        const out: { key: string; exclusion: Exclusion | null }[] = []
        p.anchors.forEach((raw, k) => {
          const line = lineAt(lines, raw.offset + shift)
          // 锚定在前一部分或（按未环绕的位置）放不进本页的行中的对象留给其所在的页。
          if (line < site.first || (line > site.first && (tops[line] ?? 0) >= site.limit)) return
          const a = fit(raw)
          const key = `${block}:${k}`
          let known = rects.get(key)
          if (known === undefined || known.page !== page) {
            known = { page, rect: anchorRect(a, placed, frame, site.limit) }
            rects.set(key, known)
          }
          out.push({ key, exclusion: exclusionOf(a, known.rect, block) })
        })
        return out
      },
      mustMove: (block, top, limit) => {
        const p = doc.body[block] as Paragraph
        const lines = byBlock.get(block)?.text.lines ?? []
        const shift = numberingText(p).length
        return p.anchors.some((raw) => {
          const a = fit(raw)
          if (a.wrap.type === 'none' || a.vertical.align !== null) return false
          if (a.vertical.from !== 'paragraph' && a.vertical.from !== 'line') return false
          if (lineAt(lines, raw.offset + shift) !== 0) return false
          const y = top + a.vertical.offset
          return y < limit && y + a.height > limit + 0.01 && limit - a.height < top
        })
      },
    },
  )

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

  const pages: Page[] = flows.map((flow, pageIndex) => {
    const sec = doc.sections[flow.section]!
    const x0 = sec.marginLeft + sec.gutter
    const values: FieldValues = {
      page: flow.numberText,
      pages: String(flows.length),
      sectionPages: String(sectionTotals.get(flow.section) ?? 0),
    }
    const out = new PageBuilder(fonts, cx, (x) => frameAt(sec, x), fit)
    const header: PageItem[] = []
    const footer: PageItem[] = []
    if (!flow.blank) {
      const h = partRef(doc, flow.section, flow.kind, 'headers')
      const hl = h === null ? null : partLayout(h, flow.section, values)
      if (hl !== null) out.stackItems(header, hl.stack, x0, sec.header, fullWidth(sec), null)
      const f = partRef(doc, flow.section, flow.kind, 'footers')
      const fl = f === null ? null : partLayout(f, flow.section, values)
      if (fl !== null)
        out.stackItems(
          footer,
          fl.stack,
          x0,
          sec.pageHeight - sec.footer - fl.stack.height,
          fullWidth(sec),
          null,
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
          const known = rects.get(`${item.block}:${k}`)
          return known === undefined ? undefined : known.page === pageIndex ? known.rect : null
        }),
      )
    }
    const background = pageBackground(doc, imageIndex)
    return {
      section: flow.section,
      width: sec.pageWidth,
      height: sec.pageHeight,
      number: flow.numberText,
      header,
      body,
      footer,
      floats: out.floats.sort((a, b) => a.z - b.z).map(({ z: _, ...f }) => f),
      background,
      borders: pageBorders(sec, pageIndex === sectionFirst.get(flow.section)),
      hidden: out.hidden,
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

function pageBackground(
  doc: DocxDocument,
  images: ReadonlyMap<string, number>,
): PageBackground | null {
  const b = doc.background
  if (b === null) return null
  if (b.kind === 'color') return { color: b.color, image: null }
  return { color: b.color, image: images.get(b.part) ?? null }
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
    top: borderLine(b.top),
    bottom: borderLine(b.bottom),
    left: borderLine(b.left),
    right: borderLine(b.right),
  }
}

/** 一页的绘制项：段落、表格、浮动对象与未绘制图片的计数。 */
class PageBuilder {
  readonly floats: (PageFloat & { z: number })[] = []
  hidden = 0

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
      const a = this.fit(raw)
      const r = rectOf(k)
      if (r === null || (r === undefined && placement.first !== 0)) return
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
    if (n.text === null) return
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
        const space = bottom - seg.top - row.border - m.top - m.bottom
        const dy = whole ? alignOffset(cell, space) : 0
        this.stackItems(
          items,
          cell.content,
          x + m.left,
          seg.top + row.border + m.top + dy,
          cell.width - m.left - m.right,
          whole ? null : { from: seg.from[k]!, to: seg.to[k]! },
        )
      })
      // 横向边框：本段上沿。
      const line = t.horizontal[seg.row] ?? []
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
    // 本页部分的底边：表格结束时为底边框，否则为最后一段所在行的下沿。
    const last = segs[segs.length - 1]
    if (last !== undefined) {
      const lineBelow = t.horizontal[placement.end ? t.rows.length : last.row + 1] ?? []
      const y = last.top + last.height
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
    const images: PageImage[] = []
    const inline = p.images
    if (inline.length > 0) {
      const shown = new Map<number, (typeof inline)[number][]>()
      inline.forEach((im, i) => {
        const w = lay.imageLines[i]!
        const k = w.line - first
        if (k < 0 || k >= lines.length) return
        if (im.media < 0) return
        if (!w.alone) this.hidden++
        else shown.set(k, [...(shown.get(k) ?? []), im])
      })
      for (const [k, list] of shown) {
        const line = lines[k]!
        const src = lay.text.lines[first + k]!
        const total = list.reduce((w, im) => w + im.width + im.effect.left + im.effect.right, 0)
        // 图片按行的对齐范围对齐（见 `TextLine.origin`）：独占一行时行中没有文字，`left` 已含空行的对齐偏移。
        const room = src.limit - src.origin
        const offset =
          p.props.align === 'center'
            ? (room - total) / 2
            : p.props.align === 'right'
              ? room - total
              : 0
        let ix = x + src.origin + Math.max(0, offset)
        const bottom = line.top + line.height
        for (const im of list) {
          images.push({
            image: im.media,
            x: ix + im.effect.left,
            y: bottom - im.effect.bottom - im.height,
            width: im.width,
            height: im.height,
          })
          ix += im.width + im.effect.left + im.effect.right
        }
      }
    }
    const style = boxStyle(p)
    let box: ParagraphBox | null = null
    if (style !== null && lines.length > 0) {
      const f = lines[0]!
      const l = lines[lines.length - 1]!
      box = { x, y: f.top, width: lay.width, height: l.top + l.height - f.top, ...style }
    }
    return { kind: 'paragraph', block, firstLine: first, lines, box, images }
  }
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
  if (b === null) return null
  const style =
    b.style === 'double'
      ? 'double'
      : b.style === 'dotted'
        ? 'dotted'
        : b.style.startsWith('dash') || b.style === 'dotDash' || b.style === 'dotDotDash'
          ? 'dashed'
          : 'single'
  return { width: b.width, color: b.color ?? '#000000', style, space: b.space }
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
