/**
 * docx 文字的 ClearType 绘制。覆盖本目录的 `paint.ts`（正文字形段的暂存与混合、点阵字号、没有 ClearType 字形的字体）、
 * `fonts.ts`（`DocxFace.clearType`）、`chart.ts` 与 `graphic.ts`（图表文字的 ClearType 字形）。
 *
 * 期望值：正文字形的像素取自 GDI 在本机以自然宽度方式（`CLEARTYPE_NATURAL_QUALITY`，WPS 屏幕绘制请求的方式）逐字给出前进
 * 宽度绘制的同一段文字，黑字白底、对比度 1000 时各子像素的亮度换算为 0–6；点阵字号取自 WPS 实测（宋体 9–13 磅不平滑）。
 * 读取本机 Windows 字体目录中的 Times New Roman 与宋体：其他平台跳过。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingCanvas, RecordingContext } from '../../drawingml/paint/test-helper.ts'
import type { ClearTypeGlyphs, PixelData } from '../../glyph/cleartype/index.ts'
import { LOCAL_FONTS } from '../../test-fonts.ts'
import { NO_HOST_FAMILIES } from '../../text/index.ts'
import { parseDocx } from '../index.ts'
import { layoutPages } from '../page/build.ts'
import type { Page, PageFragment, PageParagraph } from '../page/model.ts'
import { buildDocx, p } from '../test-helper.ts'
import { type DocxFace, DocxFonts, loadDocxFace } from './fonts.ts'
import { paintPage } from './paint.ts'

const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')

/** 记录绘制调用，另以白色像素缓冲区实现像素的读写；`writes` 为每次写回像素时已记录的绘制调用数。 */
class PixelContext extends RecordingContext {
  readonly pixels: Uint8ClampedArray
  readonly writes: number[] = []

  constructor(readonly width = 200) {
    super()
    this.pixels = new Uint8ClampedArray(4 * width * width).fill(255)
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

  /** [x0, x1) × [y0, y1) 各像素三个通道的覆盖等级（黑字白底、对比度 1000），每行一个字符串。 */
  levels(x0: number, y0: number, x1: number, y1: number): string[] {
    const rows: string[] = []
    for (let y = y0; y < y1; y++) {
      let row = ''
      for (let x = x0; x < x1; x++)
        for (let c = 0; c < 3; c++)
          row += Math.round(((255 - this.pixels[4 * (y * this.width + x) + c]!) * 6) / 255)
      rows.push(row)
    }
    return rows
  }
}

const RESOURCES = { images: [], parts: [], createCanvas: () => new RecordingCanvas(1, 1) }
const ON = { contrast: 1000 }

function fragment(f: Partial<PageFragment> & { text: string; advances: number[] }): PageFragment {
  return {
    face: 0,
    size: 12,
    x: 10,
    baseline: 15,
    color: '#000000',
    underline: null,
    strike: null,
    fill: null,
    ...f,
  }
}

function paragraph(
  fragments: PageFragment[],
  box: PageParagraph['box'] = null,
  top = 0,
): PageParagraph {
  return {
    kind: 'paragraph',
    block: 0,
    firstLine: 0,
    box,
    images: [],
    graphics: [],
    formulas: [],
    lines: [{ top, height: 20, fragments }],
  }
}

function page(body: PageParagraph[]): Page {
  return {
    section: 0,
    width: 140,
    height: 140,
    number: '1',
    header: [],
    footer: [],
    floats: [],
    background: null,
    borders: null,
    graphicFonts: null,
    hiddenMath: 0,
    body,
  }
}

/** 以 `face` 绘制 `pg`；`clearType` 为假时主机不使用 ClearType。 */
function paint(pg: Page, face: DocxFace, clearType: boolean, synthetic = false) {
  const ctx = new PixelContext()
  const ref = {
    family: face.family,
    bold: face.bold,
    italic: face.italic,
    syntheticBold: synthetic,
    syntheticItalic: synthetic,
  }
  paintPage(
    ctx,
    pg,
    { faces: [ref], draw: () => face },
    RESOURCES,
    4 / 3,
    clearType ? { display: ON, target: ctx } : null,
  )
  return ctx
}

describe.skipIf(!LOCAL_FONTS)('正文文字的 ClearType 字形（本机字体）', () => {
  const times = () =>
    loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'times.ttf'))), 'Times New Roman')
  const simsun = () =>
    loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)

  /** 原始失败形状：WPS 文字的正文为 GDI 自然宽度方式的 ClearType 绘制，此前一律以浏览器字体（`fillText`）绘制。 */
  test('平滑字号的正文以 ClearType 字形写入画布像素，与 GDI 逐子像素相同；主机不使用 ClearType 时以 fillText 绘制', () => {
    // Times New Roman 12 磅（ppem 16）「Te」：首字在 13 像素处，第二个字在其后 11 像素，基线 20。
    const pg = page([paragraph([fragment({ text: 'Te', advances: [8, 6] })])])
    const on = paint(pg, times(), true)
    expect(on.named('fillText')).toHaveLength(0)
    expect(on.levels(12, 9, 31, 20)).toEqual([
      '000246666666666666666666666664200000000000000000000000000',
      '001355310000013566420000002464200000000000000000000000000',
      '001332000000013566420000000133200000000000000000000000000',
      '000000000000013566420000000000000000000000000000000000000',
      '000000000000013566420000000000000000000000246666666642000',
      '000000000000013566420000000000000000000246420000002466420',
      '000000000000013566420000000000000000002466666666666666642',
      '000000000000013566420000000000000000013565310000000000000',
      '000000000000013566420000000000000000013566420000000000000',
      '000000000000013566420000000000000000000246665310000002331',
      '000000000246666666666653100000000000000001356666666664200',
    ])
    const off = paint(pg, times(), false)
    expect(off.named('fillText').map((c) => c.args)).toEqual([
      ['T', 13, 20],
      ['e', 24, 20],
    ])
    expect(off.writes).toHaveLength(0)
  })

  test('点阵模式的字号仍以单色字形绘制，不读写像素；宋体 14 磅为 ClearType 字形', () => {
    const small = paint(
      page([paragraph([fragment({ text: '汉字', size: 10.5, advances: [10.5, 10.5] })])]),
      simsun(),
      true,
    )
    expect(small.writes).toHaveLength(0)
    expect(small.named('fillText')).toHaveLength(0)
    expect(small.named('fillRect').length).toBeGreaterThan(10)
    const large = paint(
      page([paragraph([fragment({ text: '汉字', size: 14, advances: [14, 14] })])]),
      simsun(),
      true,
    )
    expect(large.writes.length).toBeGreaterThan(0)
    expect(large.named('fillText')).toHaveLength(0)
  })

  /** 原始失败形状：每个片段各读写一次画布像素时，一页的读写次数随片段数增长。 */
  test('相邻段落的字形段一并混合，在其后的段落底纹之前写回；页末写回其余的字形段', () => {
    const shaded = { x: 0, y: 40, width: 100, height: 20, fill: '#00ff00' }
    const pg = page([
      paragraph([fragment({ text: 'Te', advances: [8, 6] })]),
      paragraph([fragment({ text: 'Te', advances: [8, 6], baseline: 30 })], null, 20),
      paragraph(
        [fragment({ text: 'Te', advances: [8, 6], baseline: 55 })],
        { ...shaded, top: null, bottom: null, left: null, right: null },
        40,
      ),
    ])
    const ctx = paint(pg, times(), true)
    const green = ctx.calls.findIndex((c) => c.name === 'fillRect' && c.fillStyle === '#00ff00')
    expect(green).toBeGreaterThan(-1)
    expect(ctx.writes).toHaveLength(2)
    expect(ctx.writes[0]).toBeLessThanOrEqual(green)
    expect(ctx.writes[1]).toBeGreaterThan(green)
  })

  test('字体没有 ClearType 字形（CFF 轮廓）时以 fillText 绘制；合成粗体与合成斜体交给 ClearType 字形', () => {
    const pg = page([paragraph([fragment({ text: 'Te', advances: [8, 6] })])])
    const cff = paint(pg, { ...times(), clearType: null }, true)
    expect(cff.named('fillText').map((c) => c.args[0])).toEqual(['T', 'e'])
    const requests: unknown[][] = []
    const recording: ClearTypeGlyphs = {
      glyph: (_id, ppem, bold, oblique) => {
        requests.push([ppem, bold, oblique])
        return {
          width: 1,
          height: 1,
          bearingX: 0,
          bearingY: 1,
          coverage: Uint8Array.from([6, 6, 6]),
        }
      },
    }
    paint(pg, { ...times(), clearType: recording }, true, true)
    expect(requests).toEqual([
      [16, true, true],
      [16, true, true],
    ])
  })
})

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** 柱形图：类别「甲」「乙」，图表文字 14 磅宋体。 */
const CHART =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${REL}">` +
  '<c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/>' +
  '<c:order val="0"/><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>甲</c:v>' +
  '</c:pt><c:pt idx="1"><c:v>乙</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f>' +
  '<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1">' +
  '<c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>' +
  '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
  '<c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling>' +
  '<c:delete val="1"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart>' +
  '<c:txPr><a:bodyPr/><a:p><a:pPr><a:defRPr sz="1400"><a:latin typeface="宋体"/><a:ea typeface="宋体"/></a:defRPr>' +
  '</a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr></c:chartSpace>'

/** 主题：配色与字体方案，西文与东亚字体均为宋体。 */
const THEME =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="${A}"><a:themeElements>` +
  '<a:clrScheme name="c"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:accent1><a:srgbClr val="0000FF"/></a:accent1></a:clrScheme><a:fontScheme name="f"><a:majorFont>' +
  '<a:latin typeface="宋体"/></a:majorFont><a:minorFont><a:latin typeface="宋体"/><a:ea typeface="宋体"/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="m"/></a:themeElements></a:theme>'

const INLINE_CHART =
  '<w:r><w:drawing><wp:inline><wp:extent cx="3810000" cy="2286000"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
  `<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rIdChart"/></a:graphicData></a:graphic>` +
  '</wp:inline></w:drawing></w:r>'

describe.skipIf(!LOCAL_FONTS)('图表文字的 ClearType 字形（本机字体）', () => {
  test('主机使用 ClearType 时图表的平滑字号以 ClearType 字形写入画布像素，不调用 fillText', async () => {
    const parsed = await parseDocx(
      buildDocx({
        body:
          p(INLINE_CHART) +
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" ' +
          'w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>',
        theme: THEME,
        extra: [
          {
            id: 'rIdChart',
            type: 'chart',
            name: 'charts/chart1.xml',
            content: CHART,
            contentType: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
          },
        ],
      }),
    )
    if (!parsed.ok) throw new Error('解析失败')
    const simsun = loadDocxFace(new Uint8Array(readFileSync(join(FONTS, 'simsun.ttc'))), '宋体', 0)
    const { pages } = layoutPages(parsed.value, new DocxFonts([simsun], '宋体'), NO_HOST_FAMILIES)
    const fonts = { faces: pages.faces, draw: () => simsun }
    const draw = (clearType: boolean) => {
      const ctx = new PixelContext(800)
      paintPage(
        ctx,
        pages.pages[0]!,
        fonts,
        RESOURCES,
        4 / 3,
        clearType ? { display: ON, target: ctx } : null,
      )
      return ctx
    }
    const on = draw(true)
    expect(on.named('fillText')).toHaveLength(0)
    expect(on.writes.length).toBeGreaterThan(0)
    const off = draw(false)
    expect(off.named('fillText').map((c) => c.args[0])).toEqual(
      expect.arrayContaining(['甲', '乙']),
    )
    expect(off.writes).toHaveLength(0)
  })
})
