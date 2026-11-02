/**
 * 分页：把逐段排版结果按节的版面与分页属性切分为页。长度单位为磅。规则均为 WPS 12.1 实测结果。
 *
 * - 行可容纳的判据：行中文字的底边不超过正文区底边（容差 `FIT_EPSILON`），见 `lineNeed`。多倍行距（倍数大于 1）
 *   在文字下方增加的部分不必容纳在本页：不对齐网格时按行高除以倍数判定，对齐网格时按文字底边判定（文字在行内上下
 *   居中）；含嵌入式对象的行按对象框高度判定；段后间距不必容纳。
 * - 相邻段落之间的距离为上一段段后间距与下一段段前间距中的较大者（不相加）；与网格无关。段落边框占用的高度
 *   （`ParagraphLayout.borderTop`、`borderBottom`）另加在段前间距之后与最后一行之后，下边框须与最后一行一起容纳在本页
 *   （WPS 实测：3 磅三线下边框超出正文区底边时段落移到下一页）。
 * - 位于页首（或栏首）的段落的段前间距见 `topSpacing`。
 * - 孤行控制：段落跨页时本页至少两行、下页至少两行，不满足时整段移到下页；段中不分页的段落不跨页；
 *   与下段同页的段落（可连续多段）与下一段的第一行（下一块为表格时为表格的第一行）不在同一页时，整组移到下页。
 *   正文区为空时以上规则不生效，
 *   避免无法容纳的内容无限换页。
 * - 段内分页符之后的行从下一页开始；分栏符之后的行从下一栏开始，在最后一栏时从下一页开始。
 *   兼容模式 14 及以上，段落以分页符结束（其后没有嵌入式对象）时段落标记留在本页，下一段从下一页开始；
 *   兼容模式低于 14，或该段落结束一节时，段落标记单独占一行移到下一页。
 * - 节：`nextPage` 从新页开始；`continuous` 在当前位置继续，各栏的顶边为当前位置（页面尺寸不同时从新页开始，
 *   页边距不同不换页）；`nextColumn` 从下一栏开始；`evenPage`、`oddPage` 从新页开始，下一页的物理页序号奇偶不符时
 *   先插入一张空白页，但本节或之前任一节设置了页码起始值时不插入（经验规则：重新编号之后的 7 个用例均未插入）。
 *   奇偶页页眉页脚不同且新节第一页的页码与上一页奇偶相同时，同样先插入一张空白页（经验规则：语料中两处
 *   重新编号为 1、上一页页码为 3 的分节均如此）。没有段落的节同样开始新页。
 * - 表格（`../table/layout.ts` 的排版结果）逐行放置：无法容纳的行在行内切开，单元格中能容纳的行留在本页，其余移到下页，
 *   切开的行在续页的部分顶部另占本行的行顶边框，续页开头的整行改占表格上框线的高度；切开处之后没有任何一行时（只余段后
 *   间距等）不切开，整行移到下页。不能跨页的行（`cantSplit`）、固定行高的行与最小行高大于本页剩余空间的行整行移到下页；
 *   切开的最小行高的行在续页的部分不小于最小行高。续页先重复开头的标题行。浮动表格（`tblpPr`）纵向相对文字时自原位置
 *   下移其偏移，标题行不重复（WPS 实测）。
 *   行中段落设置了 `keepNext` 的行与下一行同页（连续多行一起移到下页），这组行已位于该页表格部分的开头时不再移动。
 *   页首仍无法容纳的行按剩余空间切开。本页部分的底边框（以表格的最后一行结束时为表格底边框，否则见 `../table/layout.ts`
 *   的跨页处边框）须与该部分的最后一行一起容纳在本页（WPS 实测：最后一行底边距正文区底边 0.5 磅时，1.5 磅的底边框使该行
 *   移到下页，0.5 磅的不移动；表格未结束时同样）。
 * - 浮动对象：段落的每一部分在一页中放置之前，由调用方的 `anchored` 求出锚定在这一部分（含本页可能放下的行）中的
 *   对象在本页的位置与避让矩形，每个对象在一页中只记录第一次求得的结果（`PageFlow.anchors`）；之后本页的段落经
 *   `wrap` 按本页全部矩形重排（只重排段落的第一部分）。新矩形的顶边不低于锚定段落顶边、且与本页已放置的行重叠时，
 *   本页（栏）从头重排（本页从段落开头开始时；否则只影响其后的行），重排保留本页已记录的对象。
 *   与下段同页的段落组整体移页时，组的起点之后记录的对象随舍弃的页面与内容一起舍弃，在新位置重新求得。
 *   因环绕而下移的行移到下一页时去掉下移的距离。
 */

import type { DocumentLayout, ParagraphLayout } from '../layout.ts'
import type { DocxDocument, Paragraph, ParagraphProps, Section } from '../model.ts'
import type { RowBox, TableLayout } from '../table/layout.ts'
import { pageNumberText } from './number.ts'

/** 行底超出正文区底边不足此值时仍视为可容纳：排版坐标由浮点累加得到。 */
export const FIT_EPSILON = 0.01

/**
 * 判定第 `j` 行能否容纳时自行顶起计入的高度（见文件头）；`strip` 为页首的行去掉的环绕下移距离。
 * 对齐网格的多倍行距按文字底边判定（WPS 12.1 实测：1.5 倍行距、15.6 磅网格的宋体行，10.5 磅时剩余 19 磅留在本页、
 * 18.5 磅移到下一页，12 磅时 19.5 磅留在本页、19 磅移到下一页，与文字底边 18.51、19.48 磅一致）。
 */
export function lineNeed(
  layout: ParagraphLayout,
  props: ParagraphProps,
  j: number,
  strip = 0,
): number {
  const box = layout.objects.get(j)
  if (box !== undefined) return box
  const line = layout.text.lines[j]!
  const grid = layout.gridBottoms.get(j)
  if (grid !== undefined) return (line.skip ?? 0) - strip + grid
  const ls = props.lineSpacing
  const ratio = ls.rule === 'multiple' && ls.value > 1 && !props.snapToGrid ? 1 / ls.value : 1
  return (line.height - strip) * ratio
}

/** 页眉页脚的种类：首页、偶数页与其余页。 */
export type PageKind = 'first' | 'even' | 'default'

/** 正文区的上下边界（页面坐标）。 */
export interface BodyArea {
  readonly top: number
  readonly bottom: number
}

export interface LinePlacement {
  readonly kind: 'paragraph'
  readonly block: number
  /** 本页第一行在整段中的序号。 */
  readonly first: number
  /** 各行行顶（页面坐标），依次对应 `first` 起的各行。 */
  readonly tops: readonly number[]
  /** 段落左缩进处的横坐标（页面坐标）。 */
  readonly x: number
  /** 所用的排版结果（环绕时为按本页重排的结果）。 */
  readonly layout: ParagraphLayout
  /** 第一行之前留出的段前间距（本页第一部分为 0 以外的值时，段落顶边在第一行行顶之上这么多）。 */
  readonly space: number
}

/**
 * 表格在一页中的一行或一行的一部分：`from`、`to` 为各单元格（`RowBox.cells` 的顺序）内容中显示的纵向范围，
 * 相对单元格文字区顶边；整行时为 `0` 与 `Infinity`。
 */
export interface RowSegment {
  readonly row: number
  readonly top: number
  readonly height: number
  readonly from: readonly number[]
  readonly to: readonly number[]
  /** 续页重复的标题行。 */
  readonly repeat: boolean
  /** 续页部分的第一段（不含重复的标题行）：顶边绘制 `TableLayout.pageTop`。 */
  readonly pageTop: boolean
  /** 本段顶边框占用的高度：续页部分开头的整行为 `RowBox.pageBorder`，其余（含切开的行在续页的部分）为 `RowBox.border`。 */
  readonly border: number
}

export interface TablePlacement {
  readonly kind: 'table'
  readonly block: number
  readonly layout: TableLayout
  /** 表格左边（页面坐标）。 */
  readonly x: number
  readonly top: number
  readonly height: number
  readonly segments: readonly RowSegment[]
  /** 本页部分以表格的最后一行结束（绘制底边框）。 */
  readonly end: boolean
}

export type Placement = LinePlacement | TablePlacement

/** 浮动对象的对象框（页面坐标）。 */
export interface ObjectBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 一页中记录的浮动对象：`key` 标识对象，`exclusion` 为避让矩形（不影响环绕的对象为 `null`）。 */
export interface PlacedAnchor {
  readonly key: string
  readonly box: ObjectBox
  readonly exclusion: Exclusion | null
}

export interface PageFlow {
  readonly section: number
  /** 页码值。 */
  readonly number: number
  readonly numberText: string
  readonly kind: PageKind
  readonly area: BodyArea
  /** 补足奇偶而插入的空白页。 */
  readonly blank: boolean
  readonly items: Placement[]
  /** 本页记录的浮动对象，按求得的顺序。 */
  readonly anchors: PlacedAnchor[]
}

/** 浮动对象避让的矩形（页面坐标），已加上距正文的距离。 */
export interface Exclusion {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  /** 上下型：重叠的行下移到矩形下方（见 `overlaps`）。 */
  readonly topAndBottom: boolean
  readonly side: 'bothSides' | 'left' | 'right' | 'largest'
  /** 锚定段落的块下标。 */
  readonly owner: number
}

/** 段落的一部分在一页中放置时的位置：供求浮动对象的位置。 */
export interface AnchorSite {
  readonly section: number
  /** 这一部分的第一行在整段中的序号。 */
  readonly first: number
  /**
   * 相对段落定位的基准：段落的第一部分为段落顶边（上一段的段后间距之下、本段自身的段前间距之上），其余部分为该部分
   * 第一行的行顶。
   */
  readonly top: number
  /** 这一部分第一行的行顶。 */
  readonly lineTop: number
  /** 所在区域（栏）的左边与本页的正文区。 */
  readonly x: number
  readonly area: BodyArea
  readonly layout: ParagraphLayout
}

export interface PaginateOptions {
  /** 正文区：由页眉页脚的高度与页边距决定。 */
  area(section: number, kind: PageKind): BodyArea
  /** 表格排版：区域为所在节的第一栏。 */
  table(block: number): TableLayout
  /**
   * 环绕：段落 `block` 的第一行行顶位于 `top`、区域左边为 `x`、正文区底边为 `bottom` 时按 `exclusions` 重排；
   * 没有影响该段的矩形时返回 `null`。`once` 为真时上下型对象只使行下移一次（求段内对象的定位基准用）。
   * `before` 为第一行之上属于本段的间距（段前间距超出上一段段后间距的部分与段落上边框）：第一行下移到上下型对象下方时
   * 行顶在对象底边之下这么多。
   */
  wrap(
    block: number,
    x: number,
    top: number,
    bottom: number,
    exclusions: readonly Exclusion[],
    once: boolean,
    before: number,
  ): ParagraphLayout | null
  /** 段落 `block` 这一部分中的浮动对象按 `site` 求得的位置与避让矩形。 */
  anchored(block: number, site: AnchorSite): readonly PlacedAnchor[]
  /**
   * 段落的第一部分按 `site` 放置时，锚定在第一行的浮动对象是否要求段落移到下一页（对象随段落移动，见 `build.ts`）。
   */
  mustMove(block: number, site: AnchorSite): boolean
}

/**
 * 段落 `block` 中纵向范围为 [`top`, `bottom`) 的行是否与矩形 `e` 重叠。上下型对象的顶边恰好接触行底时，锚定段落及其后
 * 段落的行同样计入，之前段落的行不计入（WPS 实测：上下型图片相对段落偏移 0 时，上一段末行留在图片上方）。
 */
export function overlaps(e: Exclusion, top: number, bottom: number, block: number): boolean {
  const touching = e.topAndBottom && block >= e.owner
  return (touching ? bottom > e.top - 0.01 : bottom > e.top + 0.01) && top < e.bottom
}

/** 单元格内容中可在其后切开的位置（相对文字区顶边）：段落各行的底边与嵌套表格的底边。 */
function cutPoints(
  items: TableLayout['rows'][number]['cells'][number]['content']['items'],
): number[] {
  const out: number[] = []
  for (const it of items) {
    if (it.kind === 'table') {
      out.push(it.top + it.table.height)
      continue
    }
    for (const line of it.layout.text.lines) out.push(it.top + line.top + line.height)
  }
  return out
}

/**
 * 切开的行在续页部分中的高度（不含顶边框）：各单元格余下的内容加上下边距中的最大者，且不小于最小行高
 * （WPS 实测：最小值 100 磅的行切开后，续页部分余下两行文字时仍高 100 磅）。
 */
function continuedHeight(row: RowBox, from: readonly number[]): number {
  return Math.max(
    row.minimum,
    ...row.cells.map((c, k) => {
      const m = c.cell.margins
      return m.top + Math.max(0, c.content.height - from[k]!) + m.bottom
    }),
  )
}

/** 位于页首或栏首的原因。 */
export type TopReason = 'start' | 'section' | 'pageBreak' | 'pageBreakBefore' | 'column' | 'natural'

/**
 * 页首（栏首）段落的段前间距：文档开头与分节开始时保留；段前分页在兼容模式低于 15 时保留；
 * 自然换页、分页符与分栏符之后为 0。保留时扣除上一段（在上一页）的段后间距：相邻段落的距离取两者中的较大者，
 * 段后间距已计在上一页（WPS 实测：段前 14、上一段段后 2 时为 12；段前 24、段后 10 时为 14）。
 */
export function topSpacing(
  before: number,
  reason: TopReason,
  compatibilityMode: number,
  previousAfter: number,
): number {
  const kept = Math.max(0, before - previousAfter)
  switch (reason) {
    case 'start':
    case 'section':
      return kept
    case 'pageBreakBefore':
      return compatibilityMode >= 15 ? 0 : kept
    default:
      return 0
  }
}

/**
 * 段前分页的段落已位于页首时的原因：分页符或自然换页之后按段前分页处理（WPS 实测：分页符之后带段前分页的标题保留段前间距），
 * 文档开头与分节开始不变。
 */
function withPageBreakBefore(reason: TopReason): TopReason {
  return reason === 'start' || reason === 'section' ? reason : 'pageBreakBefore'
}

/** 由节的页面设置得到各栏的横坐标（页面坐标）。 */
function columnLefts(section: Section): number[] {
  const out: number[] = []
  let x = section.marginLeft + section.gutter
  for (const c of section.columns) {
    out.push(x)
    x += c.width + c.space
  }
  return out
}

/** 段落文字中 `position` 所在行的序号。 */
function lineAt(layout: ParagraphLayout, position: number): number {
  const lines = layout.text.lines
  for (let i = 0; i < lines.length; i++) {
    if (position >= lines[i]!.start && position < lines[i]!.end) return i
  }
  return lines.length - 1
}

/** 段内分页符（`\f`）与分栏符（`\v`）在段落文字（`Paragraph.runs` 依次相接）中的位置。 */
/** 段内分页符与分栏符：段落文字中的位置、所在字段的下标与种类。 */
function breaksOf(p: Paragraph): { offset: number; run: number; kind: 'page' | 'column' }[] {
  const out: { offset: number; run: number; kind: 'page' | 'column' }[] = []
  let offset = 0
  p.runs.forEach((r, run) => {
    for (let i = 0; i < r.text.length; i++) {
      const c = r.text[i]
      if (c === '\f') out.push({ offset: offset + i, run, kind: 'page' })
      else if (c === '\v') out.push({ offset: offset + i, run, kind: 'column' })
    }
    offset += r.text.length
  })
  return out
}

/** 编号字段的长度：段落文字中正文字段的起点。 */
function numberingLength(layout: ParagraphLayout, doc: DocxDocument): number {
  if (layout.runs[0] !== -1) return 0
  const p = doc.body[layout.block]
  if (p === undefined || p.kind !== 'paragraph' || p.numbering === null) return 0
  const n = p.numbering
  return n.text.length + (n.suffix === 'nothing' ? 0 : 1)
}

interface Snapshot {
  readonly pages: number
  readonly items: number
  readonly anchors: number
  readonly column: number
  readonly y: number
  readonly regionTop: number
  readonly empty: boolean
  readonly reason: TopReason
  readonly prevAfter: number
  readonly carriedAfter: number
}

export function paginate(
  doc: DocxDocument,
  layout: DocumentLayout,
  options: PaginateOptions,
): PageFlow[] {
  const byBlock = new Map<number, ParagraphLayout>()
  for (const p of layout.paragraphs) byBlock.set(p.block, p)
  const mode = doc.settings.compatibilityMode
  const evenAndOdd = doc.settings.evenAndOddHeaders

  const pages: PageFlow[] = []
  let section = 0
  /** 当前页所属节的设置；插入空白页时临时取上一节。 */
  let setup: Section = doc.sections[0]!
  let lefts: number[] = [0]
  let column = 0
  let y = 0
  let regionTop = 0
  /** 当前栏中尚未放置内容。 */
  let empty = true
  let reason: TopReason = 'start'
  /** 上一段的段后间距（尚未计入 `y`）。 */
  let prevAfter = 0
  /** 换页（栏）前最后一段的段后间距，供页首段落扣除。 */
  let carriedAfter = 0
  let sectionPages = 0
  let restarted = false
  /** 当前放置的位置：页（栏）开始时记录，供本页从头重排。`table` 为真时位于表格中，不能重排。 */
  let cursor = { block: 0, line: 0, table: false }
  let regionStart: { block: number; line: number; table: boolean; snap: Snapshot } | null = null
  /** 闭包中赋值的变量不参与控制流收窄，经函数读取。 */
  const regionAt = () => regionStart
  const current = (): PageFlow => pages[pages.length - 1]!
  /** 第 `page` 页的避让矩形。 */
  const exclusionsOf = (page: number): Exclusion[] =>
    pages[page]!.anchors.flatMap((a) => (a.exclusion === null ? [] : [a.exclusion]))

  const startPage = (blank: boolean, why: TopReason) => {
    const prev = pages[pages.length - 1]
    const number =
      sectionPages === 0 && setup.numberStart !== null ? setup.numberStart : (prev?.number ?? 0) + 1
    const kind: PageKind =
      sectionPages === 0 && setup.titlePage
        ? 'first'
        : evenAndOdd && number % 2 === 0
          ? 'even'
          : 'default'
    const area = options.area(section, kind)
    pages.push({
      section,
      number,
      numberText: pageNumberText(number, setup.numberFormat),
      kind,
      area,
      blank,
      items: [],
      anchors: [],
    })
    sectionPages++
    column = 0
    regionTop = area.top
    y = area.top
    empty = true
    reason = why
    carriedAfter = prevAfter
    prevAfter = 0
    regionStart = { ...cursor, snap: snapshot() }
  }

  const nextColumn = (why: TopReason) => {
    if (column < lefts.length - 1) {
      column++
      y = regionTop
      empty = true
      reason = why
      carriedAfter = prevAfter
      prevAfter = 0
      regionStart = { ...cursor, snap: snapshot() }
    } else startPage(false, why)
  }

  /**
   * 记录段落 `block` 这一部分中本页尚未记录的对象；返回是否需要本页从头重排。从头重排不清除本页的记录：每次重排都需要
   * 一个本页尚未记录的对象，对象有限，因此重排次数有限。
   */
  const addAnchors = (block: number, site: AnchorSite): boolean => {
    const flow = current()
    let restart = false
    for (const f of options.anchored(block, site)) {
      if (flow.anchors.some((a) => a.key === f.key)) continue
      flow.anchors.push(f)
      if (f.exclusion === null) continue
      if (f.exclusion.top <= site.top + FIT_EPSILON && overlapsPlaced(f.exclusion)) restart = true
    }
    return restart
  }

  /** 本页已放置的行中是否有与矩形 `e` 重叠的行（判据同环绕）。 */
  const overlapsPlaced = (e: Exclusion): boolean => {
    for (const it of current().items) {
      if (it.kind !== 'paragraph') continue
      for (let k = 0; k < it.tops.length; k++) {
        const top = it.tops[k]!
        const bottom = top + it.layout.text.lines[it.first + k]!.height
        if (overlaps(e, top, bottom, it.block)) return true
      }
    }
    return false
  }

  const snapshot = (): Snapshot => ({
    pages: pages.length,
    items: current().items.length,
    anchors: current().anchors.length,
    column,
    y,
    regionTop,
    empty,
    reason,
    prevAfter,
    carriedAfter,
  })

  /** 回到 `s` 的位置（同一页从头重排）：本页已记录的对象保留。 */
  const restore = (s: Snapshot) => {
    sectionPages -= pages.length - s.pages
    pages.length = s.pages
    current().items.length = s.items
    column = s.column
    y = s.y
    regionTop = s.regionTop
    empty = s.empty
    reason = s.reason
    prevAfter = s.prevAfter
    carriedAfter = s.carriedAfter
  }

  /** 舍弃 `s` 之后放置的内容（段落组整体移页）：之后记录的对象一并舍弃。 */
  const discard = (s: Snapshot) => {
    restore(s)
    current().anchors.length = s.anchors
  }

  const beginSection = (index: number) => {
    const s = doc.sections[index]!
    const prevSection = section
    const prevSetup = setup
    section = index
    setup = s
    if (setup.numberStart !== null) restarted = true
    lefts = columnLefts(s)
    if (pages.length === 0) {
      sectionPages = 0
      startPage(false, 'start')
      return
    }
    const prev = doc.sections[prevSection]!
    const sameSize = prev.pageWidth === s.pageWidth && prev.pageHeight === s.pageHeight
    if (setup.start === 'continuous' && sameSize) {
      sectionPages = 1
      column = 0
      regionTop = y
      return
    }
    if (setup.start === 'nextColumn' && sameSize && column < lefts.length - 1) {
      sectionPages = 1
      nextColumn('section')
      return
    }
    sectionPages = 0
    const nextNumber = setup.numberStart ?? current().number + 1
    const oddEven =
      (setup.start === 'evenPage' || setup.start === 'oddPage') &&
      !restarted &&
      ((pages.length + 1) % 2 === 0) !== (setup.start === 'evenPage')
    // 奇偶页页眉页脚不同时，新节第一页的页码与上一页奇偶相同（重新编号所致）则先插入一张空白页。
    const sameParity = evenAndOdd && nextNumber % 2 === current().number % 2
    if (oddEven || sameParity) {
      // 空白页沿用上一节的版面与页码格式。
      const keep = setup
      setup = prevSetup
      section = prevSection
      sectionPages = 1
      startPage(true, 'section')
      section = index
      setup = keep
      sectionPages = 0
    }
    startPage(false, 'section')
  }

  /** 表格逐行放置（见文件头）。 */
  const placeTable = (b: number, t: TableLayout) => {
    y += prevAfter
    prevAfter = 0
    const float = t.table.float
    if (float !== null && float.vertical === 'text') y += float.y
    const header: number[] = []
    if (float === null) for (let r = 0; r < t.rows.length && t.rows[r]!.header; r++) header.push(r)
    let segments: RowSegment[] = []
    let top = y
    /** 本页（栏）的表格部分尚未放置行（标题行重复之外）。 */
    let fresh = empty
    /** 已换页（栏）：本页部分的第一段（未重复标题行时）顶边取 `pageTop`。 */
    let resumed = false
    const whole = (r: number) => t.rows[r]!.cells.map(() => 0)
    const flush = (end: boolean) => {
      if (segments.length > 0)
        current().items.push({
          kind: 'table',
          block: b,
          layout: t,
          x: lefts[column]! + t.x,
          top,
          height: y - top,
          segments,
          end,
        })
      segments = []
    }
    const turn = (r: number) => {
      cursor = { block: b, line: r, table: true }
      flush(false)
      nextColumn('natural')
      top = y
      fresh = true
      resumed = true
      if (r >= header.length) {
        for (const h of header) {
          const row = t.rows[h]!
          segments.push({
            row: h,
            top: y,
            height: row.height,
            from: whole(h),
            to: row.cells.map(() => Number.POSITIVE_INFINITY),
            repeat: true,
            pageTop: false,
            border: row.border,
          })
          y += row.height
        }
      }
    }
    /** 本页（栏）表格部分的第一行（不含重复的标题行）与各行放置前的状态。 */
    let pageFirst = 0
    const saved: { segments: number; y: number; fresh: boolean }[] = []
    for (let r = 0; r < t.rows.length; r++) {
      const row = t.rows[r]!
      /** 各单元格已在前页显示到的位置。 */
      let from = whole(r)
      for (;;) {
        // 每次放置前记录：换页后再次放置同一行时，记录的是新部分中的状态。
        saved[r] = { segments: segments.length, y, fresh }
        const pageTop = resumed && segments.length === 0
        const continued = from.some((v) => v > 0)
        // WPS 实测：续页开头的整行下移表格上框线的高度；切开的行在续页的部分只占本行的行顶边框，顶部同样绘制上框线。
        const border = pageTop && !continued ? row.pageBorder : row.border
        const rest = continued
          ? border + continuedHeight(row, from)
          : row.rule === 'exact'
            ? row.height
            : row.height - row.border + border
        const bottom = current().area.bottom
        if (y + rest + row.pageBottomBorder <= bottom + FIT_EPSILON) {
          segments.push({
            row: r,
            top: y,
            height: rest,
            from,
            to: row.cells.map(() => Number.POSITIVE_INFINITY),
            repeat: false,
            pageTop,
            border,
          })
          y += rest
          fresh = false
          break
        }
        // 与下一行同页的行（行中段落设置了 keepNext）：连续的这类行与本行一起移到下一页。这组行已位于本页（栏）
        // 表格部分的开头时不再移动，本行按普通行放置：移动后这组行即位于新部分的开头，再次移动不能使其与本行同页。
        let start = r
        while (start > pageFirst && t.rows[start - 1]!.keepNext) start--
        if (start < r && !from.some((v) => v > 0) && !saved[start]!.fresh) {
          const s = saved[start]!
          segments.length = s.segments
          y = s.y
          fresh = s.fresh
          r = start
          turn(r)
          pageFirst = r
          r--
          break
        }
        // 最小行高大于本页剩余空间的行整行移到下页（WPS 实测：最小值 160 磅、剩余 137.9 磅时内容可以切开也整行移动；
        // 最小值 100 磅时切开）。
        const minimumFits = y + border + row.minimum + row.pageBottomBorder <= bottom + FIT_EPSILON
        const splittable = !row.cantSplit && row.rule !== 'exact' && minimumFits
        if (!splittable && !fresh) {
          turn(r)
          pageFirst = r
          continue
        }
        // 行内切开：各单元格留下底边不超过本页正文区底边的行。
        const room = bottom - y - border - row.pageBottomBorder
        const cuts = row.cells.map((c) => cutPoints(c.content.items))
        const to = row.cells.map((c, k) => {
          const avail = room - c.cell.margins.top + from[k]!
          let cut = from[k]!
          for (const p of cuts[k]!) if (p <= avail + FIT_EPSILON && p > cut) cut = p
          return cut
        })
        // 切开处之后没有任何一行时不切开：只有段后间距等留到下页的行整行移到下页（WPS 实测：单元格中一行文字可以容纳、
        // 其后 10 磅段后间距超出正文区底边时整行移动）。
        const placed =
          to.some((v, k) => v > from[k]!) &&
          cuts.some((list, k) => list.some((p) => p > to[k]! + FIT_EPSILON))
        if (!placed && !fresh) {
          turn(r)
          pageFirst = r
          continue
        }
        if (!placed) {
          // 页首仍无法切开：整行放在本页，超出部分不显示。
          segments.push({
            row: r,
            top: y,
            height: Math.max(0, bottom - y),
            from,
            to: row.cells.map(() => Number.POSITIVE_INFINITY),
            repeat: false,
            pageTop,
            border,
          })
          y = Math.max(y, bottom)
          fresh = false
          break
        }
        const used =
          border + Math.max(...row.cells.map((c, k) => c.cell.margins.top + to[k]! - from[k]!))
        segments.push({ row: r, top: y, height: used, from, to, repeat: false, pageTop, border })
        y += used
        from = to
        turn(r)
        pageFirst = r
      }
      empty = false
    }
    y += t.bottom
    flush(true)
  }

  /** 与下段同页的段落组：起点之前的状态与组内第一段。 */
  let keepChain: { snap: Snapshot; block: number } | null = null
  let sectionIndex = -1
  /** 依次开始各节直到第 `target` 节（含没有段落的节）。 */
  const enter = (target: number) => {
    while (sectionIndex < target) {
      sectionIndex++
      beginSection(sectionIndex)
      keepChain = null
    }
  }

  blocks: for (let b = 0; b < doc.body.length; b++) {
    const block = doc.body[b]!
    cursor = { block: b, line: 0, table: false }
    if (block.section !== sectionIndex) enter(block.section)
    const before = snapshot()
    const firstPage = pages.length - 1

    if (block.kind === 'table') {
      placeTable(b, options.table(b))
      // 与下段同页的段落之后是表格时，与表格的第一行同页。
      if (
        keepChain !== null &&
        placedFrom(pages, b, firstPage) > firstPage &&
        !keepChain.snap.empty
      ) {
        const chain = keepChain
        keepChain = null
        discard(chain.snap)
        cursor = { block: chain.block, line: 0, table: false }
        nextColumn('natural')
        b = chain.block - 1
        continue
      }
      keepChain = null
      continue
    }

    const initial = byBlock.get(b)
    if (initial === undefined) continue
    let lay = initial
    const pf = block.props
    const breaks = breaksOf(block)
    const endsSection = doc.body[b + 1]?.section !== block.section
    // 嵌入式对象之后的文字另起字段（见 `../parse/body.ts`）：位于最后一个分页符所在字段之后的对象在分页符之后。
    const lastBreak = breaks.reduce((m, br) => Math.max(m, br.run), -1)
    const objectAfter = block.images.some((im) => im.run > lastBreak)
    let n = 0
    let forced = new Map<number, 'page' | 'column'>()
    /** 段落以分页符结束且段落标记留在本页：下一段从新页开始。 */
    let breakAfter = false
    /** 按排版结果确定行数与段内分页符、分栏符所在的行。 */
    const prepare = (l: ParagraphLayout) => {
      lay = l
      n = l.text.lines.length
      forced = new Map()
      const offset = numberingLength(l, doc)
      for (const br of breaks) forced.set(lineAt(l, br.offset + offset), br.kind)
      const last = l.text.lines[n - 1]
      breakAfter =
        mode >= 14 &&
        !endsSection &&
        !objectAfter &&
        n >= 2 &&
        last!.start === last!.end &&
        forced.get(n - 2) === 'page'
      if (breakAfter) {
        forced.delete(n - 2)
        n -= 1
      }
    }
    prepare(initial)
    if (pf.pageBreakBefore) {
      if (!(empty && current().items.length === 0)) startPage(false, 'pageBreakBefore')
      else reason = withPageBreakBefore(reason)
    }

    let i = 0
    let laidPage = -1
    while (i < n) {
      const page = current()
      const space =
        i > 0
          ? 0
          : lay.borderTop +
            (empty
              ? topSpacing(lay.spaceBefore, reason, mode, carriedAfter)
              : Math.max(prevAfter, lay.spaceBefore))
      const top = y + space
      // 上一段的段后间距之下为本段顶边：相对段落的对象以此为基准，下移到上下型对象之下时其余间距另加在对象底边之下。
      const own = i > 0 || empty ? space : space - prevAfter
      if (i === 0 && laidPage !== pages.length - 1) {
        const site = {
          section: block.section,
          first: 0,
          top: top - own,
          lineTop: top,
          x: lefts[column]!,
          area: page.area,
          layout: initial,
        }
        if (!empty && options.mustMove(b, site)) {
          cursor = { block: b, line: 0, table: false }
          nextColumn('natural')
          continue
        }
        const pageIndex = pages.length - 1
        // 段内对象的位置按本页已有对象环绕后的段落位置求得（不计段内对象本身）。
        const others = exclusionsOf(pageIndex)
        const moved =
          block.anchors.length > 0 && others.length > 0
            ? (options.wrap(b, lefts[column]!, top, page.area.bottom, others, true, own)?.text
                .lines[0]?.skip ?? 0)
            : 0
        const restart = addAnchors(b, {
          section: block.section,
          first: 0,
          top: top - own + moved,
          lineTop: top + moved,
          x: lefts[column]!,
          area: page.area,
          layout: initial,
        })
        const from = regionAt()
        if (restart && from !== null && !from.table && from.line === 0) {
          restore(from.snap)
          keepChain = null
          b = from.block - 1
          continue blocks
        }
        laidPage = pageIndex
        const list = exclusionsOf(pageIndex)
        prepare(options.wrap(b, lefts[column]!, top, page.area.bottom, list, false, own) ?? initial)
      } else if (i > 0) {
        addAnchors(b, {
          section: block.section,
          first: i,
          top,
          lineTop: top,
          x: lefts[column]!,
          area: page.area,
          layout: lay,
        })
      }
      const lines = lay.text.lines
      /** 页首的行去掉环绕造成的下移。 */
      const strip = (j: number) => (j === i && i > 0 ? (lines[j]!.skip ?? 0) : 0)
      let fit = 0
      let bottom = top
      let stop = n
      for (let j = i; j < n; j++) {
        const border = j === lines.length - 1 ? lay.borderBottom : 0
        const need = lineNeed(lay, block.props, j, strip(j)) + border
        if (bottom + need > page.area.bottom + FIT_EPSILON) break
        bottom += lines[j]!.height - strip(j)
        fit++
        if (forced.has(j)) {
          stop = j + 1
          break
        }
      }
      const rest = stop - i
      let k = fit
      if (k < rest && !empty) {
        if (pf.keepLines && i === 0) k = 0
        else if (pf.widowControl) {
          if (rest - k === 1) k--
          if (i === 0 && k < 2) k = 0
          k = Math.max(0, k)
        }
      }
      if (k === 0) {
        if (empty) k = Math.max(1, fit)
        else {
          cursor = { block: b, line: i, table: false }
          nextColumn('natural')
          continue
        }
      }
      const tops: number[] = []
      let ly = top
      for (let j = i; j < i + k; j++) {
        tops.push(ly - strip(j))
        ly += lines[j]!.height - strip(j)
      }
      page.items.push({
        kind: 'paragraph',
        block: b,
        first: i,
        tops,
        x: lefts[column]! + lay.left,
        layout: lay,
        space,
      })
      y = ly
      empty = false
      prevAfter = 0
      i += k
      cursor = i < n ? { block: b, line: i, table: false } : { block: b + 1, line: 0, table: false }
      const kind = forced.get(i - 1)
      if (kind === 'page') startPage(false, 'pageBreak')
      else if (kind === 'column') nextColumn('column')
      else if (i < n) nextColumn('natural')
    }
    y += lay.borderBottom
    prevAfter = lay.spaceAfter
    cursor = { block: b + 1, line: 0, table: false }
    if (breakAfter) startPage(false, 'pageBreak')

    // 与下段同页：上一段（组）设置了 keepNext，本段第一行却不在组的最后一页时，整组移到下一页（栏）。
    if (
      keepChain !== null &&
      placedFrom(pages, b, firstPage) > firstPage &&
      !keepChain.snap.empty
    ) {
      const chain = keepChain
      keepChain = null
      discard(chain.snap)
      cursor = { block: chain.block, line: 0, table: false }
      nextColumn('natural')
      b = chain.block - 1
      continue
    }
    if (pf.keepNext) keepChain ??= { snap: before, block: b }
    else keepChain = null
  }
  enter(doc.sections.length - 1)
  return pages
}

/** 段落 `block` 第一部分所在页的下标（自 `from` 起查找）。 */
function placedFrom(pages: readonly PageFlow[], block: number, from: number): number {
  for (let p = from; p < pages.length; p++) {
    if (pages[p]!.items.some((it) => it.block === block)) return p
  }
  return pages.length - 1
}
