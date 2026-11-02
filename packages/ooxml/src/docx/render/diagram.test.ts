/**
 * docx 中的 SmartArt。覆盖 `../load.ts`（主文档与页眉页脚引用的四个部件的读取与按文档主题求值）、
 * `../parse/body.ts` 与 `../parse/drawing.ts`（嵌入式与浮动 SmartArt、无法求值时计入 smartArt）、
 * `../page/build.ts`（嵌入式 SmartArt 的放置、`requiredFonts` 与 `Page.graphicFonts`）、本目录的 `paint.ts`（SmartArt 的绘制）。
 *
 * 布局定义取 `../../drawingml/diagram/test-helper.ts` 的 process1 结构；排版与绘制的用例读取本机 Windows 字体目录中的
 * 宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  colorsXml,
  dataXml,
  PROCESS,
  STYLES,
  THEME_XML,
} from '../../drawingml/diagram/test-helper.ts'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { type DocxDocument, type Paragraph, parseDocx } from '../index.ts'
import { layoutPages, requiredFonts } from '../page/build.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { DocxFonts, loadDocxFace } from './fonts.ts'
import { paintPage } from './paint.ts'

const DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram'
const SECT =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" ' +
  'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>'
const DATA = dataXml([['甲'], ['乙'], ['丙']], {
  node: 'node',
  trans: ['sibTrans', 'connectorText'],
})
const CT = 'application/vnd.openxmlformats-officedocument.drawingml.'

function relIds(n: number): string {
  return `<dgm:relIds xmlns:dgm="${DGM}" r:dm="rIdDm${n}" r:lo="rIdLo${n}" r:qs="rIdQs${n}" r:cs="rIdCs${n}"/>`
}

/** 5880735 × 1524000 EMU（463.05 × 120 磅）的嵌入式 SmartArt。 */
function inlineDiagram(n: number): string {
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="5880735" cy="1524000"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<a:graphic><a:graphicData uri="${DGM}">${relIds(n)}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  )
}

function anchoredDiagram(n: number): string {
  return (
    '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" ' +
    'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
    '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
    '<wp:extent cx="5880735" cy="521970"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapTopAndBottom/>' +
    `<wp:docPr id="${n}" name="图示 ${n}"/><a:graphic><a:graphicData uri="${DGM}">${relIds(n)}</a:graphicData>` +
    '</a:graphic></wp:anchor></w:drawing></w:r>'
  )
}

/** 第 `n` 个 SmartArt 的四个部件；`layout` 为 `null` 时不写布局定义部件。 */
function diagramParts(n: number, data = DATA, layout: string | null = PROCESS) {
  const parts = [
    { id: `rIdDm${n}`, type: 'diagramData', name: `diagrams/data${n}.xml`, content: data },
    {
      id: `rIdQs${n}`,
      type: 'diagramQuickStyle',
      name: `diagrams/quickStyle${n}.xml`,
      content: STYLES,
    },
    {
      id: `rIdCs${n}`,
      type: 'diagramColors',
      name: `diagrams/colors${n}.xml`,
      content: colorsXml(),
    },
  ]
  if (layout !== null)
    parts.push({
      id: `rIdLo${n}`,
      type: 'diagramLayout',
      name: `diagrams/layout${n}.xml`,
      content: layout,
    })
  return parts.map((x) => ({ ...x, contentType: `${CT}${x.type}+xml` }))
}

async function parse(body: string, extra: Parameters<typeof buildDocx>[0]['extra'] = []) {
  const result = await parseDocx(buildDocx({ body: body + SECT, theme: THEME_XML, extra }))
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

function paragraphs(doc: DocxDocument): Paragraph[] {
  return doc.body.filter((b): b is Paragraph => b.kind === 'paragraph')
}

describe('SmartArt 的读取与求值', () => {
  test('嵌入式 SmartArt 按四个部件与文档主题求值，对象框为 wp:extent，不计入 smartArt', async () => {
    const doc = await parse(p(inlineDiagram(1)), diagramParts(1))
    const g = paragraphs(doc)[0]!.images[0]!.graphic
    expect(g?.kind).toBe('diagram')
    if (g?.kind !== 'diagram') return
    expect(g.frame).toMatchObject({ x: 0, y: 0, width: 5880735, height: 1524000 })
    expect(g.diagram.root.children.length).toBeGreaterThan(0)
    expect(doc.unsupported).toEqual({})
  })

  test('浮动 SmartArt 为 DrawingNode 中的 diagram', async () => {
    const doc = await parse(p(anchoredDiagram(1) + r('其后的文字')), diagramParts(1))
    const a = paragraphs(doc)[0]!.anchors[0]!
    expect(a.drawing?.kind).toBe('diagram')
    expect(a.width).toBeCloseTo(463.05, 6)
    expect(doc.unsupported).toEqual({})
  })

  test('布局含未实现的算法、数据部件不存在时计入 smartArt，对象框仍占位置', async () => {
    const unknown = PROCESS.replace('<dgm:alg type="lin"/>', '<dgm:alg type="snake"/>')
    const doc = await parse(p(inlineDiagram(1)) + p(anchoredDiagram(2)) + p(inlineDiagram(3)), [
      ...diagramParts(1, DATA, unknown),
      ...diagramParts(2, DATA, unknown),
      ...diagramParts(3).filter((x) => x.type !== 'diagramData'),
    ])
    const [a, b, c] = paragraphs(doc)
    expect(a!.images[0]!.graphic).toBeNull()
    expect(a!.images[0]!.width).toBeCloseTo(463.05, 6)
    expect(b!.anchors[0]!.drawing).toBeNull()
    expect(c!.images[0]!.graphic).toBeNull()
    expect(doc.unsupported).toEqual({ smartArt: 3 })
  })

  test('页眉部件引用的 SmartArt 按页眉部件的关系表读取', async () => {
    const header =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ' +
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${p(inlineDiagram(1))}</w:hdr>`
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      diagramParts(1)
        .map(
          (x) =>
            `<Relationship Id="${x.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${x.type}" Target="${x.name}"/>`,
        )
        .join('') +
      '</Relationships>'
    const result = await parseDocx(
      buildDocx({
        body:
          p(r('正文')) +
          SECT.replace('<w:pgSz', '<w:headerReference w:type="default" r:id="rIdHdr"/><w:pgSz'),
        theme: THEME_XML,
        extra: [
          { id: 'rIdHdr', type: 'header', name: 'header1.xml', content: header },
          { id: 'rIdHdrRels', type: 'x', name: '_rels/header1.xml.rels', content: rels },
          // 部件只由页眉部件的关系表引用：主文档关系的类型不是 SmartArt 部件。
          ...diagramParts(1).map((x) => ({ ...x, id: `${x.id}Main`, type: 'x' })),
        ],
      }),
    )
    if (!result.ok) throw new Error('解析失败')
    const block = result.value.parts.rIdHdr![0]!
    expect(block.kind === 'paragraph' && block.images[0]!.graphic?.kind).toBe('diagram')
    expect(result.value.unsupported).toEqual({})
  })
})

describe.skipIf(process.platform !== 'win32')('SmartArt 的放置与绘制（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  const simsun = () =>
    loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)

  test('requiredFonts 含 SmartArt 文字的字体与 MISSING_LATIN；独占一行的 SmartArt 按段落对齐方式放置并绘制节点文字', async () => {
    const doc = await parse(
      p(r('正文')) +
        p('<w:r><w:br w:type="page"/></w:r>') +
        p(inlineDiagram(1), '<w:jc w:val="center"/>'),
      diagramParts(1),
    )
    expect(requiredFonts(doc)).toEqual(expect.arrayContaining(['MinorEA', 'Segoe Print']))
    const { pages } = layoutPages(doc, new DocxFonts([simsun()], '宋体'))
    expect(pages.pages).toHaveLength(2)
    expect(pages.pages[0]!.graphicFonts).toBeNull()
    const page = pages.pages[1]!
    expect(page.graphicFonts).not.toBeNull()
    const item = page.body.find((it) => it.kind === 'paragraph' && it.graphics.length > 0)
    if (item?.kind !== 'paragraph') throw new Error('没有 SmartArt')
    const g = item.graphics[0]!
    expect(g.graphic.kind).toBe('diagram')
    // 宽于版心（415.3 磅）时自版心左边开始；单倍行距中顶边与行顶对齐。
    expect(g.x).toBeCloseTo(90, 6)
    expect(g.y).toBeCloseTo(item.lines[0]!.top, 6)
    expect(g.width).toBeCloseTo(463.05, 6)
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: pages.faces, draw: () => simsun() },
      { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) },
    )
    const texts = ctx.calls.filter((k) => k.name === 'fillText').map((k) => String(k.args[0]))
    expect(texts.join('')).toBe('甲乙丙')
    expect(ctx.calls.filter((k) => k.name === 'fill').length).toBeGreaterThanOrEqual(5)
  })
})
