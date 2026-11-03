/**
 * docx 表格。覆盖 `../parse/table.ts`（表格、行、单元格属性与 `cnfStyle`）、`../resolve/table.ts`（表格样式链、
 * 条件格式的生效条件与叠加、单元格边框）、`layout.ts`（列宽、横向位置、行高规则、边框占用的高度、
 * 纵向合并（含合并单元格内部的行顶边框）、单元格内容与纵向对齐、边框冲突、单元格上下边距与行高、行间边框与上边距的叠加）、`autofit.ts`（自动调整布局的
 * 列宽）、`../layout.ts` 的最小与最大内容宽度、`../resolve/cascade.ts` 的 `contentIndent`、
 * `../page/build.ts` 与 `../page/paginate.ts` 中表格的分页与绘制项（标题行重复、行内切开、表格中的行网格、跨页处的上下框线、
 * 底边框须容纳在本页、最小行高的行跨页、只余段后间距的行整行移页、浮动表格的纵向偏移、横向位置与不重复标题行），
 * `../parse/body.ts` 中单元格的分页符与分栏符，以及 `../render/paint.ts` 的表格边框与虚框。
 *
 * 期望值取自 WPS 12.1 只读打开同样内容的构造文档后逐段取得的位置（`Range.Information(5)`、`Information(6)`）
 * 与 720 dpi 的页面 EMF 回放。排版用例读取本机 Windows 字体目录中的 Times New Roman 与宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { NO_HOST_FAMILIES } from '../../text/index.ts'
import { type DocxDocument, parseDocx, type TableBlock } from '../index.ts'
import { ParagraphLayouter } from '../layout.ts'
import { layoutPages } from '../page/build.ts'
import type { Page, PageItem, PageTable } from '../page/model.ts'
import { type DocxFace, DocxFonts, loadDocxFace } from '../render/fonts.ts'
import { paintPage } from '../render/paint.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { layoutTable } from './layout.ts'

const DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" ' +
  'w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:widowControl w:val="0"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/>' +
  '<w:tblPr><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>' +
  '</w:tblPr></w:style>'

const SECT =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" ' +
  'w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'

const compat = (mode: number, extra = '') =>
  `<w:compat>${extra}<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="${mode}"/></w:compat>`

const border = (sz = 4, sides = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) =>
  sides.map((s) => `<w:${s} w:val="single" w:sz="${sz}" w:space="0" w:color="000000"/>`).join('')

interface Cell {
  readonly text?: string
  readonly tcPr?: string
  readonly body?: string
}

/** 表格 XML：`rows` 为各行的行属性与单元格；单元格宽度取所跨网格列宽之和。 */
function table(
  grid: readonly number[],
  rows: readonly { readonly trPr?: string; readonly cells: readonly Cell[] }[],
  tblPr = '',
  borders: string | null = border(),
  layout = 'fixed',
): string {
  const tbl =
    `<w:tblPr><w:tblW w:w="${grid.reduce((a, b) => a + b, 0)}" w:type="dxa"/>${tblPr}` +
    `${borders === null ? '' : `<w:tblBorders>${borders}</w:tblBorders>`}<w:tblLayout w:type="${layout}"/></w:tblPr>`
  const g = `<w:tblGrid>${grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
  const body = rows
    .map((row) => {
      let col = 0
      const cells = row.cells
        .map((c) => {
          const span = Number(/gridSpan w:val="(\d+)"/.exec(c.tcPr ?? '')?.[1] ?? 1)
          const w = grid.slice(col, col + span).reduce((a, b) => a + b, 0)
          col += span
          return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${c.tcPr ?? ''}</w:tcPr>${c.body ?? p(r(c.text ?? ''))}</w:tc>`
        })
        .join('')
      return `<w:tr>${row.trPr ? `<w:trPr>${row.trPr}</w:trPr>` : ''}${cells}</w:tr>`
    })
    .join('')
  return `<w:tbl>${tbl}${g}${body}</w:tbl>`
}

async function parse(
  body: string,
  settings = compat(14),
  styles = DEFAULTS,
): Promise<DocxDocument> {
  const result = await parseDocx(buildDocx({ body: body + SECT, settings, styles }))
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

const tables = (d: DocxDocument) => d.body.filter((b): b is TableBlock => b.kind === 'table')

const STYLE =
  '<w:style w:type="table" w:styleId="TS"><w:name w:val="TS"/><w:basedOn w:val="TableNormal"/>' +
  '<w:pPr><w:spacing w:after="0"/><w:jc w:val="center"/></w:pPr>' +
  `<w:tblPr><w:tblBorders>${border()}</w:tblBorders></w:tblPr>` +
  '<w:tblStylePr w:type="firstRow"><w:rPr><w:b/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="2F5597"/>' +
  '<w:tcBorders><w:bottom w:val="double" w:sz="4" w:color="FF0000"/></w:tcBorders></w:tcPr></w:tblStylePr>' +
  '<w:tblStylePr w:type="band1Horz"><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/></w:tcPr></w:tblStylePr>' +
  '<w:tblStylePr w:type="firstCol"><w:rPr><w:i/></w:rPr></w:tblStylePr></w:style>'

const LOOK = '<w:tblStyle w:val="TS"/><w:tblLook w:val="04A0"/>'

describe('解析：表格属性、表格样式与条件格式', () => {
  test('表格属性：宽度、布局、缩进、对齐、边框与边距；行与单元格的属性', async () => {
    const d = await parse(
      table(
        [2000, 3000],
        [
          {
            trPr: '<w:trHeight w:val="600" w:hRule="exact"/><w:tblHeader/><w:cantSplit/>',
            cells: [
              {
                text: 'a',
                tcPr: '<w:vMerge w:val="restart"/><w:vAlign w:val="center"/><w:noWrap/>',
              },
              {
                text: 'b',
                tcPr: '<w:tcMar><w:left w:w="400" w:type="dxa"/></w:tcMar><w:shd w:val="clear" w:fill="FFC000"/>',
              },
            ],
          },
          { cells: [{ tcPr: '<w:vMerge/>' }, { text: 'c' }] },
        ],
        '<w:jc w:val="center"/><w:tblInd w:w="720" w:type="dxa"/>',
      ),
    )
    const t = tables(d)[0]!
    expect([t.grid, t.layout, t.indent, t.align, t.width]).toEqual([
      [100, 150],
      'fixed',
      36,
      'center',
      { type: 'dxa', value: 250 },
    ])
    expect(t.borders.insideV).toEqual({ style: 'single', width: 0.5, color: '#000000', space: 0 })
    expect(t.margins).toEqual({ left: 5.4, top: 0, right: 5.4, bottom: 0 })
    const [c0, c1] = t.rows[0]!.cells
    expect(t.rows[0]).toMatchObject({
      height: { rule: 'exact', value: 30 },
      header: true,
      cantSplit: true,
    })
    expect([c0!.vMerge, c0!.vAlign, c0!.noWrap, c1!.margins.left, c1!.shading]).toEqual([
      'restart',
      'center',
      true,
      20,
      '#ffc000',
    ])
    expect(t.rows[1]!.cells[0]!.vMerge).toBe('continue')
  })

  test('条件格式只按 cnfStyle 生效：tblLook 不起作用；行的 cnfStyle 使首行与横向条带生效，单元格的使全部种类生效，段落的不起作用', async () => {
    const row = (
      r0: number,
      trPr: string,
      tcPr: (c: number) => string,
      pPr: (c: number) => string,
    ) => ({
      trPr,
      cells: [0, 1].map((c) => ({ tcPr: tcPr(c), body: p(r(`r${r0}c${c}`), pPr(c)) })),
    })
    const cnf = (bits: string) => `<w:cnfStyle w:val="${bits}"/>`
    const first = '100000000000'
    const firstCol = '001000000000'
    const band = '000000100000'
    const build = (where: 'none' | 'tr' | 'tc' | 'p') =>
      table(
        [2000, 3000],
        [0, 1].map((r0) =>
          row(
            r0,
            where === 'tr' ? cnf(r0 === 0 ? first : band) : '',
            (c) =>
              where === 'tc'
                ? cnf(
                    (r0 === 0 ? first : band)
                      .split('')
                      .map((b, i) => (b === '1' || (c === 0 && firstCol[i] === '1') ? '1' : '0'))
                      .join(''),
                  )
                : '',
            () => (where === 'p' ? cnf(r0 === 0 ? first : band) : ''),
          ),
        ),
        LOOK,
        null,
      )
    const d = await parse(
      build('none') + p(r('x')) + build('tr') + p(r('x')) + build('tc') + p(r('x')) + build('p'),
      compat(14),
      DEFAULTS + STYLE,
    )
    const shading = (t: TableBlock) => t.rows.map((row) => row.cells.map((c) => c.shading))
    const style = (t: TableBlock) =>
      t.rows.map((row) =>
        row.cells.map((c) => {
          const para = c.content[0]
          if (para?.kind !== 'paragraph') return ''
          const props = para.runs[0]!.props
          return `${props.bold ? 'b' : ''}${props.italic ? 'i' : ''}`
        }),
      )
    const [none, tr, tc, pp] = tables(d)
    expect(shading(none!)).toEqual([
      [null, null],
      [null, null],
    ])
    expect(shading(tr!)).toEqual([
      ['#2f5597', '#2f5597'],
      ['#d9e2f3', '#d9e2f3'],
    ])
    expect(style(tr!)).toEqual([
      ['b', 'b'],
      ['', ''],
    ])
    expect(style(tc!)).toEqual([
      ['bi', 'b'],
      ['i', ''],
    ])
    expect(shading(pp!)).toEqual(shading(none!))
    // 条件格式的单元格边框作用于所在单元格。
    expect(tr!.rows[0]!.cells[0]!.borders.bottom).toEqual({
      style: 'double',
      width: 0.5,
      color: '#ff0000',
      space: 0,
    })
  })

  test('单元格中段落的属性：表格样式位于段落样式之前（Normal 的段后间距生效，表格样式的居中在 Normal 未指定时生效）', async () => {
    const normal =
      '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/>' +
      '<w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr></w:style>'
    const styles = DEFAULTS.replace(
      '<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>',
      normal,
    )
    const d = await parse(
      table([2000], [{ cells: [{ text: 'a' }] }], LOOK, null),
      compat(14),
      styles + STYLE,
    )
    const para = tables(d)[0]!.rows[0]!.cells[0]!.content[0]
    if (para?.kind !== 'paragraph') throw new Error('不是段落')
    expect([para.props.align, para.props.after, para.props.lineSpacing]).toEqual([
      'center',
      10,
      { rule: 'multiple', value: 1.15 },
    ])
  })
})

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')

describe.skipIf(process.platform !== 'win32')('排版与分页（本机字体）', () => {
  let fonts: DocxFonts | null = null
  const load = (): DocxFonts => {
    if (fonts !== null) return fonts
    const faces: DocxFace[] = [
      loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'times.ttf'))), 'Times New Roman'),
      loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0),
    ]
    fonts = new DocxFonts(faces, '宋体')
    return fonts
  }

  /** 各页表格中的段落：文字、首字横坐标与行顶。 */
  function cells(d: DocxDocument): { page: number; text: string; x: number; y: number }[][] {
    const pages = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages
    return pages.map((pg, i) => {
      const out: { page: number; text: string; x: number; y: number }[] = []
      const visit = (items: readonly PageItem[]) => {
        for (const it of items) {
          if (it.kind === 'table') visit(it.items)
          else {
            const line = it.lines[0]!
            out.push({
              page: i + 1,
              text: it.lines.flatMap((l) => l.fragments.map((f) => f.text)).join(''),
              x: line.fragments[0]?.x ?? -1,
              y: line.top,
            })
          }
        }
      }
      for (const it of pg.body) if (it.kind === 'table') visit(it.items)
      return out
    })
  }
  const near = (actual: number, expected: number) =>
    expect(Math.abs(actual - expected)).toBeLessThan(0.06)
  const find = (all: ReturnType<typeof cells>, text: string) => {
    for (const pg of all) for (const c of pg) if (c.text.startsWith(text)) return c
    throw new Error(`未找到 ${text}`)
  }

  test('续页重复的标题行之后：顶边为标题行底边与首行顶边的取舍，绘制该线，首行按其占用的高度下移', async () => {
    // WPS（语料 docx-0824436d 第 12 页）：标题行底边 1.25 磅、数据行顶边为 nil 且上边距 1 磅时，续页标题行下绘制 1.25 磅的
    // 线，第一行数据的行顶在标题行底边之下 1.25 磅，与第一页相同。
    const head =
      '<w:tcBorders><w:top w:val="single" w:sz="14" w:color="000000"/><w:bottom w:val="single" w:sz="10" w:color="000000"/></w:tcBorders>'
    const data =
      '<w:tcBorders><w:top w:val="nil"/><w:bottom w:val="nil"/></w:tcBorders><w:tcMar><w:top w:w="20" w:type="dxa"/><w:bottom w:w="20" w:type="dxa"/></w:tcMar>'
    const rows = [
      { trPr: '<w:tblHeader/>', cells: [{ text: '标题', tcPr: head }] },
      ...Array.from({ length: 80 }, (_, k) => ({ cells: [{ text: `行${k}`, tcPr: data }] })),
    ]
    const d = await parse(table([4000], rows, '', null))
    const pages = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages
    const table1 = pages[1]!.body.find((it) => it.kind === 'table')!
    if (table1.kind !== 'table') throw new Error('不是表格')
    const lines = table1.edges.filter((e) => !e.vertical && e.line !== null).map((e) => e.y)
    const first = cells(d)[1]!.find((c) => c.text.startsWith('行'))!
    const headerBottom = lines.find((y) => y > table1.top)!
    expect(lines.filter((y) => y > table1.top + 1)).toHaveLength(1)
    near(first.y - headerBottom, 1.25)
  })

  test('横向位置：兼容模式 14 文字与 tblInd 对齐，15 单元格左边在 tblInd 加左边框一半处；居中按网格宽度；右对齐两种模式不同', async () => {
    const body =
      p(r('A:')) +
      table([2000, 3000, 2000], [{ cells: [{ text: 'A1a' }, { text: 'A1b' }, { text: 'A1c' }] }]) +
      p(r('B:')) +
      table(
        [2000, 3000, 2000],
        [{ cells: [{ text: 'A2a' }, { text: 'A2b' }, { text: 'A2c' }] }],
        '',
        border(48, ['left']) + border(4, ['top', 'bottom', 'right', 'insideH', 'insideV']),
      ) +
      p(r('C:')) +
      table(
        [2500, 2500],
        [{ cells: [{ text: 'A3a' }, { text: 'A3b' }] }],
        '<w:jc w:val="center"/>',
      ) +
      p(r('D:')) +
      table(
        [2500, 2500],
        [{ cells: [{ text: 'A4a' }, { text: 'A4b' }] }],
        '<w:jc w:val="right"/>',
      ) +
      p(r('E:')) +
      table(
        [2000, 3000, 2000],
        [{ cells: [{ text: 'A5a' }, { text: 'A5b' }, { text: 'A5c' }] }],
        '<w:tblInd w:w="360" w:type="dxa"/>',
        border(24),
      )
    const c14 = cells(await parse(body, compat(14)))
    const c15 = cells(await parse(body, compat(15)))
    const xs = (all: ReturnType<typeof cells>, names: string[]) => names.map((n) => find(all, n).x)
    const expect14 = [90, 190, 340, 90, 178.05, 303.05, 266.1, 108]
    const expect15 = [95.65, 195.65, 345.65, 98.4, 178.05, 303.05, 260.45, 114.9]
    const names = ['A1a', 'A1b', 'A1c', 'A2a', 'A3a', 'A3b', 'A4a', 'A5a']
    xs(c14, names).forEach((x, i) => {
      near(x, expect14[i]!)
    })
    xs(c15, names).forEach((x, i) => {
      near(x, expect15[i]!)
    })
  })

  test('行高：行顶边框计入本行，最小行高为边框加最小值，固定行高含边框；表格底边框另占高度；纵向居中与底端对齐', async () => {
    const body =
      p(r('A:')) +
      table(
        [2000, 3000, 2000],
        [
          {
            trPr: '<w:trHeight w:val="600"/>',
            cells: [{ text: 'R1a' }, { text: 'R1b' }, { text: 'R1c' }],
          },
          {
            trPr: '<w:trHeight w:val="600"/>',
            cells: [{ text: 'R2a' }, { text: 'R2b' }, { text: 'R2c' }],
          },
        ],
      ) +
      p(r('B:')) +
      table(
        [2000, 3000, 2000],
        [
          {
            trPr: '<w:trHeight w:val="600"/>',
            cells: [{ text: 'T1a' }, { text: 'T1b' }, { text: 'T1c' }],
          },
          {
            trPr: '<w:trHeight w:val="600" w:hRule="exact"/>',
            cells: [{ text: 'T2a' }, { text: 'T2b' }, { text: 'T2c' }],
          },
          {
            trPr: '<w:trHeight w:val="600"/>',
            cells: [{ text: 'T3a' }, { text: 'T3b' }, { text: 'T3c' }],
          },
        ],
        '',
        border(24),
      ) +
      p(r('C:')) +
      table(
        [2000, 3000, 2000],
        [
          {
            trPr: '<w:trHeight w:val="900"/>',
            cells: [
              { text: 'V1a' },
              { text: 'V1b', tcPr: '<w:vAlign w:val="center"/>' },
              { text: 'V1c', tcPr: '<w:vAlign w:val="bottom"/>' },
            ],
          },
        ],
      ) +
      p(r('D:'))
    const all = cells(await parse(body))
    near(find(all, 'R1a').y, 84.55)
    near(find(all, 'R2a').y, 115.05)
    near(find(all, 'T1a').y, 160.6)
    near(find(all, 'T2a').y, 193.6)
    near(find(all, 'T3a').y, 223.6)
    near(find(all, 'V1b').y - find(all, 'V1a').y, 404.55 - 388.1)
    near(find(all, 'V1c').y - find(all, 'V1a').y, 421.0 - 388.1)
  })

  test('纵向合并：合并单元格的内容高于所跨各行时最后一行加高；相邻单元格边框取较宽者', async () => {
    const long = '汉字排版测试表格列宽'.repeat(6)
    const body =
      p(r('A:')) +
      table(
        [2000, 3000, 2000],
        [
          {
            cells: [
              { text: 'M1a' },
              { text: long, tcPr: '<w:vMerge w:val="restart"/>' },
              { text: 'M1c' },
            ],
          },
          { cells: [{ text: 'M2a' }, { tcPr: '<w:vMerge/>' }, { text: 'M2c' }] },
          { cells: [{ text: 'M3a' }, { tcPr: '<w:vMerge/>' }, { text: 'M3c' }] },
        ],
      ) +
      p(r('B:')) +
      table(
        [2000, 3000, 2000],
        [
          {
            cells: [
              { text: 'E1a' },
              {
                text: 'E1b',
                tcPr: '<w:tcBorders><w:right w:val="single" w:sz="24" w:color="FF0000"/></w:tcBorders>',
              },
              {
                text: 'E1c',
                tcPr: '<w:tcBorders><w:left w:val="single" w:sz="8" w:color="0000FF"/></w:tcBorders>',
              },
            ],
          },
        ],
      )
    const d = await parse(body)
    const all = cells(d)
    near(find(all, 'M2a').y, 281.75 - 269.2 + find(all, 'M1a').y)
    const page = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages[0]!
    const second = page.body.filter((it): it is PageTable => it.kind === 'table')[1]!
    const between = second.edges.find((e) => e.vertical && Math.abs(e.x - 334.6) < 0.01)
    expect(between?.line).toMatchObject({ strokes: [{ offset: 0, size: 3 }], color: '#ff0000' })
  })

  test('自动调整：各列不小于其中单元格的最小内容宽度；百分比宽度按比例缩放各列', async () => {
    const word = 'A11:Supercalifragilisticexpialidocious'
    const body =
      p(r('A:')) +
      table(
        [800, 1000, 1000],
        [{ cells: [{ text: word }, { text: 'A11r0c1:' }, { text: 'A11r0c2:' }] }],
        '',
        border(),
        'autofit',
      ) +
      p(r('B:')) +
      table(
        [1000, 1000, 1000],
        [{ cells: [{ text: 'P1' }, { text: 'P2' }, { text: 'P3' }] }],
        '',
        border(),
        'autofit',
      ).replace('<w:tblW w:w="3000" w:type="dxa"/>', '<w:tblW w:w="5000" w:type="pct"/>')
    const all = cells(await parse(body))
    near(find(all, 'A11r0c1').x, 262.95)
    near(find(all, 'A11r0c2').x, 313.45)
    near(find(all, 'P2').x, 232)
    near(find(all, 'P3').x, 374.05)
  })

  test('自动调整：居中与右对齐段落的最小内容宽度不含对齐偏移，固定宽度的表格各列保持网格宽度', async () => {
    // 语料（表 2.4，7 列、单元格居中）：WPS 按网格列宽显示；对齐偏移计入内容宽度时各列达 5×10⁵ 磅。
    const centered = (text: string, jc: string) => ({ body: p(r(text), `<w:jc w:val="${jc}"/>`) })
    const body = table(
      [1000, 1200, 1400],
      [{ cells: [centered('甲', 'center'), centered('乙', 'right'), centered('丙', 'center')] }],
      '',
      border(),
      'autofit',
    )
    const d = await parse(body)
    const pg = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages[0]!
    const t = pg.body[0]
    if (t?.kind !== 'table') throw new Error('不是表格')
    const xs = t.edges.filter((e) => e.vertical).map((e) => e.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(180, 6)
  })

  test('纵向合并的单元格内部的边框计入行顶边框：起始单元格的下边框或后续单元格的上边框（WPS：构造文档 w10m）', async () => {
    const bd = (side: string, sz: number) =>
      sz > 0
        ? `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="000000"/>`
        : `<w:${side} w:val="nil"/>`
    const merged = (name: string, restartBottom: number, continueTop: number) =>
      table(
        [3000, 3000],
        [
          {
            cells: [
              {
                text: `${name}甲`,
                tcPr: `<w:vMerge w:val="restart"/><w:tcBorders>${bd('bottom', restartBottom)}</w:tcBorders>`,
              },
              { text: `${name}乙`, tcPr: `<w:tcBorders>${bd('bottom', 0)}</w:tcBorders>` },
            ],
          },
          {
            cells: [
              { tcPr: `<w:vMerge/><w:tcBorders>${bd('top', continueTop)}</w:tcBorders>` },
              { text: `${name}丙`, tcPr: `<w:tcBorders>${bd('top', 0)}</w:tcBorders>` },
            ],
          },
        ],
        '<w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar>',
        null,
      )
    const body = [
      ['A', 0, 24],
      ['B', 24, 0],
      ['C', 0, 0],
    ]
      .map(([n, b, c]) => p(r(`${n}:`)) + merged(n as string, b as number, c as number))
      .join('')
    const all = cells(await parse(body))
    const step = (n: string) => find(all, `${n}丙`).y - find(all, `${n}乙`).y
    near(step('A'), 102.2 - 85.6)
    near(step('B'), 159.7 - 143.05)
    near(step('C'), 214.15 - 200.55)
  })

  describe('自动调整布局的列宽（WPS：构造文档 w10a、w10b、w10e、w10g、w10k，版心 451.3 磅，宋体，单元格左右边距 5.4 磅）', () => {
    const A4 =
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" ' +
      'w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
    const SONG = '<w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体"/>'
    const H = '汉'
    /** 单元格：文字、`tcW`（缇、`auto` 或 `pct:` 加五十分之一百分数）与其余 `tcPr`；文字为宋体 10.5 磅，`ppr` 另给段落属性。 */
    type C = readonly [
      text: string,
      width: number | 'auto' | `pct:${number}`,
      tcPr?: string,
      ppr?: string,
      rpr?: string,
    ]
    const tcW = (width: C[1]) =>
      width === 'auto'
        ? '<w:tcW w:w="0" w:type="auto"/>'
        : typeof width === 'number'
          ? `<w:tcW w:w="${width}" w:type="dxa"/>`
          : `<w:tcW w:w="${width.slice(4)}" w:type="pct"/>`
    const tc = ([text, width, tcPr = '', ppr = '', rpr = '']: C) =>
      `<w:tc><w:tcPr>${tcW(width)}` +
      `${tcPr}</w:tcPr>${p(text === '' ? '' : r(text, SONG + rpr), `<w:jc w:val="left"/>${ppr}`)}</w:tc>`
    const auto = (
      rows: readonly (readonly C[])[],
      tblW = '<w:tblW w:w="0" w:type="auto"/>',
      tblPr = '',
      borders = border(),
    ) =>
      `<w:tbl><w:tblPr>${tblW}${tblPr}<w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>` +
      `${'<w:gridCol w:w="2000"/>'.repeat(rows[0]!.length)}</w:tblGrid>` +
      `${rows.map((row) => `<w:tr>${row.map(tc).join('')}</w:tr>`).join('')}</w:tbl>`
    const dxa = (w: number) => `<w:tblW w:w="${w}" w:type="dxa"/>`
    /** 各表格的网格列宽。 */
    const widths = async (tbls: readonly string[], mode = 15): Promise<number[][]> => {
      const body = tbls.map((t) => p(r('表')) + t).join('') + A4
      const result = await parseDocx(buildDocx({ body, settings: compat(mode), styles: DEFAULTS }))
      if (!result.ok) throw new Error('解析失败')
      const d = result.value
      const cx = {
        layouter: new ParagraphLayouter(d, load().source, NO_HOST_FAMILIES),
        compatibilityMode: mode,
      }
      return tables(d).map((t) => {
        const c = layoutTable(t, d.sections[0]!.columns[0]!.width, cx).columns
        return c.slice(1).map((x, i) => Math.round((x - c[i]!) * 100) / 100)
      })
    }

    test('自动列取最大宽度；宽于可用宽度时按初值减最小宽度的比例收窄，窄于 tblW 时按初值的比例展宽；网格不参与', async () => {
      expect(
        await widths([
          auto([
            [
              [H.repeat(4), 'auto'],
              [H.repeat(8), 'auto'],
            ],
          ]),
          auto([
            [
              [H.repeat(10), 'auto'],
              [H.repeat(60), 'auto'],
            ],
          ]),
          auto([
            [
              ['0'.repeat(20), 'auto'],
              [H.repeat(60), 'auto'],
            ],
          ]),
          auto(
            [
              [
                [H.repeat(4), 'auto'],
                [H.repeat(8), 'auto'],
              ],
            ],
            dxa(6000),
          ),
          auto([
            [
              [H.repeat(4), 'auto'],
              [H.repeat(8), 'auto'],
            ],
            [
              [H.repeat(12), 'auto'],
              [H.repeat(2), 'auto'],
            ],
          ]),
          auto([
            [
              ['', 'auto'],
              [H.repeat(4), 'auto'],
            ],
          ]),
        ]),
      ).toEqual([
        [52.8, 94.8],
        [75.35, 375.45],
        [115.8, 335],
        [107.3, 192.7],
        [136.8, 94.8],
        [11.1, 52.8],
      ])
    })

    test('定宽列保持首选宽度，差额先由自动列承担；首选宽度小于最小宽度时取最小宽度；同列中第一个首选宽度之前的单元格不计入', async () => {
      const two = [H.repeat(2), 2000] as const
      expect(
        await widths([
          auto(
            [
              [
                [H.repeat(4), 1000],
                [H.repeat(30), 'auto'],
              ],
            ],
            dxa(6000),
          ),
          auto(
            [
              [
                ['0'.repeat(16), 1000],
                [H.repeat(4), 5000],
              ],
            ],
            dxa(6000),
          ),
          auto(
            [
              [
                [H.repeat(4), 2000],
                [H.repeat(8), 'auto'],
                [H.repeat(2), 2000],
              ],
            ],
            dxa(6000),
          ),
          auto([
            [
              [H.repeat(4), 2500],
              [H.repeat(8), 2500],
            ],
          ]),
          auto(
            [
              [
                [H.repeat(4), 2000],
                [H.repeat(8), 2000],
              ],
            ],
            dxa(6000),
          ),
          auto([
            [two, two],
            [[H.repeat(12), 'auto'], two],
          ]),
          auto([
            [[H.repeat(12), 'auto'], two],
            [two, two],
          ]),
        ]),
      ).toEqual([
        [50, 250],
        [94.8, 205.2],
        [100, 100, 100],
        [125, 125],
        [150, 150],
        [136.8, 100],
        [100, 100],
      ])
    })

    test('可用宽度：兼容模式 15 为版心减表格左右框线的一半（不看单元格边框），14 为版心加表格左右边距，都减左缩进；pct 的 tblW 按比例，不减左缩进', async () => {
      const long = auto([
        [
          [H.repeat(30), 'auto'],
          [H.repeat(30), 'auto'],
        ],
      ])
      const indented = auto(
        [
          [
            [H.repeat(30), 'auto'],
            [H.repeat(30), 'auto'],
          ],
        ],
        undefined,
        '<w:tblInd w:w="500" w:type="dxa"/>',
      )
      const half = auto(
        [
          [
            [H.repeat(4), 'auto'],
            [H.repeat(8), 'auto'],
          ],
        ],
        '<w:tblW w:w="2500" w:type="pct"/>',
      )
      const full = auto(
        [
          [
            [H.repeat(4), 'auto'],
            [H.repeat(8), 'auto'],
          ],
        ],
        '<w:tblW w:w="5000" w:type="pct"/>',
        '<w:tblInd w:w="500" w:type="dxa"/>',
      )
      expect(await widths([long, indented, half, full], 15)).toEqual([
        [225.4, 225.4],
        [212.9, 212.9],
        [80.65, 144.75],
        [161.25, 289.55],
      ])
      expect(await widths([long, indented, half, full], 14)).toEqual([
        [231.05, 231.05],
        [218.55, 218.55],
        [82.65, 148.4],
        [165.3, 296.8],
      ])
      const thick = (side: string) =>
        `<w:tcBorders><w:${side} w:val="single" w:sz="24" w:space="0" w:color="000000"/></w:tcBorders>`
      const cellsOnly = auto(
        [
          [
            [H.repeat(2), 4513, thick('left')],
            [H.repeat(2), 4513, thick('right')],
          ],
        ],
        undefined,
        '',
        border(4, ['top', 'bottom', 'insideH', 'insideV']),
      )
      const framed = auto(
        [
          [
            [H.repeat(2), 4513],
            [H.repeat(2), 4513],
          ],
        ],
        undefined,
        '',
        border(24),
      )
      expect(await widths([cellsOnly, framed], 15)).toEqual([
        [225.65, 225.65],
        [224.15, 224.15],
      ])
    })

    test('横向位置按表格的左框线：没有左框线、第一列单元格左边框 3 磅时单元格左边与版心左边对齐（WPS：文字距版心左边 5.4 磅）', async () => {
      const thick =
        '<w:tcBorders><w:left w:val="single" w:sz="24" w:space="0" w:color="000000"/></w:tcBorders>'
      const t = auto(
        [
          [
            [H.repeat(2), 4513, thick],
            [H.repeat(2), 4513],
          ],
        ],
        undefined,
        '',
        border(4, ['top', 'bottom', 'insideH', 'insideV']),
      )
      const result = await parseDocx(
        buildDocx({ body: p(r('表')) + t + A4, settings: compat(15), styles: DEFAULTS }),
      )
      if (!result.ok) throw new Error('解析失败')
      const d = result.value
      const cx = {
        layouter: new ParagraphLayouter(d, load().source, NO_HOST_FAMILIES),
        compatibilityMode: 15,
      }
      expect(layoutTable(tables(d)[0]!, d.sections[0]!.columns[0]!.width, cx).x).toBe(0)
    })

    test('合并单元格的宽度大于所跨各列之和时，差额按各列初值的比例分配', async () => {
      const span = '<w:gridSpan w:val="2"/>'
      expect(
        await widths([
          auto([
            [
              [H.repeat(4), 'auto'],
              [H.repeat(8), 'auto'],
            ],
            [[H.repeat(20), 'auto', span]],
          ]),
          auto([
            [
              [H.repeat(4), 2000],
              [H.repeat(8), 'auto'],
            ],
            [[H.repeat(30), 'auto', span]],
          ]),
        ]),
      ).toEqual([
        [79, 141.8],
        [167.25, 158.55],
      ])
    })

    test('合并单元格中不可断开的内容宽于所跨各列之和时，各列按最小宽度与初值之和的比例分得该宽度；不宽于时各列不变（WPS：构造文档 w14 t15 的 S7、S11、S13、S14）', async () => {
      const digits = (n: number) => '0'.repeat(n)
      const span = (n: number) => `<w:gridSpan w:val="${n}"/>`
      expect(
        await widths([
          auto([
            [
              [H.repeat(4), 'auto'],
              [H.repeat(8), 'auto'],
            ],
            [[digits(40), 'auto', span(2)]],
          ]),
          auto([
            [
              [H.repeat(2), 'auto'],
              [H.repeat(4), 'auto'],
              [H.repeat(8), 'auto'],
            ],
            [[digits(50), 'auto', span(3)]],
          ]),
          auto([
            [
              [H.repeat(4), 2000],
              [H.repeat(8), 'auto'],
            ],
            [[digits(40), 'auto', span(2)]],
          ]),
          auto([
            [
              [H.repeat(4), 'auto'],
              [H.repeat(16), 'auto'],
            ],
            [[digits(40), 'auto', span(2)]],
          ]),
        ]),
      ).toEqual([
        [86, 134.8],
        [59.65, 83.25, 130.4],
        [112.8, 108],
        [52.8, 178.8],
      ])
    })

    test('tcW 为 pct 的列：没有其他列时按比例分满表格宽度，否则为表格宽度乘以比例、余下归其他列（WPS：构造文档 w14 t15 的 M3–M12）', async () => {
      const two = (a: string, b: string, wa: C[1], wb: C[1], tblW?: string) =>
        auto(
          [
            [
              [a, wa],
              [b, wb],
            ],
          ],
          tblW,
        )
      expect(
        await widths([
          two(H.repeat(4), H.repeat(8), 'pct:1000', 'pct:2000'),
          two(H.repeat(8), H.repeat(4), 'pct:1000', 'pct:2000'),
          two(H.repeat(4), H.repeat(8), 'pct:1000', 'pct:2000', dxa(6000)),
          two(H.repeat(4), H.repeat(8), 'pct:1000', 3000),
          auto([
            [
              [H.repeat(4), 'pct:1000'],
              [H.repeat(8), 'pct:2000'],
              [H.repeat(2), 'auto'],
            ],
          ]),
        ]),
      ).toEqual([
        [88, 176],
        [150.25, 300.55],
        [100, 200],
        [52.8, 211.2],
        [52.8, 105.6, 105.6],
      ])
    })

    test('内容宽度：首行字符缩进按缺省段落样式的字号计算，排版按字段字号；分散对齐不计对齐增量', async () => {
      const big = '<w:sz w:val="24"/>'
      const indent = '<w:ind w:firstLineChars="200" w:firstLine="480"/>'
      const body = [
        auto([[[H.repeat(4), 'auto', '', indent, big]]]),
        auto([[['学生姓名', 'auto', '', '<w:jc w:val="distribute"/>', big]]]),
      ]
      expect(await widths(body)).toEqual([[79.8], [58.8]])
      const d = await parse(body.join(''), compat(15))
      const para = tables(d)[0]!.rows[0]!.cells[0]!.content[0]
      if (para?.kind !== 'paragraph') throw new Error('不是段落')
      expect([para.props.firstLine, para.props.contentIndent.firstLine]).toEqual([24, 21])
    })
  })

  test('表格中的段落只在设置 adjustLineHeightInTable 时对齐行网格', async () => {
    const long = '汉字排版测试表格列宽'.repeat(6)
    const body =
      p(r('A:')) +
      table(
        [2000, 3000, 2000],
        [
          { cells: [{ text: 'Q1a' }, { text: 'Q1b' }, { text: 'Q1c' }] },
          { cells: [{ text: 'Q2a' }, { text: long }, { text: 'Q2c' }] },
        ],
      )
    const grid = '<w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>'
    const off = await parseDocx(
      buildDocx({
        body: body + SECT.replace('</w:sectPr>', grid),
        settings: compat(14),
        styles: DEFAULTS,
      }),
    )
    const on = await parseDocx(
      buildDocx({
        body: body + SECT.replace('</w:sectPr>', grid),
        settings: compat(14, '<w:adjustLineHeightInTable/>'),
        styles: DEFAULTS,
      }),
    )
    if (!off.ok || !on.ok) throw new Error('解析失败')
    near(find(cells(off.value), 'Q2a').y, 100.65)
    near(find(cells(on.value), 'Q2a').y, 104.2)
  })

  test('跨页：续页先重复标题行；行内切开的部分在下页顶部另占一道行顶边框', async () => {
    const before = Array.from({ length: 40 }, (_, k) => p(r(`P${k}:`))).join('')
    const rows = [
      { trPr: '<w:tblHeader/>', cells: [{ text: 'H0' }, { text: 'H1' }, { text: 'H2' }] },
      ...Array.from({ length: 29 }, (_, k) => ({
        cells: [{ text: `U${k + 1}a` }, { text: `U${k + 1}b` }, { text: `U${k + 1}c` }],
      })),
    ]
    const mid = Array.from({ length: 30 }, (_, k) => p(r(`Q${k}:`))).join('')
    const many = Array.from({ length: 12 }, (_, k) => p(r(`V${k}:`))).join('')
    const split = table(
      [2000, 3000, 2000],
      [
        { cells: [{ text: 'W0a' }, { text: 'W0b' }, { text: 'W0c' }] },
        { cells: [{ text: 'W1a' }, { body: many }, { text: 'W1c' }] },
        { cells: [{ text: 'W2a' }, { text: 'W2b' }, { text: 'W2c' }] },
      ],
    )
    const all = cells(
      await parse(before + table([2000, 3000, 2000], rows) + p(r('X:')) + mid + split),
    )
    expect([find(all, 'U16a').page, find(all, 'U17a').page]).toEqual([1, 2])
    expect(all[1]!.filter((c) => c.text === 'H0')).toHaveLength(1)
    near(find(all, 'U17a').y, 85.05)
    expect([find(all, 'V10').page, find(all, 'V11').page]).toEqual([2, 3])
    near(find(all, 'V11').y, 72.5)
    near(find(all, 'W2a').y, 85.05)
  })

  test('行高与单元格上下边距：最小值不含上下边距，固定值含上边距不含下边距；上一行的下边框与本行上边距重叠，本行上边框与上边距相加', async () => {
    // WPS（宋体五号一行文字 13.6 磅）：上下边距各 5 磅时最小值 30 磅的行高 40 磅；只有下边距 5 磅时固定值 30 磅的行高 35 磅，
    // 只有上边距时 30 磅；上边距 5 磅时上一行 1.5 磅下边框之下一行高 23.6 磅，本行 1.5 磅上边框时 25.1 磅，
    // 两者都有（本行 0.5 磅）时 24.1 磅；上边距 1 磅、上一行下边框 1.25 磅、本行上边框 nil 时 15.85 磅。
    const mar = (top: number, bottom: number) =>
      `<w:tblCellMar><w:top w:w="${top}" w:type="dxa"/><w:bottom w:w="${bottom}" w:type="dxa"/></w:tblCellMar>`
    const bd = (side: string, sz: number) =>
      `<w:${side} w:val="single" w:sz="${sz}" w:space="0" w:color="000000"/>`
    const three = (
      tag: string,
      first: { trPr?: string; tcPr?: string },
      second: string,
      tblPr: string,
    ) =>
      p(r(`${tag}:`)) +
      table(
        [2000, 2000],
        [
          {
            trPr: first.trPr ?? '',
            cells: [0, 1].map(() => ({ text: `${tag}0行`, tcPr: first.tcPr ?? '' })),
          },
          { cells: [0, 1].map(() => ({ text: `${tag}1行`, tcPr: second })) },
          { cells: [0, 1].map(() => ({ text: `${tag}2行` })) },
        ],
        tblPr,
        null,
      )
    const body =
      three('M', { trPr: '<w:trHeight w:val="600"/>' }, '', mar(100, 100)) +
      three('N', { trPr: '<w:trHeight w:val="600" w:hRule="exact"/>' }, '', mar(0, 100)) +
      three('K', { trPr: '<w:trHeight w:val="600" w:hRule="exact"/>' }, '', mar(100, 0)) +
      three('P', { tcPr: `<w:tcBorders>${bd('bottom', 12)}</w:tcBorders>` }, '', mar(100, 100)) +
      three('Q', {}, `<w:tcBorders>${bd('top', 12)}</w:tcBorders>`, mar(100, 100)) +
      three(
        'S',
        { tcPr: `<w:tcBorders>${bd('bottom', 12)}</w:tcBorders>` },
        `<w:tcBorders>${bd('top', 4)}</w:tcBorders>`,
        mar(100, 100),
      ) +
      three(
        'T',
        { tcPr: `<w:tcBorders>${bd('bottom', 10)}</w:tcBorders>` },
        '<w:tcBorders><w:top w:val="nil"/></w:tcBorders>',
        mar(20, 20),
      ) +
      p(r('Z:'))
    const all = cells(await parse(body))
    const step = (tag: string) => find(all, `${tag}1`).y - find(all, `${tag}0`).y
    near(step('M'), 40)
    near(step('N'), 35)
    near(step('K'), 30)
    near(step('P'), 23.6)
    near(step('Q'), 25.1)
    near(step('S'), 24.1)
    near(step('T'), 15.85)
  })

  test('跨页处的边框：续页开头的整行下移上框线的高度，切开的行在续页只占本行的行顶边框；两处都绘制上下框线', async () => {
    // WPS：上下框线 1.5 磅、内框横线 0.5 磅；正文区 72–769.9 磅。整行跨页时续页第一行的文字在 73.5 磅；
    // 第二行切开时续页部分的文字在 72.5 磅，其后一行在 141.05 磅。本页底部与续页顶部都绘制 1.5 磅的线。
    const lead = (n: number) =>
      Array.from({ length: n }, (_, k) =>
        p(r(`F${k}`), '<w:spacing w:before="0" w:after="0" w:line="400" w:lineRule="exact"/>'),
      ).join('')
    const zero =
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar>'
    const frame = border(12, ['top', 'bottom']) + border(4, ['insideH'])
    const whole = table(
      [4000, 4000],
      Array.from({ length: 45 }, (_, k) => ({ cells: [{ text: `R${k}行` }, { text: `R${k}列` }] })),
      zero,
      frame,
    )
    const many = Array.from({ length: 16 }, (_, k) => p(r(`C${k}行`))).join('')
    const split = table(
      [4000, 4000],
      [
        { cells: [{ text: 'G0首行' }, { text: 'G0首列' }] },
        { cells: [{ body: many }, { text: 'G1右格' }] },
        { cells: [{ text: 'G2末行' }, { text: 'G2末列' }] },
      ],
      zero,
      frame,
    )
    const pageBreak = p('<w:r><w:br w:type="page"/></w:r>')
    const d = await parse(lead(19) + whole + pageBreak + lead(26) + split)
    const all = cells(d)
    const first = all.findIndex((pg) => pg.some((c) => c.text === 'R0行'))
    near(all[first + 1]![0]!.y, 73.5)
    const splitPage = all.findIndex((pg) => pg.some((c) => c.text === 'G0首行'))
    expect(all[splitPage + 1]![0]!.text).toBe('C11行')
    near(all[splitPage + 1]![0]!.y, 72.5)
    near(find(all, 'G2末行').y, 141.05)
    const pages = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages
    const widths = (page: number, y: number) =>
      pages[page]!.body.flatMap((it) => (it.kind === 'table' ? it.edges : []))
        .filter((e) => !e.vertical && e.line !== null && Math.abs(e.y - y) < 0.01)
        .map((e) => e.line!.strokes.map((k) => k.size))
    const part = (page: number) => pages[page]!.body.find((it) => it.kind === 'table')!
    // 本页底部的线上沿比该部分底边高 0.75 磅（WPS 屏幕 EMF：语料 32c9f4a4 第 32 页、0824436d 第 25 页）。
    const bottomOfFirst = part(first).top + part(first).height
    expect(widths(first, bottomOfFirst - 0.75)).toEqual([[1.5], [1.5]])
    expect(widths(first + 1, part(first + 1).top)).toEqual([[1.5], [1.5]])
    expect(widths(splitPage + 1, part(splitPage + 1).top)).toEqual([[1.5], [1.5]])
  })

  test('跨页：单元格中的行都能容纳、只有段后间距超出时整行移到下页；最小行高大于本页剩余空间时整行移到下页，切开的行在续页不小于最小值', async () => {
    // WPS：单元格段落段后 10 磅，第 20 行的文字可以容纳而段后间距超出正文区底边时，该行整行在下页（文字 73.5 磅）。
    // 最小值 120 磅、本页剩余 97.9 磅的行整行移到下页；最小值 100 磅、内容 12 行的行在本页留 10 行，
    // 续页部分仍高 100.5 磅（含 0.5 磅行顶边框），下一行文字在 173 磅。
    const lead = (n: number, line = 400) =>
      Array.from({ length: n }, (_, k) =>
        p(r(`F${k}`), `<w:spacing w:before="0" w:after="0" w:line="${line}" w:lineRule="exact"/>`),
      ).join('')
    const zero =
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar>'
    const after = '<w:spacing w:before="0" w:after="200" w:line="240" w:lineRule="auto"/>'
    const spaced = table(
      [4000, 4000],
      Array.from({ length: 30 }, (_, k) => ({
        cells: [{ body: p(r(`D${k}行`), after) }, { body: p(r(`D${k}列`), after) }],
      })),
      zero,
      border(12, ['top', 'bottom']),
    )
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, k) => p(r(`${tag}${k}行`))).join('')
    const minimum = (tag: string, twips: number, n: number) =>
      table(
        [4000, 4000],
        [
          {
            trPr: `<w:trHeight w:val="${twips}"/>`,
            cells: [{ body: lines(n, tag) }, { text: `${tag}右格` }],
          },
          { cells: [{ text: `${tag}下行` }, { text: `${tag}下列` }] },
        ],
        zero,
        border(4),
      )
    const pageBreak = p('<w:r><w:br w:type="page"/></w:r>')
    const all = cells(
      await parse(
        lead(1, 100) +
          lead(10) +
          spaced +
          pageBreak +
          lead(30) +
          minimum('X', 2400, 6) +
          pageBreak +
          lead(28) +
          minimum('Y', 2000, 12),
      ),
    )
    expect(find(all, 'D20行').page).toBe(find(all, 'D19行').page + 1)
    near(find(all, 'D20行').y, 73.5)
    // 第 2 页之后：分页符所在页、30 段填充所在页，最小值 120 磅的行在其下一页。
    expect(find(all, 'X0行').page).toBe(find(all, 'D20行').page + 2)
    near(find(all, 'X0行').y, 72.5)
    near(find(all, 'X下行').y, 193)
    expect(find(all, 'Y10行').page).toBe(find(all, 'Y0行').page + 1)
    near(find(all, 'Y下行').y, 173)
  })

  test('本页部分的底边框须与该部分的最后一行一起容纳在本页：表格结束时为表格底边框，未结束时同样', async () => {
    // WPS（q1–q4）：固定行高 20 磅，第三行底边在 769.4 磅（正文区底边 769.9 磅）。1.5 磅底边框时第三行移到下页，
    // 0.5 磅时留在本页；表格有第四行时第三行同样移到下页。
    const lead =
      Array.from({ length: 31 }, (_, k) =>
        p(r(`F${k}`), '<w:spacing w:before="0" w:after="0" w:line="400" w:lineRule="exact"/>'),
      ).join('') +
      p(r('补'), '<w:spacing w:before="0" w:after="0" w:line="348" w:lineRule="exact"/>')
    const zero =
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar>'
    const exact = (n: number, sz: number) =>
      table(
        [4000, 4000],
        Array.from({ length: n }, (_, k) => ({
          trPr: '<w:trHeight w:val="400" w:hRule="exact"/>',
          cells: [{ text: `E${k}行` }, { text: `E${k}列` }],
        })),
        zero,
        border(sz, ['bottom']),
      )
    const pageOf = async (n: number, sz: number) =>
      find(cells(await parse(lead + exact(n, sz) + p(r('后')))), 'E2行').page
    expect(await pageOf(3, 12)).toBe(2)
    expect(await pageOf(3, 4)).toBe(1)
    expect(await pageOf(4, 12)).toBe(2)
  })

  test('浮动表格：纵向相对文字时下移 tblpY；标题行不在续页重复', async () => {
    // WPS：tblpY 为 145 缇时表格比原位置低 7.25 磅；续页第一行为数据行，文字在 73.5 磅（上框线 1.5 磅）。
    const lead = Array.from({ length: 20 }, (_, k) =>
      p(r(`F${k}`), '<w:spacing w:before="0" w:after="0" w:line="400" w:lineRule="exact"/>'),
    ).join('')
    const rows = [
      { trPr: '<w:tblHeader/>', cells: [{ text: '标题甲' }, { text: '标题乙' }] },
      ...Array.from({ length: 40 }, (_, k) => ({
        cells: [{ text: `L${k}行` }, { text: `L${k}列` }],
      })),
    ]
    const zero =
      '<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/></w:tblCellMar>'
    const pos =
      '<w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:horzAnchor="page" w:tblpX="1812" w:tblpY="145"/>'
    const frame = border(12, ['top', 'bottom'])
    const inline = cells(await parse(lead + p(r('T')) + table([4000, 4000], rows, zero, frame)))
    const floating = cells(
      await parse(lead + p(r('T')) + table([4000, 4000], rows, pos + zero, frame)),
    )
    near(find(floating, '标题甲').y - find(inline, '标题甲').y, 7.25)
    expect(floating[1]!.some((c) => c.text === '标题甲')).toBe(false)
    expect(inline[1]!.some((c) => c.text === '标题甲')).toBe(true)
    near(floating[1]![0]!.y, 73.5)
  })

  test('浮动表格的横向位置：基准加 tblpX，不看对齐方式；兼容模式 15 单元格左边在该处，14 文字在该处加 tblInd', async () => {
    // WPS（页边距 90 磅、tblpX 1812 缇、单元格左边距 5.4 磅，构造文档 w11b）：第一个单元格文字的横坐标。
    const pos = (anchor: string) =>
      `<w:tblpPr w:leftFromText="180" w:rightFromText="180" w:vertAnchor="text" w:horzAnchor="${anchor}" w:tblpX="1812" w:tblpY="145"/>`
    const cases: [string, string, number, number][] = [
      ['page', '', 95.95, 90.55],
      ['page', '<w:tblInd w:w="400" w:type="dxa"/>', 95.95, 110.55],
      ['margin', '', 185.95, 180.55],
      ['text', '', 185.95, 180.55],
      ['text', '<w:jc w:val="center"/>', 185.95, 180.55],
    ]
    for (const [anchor, extra, c15, c14] of cases) {
      const body =
        p(r('前')) +
        table(
          [3000, 3000],
          [{ cells: [{ text: 'X甲' }, { text: 'X乙' }] }],
          pos(anchor) + extra,
          border(48),
        )
      const x15 = find(cells(await parse(body, compat(15))), 'X甲').x
      const x14 = find(cells(await parse(body, compat(14))), 'X甲').x
      near(x15, c15)
      near(x14, c14)
    }
  })

  test('内部边一侧无边框时，另一侧的边框须胜过表格虚框（0.5 磅、#c8c8c8）：更宽，或同宽且亮度不高于虚框', async () => {
    // WPS（构造文档 w11j、w11k，表格没有框线，只有第一列单元格的下边框与右边框）：
    const cases: [number, string, string, boolean][] = [
      [2, '000000', 'single', false],
      [3, '000000', 'single', false],
      [4, '000000', 'single', true],
      [4, 'C8C8C8', 'single', true],
      [4, 'FFFF00', 'single', true],
      [4, 'D0D0D0', 'single', false],
      [4, 'E7E7E7', 'single', false],
      [4, 'E7E7E7', 'double', false],
      [6, 'E7E7E7', 'single', true],
      [2, '000000', 'double', false],
    ]
    for (const [sz, color, val, drawn] of cases) {
      const side = (s: string) =>
        `<w:${s} w:val="${val}" w:sz="${sz}" w:space="0" w:color="${color}"/>`
      const tcPr = `<w:tcBorders>${side('bottom')}${side('right')}</w:tcBorders>`
      const body =
        p(r('前')) +
        table(
          [3000, 3000],
          [
            { cells: [{ text: '甲', tcPr }, { text: '乙' }] },
            { cells: [{ text: '丙' }, { text: '丁' }] },
          ],
          '',
          null,
        )
      const d = await parse(body)
      const cx = {
        layouter: new ParagraphLayouter(d, load().source, NO_HOST_FAMILIES),
        compatibilityMode: 14,
      }
      const laid = layoutTable(tables(d)[0]!, d.sections[0]!.columns[0]!.width, cx)
      const key = `${sz} ${color} ${val}`
      expect([key, laid.horizontal[1]![0] !== null]).toEqual([key, drawn])
      expect([key, laid.vertical[0]![1] !== null]).toEqual([key, drawn])
    }
  })

  test('单元格中的分页符与分栏符不起作用、不占宽度，换行符照常（语料 f3d0519d 第 47 页）', async () => {
    // WPS（构造文档 w11h）：「甲」分页符「乙」、「甲」分栏符「乙」与「甲乙」位置相同；「甲」换行「乙」为两行。
    const brk = (type: string) => `<w:r><w:br${type === '' ? '' : ` w:type="${type}"`}/></w:r>`
    const body = (type: string) =>
      p(r('前')) +
      table([3000, 3000], [{ cells: [{ body: p(r('甲') + brk(type) + r('乙')) }, { text: '右' }] }])
    const lines = async (type: string) => {
      const pages = layoutPages(await parse(body(type)), load(), NO_HOST_FAMILIES).pages.pages
      const t = pages[0]!.body.find((it) => it.kind === 'table')!
      if (t.kind !== 'table') throw new Error('不是表格')
      const para = t.items.find(
        (it) => it.kind === 'paragraph' && it.lines[0]!.fragments[0]?.text.startsWith('甲'),
      )
      if (para?.kind !== 'paragraph') throw new Error('不是段落')
      return para.lines.map((l) => l.fragments.map((f) => f.text).join(''))
    }
    expect(await lines('page')).toEqual(['甲乙'])
    expect(await lines('column')).toEqual(['甲乙'])
    expect(await lines('')).toEqual(['甲', '乙'])
  })
})

describe('绘制：表格边框与虚框', () => {
  test('有边框的边按线宽绘制，无边框的边画 1 像素 #c8c8c8 的虚框，按页面像素坐标每 4 像素留空 1 像素', () => {
    const table: PageTable = {
      kind: 'table',
      block: 0,
      rows: [0],
      top: 0,
      height: 30,
      fills: [{ x: 0, y: 0, width: 30, height: 30, color: '#ffc000' }],
      items: [],
      edges: [
        { vertical: false, x: 0, y: 0, length: 6, line: null },
        {
          vertical: true,
          x: 30,
          y: 0,
          length: 30,
          line: { strokes: [{ offset: 0, size: 3 }], color: '#ff0000', style: 'solid', space: 0 },
        },
      ],
    }
    const page: Page = {
      section: 0,
      width: 100,
      height: 100,
      number: '1',
      header: [],
      body: [table],
      footer: [],
      floats: [],
      background: null,
      borders: null,
      graphicFonts: null,
      hiddenMath: 0,
    }
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: [], draw: () => null },
      { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) },
      4 / 3,
    )
    const rects = ctx.named('fillRect').map((c) => [String(c.fillStyle), ...c.args])
    // 底纹在先，虚框跳过 x % 4 === 3 的像素。3 磅的竖线以中线为准为 4 像素宽的矩形，另加 1 缇：
    // 起点在整数像素处时覆盖 5 像素（WPS 屏幕 EMF：1.5 磅的线起点为整数像素时占 3 像素）。
    expect(rects.slice(1, 2)).toEqual([['#ffc000', 0, 0, 40, 40]])
    expect(rects.filter((c) => c[0] === '#c8c8c8').map((c) => c[1])).toEqual([0, 1, 2, 4, 5, 6, 8])
    expect(rects.find((c) => c[0] === '#ff0000')).toEqual(['#ff0000', 38, 0, 5, 40])
  })
})
