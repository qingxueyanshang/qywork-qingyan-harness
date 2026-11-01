/**
 * docx 分页与页面绘制。覆盖 `paginate.ts`（行可容纳的判据、相邻段间距、页首段前间距、段内分页符与分栏符、
 * 孤行控制、段中不分页、与下段同页、分节类型、奇偶页空白页、分栏、表格的逐行放置、行内切开、标题行重复、
 * 不能跨页的行与同页的行、页码与页面种类）、`number.ts`（页码格式）、`build.ts`（`partRef` 页眉页脚的沿用、
 * `requiredFonts`、独占一行的嵌入式图片的横向位置、未绘制图片的计数）、`../render/paint.ts`（逐字取整定位、
 * 点阵模式、`pageImages`）与 `../render/fonts.ts`（字形登记）。
 *
 * 期望值取自 WPS 12.1 只读打开构造文档后逐段取得的所在页与垂直位置（`Range.Information(3)`、`Information(6)`）。
 * 文档由 XML 解析得到；分页用例的排版结果按给定行高构造，不读取字体。分页属性写在 XML 中，或由 `tweak` 改写模型字段。
 * 嵌入式图片的用例读取本机 Windows 字体目录中的宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import type { BitmapGlyph, EmbeddedBitmaps } from '../../font/index.ts'
import type { TextBlock, TextFragment, TextLine } from '../../text/index.ts'
import {
  type DocumentSettings,
  type DocxDocument,
  type ParagraphProps,
  parseDocx,
  type Section,
} from '../index.ts'
import type { DocumentLayout, ParagraphLayout } from '../layout.ts'
import { type DocxFace, DocxFonts, loadDocxFace } from '../render/fonts.ts'
import { pageImages, paintPage } from '../render/paint.ts'
import type { CellBox, RowBox, TableLayout } from '../table/layout.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { layoutPages, partRef, requiredFonts } from './build.ts'
import type { Page } from './model.ts'
import { pageNumberText } from './number.ts'
import {
  type PageFlow,
  type PaginateOptions,
  paginate,
  type TablePlacement,
  topSpacing,
} from './paginate.ts'

/** A4，上下边距 72 磅：正文区为 72–769.9 磅。 */
const SECT = (extra = '') =>
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" ` +
  `w:header="851" w:footer="992" w:gutter="0"/>${extra}</w:sectPr>`
const BOTTOM = 841.9 - 72
const COMPAT14 =
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="14"/></w:compat>'

async function doc(body: string, settings = COMPAT14): Promise<DocxDocument> {
  const result = await parseDocx(buildDocx({ body, settings }))
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

/** 改写模型字段：段落属性（缺省关闭孤行控制）、段落文字（单个字段）、节与设置。 */
function tweak(
  d: DocxDocument,
  over: {
    props?: (b: number) => Partial<ParagraphProps>
    text?: (b: number) => string | null
    section?: (s: number) => Partial<Section>
    settings?: Partial<DocumentSettings>
  } = {},
): DocxDocument {
  return {
    ...d,
    settings: { ...d.settings, ...over.settings },
    sections: d.sections.map((s, i) => ({ ...s, ...over.section?.(i) })),
    body: d.body.map((b, i) => {
      if (b.kind !== 'paragraph') return b
      const text = over.text?.(i) ?? null
      return {
        ...b,
        props: { ...b.props, widowControl: false, ...over.props?.(i) },
        runs: text === null ? b.runs : [{ ...b.runs[0]!, text }],
      }
    }),
  }
}

function line(start: number, end: number, top: number, height: number): TextLine {
  return {
    start,
    end,
    top,
    height,
    baseline: top + height * 0.8,
    left: 0,
    width: 0,
    origin: 0,
    limit: 0,
    fragments: [],
    forcedBreak: false,
  }
}

/**
 * 按各段行高构造排版结果，第 k 行覆盖段落文字的第 k 个字符；`spacing` 为各段的段前段后间距，
 * `objects` 为各段第一行中嵌入式对象框的高度。
 */
function layout(
  heights: readonly (readonly number[])[],
  spacing: readonly (readonly [number, number])[] = [],
  blocks: readonly number[] = heights.map((_, i) => i),
  objects: Readonly<Record<number, number>> = {},
): DocumentLayout {
  const paragraphs: ParagraphLayout[] = heights.map((hs, i) => {
    let top = 0
    const lines = hs.map((h, k) => {
      const l = line(k, k + 1, top, h)
      top += h
      return l
    })
    const text: TextBlock = { lines, height: top }
    const [before, after] = spacing[i] ?? [0, 0]
    return {
      block: blocks[i]!,
      left: 0,
      width: 400,
      spaceBefore: before,
      spaceAfter: after,
      text,
      runs: [],
      objects: new Map(objects[blocks[i]!] === undefined ? [] : [[0, objects[blocks[i]!]!]]),
      imageLines: [],
    }
  })
  return { paragraphs, missingFonts: [] }
}

/** 表格的一行：一个单元格，内容为行高给出的若干行（`lines` 缺省时一行占满行高）。 */
interface RowSpec {
  readonly height: number
  readonly header?: boolean
  readonly cantSplit?: boolean
  readonly keepNext?: boolean
  readonly lines?: readonly number[]
}

/** 按各行构造表格排版结果：一列，单元格边距与边框为 0。 */
function tableOf(rows: readonly RowSpec[]): TableLayout {
  const boxes: RowBox[] = rows.map((r) => {
    const heights = r.lines ?? [r.height]
    const lay = layout([heights]).paragraphs[0]!
    const cell: CellBox = {
      cell: { margins: { left: 0, top: 0, right: 0, bottom: 0 } } as CellBox['cell'],
      col: 0,
      span: 1,
      rowSpan: 1,
      x: 0,
      width: 100,
      content: {
        items: [
          { kind: 'paragraph', block: 0, paragraph: {} as never, layout: lay, top: 0, space: 0 },
        ],
        height: lay.text.height,
      },
    }
    return {
      height: r.height,
      border: 0,
      rule: 'auto',
      header: r.header ?? false,
      cantSplit: r.cantSplit ?? false,
      keepNext: r.keepNext ?? false,
      cells: [cell],
    }
  })
  return {
    table: {} as TableLayout['table'],
    x: 0,
    width: 100,
    columns: [0, 100],
    rows: boxes,
    bottom: 0,
    height: boxes.reduce((a, r) => a + r.height, 0),
    horizontal: [],
    vertical: [],
  }
}

const AREA = { top: 72, bottom: BOTTOM }
const options = (tables: Record<number, TableLayout> = {}): PaginateOptions => ({
  area: () => AREA,
  table: (b: number) => tables[b] ?? tableOf([{ height: 0 }]),
  wrap: () => null,
  anchored: () => [],
  mustMove: () => false,
})

/** 每段第一部分所在页（从 1 起）与行顶。 */
function where(
  pages: readonly PageFlow[],
): Map<number, { page: number; top: number; lines: number }> {
  const out = new Map<number, { page: number; top: number; lines: number }>()
  pages.forEach((pg, i) => {
    for (const it of pg.items) {
      if (out.has(it.block)) continue
      out.set(it.block, {
        page: i + 1,
        top: it.kind === 'paragraph' ? it.tops[0]! : it.top,
        lines: it.kind === 'paragraph' ? it.tops.length : 0,
      })
    }
  })
  return out
}

function paras(n: number, text = 'x'): string {
  return Array.from({ length: n }, () => p(r(text))).join('')
}

describe('paginate：行与段距', () => {
  test('行底不超过正文区底边即可容纳，段后间距不必容纳（WPS：段后 30 磅的第 34 行仍在本页）', async () => {
    const d = tweak(await doc(paras(36) + SECT()))
    const heights = Array.from({ length: 36 }, () => [20])
    const sp = heights.map((_, i): [number, number] => [0, i === 33 ? 30 : 0])
    const w = where(paginate(d, layout(heights, sp), options()))
    expect(w.get(33)).toEqual({ page: 1, top: 732, lines: 1 })
    expect(w.get(34)).toEqual({ page: 2, top: 72, lines: 1 })
  })

  test('相邻段落的距离为段后与段前中的较大者（30/14 → 30，10/14 → 14，14/14 → 14）', async () => {
    const d = tweak(await doc(paras(6) + SECT()))
    const sp: [number, number][] = [
      [0, 30],
      [14, 10],
      [14, 14],
      [14, 0],
      [0, 0],
      [0, 0],
    ]
    const heights = Array.from({ length: 6 }, () => [20])
    const w = where(paginate(d, layout(heights, sp), options()))
    expect(w.get(1)!.top).toBe(72 + 20 + 30)
    expect(w.get(2)!.top).toBe(122 + 20 + 14)
    expect(w.get(3)!.top).toBe(156 + 20 + 14)
  })

  test('多倍行距在文字下方增加的部分不必容纳：1.5 倍的行按行高除以倍数判定', async () => {
    const d = tweak(
      await doc(
        p(r('a'), '<w:spacing w:line="400" w:lineRule="exact"/>') +
          p(r('b'), '<w:spacing w:line="360" w:lineRule="auto"/>') +
          SECT(),
      ),
    )
    // 第一段占到 743，第二段 1.5 倍行高 29.175：整行越过底边 3.3 磅，文字部分（19.45）可容纳。
    const w = where(paginate(d, layout([[671], [29.175]]), options()))
    expect(w.get(1)!.page).toBe(1)
  })

  test('含嵌入式对象的行按对象框高度判定：1.5 倍行距的图片行不按行高除以倍数', async () => {
    const d = tweak(
      await doc(
        p(r('a'), '<w:spacing w:line="400" w:lineRule="exact"/>') +
          p('', '<w:spacing w:line="360" w:lineRule="auto"/>') +
          SECT(),
      ),
    )
    // 图片框 228 磅、行高 235.8 磅，自 560 起：行高除以倍数可容纳，对象框越过底边。
    const w = where(paginate(d, layout([[488], [235.8]], [], undefined, { 1: 228 }), options()))
    expect(w.get(1)).toEqual({ page: 2, top: 72, lines: 1 })
  })
})

describe('paginate：页首段前间距', () => {
  test('topSpacing：文档开头与分节保留；段前分页在兼容模式 15 为 0、14 保留；自然换页与分页符之后为 0', () => {
    expect(topSpacing(14, 'start', 15, 0)).toBe(14)
    expect(topSpacing(14, 'section', 15, 0)).toBe(14)
    expect(topSpacing(14, 'pageBreakBefore', 14, 0)).toBe(14)
    expect(topSpacing(14, 'pageBreakBefore', 15, 0)).toBe(0)
    expect(topSpacing(14, 'pageBreak', 14, 0)).toBe(0)
    expect(topSpacing(14, 'natural', 14, 0)).toBe(0)
  })

  test('topSpacing：保留时扣除上一页最后一段的段后间距（段前 14、段后 2 → 12；段前 24、段后 10 → 14）', () => {
    expect(topSpacing(14, 'pageBreakBefore', 14, 2)).toBe(12)
    expect(topSpacing(24, 'section', 14, 10)).toBe(14)
    expect(topSpacing(6, 'section', 14, 10)).toBe(0)
  })

  test('自然换页到页首的段落不留段前间距', async () => {
    const d = tweak(await doc(paras(36) + SECT()))
    const heights = Array.from({ length: 36 }, () => [20])
    const sp = heights.map((_, i): [number, number] => [i === 34 ? 14 : 0, 0])
    const w = where(paginate(d, layout(heights, sp), options()))
    expect(w.get(33)!.page).toBe(1)
    expect(w.get(34)).toEqual({ page: 2, top: 72, lines: 1 })
  })

  test('段前分页（XML 中的 pageBreakBefore）：兼容模式 14 保留段前间距，15 为 0', async () => {
    const body = p(r('a')) + p(r('b'), '<w:pageBreakBefore/>') + p(r('c')) + SECT()
    const lay = layout(
      [[20], [20], [20]],
      [
        [0, 0],
        [14, 0],
        [0, 0],
      ],
    )
    const flow = async (mode: number) =>
      where(
        paginate(tweak(await doc(body), { settings: { compatibilityMode: mode } }), lay, options()),
      )
    expect((await flow(14)).get(1)).toEqual({ page: 2, top: 86, lines: 1 })
    expect((await flow(15)).get(1)).toEqual({ page: 2, top: 72, lines: 1 })
  })
})

describe('paginate：分页符与分栏符', () => {
  test('段中分页符（XML 中的 w:br type=page）之后的行从下一页页首开始', async () => {
    const d = tweak(await doc(p(`${r('a')}<w:r><w:br w:type="page"/></w:r>${r('b')}`) + SECT()))
    const pages = paginate(d, layout([[20, 20, 20]]), options())
    expect(pages.length).toBe(2)
    expect(pages[1]!.items[0]).toMatchObject({ first: 2, tops: [72] })
  })

  test('兼容模式 14：段落以分页符结束时段落标记留在本页，下一段从新页开始且不留段前间距', async () => {
    const d = tweak(await doc(paras(2) + SECT()), { text: (b) => (b === 0 ? '\f' : null) })
    const lay = layout(
      [[20, 12.05], [20]],
      [
        [0, 0],
        [20, 0],
      ],
    )
    const pages = paginate(
      d,
      { ...lay, paragraphs: [emptyLast(lay.paragraphs[0]!), lay.paragraphs[1]!] },
      options(),
    )
    expect(pages[0]!.items[0]).toMatchObject({ tops: [72] })
    expect(where(pages).get(1)).toEqual({ page: 2, top: 72, lines: 1 })
  })

  test('兼容模式 0：分页符之后的段落标记单独占一行移到下一页，下一段在其后并保留段前间距', async () => {
    const d = tweak(await doc(paras(2) + SECT(), ''), { text: (b) => (b === 0 ? '\f' : null) })
    const lay = layout(
      [[20, 12.05], [20]],
      [
        [0, 0],
        [20, 0],
      ],
    )
    const pages = paginate(
      d,
      { ...lay, paragraphs: [emptyLast(lay.paragraphs[0]!), lay.paragraphs[1]!] },
      options(),
    )
    expect(pages[1]!.items[0]).toMatchObject({ block: 0, first: 1, tops: [72] })
    expect(where(pages).get(1)).toEqual({ page: 2, top: 72 + 12.05 + 20, lines: 1 })
  })

  test('两栏时分栏符之后从第二栏顶部开始', async () => {
    const two = tweak(await doc(paras(1) + SECT('<w:cols w:num="2" w:space="425"/>')), {
      text: () => '\v',
    })
    const pages = paginate(two, layout([[20, 20]]), options())
    expect(pages.length).toBe(1)
    expect(pages[0]!.items[1]).toMatchObject({ first: 1, tops: [72] })
    expect((pages[0]!.items[1] as { x: number }).x).toBeGreaterThan(
      (pages[0]!.items[0] as { x: number }).x,
    )
  })
})

/** 把最后一行改为不含字符的段落标记行。 */
function emptyLast(lay: ParagraphLayout): ParagraphLayout {
  const lines = lay.text.lines.map((l, i, all) =>
    i === all.length - 1 ? { ...l, start: i, end: i } : l,
  )
  return { ...lay, text: { ...lay.text, lines } }
}

describe('paginate：孤行控制、段中不分页与与下段同页', () => {
  /** 前 `n` 段各占一行（20 磅），其后为一段 `lines` 行的段落。 */
  async function tail(n: number, lines: number, props: Partial<ParagraphProps>) {
    const d = tweak(await doc(paras(n + 1) + SECT()), { props: (b) => (b === n ? props : {}) })
    const heights = [
      ...Array.from({ length: n }, () => [20]),
      Array.from({ length: lines }, () => 20),
    ]
    return paginate(d, layout(heights), options())
  }

  test('孤行控制：3 行段落本页只能容纳 1 行或 2 行时整段移到下页', async () => {
    expect(where(await tail(33, 3, { widowControl: true })).get(33)).toMatchObject({
      page: 2,
      lines: 3,
    })
    expect(where(await tail(32, 3, { widowControl: true })).get(32)).toMatchObject({
      page: 2,
      lines: 3,
    })
  })

  test('孤行控制：4 行段落本页能容纳 3 行时本页 2 行、下页 2 行', async () => {
    const pages = await tail(31, 4, { widowControl: true })
    expect(pages[0]!.items.at(-1)).toMatchObject({ block: 31, first: 0, tops: [692, 712] })
    expect(pages[1]!.items[0]).toMatchObject({ block: 31, first: 2 })
  })

  test('关闭孤行控制时按可容纳的行数切开', async () => {
    const pages = await tail(33, 3, {})
    expect(pages[0]!.items.at(-1)).toMatchObject({ block: 33, tops: [732] })
  })

  test('段中不分页：无法容纳时整段移到下页', async () => {
    expect(where(await tail(31, 4, { keepLines: true })).get(31)).toMatchObject({
      page: 2,
      lines: 4,
    })
  })

  test('与下段同页（XML 中的 keepNext）：两段标题与下一段第一行不在同一页时一起移到下页', async () => {
    const body =
      paras(32) + p(r('h'), '<w:keepNext/>') + p(r('h'), '<w:keepNext/>') + paras(1) + SECT()
    const parsed = await doc(body)
    expect(parsed.body.map((b) => b.kind === 'paragraph' && b.props.keepNext)[32]).toBe(true)
    const d = tweak(parsed, { props: (b) => (b === 34 ? { widowControl: true } : {}) })
    const heights = [...Array.from({ length: 34 }, () => [20]), [20, 20, 20]]
    const w = where(paginate(d, layout(heights), options()))
    expect(w.get(32)).toEqual({ page: 2, top: 72, lines: 1 })
    expect(w.get(34)!.page).toBe(2)
  })

  test('与下段同页的段落已在页首时不再移动', async () => {
    const d = tweak(await doc(paras(2) + SECT()), { props: (b) => ({ keepNext: b === 0 }) })
    const w = where(paginate(d, layout([[700], [20]]), options()))
    expect(w.get(0)!.page).toBe(1)
    expect(w.get(1)!.page).toBe(2)
  })
})

describe('paginate：分节', () => {
  test('连续分节（XML 中的 w:type）在当前位置继续；下一页分节从新页开始', async () => {
    const d = tweak(
      await doc(
        p(r('a'), SECT()) + p(r('b'), SECT('<w:type w:val="continuous"/>')) + p(r('c')) + SECT(),
      ),
    )
    expect(d.sections.map((s) => s.start)).toEqual(['nextPage', 'continuous', 'nextPage'])
    const w = where(paginate(d, layout([[20], [20], [20]]), options()))
    expect(w.get(1)).toEqual({ page: 1, top: 92, lines: 1 })
    expect(w.get(2)).toEqual({ page: 2, top: 72, lines: 1 })
  })

  test('偶数页分节：下一页为奇数页时先插入空白页；之前有重新编号的节时不插入', async () => {
    const d = await doc(p(r('a'), SECT()) + p(r('b'), SECT()) + p(r('c')) + SECT())
    const even = (s: number): Partial<Section> => ({ start: s === 0 ? 'nextPage' : 'evenPage' })
    const plain = paginate(tweak(d, { section: even }), layout([[20], [20], [20]]), options())
    expect(plain.map((pg) => pg.blank)).toEqual([false, false, true, false])
    const restarted = paginate(
      tweak(d, { section: (s) => ({ ...even(s), numberStart: s === 1 ? 3 : null }) }),
      layout([[20], [20], [20]]),
      options(),
    )
    expect(restarted.map((pg) => pg.blank)).toEqual([false, false, false])
  })

  test('奇偶页页眉页脚不同时，新节第一页的页码与上一页奇偶相同则先插入空白页', async () => {
    const d = tweak(await doc(p(r('a'), SECT()) + p(r('b')) + SECT('<w:pgNumType w:start="1"/>')), {
      settings: { evenAndOddHeaders: true },
    })
    const pages = paginate(d, layout([[20], [20]]), options())
    expect(pages.map((pg) => [pg.number, pg.blank])).toEqual([
      [1, false],
      [2, true],
      [1, false],
    ])
  })

  test('页码按节的格式与起始值；首页与偶数页的种类', async () => {
    const d = tweak(
      await doc(
        paras(70) + SECT('<w:pgNumType w:fmt="upperRoman" w:start="3"/><w:titlePg/>'),
        `${COMPAT14}<w:evenAndOddHeaders/>`,
      ),
    )
    const pages = paginate(d, layout(Array.from({ length: 70 }, () => [20])), options())
    expect(pages.map((pg) => [pg.numberText, pg.kind])).toEqual([
      ['III', 'first'],
      ['IV', 'even'],
      ['V', 'default'],
    ])
  })

  test('没有段落的节同样开始新页', async () => {
    const d = tweak(await doc(p(r('a'), SECT()) + SECT()))
    expect(paginate(d, layout([[20]]), options()).length).toBe(2)
  })

  test('pageNumberText：未实现的格式按十进制显示', () => {
    expect(pageNumberText(12, 'decimal')).toBe('12')
    expect(pageNumberText(4, 'lowerRoman')).toBe('iv')
    expect(pageNumberText(5, 'numberInDash')).toBe('- 5 -')
    expect(pageNumberText(7, 'noSuchFormat')).toBe('7')
  })
})

describe('paginate：表格', () => {
  const TABLE = '<w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>'
  const parts = (pages: readonly PageFlow[]) =>
    pages.flatMap((pg, i) =>
      pg.items
        .filter((it): it is TablePlacement => it.kind === 'table')
        .map((it) => ({ page: i + 1, it })),
    )

  test('无法容纳的行移到下一页，续页先重复标题行（WPS：续页顶部为标题行，其后接着放其余各行）', async () => {
    const d = tweak(await doc(`${p(r('a'))}${TABLE}${p(r('b'))}${SECT()}`))
    const rows = [
      { height: 30, header: true },
      ...Array.from({ length: 30 }, () => ({ height: 40 })),
    ]
    const pages = paginate(d, layout([[20], [20]], [], [0, 2]), options({ 1: tableOf(rows) }))
    const [first, second] = parts(pages)
    // 本页 72+20 起放标题行与 16 行（30 + 16×40 = 670），续页先占 30 磅标题行。
    expect([first!.page, first!.it.top, first!.it.height, first!.it.end]).toEqual([
      1,
      92,
      670,
      false,
    ])
    expect([second!.page, second!.it.top, second!.it.height, second!.it.end]).toEqual([
      2,
      72,
      30 + 14 * 40,
      true,
    ])
    expect(second!.it.segments[0]).toMatchObject({ row: 0, repeat: true })
    expect(second!.it.segments[1]).toMatchObject({ row: 17, top: 102, repeat: false })
  })

  test('行内切开：单元格中底边不超过正文区底边的行留在本页，其余行在下一页接着显示', async () => {
    const d = tweak(await doc(`${p(r('a'))}${TABLE}${p(r('b'))}${SECT()}`))
    const lines = Array.from({ length: 40 }, () => 20)
    const t = tableOf([{ height: 800, lines }])
    const [first, second] = parts(paginate(d, layout([[20], [20]], [], [0, 2]), options({ 1: t })))
    // 72+20 起可容纳 33 行（660 磅）；下页显示其余 7 行。
    expect(first!.it.segments).toEqual([
      { row: 0, top: 92, height: 660, from: [0], to: [660], repeat: false },
    ])
    expect(second!.it.segments).toEqual([
      { row: 0, top: 72, height: 140, from: [660], to: [Number.POSITIVE_INFINITY], repeat: false },
    ])
  })

  test('不能跨页的行与固定行高的行整行移到下一页', async () => {
    const d = tweak(await doc(`${p(r('a'))}${TABLE}${p(r('b'))}${SECT()}`))
    const t = tableOf([{ height: 600 }, { height: 200, cantSplit: true, lines: [100, 100] }])
    const [first, second] = parts(paginate(d, layout([[20], [20]], [], [0, 2]), options({ 1: t })))
    expect(first!.it.segments.map((g) => g.row)).toEqual([0])
    expect([second!.page, second!.it.segments[0]!.row, second!.it.top]).toEqual([2, 1, 72])
  })

  test('与下一行同页的行（行中段落设置了 keepNext）与下一行一起移到下一页', async () => {
    const d = tweak(await doc(`${p(r('a'))}${TABLE}${p(r('b'))}${SECT()}`))
    // 本页 92 + 600 + 90 超出正文区底边，下一页 72 + 600 + 90 = 762 可容纳。
    const t = tableOf([{ height: 600, keepNext: true }, { height: 90 }])
    const all = parts(paginate(d, layout([[20], [20]], [], [0, 2]), options({ 1: t })))
    expect(all).toHaveLength(1)
    expect([all[0]!.page, all[0]!.it.top, all[0]!.it.segments.map((g) => g.row)]).toEqual([
      2,
      72,
      [0, 1],
    ])
  })

  test('与下一行同页的行已位于表格部分的开头时不再移动，下一行按普通行放置', async () => {
    const d = tweak(await doc(`${p(r('a'))}${TABLE}${p(r('b'))}${SECT()}`))
    // 600 + 200 超出一页正文区：两行移到第 2 页后不再移动；第二行只有一行 200 磅的内容，无法切开，移到第 3 页。
    const t = tableOf([{ height: 600, keepNext: true }, { height: 200 }])
    const all = parts(paginate(d, layout([[20], [20]], [], [0, 2]), options({ 1: t })))
    expect(all.map((x) => [x.page, x.it.top, x.it.segments.map((g) => g.row)])).toEqual([
      [2, 72, [0]],
      [3, 72, [1]],
    ])
  })

  test('页首仍无法容纳任何一行时整行放在本页，超出部分不显示，后续内容从下一页开始', async () => {
    const d = tweak(await doc(`${TABLE}${p(r('b'))}${SECT()}`))
    const pages = paginate(d, layout([[20]], [], [1]), options({ 0: tableOf([{ height: 1000 }]) }))
    expect(pages[0]!.items[0]).toMatchObject({ kind: 'table', top: 72, height: BOTTOM - 72 })
    expect(where(pages).get(1)).toEqual({ page: 2, top: 72, lines: 1 })
  })
})

describe('build：页眉页脚与所需字体', () => {
  test('partRef：本节未引用的种类沿用之前最近一节；首页与偶数页各自沿用', async () => {
    const refs = [
      '<w:headerReference w:type="default" r:id="h1"/><w:headerReference w:type="first" r:id="f1"/>' +
        '<w:headerReference w:type="even" r:id="e1"/>',
      '',
      '<w:headerReference w:type="default" r:id="h3"/>',
    ]
    const d = await doc(
      p(r('a'), SECT(refs[0])) + p(r('b'), SECT(refs[1])) + p(r('c')) + SECT(refs[2]),
    )
    expect(partRef(d, 1, 'default', 'headers')).toBe('h1')
    expect(partRef(d, 2, 'default', 'headers')).toBe('h3')
    expect(partRef(d, 2, 'even', 'headers')).toBe('e1')
    expect(partRef(d, 2, 'first', 'headers')).toBe('f1')
    expect(partRef(d, 2, 'default', 'footers')).toBeNull()
  })

  test('requiredFonts：含表格单元格中段落的字体', async () => {
    const d = await doc(
      p(r('a', '<w:rFonts w:ascii="A1" w:hAnsi="A1" w:eastAsia="E1"/>')) +
        `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${p(r('b', '<w:rFonts w:ascii="T1" w:hAnsi="T1" w:eastAsia="T2"/>'))}</w:tc></w:tr></w:tbl>` +
        SECT(),
    )
    const names = requiredFonts(d)
    expect(names).toContain('A1')
    expect(names).toContain('T2')
  })
})

describe('paintPage：逐字定位与点阵模式', () => {
  function recorder() {
    const ctx = new RecordingContext()
    const calls = () =>
      ctx.calls.map((c) =>
        c.name === 'fillText'
          ? `text ${c.args.join(' ')}`
          : c.name === 'fillRect'
            ? `rect ${c.args.join(' ')}`
            : c.name,
      )
    return { ctx, calls }
  }
  const NO_RESOURCES = { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) }

  function page(fragment: Partial<TextFragment> & { text: string; advances: number[] }): Page {
    return {
      section: 0,
      width: 100,
      height: 100,
      number: '1',
      header: [],
      footer: [],
      floats: [],
      background: null,
      borders: null,
      hidden: 0,
      body: [
        {
          kind: 'paragraph',
          block: 0,
          firstLine: 0,
          box: null,
          images: [],
          lines: [
            {
              top: 0,
              height: 20,
              fragments: [
                {
                  face: 0,
                  size: fragment.size ?? 10.5,
                  x: fragment.x ?? 10,
                  baseline: fragment.baseline ?? 15,
                  text: fragment.text,
                  advances: fragment.advances,
                  color: '#000000',
                  underline: null,
                  strike: null,
                  fill: null,
                },
              ],
            },
          ],
        },
      ],
    }
  }

  function face(bitmaps: EmbeddedBitmaps | null): DocxFace {
    return {
      family: 'F',
      bold: false,
      italic: false,
      text: {
        metrics: { glyphId: () => 1 } as unknown as DocxFace['text']['metrics'],
        vertical: {} as DocxFace['text']['vertical'],
      },
      pixelVertical: () => ({
        ascent: 12,
        descent: 2,
        height: 14,
        internalLeading: 0,
        externalLeading: 0,
      }),
      pixelAdvance: () => null,
      bitmaps,
    }
  }

  const ref = {
    family: 'F',
    bold: false,
    italic: false,
    syntheticBold: false,
    syntheticItalic: false,
  }

  test('轮廓字形：每字位于排版坐标换算为像素后四舍五入处，字号取整数像素', () => {
    const { ctx, calls } = recorder()
    paintPage(
      ctx,
      page({ text: 'ab', advances: [5.2, 5.2] }),
      { faces: [ref], draw: () => face(null) },
      NO_RESOURCES,
    )
    expect(calls().filter((c) => c.startsWith('text'))).toEqual(['text a 13 20', 'text b 20 20'])
    expect(ctx.font).toBe('14px "F"')
  })

  test('点阵模式：字形以着墨像素的横向线段填充，不调用 fillText', () => {
    const glyph: BitmapGlyph = {
      width: 2,
      height: 1,
      bearingX: 0,
      bearingY: 1,
      advance: 2,
      pixels: new Uint8Array([1, 1]),
    }
    const bitmaps: EmbeddedBitmaps = { sizes: [14], screenMode: () => true, glyph: () => glyph }
    const { ctx, calls } = recorder()
    paintPage(
      ctx,
      page({ text: '汉', advances: [10.5] }),
      { faces: [ref], draw: () => face(bitmaps) },
      NO_RESOURCES,
    )
    expect(calls().filter((c) => c.startsWith('text'))).toEqual([])
    expect(calls()).toContain('rect 13 19 2 1')
  })
})

describe.skipIf(process.platform !== 'win32')('build：独占一行的嵌入式图片（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  const picture =
    '<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/>' +
    '<wp:effectExtent l="0" t="0" r="15240" b="0"/><a:graphic>' +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'

  test('按段落对齐方式放在行的对齐范围内：居中时左边为版心左边加剩余宽度的一半', async () => {
    // WPS 屏幕显示：居中段落中对象框宽 442.8 + 1.2 磅的图片，左边位于版心左边加 (473.4 − 444) / 2 处。
    const body = ['center', 'right', 'left']
      .map((jc) => p(picture, `<w:jc w:val="${jc}"/>`))
      .join('')
    const result = await parseDocx(
      buildDocx({
        body: body + SECT(),
        settings: COMPAT14,
        extra: [
          {
            id: 'rIdImg',
            type: 'image',
            name: 'media/image1.png',
            content: 'PNG',
            contentType: 'image/png',
          },
        ],
      }),
    )
    if (!result.ok) throw new Error('解析失败')
    const simsun = loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)
    const page = layoutPages(result.value, new DocxFonts([simsun], '宋体')).pages.pages[0]!
    const xs = page.body.flatMap((it) =>
      it.kind === 'paragraph' ? it.images.map((im) => im.x) : [],
    )
    // 版心 90–505.3 磅，对象框宽 100 + 1.2 磅。
    const expected = [90 + (415.3 - 101.2) / 2, 90 + 415.3 - 101.2, 90]
    expect(xs).toHaveLength(3)
    xs.forEach((x, i) => {
      expect(x).toBeCloseTo(expected[i]!, 6)
    })
  })

  test('与文字同行的图片计入 Page.hidden，图表等没有可绘制内容的对象只在解析时计数；pageImages 列出该页绘制的图片', async () => {
    const chart =
      '<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><a:graphic>' +
      '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/>' +
      '</a:graphic></wp:inline></w:drawing></w:r>'
    const image = (id: string, name: string) => ({
      id,
      type: 'image',
      name,
      content: 'PNG',
      contentType: 'image/png',
    })
    const result = await parseDocx(
      buildDocx({
        body: p(r('前') + picture.replace('rIdImg', 'rIdTwo')) + p(chart) + p(picture) + SECT(),
        settings: COMPAT14,
        extra: [image('rIdImg', 'media/image1.png'), image('rIdTwo', 'media/image2.png')],
      }),
    )
    if (!result.ok) throw new Error('解析失败')
    expect(result.value.unsupported).toEqual({ chart: 1 })
    const simsun = loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)
    const { pages } = layoutPages(result.value, new DocxFonts([simsun], '宋体'))
    const page = pages.pages[0]!
    expect(pages.pages).toHaveLength(1)
    expect(page.hidden).toBe(1)
    const parts = pages.images.map((im) => im.part)
    expect(parts).toEqual(['/word/media/image2.png', '/word/media/image1.png'])
    expect(pageImages(page, parts)).toEqual([1])
  })
})

describe('DocxFonts：登记字形', () => {
  const metrics = {
    glyphId: () => 1,
    advance: () => 5,
  } as unknown as DocxFace['text']['metrics']
  const regular: DocxFace = {
    family: '宋体',
    bold: false,
    italic: false,
    text: { metrics, vertical: {} as DocxFace['text']['vertical'] },
    pixelVertical: () => ({
      ascent: 12,
      descent: 2,
      height: 14,
      internalLeading: 0,
      externalLeading: 0,
    }),
    pixelAdvance: () => null,
    bitmaps: null,
  }

  test('请求粗体而没有粗体字形时返回已按仿粗体换算的字形，登记为合成粗体；缺少的字体返回 null', () => {
    const fonts = new DocxFonts([regular], '宋体')
    const bold = fonts.source.face('宋体', true, false)!
    expect(bold.bold).toBe(true)
    expect(bold.face.metrics.advance(0x6c49, 10.5)).toBeCloseTo(5 + 10.5 / 256, 9)
    expect(fonts.refs[fonts.ref(bold.face)]).toEqual({
      family: '宋体',
      bold: false,
      italic: false,
      syntheticBold: true,
      syntheticItalic: false,
    })
    expect(fonts.source.face('不存在的字体', false, false)).toBeNull()
    expect(fonts.refs[fonts.ref(fonts.source.fallback)]!.syntheticBold).toBe(false)
  })
})
