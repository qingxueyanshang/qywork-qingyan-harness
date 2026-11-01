/**
 * 覆盖范围：`slide.ts`（画布尺寸、背景、形状与组合的变换复合、文字不随水平翻转镜像、阴影与隐藏形状，经由
 * `../../drawingml/shape/paint.ts`）、`../../drawingml/text/body.ts`（行距与段间距换算、自动调整缩放、字符间距、
 * 项目符号与悬挂缩进、自动编号、`slidenum`、不断行时的对齐平移）、`table.ts`（行高随文字增高、合并单元格的区域、边框）、
 * `../../drawingml/text/bullet.ts`、`fonts.ts` 与 `../../drawingml/text/fonts.ts`（字体名收集、仿粗体、缺少字体、
 * 西文字体缺失时的替代字体）、`resources.ts`（图片部件收集、嵌入字体读取）；`../parse/slide.ts` 与 `../load.ts` 的
 * `embeddedFontLst`；以及 `../resolve/` 与 `../../drawingml/shape/resolve.ts` 中为绘制补充的部分（内置表格样式、
 * 未指定西文字体为 Arial、竖排文字、图片项目符号、无法解码的图片与外部阴影之外的效果的计数）。
 */

import { describe, expect, test } from 'bun:test'
import type { PaintImage } from '../../drawingml/paint/context.ts'
import { canvasFactory, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { autofitScale, layoutBody, lineSpacing, paragraphSpace } from '../../drawingml/text/body.ts'
import { autoNumberText, symbolChar } from '../../drawingml/text/bullet.ts'
import {
  FaceCache,
  MISSING_LATIN,
  type SlideFont,
  type SlideFontSource,
} from '../../drawingml/text/fonts.ts'
import type { TextBody } from '../../drawingml/text/model.ts'
import type { FontMetrics } from '../../font/metrics.ts'
import type { VerticalMetrics } from '../../font/vertical.ts'
import type { TextFace } from '../../text/index.ts'
import { parsePptx } from '../load.ts'
import type { Presentation, Shape, Table } from '../model.ts'
import { buildPptx, type DeckSpec, para, run, slideXml, sp, text, xfrm } from '../test-helper.ts'
import { presentationFonts } from './fonts.ts'
import { readEmbeddedFonts, slideImages } from './resources.ts'
import { paintSlide, slideSize } from './slide.ts'
import { layoutTable } from './table.ts'

const EMU = 9525

function fakeFace(
  width: (cp: number) => number,
  glyph: (cp: number) => number = () => 1,
): TextFace {
  const metrics: FontMetrics = {
    unitsPerEm: 1000,
    numGlyphs: 100,
    glyphId: glyph,
    advanceWidth: width,
    advance: (cp, size) => (width(cp) * size) / 1000,
  }
  const vertical: VerticalMetrics = {
    unitsPerEm: 1000,
    hheaAscender: 800,
    hheaDescender: -200,
    hheaLineGap: 0,
    winAscent: 800,
    winDescent: 200,
    averageWidth: 500,
    eastAsianCodePage: false,
    superscriptSize: 650,
    superscriptOffset: 450,
    subscriptSize: 650,
    subscriptOffset: 140,
  }
  return { metrics, vertical }
}

/** 拉丁字符半宽、其余全宽；单倍行高为字号。 */
const FACE = fakeFace((cp) => (cp < 0x80 ? 500 : 1000))
const FALLBACK: SlideFont = { face: FACE, family: '宋体', bold: false, italic: false }

function fonts(known: Record<string, SlideFont> = {}): SlideFontSource {
  return { face: (name) => known[name] ?? null, fallback: FALLBACK }
}

async function parse(spec: DeckSpec): Promise<Presentation> {
  const r = await parsePptx(buildPptx(spec))
  if (!r.ok) throw new Error(JSON.stringify(r.failure))
  return r.value
}

function find(p: Presentation, id: number): Shape {
  const visit = (list: readonly Shape[]): Shape | null => {
    for (const s of list) {
      if (s.id === id && s.origin === 'slide') return s
      if (s.kind === 'group') {
        const inner = visit(s.children)
        if (inner !== null) return inner
      }
    }
    return null
  }
  const found = visit(p.slides[0]!.shapes)
  if (found === null) throw new Error(`没有 id=${id} 的形状`)
  return found
}

function paint(p: Presentation, images: Record<string, PaintImage> = {}) {
  const ctx = new RecordingContext()
  const factory = canvasFactory()
  paintSlide(
    ctx,
    p,
    p.slides[0]!,
    { fonts: fonts(), image: (part) => images[part] ?? null, createCanvas: factory.create },
    1,
  )
  return { ctx, layers: factory.created }
}

const solid = (hex: string) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`
const rect = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

describe('变换', () => {
  test('画布尺寸按缩放取整；背景铺满幻灯片', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml('', {
            bg: `<p:bg><p:bgPr>${solid('112233')}<a:effectLst/></p:bgPr></p:bg>`,
          }),
        },
      ],
    })
    expect(slideSize(p, 1)).toEqual({ width: 1280, height: 720 })
    expect(slideSize(p, 1.5)).toEqual({ width: 1920, height: 1080 })
    const { ctx } = paint(p)
    const fills = ctx.named('fill')
    expect(fills[0]!.fillStyle).toBe('#112233')
  })

  test('组合的旋转以组合框中心为原点作用于子形状', async () => {
    const child = sp(11, { spPr: `${xfrm(0, 0, 100 * EMU, 100 * EMU)}${rect}${solid('FF0000')}` })
    const group =
      '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="组合"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
      `<p:grpSpPr><a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="${200 * EMU}" cy="${100 * EMU}"/>` +
      `<a:chOff x="0" y="0"/><a:chExt cx="${200 * EMU}" cy="${100 * EMU}"/></a:xfrm></p:grpSpPr>${child}</p:grpSp>`
    const p = await parse({ slides: [{ xml: slideXml(group) }] })
    const { ctx } = paint(p)
    const fill = ctx.named('fill').find((c) => c.fillStyle === '#FF0000')!
    const m = fill.matrix
    // 子形状左上角 (0, 0)：绕组合中心 (100, 50) 顺时针旋转 90° 后位于 (150, -50)。
    expect(m.a * 0 + m.c * 0 + m.e).toBeCloseTo(150, 9)
    expect(m.b * 0 + m.d * 0 + m.f).toBeCloseTo(-50, 9)
    expect(m.b).toBeCloseTo(1, 9)
  })

  test('水平翻转的形状：几何镜像，文字不镜像；垂直翻转的文字旋转 180°', async () => {
    const shape = (id: number, flip: string) =>
      sp(id, {
        spPr: `${xfrm(0, 0, 200 * EMU, 100 * EMU, flip)}${rect}${solid('00FF00')}`,
        body: text(para(run('A', '<a:rPr lang="en-US" sz="1000"/>'))),
      })
    const p = await parse({
      slides: [{ xml: slideXml(shape(10, ' flipH="1"') + shape(11, ' flipV="1"')) }],
    })
    const { ctx } = paint(p)
    const geometry = ctx.named('fill').filter((c) => c.fillStyle === '#00FF00')
    expect(geometry[0]!.matrix.a).toBeCloseTo(-1, 9)
    const texts = ctx.named('fillText')
    const flipH = texts[0]!.matrix
    expect(flipH.a * flipH.d - flipH.b * flipH.c).toBeGreaterThan(0)
    expect(flipH.a).toBeCloseTo(4 / 3, 9)
    const flipV = texts[1]!.matrix
    expect(flipV.a).toBeCloseTo(-4 / 3, 9)
    expect(flipV.d).toBeCloseTo(-4 / 3, 9)
  })

  test('隐藏的形状不绘制；外部阴影经图层绘制', async () => {
    const shadow =
      '<a:effectLst><a:outerShdw blurRad="0" dist="95250" dir="0" algn="ctr" rotWithShape="0">' +
      '<a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:outerShdw></a:effectLst>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              spPr: `${xfrm(0, 0, 100 * EMU, 100 * EMU)}${rect}${solid('0000FF')}${shadow}`,
            }) +
              sp(11, {
                spPr: `${xfrm(0, 0, 100 * EMU, 100 * EMU)}${rect}${solid('ABCDEF')}`,
              }).replace('name="形状 11"', 'name="形状 11" hidden="1"'),
          ),
        },
      ],
    })
    const { ctx, layers } = paint(p)
    expect(ctx.named('fill').some((c) => c.fillStyle === '#ABCDEF')).toBe(false)
    expect(layers.length).toBe(1)
    expect(layers[0]!.context.named('fill')[0]!.fillStyle).toBe('#0000FF')
    const draws = ctx.named('drawImage')
    expect(draws.length).toBe(2)
  })
})

describe('文字输入换算', () => {
  test('行距、段间距与自动调整缩放', () => {
    expect(lineSpacing({ unit: 'percent', value: 1.5 }, 0.2)).toEqual({
      rule: 'proportional',
      value: 1.3,
    })
    expect(lineSpacing({ unit: 'points', value: 20 }, 0.2)).toEqual({ rule: 'fixed', value: 20 })
    expect(paragraphSpace({ unit: 'points', value: 6 }, 30)).toBe(6)
    expect(paragraphSpace({ unit: 'percent', value: 0.5 }, 30)).toBe(15)
    const body = (autofit: TextBody['body']['autofit']) =>
      autofitScale({
        rotation: 0,
        vertical: 'horz',
        wrap: true,
        insetLeft: 0,
        insetTop: 0,
        insetRight: 0,
        insetBottom: 0,
        anchor: 't',
        anchorCenter: false,
        columns: 1,
        columnSpacing: 0,
        rtlColumns: false,
        upright: false,
        autofit,
      })
    expect(body({ kind: 'normal', fontScale: 0.9, lineSpacingReduction: 0.1 })).toEqual({
      font: 0.9,
      lineReduction: 0.1,
    })
    expect(body({ kind: 'shape' })).toEqual({ font: 1, lineReduction: 0 })
  })

  test('悬挂缩进的项目符号：符号在首行起点，正文从左缩进处开始；字号乘以缩放比例', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 200 * EMU),
              body: text(
                para(
                  run('甲乙', '<a:rPr lang="zh-CN" sz="2000"/>'),
                  '<a:pPr marL="254000" indent="-254000"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>',
                ),
                '<a:bodyPr><a:normAutofit fontScale="50000"/></a:bodyPr>',
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const faces = new FaceCache(fonts())
    const layout = layoutBody(s.text, 300, { faces, slideNumber: 1 })
    const frags = layout.paragraphs[0]!.block.lines[0]!.fragments
    const para0 = layout.paragraphs[0]!
    expect(para0.x).toBe(20)
    expect(frags[0]!.x + para0.x).toBe(0)
    expect(frags[1]!.x + para0.x).toBe(20)
    expect(frags[1]!.size).toBe(10)
  })

  test('自动编号连续递增；slidenum 显示幻灯片编号；不断行时按对齐方式平移', async () => {
    const num = '<a:pPr marL="0" indent="0" algn="r"><a:buAutoNum type="arabicParenR"/></a:pPr>'
    const p = await parse({
      presentationAttrs: ' firstSlideNum="7"',
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 200 * EMU),
              body: text(
                para(run('a', '<a:rPr lang="en-US" sz="1000"/>'), num) +
                  para(
                    '<a:fld id="{1}" type="slidenum"><a:rPr lang="en-US" sz="1000"/><a:t>‹#›</a:t></a:fld>',
                    num,
                  ),
                '<a:bodyPr wrap="none"/>',
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const layout = layoutBody(s.text, 100, { faces: new FaceCache(fonts()), slideNumber: 7 })
    const texts = layout.paragraphs.map((q) => q.runs.map((r) => r.text).join(''))
    expect(texts).toEqual(['1)a', '2)7'])
    // 不断行：「1)a」宽 15 磅，右对齐在 100 磅内平移 85 磅。
    expect(layout.paragraphs[0]!.shifts[0]).toBeCloseTo(85, 9)
  })

  test('字符间距乘以自动调整的字号缩放后计入每个字的步进', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 200 * EMU),
              body: text(
                para(run('ab', '<a:rPr lang="en-US" sz="1000" spc="300"/>')),
                '<a:bodyPr><a:normAutofit fontScale="50000"/></a:bodyPr>',
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const layout = layoutBody(s.text, 300, { faces: new FaceCache(fonts()), slideNumber: 1 })
    expect(layout.paragraphs[0]!.block.lines[0]!.fragments[0]!.advances).toEqual([4, 4])
  })

  test('自动编号格式与符号字体码位', () => {
    expect(
      [
        ['alphaUcPeriod', 28],
        ['romanLcParenBoth', 14],
        ['circleNumDbPlain', 3],
        ['circleNumWdBlackPlain', 12],
        ['ea1ChsPeriod', 21],
        ['arabicDbPlain', 10],
        ['thaiNumPeriod', 4],
      ].map(([s, n]) => autoNumberText(s as string, n as number)),
    ).toEqual(['BB.', '(xiv)', '③', '⓬', '二十一．', '１０', '4.'])
    const symbol = fakeFace(
      () => 1000,
      (cp) => (cp >= 0xf020 && cp <= 0xf0ff ? 5 : 0),
    )
    expect(symbolChar('§', symbol)).toBe('')
    expect(symbolChar('§', FACE)).toBe('§')
  })

  test('仿粗体：请求粗体而返回常规字形时每字加宽字号的 1/256；缺少字体与空字体名用回退字体', () => {
    const regular: SlideFont = { face: FACE, family: '甲', bold: false, italic: false }
    const cache = new FaceCache(fonts({ 甲: regular }))
    const bold = cache.get('甲', true, false)
    expect(bold.face.metrics.advance(0x41, 256)).toBe(128 + 1)
    expect(bold.family).toBe('甲')
    expect(cache.get('乙', false, false).family).toBe('宋体')
    expect(cache.get('', false, false).family).toBe('宋体')
    expect(cache.of(bold.face)).toBe(bold)
  })

  /**
   * 原始失败形状：西文字体缺失时改用该字段的东亚字体。WPS 演示的导出图中，缺失西文字体的西文字符以 Segoe Print 绘制，
   * 与东亚字体无关。
   */
  test('西文字体缺失时西文字符取 Segoe Print 而不取东亚字体，粗体取其粗体字形；主机没有 Segoe Print 时用回退字体', async () => {
    const yahei: SlideFont = {
      face: fakeFace((cp) => (cp < 0x80 ? 550 : 1000)),
      family: '微软雅黑',
      bold: false,
      italic: false,
    }
    const print: SlideFont = {
      face: fakeFace(() => 600),
      family: MISSING_LATIN,
      bold: false,
      italic: false,
    }
    const printBold: SlideFont = { ...print, face: fakeFace(() => 700), bold: true }
    const source: SlideFontSource = {
      face: (name, bold) =>
        name === '微软雅黑' ? yahei : name === MISSING_LATIN ? (bold ? printBold : print) : null,
      fallback: FALLBACK,
    }
    const cache = new FaceCache(source)
    expect(cache.latin('QyMissingLatinA', false, false).family).toBe(MISSING_LATIN)
    expect(cache.latin('QyMissingLatinA', true, false).face.metrics.advance(0x41, 1000)).toBe(700)
    expect(cache.latin('微软雅黑', false, false).family).toBe('微软雅黑')
    expect(
      new FaceCache(fonts({ 微软雅黑: yahei })).latin('QyMissingLatinA', false, false).family,
    ).toBe('宋体')

    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400, 100),
              body: text(
                para(
                  run(
                    'Ab中',
                    '<a:rPr lang="zh-CN" sz="2000"><a:latin typeface="QyMissingLatinA"/><a:ea typeface="微软雅黑"/></a:rPr>',
                  ),
                ),
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('没有文本框')
    const settings = { faces: new FaceCache(source), slideNumber: 1 }
    const fragments = layoutBody(s.text, 400, settings).paragraphs[0]!.block.lines[0]!.fragments
    const families = fragments.map((f) => [
      'Ab中'.slice(f.start, f.end),
      settings.faces.of(f.face).family,
    ])
    expect(families).toEqual([
      ['Ab', MISSING_LATIN],
      ['中', '微软雅黑'],
    ])
  })
})

describe('表格', () => {
  const cell = (t: string, attrs = '') =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${para(run(t, '<a:rPr lang="zh-CN" sz="2000"/>'))}</a:txBody>` +
    '<a:tcPr marL="0" marR="0" marT="0" marB="0"><a:lnB w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnB></a:tcPr></a:tc>'
  const table = (styleId: string, rows: string) =>
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="30" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    `<p:xfrm><a:off x="0" y="0"/><a:ext cx="${200 * EMU}" cy="${20 * EMU}"/></p:xfrm>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>` +
    `<a:tblGrid><a:gridCol w="${100 * EMU}"/><a:gridCol w="${100 * EMU}"/></a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`

  test('行高取设定值与文字所需高度的较大者；合并单元格覆盖所跨区域；边框逐边绘制', async () => {
    const rows =
      `<a:tr h="${10 * EMU}">${cell('甲', ' gridSpan="2"')}${cell('', ' hMerge="1"')}</a:tr>` +
      `<a:tr h="${40 * EMU}">${cell('乙')}${cell('丙')}</a:tr>`
    const p = await parse({
      slides: [{ xml: slideXml(table('{5940675A-B579-460E-94D1-54222C63F5DA}', rows)) }],
    })
    const t = find(p, 30) as Table
    const layout = layoutTable(t, { faces: new FaceCache(fonts()), slideNumber: 1 })
    // 20 磅字号的单倍行高为 1.21 × 20 磅，即 32.27 像素，大于第一行的 10 像素。
    expect(layout.rows[1]).toBeCloseTo((20 * 1.21 * 4) / 3, 9)
    expect(layout.rows[2]! - layout.rows[1]!).toBeCloseTo(40, 9)
    expect(layout.cells.length).toBe(3)
    expect(layout.cells[0]!.width).toBe(200)
    const { ctx } = paint(p)
    expect(ctx.named('stroke').filter((c) => c.strokeStyle === '#FF0000').length).toBe(3)
    expect(p.slides[0]!.unsupported.tableStyle).toBe(1)
  })

  test('文件未写入的内置表格样式取收录的定义', async () => {
    const rows = `<a:tr h="${10 * EMU}">${cell('甲')}${cell('乙')}</a:tr><a:tr h="${10 * EMU}">${cell('丙')}${cell('丁')}</a:tr>`
    const p = await parse({
      slides: [{ xml: slideXml(table('{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}', rows)) }],
    })
    const t = find(p, 30) as Table
    expect(p.slides[0]!.unsupported.tableStyle).toBeUndefined()
    // 中度样式 2：首行为强调色 1 的实色填充，第一条带为强调色 1 的 40% 浅色。
    expect(t.rows[0]!.cells[0]!.fill).toEqual({
      kind: 'solid',
      color: { r: 68 / 255, g: 114 / 255, b: 196 / 255, a: 1 },
    })
    expect(t.rows[1]!.cells[0]!.fill.kind).toBe('solid')
  })
})

describe('求值阶段为绘制补充的内容', () => {
  test('未指定西文字体为 Arial；字体名与图片部件按首次出现收集', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 10, 10),
              body: text(
                para(run('甲'), '<a:pPr lvl="7"/>') +
                  para(run('乙', '<a:rPr lang="zh-CN"><a:latin typeface="Consolas"/></a:rPr>')),
              ),
            }) +
              '<p:pic><p:nvPicPr><p:cNvPr id="20" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
              '<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
              `<p:spPr>${xfrm(0, 0, 10, 10)}${rect}</p:spPr></p:pic>`,
          ),
          rels: [['rIdImg', 'image', '../media/image1.png']],
        },
      ],
      media: { 'ppt/media/image1.png': new Uint8Array([1, 2, 3]) },
    })
    expect(presentationFonts(p)).toEqual(['Arial', 'Calibri', 'Consolas', '等线', MISSING_LATIN])
    expect(slideImages(p.slides[0]!)).toEqual(['/ppt/media/image1.png'])
    const s = find(p, 10)
    const first = s.kind === 'shape' ? s.text?.paragraphs[0] : undefined
    expect([first?.end.latin, first?.end.ea]).toEqual(['Arial', ''])
  })

  test('竖排文字、图片项目符号、无法解码的图片与外部阴影之外的效果分别计数', async () => {
    const pic = (id: number, rid: string) =>
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(0, 0, 10, 10)}${rect}</p:spPr></p:pic>`
    const glow = '<a:effectLst><a:glow rad="1000"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              spPr: `${xfrm(0, 0, 10, 10)}${rect}${glow}`,
              body: text(
                para(run('甲'), '<a:pPr><a:buBlip><a:blip r:embed="rIdPng"/></a:buBlip></a:pPr>'),
                '<a:bodyPr vert="eaVert"/>',
              ),
            }) +
              sp(11, {
                spPr: xfrm(0, 0, 10, 10),
                body: text(para(run('乙')), '<a:bodyPr vert="vert270"/>'),
              }) +
              pic(20, 'rIdEmf') +
              pic(21, 'rIdPng'),
          ),
          rels: [
            ['rIdEmf', 'image', '../media/image1.emf'],
            ['rIdPng', 'image', '../media/image2.png'],
          ],
        },
      ],
      media: {
        'ppt/media/image1.emf': new Uint8Array([1]),
        'ppt/media/image2.png': new Uint8Array([1]),
      },
    })
    expect(p.slides[0]!.unsupported).toEqual({
      verticalText: 1,
      pictureBullet: 1,
      imageFormat: 1,
      effect: 1,
    })
  })
})

describe('嵌入字体', () => {
  test('embeddedFontLst 按字形列出部件；sfnt 字节原样使用，无法还原的部件计入 failed', async () => {
    const ttf = new Uint8Array(12 + 16)
    new DataView(ttf.buffer).setUint32(0, 0x00010000)
    new DataView(ttf.buffer).setUint16(4, 1)
    ttf.set([0x68, 0x65, 0x61, 0x64], 12)
    const spec: DeckSpec = {
      slides: [{ xml: slideXml('') }],
      presentationRels: [
        ['rIdF1', 'font', 'fonts/font1.fntdata'],
        ['rIdF2', 'font', 'fonts/font2.fntdata'],
      ],
      presentationExtra:
        '<p:embeddedFontLst><p:embeddedFont><p:font typeface="甲"/><p:regular r:id="rIdF1"/>' +
        '<p:bold r:id="rIdF2"/></p:embeddedFont></p:embeddedFontLst>',
      media: {
        'ppt/fonts/font1.fntdata': ttf,
        'ppt/fonts/font2.fntdata': new Uint8Array([1, 2, 3]),
      },
    }
    const bytes = buildPptx(spec)
    const r = await parsePptx(bytes)
    if (!r.ok) throw new Error('解析失败')
    expect(r.value.embeddedFonts).toEqual([
      { typeface: '甲', bold: false, italic: false, part: '/ppt/fonts/font1.fntdata' },
      { typeface: '甲', bold: true, italic: false, part: '/ppt/fonts/font2.fntdata' },
    ])
    const out = await readEmbeddedFonts(bytes, r.value.embeddedFonts)
    expect(out.fonts.map((f) => [f.typeface, f.bold, f.bytes.length])).toEqual([['甲', false, 28]])
    expect(out.failed).toEqual(['/ppt/fonts/font2.fntdata'])
  })
})
