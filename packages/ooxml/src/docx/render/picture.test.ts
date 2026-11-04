/**
 * docx 中的图片与图元文件（WMF、EMF）。覆盖 `../load.ts`（图元文件的 imageFormat 计数）、`../parse/drawing.ts`
 * （w:object 中 v:imagedata 的裁剪比例）、`../parse/body.ts`（嵌入式图片的 a:srcRect）、`../page/build.ts`（requiredFonts
 * 与 Page.graphicFonts 含图元文件文字的字体）、`../../drawingml/paint/picture.ts`（decodePicture）与本目录的 `paint.ts`
 * （嵌入式图片、浮动对象与页面背景中图元文件的绘制）。
 *
 * 记录的读取与绘制规则见 `../../metafile/metafile.test.ts`；排版与绘制的用例读取本机 Windows 字体目录中的宋体与 Arial：
 * 其他平台跳过。
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePicture, type ImageDecoder } from '../../drawingml/paint/picture.ts'
import {
  placeableWmf,
  RED_RECT_WMF,
  RecordingCanvas,
  RecordingContext,
} from '../../drawingml/paint/test-helper.ts'
import { NO_HOST_FAMILIES } from '../../text/index.ts'
import { type DocxDocument, parseDocx } from '../index.ts'
import { layoutPages, requiredFonts } from '../page/build.ts'
import { buildDocx, p } from '../test-helper.ts'
import { DocxFonts, loadDocxFace } from './fonts.ts'
import { paintPage } from './paint.ts'

/** 红色画刷的矩形，与 Arial（ANSI_CHARSET）的文字「A」。 */
const DRAWING = placeableWmf([
  [0x02fc, 0, 0x00ff, 0, 0],
  [0x012d, 0],
  [0x041b, 40, 90, 10, 10],
  [0x02fb, -20 & 0xffff, 0, 0, 0, 400, 0, 0, 0, 0, 0x7241, 0x6169, 0x006c],
  [0x012d, 1],
  [0x0102, 1],
  [0x0a32, 0, 20, 1, 0, 0x41, 12],
])

/** 同 `DRAWING`，文字的逻辑字高为 50。 */
const TALL_TEXT = placeableWmf([
  [0x02fb, -50 & 0xffff, 0, 0, 0, 400, 0, 0, 0, 0, 0x7241, 0x6169, 0x006c],
  [0x012d, 0],
  [0x0102, 1],
  [0x0a32, 0, 20, 1, 0, 0x41, 12],
])

/** 含未实现的记录（ARC）。 */
const UNSUPPORTED = placeableWmf([[0x0817, 0, 0, 0, 0, 0, 0, 0, 0]])

const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'

function inlinePicture(embed: string): string {
  return (
    '<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/><a:graphic>' +
    `<a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:blipFill><a:blip r:embed="${embed}"/>` +
    '</pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
  )
}

/** 嵌入式图片，`a:srcRect` 为 `crop`。 */
function croppedPicture(embed: string, crop: string): string {
  return inlinePicture(embed).replace(
    `<a:blip r:embed="${embed}"/>`,
    `<a:blip r:embed="${embed}"/>${crop}`,
  )
}

function anchoredPicture(embed: string): string {
  return (
    '<w:r><w:drawing><wp:anchor simplePos="0" relativeHeight="1" behindDoc="0"><wp:simplePos x="0" y="0"/>' +
    '<wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
    '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
    '<wp:extent cx="1270000" cy="635000"/><wp:wrapNone/><a:graphic>' +
    `<a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:blipFill><a:blip r:embed="${embed}"/>` +
    '</pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1270000" cy="635000"/></a:xfrm>' +
    '<a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
  )
}

/** 345 × 66 磅的 OLE 对象，图片各边裁去 1/8（`8192f` 与小数 `0.125`）。 */
const OBJECT =
  '<w:r><w:object><v:shape id="s1" style="width:345pt;height:66pt" filled="f" stroked="f">' +
  '<v:imagedata r:id="rIdWmf" cropleft="8192f" croptop="0.125" cropright="8192f" cropbottom="8192f"/>' +
  '</v:shape></w:object></w:r>'

const SECT =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" ' +
  'w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'

async function parse(body: string): Promise<DocxDocument> {
  const image = (id: string, name: string, content: Uint8Array) => ({
    id,
    type: 'image',
    name,
    content,
    contentType: 'image/x-wmf',
  })
  const result = await parseDocx(
    buildDocx({
      body: body + SECT,
      extra: [
        image('rIdWmf', 'media/image1.wmf', DRAWING),
        image('rIdBad', 'media/image2.wmf', UNSUPPORTED),
        image('rIdRect', 'media/image3.wmf', RED_RECT_WMF),
        image('rIdTall', 'media/image4.wmf', TALL_TEXT),
      ],
    }),
  )
  if (!result.ok) throw new Error('解析失败')
  return result.value
}

const decoder: ImageDecoder = {
  file: async () => ({ width: 1, height: 1 }),
  pixels: async (width, height) => ({ width, height }),
}

describe('图元文件的解析与计数', () => {
  test('w:object 的裁剪比例：以 f 结尾时单位为 1/65536，否则为小数（语料 0824436d 封面）', async () => {
    const doc = await parse(p(OBJECT))
    const first = doc.body[0]
    if (first?.kind !== 'paragraph') throw new Error('不是段落')
    expect(first.images[0]!.crop).toEqual({ left: 0.125, top: 0.125, right: 0.125, bottom: 0.125 })
    expect(doc.unsupported).toEqual({})
  })

  test('嵌入式图片的 a:srcRect 为裁剪比例', async () => {
    const doc = await parse(p(croppedPicture('rIdWmf', '<a:srcRect l="10000" t="6440" r="891"/>')))
    const first = doc.body[0]
    if (first?.kind !== 'paragraph') throw new Error('不是段落')
    expect(first.images[0]!.crop).toEqual({ left: 0.1, top: 0.0644, right: 0.00891, bottom: 0 })
  })

  test('可以绘制的图元文件不计入 imageFormat（嵌入式图片与浮动对象相同）；含未实现记录的图元文件每次引用计一次', async () => {
    const doc = await parse(
      p(inlinePicture('rIdWmf')) + p(anchoredPicture('rIdWmf')) + p(inlinePicture('rIdBad')),
    )
    expect(doc.unsupported).toEqual({ imageFormat: 1 })
  })

  test('decodePicture：图元文件读取为绘制命令，含未实现记录时为 null；其余图片交给解码器', async () => {
    const drawn = await decodePicture(DRAWING, 'image/x-wmf', decoder)
    expect(drawn?.kind === 'metafile' && drawn.metafile.kind).toBe('wmf')
    expect(await decodePicture(UNSUPPORTED, 'image/x-wmf', decoder)).toBeNull()
    const png = await decodePicture(new Uint8Array([1]), 'image/png', decoder)
    expect(png).toEqual({
      kind: 'bitmap',
      bitmap: { width: 1, height: 1 },
      resolution: { x: 96, y: 96 },
    })
  })
})

describe.skipIf(process.platform !== 'win32')('图元文件的排版与绘制（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  // 字体在 beforeAll 中读取：跳过的 describe 回调同样在收集用例时执行，在此处读取会使其他平台报错。
  let arial!: ReturnType<typeof loadDocxFace>
  let faces: ReturnType<typeof loadDocxFace>[] = []
  beforeAll(() => {
    const simsun = loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)
    arial = loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'arial.ttf'))), 'Arial', 0)
    faces = [simsun, arial]
  })

  test('requiredFonts 含图元文件文字的字体；有图元文件的页面带字体表，绘制时按裁剪比例映射到对象框并裁剪到对象框', async () => {
    const doc = await parse(
      p(OBJECT) + p('<w:r><w:br w:type="page"/></w:r>') + p('<w:r><w:t>二</w:t></w:r>'),
    )
    expect(requiredFonts(doc, NO_HOST_FAMILIES)).toContain('Arial')
    const { pages } = layoutPages(doc, new DocxFonts(faces, '宋体'), NO_HOST_FAMILIES)
    expect(pages.pages[0]!.graphicFonts).not.toBeNull()
    expect(pages.pages[1]!.graphicFonts).toBeNull()
    const images = await Promise.all(
      pages.images.map((im) => decodePicture(im.bytes, im.contentType, decoder)),
    )
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      pages.pages[0]!,
      {
        faces: pages.faces,
        draw: (ref) => faces.find((f) => f.family === ref.family && f.bold === ref.bold) ?? null,
      },
      {
        images,
        parts: pages.images.map((im) => im.part),
        createCanvas: () => new RecordingCanvas(1, 1),
      },
    )
    // 对象框 460 × 88 像素；裁去各边 1/8 后，图片框 100 × 50 映射到 613.33 × 117.33 像素的矩形，
    // 左上角在对象框左上角之外 76.67、14.67 像素。
    const clip = ctx.named('rect')[0]!.args as number[]
    expect(clip.slice(2)).toEqual([460, 88])
    const [bx, by] = clip as [number, number]
    const red = ctx.calls.findIndex((c) => c.name === 'fill' && c.fillStyle === 'rgb(255,0,0)')
    expect(red).toBeGreaterThan(0)
    // 矩形 (10, 10)–(90, 40) 的左上角：(-76.67 + 10 × 6.133, -14.67 + 10 × 2.347) 取整。
    const corner = ctx.calls.slice(0, red).findLast((c) => c.name === 'moveTo')!
    expect(corner.args).toEqual([Math.round(bx - 15.333), Math.round(by + 8.8)])
    // 字号 20 × 2.347 取整为 47 像素；参考点横坐标 -76.67 + 20 × 6.133 = 46。逻辑字高 20 小于 50，为单色字形：
    // 着墨的行段与 Arial 在 ppem 47 下提示后的「A」相同，左边为参考点加左侧位点。
    expect(ctx.named('fillText').some((c) => c.args[0] === 'A')).toBe(false)
    const glyph = arial.hinting!.glyph(arial.text.metrics.glyphId(0x41), 47, false)
    const black = ctx.calls.filter((c) => c.name === 'fillRect' && c.fillStyle === 'rgb(0,0,0)')
    const runs = glyph.pixels.reduce(
      (n, v, i) => n + (v && (i % glyph.width === 0 || !glyph.pixels[i - 1]) ? 1 : 0),
      0,
    )
    expect(black).toHaveLength(runs)
    expect(Math.min(...black.map((c) => c.args[0] as number))).toBe(bx + 46 + glyph.bearingX)
  })

  test('图元文件文字的逻辑字高不小于 50 且 gasp 要求灰度时平滑，否则为单色字形', async () => {
    // WPS 文字实测（构造文件，Times New Roman 与 Symbol）：逻辑字高 49 及以下单色，50 及以上在 gasp 要求灰度的 ppem 平滑。
    const doc = await parse(p(inlinePicture('rIdTall')))
    const { pages } = layoutPages(doc, new DocxFonts(faces, '宋体'), NO_HOST_FAMILIES)
    const images = await Promise.all(
      pages.images.map((im) => decodePicture(im.bytes, im.contentType, decoder)),
    )
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      pages.pages[0]!,
      {
        faces: pages.faces,
        draw: (ref) => faces.find((f) => f.family === ref.family && f.bold === ref.bold) ?? null,
      },
      {
        images,
        parts: pages.images.map((im) => im.part),
        createCanvas: () => new RecordingCanvas(1, 1),
      },
    )
    // 图片框 100 × 50 映射到 133.33 × 66.67 像素：字号 50 × 1.333 取整为 67 像素，Arial 在该 ppem 的 gasp 要求灰度。
    expect(arial.grayscale(67)).toBe(true)
    const text = ctx.named('fillText').find((c) => c.args[0] === 'A')!
    expect(text.font).toBe('67px "Arial"')
  })

  test('浮动对象中的图元文件按图片填充回放，该页带字体表', async () => {
    const doc = await parse(p(anchoredPicture('rIdRect')))
    const { pages } = layoutPages(doc, new DocxFonts(faces, '宋体'), NO_HOST_FAMILIES)
    expect(pages.pages[0]!.graphicFonts).not.toBeNull()
    const images = await Promise.all(
      pages.images.map((im) => decodePicture(im.bytes, im.contentType, decoder)),
    )
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      pages.pages[0]!,
      { faces: pages.faces, draw: () => null },
      {
        images,
        parts: pages.images.map((im) => im.part),
        createCanvas: () => new RecordingCanvas(1, 1),
      },
    )
    // 对象框 100 × 50 磅（133.33 × 66.67 像素），矩形 (10, 10)–(90, 40) 映射到对象框内。
    const red = ctx.calls.find((c) => c.name === 'fill' && c.fillStyle === 'rgb(255,0,0)')
    expect(red).toBeDefined()
  })
})
