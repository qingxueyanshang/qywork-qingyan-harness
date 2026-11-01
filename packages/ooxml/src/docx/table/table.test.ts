/**
 * docx 表格。覆盖 `../parse/table.ts`（表格、行、单元格属性与 `cnfStyle`）、`../resolve/table.ts`（表格样式链、
 * 条件格式的生效条件与叠加、单元格边框）、`layout.ts`（列宽与自动调整、横向位置、行高规则、边框占用的高度、
 * 纵向合并、单元格内容与纵向对齐、边框冲突）、`../page/build.ts` 与 `../page/paginate.ts` 中表格的分页与绘制项
 * （标题行重复、行内切开、表格中的行网格），以及 `../render/paint.ts` 的表格边框与虚框。
 *
 * 期望值取自 WPS 12.1 只读打开同样内容的构造文档后逐段取得的位置（`Range.Information(5)`、`Information(6)`）
 * 与 720 dpi 的页面 EMF 回放。排版用例读取本机 Windows 字体目录中的 Times New Roman 与宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { type DocxDocument, parseDocx, type TableBlock } from '../index.ts'
import { layoutPages } from '../page/build.ts'
import type { Page, PageItem, PageTable } from '../page/model.ts'
import { type DocxFace, DocxFonts, loadDocxFace } from '../render/fonts.ts'
import { paintPage } from '../render/paint.ts'
import { buildDocx, p, r } from '../test-helper.ts'

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
    const pages = layoutPages(d, load()).pages.pages
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
    const page = layoutPages(d, load()).pages.pages[0]!
    const second = page.body.filter((it): it is PageTable => it.kind === 'table')[1]!
    const between = second.edges.find((e) => e.vertical && Math.abs(e.x - 334.6) < 0.01)
    expect(between?.line).toMatchObject({ width: 3, color: '#ff0000' })
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
          line: { width: 3, color: '#ff0000', style: 'single', space: 0 },
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
      hidden: 0,
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
    // 底纹在先，虚框跳过 x % 4 === 3 的像素，3 磅的竖线以中线为准占 4 像素。
    expect(rects.slice(1, 2)).toEqual([['#ffc000', 0, 0, 40, 40]])
    expect(rects.filter((c) => c[0] === '#c8c8c8').map((c) => c[1])).toEqual([0, 1, 2, 4, 5, 6, 8])
    expect(rects.find((c) => c[0] === '#ff0000')).toEqual(['#ff0000', 38, 0, 4, 40])
  })
})
