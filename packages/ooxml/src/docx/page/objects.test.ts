/**
 * docx 中对象的放置、页面边框与计数。覆盖 `../layout.ts`（独占一行的嵌入式对象的纵向位置）、`build.ts`（影响环绕的浮动
 * 对象横向不超出页面、纵向按兼容模式调整（`keepOnPage`）、不换行且根据文字调整大小的文本框的宽度（`fitAnchor`）、竖排文字与形状旋转
 * 相抵的文本框的文字区（`textBoxes`，含 `../parse/drawing.ts` 的 `turnedText`）、上下型对象使锚定段落移页、对象所属的页、页面边框的矩形、
 * 页眉页脚中未绘制图片与公式的计数、同页分为几部分的段落中的对象只放置一次、被推到上下型对象下方的行另加本段段前间距）、
 * `paginate.ts`（相对段落的对象的基准、与下段同页的段落组整体移页时舍弃已记录的对象、`overlaps` 中上一段与
 * 上下型对象相接的行、`fitRatio`）、`../render/paint.ts`（页面边框的线与四角）、
 * `../parse/body.ts` 与 `../load.ts`（页眉页脚中未实现元素按部件计数）、`../border.ts`（线型的线与间距）与段落边框占用的
 * 高度（`../layout.ts` 的 `contextSpacing`、`paginate.ts`、`../table/layout.ts` 的 `layoutStack`、`../parse/properties.ts`
 * 中带 `space` 的 `none`）。
 *
 * 期望值取自 WPS 12.1 只读打开构造文档后的屏幕显示（EMF 回放）与逐段取得的位置（`Range.Information(3)`、`Information(6)`）。
 * 排版用例读取本机 Windows 字体目录中的宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import { NO_HOST_FAMILIES } from '../../text/index.ts'
import { borderSpace, borderStrokes } from '../border.ts'
import { type DocxDocument, parseDocx } from '../index.ts'
import { DocxFonts, loadDocxFace } from '../render/fonts.ts'
import { paintPage } from '../render/paint.ts'
import { buildDocx, p, r } from '../test-helper.ts'
import { layoutPages } from './build.ts'
import type { BorderLine, Page, PageBorderBox, PageParagraph } from './model.ts'

const SECT = (extra = '', grid = '') =>
  `<w:sectPr>${extra}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" ` +
  `w:header="851" w:footer="992" w:gutter="0"/>${grid}</w:sectPr>`
const EMU = 12700
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const IMAGE = {
  id: 'rIdImg',
  type: 'image',
  name: 'media/image1.png',
  content: 'PNG',
  contentType: 'image/png',
}

function pic(w: number, h: number): string {
  return (
    `<pic:pic xmlns:pic="${PIC}"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm></pic:spPr></pic:pic>`
  )
}

function inline(w: number, h: number): string {
  return (
    `<w:r><w:drawing><wp:inline><wp:extent cx="${w * EMU}" cy="${h * EMU}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<a:graphic><a:graphicData uri="${PIC}">${pic(w, h)}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  )
}

function anchor(
  w: number,
  h: number,
  h0: readonly [string, number],
  v0: readonly [string, number],
  wrap: string,
  behind = false,
): string {
  return (
    '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="1" ' +
    `behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="${h0[0]}"><wp:posOffset>${h0[1] * EMU}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="${v0[0]}"><wp:posOffset>${v0[1] * EMU}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${w * EMU}" cy="${h * EMU}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}` +
    `<wp:docPr id="1" name="图片"/><a:graphic><a:graphicData uri="${PIC}">${pic(w, h)}</a:graphicData></a:graphic>` +
    '</wp:anchor></w:drawing></w:r>'
  )
}

async function parse(body: string, extra = [IMAGE], mode = 0): Promise<DocxDocument> {
  const settings =
    mode === 0
      ? undefined
      : `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="${mode}"/></w:compat>`
  const result = await parseDocx(
    buildDocx(settings === undefined ? { body, extra } : { body, extra, settings }),
  )
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

describe('paintPage：页面边框', () => {
  const red = (width: number, style = 'single'): BorderLine => ({
    strokes: borderStrokes(style, width),
    color: '#ff0000',
    style: 'solid',
    space: 24,
  })
  function rects(borders: PageBorderBox): string[] {
    const page: Page = {
      section: 0,
      width: 595.3,
      height: 841.9,
      number: '1',
      header: [],
      body: [],
      footer: [],
      floats: [],
      background: null,
      borders,
      graphicFonts: null,
      hiddenMath: 0,
    }
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: [], draw: () => null },
      { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) },
    )
    return ctx.calls
      .filter((c) => c.name === 'fillRect' && c.fillStyle === '#ff0000')
      .map((c) => c.args.join(' '))
  }

  test('相对页面：线的外缘距页面边缘 space 磅，线向内；四角相接（WPS：0.5 磅线位于第 32 行与第 1090 行）', () => {
    const l = red(0.5)
    const box = { x: 24, y: 24, width: 547.3, height: 793.9, inside: true }
    expect(rects({ ...box, top: l, bottom: l, left: l, right: l })).toEqual([
      '32 32 730 1',
      '32 1090 730 1',
      '32 32 1 1059',
      '761 32 1 1059',
    ])
  })

  test('复合线型按屏幕顺序排列，下边与右边的外缘在线组末端（WPS 页面 EMF：3 磅 thinThickSmallGap 与 thickThinLargeGap）', () => {
    const box = { x: 24, y: 24, width: 547.3, height: 793.9, inside: true }
    const rows = (style: string) => {
      const l = red(3, style)
      const out = rects({ ...box, top: l, bottom: l, left: null, right: null })
      return out
        .map((s) => s.split(' ').map(Number))
        .sort((a, b) => a[1]! - b[1]!)
        .map(([, y, , h]) => `${y}+${h}`)
    }
    expect(rows('thinThickSmallGap')).toEqual(['32+4', '37+1', '1085+4', '1090+1'])
    expect(rows('thickThinLargeGap')).toEqual(['32+1', '37+2', '1084+1', '1089+2'])
  })

  test('双线：两条线宽的线中间隔一个线宽，内线在内角相接（WPS：0.5 磅双线位于第 32 与 34 行）', () => {
    const l = red(0.5, 'double')
    const box = { x: 24, y: 24, width: 547.3, height: 793.9, inside: true }
    const out = rects({ ...box, top: l, bottom: null, left: l, right: null })
    expect(out).toEqual(['32 32 730 1', '34 34 728 1', '32 32 1 1059', '34 34 1 1057'])
  })

  test('相对正文：线的内缘距正文区 space 磅，线向外（WPS：1 磅线、space 4 磅位于第 90 行）', () => {
    const l = { ...red(1), space: 4 }
    const out = rects({
      x: 86,
      y: 68,
      width: 431.3,
      height: 713.9,
      inside: false,
      top: l,
      bottom: null,
      left: null,
      right: null,
    })
    expect(out).toEqual(['115 90 575 1'])
  })
})

describe.skipIf(process.platform !== 'win32')('build：对象的位置（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  let fonts: DocxFonts | null = null
  const load = (): DocxFonts => {
    fonts ??= new DocxFonts(
      [loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)],
      '宋体',
    )
    return fonts
  }
  const paragraphsOf = (page: Page) =>
    page.body.filter((it): it is PageParagraph => it.kind === 'paragraph')

  test('所在字段的基线提升使嵌入式图片与行的上下沿随之移动（WPS：w9-raise，30 磅图片下降 5 磅时行高 30 磅，提升 3 磅时 36.05 磅）', async () => {
    const raised = (pos: number) =>
      p(
        r('文字') +
          inline(40, 30).replace('<w:r>', `<w:r><w:rPr><w:position w:val="${pos}"/></w:rPr>`) +
          r('文字'),
        '<w:spacing w:line="240" w:lineRule="auto"/>',
      )
    const d = await parse(raised(-10) + raised(6) + SECT())
    const [down, up] = paragraphsOf(layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages[0]!)
    const bottom = (it: PageParagraph) => it.images[0]!.y + it.images[0]!.height - it.lines[0]!.top
    expect(down!.lines[0]!.height).toBeCloseTo(30, 6)
    expect(bottom(down!)).toBeCloseTo(30, 6)
    expect(up!.lines[0]!.height).toBeCloseTo(33 + (74 * 10.5) / 256, 6)
    expect(bottom(up!)).toBeCloseTo(30, 6)
  })

  test('独占一行的嵌入式图片：多倍行距顶边对齐行顶，对齐网格时上下均分，固定行距顶边对齐，最小行距底边对齐行底', async () => {
    // WPS 实测（构造文档 w5-grid、w5-nogrid）：80×70 磅图片，24 磅图片用于 30 磅固定行距；位置与下列规则一致。
    const cases = [
      ['<w:spacing w:line="360" w:lineRule="auto"/>', 70],
      ['<w:spacing w:line="600" w:lineRule="exact"/>', 24],
      ['<w:spacing w:line="2600" w:lineRule="atLeast"/>', 70],
    ] as const
    const body = (snap: boolean) =>
      cases
        .map(
          ([ppr, h]) =>
            p(r('上一行')) + p(inline(80, h), `${ppr}${snap ? '' : '<w:snapToGrid w:val="0"/>'}`),
        )
        .join('')
    for (const snap of [false, true]) {
      const grid = snap ? '<w:docGrid w:type="lines" w:linePitch="312"/>' : ''
      const d = await parse(body(snap) + SECT('', grid))
      const items = paragraphsOf(layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages[0]!).filter(
        (it) => it.images.length > 0,
      )
      const [multiple, exact, atLeast] = items.map((it) => ({
        im: it.images[0]!,
        line: it.lines[0]!,
      }))
      const free = multiple!.line.height - multiple!.im.height
      expect(free).toBeGreaterThan(1)
      expect(multiple!.im.y - multiple!.line.top).toBeCloseTo(snap ? free / 2 : 0, 6)
      expect(exact!.im.y).toBeCloseTo(exact!.line.top, 6)
      expect(exact!.line.height).toBeCloseTo(30, 6)
      expect(atLeast!.im.y + atLeast!.im.height).toBeCloseTo(
        atLeast!.line.top + atLeast!.line.height,
        6,
      )
    }
  })

  test('影响环绕的浮动对象横向不超出页面，wrapNone 不移动（WPS：右边超出时右对齐页面，左边超出时左对齐页面）', async () => {
    const square = '<wp:wrapSquare wrapText="bothSides"/>'
    const body =
      p(anchor(300, 100, ['column', 400], ['paragraph', 0], square) + r('一')) +
      p('<w:r><w:br w:type="page"/></w:r>') +
      p(anchor(300, 100, ['column', 400], ['paragraph', 0], '<wp:wrapNone/>') + r('二')) +
      p('<w:r><w:br w:type="page"/></w:r>') +
      p(anchor(300, 100, ['column', -150], ['paragraph', 0], square) + r('三')) +
      SECT()
    const pages = layoutPages(await parse(body), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages.map((pg) => pg.floats[0]!.x)).toEqual([595.3 - 300, 90 + 400, 0])
  })

  test('不换行且根据文字调整大小的文本框：宽度取文字宽度，按调整后的宽度对齐；换行的文本框保持记录的宽度', async () => {
    // WPS（x-autofit-width）：记录宽高 144 磅、内容为「48」的文本框相对页边距左、中、右对齐时，数字分别位于页边距
    // 左端、版心中央与右端；wrap 为 square 时文本框仍宽 144 磅，居中时左边在版心中央减 72 磅。
    const box = (align: string, wrap: string) =>
      '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" ' +
      'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
      `<wp:positionH relativeFrom="margin"><wp:align>${align}</wp:align></wp:positionH>` +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
      '<wp:extent cx="1828800" cy="1828800"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="1" name="文本框"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1828800" cy="1828800"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${p(r('48'))}</w:txbxContent></wps:txbx>` +
      `<wps:bodyPr wrap="${wrap}" lIns="0" tIns="0" rIns="0" bIns="0"><a:spAutoFit/></wps:bodyPr>` +
      '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    const body =
      ['left', 'center', 'right'].map((a) => p(box(a, 'none') + r('段'))).join('') +
      p(box('center', 'square') + r('段')) +
      SECT()
    const floats = layoutPages(await parse(body, []), load(), NO_HOST_FAMILIES).pages.pages[0]!
      .floats
    const textWidth = (k: number) => {
      const item = floats[k]!.texts[0]!.items[0]
      if (item?.kind !== 'paragraph') throw new Error('不是段落')
      return item.lines[0]!.fragments.reduce((w, f) => w + f.advances.reduce((a, b) => a + b, 0), 0)
    }
    const region = (11906 - 3600) / 20
    const w = textWidth(0)
    expect(w).toBeGreaterThan(5)
    expect(floats.slice(0, 3).map((f) => f.width)).toEqual([w, w, w])
    expect(floats[0]!.x).toBeCloseTo(90, 6)
    expect(floats[1]!.x).toBeCloseTo(90 + (region - w) / 2, 6)
    expect(floats[2]!.x).toBeCloseTo(90 + region - w, 6)
    expect(floats[3]!.width).toBeCloseTo(144, 6)
    expect(floats[3]!.x).toBeCloseTo(90 + (region - 144) / 2, 6)
    expect(textWidth(1)).toBeCloseTo(w, 9)
  })

  test('文本框内容超出形状时顶端对齐并裁剪：横向到形状外边缘，纵向到下内缩以内，内缩为 0 时到外边缘', async () => {
    // WPS（构造文档 w13 x1）：七行文字放进 140 × 60 磅的框，上、中、下三种纵向对齐都自上内缩处排起，裁到下内缩（3.6 磅）以内；
    // 内缩为 0 的框裁到外边缘；60 磅宽的框中 100 磅宽的图片裁到形状的右边缘。
    const box = (x: number, anchor: string, ins: number, w: number, h: number, content: string) =>
      '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" ' +
      'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${x * EMU}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="page"><wp:posOffset>${60 * EMU}</wp:posOffset></wp:positionV>` +
      `<wp:extent cx="${w * EMU}" cy="${h * EMU}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
      '<wp:docPr id="1" name="文本框"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      `<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${content}</w:txbxContent></wps:txbx>` +
      `<wps:bodyPr wrap="square" lIns="${ins * 91440}" tIns="${ins * 45720}" rIns="${ins * 91440}" bIns="${ins * 45720}" ` +
      `anchor="${anchor}"><a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
    const lines = Array.from({ length: 7 }, (_, k) => p(r(`第${k + 1}行文字`))).join('')
    const body =
      p(
        box(60, 't', 1, 140, 60, lines) +
          box(220, 'ctr', 1, 140, 60, lines) +
          box(380, 'b', 1, 140, 60, lines) +
          box(60, 't', 0, 140, 40, lines) +
          box(220, 't', 1, 60, 120, p(inline(100, 100))) +
          r('段'),
      ) + SECT()
    const { pages } = layoutPages(await parse(body), load(), NO_HOST_FAMILIES)
    const page = pages.pages[0]!
    const texts = page.floats.map((f) => f.texts[0]!)
    expect(texts.map((t) => t.clip)).toEqual([
      { x: 60, y: 60, width: 140, height: 56.4 },
      { x: 220, y: 60, width: 140, height: 56.4 },
      { x: 380, y: 60, width: 140, height: 56.4 },
      { x: 60, y: 60, width: 140, height: 40 },
      { x: 220, y: 60, width: 60, height: 116.4 },
    ])
    for (const t of texts.slice(0, 3)) {
      const first = t.items[0]
      if (first?.kind !== 'paragraph') throw new Error('不是段落')
      expect(first.lines[0]!.top).toBeCloseTo(63.6, 1)
    }
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: pages.faces, draw: () => null },
      {
        images: [],
        parts: [],
        createCanvas: () => new RecordingCanvas(1, 1),
      },
    )
    const clips = ctx.calls.filter((c) => c.name === 'rect').map((c) => c.args.join(' '))
    expect(clips).toEqual(expect.arrayContaining(['80 80 187 75', '80 80 187 53', '293 80 80 155']))
  })

  test('横排文字随形状旋转：按未旋转的形状框排版，绘制时绕形状框中心旋转', async () => {
    // WPS（构造文档 w14 x1 的 X18）：56.7 × 113.4 磅、旋转 270°、内缩左 2 上 6 右 10 下 14 磅的文本框，文字按 56.7 磅宽的框换行，
    // 随形状旋转 270°。
    const box =
      '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" ' +
      'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${380 * EMU}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="page"><wp:posOffset>${440 * EMU}</wp:posOffset></wp:positionV>` +
      '<wp:extent cx="720090" cy="1440180"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="1" name="文本框"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      '<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm rot="16200000"><a:off x="0" y="0"/>' +
      '<a:ext cx="720090" cy="1440180"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${p(r('汉'.repeat(9)))}</w:txbxContent></wps:txbx>` +
      '<wps:bodyPr vert="horz" wrap="square" lIns="25400" tIns="76200" rIns="127000" bIns="177800" anchor="t">' +
      '<a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    const { pages } = layoutPages(
      await parse(p(box + r('段')) + SECT(), []),
      load(),
      NO_HOST_FAMILIES,
    )
    const page = pages.pages[0]!
    const t = page.floats[0]!.texts[0]!
    expect(t.rotation).toEqual({ angle: 270, x: 380 + 56.7 / 2, y: 440 + 113.4 / 2 })
    const first = t.items[0]
    if (first?.kind !== 'paragraph') throw new Error('不是段落')
    // 文字区宽 56.7 − 2 − 10 = 44.7 磅：每行 4 个 10.5 磅的字。
    expect(first.lines.map((l) => l.fragments[0]!.text.length)).toEqual([4, 4, 1])
    expect(first.lines[0]!.fragments[0]!.x).toBeCloseTo(382, 6)
    const ctx = new RecordingContext()
    paintPage(
      ctx,
      page,
      { faces: pages.faces, draw: () => null },
      {
        images: [],
        parts: [],
        createCanvas: () => new RecordingCanvas(1, 1),
      },
    )
    // 裁剪路径在旋转后的坐标中：顺时针 270° 的变换为 (0, −1, 1, 0)，旋转中心不动。
    const clip = ctx.calls.find((c) => c.name === 'rect')!
    const m = clip.matrix
    expect([m.a, m.b, m.c, m.d].map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([0, -1, 1, 0])
    const [cx, cy] = [(380 + 56.7 / 2) * (4 / 3), (440 + 113.4 / 2) * (4 / 3)]
    expect(m.a * cx + m.c * cy + m.e).toBeCloseTo(cx, 6)
    expect(m.b * cx + m.d * cy + m.f).toBeCloseTo(cy, 6)
  })

  test('竖排文字与形状旋转相抵的文本框：文字横排在旋转后的形状框中，内缩随形状旋转；不相抵的竖排计入不支持的效果', async () => {
    // WPS（构造文档 w14 x1）：56.7 × 113.4 磅、内缩左 2 上 6 右 10 下 14 磅的文本框，旋转 270° 且 vert 时文字区宽 93.4 磅，
    // 左边距中心 56.7 − 6 磅、顶边距中心 28.35 − 10 磅；旋转 90° 且 vert270 时为 56.7 − 14 与 28.35 − 2 磅。
    const box = (x: number, rot: number, vert: string) =>
      '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" ' +
      'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
      `<wp:positionH relativeFrom="page"><wp:posOffset>${x * EMU}</wp:posOffset></wp:positionH>` +
      `<wp:positionV relativeFrom="page"><wp:posOffset>${80 * EMU}</wp:posOffset></wp:positionV>` +
      '<wp:extent cx="720090" cy="1440180"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>' +
      '<wp:docPr id="1" name="文本框"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      `<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm rot="${rot * 60000}"><a:off x="0" y="0"/>` +
      '<a:ext cx="720090" cy="1440180"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${p(r('汉'.repeat(17)))}</w:txbxContent></wps:txbx>` +
      `<wps:bodyPr vert="${vert}" wrap="square" lIns="25400" tIns="76200" rIns="127000" bIns="177800" anchor="t">` +
      '<a:noAutofit/></wps:bodyPr></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    const body =
      p(box(60, 270, 'vert') + box(220, 90, 'vert270') + box(380, 0, 'vert') + r('段')) + SECT()
    const doc = await parse(body, [])
    const floats = layoutPages(doc, load(), NO_HOST_FAMILIES).pages.pages[0]!.floats
    const lines = (k: number) => {
      const item = floats[k]!.texts[0]!.items[0]
      if (item?.kind !== 'paragraph') throw new Error('不是段落')
      return item.lines
    }
    const [cx, cy] = [60 + 56.7 / 2, 80 + 113.4 / 2]
    expect(lines(0).map((l) => l.fragments[0]!.text.length)).toEqual([8, 8, 1])
    expect(lines(0)[0]!.fragments[0]!.x).toBeCloseTo(cx - 56.7 + 6, 6)
    expect(lines(0)[0]!.top).toBeCloseTo(cy - 28.35 + 10, 6)
    expect(lines(1)[0]!.fragments[0]!.x).toBeCloseTo(cx + 160 - 56.7 + 14, 6)
    expect(lines(1)[0]!.top).toBeCloseTo(cy - 28.35 + 2, 6)
    expect(lines(2)[0]!.fragments[0]!.text.length).toBe(4)
    expect(doc.unsupported).toEqual({ effect: 1 })
  })

  test('与下段同页的段落组因下一段的上下型图片无法容纳而整体移页：图片按段落的新位置求得，标题留在页首（WPS：标题 72，图片 85.5）', async () => {
    const big = p(r('占位'), '<w:spacing w:line="12000" w:lineRule="exact"/>')
    const heading = p(r('标题'), '<w:keepNext/>')
    const withPicture = (offset: number) =>
      p(
        anchor(200, 150, ['column', 100], ['paragraph', offset], '<wp:wrapTopAndBottom/>') +
          r('带图片的段落'),
      )
    for (const offset of [0, 20]) {
      const pages = layoutPages(
        await parse(big + heading + withPicture(offset) + SECT(), [IMAGE], 15),
        load(),
        NO_HOST_FAMILIES,
      ).pages.pages
      expect(pages).toHaveLength(2)
      const [title, owner] = paragraphsOf(pages[1]!)
      const titleLine = title!.lines[0]!
      expect(titleLine.top).toBeCloseTo(72, 6)
      const f = pages[1]!.floats[0]!
      expect(f.y).toBeCloseTo(titleLine.top + titleLine.height + offset, 6)
      // 偏移 0 时段落的行在图片底边（235.617 磅）之下的第一个整缇；偏移 20 磅时一行文字排在标题与图片之间，行顶向下
      // 取整到缇（WPS：段落位于 85.6，图片 105.75）。
      const textTop = owner!.lines[0]!.top
      expect(textTop).toBeCloseTo(offset === 0 ? 235.65 : 85.6, 6)
      expect(pages[0]!.floats).toEqual([])
    }
  })

  test('上下型图片本身可以容纳而段落第一行下移到图片下方后本页容纳不下时，段落连同图片与同页的标题移到下一页（WPS：标题 72，文字 235.65）', async () => {
    // 占位段落使标题位于约 603 磅处，图片底边距正文区底边约 3 磅。
    const big = p(r('占位'), '<w:spacing w:line="10620" w:lineRule="exact"/>')
    const body =
      big +
      p(r('标题'), '<w:keepNext/>') +
      p(
        anchor(200, 150, ['column', 100], ['paragraph', 0], '<wp:wrapTopAndBottom/>') +
          r('带图片的段落'),
      ) +
      SECT()
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages).toHaveLength(2)
    const f = pages[0]!.floats
    expect(f).toEqual([])
    const [title, owner] = paragraphsOf(pages[1]!)
    expect(title!.lines[0]!.top).toBeCloseTo(72, 6)
    const picture = pages[1]!.floats[0]!
    expect(picture.y + picture.height).toBeLessThan(769.9)
    // 图片底边 235.617 磅之下的第一个整缇。
    expect(owner!.lines[0]!.top).toBeCloseTo(235.65, 6)
  })

  test('上一段末行与上下型图片顶边相接时不避让（WPS：上一段留在 235.4，图片 249.0，带图片段落的文字在 399.05）', async () => {
    const body =
      p(r('上一段')) +
      p(
        anchor(200, 150, ['column', 100], ['paragraph', 0], '<wp:wrapTopAndBottom/>') +
          r('带图片的段落'),
      ) +
      SECT()
    const page = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages
      .pages[0]!
    const [prev, owner] = paragraphsOf(page)
    expect(prev!.lines[0]!.top).toBeCloseTo(72, 6)
    const f = page.floats[0]!
    expect(f.y).toBeCloseTo(72 + prev!.lines[0]!.height, 6)
    // 图片底边 235.617 磅之下的第一个整缇（WPS：图片底边 399.017 磅时文字在 399.05）。
    expect(owner!.lines[0]!.top).toBeCloseTo(235.65, 6)
  })

  test('兼容模式 14：上下型图片顶边恰好接触上一段末行（末行计入段后间距）时上一段移到图片下方（WPS：w11f、w11g 改为兼容模式 14）', async () => {
    // WPS 实测（构造文档 w14 的 w11f-14、w11g-14）：图片相对段落偏移 0，上一段段后 0 或 10 磅时上一段都移到图片底边之下的
    // 第一个整缇，兼容模式 15 中上一段留在原处。
    for (const [after, top] of [
      [0, 235.65],
      [200, 245.65],
    ] as const) {
      const body =
        p(r('上一段'), `<w:spacing w:after="${after}"/>`) +
        p(
          anchor(200, 150, ['column', 100], ['paragraph', 0], '<wp:wrapTopAndBottom/>') +
            r('带图片的段落'),
        ) +
        SECT()
      const [legacy] = paragraphsOf(
        layoutPages(await parse(body, [IMAGE], 14), load(), NO_HOST_FAMILIES).pages.pages[0]!,
      )
      const [current] = paragraphsOf(
        layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages[0]!,
      )
      expect([after, legacy!.lines[0]!.top]).toEqual([after, top])
      expect([after, current!.lines[0]!.top]).toEqual([after, 72])
    }
  })

  test('页面边框：相对页面时矩形为线的外缘，相对正文时为线的内缘', async () => {
    const border = (frm: string) =>
      `<w:pgBorders w:offsetFrom="${frm}"><w:top w:val="single" w:sz="8" w:space="4" w:color="FF0000"/>` +
      '<w:left w:val="single" w:sz="8" w:space="4" w:color="FF0000"/></w:pgBorders>'
    const d = await parse(p(r('一'), SECT(border('page'))) + p(r('二')) + SECT(border('text')))
    const pages = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages
    expect(pages[0]!.borders).toMatchObject({ x: 4, y: 4, inside: true })
    expect(pages[1]!.borders).toMatchObject({ x: 86, y: 68, inside: false })
  })

  test('页眉中未实现的元素与没有数学字体的公式每个部件计一次，与文字同行的图片每页绘制；页码域由分页生成，不计入 dynamicField', async () => {
    const W =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'
    const header =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}>` +
      p(`${r('页眉')}${inline(10, 10)}<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>`) +
      p(
        '<w:fldSimple w:instr=" DATE "><w:r><w:t>2026</w:t></w:r></w:fldSimple><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>',
      ) +
      '</w:hdr>'
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>'
    const pageBreak = p('<w:r><w:br w:type="page"/></w:r>')
    const d = await parse(
      p(r('一')) +
        pageBreak +
        p(r('二')) +
        pageBreak +
        p(r('三')) +
        SECT('<w:headerReference w:type="default" r:id="rIdHdr"/>'),
      [
        IMAGE,
        {
          id: 'rIdHdr',
          type: 'header',
          name: 'header1.xml',
          content: header,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
        },
        {
          id: 'rIdHdrRels',
          type: 'x',
          name: '_rels/header1.xml.rels',
          content: rels,
          contentType: 'application/xml',
        },
      ],
    )
    expect(d.unsupported).toEqual({ dynamicField: 1 })
    const pages = layoutPages(d, load(), NO_HOST_FAMILIES).pages.pages
    const drawn = (pg: Page) =>
      pg.header.reduce((n, it) => n + (it.kind === 'paragraph' ? it.images.length : 0), 0)
    expect(pages.map(drawn)).toEqual([1, 1, 1])
    expect(pages.map((pg) => pg.hiddenMath)).toEqual([1, 0, 0])
  })

  // 以下用例每行 14 磅固定行距：正文区 72–769.9 磅，第 k 个段落（自 0 起）的行顶为 72 + 14k。
  const EXACT = '<w:spacing w:line="280" w:lineRule="exact"/>'
  const SQUARE = '<wp:wrapSquare wrapText="bothSides"/>'
  const PAGE_BREAK = p('<w:r><w:br w:type="page"/></w:r>', EXACT)
  const fill = (n: number) => Array.from({ length: n }, (_, k) => p(r(`填充${k}`), EXACT)).join('')
  const floatsY = (pages: readonly Page[]) => pages.map((pg) => pg.floats.map((f) => f.y))

  test('兼容模式 15：对象限于正文区之内，底边超出时上移、顶边高于正文区时下移，四周型对象的锚定段落不移页（WPS：w6-clamp15、w6-move15）', async () => {
    const body =
      p(anchor(300, 760, ['column', 0], ['paragraph', 40], SQUARE) + r('一'), EXACT) +
      PAGE_BREAK +
      p(anchor(300, 300, ['column', 0], ['paragraph', -50], SQUARE) + r('二'), EXACT) +
      PAGE_BREAK +
      fill(20) +
      p(anchor(300, 500, ['column', 0], ['paragraph', 0], SQUARE) + r('三'), EXACT) +
      SECT()
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages).toHaveLength(3)
    const ys = floatsY(pages)
    // 高于正文区的对象顶边对齐正文区顶边；第 3 页对象上移到段落顶边（352）之上，段落留在本页。
    expect(ys[0]![0]).toBeCloseTo(72, 6)
    expect(ys[1]![0]).toBeCloseTo(72, 6)
    expect(ys[2]![0]).toBeCloseTo(769.9 - 500, 6)
    expect(paragraphsOf(pages[2]!).at(-1)!.lines[0]!.top).toBeCloseTo(72 + 20 * 14, 6)
  })

  test('兼容模式 14：只有底边超出页面底边的对象上移，至底边与页面底边对齐（WPS：w6-clamp14、w6-move14）', async () => {
    const body =
      p(anchor(300, 760, ['column', 0], ['paragraph', 40], SQUARE) + r('一'), EXACT) +
      PAGE_BREAK +
      p(anchor(300, 700, ['column', 0], ['paragraph', 40], SQUARE) + r('二'), EXACT) +
      SECT()
    const ys = floatsY(
      layoutPages(await parse(body, [IMAGE], 14), load(), NO_HOST_FAMILIES).pages.pages,
    )
    expect(ys[0]![0]).toBeCloseTo(841.9 - 760, 6)
    expect(ys[1]![0]).toBeCloseTo(72 + 40, 6)
  })

  test('整页紧密型图片之后只含分页符的段落避让图片移到下一页（WPS：w5-cover 第 1 例，共 3 页）', async () => {
    const tight =
      '<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/>' +
      '<wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>'
    const body =
      p(anchor(595.3, 841.9, ['column', -90], ['paragraph', 40], tight, true) + r('第 1 例')) +
      p('<w:r><w:br w:type="page"/></w:r>') +
      p(r('其后')) +
      SECT()
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages).toHaveLength(3)
    expect(pages[0]!.floats[0]!.y).toBeCloseTo(72, 6)
    expect(pages.map((pg) => paragraphsOf(pg).map((it) => it.block))).toEqual([[0], [1], [2]])
  })

  test('兼容模式 15：顶边在正文区底边之下的上下型对象上移后与第一行重叠时，锚定段落移到下一页，其前的段落留在本页（WPS：w6-tb15 第 4 例）', async () => {
    const body =
      fill(45) +
      p(
        anchor(300, 100, ['column', 0], ['paragraph', 100], '<wp:wrapTopAndBottom/>') + r('锚定'),
        EXACT,
      ) +
      SECT()
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages).toHaveLength(2)
    expect(paragraphsOf(pages[0]!).at(-1)!.block).toBe(44)
    expect(pages[0]!.floats).toEqual([])
    const owner = paragraphsOf(pages[1]!)[0]!
    expect(owner.block).toBe(45)
    expect(pages[1]!.floats[0]!.y).toBeCloseTo(72 + 100, 6)
    // 对象在第一行之下 100 磅处，第一行留在页首（WPS：段落 56.7，图片 156.75）。
    expect(owner.lines[0]!.top).toBeCloseTo(72, 6)
  })

  test('effectExtent 计入避让矩形：上下型对象之下的行再下移 effectExtent 的底边范围（WPS：w6-sa，0.9 磅）', async () => {
    const effect = (b: number) =>
      anchor(400, 41.1, ['column', 0], ['paragraph', 2.55], '<wp:wrapTopAndBottom/>').replace(
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>',
        `<wp:effectExtent l="0" t="0" r="0" b="${b * EMU}"/>`,
      )
    for (const b of [0, 0.9]) {
      const body = p(r('前'), EXACT) + p(effect(b), EXACT) + p(r('后'), EXACT) + SECT()
      const page = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages
        .pages[0]!
      const [, owner, after] = paragraphsOf(page)
      // 锚定段落顶边 86，对象 88.55–129.65；锚定段落的行与其后的行依次在矩形下方，矩形底边为整缇，行顶在其下 1 缇。
      expect(owner!.lines[0]!.top).toBeCloseTo(72 + 14 + 2.55 + 41.1 + b + 0.05, 6)
      expect(after!.lines[0]!.top).toBeCloseTo(72 + 14 + 2.55 + 41.1 + b + 0.05 + 14, 6)
    }
  })

  test('锚定段落中与本段上下型对象重叠的行下移到对象下方，本页容纳不下时移到下一页（语料 32c9f4a4 第 29、30 页）', async () => {
    // 锚定段落三行位于 520、534、548 磅；对象上移至底边与正文区底边对齐（553.9–769.9），第三行与之重叠。
    const br = '<w:r><w:br/></w:r>'
    const body =
      fill(32) +
      p(
        anchor(360, 216, ['column', 0], ['paragraph', 74], '<wp:wrapTopAndBottom/>') +
          r('一') +
          br +
          r('二') +
          br +
          r('三'),
        `${EXACT}<w:widowControl w:val="0"/>`,
      ) +
      SECT()
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages[0]!.floats[0]!.y).toBeCloseTo(769.9 - 216, 6)
    expect(paragraphsOf(pages[0]!).at(-1)!.lines).toHaveLength(2)
    const rest = paragraphsOf(pages[1]!)[0]!
    expect(rest.block).toBe(32)
    expect(rest.lines[0]!.top).toBeCloseTo(72, 6)
  })

  test('锚定在本页容纳不下的行中的对象属于下一页，不使本页的段落避让（语料 32c9f4a4 第 21、22 页）', async () => {
    // 锚定段落的三行位于 730、744、758 磅：第三行底边 772 超出正文区，对象锚定在第三行。
    const br = '<w:r><w:br/></w:r>'
    const body =
      fill(47) +
      p(
        r('一') +
          br +
          r('二') +
          br +
          anchor(200, 150, ['column', 0], ['paragraph', 47.5], '<wp:wrapTopAndBottom/>') +
          r('三'),
        `${EXACT}<w:widowControl w:val="0"/>`,
      ) +
      SECT()
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(pages[0]!.floats).toEqual([])
    const first = paragraphsOf(pages[0]!)
    expect(first.map((it) => it.lines[0]!.top)).toEqual(
      Array.from({ length: 48 }, (_, k) => expect.closeTo(72 + 14 * k, 6)),
    )
    expect(first.at(-1)!.lines).toHaveLength(2)
    expect(pages[1]!.floats).toHaveLength(1)
  })

  test('相对段落的对象以上一段段后间距之下为基准；行下移到上下型对象下方时，本段超出上一段段后间距的段前间距加在对象之下', async () => {
    // WPS（构造文档 w11f、w11g，宋体 10.5 磅、100 磅高的上下型图片）：前一段行顶 72 磅。
    const sp = (before: number, after: number) =>
      `<w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/>`
    const tb = '<wp:wrapTopAndBottom/>'
    const own = (before: number, prevAfter: number, offset: number) =>
      p(r('前段'), sp(0, prevAfter)) +
      p(anchor(200, 100, ['column', 0], ['paragraph', offset], tb) + r('锚定'), sp(before, 0))
    const pushed = (before: number, prevAfter: number) =>
      p(anchor(200, 100, ['column', 0], ['paragraph', 16], tb) + r('锚定'), sp(0, prevAfter)) +
      p(r('被推'), sp(before, 0))
    const cases: [string, string, number][] = [
      [own(0, 200, 0), '锚定', 195.65],
      [own(160, 0, 0), '锚定', 193.65],
      [own(160, 0, 20), '锚定', 213.65],
      [own(0, 200, 20), '锚定', 95.6],
      [own(400, 200, 0), '锚定', 205.65],
      [pushed(160, 0), '被推', 196.05],
      [pushed(160, 200), '被推', 188.05],
      [pushed(400, 200), '被推', 198.05],
    ]
    for (const [body, text, top] of cases) {
      const pages = layoutPages(await parse(body + SECT(), [IMAGE], 15), load(), NO_HOST_FAMILIES)
        .pages.pages
      const it = paragraphsOf(pages[0]!).find((x) =>
        x.lines[0]!.fragments.some((f) => f.text.startsWith(text)),
      )!
      expect([text, top, Math.abs(it.lines[0]!.top - top) < 0.1]).toEqual([text, top, true])
    }
  })

  test('段落在同一页分为几部分（分栏符之后转到下一栏）时，锚定在其中的对象只放置一次（语料 470bf4c1）', async () => {
    const cols = '<w:cols w:num="2" w:space="425"/>'
    const body =
      p(
        anchor(100, 50, ['page', 300], ['page', 400], '<wp:wrapNone/>') +
          r('左栏') +
          '<w:r><w:br w:type="column"/></w:r>' +
          r('右栏'),
      ) + SECT(cols)
    const pages = layoutPages(await parse(body, [IMAGE], 15), load(), NO_HOST_FAMILIES).pages.pages
    expect(paragraphsOf(pages[0]!)).toHaveLength(2)
    expect(pages[0]!.floats).toHaveLength(1)
  })

  const side = (name: string, val: string, sz: number, space: number) =>
    `<w:${name} w:val="${val}" w:sz="${sz}" w:space="${space}" w:color="000000"/>`
  const bdr = (...sides: string[]) => `<w:pBdr>${sides.join('')}</w:pBdr>`

  test('段落边框占用的高度：绘制的边框占 space 加线组宽度，相同边框的相邻段落为一组；none 的上边框只在组外占 space，下边框占两倍 space（WPS：w7-bdr、w6-border2）', async () => {
    const group = bdr(side('top', 'single', 4, 10), side('bottom', 'single', 4, 10))
    const body =
      p(r('开头'), bdr(side('top', 'none', 0, 10))) +
      p(r('前')) +
      p(r('A'), bdr(side('top', 'single', 4, 10))) +
      p(r('前')) +
      p(r('B'), bdr(side('bottom', 'single', 4, 10))) +
      p(r('前')) +
      p(r('F'), bdr(side('top', 'none', 0, 10))) +
      p(r('前')) +
      p(r('G'), bdr(side('bottom', 'none', 0, 10))) +
      p(r('前')) +
      p(r('Q'), bdr(side('top', 'none', 0, 10), side('bottom', 'single', 4, 10))) +
      p(r('前')) +
      p(r('L1'), group) +
      p(r('L2'), group) +
      p(r('后')) +
      p(r('J'), bdr(side('bottom', 'thickThinSmallGap', 12, 1))) +
      p(r('后')) +
      SECT()
    const tops = paragraphsOf(
      layoutPages(await parse(body), load(), NO_HOST_FAMILIES).pages.pages[0]!,
    ).map((it) => it.lines[0]!.top)
    expect(tops[0]).toBeCloseTo(82, 6)
    // 行顶取整到缇，相邻行顶之差与按行高求得的值相差不到 1 缇：按 0.5 磅取整后比较。
    const line = tops[2]! - tops[1]! - 10.5
    const extra = tops.slice(1).map((t, k) => Math.round((t - tops[k]! - line) * 2) / 2 + 0)
    expect(extra).toEqual([0, 10.5, 0, 0, 10.5, 0, 0, 0, 20, 10, 10.5, 10.5, 0, 10.5, 0, 4])
  })

  test('下边框须与最后一行一起容纳在本页：3 磅三线下边框超出正文区底边时段落移到下一页', async () => {
    const tail = (b: string) => fill(48) + p(r('边框'), EXACT + bdr(b)) + SECT()
    const pageOf = async (b: string) =>
      layoutPages(await parse(tail(b)), load(), NO_HOST_FAMILIES).pages.pages.findIndex((pg) =>
        paragraphsOf(pg).some((it) => it.block === 48),
      )
    expect(await pageOf(side('bottom', 'single', 4, 4))).toBe(0)
    expect(await pageOf(side('bottom', 'triple', 24, 4))).toBe(1)
  })

  test('线型的线与间距：SmallGap 的间距与细线为 0.75 磅，MediumGap 为线宽的一半，LargeGap 的粗线 1.5 磅、间距为线宽', () => {
    expect(borderStrokes('thinThickSmallGap', 3)).toEqual([
      { offset: 0, size: 3 },
      { offset: 3.75, size: 0.75 },
    ])
    expect(borderStrokes('thickThinMediumGap', 3)).toEqual([
      { offset: 0, size: 1.5 },
      { offset: 3, size: 3 },
    ])
    expect(borderStrokes('thinThickThinLargeGap', 1.5)).toEqual([
      { offset: 0, size: 0.75 },
      { offset: 2.25, size: 1.5 },
      { offset: 5.25, size: 0.75 },
    ])
    expect(
      ['single', 'double', 'triple', 'thickThinSmallGap', 'none'].map((style) =>
        borderSpace({ style, width: 1.5, color: null, space: 0 }),
      ),
    ).toEqual([1.5, 4.5, 7.5, 3, 0])
  })
})
