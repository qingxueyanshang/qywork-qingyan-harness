/**
 * docx 中的图表。覆盖 `../load.ts`（图表部件的读取与求值、主题覆盖、宿主规则、图表中图片部件的登记）、
 * `../parse/body.ts` 与 `../parse/drawing.ts`（嵌入式与浮动图表、含未实现内容的图表计数）、
 * `../page/build.ts`（嵌入式图表的放置、`requiredFonts` 与 `Page.graphicFonts`）、本目录的 `graphic.ts`（图表文字的字体）与 `chart.ts`（图表文字的点阵）
 * 与 `paint.ts`（图表的绘制、`pageImages`）。
 *
 * 期望值取自 WPS 12.1 只读打开构造文档后的屏幕显示（EMF 回放）：图表显示缓存值（与内嵌工作簿不同时）、按图表部件的
 * 主题覆盖取方案颜色、未写出格式的图表区有 0.75 磅边框。排版与绘制的用例读取本机 Windows 字体目录中的宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chart } from '../../drawingml/chart/model.ts'
import { parseHexColor } from '../../drawingml/color.ts'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { type DocxDocument, type Paragraph, parseDocx } from '../index.ts'
import type { InlineImage } from '../model.ts'
import { layoutPages, requiredFonts } from '../page/build.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { DocxFonts, loadDocxFace } from './fonts.ts'
import { pageImages, paintPage } from './paint.ts'

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const SECT =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" ' +
  'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'

/** 柱形图部件：缓存值 1、2，系列名「缓存系列」；`plot` 插入在图表组中，`space` 插入在 `chartSpace` 末尾。 */
function chartXml(plot = '', space = '', seriesFill = ''): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${REL}"><c:chart>` +
    '<c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>' +
    '<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/>' +
    `<c:pt idx="0"><c:v>缓存系列</c:v></c:pt></c:strCache></c:strRef></c:tx>${seriesFill}` +
    '<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>甲</c:v></c:pt>' +
    '<c:pt idx="1"><c:v>乙</c:v></c:pt></c:strCache></c:strRef></c:cat>' +
    '<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/>' +
    '<c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>' +
    `${plot}<c:axId val="1"/><c:axId val="2"/></c:barChart>` +
    '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
    '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>' +
    `</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart>${space}</c:chartSpace>`
  )
}

const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'

function inlineChart(id: string): string {
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="3810000" cy="2286000"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${id}"/></a:graphicData></a:graphic>` +
    '</wp:inline></w:drawing></w:r>'
  )
}

function anchoredChart(id: string): string {
  return (
    '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" ' +
    'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
    '<wp:positionH relativeFrom="column"><wp:posOffset>635000</wp:posOffset></wp:positionH>' +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>254000</wp:posOffset></wp:positionV>' +
    '<wp:extent cx="3048000" cy="2032000"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/>' +
    `<wp:docPr id="1" name="图表 1"/><a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="${id}"/>` +
    '</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
  )
}

function chartRels(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`
}

function themeXml(root: 'theme' | 'themeOverride', accent1: string): string {
  const schemes =
    '<a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
    `<a:accent1><a:srgbClr val="${accent1}"/></a:accent1></a:clrScheme>` +
    '<a:fontScheme name="f"><a:majorFont><a:latin typeface="宋体"/></a:majorFont><a:minorFont><a:latin typeface="宋体"/>' +
    '<a:ea typeface="宋体"/></a:minorFont></a:fontScheme><a:fmtScheme name="m"/>'
  const inner = root === 'theme' ? `<a:themeElements>${schemes}</a:themeElements>` : schemes
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:${root} xmlns:a="${A}">${inner}</a:${root}>`
}

async function parse(body: string, extra: Parameters<typeof buildDocx>[0]['extra'] = []) {
  const result = await parseDocx(
    buildDocx({ body: body + SECT, theme: themeXml('theme', '0000FF'), extra }),
  )
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

const chartPart = (content: string) => ({
  id: 'rIdChart',
  type: 'chart',
  name: 'charts/chart1.xml',
  content,
  contentType: CHART_TYPE,
})

function paragraphs(doc: DocxDocument): Paragraph[] {
  return doc.body.filter((b): b is Paragraph => b.kind === 'paragraph')
}

function chartOf(im: InlineImage): Chart | null {
  return im.graphic?.kind === 'chart' ? im.graphic.chart : null
}

describe('图表的读取与求值', () => {
  test('嵌入式图表取缓存值并按 WPS 表格的规则求值（图表区缺省有边框），不计入 chart', async () => {
    const doc = await parse(p(inlineChart('rIdChart')), [chartPart(chartXml())])
    const im = paragraphs(doc)[0]!.images[0]!
    expect(im.media).toBe(-1)
    expect(im.width).toBe(300)
    const chart = chartOf(im)!
    expect(chart.host).toBe('sheet')
    expect(chart.box.line).not.toBeNull()
    const s = chart.plot.groups[0]!.series[0]!
    expect(s.name).toBe('缓存系列')
    expect(s.values).toEqual([1, 2])
    expect(s.categories).toEqual(['甲', '乙'])
    expect(doc.unsupported).toEqual({})
  })

  test('图表部件引用主题覆盖时方案颜色取自主题覆盖', async () => {
    const doc = await parse(p(inlineChart('rIdChart')), [
      chartPart(chartXml()),
      {
        id: 'rIdChartRels',
        type: 'x',
        name: 'charts/_rels/chart1.xml.rels',
        content: chartRels(
          `<Relationship Id="rId1" Type="${REL}/themeOverride" Target="../theme/themeOverride1.xml"/>`,
        ),
      },
      {
        id: 'rIdOverride',
        type: 'x',
        name: 'theme/themeOverride1.xml',
        content: themeXml('themeOverride', 'FF0000'),
      },
    ])
    const fill = chartOf(paragraphs(doc)[0]!.images[0]!)!.plot.groups[0]!.series[0]!.box.fill
    expect(fill).toEqual({ kind: 'solid', color: parseHexColor('FF0000')! })
  })

  test('含未实现内容的图表与扩展图表计入 chart，对象框仍占位置', async () => {
    const doc = await parse(
      p(inlineChart('rIdChart')) +
        p(
          '<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><a:graphic>' +
            '<a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" r:id="rIdChart"/></a:graphicData>' +
            '</a:graphic></wp:inline></w:drawing></w:r>',
        ),
      [chartPart(chartXml('<c:serLines/>'))],
    )
    const [a, b] = paragraphs(doc)
    expect(a!.images[0]!.graphic).toBeNull()
    expect(b!.images[0]!.graphic).toBeNull()
    expect(doc.unsupported).toEqual({ chart: 2 })
  })

  test('浮动图表为 DrawingNode 中的 chart，对象框为 wp:extent', async () => {
    const doc = await parse(p(anchoredChart('rIdChart') + r('环绕的文字')), [chartPart(chartXml())])
    const a = paragraphs(doc)[0]!.anchors[0]!
    expect(a.drawing?.kind).toBe('chart')
    if (a.drawing?.kind !== 'chart') return
    expect(a.drawing.frame).toMatchObject({ x: 0, y: 0, width: 3048000, height: 2032000 })
    expect(a.width).toBe(240)
    expect(doc.unsupported).toEqual({})
  })

  test('图表中图片填充的部件登记为图片部件', async () => {
    const doc = await parse(p(inlineChart('rIdChart')), [
      chartPart(
        chartXml(
          '',
          '',
          `<c:spPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></c:spPr>`,
        ),
      ),
      {
        id: 'rIdChartRels',
        type: 'x',
        name: 'charts/_rels/chart1.xml.rels',
        content: chartRels(
          `<Relationship Id="rId1" Type="${REL}/image" Target="../media/bar.png"/>`,
        ),
      },
      { id: 'rIdBar', type: 'x', name: 'media/bar.png', content: 'PNG', contentType: 'image/png' },
    ])
    expect(doc.media.map((m) => m.part)).toEqual(['/word/media/bar.png'])
  })
})

describe.skipIf(process.platform !== 'win32')('图表的放置与绘制（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  const simsun = () =>
    loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)

  test('requiredFonts 含图表文字的字体与 MISSING_LATIN；有图表的页带图表文字的字体', async () => {
    const doc = await parse(
      p(r('正文')) + p('<w:r><w:br w:type="page"/></w:r>') + p(inlineChart('rIdChart')),
      [chartPart(chartXml())],
    )
    expect(requiredFonts(doc)).toEqual(expect.arrayContaining(['宋体', 'Segoe Print']))
    const { pages } = layoutPages(doc, new DocxFonts([simsun()], '宋体'))
    expect(pages.pages).toHaveLength(2)
    expect(pages.pages[0]!.graphicFonts).toBeNull()
    const fonts = pages.pages[1]!.graphicFonts!
    expect(fonts.named.some((n) => n.name === '宋体' && !n.bold && !n.italic)).toBe(true)
    expect(pages.faces[fonts.fallback]!.family).toBe('宋体')
  })

  test('独占一行的嵌入式图表在 1.5 倍行距中顶边与行顶对齐，按段落对齐方式居中；绘制图表区与图例文字', async () => {
    const doc = await parse(
      p(
        inlineChart('rIdChart'),
        '<w:jc w:val="center"/><w:spacing w:line="360" w:lineRule="auto"/>',
      ),
      [chartPart(chartXml())],
    )
    const { pages } = layoutPages(doc, new DocxFonts([simsun()], '宋体'))
    const page = pages.pages[0]!
    const item = page.body[0]!
    if (item.kind !== 'paragraph') throw new Error('不是段落')
    const c = item.graphics[0]!
    expect(item.images).toEqual([])
    expect(c.y).toBeCloseTo(item.lines[0]!.top, 6)
    expect(item.lines[0]!.height).toBeGreaterThan(c.height)
    expect(c.x).toBeCloseTo(90 + (415.3 - 300) / 2, 6)
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: pages.faces, draw: () => simsun() },
      { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) },
    )
    // 宋体 10 磅（13 像素）的汉字与数字都以单色字形画在设备像素上：汉字取内嵌点阵，数字没有点阵，取提示后光栅化的轮廓
    // （WPS 文字实测：图表中这一字号的数字同样不平滑）。
    expect(ctx.calls.filter((k) => k.name === 'fillText')).toEqual([])
    const bitmap = ctx.calls.filter(
      (k) => k.name === 'fillRect' && k.matrix.a === 1 && k.matrix.d === 1 && k.matrix.e === 0,
    )
    expect(bitmap.length).toBeGreaterThan(40)
    expect(bitmap.every((k) => (k.args as number[]).every((v) => Number.isInteger(v)))).toBe(true)
    expect(ctx.calls.some((k) => k.name === 'fill')).toBe(true)
  })

  test('pageImages 列出该页图表读取的图片', async () => {
    const doc = await parse(p(inlineChart('rIdChart')), [
      chartPart(
        chartXml(
          '',
          '',
          `<c:spPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></c:spPr>`,
        ),
      ),
      {
        id: 'rIdChartRels',
        type: 'x',
        name: 'charts/_rels/chart1.xml.rels',
        content: chartRels(
          `<Relationship Id="rId1" Type="${REL}/image" Target="../media/bar.png"/>`,
        ),
      },
      { id: 'rIdBar', type: 'x', name: 'media/bar.png', content: 'PNG', contentType: 'image/png' },
    ])
    const { pages } = layoutPages(doc, new DocxFonts([simsun()], '宋体'))
    const parts = pages.images.map((im) => im.part)
    expect(pageImages(pages.pages[0]!, parts)).toEqual([0])
  })
})
