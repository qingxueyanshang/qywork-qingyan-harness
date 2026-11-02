/**
 * 覆盖范围：`slide.ts`（画布尺寸、背景、形状与组合的变换复合、文字不随水平翻转镜像、阴影与隐藏形状，经由
 * `../../drawingml/shape/paint.ts`；图片绘制矩形取整，图元文件的图片与 `slideMetafileFonts`）、`ink.ts`（墨迹线段与圆点）、`../../drawingml/text/body.ts`
 * （行高与基线、行距与段间距换算、项目符号不计入行高、自动调整缩放、字符间距、
 * 项目符号与悬挂缩进、自动编号、`slidenum`、不断行时的对齐平移）、`table.ts`（行高随文字增高、合并单元格的区域、边框）、
 * `../../drawingml/text/bullet.ts`、`fonts.ts` 与 `../../drawingml/text/fonts.ts`（字体名收集、仿粗体、缺少字体、
 * 西文字体缺失时的替代字体、点阵字形）、`resources.ts`（图片部件收集、嵌入字体读取）；`../parse/slide.ts` 与 `../load.ts` 的
 * `embeddedFontLst` 与可以绘制的图元文件；以及 `../resolve/` 与 `../../drawingml/shape/resolve.ts` 中为绘制补充的部分（内置表格样式、
 * 未指定西文字体为 Arial、竖排文字、图片项目符号、无法绘制的图片与外部阴影之外的效果的计数）。
 */

import { describe, expect, test } from 'bun:test'
import type { PaintImage } from '../../drawingml/paint/context.ts'
import { decodePicture } from '../../drawingml/paint/picture.ts'
import { SCREEN_RESOLUTION } from '../../drawingml/paint/resolution.ts'
import {
  canvasFactory,
  placeableWmf,
  RED_RECT_WMF,
  RecordingContext,
} from '../../drawingml/paint/test-helper.ts'
import {
  autofitScale,
  layoutBody,
  lineSpacing,
  paintBody,
  paragraphSpace,
} from '../../drawingml/text/body.ts'
import { autoNumberText, symbolChar } from '../../drawingml/text/bullet.ts'
import {
  FaceCache,
  MISSING_LATIN,
  type SlideFont,
  type SlideFontSource,
} from '../../drawingml/text/fonts.ts'
import type { TextBody } from '../../drawingml/text/model.ts'
import type { BitmapGlyph, EmbeddedBitmaps } from '../../font/bitmap.ts'
import type { FontMetrics } from '../../font/metrics.ts'
import type { VerticalMetrics } from '../../font/vertical.ts'
import { readMetafile } from '../../metafile/index.ts'
import type { TextFace } from '../../text/index.ts'
import { parsePptx } from '../load.ts'
import type { Presentation, Shape, Table } from '../model.ts'
import { buildPptx, type DeckSpec, para, run, slideXml, sp, text, xfrm } from '../test-helper.ts'
import { presentationFonts, type SlideFace, type SlideFonts } from './fonts.ts'
import { readEmbeddedFonts, readImages, slideImages } from './resources.ts'
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

function slideFace(font: SlideFont, bitmaps: EmbeddedBitmaps | null = null): SlideFace {
  const ppem = (p: number) => ({
    ascent: Math.round(p * 0.86),
    descent: Math.round(p * 0.14),
    height: p,
    internalLeading: 0,
    externalLeading: 0,
  })
  return { ...font, bitmaps, pixelVertical: ppem }
}

const FALLBACK = slideFace({ face: FACE, family: '宋体', bold: false, italic: false })

function fonts(known: Record<string, SlideFace> = {}): SlideFonts {
  const all = [FALLBACK, ...Object.values(known)]
  return {
    face: (name) => known[name] ?? null,
    fallback: FALLBACK,
    family: (family) => all.filter((f) => f.family === family),
  }
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

function paint(
  p: Presentation,
  images: Record<string, PaintImage> = {},
  source: SlideFonts = fonts(),
  scale = 1,
) {
  const ctx = new RecordingContext()
  const factory = canvasFactory()
  paintSlide(
    ctx,
    p,
    p.slides[0]!,
    {
      fonts: source,
      image: (part) => {
        const bitmap = images[part]
        return bitmap === undefined
          ? null
          : { kind: 'bitmap', bitmap, resolution: SCREEN_RESOLUTION }
      },
      createCanvas: factory.create,
    },
    scale,
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

describe('图片与墨迹', () => {
  test('读取的图片部件由 decodePicture 求出文件记录的分辨率', async () => {
    const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    const chars = (t: string) => [...t].map((c) => c.charCodeAt(0))
    const png = new Uint8Array([
      ...[0x89, ...chars('PNG'), 0x0d, 0x0a, 0x1a, 0x0a],
      ...[...be32(13), ...chars('IHDR'), ...new Array(13).fill(0), 0, 0, 0, 0],
      ...[...be32(9), ...chars('pHYs'), ...be32(5906), ...be32(5906), 1, 0, 0, 0, 0],
    ])
    const data = buildPptx({
      slides: [{ xml: slideXml(''), rels: [['rIdImg', 'image', '../media/image1.png']] }],
      media: { 'ppt/media/image1.png': png },
    })
    const part = (await readImages(data, ['/ppt/media/image1.png'])).get('/ppt/media/image1.png')!
    const decoded = await decodePicture(part.bytes.slice(), part.contentType, {
      file: async () => ({ width: 1, height: 1 }),
      pixels: async (width, height) => ({ width, height }),
    })
    expect(decoded?.kind === 'bitmap' ? decoded.resolution.x : 0).toBeCloseTo(150.01, 2)
  })

  const image: PaintImage = { width: 40, height: 20 }
  const device = (c: {
    args: readonly unknown[]
    matrix: { a: number; d: number; e: number; f: number }
  }) => {
    // `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`。
    const [, , , , , x, y, w, h] = c.args as number[]
    const m = c.matrix
    return [m.a * x! + m.e, m.d * y! + m.f, m.a * w!, m.d * h!]
  }

  test('图片的绘制矩形取整到设备像素（左上角 .5 向下取整，宽高各自四舍五入）；形状的图片填充不取整', async () => {
    const pic = (id: number, x: number, y: number, w: number, h: number) =>
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      '<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
      `<p:spPr>${xfrm(x, y, w, h)}${rect}</p:spPr></p:pic>`
    const filled = sp(12, {
      spPr: `${xfrm(10.25 * EMU, 20.75 * EMU, 30.5 * EMU, 10 * EMU)}${rect}<a:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`,
    })
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            pic(10, 500.5 * EMU, 50.5 * EMU, 400 * EMU, 300 * EMU) +
              pic(11, 21.75 * EMU, 99.25 * EMU, 1229.67 * EMU, 591.2 * EMU) +
              filled,
          ),
          rels: [['rIdImg', 'image', '../media/image1.png']],
        },
      ],
    })
    const draws = paint(p, { '/ppt/media/image1.png': image }).ctx.named('drawImage')
    const [a, b, c] = draws.map(device)
    expect(a).toEqual([500, 50, 400, 300])
    expect(b![0]).toBeCloseTo(22, 9)
    expect(b![1]).toBeCloseTo(99, 9)
    expect(b![2]).toBeCloseTo(1230, 9)
    expect(b![3]).toBeCloseTo(591, 9)
    expect(c![0]).toBeCloseTo(10.25, 9)
    expect(c![1]).toBeCloseTo(20.75, 9)
    expect(c![2]).toBeCloseTo(30.5, 9)
  })

  test('图片为图元文件：可以绘制的不计入 imageFormat，文字的字体列入 presentationFonts；图片框映射到图片矩形并回放', async () => {
    const pic = (id: number, rid: string, x: number) =>
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(x * EMU, 0, 200 * EMU, 100 * EMU)}${rect}</p:spPr></p:pic>`
    const text = placeableWmf([
      [0x02fb, -20 & 0xffff, 0, 0, 0, 400, 0, 0, 0, 0, 0x7241, 0x6169, 0x006c],
      [0x012d, 0],
      [0x0a32, 0, 20, 1, 0, 0x41, 12],
    ])
    const p = await parse({
      slides: [
        {
          xml: slideXml(pic(10, 'rIdRect', 0) + pic(11, 'rIdText', 300) + pic(12, 'rIdBad', 600)),
          rels: [
            ['rIdRect', 'image', '../media/image1.emf'],
            ['rIdText', 'image', '../media/image2.emf'],
            ['rIdBad', 'image', '../media/image3.emf'],
          ],
        },
      ],
      media: {
        'ppt/media/image1.emf': RED_RECT_WMF,
        'ppt/media/image2.emf': text,
        'ppt/media/image3.emf': placeableWmf([[0x0817, 0, 0, 0, 0, 0, 0, 0, 0]]),
      },
    })
    expect(p.slides[0]!.unsupported).toEqual({ imageFormat: 1 })
    expect(presentationFonts(p)).toContain('Arial')
    const ctx = new RecordingContext()
    const metafile = readMetafile(RED_RECT_WMF)!
    paintSlide(
      ctx,
      p,
      p.slides[0]!,
      {
        fonts: fonts(),
        image: (part) =>
          part === '/ppt/media/image1.emf' ? { kind: 'metafile', metafile, images: [] } : null,
        createCanvas: canvasFactory().create,
      },
      1.5,
    )
    // 图片矩形 200 × 100 按 1.5 倍为 300 × 150 设备像素；矩形 (10, 10) 换算为 (30, 30)。
    const red = ctx.calls.findIndex((c) => c.name === 'fill' && c.fillStyle === 'rgb(255,0,0)')
    expect(red).toBeGreaterThan(0)
    expect(ctx.calls.slice(0, red).findLast((c) => c.name === 'moveTo')!.args).toEqual([30, 30])
  })

  test('墨迹逐段画圆头线段，线宽取两端笔宽的平均值；单点笔画画为圆点', async () => {
    const ink =
      '<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:definitions><inkml:context xml:id="c">' +
      '<inkml:inkSource xml:id="s"><inkml:traceFormat><inkml:channel name="X"/><inkml:channel name="Y"/>' +
      '<inkml:channel name="F" max="100"/></inkml:traceFormat></inkml:inkSource></inkml:context>' +
      '<inkml:brush xml:id="b"><inkml:brushProperty name="width" value="0.2" units="cm"/></inkml:brush></inkml:definitions>' +
      '<inkml:trace brushRef="#b">0 0 50,10 0 50,20 0 100</inkml:trace><inkml:trace brushRef="#b">20 10 50</inkml:trace></inkml:ink>'
    const content =
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><mc:Choice Requires="p14">' +
      '<p:contentPart r:id="rIdInk"><p14:nvContentPartPr><p14:cNvPr id="20" name="墨迹"/></p14:nvContentPartPr>' +
      `<p14:xfrm><a:off x="${100 * EMU}" y="${50 * EMU}"/><a:ext cx="${200 * EMU}" cy="${100 * EMU}"/></p14:xfrm>` +
      '</p:contentPart></mc:Choice></mc:AlternateContent>'
    const p = await parse({
      slides: [{ xml: slideXml(content), rels: [['rIdInk', 'customXml', '../ink/ink1.xml']] }],
      media: { 'ppt/ink/ink1.xml': ink },
    })
    const { ctx } = paint(p)
    const strokes = ctx.named('stroke')
    // 笔刷 0.2 厘米（7.56 像素），压力 0.5 与 1 的笔宽分别为其 1 倍与 1.8 倍。
    const brush = (0.2 * 360000) / EMU
    expect(strokes.length).toBe(2)
    expect(strokes[0]!.lineWidth).toBeCloseTo(brush, 9)
    expect(strokes[1]!.lineWidth).toBeCloseTo(brush * 1.4, 9)
    const lines = ctx.named('lineTo')
    // 外接框 20 × 10 对应形状框 200 × 100 像素：每单位 10 像素。
    expect(lines.map((l) => l.args)).toEqual([
      [100, 0],
      [200, 0],
    ])
    expect(lines[0]!.matrix.e).toBeCloseTo(100, 9)
    const dot = ctx.named('ellipse')[0]!
    expect(dot.args.slice(0, 4)).toEqual([200, 100, brush / 2, brush / 2])
    expect(ctx.named('fill').length).toBeGreaterThanOrEqual(1)
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

  test('单倍行高为 1.2 倍字号；行高与单倍行高之差的 1/1.2 加在文字上方；纵向中心按代码页分两组；段距百分比相对单倍行高', async () => {
    const EA = slideFace({
      face: { ...FACE, vertical: { ...FACE.vertical, eastAsianCodePage: true } },
      family: '东亚',
      bold: false,
      italic: false,
    })
    const tallEA = slideFace({
      face: {
        ...FACE,
        vertical: { ...FACE.vertical, winAscent: 1100, winDescent: 300, eastAsianCodePage: true },
      },
      family: '高东亚',
      bold: false,
      italic: false,
    })
    const lines = async (spacing: string, rPr: string, extra = '') => {
      const lnSpc = spacing === '' ? '' : `<a:lnSpc>${spacing}</a:lnSpc>`
      const pPr = `<a:pPr>${lnSpc}${extra}</a:pPr>`
      const body = text(para(run('甲', rPr), pPr) + para(run('乙', rPr), pPr))
      const p = await parse({ slides: [{ xml: slideXml(sp(10, { body })) }] })
      const shape = find(p, 10)
      if (shape.kind !== 'shape' || shape.text === null) throw new Error('没有文字')
      const faces = new FaceCache(fonts({ 东亚: EA, 高东亚: tallEA }))
      const layout = layoutBody(shape.text, 400, { faces, slideNumber: 1 })
      const first = layout.paragraphs[0]!.block.lines[0]!
      return { height: first.height, baseline: first.baseline, pitch: layout.paragraphs[1]!.y }
    }
    // 测试字体 `winAscent` 800、`winDescent` 200（每 1000 单位），20 磅：纵向中心距行顶 0.6012 × 20 磅，基线再下移 6 磅。
    const latin = '<a:rPr lang="en-US" sz="2000"/>'
    const single = await lines('', latin)
    expect(single.height).toBeCloseTo(24, 9)
    expect(single.pitch).toBeCloseTo(24, 9)
    expect(single.baseline).toBeCloseTo(0.6012 * 20 + 6, 9)
    const wide = await lines('<a:spcPct val="150000"/>', latin)
    expect(wide.height).toBeCloseTo(36, 9)
    expect(wide.baseline - single.baseline).toBeCloseTo(12 / 1.2, 9)
    const fixed = await lines('<a:spcPts val="3000"/>', latin)
    expect(fixed.height).toBeCloseTo(30, 9)
    expect(fixed.baseline - single.baseline).toBeCloseTo(6 / 1.2, 9)
    const eastAsian = await lines(
      '',
      '<a:rPr lang="zh-CN" sz="2000"><a:ea typeface="东亚"/></a:rPr>',
    )
    // 东亚字体的中心系数为 0.5825 − 0.03 × max(0, 上下沿之和 − 1.1)：上下沿之和为 1 时为 0.5825，为 1.4 时为 0.5735。
    expect(single.baseline - eastAsian.baseline).toBeCloseTo((0.6012 - 0.5825) * 20, 9)
    const tall = await lines('', '<a:rPr lang="zh-CN" sz="2000"><a:ea typeface="高东亚"/></a:rPr>')
    expect(tall.baseline).toBeCloseTo((0.5825 - 0.03 * 0.3 + 0.4) * 20, 9)
    const pct = '<a:spcPct val="50000"/>'
    const before = await lines('<a:spcPct val="150000"/>', latin, `<a:spcBef>${pct}</a:spcBef>`)
    expect(before.pitch).toBeCloseTo(36 + 0.5 * 24, 9)
    const after = await lines('<a:spcPct val="150000"/>', latin, `<a:spcAft>${pct}</a:spcAft>`)
    expect(after.pitch).toBeCloseTo(36 + 0.5 * 24, 9)
  })

  test('多种字体同行：基线按并集的上下沿与下沿最大的字体的纵向中心系数求出', async () => {
    // 西文测试字体上沿 0.8、下沿 0.2；东亚字体上沿 0.7、下沿 0.35（下沿最大），中心系数 0.5825。
    const EA = slideFace({
      face: {
        ...FACE,
        vertical: { ...FACE.vertical, winAscent: 700, winDescent: 350, eastAsianCodePage: true },
      },
      family: '东亚',
      bold: false,
      italic: false,
    })
    const first = async (runs: string) => {
      const p = await parse({ slides: [{ xml: slideXml(sp(10, { body: text(para(runs)) })) }] })
      const shape = find(p, 10)
      if (shape.kind !== 'shape' || shape.text === null) throw new Error('没有文字')
      const faces = new FaceCache(fonts({ 东亚: EA }))
      return layoutBody(shape.text, 400, { faces, slideNumber: 1 }).paragraphs[0]!.block.lines[0]!
    }
    const latin = run('Ag', '<a:rPr lang="en-US" sz="2000"/>')
    const eastAsian = run('甲', '<a:rPr lang="zh-CN" sz="2000"><a:ea typeface="东亚"/></a:rPr>')
    expect((await first(latin)).baseline).toBeCloseTo((0.6012 + 0.3) * 20, 9)
    const mixed = await first(latin + eastAsian)
    expect(mixed.height).toBeCloseTo(24, 9)
    expect(mixed.baseline).toBeCloseTo((0.5825 + (0.8 - 0.35) / 2) * 20, 9)
  })

  test('非纯色的文字填充以每一行为范围', async () => {
    const grad =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="50000"><a:srgbClr val="00FF00"/></a:gs>' +
      '<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>'
    const rPr = `<a:rPr lang="zh-CN" sz="2000">${grad}</a:rPr>`
    const body = text(para(run('甲乙', rPr)) + para(run('甲乙丙丁', rPr)))
    const p = await parse({ slides: [{ xml: slideXml(sp(10, { body })) }] })
    const shape = find(p, 10)
    if (shape.kind !== 'shape' || shape.text === null) throw new Error('没有文字')
    const faces = new FaceCache(fonts())
    const layout = layoutBody(shape.text, 400, { faces, slideNumber: 1 })
    const factory = canvasFactory()
    const target = {
      matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      width: 400,
      height: 300,
      scale: 1,
    }
    paintBody(
      new RecordingContext(),
      layout,
      target,
      faces,
      { image: () => null, createCanvas: factory.create },
      { width: 800, height: 600 },
      [],
    )
    const fills = factory.created.flatMap((c) =>
      c.context
        .named('fill')
        .filter((f) => (f.fillStyle as { kind?: string }).kind === 'linear')
        .map((f) => ({ points: (f.fillStyle as { points: number[] }).points })),
    )
    const lines = layout.paragraphs.map((q) => q.block.lines[0]!)
    expect(fills.map((f) => f.points[2]! - f.points[0]!)).toEqual(lines.map((l) => l.width))
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

  test('项目符号的字体与字号不改变行高与基线', async () => {
    const tall = slideFace({
      face: { ...FACE, vertical: { ...FACE.vertical, winAscent: 1100, winDescent: 300 } },
      family: '高',
      bold: false,
      italic: false,
    })
    const pPr =
      '<a:pPr marL="254000" indent="-254000"><a:buSzPct val="150000"/><a:buFont typeface="高"/><a:buChar char="•"/></a:pPr>'
    const body = text(
      para(run('甲', '<a:rPr lang="zh-CN" sz="2000"/>'), pPr) +
        para(run('乙', '<a:rPr lang="zh-CN" sz="2000"/>')),
    )
    const p = await parse({ slides: [{ xml: slideXml(sp(10, { body })) }] })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const faces = new FaceCache(fonts({ 高: tall }))
    const layout = layoutBody(s.text, 300, { faces, slideNumber: 1 })
    const [withBullet, plain] = layout.paragraphs.map((x) => x.block.lines[0]!)
    expect(withBullet!.fragments.length).toBe(2)
    expect(withBullet!.height).toBeCloseTo(plain!.height, 9)
    expect(withBullet!.baseline).toBeCloseTo(plain!.baseline, 9)
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
    const cache = new FaceCache(fonts({ 甲: slideFace(regular) }))
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
      new FaceCache(fonts({ 微软雅黑: slideFace(yahei) })).latin('QyMissingLatinA', false, false)
        .family,
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
    // 20 磅字号的单倍行高为 1.2 × 20 磅，即 32 像素，大于第一行的 10 像素。
    expect(layout.rows[1]).toBeCloseTo((20 * 1.2 * 4) / 3, 9)
    expect(layout.rows[2]! - layout.rows[1]!).toBeCloseTo(40, 9)
    expect(layout.cells.length).toBe(3)
    expect(layout.cells[0]!.width).toBe(200)
    const { ctx } = paint(p)
    expect(ctx.named('stroke').filter((c) => c.strokeStyle === '#FF0000').length).toBe(3)
    expect(p.slides[0]!.unsupported.tableStyle).toBe(1)
  })

  test('相邻单元格相同的边只画一次；不足 1 磅的边框按磅数乘不透明度', async () => {
    const ln = (tag: string) =>
      `<a:${tag} w="6350"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:${tag}>`
    const boxed = (t: string) =>
      `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${para(run(t, '<a:rPr lang="zh-CN" sz="1000"/>'))}</a:txBody>` +
      `<a:tcPr>${ln('lnL')}${ln('lnR')}${ln('lnT')}${ln('lnB')}</a:tcPr></a:tc>`
    const rows = `<a:tr h="${40 * EMU}">${boxed('甲')}${boxed('乙')}</a:tr><a:tr h="${40 * EMU}">${boxed('丙')}${boxed('丁')}</a:tr>`
    const p = await parse({ slides: [{ xml: slideXml(table('', rows)) }] })
    const strokes = paint(p)
      .ctx.named('stroke')
      .filter((c) => c.strokeStyle === '#000000')
    // 外框 8 段、内部竖线与横线各 2 段。
    expect(strokes.length).toBe(12)
    expect(strokes.every((c) => c.alpha === 0.5)).toBe(true)
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

describe('点阵字形', () => {
  /** 原始失败形状：WPS 演示中宋体 9–13 磅的形状文字按内嵌点阵绘制，此前一律按轮廓以平滑字形绘制。 */
  test('形状文字在有点阵的字号按点阵画在整数坐标上，其他字号按轮廓绘制；粗体由常规字形的点阵加粗，斜体取倾斜的单色字形', async () => {
    const glyph = {
      width: 2,
      height: 2,
      bearingX: 0,
      bearingY: 2,
      advance: 2,
      pixels: new Uint8Array([1, 1, 1, 1]),
    }
    // 合成斜体的单色字形：1 × 1。
    const slanted: BitmapGlyph = {
      ...glyph,
      width: 1,
      height: 1,
      bearingY: 1,
      pixels: new Uint8Array([1]),
    }
    const bitmaps: EmbeddedBitmaps = {
      sizes: [14],
      screenMode: (ppem) => ppem === 14,
      glyph: (ppem, _id, oblique) => (ppem === 14 ? (oblique ? slanted : glyph) : null),
    }
    const song = slideFace(
      {
        face: fakeFace((cp) => (cp < 0x80 ? 500 : 1000)),
        family: '宋体点阵',
        bold: false,
        italic: false,
      },
      bitmaps,
    )
    const deck = (rPr: string) =>
      parse({
        slides: [
          {
            xml: slideXml(
              sp(10, {
                txBox: true,
                spPr: xfrm(0, 0, 400, 100),
                body: text(
                  para(
                    run(
                      '国A',
                      `<a:rPr lang="zh-CN" sz="1050"${rPr}><a:latin typeface="宋体"/><a:ea typeface="宋体"/></a:rPr>`,
                    ),
                  ),
                ),
              }),
            ),
          },
        ],
      })
    const regular = await deck('')
    const rows = (ctx: RecordingContext) =>
      ctx.named('fillRect').filter((c) => c.args[3] === 1 && c.args.every(Number.isInteger))
    const at96 = paint(regular, {}, fonts({ 宋体: song }), 1).ctx
    expect(at96.named('fillText')).toHaveLength(0)
    expect(rows(at96).map((c) => c.args[2])).toEqual([2, 2, 2, 2])
    const zoomed = paint(regular, {}, fonts({ 宋体: song }), 1.5).ctx
    expect(zoomed.named('fillText').map((c) => c.args[0])).toEqual(['国', 'A'])
    const bold = paint(await deck(' b="1"'), {}, fonts({ 宋体: song }), 1).ctx
    expect(rows(bold).map((c) => c.args[2])).toEqual([3, 3, 3, 3])
    // 斜体同样不平滑：字体没有斜体字形时取倾斜的单色字形。
    const italic = paint(await deck(' i="1"'), {}, fonts({ 宋体: song }), 1).ctx
    expect(italic.named('fillText')).toHaveLength(0)
    expect(rows(italic).map((c) => c.args[2])).toEqual([1, 1])
  })
})
