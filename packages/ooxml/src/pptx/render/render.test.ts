/**
 * 覆盖范围：`slide.ts`（画布尺寸、背景、形状与组合的变换复合、文字不随水平翻转镜像、阴影与隐藏形状，经由
 * `../../drawingml/shape/paint.ts`；图片绘制矩形取整，图元文件的图片与 `slideMetafileFonts`）、`ink.ts`（墨迹线段与圆点）、`../../drawingml/text/body.ts`
 * （行高与基线、行距与段间距换算、项目符号不计入行高、自动调整缩放、字符间距、
 * 项目符号与悬挂缩进、图片项目符号、`eaVert` 的直立东亚文字、自动编号、`slidenum`、不断行时的对齐平移）、`table.ts`（行高随文字增高、合并单元格的区域、边框）、
 * `../../drawingml/text/bullet.ts`、`fonts.ts` 与 `../../drawingml/text/fonts.ts`（字体名收集、仿粗体、合成斜体与正体各自的
 * 绘制字形、缺少字体、西文字体缺失时按 `charset` 的替代字体、缺少的符号字体、竖排直立字的旋转中心、点阵字形、ClearType 字形）、
 * `../../drawingml/text/math.ts`（公式取 `a14` 分支、行内与显示公式的行高与对齐、有项目符号时按行内排版、未实现的公式计数）、
 * `resources.ts`（图片部件收集、嵌入字体读取）；`../../drawingml/text/body.ts` 与 `../../drawingml/shape/paint.ts` 的锚定
 * （首行下沿超出行高的部分）与文字映像；`../parse/slide.ts` 与 `../load.ts` 的
 * `embeddedFontLst` 与可以绘制的图元文件；以及 `../resolve/` 与 `../../drawingml/shape/resolve.ts` 中为绘制补充的部分（内置表格样式、
 * 未指定西文字体为 Arial、竖排文字、图片项目符号、无法绘制的图片与未绘制的效果的计数）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import { extractFace } from '../../font/index.ts'
import type { FontMetrics } from '../../font/metrics.ts'
import type { VerticalMetrics } from '../../font/vertical.ts'
import type { ClearTypeDisplay, ClearTypeGlyphs, PixelData } from '../../glyph/cleartype/index.ts'
import { readMetafile } from '../../metafile/index.ts'
import type { TextFace } from '../../text/index.ts'
import { parsePptx } from '../load.ts'
import type { Presentation, Shape, Table } from '../model.ts'
import { buildPptx, type DeckSpec, para, run, slideXml, sp, text, xfrm } from '../test-helper.ts'
import {
  presentationFonts,
  readSlideFace,
  type SlideFace,
  type SlideFonts,
  slideMath,
} from './fonts.ts'
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

function slideFace(
  font: SlideFont,
  bitmaps: EmbeddedBitmaps | null = null,
  clearType: ClearTypeGlyphs | null = null,
): SlideFace {
  const ppem = (p: number) => ({
    ascent: Math.round(p * 0.86),
    descent: Math.round(p * 0.14),
    height: p,
    internalLeading: 0,
    externalLeading: 0,
  })
  return { ...font, bitmaps, pixelVertical: ppem, clearType, outlines: null, math: null }
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

/**
 * 记录绘制调用，另以白色不透明的像素缓冲区实现像素的读写（ClearType 字形）。`writes` 为每次写回像素时已记录的
 * 绘制调用数，用于判定写回与其他绘制的先后。
 */
class PixelContext extends RecordingContext {
  readonly pixels: Uint8ClampedArray
  readonly writes: number[] = []

  constructor(
    readonly width = 1600,
    readonly height = 1000,
  ) {
    super()
    this.pixels = new Uint8ClampedArray(4 * width * height).fill(255)
  }

  getImageData(sx: number, sy: number, sw: number, sh: number): PixelData {
    const data = new Uint8ClampedArray(4 * sw * sh)
    for (let y = 0; y < sh; y++) {
      const from = 4 * ((sy + y) * this.width + sx)
      data.set(this.pixels.subarray(from, from + 4 * sw), 4 * y * sw)
    }
    return { data, width: sw, height: sh }
  }

  putImageData(img: PixelData, dx: number, dy: number): void {
    this.writes.push(this.calls.length)
    for (let y = 0; y < img.height; y++)
      this.pixels.set(
        img.data.subarray(4 * y * img.width, 4 * (y + 1) * img.width),
        4 * ((dy + y) * this.width + dx),
      )
  }

  /** 颜色为 `[r, g, b]` 的像素坐标。 */
  find(rgb: readonly number[]): [number, number][] {
    const out: [number, number][] = []
    for (let i = 0; i < this.pixels.length; i += 4) {
      if (
        this.pixels[i] === rgb[0] &&
        this.pixels[i + 1] === rgb[1] &&
        this.pixels[i + 2] === rgb[2]
      )
        out.push([(i / 4) % this.width, Math.floor(i / 4 / this.width)])
    }
    return out
  }
}

function paint(
  p: Presentation,
  images: Record<string, PaintImage> = {},
  source: SlideFonts = fonts(),
  scale = 1,
  clearType: ClearTypeDisplay | null = null,
) {
  const ctx = new PixelContext()
  const factory = canvasFactory()
  paintSlide(
    ctx,
    p,
    p.slides[0]!,
    {
      fonts: source,
      clearType,
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
    const ctx = new PixelContext()
    const metafile = readMetafile(RED_RECT_WMF)!
    paintSlide(
      ctx,
      p,
      p.slides[0]!,
      {
        fonts: fonts(),
        clearType: null,
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
      { image: () => null, createCanvas: factory.create, metafileFonts: null },
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

  test('图片项目符号：高度为项目符号字号的 0.68 倍、宽度按宽高比，中心在首行的纵向中心；悬挂缩进不足或缩进为正时正文紧接图片右侧', async () => {
    const bullet = (rel: string, ppr: string) =>
      para(
        run('甲乙', '<a:rPr lang="zh-CN" sz="2400"/>'),
        `<a:pPr ${ppr}><a:buBlip><a:blip r:embed="${rel}"/></a:buBlip></a:pPr>`,
      )
    const hanging = 'marL="342900" indent="-342900"'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 300 * EMU),
              body: text(
                bullet('rIdSq', hanging) +
                  bullet('rIdWide', hanging) +
                  bullet('rIdSq', 'marL="228600" indent="228600"'),
              ),
            }),
          ),
          rels: [
            ['rIdSq', 'image', '../media/sq.png'],
            ['rIdWide', 'image', '../media/wide.png'],
          ],
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const sizes: Record<string, { width: number; height: number }> = {
      '/ppt/media/sq.png': { width: 40, height: 40 },
      '/ppt/media/wide.png': { width: 80, height: 40 },
    }
    const pictures = (part: string) => {
      const bitmap = sizes[part]
      return bitmap === undefined
        ? null
        : { kind: 'bitmap' as const, bitmap, resolution: SCREEN_RESOLUTION }
    }
    const faces = new FaceCache(fonts())
    const layout = layoutBody(s.text, 300, { faces, slideNumber: 1, pictures })
    const [sq, wide, positive] = layout.paragraphs
    const textX = (q: typeof sq) => q!.x + q!.block.lines[0]!.fragments[0]!.x
    // 字号 24 磅：高 16.32 磅。悬挂缩进 27 磅足够时正文从左缩进处开始。
    expect(sq!.bullet).toMatchObject({ part: '/ppt/media/sq.png', x: 0 })
    expect(sq!.bullet!.height).toBeCloseTo(16.32, 6)
    expect(sq!.bullet!.width).toBeCloseTo(16.32, 6)
    expect(textX(sq)).toBeCloseTo(27, 6)
    // 字框上沿 0.8、下沿 0.2：纵向中心在基线之上 0.3 倍字号。
    const line = sq!.block.lines[0]!
    expect(sq!.bullet!.y + sq!.bullet!.height / 2).toBeCloseTo(sq!.y + line.baseline - 7.2, 6)
    // 宽高比 2:1 的图片宽 32.64 磅，超出悬挂缩进：正文紧接图片右侧。
    expect(wide!.bullet!.width).toBeCloseTo(32.64, 6)
    expect(textX(wide)).toBeCloseTo(32.64, 6)
    // 首行缩进为正：图片在左缩进处，正文从首行缩进处开始。
    expect(positive!.bullet!.x).toBeCloseTo(18, 6)
    expect(textX(positive)).toBeCloseTo(36, 6)
  })

  /**
   * 原始失败形状：项目符号之后的制表符套用 WordprocessingML 列表的规则，取左缩进之前较近的默认制表位，正文比 WPS 靠左。
   * WPS 演示实测（构造文件）：左缩进 104 像素、悬挂 56 像素、默认制表位 96 像素时正文仍从左缩进处开始；左缩进之前的默认制表位
   * 与自定义制表位都不取；编号宽于悬挂缩进时正文紧接编号。
   */
  test('项目符号之后的正文从左缩进处开始，不取左缩进之前的制表位；项目符号越过左缩进时紧接其后', async () => {
    const r = run('甲乙', '<a:rPr lang="zh-CN" sz="2000"/>')
    const num = '<a:buFontTx/><a:buAutoNum type="arabicPeriod"/>'
    const dot = '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 300 * EMU),
              body: text(
                para(r, `<a:pPr marL="990600" indent="-533400" defTabSz="914400">${num}</a:pPr>`) +
                  para(
                    r,
                    `<a:pPr marL="1905000" indent="-1428750" defTabSz="476250">${dot}</a:pPr>`,
                  ) +
                  para(
                    r,
                    `<a:pPr marL="952500" indent="-952500">${dot}<a:tabLst><a:tab pos="571500" algn="l"/></a:tabLst></a:pPr>`,
                  ) +
                  para(
                    r,
                    '<a:pPr marL="285750" indent="-285750"><a:buFontTx/><a:buAutoNum type="arabicPeriod" startAt="10"/></a:pPr>',
                  ),
                '<a:bodyPr lIns="0" rIns="0"/>',
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const layout = layoutBody(s.text, 300, { faces: new FaceCache(fonts()), slideNumber: 1 })
    const textX = (i: number) => {
      const q = layout.paragraphs[i]!
      return q.x + q.block.lines[0]!.fragments[1]!.x
    }
    expect(textX(0)).toBeCloseTo(78, 6)
    expect(textX(1)).toBeCloseTo(150, 6)
    expect(textX(2)).toBeCloseTo(75, 6)
    // 「10.」三个半角字符宽 30 磅，越过 22.5 磅的左缩进。
    expect(textX(3)).toBeCloseTo(30, 6)
  })

  /**
   * 原始失败形状：合成斜体与正体共用一个排版字体对象，`of` 取到最后登记的绘制字形，页面上只要有一处斜体，同一字体的正文
   * 全部画成斜体（WPS 的导出图中正文为正体）。
   */
  test('同一字体的正体与合成斜体各有绘制字形：段落中正体、斜体、正体交替时各按其字形绘制', async () => {
    const regular = slideFace({ face: FACE, family: '甲', bold: false, italic: false })
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 100 * EMU),
              body: text(
                para(
                  run('正', '<a:rPr lang="zh-CN"><a:ea typeface="甲"/></a:rPr>') +
                    run('斜', '<a:rPr lang="zh-CN" i="1"><a:ea typeface="甲"/></a:rPr>') +
                    run('正', '<a:rPr lang="zh-CN"><a:ea typeface="甲"/></a:rPr>'),
                ),
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    const faces = new FaceCache(fonts({ 甲: regular }))
    const frags = layoutBody(s.text, 400, { faces, slideNumber: 1 }).paragraphs[0]!.block.lines[0]!
      .fragments
    expect(frags.map((f) => faces.of(f.face).italic)).toEqual([false, true, false])
    expect(frags.map((f) => faces.of(f.face).family)).toEqual(['甲', '甲', '甲'])
  })

  /** 原始失败形状：直立的字按 win 上下沿的中点转回直立，微软雅黑的列比 WPS 偏 4–9 像素。 */
  test('eaVert：直立的字以 typo 上下沿的中点为旋转中心', async () => {
    const typo = slideFace({
      face: { ...FACE, vertical: { ...FACE.vertical, typoAscender: 700, typoDescender: -300 } },
      family: '直',
      bold: false,
      italic: false,
    })
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 100 * EMU, 400 * EMU),
              body: text(
                para(run('甲', '<a:rPr lang="zh-CN" sz="2000"><a:ea typeface="直"/></a:rPr>')),
                '<a:bodyPr vert="eaVert"/>',
              ),
            }),
          ),
        },
      ],
    })
    const { ctx } = paint(p, {}, fonts({ 直: typo }))
    const han = ctx.named('fillText').find((c) => c.args[0] === '甲')
    // typo 上下沿 700、-300 的中点在基线之上 0.2 倍字号（win 上下沿 800、200 时为 0.3 倍）。
    expect(han?.args[2]).toBeCloseTo(0.2 * 20, 6)
  })

  test('eaVert：文本区域按 vert 旋转，汉字与顿号转回直立，西文随文字方向旋转', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 100 * EMU, 400 * EMU),
              body: text(para(run('甲a、')), '<a:bodyPr vert="eaVert"/>'),
            }),
          ),
        },
      ],
    })
    const { ctx } = paint(p)
    const calls = new Map(ctx.named('fillText').map((c) => [c.args[0], c.matrix]))
    const han = calls.get('甲')
    const latin = calls.get('a')
    const comma = calls.get('、')
    expect([han?.a, han?.b, han?.c, han?.d].map((v) => Math.round(v ?? 9))).toEqual([1, 0, 0, 1])
    expect([comma?.a, comma?.b].map((v) => Math.round(v ?? 9))).toEqual([1, 0])
    expect([latin?.a, latin?.b, latin?.c, latin?.d].map((v) => Math.round(v ?? 9))).toEqual([
      0, 1, -1, 0,
    ])
  })

  test('eaVert：形状旋转 270° 与竖排相抵时按横排绘制，汉字不再转回', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 100 * EMU, 400 * EMU, ' rot="16200000"'),
              body: text(para(run('甲a')), '<a:bodyPr vert="eaVert"/>'),
            }),
          ),
        },
      ],
    })
    const { ctx } = paint(p)
    for (const c of ctx.named('fillText')) {
      const m = c.matrix
      expect([m.a, m.b, m.c, m.d].map((v) => Math.round(v) + 0)).toEqual([1, 0, 0, 1])
    }
    expect(ctx.named('fillText').length).toBe(2)
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
   * 原始失败形状：模型不保留 `charset`，`charset="-122"` 的缺失西文字体以 Segoe Print 绘制。WPS 演示实测（构造文件）：GB2312
   * 为宋体、SHIFTJIS 为 Yu Gothic、HANGUL 为 Malgun Gothic、CHINESEBIG5 为 MingLiU-ExtB，0、1、2 与未写时为 Segoe Print。
   */
  test('缺失西文字体按 charset 取替代字体，替代字体名计入字体收集', async () => {
    const named = (family: string) => slideFace({ face: FACE, family, bold: false, italic: false })
    const source = fonts({
      宋体: FALLBACK,
      'Yu Gothic': named('Yu Gothic'),
      'Malgun Gothic': named('Malgun Gothic'),
      'MingLiU-ExtB': named('MingLiU-ExtB'),
      [MISSING_LATIN]: named(MISSING_LATIN),
    })
    const cache = new FaceCache(source)
    const family = (charset: number | undefined) =>
      cache.latin('QyMissing', charset, false, false).family
    expect([-122, -128, -127, -120, 0, 1, 2, undefined].map(family)).toEqual([
      '宋体',
      'Yu Gothic',
      'Malgun Gothic',
      'MingLiU-ExtB',
      MISSING_LATIN,
      MISSING_LATIN,
      MISSING_LATIN,
      MISSING_LATIN,
    ])
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 100 * EMU),
              body: text(
                para(
                  run(
                    'Ab',
                    '<a:rPr lang="en-US"><a:latin typeface="QyMissing" charset="-128"/></a:rPr>',
                  ),
                ),
              ),
            }),
          ),
        },
      ],
    })
    expect(presentationFonts(p)).toContain('Yu Gothic')
  })

  /**
   * 原始失败形状：主机没有 Wingdings 2 时项目符号「¡」以回退字体显示为「¡」。WPS 演示实测：以 Wingdings 中同一码位的
   * 字形绘制（○）；Wingdings 3 取 Symbol。
   */
  test('缺少的符号字体：项目符号与字段改用替代的符号字体，字符换算到其符号码位', async () => {
    const symbolOnly = fakeFace(
      () => 1000,
      (cp) => (cp >= 0xf020 && cp <= 0xf0ff ? 5 : 0),
    )
    const wingdings = slideFace({
      face: symbolOnly,
      family: 'Wingdings',
      bold: false,
      italic: false,
    })
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 100 * EMU),
              body: text(
                para(
                  run('甲', '<a:rPr lang="zh-CN"/>'),
                  '<a:pPr marL="254000" indent="-254000"><a:buFont typeface="Wingdings 2" pitchFamily="18" charset="2"/><a:buChar char="¡"/></a:pPr>',
                ),
              ),
            }),
          ),
        },
      ],
    })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    expect(presentationFonts(p)).toContain('Wingdings')
    const faces = new FaceCache(fonts({ Wingdings: wingdings }))
    const q = layoutBody(s.text, 400, { faces, slideNumber: 1 }).paragraphs[0]!
    expect(q.runs[0]!.text).toBe('\uf0a1\t')
    expect(faces.of(q.block.lines[0]!.fragments[0]!.face).family).toBe('Wingdings')
    expect(faces.get('Wingdings 2', false, false).family).toBe('Wingdings')
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
    expect(cache.latin('QyMissingLatinA', undefined, false, false).family).toBe(MISSING_LATIN)
    expect(
      cache.latin('QyMissingLatinA', undefined, true, false).face.metrics.advance(0x41, 1000),
    ).toBe(700)
    expect(cache.latin('微软雅黑', undefined, false, false).family).toBe('微软雅黑')
    expect(
      new FaceCache(fonts({ 微软雅黑: slideFace(yahei) })).latin(
        'QyMissingLatinA',
        undefined,
        false,
        false,
      ).family,
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

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
const windows = process.platform === 'win32'

/** 本机的 Cambria Math（cambria.ttc 第 2 个字体）。 */
function cambriaMath(): SlideFace {
  const bytes = extractFace(new Uint8Array(readFileSync(join(FONTS, 'cambria.ttc'))), 1)
  const face = readSlideFace(bytes, 'Cambria Math', false, false)
  if (face === null || face.math === null) throw new Error('Cambria Math 没有 MATH 表')
  return face
}

describe('公式', () => {
  const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
  const mr = (t: string) =>
    `<m:r><a:rPr lang="en-US" sz="2400" i="1"><a:latin typeface="Cambria Math"/></a:rPr><m:t>${t}</m:t></m:r>`
  const fraction = `${mr('𝑥')}${mr('=')}<m:f><m:num>${mr('𝑎')}${mr('+')}${mr('𝑏')}</m:num><m:den>${mr('2')}</m:den></m:f>`
  const display = (jc: string) =>
    `<a14:m><m:oMathPara xmlns:m="${M}"><m:oMathParaPr><m:jc m:val="${jc}"/></m:oMathParaPr><m:oMath>${fraction}</m:oMath></m:oMathPara></a14:m>`
  const inline = `<a14:m><m:oMath xmlns:m="${M}">${fraction}</m:oMath></a14:m>`
  const words = (t: string) => run(t, '<a:rPr lang="zh-CN" sz="2400"/>')
  /** 公式所在的形状放在要求 `a14` 的分支中，替代分支是写着 FALLBACK 的形状（与 PowerPoint 写出的结构相同）。 */
  const alternate = (body: string) =>
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
    'xmlns:a14="http://schemas.microsoft.com/office/drawing/2010/main"><mc:Choice Requires="a14">' +
    sp(10, { txBox: true, spPr: xfrm(0, 0, 400 * EMU, 400 * EMU), body }) +
    '</mc:Choice><mc:Fallback>' +
    sp(10, {
      txBox: true,
      spPr: xfrm(0, 0, 400 * EMU, 400 * EMU),
      body: text(para(words('FALLBACK'))),
    }) +
    '</mc:Fallback></mc:AlternateContent>'

  async function formulaText(body: string) {
    const p = await parse({ slides: [{ xml: slideXml(alternate(body)) }] })
    const s = find(p, 10)
    if (s.kind !== 'shape' || s.text === null) throw new Error('不是文本框')
    return { p, text: s.text }
  }

  /** 原始失败形状：取了替代分支，显示 PowerPoint 的替代图片（其中只有空格的段落带着占位符的项目符号）。 */
  test('取要求 a14 的分支，公式为字段；含矩阵的公式计入未实现的公式', async () => {
    const { p, text: t } = await formulaText(
      text(
        para(words('甲') + inline) +
          para(`<a14:m><m:oMath xmlns:m="${M}"><m:m/></m:oMath></a14:m>`),
      ),
    )
    expect(t.paragraphs[0]!.runs.map((r) => r.kind)).toEqual(['text', 'math'])
    expect(JSON.stringify(t)).not.toContain('FALLBACK')
    expect(p.slides[0]!.unsupported.math).toBe(1)
    expect(presentationFonts(p)).toContain('Cambria Math')
  })

  /**
   * WPS 演示实测（构造文件，24 磅；语料中强制换行之后的行内公式）：显示公式按 `m:jc` 对齐而与段落 `algn` 无关；只含显示
   * 分数的行高为公式的上下沿之和；行内分数使所在行增高；有项目符号的段落中的显示公式按行内样式排版（分数缩小）；强制换行
   * 之后独占一行的行内公式按显示样式排版。
   */
  test.skipIf(!windows)(
    '显示公式按 m:jc 对齐、行高为公式的上下沿之和；行内分数增高所在行；有项目符号时按行内排版',
    async () => {
      const source = fonts({ 'Cambria Math': cambriaMath() })
      const settings = { faces: new FaceCache(source), slideNumber: 1, math: slideMath(source) }
      const flat = '<a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0"/>'
      const right = await formulaText(text(para(display('right'), '<a:pPr algn="l"/>'), flat))
      const r = layoutBody(right.text, 300, settings).paragraphs[0]!
      const line = r.block.lines[0]!
      const last = line.objects.at(-1)!
      const segments = line.objects.map((o) => r.runs[o.run]!.formula!.layout)
      expect(r.x + r.shifts[0]! + last.x + segments.at(-1)!.width).toBeCloseTo(300, 6)
      const ascent = Math.max(...segments.map((g) => g.lineAscent))
      const descent = Math.max(...segments.map((g) => g.lineDescent))
      expect(line.height).toBeCloseTo(ascent + descent, 6)
      expect(line.height).toBeGreaterThan(24 * 1.2)

      const mixed = await formulaText(text(para(words('甲') + inline) + para(words('乙')), flat))
      const plain = await formulaText(text(para(words('甲')) + para(words('乙')), flat))
      const second = (t: TextBody) => layoutBody(t, 300, settings).paragraphs[1]!.y
      expect(second(mixed.text)).toBeGreaterThan(second(plain.text))

      const bulleted = await formulaText(
        text(
          para(
            display('centerGroup'),
            '<a:pPr marL="508000" indent="-508000"><a:buChar char="•"/></a:pPr>',
          ),
          flat,
        ),
      )
      const centered = await formulaText(text(para(display('centerGroup')), flat))
      // 墨迹的高度：行内样式的分数（分子分母缩小）低于显示样式。
      const height = (t: TextBody) =>
        Math.max(
          ...layoutBody(t, 300, settings).paragraphs[0]!.runs.map((x) =>
            x.formula === null ? 0 : x.formula.layout.ascent + x.formula.layout.descent,
          ),
        )
      expect(height(bulleted.text)).toBeLessThan(height(centered.text))

      const broken = await formulaText(
        text(para(`${words('甲')}<a:br><a:rPr lang="zh-CN" sz="2400"/></a:br>${inline}`), flat),
      )
      const own = layoutBody(broken.text, 300, settings).paragraphs[0]!
      const formulaLine = own.block.lines.findIndex((l) => l.objects.length > 0)
      expect(height(broken.text)).toBeCloseTo(height(centered.text), 6)
      const objects = own.block.lines[formulaLine]!.objects
      const lastSegment = own.runs[objects.at(-1)!.run]!.formula!.layout
      const start = own.x + own.shifts[formulaLine]! + objects[0]!.x
      const end = own.x + own.shifts[formulaLine]! + objects.at(-1)!.x + lastSegment.width
      expect((start + end) / 2).toBeCloseTo(150, 6)
    },
  )
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
      slides: [{ xml: slideXml(table('{00000000-0000-0000-0000-000000000001}', rows)) }],
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

  test('只写样式 ID 的「无样式，网格」「无样式，无网格」与中度样式 2 的深色与强调色 6', async () => {
    const rows = `<a:tr h="${10 * EMU}">${cell('甲')}${cell('乙')}</a:tr><a:tr h="${10 * EMU}">${cell('丙')}${cell('丁')}</a:tr>`
    const resolve = async (id: string) => {
      const p = await parse({ slides: [{ xml: slideXml(table(id, rows)) }] })
      expect(p.slides[0]!.unsupported.tableStyle).toBeUndefined()
      return find(p, 30) as Table
    }
    // WPS 演示导出图：网格为黑色 1 磅边框、无填充；无网格没有边框与填充；深色样式的首行为黑色，强调色 6 的首行为绿色。
    const grid = await resolve('{5940675A-B579-460E-94D1-54222C63F5DA}')
    expect(grid.rows[1]!.cells[0]!.borders.left?.width).toBe(12700)
    expect(grid.rows[1]!.cells[0]!.fill.kind).toBe('none')
    const plain = await resolve('{2D5ABB26-0587-4C30-8999-92F81FD0307C}')
    expect(plain.rows[1]!.cells[0]!.borders.left).toBeNull()
    expect(plain.rows[1]!.cells[0]!.fill.kind).toBe('none')
    const dark = await resolve('{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}')
    expect(dark.rows[0]!.cells[0]!.fill).toEqual({
      kind: 'solid',
      color: { r: 0, g: 0, b: 0, a: 1 },
    })
    const green = await resolve('{93296810-A885-4BE3-A3E7-6D5BEEA58F35}')
    expect(green.rows[0]!.cells[0]!.fill).toEqual({
      kind: 'solid',
      color: { r: 112 / 255, g: 173 / 255, b: 71 / 255, a: 1 },
    })
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

  test('竖排文字、无法解码的图片（含图片项目符号）与未绘制的效果（预设阴影）分别计数；eaVert、可以绘制的图片项目符号与形状的内部阴影不计数', async () => {
    const pic = (id: number, rid: string) =>
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${xfrm(0, 0, 10, 10)}${rect}</p:spPr></p:pic>`
    const preset =
      '<a:effectLst><a:prstShdw prst="shdw1" dist="1000"><a:srgbClr val="000000"/></a:prstShdw></a:effectLst>'
    const innerShadow =
      '<a:effectLst><a:innerShdw blurRad="1000" dist="1000"><a:srgbClr val="000000"/></a:innerShdw></a:effectLst>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              spPr: `${xfrm(0, 0, 10, 10)}${rect}${preset}`,
              body: text(
                para(run('甲'), '<a:pPr><a:buBlip><a:blip r:embed="rIdEmf"/></a:buBlip></a:pPr>'),
                '<a:bodyPr vert="wordArtVert"/>',
              ),
            }) +
              sp(11, {
                spPr: `${xfrm(0, 0, 10, 10)}${rect}${solid('FF0000')}${innerShadow}`,
                body: text(para(run('乙')), '<a:bodyPr vert="vert270"/>'),
              }) +
              sp(12, {
                spPr: xfrm(0, 0, 10, 10),
                body: text(
                  para(run('丙'), '<a:pPr><a:buBlip><a:blip r:embed="rIdPng"/></a:buBlip></a:pPr>'),
                  '<a:bodyPr vert="eaVert"/>',
                ),
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
      imageFormat: 2,
      effect: 1,
    })
    expect(slideImages(p.slides[0]!)).toEqual(['/ppt/media/image1.emf', '/ppt/media/image2.png'])
  })
})

describe('锚定与文字映像', () => {
  /** 纵向度量取自字体文件（Segoe Print、微软雅黑）的字体，em 为 1000。 */
  const metricFace = (family: string, ascent: number, descent: number, eastAsian: boolean) =>
    slideFace({
      face: {
        ...FACE,
        vertical: {
          ...FACE.vertical,
          winAscent: ascent,
          winDescent: descent,
          hheaAscender: ascent,
          hheaDescender: -descent,
          eastAsianCodePage: eastAsian,
        },
      },
      family,
      bold: false,
      italic: false,
    })
  const source = fonts({
    印: metricFace('印', 1247.6, 495.1, false),
    雅: metricFace('雅', 1058.1, 261.7, true),
  })
  const box = (id: number, x: number, anchor: string, font: string, size: number, effect = '') =>
    sp(id, {
      txBox: true,
      spPr: xfrm(x * EMU, 0, 300 * EMU, 150 * EMU),
      body: text(
        para(
          run(
            `${id}`,
            `<a:rPr lang="en-US" sz="${size * 100}">${effect}<a:latin typeface="${font}"/><a:ea typeface="${font}"/></a:rPr>`,
          ),
        ),
        `<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr>`,
      ),
    })
  /** 各文本框文字基线的设备纵坐标。 */
  const baselines = (p: Presentation) => {
    const { ctx } = paint(p, {}, source)
    return new Map(
      ctx
        .named('fillText')
        .map((c) => [c.args[0], c.matrix.d * (c.args[2] as number) + c.matrix.f]),
    )
  }

  /** 原始失败形状：锚定居中的 72 磅 Segoe Print 比 WPS 演示低 13 像素，锚定底端的 80 磅微软雅黑低 9 像素。 */
  test('锚定居中与底端时内容高度另加首行下沿超出行高的部分；锚定顶端不变', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            box(1, 0, 't', '印', 72) +
              box(2, 310, 'ctr', '印', 72) +
              box(3, 620, 't', '雅', 80) +
              box(4, 930, 'b', '雅', 80),
          ),
        },
      ],
    })
    const y = baselines(p)
    // WPS 演示导出图：相对锚定顶端，居中的 72 磅 Segoe Print 下移 (150 − 115.2) / 2 − 13 像素，
    // 底端的 80 磅微软雅黑下移 150 − 128 − 9 像素。
    expect(Math.abs(y.get('2')! - y.get('1')! - ((150 - 115.2) / 2 - 13))).toBeLessThanOrEqual(1)
    expect(Math.abs(y.get('4')! - y.get('3')! - (150 - 128 - 9))).toBeLessThanOrEqual(1)
  })

  test('文字映像逐行以基线为对称轴；dist 把映像框延长 dist × 字号 / 34.9，映像起点距基线为其两倍', async () => {
    const reflection = (dist: number) =>
      `<a:effectLst><a:reflection stA="100000" endA="0" endPos="100000" dist="${dist}" dir="5400000" sy="-100000" algn="bl" rotWithShape="0"/></a:effectLst>`
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            box(1, 0, 't', '印', 48, reflection(0)) + box(2, 310, 't', '印', 48, reflection(76200)),
          ),
        },
      ],
    })
    const y = baselines(p)
    const { ctx } = paint(p, {}, source)
    const flips = ctx.named('drawImage').filter((c) => c.matrix.d < 0)
    expect(flips.length).toBe(2)
    // 映像变换下基线 y 的像（绘制的基线取整到设备像素）：dist 为 0 时不动；dist 为 6 磅（48 磅）时 WPS 演示导出图中
    // 映像起点距基线 22 像素。
    const image = (m: { d: number; f: number }, v: number) => m.d * v + m.f
    expect(Math.abs(image(flips[0]!.matrix, y.get('1')!) - y.get('1')!)).toBeLessThanOrEqual(1)
    expect(Math.abs(image(flips[1]!.matrix, y.get('2')!) - y.get('2')! - 22)).toBeLessThanOrEqual(1)
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

describe('ClearType 字形', () => {
  /** 每个字形为 1 × 1、三个通道覆盖都为 6 的像素（混合后为文字颜色），记录每次请求的字形编号、ppem、合成粗体与斜体。 */
  const recordingGlyphs = (requests: unknown[][]): ClearTypeGlyphs => ({
    glyph: (id, ppem, bold, oblique) => {
      requests.push([id, ppem, bold, oblique])
      return { width: 1, height: 1, bearingX: 0, bearingY: 1, coverage: Uint8Array.from([6, 6, 6]) }
    },
  })
  // 每个字体须有自己的度量对象：排版按对象判定字体是否相同。
  const arial = (glyphs: ClearTypeGlyphs) =>
    slideFace(
      {
        face: fakeFace((cp) => (cp < 0x80 ? 500 : 1000)),
        family: 'Arial',
        bold: false,
        italic: false,
      },
      null,
      glyphs,
    )
  const deck = (rPr: string, bodyPr = '') =>
    parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 100 * EMU),
              body: text(
                para(
                  run(
                    'AB',
                    `<a:rPr lang="en-US" sz="1200"${rPr}>${solid('C00000')}<a:latin typeface="Arial"/></a:rPr>`,
                  ),
                ),
                bodyPr,
              ),
            }),
          ),
        },
      ],
    })

  /** 原始失败形状：WPS 演示的形状文字为 GDI 的 ClearType 绘制，此前一律以浏览器字体（`fillText`）绘制。 */
  test('显示器使用 ClearType 时形状文字按 ClearType 字形逐字写入画布像素，不调用 fillText；不使用时以 fillText 绘制', async () => {
    const p = await deck('')
    const requests: unknown[][] = []
    const on = paint(p, {}, fonts({ Arial: arial(recordingGlyphs(requests)) }), 1, {
      contrast: 1000,
    }).ctx
    expect(on.named('fillText')).toHaveLength(0)
    // 两个字各一个像素，位于整数设备坐标、同一基线；ppem 为 12 磅按 96 dpi 取整（16）。
    const ink = on.find([0xc0, 0, 0])
    expect(ink).toHaveLength(2)
    expect(ink[0]![1]).toBe(ink[1]![1])
    expect(requests).toEqual([
      [1, 16, false, false],
      [1, 16, false, false],
    ])
    const off = paint(p, {}, fonts({ Arial: arial(recordingGlyphs([])) }), 1, null).ctx
    expect(off.named('fillText').map((c) => c.args[0])).toEqual(['A', 'B'])
    expect(off.find([0xc0, 0, 0])).toHaveLength(0)
  })

  test('字体没有粗体、斜体字形时按合成粗体与合成斜体取 ClearType 字形', async () => {
    const requests: unknown[][] = []
    paint(await deck(' b="1" i="1"'), {}, fonts({ Arial: arial(recordingGlyphs(requests)) }), 1, {
      contrast: 1000,
    })
    expect(requests).toEqual([
      [1, 16, true, true],
      [1, 16, true, true],
    ])
  })

  test('旋转的文字与半透明的文字以 fillText 绘制', async () => {
    const source = fonts({ Arial: arial(recordingGlyphs([])) })
    const rotated = paint(await deck('', '<a:bodyPr rot="5400000"/>'), {}, source, 1, {
      contrast: 1000,
    }).ctx
    expect(rotated.named('fillText').map((c) => c.args[0])).toEqual(['A', 'B'])
    const translucent = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              txBox: true,
              spPr: xfrm(0, 0, 400 * EMU, 100 * EMU),
              body: text(
                para(
                  run(
                    'AB',
                    '<a:rPr lang="en-US" sz="1200"><a:solidFill><a:srgbClr val="C00000"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:latin typeface="Arial"/></a:rPr>',
                  ),
                ),
              ),
            }),
          ),
        },
      ],
    })
    const half = paint(translucent, {}, source, 1, { contrast: 1000 }).ctx
    expect(half.named('fillText').map((c) => c.args[0])).toEqual(['A', 'B'])
  })

  /** 原始失败形状：每个文本框各读写一次画布像素，每次读写都要先完成此前的绘制，含图片的幻灯片重绘耗时约翻倍。 */
  test('只画文字的相邻形状一并混合，在其后有填充的形状之前写回；幻灯片末尾写回其余的文字', async () => {
    const box = (id: number, y: number, fill = '<a:noFill/>') =>
      sp(id, {
        txBox: true,
        spPr: xfrm(0, y * EMU, 400 * EMU, 40 * EMU) + fill,
        body: text(
          para(
            run(
              'AB',
              `<a:rPr lang="en-US" sz="1200">${solid('C00000')}<a:latin typeface="Arial"/></a:rPr>`,
            ),
          ),
        ),
      })
    const p = await parse({
      slides: [
        { xml: slideXml(box(10, 0) + box(11, 50) + box(12, 100, solid('00FF00')) + box(13, 150)) },
      ],
    })
    const ctx = paint(p, {}, fonts({ Arial: arial(recordingGlyphs([])) }), 1, {
      contrast: 1000,
    }).ctx
    expect(ctx.named('fillText')).toHaveLength(0)
    // 第三个形状的填充是第一次以绿色绘制的调用。
    const green = ctx.calls.findIndex((c) => String(c.fillStyle).toLowerCase() === '#00ff00')
    expect(green).toBeGreaterThan(0)
    expect(ctx.writes).toHaveLength(2)
    expect(ctx.writes[0]).toBeLessThanOrEqual(green)
    expect(ctx.writes[1]).toBeGreaterThan(green)
    // 四个文本框的字都已写入：每个字一个文字颜色的像素。
    expect(ctx.find([0xc0, 0, 0])).toHaveLength(8)
  })
})
