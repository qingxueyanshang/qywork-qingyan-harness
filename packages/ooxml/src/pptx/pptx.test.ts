/**
 * 覆盖 `load.ts`（`parsePptx` 的部件定位、失败分类、背景与颜色映射、SmartArt 与墨迹部件读取）、`parse/`（演示文稿、幻灯片部件、
 * 形状树、几何、表格、文本、SmartArt 部件引用、InkML）与 `resolve/`（占位符匹配与继承、样式矩阵引用、文字样式链、组合坐标换算、
 * 组合填充、表格样式、SmartArt 求值、墨迹坐标与笔宽、未实现元素计数）；`render/fonts.ts` 收集 SmartArt 文字的字体。
 *
 * 夹具由 `test-helper.ts` 在测试内生成最小 pptx。
 */

import { describe, expect, test } from 'bun:test'
import { type Color, colorToHex } from '../drawingml/color.ts'
import { CHEVRON, colorsXml, dataXml, STYLES } from '../drawingml/diagram/test-helper.ts'
import type { ShapeFill } from '../drawingml/fill.ts'
import type { Paragraph } from '../drawingml/text/model.ts'
import { parsePptx } from './load.ts'
import type { AutoShape, Group, Ink, Picture, Presentation, Shape, Slide, Table } from './model.ts'
import { presentationFonts } from './render/fonts.ts'
import {
  buildPptx,
  buildZip,
  type DeckSpec,
  layoutXml,
  masterXml,
  NS_DECL,
  para,
  run,
  slideXml,
  sp,
  text,
  xfrm,
} from './test-helper.ts'

async function parse(spec: DeckSpec): Promise<Presentation> {
  const r = await parsePptx(buildPptx(spec))
  if (!r.ok) throw new Error(JSON.stringify(r.failure))
  return r.value
}

function hex(fill: ShapeFill | null): string | null {
  return fill?.kind === 'solid' ? colorToHex(fill.color) : null
}

function rgb(color: Color): string {
  return colorToHex(color)
}

function byId(slide: Slide, id: number): Shape {
  const found = slide.shapes.find((s) => s.id === id && s.origin === 'slide')
  if (found === undefined) throw new Error(`没有 id=${id} 的形状`)
  return found
}

function autoShape(slide: Slide, id: number): AutoShape {
  const s = byId(slide, id)
  if (s.kind !== 'shape') throw new Error(`id=${id} 不是形状`)
  return s
}

function paragraphs(slide: Slide, id: number): readonly Paragraph[] {
  return autoShape(slide, id).text?.paragraphs ?? []
}

function firstRun(p: Paragraph) {
  const r = p.runs[0]
  if (r === undefined) throw new Error('段落没有字段')
  return r.style
}

describe('演示文稿结构', () => {
  test('幻灯片尺寸、按 sldIdLst 的顺序、隐藏标记与起始编号', async () => {
    const p = await parse({
      slides: [
        { xml: slideXml('') },
        { xml: slideXml('', { attrs: ' show="0"' }) },
        { xml: slideXml('') },
      ],
      order: [2, 0, 1],
      presentationAttrs: ' firstSlideNum="5"',
    })
    expect(p.width).toBe(12192000)
    expect(p.height).toBe(6858000)
    expect(p.slides.map((s) => s.part)).toEqual([
      '/ppt/slides/slide3.xml',
      '/ppt/slides/slide1.xml',
      '/ppt/slides/slide2.xml',
    ])
    expect(p.slides.map((s) => s.number)).toEqual([5, 6, 7])
    expect(p.slides.map((s) => s.hidden)).toEqual([false, false, true])
    expect(p.slides[0]!.layout).toBe('/ppt/slideLayouts/slideLayout1.xml')
    expect(p.slides[0]!.master).toBe('/ppt/slideMasters/slideMaster1.xml')
    expect(p.masters).toEqual(['/ppt/slideMasters/slideMaster1.xml'])
  })

  test('主文档不是演示文稿时为 corrupt(presentation)，部件 XML 结构错误时为 corrupt(xml)', async () => {
    const zip = buildZip({
      '[Content_Types].xml':
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Override PartName="/x.xml" ContentType="application/xml"/></Types>',
      '_rels/.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="x.xml"/></Relationships>',
      'x.xml': '<x/>',
    })
    expect(await parsePptx(zip)).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'presentation' },
    })
    const broken = await parsePptx(buildPptx({ slides: [{ xml: '<p:sld><p:cSld>' }] }))
    expect(broken).toEqual({ ok: false, failure: { kind: 'corrupt', reason: 'xml' } })
  })
})

describe('背景与颜色映射', () => {
  const override =
    '<p:clrMapOvr><a:overrideClrMapping bg1="dk1" tx1="lt1" bg2="dk2" tx2="lt2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr>'
  const box = sp(9, { txBox: true, spPr: xfrm(0, 0, 100, 100), body: text(para(run('字'))) })

  test('bgRef 经 bgFillStyleLst 求值，phClr 取引用颜色并经颜色映射', async () => {
    const p = await parse({
      layouts: [layoutXml(), layoutXml({ extra: override })],
      slides: [
        { xml: slideXml(box) },
        { xml: slideXml(box), layout: 1 },
        {
          xml: slideXml(box, {
            extra: override.replace('bg1="dk1"', 'bg1="lt2"'),
          }),
          layout: 1,
        },
      ],
    })
    expect(hex(p.slides[0]!.background)).toBe('FFFFFF')
    expect(hex(firstRun(paragraphs(p.slides[0]!, 9)[0]!).fill)).toBe('000000')
    // 版式覆盖映射：幻灯片沿用版式的映射，母版背景中的 bg1 落到 dk1，文字 tx1 落到 lt1。
    expect(hex(p.slides[1]!.background)).toBe('000000')
    expect(hex(firstRun(paragraphs(p.slides[1]!, 9)[0]!).fill)).toBe('FFFFFF')
    expect(hex(p.slides[2]!.background)).toBe('E7E6E6')
  })

  test('幻灯片自身的 bgPr 优先；bgRef 1003 取主题中的图片填充并按主题关系解析部件', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml('', {
            bg: '<p:bg><p:bgPr><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>',
          }),
        },
        {
          xml: slideXml('', {
            bg: '<p:bg><p:bgRef idx="1003"><a:schemeClr val="bg1"/></p:bgRef></p:bg>',
          }),
        },
        {
          xml: slideXml('', {
            bg: '<p:bg><p:bgRef idx="0"><a:schemeClr val="bg1"/></p:bgRef></p:bg>',
          }),
        },
      ],
    })
    expect(hex(p.slides[0]!.background)).toBe('ED7D31')
    const picture = p.slides[1]!.background
    expect(picture?.kind).toBe('picture')
    if (picture?.kind === 'picture') expect(picture.image.part).toBe('/ppt/media/bg.png')
    expect(p.slides[2]!.background).toEqual({ kind: 'none' })
  })
})

describe('样式矩阵引用', () => {
  const style = (fill: number, line: number, effect: number) =>
    `<a:lnRef idx="${line}"><a:schemeClr val="accent1"/></a:lnRef>` +
    `<a:fillRef idx="${fill}"><a:schemeClr val="accent2"/></a:fillRef>` +
    `<a:effectRef idx="${effect}"><a:schemeClr val="accent1"/></a:effectRef>` +
    '<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef>'

  test('fillRef、lnRef、effectRef、fontRef 取主题格式方案，引用颜色替换 phClr', async () => {
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            sp(10, {
              spPr: xfrm(0, 0, 10, 10),
              style: style(1, 2, 3),
              body: text(para(run('字'))),
            }) +
              sp(11, { spPr: xfrm(0, 0, 10, 10), style: style(2, 0, 0) }) +
              sp(12, {
                spPr: `${xfrm(0, 0, 10, 10)}<a:noFill/><a:ln w="38100"/>`,
                style: style(1, 1, 0),
              }) +
              sp(13, { spPr: xfrm(0, 0, 10, 10), style: style(1001, 3, 0) }) +
              sp(14, { spPr: xfrm(0, 0, 10, 10), style: style(0, 9, 7) }),
          ),
        },
      ],
    })
    const slide = p.slides[0]!
    const s10 = autoShape(slide, 10)
    expect(hex(s10.fill)).toBe('ED7D31')
    expect(s10.line?.width).toBe(12700)
    expect(hex(s10.line?.fill ?? null)).toBe('4472C4')
    expect(s10.effects).toHaveLength(1)
    const shadow = s10.effects[0]!
    expect(shadow.kind).toBe('outerShadow')
    if (shadow.kind === 'outerShadow') {
      expect(shadow.blur).toBe(57150)
      expect(shadow.direction).toBe(90)
      expect(shadow.color.a).toBeCloseTo(0.63, 6)
    }
    const r10 = firstRun(s10.text!.paragraphs[0]!)
    expect(r10.latin).toBe('Calibri')
    expect(hex(r10.fill)).toBe('FFFFFF')
    // 效果样式 3 含正视相机与棱台：棱台不改变外观，按 threePt 光照着色，不登记。
    expect(s10.threeD).toEqual({
      rotation: { lat: 0, lon: 0, rev: 0 },
      distance: null,
      scale: 1.039,
      add: 6.5,
    })
    expect(slide.unsupported.effect3d).toBeUndefined()

    const s11 = autoShape(slide, 11)
    expect(s11.fill.kind).toBe('gradient')
    if (s11.fill.kind === 'gradient') {
      expect(s11.fill.stops.map((g) => g.position)).toEqual([0, 1])
      expect(rgb(s11.fill.stops[1]!.color)).toBe('ED7D31')
      expect(s11.fill.shade).toEqual({ kind: 'linear', angle: 90, scaled: false })
    }
    expect(s11.line).toBeNull()
    expect(s11.effects).toEqual([])

    const s12 = autoShape(slide, 12)
    expect(s12.fill).toEqual({ kind: 'none' })
    expect(s12.line?.width).toBe(38100)
    expect(hex(s12.line?.fill ?? null)).toBe('4472C4')
    expect(s12.line?.join).toBe('miter')
    expect(s12.line?.cap).toBe('flat')

    const s13 = autoShape(slide, 13)
    expect(hex(s13.fill)).toBe('ED7D31')
    expect(s13.line?.dash).toEqual({ kind: 'preset', name: 'dash' })

    const s14 = autoShape(slide, 14)
    expect(s14.fill).toEqual({ kind: 'none' })
    expect(s14.line).toBeNull()
    expect(s14.effects).toEqual([])
  })
})

describe('占位符匹配与继承', () => {
  const layout = layoutXml({
    shapes:
      sp(2, { name: '版式标题', ph: 'type="title"', body: text(para('')) }) +
      sp(3, {
        name: '版式内容',
        ph: 'idx="1"',
        spPr: xfrm(838200, 1900000, 10515600, 4000000),
        body: text(para(''), '<a:bodyPr tIns="20000"/>'),
      }) +
      sp(4, {
        name: '版式日期',
        ph: 'type="dt" sz="half" idx="10"',
        spPr: xfrm(100, 200, 300, 400),
      }) +
      sp(5, { name: '版式图片', ph: 'type="pic" idx="13"', spPr: xfrm(1000, 1000, 2000, 2000) }) +
      sp(6, { name: '版式装饰', spPr: xfrm(1, 2, 3, 4) }),
  })
  const picture =
    '<p:pic><p:nvPicPr><p:cNvPr id="15" name="图片占位"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="13"/></p:nvPr></p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr/></p:pic>'

  test('幻灯片到版式按 idx 与类型兼容匹配，版式没有匹配时按类型匹配母版，并继承位置尺寸', async () => {
    const p = await parse({
      layouts: [layout],
      slides: [
        {
          xml: slideXml(
            sp(11, { ph: 'type="title"', body: text(para(run('标题'))) }) +
              sp(12, { ph: 'idx="1"', body: text(para(run('内容'))) }) +
              sp(13, { ph: 'type="dt" sz="half"', body: text(para(run('日期'))) }) +
              sp(14, { ph: 'type="body" idx="20"', body: text(para(run('孤立'))) }) +
              picture +
              sp(16, {
                ph: 'type="title"',
                spPr: xfrm(5, 6, 7, 8),
                body: text(para(run('自身'))),
              }) +
              sp(17, { ph: 'type="tbl" idx="1"', body: text(para(run('表格'))) }) +
              sp(18, { ph: 'type="body" idx="13"', body: text(para(run('正文'))) }),
          ),
          rels: [['rIdImg', 'image', '../media/image1.png']],
        },
      ],
    })
    const slide = p.slides[0]!
    const ph = (id: number) => byId(slide, id).placeholder
    const frame = (id: number) => {
      const f = byId(slide, id).frame
      return [f.x, f.y, f.width, f.height]
    }
    expect(ph(11)).toEqual({ type: 'title', idx: 0, layoutShape: 2, masterShape: 2 })
    expect(frame(11)).toEqual([838200, 365125, 10515600, 1325563])
    expect(ph(12)).toEqual({ type: 'obj', idx: 1, layoutShape: 3, masterShape: 3 })
    expect(frame(12)).toEqual([838200, 1900000, 10515600, 4000000])
    expect(ph(13)).toEqual({ type: 'dt', idx: 0, layoutShape: null, masterShape: 4 })
    expect(frame(13)).toEqual([838200, 6356350, 2743200, 365125])
    expect(ph(14)).toEqual({ type: 'body', idx: 20, layoutShape: null, masterShape: 3 })
    expect(frame(14)).toEqual([838200, 1825625, 10515600, 4351338])
    expect(ph(15)).toEqual({ type: 'pic', idx: 13, layoutShape: 5, masterShape: 3 })
    expect(frame(15)).toEqual([1000, 1000, 2000, 2000])
    const pic = byId(slide, 15) as Picture
    expect(pic.image.part).toBe('/ppt/media/image1.png')
    expect(frame(16)).toEqual([5, 6, 7, 8])
    expect(ph(17)).toEqual({ type: 'tbl', idx: 1, layoutShape: null, masterShape: 3 })
    expect(ph(18)).toEqual({ type: 'body', idx: 13, layoutShape: 5, masterShape: 3 })
  })

  test('bodyPr 的锚定与自动调整逐字段继承，边距只取形状自身的值', async () => {
    const p = await parse({
      layouts: [layout],
      slides: [
        {
          xml: slideXml(
            sp(11, { ph: 'type="title"', body: text(para(run('标题'))) }) +
              sp(12, {
                ph: 'idx="1"',
                body: text(
                  para(run('内容')),
                  '<a:bodyPr rIns="50000"><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr>',
                ),
              }),
          ),
        },
      ],
    })
    const slide = p.slides[0]!
    const body = autoShape(slide, 12).text!.body
    expect([body.insetLeft, body.insetTop, body.insetRight, body.insetBottom]).toEqual([
      91440, 45720, 50000, 45720,
    ])
    expect(body.autofit).toEqual({ kind: 'normal', fontScale: 0.625, lineSpacingReduction: 0.2 })
    expect(autoShape(slide, 11).text!.body.anchor).toBe('ctr')
  })

  test('母版与版式的非占位符形状按绘制顺序列在幻灯片形状之前；showMasterSp 为假时省略', async () => {
    const master = masterXml({
      shapes: `${sp(2, { name: '母版标题', ph: 'type="title"', spPr: xfrm(0, 0, 10, 10) })}${sp(7, { name: '母版装饰', spPr: xfrm(9, 9, 9, 9) })}`,
      layouts: 2,
    })
    const p = await parse({
      master,
      layouts: [layout, layoutXml({ shapes: '', attrs: ' showMasterSp="0"' })],
      slides: [
        { xml: slideXml(sp(20, { spPr: xfrm(0, 0, 1, 1) })) },
        { xml: slideXml(sp(20, { spPr: xfrm(0, 0, 1, 1) }), { attrs: ' showMasterSp="0"' }) },
        { xml: slideXml(sp(20, { spPr: xfrm(0, 0, 1, 1) })), layout: 1 },
      ],
    })
    const ids = (s: Slide) => s.shapes.map((x) => `${x.origin}:${x.id}`)
    expect(ids(p.slides[0]!)).toEqual(['master:7', 'layout:6', 'slide:20'])
    expect(ids(p.slides[1]!)).toEqual(['slide:20'])
    expect(ids(p.slides[2]!).filter((x) => x.startsWith('master'))).toEqual([])
  })
})

describe('文字样式链', () => {
  const lvl = (n: number, inner: string) => `<a:lvl${n}pPr>${inner}</a:lvl${n}pPr>`
  const size = (pt: number) => `<a:defRPr sz="${pt * 100}"/>`
  const master = masterXml({
    shapes:
      sp(2, {
        ph: 'type="title"',
        spPr: xfrm(0, 0, 10, 10),
        body: text(para(''), '<a:bodyPr anchor="ctr"/>'),
      }) +
      sp(3, {
        ph: 'type="body" idx="1"',
        spPr: xfrm(0, 0, 10, 10),
        body: text(para(''), '<a:bodyPr/>', `<a:lstStyle>${lvl(4, size(14))}</a:lstStyle>`),
      }) +
      sp(4, {
        ph: 'type="dt" idx="2"',
        spPr: xfrm(0, 0, 10, 10),
        body: text(para(''), '<a:bodyPr/>', `<a:lstStyle>${lvl(1, size(12))}</a:lstStyle>`),
      }),
    txStyles:
      '<p:txStyles><p:titleStyle><a:lvl1pPr><a:buNone/><a:defRPr sz="4400"><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
      '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/>' +
      '<a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr>' +
      `${lvl(5, size(15))}</p:bodyStyle>` +
      '<p:otherStyle><a:lvl1pPr><a:defRPr sz="2000"/></a:lvl1pPr></p:otherStyle></p:txStyles>',
  })
  const layout = layoutXml({
    shapes:
      sp(2, { ph: 'type="title"', body: text(para('')) }) +
      sp(3, {
        ph: 'type="body" idx="1"',
        body: text(
          para(''),
          '<a:bodyPr/>',
          `<a:lstStyle><a:lvl1pPr algn="ctr"/>${lvl(3, size(13))}</a:lstStyle>`,
        ),
      }) +
      sp(4, { ph: 'type="dt" idx="2"', body: text(para('')) }),
  })
  const defaultTextStyle =
    '<p:defaultTextStyle><a:defPPr><a:defRPr sz="2600"/></a:defPPr>' +
    '<a:lvl1pPr><a:defRPr sz="1000"><a:latin typeface="Courier New"/></a:defRPr></a:lvl1pPr>' +
    `${lvl(6, size(16))}</p:defaultTextStyle>`

  async function deck(shapes: string) {
    const p = await parse({
      master,
      layouts: [layout],
      defaultTextStyle,
      slides: [{ xml: slideXml(shapes) }],
    })
    return p.slides[0]!
  }

  test('字号按字段、段落、形状列表样式、版式、母版占位符、母版正文样式逐级取值，正文占位符不回落到默认文本样式', async () => {
    const pPr = (level: number, inner = '') => `<a:pPr lvl="${level}">${inner}</a:pPr>`
    const slide = await deck(
      sp(10, {
        ph: 'type="body" idx="1"',
        body: text(
          para(run('一', '<a:rPr lang="zh-CN" sz="1000"/>'), pPr(0)) +
            para(run('二'), pPr(0, size(11))) +
            para(run('三'), pPr(1)) +
            para(run('四'), pPr(2)) +
            para(run('五'), pPr(3)) +
            para(run('六'), pPr(4)) +
            para(run('七'), pPr(5)) +
            para(run('八'), pPr(6)),
          '<a:bodyPr/>',
          `<a:lstStyle>${lvl(2, size(12))}</a:lstStyle>`,
        ),
      }),
    )
    const ps = paragraphs(slide, 10)
    expect(ps.map((x) => firstRun(x).size)).toEqual([10, 11, 12, 13, 14, 15, 18, 18])
    expect(ps[0]!.align).toBe('ctr')
    expect(ps[0]!.marginLeft).toBe(228600)
    expect(ps[0]!.indent).toBe(-228600)
    expect(ps[0]!.bullet).toEqual({
      kind: 'char',
      char: '•',
      font: 'Arial',
      color: { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } },
      size: 10,
    })
  })

  test('主题字体按东亚语言取按文种的字体；标题用标题样式，文本框与日期占位符用默认文本样式而不用其他样式', async () => {
    const slide = await deck(
      sp(10, {
        ph: 'type="body" idx="1"',
        body: text(
          para(run('中')) +
            para(run('日', '<a:rPr lang="ja-JP"/>')) +
            para(run('英', '<a:rPr lang="en-US" altLang="zh-CN"/>')) +
            para(run('无', '<a:rPr lang="en-US"/>')),
        ),
      }) +
        sp(11, { ph: 'type="title"', body: text(para(run('标题'))) }) +
        sp(12, { txBox: true, spPr: xfrm(0, 0, 1, 1), body: text(para(run('文本框'))) }) +
        sp(13, { ph: 'type="dt" idx="2"', body: text(para(run('日期'))) }),
    )
    const ps = paragraphs(slide, 10)
    expect(ps.map((x) => [firstRun(x).latin, firstRun(x).ea])).toEqual([
      ['Calibri', '等线'],
      ['Calibri', '游ゴシック'],
      ['Calibri', '等线'],
      ['Calibri', ''],
    ])
    const title = paragraphs(slide, 11)[0]!
    expect([firstRun(title).size, firstRun(title).latin, firstRun(title).ea]).toEqual([
      44,
      'Calibri Light',
      '等线 Light',
    ])
    expect(title.bullet).toEqual({ kind: 'none' })
    expect([
      firstRun(paragraphs(slide, 12)[0]!).size,
      firstRun(paragraphs(slide, 12)[0]!).latin,
    ]).toEqual([10, 'Courier New'])
    const date = paragraphs(slide, 13)[0]!
    expect([firstRun(date).size, firstRun(date).latin]).toEqual([12, 'Courier New'])
    expect(date.bullet).toEqual({ kind: 'none' })
  })

  test('列表样式不使用 defPPr，也不跨层级回落', async () => {
    const slide = await deck(
      sp(10, {
        txBox: true,
        spPr: xfrm(0, 0, 1, 1),
        body: text(
          para(run('甲'), '<a:pPr lvl="7"/>') + para(run('乙'), '<a:pPr lvl="1"/>'),
          '<a:bodyPr/>',
          `<a:lstStyle><a:defPPr>${size(33)}</a:defPPr></a:lstStyle>`,
        ),
      }),
    )
    const ps = paragraphs(slide, 10)
    expect(ps.map((x) => firstRun(x).size)).toEqual([18, 18])
    expect(firstRun(ps[1]!).latin).toBe('Arial')
  })

  test('自动编号在同层级连续递增，空段落不计，非编号段落使编号重新开始', async () => {
    const num = (level: number, scheme = 'arabicPeriod') =>
      `<a:pPr lvl="${level}"><a:buAutoNum type="${scheme}"/></a:pPr>`
    const slide = await deck(
      sp(10, {
        txBox: true,
        spPr: xfrm(0, 0, 1, 1),
        body: text(
          para(run('甲'), num(0)) +
            para(run('乙'), num(0)) +
            para(run('丙'), num(1, 'alphaLcParenR')) +
            para(run('丁'), num(0)) +
            para('', num(0)) +
            para(run('戊'), num(0)) +
            para(run('己'), '<a:pPr><a:buNone/></a:pPr>') +
            para(run('庚'), num(0)),
        ),
      }),
    )
    const bullets = paragraphs(slide, 10).map((x) =>
      x.bullet.kind === 'number' ? `${x.bullet.scheme}:${x.bullet.number}` : x.bullet.kind,
    )
    expect(bullets).toEqual([
      'arabicPeriod:1',
      'arabicPeriod:2',
      'alphaLcParenR:1',
      'arabicPeriod:3',
      'none',
      'arabicPeriod:4',
      'none',
      'arabicPeriod:1',
    ])
  })

  test('字段属性：粗斜体、下划线、上标、字距、高亮、超链接与行距段距', async () => {
    const slide = await deck(
      sp(10, {
        txBox: true,
        spPr: xfrm(0, 0, 1, 1),
        body: text(
          para(
            run(
              '甲',
              '<a:rPr lang="zh-CN" b="1" i="1" u="sng" baseline="30000" spc="150"><a:highlight><a:srgbClr val="FFFF00"/></a:highlight>' +
                '<a:hlinkClick r:id="rIdLink"/></a:rPr>',
            ) +
              '<a:br><a:rPr lang="zh-CN"/></a:br><a:fld id="{1}" type="slidenum"><a:rPr lang="zh-CN"/><a:t>3</a:t></a:fld>',
            '<a:pPr><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:spcBef><a:spcPts val="600"/></a:spcBef></a:pPr>',
          ),
        ),
      }),
    )
    const p0 = paragraphs(slide, 10)[0]!
    const s = firstRun(p0)
    expect([s.bold, s.italic, s.underline, s.baseline, s.spacing]).toEqual([
      true,
      true,
      'sng',
      0.3,
      1.5,
    ])
    expect(s.highlight === null ? null : rgb(s.highlight)).toBe('FFFF00')
    expect(p0.runs.map((r) => r.kind)).toEqual(['text', 'break', 'field'])
    const field = p0.runs[2]!
    if (field.kind === 'field') expect([field.field, field.text]).toEqual(['slidenum', '3'])
    expect(p0.lineSpacing).toEqual({ unit: 'percent', value: 1.5 })
    expect(p0.spaceBefore).toEqual({ unit: 'points', value: 6 })
  })
})

describe('组合', () => {
  const group = (id: number, x: string, inner: string, fill = '') =>
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="组合 ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr>${x}${fill}</p:grpSpPr>${inner}</p:grpSp>`
  const gx = (off: number[], ext: number[], chOff: number[], chExt: number[], attrs = '') =>
    `<a:xfrm${attrs}><a:off x="${off[0]}" y="${off[1]}"/><a:ext cx="${ext[0]}" cy="${ext[1]}"/>` +
    `<a:chOff x="${chOff[0]}" y="${chOff[1]}"/><a:chExt cx="${chExt[0]}" cy="${chExt[1]}"/></a:xfrm>`

  test('嵌套组合的子坐标系换算到幻灯片坐标，旋转保留在子形状上，组合填充逐级传递', async () => {
    const inner = group(
      20,
      gx([1000, 0], [1000, 1000], [500, 500], [2000, 2000]),
      sp(21, { spPr: `${xfrm(500, 500, 2000, 1000, ' rot="5400000" flipH="1"')}<a:grpFill/>` }),
    )
    const outer = group(
      10,
      gx([1000, 2000], [4000, 2000], [0, 0], [2000, 1000], ' rot="1800000"'),
      sp(11, {
        spPr: `${xfrm(100, 100, 500, 500)}<a:solidFill><a:srgbClr val="123456"/></a:solidFill>`,
      }) + inner,
      '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>',
    )
    const p = await parse({ slides: [{ xml: slideXml(outer) }] })
    const g = byId(p.slides[0]!, 10) as Group
    expect(g.kind).toBe('group')
    expect(g.frame).toEqual({
      x: 1000,
      y: 2000,
      width: 4000,
      height: 2000,
      rotation: 30,
      flipH: false,
      flipV: false,
    })
    const child = g.children[0]!
    expect([child.frame.x, child.frame.y, child.frame.width, child.frame.height]).toEqual([
      1200, 2200, 1000, 1000,
    ])
    const nested = g.children[1] as Group
    const leaf = nested.children[0] as AutoShape
    expect(leaf.frame).toEqual({
      x: 3000,
      y: 2000,
      width: 2000,
      height: 1000,
      rotation: 90,
      flipH: true,
      flipV: false,
    })
    expect(hex(nested.fill)).toBe('4472C4')
    expect(hex(leaf.fill)).toBe('4472C4')
  })

  test('非等比缩放的组合中，旋转接近 90° 的子形状横纵比例互换，中心点照常映射', async () => {
    const g = group(
      10,
      gx([0, 0], [2000, 1000], [0, 0], [1000, 1000]),
      sp(11, { spPr: xfrm(100, 100, 400, 200, ' rot="5400000"') }) +
        sp(12, { spPr: xfrm(100, 100, 400, 200, ' rot="1800000"') }),
    )
    const p = await parse({ slides: [{ xml: slideXml(g) }] })
    const [rotated, slight] = (byId(p.slides[0]!, 10) as Group).children
    const f = rotated!.frame
    expect([f.x + f.width / 2, f.y + f.height / 2, f.width, f.height]).toEqual([600, 200, 400, 400])
    expect([slight!.frame.width, slight!.frame.height]).toEqual([800, 200])
  })
})

describe('表格', () => {
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst ${NS_DECL} def="{S1}">` +
    '<a:tblStyle styleId="{S1}" styleName="测试样式">' +
    '<a:wholeTbl><a:tcTxStyle><a:fontRef idx="minor"><a:prstClr val="black"/></a:fontRef><a:schemeClr val="dk1"/></a:tcTxStyle>' +
    '<a:tcStyle><a:tcBdr><a:left><a:ln w="25400"><a:solidFill><a:schemeClr val="accent2"/></a:solidFill></a:ln></a:left>' +
    '<a:insideH><a:ln w="12700"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></a:insideH></a:tcBdr>' +
    '<a:fill><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fill></a:tcStyle></a:wholeTbl>' +
    '<a:band1H><a:tcStyle><a:tcBdr/><a:fill><a:solidFill><a:schemeClr val="accent3"/></a:solidFill></a:fill></a:tcStyle></a:band1H>' +
    '<a:firstRow><a:tcTxStyle b="on"><a:fontRef idx="minor"/><a:schemeClr val="lt1"/></a:tcTxStyle>' +
    '<a:tcStyle><a:tcBdr/><a:fillRef idx="1"><a:schemeClr val="accent2"/></a:fillRef></a:tcStyle></a:firstRow>' +
    '</a:tblStyle></a:tblStyleLst>'
  const cell = (t: string, attrs = '', tcPr = '<a:tcPr/>') =>
    `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/>${para(run(t))}</a:txBody>${tcPr}</a:tc>`
  const table = (styleId: string) =>
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="30" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
    '<p:xfrm><a:off x="100" y="200"/><a:ext cx="3000000" cy="900000"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    `<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr>` +
    '<a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="2000000"/></a:tblGrid>' +
    `<a:tr h="300000">${cell('表头', ' gridSpan="2"')}${cell('', ' hMerge="1"')}</a:tr>` +
    `<a:tr h="300000">${cell('一')}${cell('二')}</a:tr>` +
    `<a:tr h="300000">${cell('三')}${cell(
      '四',
      '',
      '<a:tcPr marL="0"><a:lnB w="3175"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnB><a:solidFill><a:schemeClr val="accent6"/></a:solidFill></a:tcPr>',
    )}</a:tr>` +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'

  test('列宽行高、合并、表格样式按区域叠加填充边框与文字，单元格设置优先', async () => {
    const p = await parse({ tableStyles: styles, slides: [{ xml: slideXml(table('{S1}')) }] })
    const t = byId(p.slides[0]!, 30) as Table
    expect(t.kind).toBe('table')
    expect(t.columns).toEqual([1000000, 2000000])
    expect(t.rows.map((r) => r.height)).toEqual([300000, 300000, 300000])
    expect(t.styleId).toBe('{S1}')
    expect([t.frame.x, t.frame.y, t.frame.width, t.frame.height]).toEqual([
      100, 200, 3000000, 900000,
    ])
    const c = (r: number, k: number) => t.rows[r]!.cells[k]!
    expect(c(0, 0).gridSpan).toBe(2)
    expect(c(0, 1).hMerge).toBe(true)
    expect(hex(c(0, 0).fill)).toBe('ED7D31')
    const head = firstRun(c(0, 0).text.paragraphs[0]!)
    expect([head.bold, head.latin, hex(head.fill)]).toEqual([true, 'Calibri', 'FFFFFF'])
    expect(hex(c(1, 0).fill)).toBe('A5A5A5')
    expect(c(1, 0).borders.top?.width).toBe(12700)
    expect(hex(c(1, 0).borders.top?.fill ?? null)).toBe('FFFFFF')
    expect(c(1, 0).borders.left?.width).toBe(25400)
    expect(c(1, 1).borders.left).toBeNull()
    expect(c(2, 0).borders.bottom).toBeNull()
    expect(hex(c(2, 0).fill)).toBe('4472C4')
    expect(hex(c(2, 1).fill)).toBe('70AD47')
    expect(c(2, 1).borders.bottom?.width).toBe(3175)
    expect(c(2, 1).marginLeft).toBe(0)
    const body = firstRun(c(1, 0).text.paragraphs[0]!)
    expect([body.bold, body.size, hex(body.fill)]).toEqual([false, 18, '000000'])
  })

  test('样式 ID 不在表格样式部件中时不应用样式并计入 tableStyle', async () => {
    const p = await parse({ tableStyles: styles, slides: [{ xml: slideXml(table('{X}')) }] })
    const t = byId(p.slides[0]!, 30) as Table
    expect(t.rows[1]!.cells[0]!.fill).toEqual({ kind: 'none' })
    expect(p.slides[0]!.unsupported.tableStyle).toBe(1)
  })
})

describe('图片、几何与未实现元素', () => {
  const frame = (id: number, uri: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="对象"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="0" y="0"/><a:ext cx="10" cy="10"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"/></a:graphic></p:graphicFrame>`
  const pic = (id: number, blip: string, nvPr = '<p:nvPr/>') =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="图片"/><p:cNvPicPr/>${nvPr}</p:nvPicPr>` +
    `<p:blipFill>${blip}<a:srcRect l="10000" t="20000"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrm(0, 0, 10, 10)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
  const P14 = 'xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"'

  test('相机旋转与光照随图片与形状给出；挤出与轮廓登记一次，正面照常投影', async () => {
    const scene =
      '<a:scene3d><a:camera prst="perspectiveRelaxedModerately"><a:rot lat="17690635" lon="0" rev="0"/></a:camera>' +
      '<a:lightRig rig="contrasting" dir="t"/></a:scene3d>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            '<p:pic><p:nvPicPr><p:cNvPr id="60" name="图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
              '<p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
              `<p:spPr>${xfrm(0, 0, 10, 10)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${scene}` +
              '<a:sp3d extrusionH="146050" contourW="38100"/></p:spPr></p:pic>' +
              sp(61, {
                spPr: `${xfrm(0, 0, 10, 10)}<a:scene3d><a:camera prst="isometricTopUp"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>`,
              }) +
              sp(62, { spPr: xfrm(0, 0, 10, 10) }),
          ),
          rels: [['rIdImg', 'image', '../media/image1.png']],
        },
      ],
    })
    const slide = p.slides[0]!
    const picture = byId(slide, 60) as Picture
    expect(picture.threeD?.rotation.lat).toBeCloseTo(294.8439, 3)
    expect(picture.threeD?.scale).toBe(0.969)
    expect(autoShape(slide, 61).threeD?.rotation).toEqual({ lat: 35.26, lon: 45, rev: 60 })
    expect(autoShape(slide, 61).threeD?.distance).toBeNull()
    expect(autoShape(slide, 62).threeD).toBeNull()
    expect(slide.unsupported.effect3d).toBe(1)
  })

  test('图片的部件、裁剪、透明度与几何；自定义几何的路径', async () => {
    const cust =
      '<a:custGeom><a:avLst/><a:gdLst><a:gd name="g1" fmla="*/ w 1 2"/></a:gdLst><a:rect l="0" t="0" r="r" b="b"/>' +
      '<a:pathLst><a:path w="100" h="200"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="g1" y="200"/></a:lnTo>' +
      '<a:arcTo wR="50" hR="50" stAng="0" swAng="5400000"/><a:cubicBezTo><a:pt x="1" y="2"/><a:pt x="3" y="4"/><a:pt x="5" y="6"/></a:cubicBezTo>' +
      '<a:close/></a:path></a:pathLst></a:custGeom>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            pic(40, '<a:blip r:embed="rIdImg"><a:alphaModFix amt="50000"/></a:blip>') +
              sp(41, { spPr: xfrm(0, 0, 10, 10) + cust }) +
              sp(42, {
                spPr: `${xfrm(0, 0, 10, 10)}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 25000"/></a:avLst></a:prstGeom>`,
              }),
          ),
          rels: [['rIdImg', 'image', '../media/image1.png']],
        },
      ],
    })
    const slide = p.slides[0]!
    const picture = byId(slide, 40) as Picture
    expect(picture.image.part).toBe('/ppt/media/image1.png')
    expect(picture.image.crop).toEqual({ left: 0.1, top: 0.2, right: 0, bottom: 0 })
    expect(picture.image.alpha).toBe(0.5)
    expect(picture.geometry).toEqual({ kind: 'preset', name: 'ellipse', adjust: [] })
    expect(autoShape(slide, 41).geometry).toEqual({
      kind: 'custom',
      adjust: [],
      guides: [{ name: 'g1', formula: '*/ w 1 2' }],
      textRect: { left: 0, top: 0, right: 'r', bottom: 'b' },
      paths: [
        {
          width: 100,
          height: 200,
          fill: 'norm',
          stroke: true,
          commands: [
            { kind: 'move', to: { x: 0, y: 0 } },
            { kind: 'line', to: { x: 'g1', y: 200 } },
            { kind: 'arc', widthRadius: 50, heightRadius: 50, startAngle: 0, swingAngle: 5400000 },
            {
              kind: 'cubic',
              points: [
                { x: 1, y: 2 },
                { x: 3, y: 4 },
                { x: 5, y: 6 },
              ],
            },
            { kind: 'close' },
          ],
        },
      ],
    })
    expect(autoShape(slide, 42).geometry).toEqual({
      kind: 'preset',
      name: 'roundRect',
      adjust: [{ name: 'adj', formula: 'val 25000' }],
    })
  })

  test('图表、SmartArt、墨迹、媒体、动画、切换、艺术字变形与图片效果按种类计数；母版装饰按出现的幻灯片计数', async () => {
    const shapes =
      frame(50, 'http://schemas.openxmlformats.org/drawingml/2006/chart') +
      frame(51, 'http://schemas.openxmlformats.org/drawingml/2006/diagram') +
      `<p:contentPart ${P14} r:id="rIdInk"/>` +
      `<mc:AlternateContent ${MC} ${P14}><mc:Choice Requires="p14"><p:contentPart r:id="rIdInk"/></mc:Choice>` +
      `<mc:Fallback>${pic(52, '<a:blip r:embed="rIdImg"/>')}</mc:Fallback></mc:AlternateContent>` +
      pic(53, '<a:blip r:embed="rIdImg"/>', '<p:nvPr><a:videoFile r:link="rIdVideo"/></p:nvPr>') +
      pic(
        54,
        '<a:blip r:embed="rIdImg"><a:duotone><a:srgbClr val="000000"/><a:srgbClr val="FFFFFF"/></a:duotone></a:blip>',
      ) +
      sp(55, {
        spPr: xfrm(0, 0, 10, 10),
        body: text(
          para(run('弯')),
          '<a:bodyPr><a:prstTxWarp prst="textArchUp"><a:avLst/></a:prstTxWarp></a:bodyPr>',
        ),
      })
    const timing =
      '<p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst>' +
      '<p:set><p:cBhvr><p:tgtEl><p:spTgt spid="50"/></p:tgtEl></p:cBhvr></p:set>' +
      '<p:set><p:cBhvr><p:tgtEl><p:spTgt spid="50"/></p:tgtEl></p:cBhvr></p:set>' +
      '<p:set><p:cBhvr><p:tgtEl><p:spTgt spid="55"/></p:tgtEl></p:cBhvr></p:set>' +
      '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
    const master = masterXml({
      shapes: `${sp(2, { ph: 'type="title"', spPr: xfrm(0, 0, 1, 1) })}${frame(9, 'http://schemas.openxmlformats.org/drawingml/2006/chart')}`,
    })
    const p = await parse({
      master,
      slides: [
        {
          xml: slideXml(shapes, {
            extra: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:transition><p:fade/></p:transition>${timing}`,
          }),
          rels: [['rIdImg', 'image', '../media/image1.png']],
        },
        { xml: slideXml('') },
        { xml: slideXml('', { attrs: ' showMasterSp="0"' }) },
      ],
    })
    // 两处墨迹的关系都不存在：`AlternateContent` 取 `contentPart` 分支，不读取替代图片 52。
    expect(p.slides[0]!.unsupported).toEqual({
      chart: 2,
      smartArt: 1,
      ink: 2,
      media: 1,
      imageEffect: 1,
      textWarp: 1,
      animation: 2,
      transition: 1,
    })
    expect(p.slides[0]!.shapes.some((s) => s.id === 52)).toBe(false)
    const chart = byId(p.slides[0]!, 50)
    expect(chart.kind === 'graphic' ? chart.content : null).toBe('chart')
    expect(p.slides[1]!.unsupported).toEqual({ chart: 1 })
    expect(p.slides[2]!.unsupported).toEqual({})
    expect(p.unsupported.chart).toBe(3)
  })

  test('OLE 对象按 Fallback 中的替代图片读取为图片，位置尺寸取外框；没有替代图片时计入 ole', async () => {
    // WPS 演示实测（构造文件）：替代图片自身的 xfrm 与外框不同时按外框显示；没有替代图片的 OLE 对象不显示。
    const ole = (id: number, inner: string) =>
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="对象 ${id}"/><p:cNvGraphicFramePr/><p:nvPr/>` +
      `</p:nvGraphicFramePr><p:xfrm><a:off x="100" y="200"/><a:ext cx="300" cy="400"/></p:xfrm><a:graphic>` +
      '<a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole">' +
      `<mc:AlternateContent ${MC}><mc:Choice xmlns:v="urn:schemas-microsoft-com:vml" Requires="v">` +
      '<p:oleObj spid="_x0000_s1025" name="" r:id="rIdOle" progId="Equation.3"><p:embed/></p:oleObj></mc:Choice>' +
      `<mc:Fallback><p:oleObj name="" r:id="rIdOle" progId="Equation.3"><p:embed/>${inner}</p:oleObj></mc:Fallback>` +
      '</mc:AlternateContent></a:graphicData></a:graphic></p:graphicFrame>'
    const p = await parse({
      slides: [
        {
          xml: slideXml(ole(70, pic(0, '<a:blip r:embed="rIdImg"/>')) + ole(71, '')),
          rels: [
            ['rIdImg', 'image', '../media/image1.png'],
            ['rIdOle', 'oleObject', '../embeddings/oleObject1.bin'],
          ],
        },
      ],
    })
    const slide = p.slides[0]!
    const picture = byId(slide, 70) as Picture
    expect(picture.kind).toBe('picture')
    expect(picture.name).toBe('对象 70')
    expect(picture.image.part).toBe('/ppt/media/image1.png')
    expect(picture.image.crop.left).toBeCloseTo(0.1)
    expect([picture.frame.x, picture.frame.y, picture.frame.width, picture.frame.height]).toEqual([
      100, 200, 300, 400,
    ])
    expect(byId(slide, 71).kind).toBe('graphic')
    expect(slide.unsupported).toEqual({ ole: 1 })
  })

  test('墨迹：InkML 的差分编码解码；外接框按同一比例对应形状框；笔宽按压力换算；单点笔画位于形状框中心', async () => {
    const ink = (traces: string, brush: string) =>
      '<inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:definitions><inkml:context xml:id="ctx0">' +
      '<inkml:inkSource xml:id="s0"><inkml:traceFormat><inkml:channel name="X" type="integer"/>' +
      '<inkml:channel name="Y" type="integer"/><inkml:channel name="F" type="integer" max="1000"/></inkml:traceFormat>' +
      `</inkml:inkSource></inkml:context><inkml:brush xml:id="br0">${brush}</inkml:brush></inkml:definitions>${traces}</inkml:ink>`
    const width = '<inkml:brushProperty name="width" value="0.1" units="cm"/>'
    const color = '<inkml:brushProperty name="color" value="#F80600"/>'
    // 显式 (100, 200)，一阶差分 (+100, 0)，二阶差分 (+100 + 50, 0)：x 为 100、200、350，压力 0.5、0.5、0.75。
    const line = `<inkml:trace brushRef="#br0">100 200 500,'100'0'0,"50"0"250</inkml:trace>`
    const content = (id: number, rid: string, cx: number, cy: number) =>
      `<mc:AlternateContent ${MC} ${P14}><mc:Choice Requires="p14"><p:contentPart r:id="${rid}">` +
      `<p14:nvContentPartPr><p14:cNvPr id="${id}" name="墨迹"/><p14:cNvContentPartPr/><p14:nvPr/></p14:nvContentPartPr>` +
      `<p14:xfrm><a:off x="1000" y="2000"/><a:ext cx="${cx}" cy="${cy}"/></p14:xfrm></p:contentPart></mc:Choice>` +
      `<mc:Fallback>${pic(id + 100, '<a:blip r:embed="rIdImg"/>')}</mc:Fallback></mc:AlternateContent>`
    const p = await parse({
      slides: [
        {
          xml: slideXml(content(60, 'rIdA', 5000, 127) + content(61, 'rIdB', 127, 127)),
          rels: [
            ['rIdA', 'customXml', '../ink/ink1.xml'],
            ['rIdB', 'customXml', '../ink/ink2.xml'],
            ['rIdImg', 'image', '../media/image1.png'],
          ],
        },
      ],
      media: {
        'ppt/ink/ink1.xml': ink(line, width + color),
        'ppt/ink/ink2.xml': ink('<inkml:trace brushRef="#br0">7 8 1000</inkml:trace>', ''),
      },
    })
    const slide = p.slides[0]!
    expect(slide.unsupported).toEqual({})
    expect(slide.shapes.map((s) => s.id)).toEqual([60, 61])
    const [a, b] = slide.shapes as Ink[]
    expect(a!.kind).toBe('ink')
    expect(a!.frame).toMatchObject({ x: 1000, y: 2000, width: 5000, height: 127 })
    expect(a!.strokes[0]!.color).toEqual({ r: 248 / 255, g: 6 / 255, b: 0, a: 1 })
    // 外接框 250 × 0 对应宽 5000 EMU：每单位 20 EMU；外接框高为 0，各点位于形状框的纵向中线。
    expect(a!.strokes[0]!.points).toEqual([
      { x: 0, y: 63.5, width: 36000 * (0.2 + 1.6 * 0.5) },
      { x: 2000, y: 63.5, width: 36000 * (0.2 + 1.6 * 0.5) },
      { x: 5000, y: 63.5, width: 36000 * (0.2 + 1.6 * 0.75) },
    ])
    expect(b!.strokes[0]!.points).toEqual([{ x: 63.5, y: 63.5, width: 0.0529 * 360000 * 1.8 }])
  })
})

describe('SmartArt', () => {
  const smartArt = (id: number, ids: string) =>
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="图示"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm><a:off x="100" y="200"/><a:ext cx="8151495" cy="660920"/></p:xfrm><a:graphic>` +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">' +
    `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" ${ids}/>` +
    '</a:graphicData></a:graphic></p:graphicFrame>'

  test('按数据部件与布局定义求值为 diagram，不计入 smartArt；布局部件缺失时计入 smartArt', async () => {
    const data = dataXml([['甲'], ['乙']], { node: 'node', trans: ['space'] })
    const p = await parse({
      slides: [
        {
          xml: slideXml(
            smartArt(7, 'r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"') +
              smartArt(8, 'r:dm="rIdDm2" r:qs="rIdQs" r:cs="rIdCs"'),
          ),
          rels: [
            ['rIdDm', 'diagramData', '../diagrams/data1.xml'],
            ['rIdLo', 'diagramLayout', '../diagrams/layout1.xml'],
            ['rIdQs', 'diagramQuickStyle', '../diagrams/quickStyle1.xml'],
            ['rIdCs', 'diagramColors', '../diagrams/colors1.xml'],
            ['rIdDm2', 'diagramData', '../diagrams/data2.xml'],
          ],
        },
      ],
      media: {
        'ppt/diagrams/data1.xml': data,
        'ppt/diagrams/data2.xml': data,
        'ppt/diagrams/layout1.xml': CHEVRON(),
        'ppt/diagrams/quickStyle1.xml': STYLES,
        'ppt/diagrams/colors1.xml': colorsXml(),
      },
    })
    const slide = p.slides[0]!
    const drawn = byId(slide, 7)
    expect(drawn.kind).toBe('diagram')
    expect(drawn.frame).toMatchObject({ x: 100, y: 200, width: 8151495, height: 660920 })
    const names = drawn.kind === 'diagram' ? drawn.diagram.root.children.map((c) => c.name) : []
    expect(names).toEqual(['node', 'space', 'node'])
    const missing = byId(slide, 8)
    expect(missing.kind === 'graphic' ? missing.content : null).toBe('smartArt')
    expect(slide.unsupported).toEqual({ smartArt: 1 })
    expect(presentationFonts(p)).toContain('等线')
  })
})
