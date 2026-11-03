/**
 * 覆盖 `fill.ts`（`readFill` 的六种填充、`readLine` 与 `mergeLine`、`readEffects`、`resolveFill` 与 `resolveLine`
 * 的求值规则）与 `theme.ts` 的格式方案（`fmtScheme` 四个列表、`styleFill`、`styleLine`、`styleEffect` 的索引规则）。
 */

import { describe, expect, test } from 'bun:test'
import type { Relationships } from '../opc/package.ts'
import { PartScanner } from '../opc/scanner.ts'
import { colorToHex, DEFAULT_COLOR_MAP } from './color.ts'
import {
  mergeLine,
  readEffects,
  readFill,
  readLine,
  resolveEffects,
  resolveFill,
  resolveLine,
} from './fill.ts'
import { parseTheme, styleEffect, styleFill, styleLine } from './theme.ts'

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** 定位到根元素的开始标签。 */
function at(xml: string): PartScanner {
  const x = new PartScanner(xml)
  x.next()
  return x
}

const RELS: Relationships = {
  source: '/ppt/slides/slide1.xml',
  list: [],
  byId: (id) =>
    id === 'rId1'
      ? {
          id,
          type: '',
          kind: 'image',
          target: '../media/a.png',
          external: false,
          part: '/ppt/media/a.png',
        }
      : null,
  ofKind: () => [],
  part: () => null,
}

const SCHEME = {
  dk1: { r: 0, g: 0, b: 0, a: 1 },
  lt1: { r: 1, g: 1, b: 1, a: 1 },
  dk2: null,
  lt2: null,
  accent1: { r: 0x44 / 255, g: 0x72 / 255, b: 0xc4 / 255, a: 1 },
  accent2: null,
  accent3: null,
  accent4: null,
  accent5: null,
  accent6: null,
  hlink: null,
  folHlink: null,
}
const CONTEXT = { scheme: SCHEME, map: DEFAULT_COLOR_MAP }

describe('readFill', () => {
  test('纯色、无填充与组合填充', () => {
    expect(readFill(at(`<a:solidFill ${A}><a:srgbClr val="FF0000"/></a:solidFill>`), null)).toEqual(
      {
        kind: 'solid',
        color: { kind: 'rgb', color: { r: 1, g: 0, b: 0, a: 1 }, transforms: [] },
      },
    )
    expect(readFill(at(`<a:noFill ${A}/>`), null)).toEqual({ kind: 'none' })
    expect(readFill(at(`<a:grpFill ${A}/>`), null)).toEqual({ kind: 'group' })
    expect(readFill(at(`<a:solidFill ${A}/>`), null)).toEqual({ kind: 'solid', color: null })
  })

  test('渐变：色标按位置排序，路径渐变的终点矩形', () => {
    const spec = readFill(
      at(
        `<a:gradFill ${A} flip="x" rotWithShape="0"><a:gsLst><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>` +
          '<a:gs pos="0"><a:schemeClr val="accent1"/></a:gs></a:gsLst>' +
          '<a:path path="rect"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>',
      ),
      null,
    )
    expect(spec.kind).toBe('gradient')
    if (spec.kind !== 'gradient') return
    expect(spec.stops.map((s) => s.position)).toEqual([0, 1])
    expect(spec.shade).toEqual({
      kind: 'path',
      path: 'rect',
      focus: { left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 },
    })
    expect([spec.flip, spec.rotateWithShape]).toEqual(['x', false])
    const fill = resolveFill(spec, CONTEXT)
    expect(fill.kind === 'gradient' ? fill.stops.map((s) => colorToHex(s.color)) : null).toEqual([
      '4472C4',
      '0000FF',
    ])
  })

  test('图片：关系解析为部件，裁剪、平铺、透明度与图片效果；扩展中的效果不记录', () => {
    const spec = readFill(
      at(
        `<a:blipFill ${A} ${R}><a:blip r:embed="rId1"><a:alphaModFix amt="40000"/><a:grayscl/>` +
          '<a:extLst><a:ext uri="x"><a14:imgProps xmlns:a14="urn:a14"><a14:imgLayer><a14:imgEffect><a14:artisticBlur/></a14:imgEffect>' +
          '</a14:imgLayer></a14:imgProps></a:ext></a:extLst></a:blip>' +
          '<a:srcRect l="-5000" r="25000"/><a:tile tx="10" ty="20" sx="50000" sy="50000" flip="xy" algn="ctr"/></a:blipFill>',
      ),
      RELS,
    )
    expect(spec).toEqual({
      kind: 'picture',
      image: {
        part: '/ppt/media/a.png',
        crop: { left: -0.05, top: 0, right: 0.25, bottom: 0 },
        stretch: null,
        tile: { offsetX: 10, offsetY: 20, scaleX: 0.5, scaleY: 0.5, flip: 'xy', align: 'ctr' },
        alpha: 0.4,
        effects: [{ kind: 'grayscale' }],
        rotateWithShape: true,
      },
    })
    const noRels = readFill(at(`<a:blipFill ${A} ${R}><a:blip r:embed="rId1"/></a:blipFill>`), null)
    expect(noRels.kind === 'picture' ? noRels.image.part : 'x').toBeNull()
  })

  test('图片效果：亮度对比度、黑白阈值、双色调与透明色按文档顺序读取，颜色求值失败的效果去掉', () => {
    const spec = readFill(
      at(
        `<a:blipFill ${A} ${R}><a:blip r:embed="rId1"><a:lum bright="-24000" contrast="66000"/><a:biLevel thresh="50000"/>` +
          '<a:duotone><a:prstClr val="black"/><a:schemeClr val="accent1"><a:tint val="45000"/></a:schemeClr></a:duotone>' +
          '<a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>' +
          '<a:duotone><a:srgbClr val="000000"/></a:duotone><a:hsl hue="0" sat="0" lum="0"/></a:blip></a:blipFill>',
      ),
      RELS,
    )
    const fill = resolveFill(spec, CONTEXT)
    const effects = fill.kind === 'picture' ? fill.image.effects : []
    expect(effects.map((e) => e.kind)).toEqual([
      'luminance',
      'biLevel',
      'duotone',
      'colorChange',
      'other',
    ])
    expect(effects[0]).toEqual({ kind: 'luminance', bright: -0.24, contrast: 0.66 })
    expect(effects[1]).toEqual({ kind: 'biLevel', threshold: 0.5 })
    const duo = effects[2]
    expect(duo?.kind === 'duotone' ? [colorToHex(duo.dark), duo.light.r < 1] : null).toEqual([
      '000000',
      true,
    ])
    const change = effects[3]
    expect(change?.kind === 'colorChange' ? colorToHex(change.from) : null).toBe('FFFFFF')
    expect(effects[4]).toEqual({ kind: 'other', name: 'hsl' })
  })

  test('图案：前景背景缺失时求值为黑与白', () => {
    const spec = readFill(
      at(
        `<a:pattFill ${A} prst="dkHorz"><a:fgClr><a:srgbClr val="00FF00"/></a:fgClr></a:pattFill>`,
      ),
      null,
    )
    const fill = resolveFill(spec, CONTEXT)
    expect(fill.kind).toBe('pattern')
    if (fill.kind === 'pattern') {
      expect([fill.preset, colorToHex(fill.foreground), colorToHex(fill.background)]).toEqual([
        'dkHorz',
        '00FF00',
        'FFFFFF',
      ])
    }
  })

  test('颜色无法求值的纯色填充为无填充', () => {
    const spec = readFill(at(`<a:solidFill ${A}><a:schemeClr val="phClr"/></a:solidFill>`), null)
    expect(resolveFill(spec, CONTEXT)).toEqual({ kind: 'none' })
    const withPlaceholder = resolveFill(spec, {
      ...CONTEXT,
      placeholder: { r: 0, g: 1, b: 0, a: 1 },
    })
    expect(withPlaceholder.kind === 'solid' ? colorToHex(withPlaceholder.color) : null).toBe(
      '00FF00',
    )
  })
})

describe('readLine', () => {
  test('宽度、端点、复合、虚线、连接与箭头；按字段合并；无填充求值为 null', () => {
    const base = readLine(
      at(
        `<a:ln ${A} w="12700" cap="rnd" cmpd="dbl" algn="in"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>` +
          '<a:custDash><a:ds d="300000" sp="100000"/></a:custDash><a:miter lim="800000"/>' +
          '<a:headEnd type="triangle" w="lg" len="sm"/><a:tailEnd type="none"/></a:ln>',
      ),
      null,
    )
    expect(base).toEqual({
      width: 12700,
      cap: 'rnd',
      compound: 'dbl',
      align: 'in',
      fill: {
        kind: 'solid',
        color: { kind: 'rgb', color: { r: 1, g: 0, b: 0, a: 1 }, transforms: [] },
      },
      dash: { kind: 'custom', stops: [{ dash: 3, space: 1 }] },
      join: 'miter',
      miterLimit: 8,
      head: { type: 'triangle', width: 'lg', length: 'sm' },
      tail: { type: 'none', width: 'med', length: 'med' },
    })
    const merged = mergeLine(base, readLine(at(`<a:ln ${A} w="25400"><a:round/></a:ln>`), null))
    const line = resolveLine(merged, CONTEXT)
    expect(line?.width).toBe(25400)
    expect(line?.join).toBe('round')
    expect(line?.miterLimit).toBeNull()
    expect(line?.tail).toBeNull()
    expect(line?.head).toEqual({ type: 'triangle', width: 'lg', length: 'sm' })
    expect(resolveLine(readLine(at(`<a:ln ${A} w="9525"/>`), null), CONTEXT)).toBeNull()
    expect(resolveLine(readLine(at(`<a:ln ${A}><a:noFill/></a:ln>`), null), CONTEXT)).toBeNull()
  })
})

describe('readEffects', () => {
  test('阴影、发光、柔化边缘、倒影、模糊与未实现的效果', () => {
    const list = readEffects(
      at(
        `<a:effectLst ${A}><a:outerShdw blurRad="10" dist="20" dir="2700000" sx="90000" algn="tl"><a:schemeClr val="phClr"/></a:outerShdw>` +
          '<a:glow rad="30"><a:srgbClr val="FFFF00"/></a:glow><a:softEdge rad="40"/>' +
          '<a:reflection stA="50000" endPos="35000" dist="5"/><a:blur rad="6" grow="0"/><a:fillOverlay blend="mult"/></a:effectLst>',
      ),
    )
    expect(list.map((e) => e.kind)).toEqual([
      'outerShadow',
      'glow',
      'softEdge',
      'reflection',
      'blur',
      'other',
    ])
    const shadow = list[0]!
    if (shadow.kind === 'outerShadow') {
      expect([shadow.blur, shadow.distance, shadow.direction, shadow.scaleX, shadow.align]).toEqual(
        [10, 20, 45, 0.9, 'tl'],
      )
    }
    // phClr 没有取值时阴影整项去掉。
    expect(resolveEffects(list, CONTEXT).map((e) => e.kind)).toEqual([
      'glow',
      'softEdge',
      'reflection',
      'blur',
      'other',
    ])
  })
})

describe('格式方案', () => {
  const theme =
    `<a:theme ${A} ${R}><a:themeElements><a:clrScheme name="c"/><a:fontScheme name="f"/><a:fmtScheme name="格式">` +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:noFill/></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln w="6350"/><a:ln w="12700"/></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectDag/><a:sp3d><a:bevelT/></a:sp3d></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:noFill/><a:blipFill><a:blip r:embed="rId1"/></a:blipFill></a:bgFillStyleLst>' +
    '</a:fmtScheme></a:themeElements></a:theme>'

  test('四个列表按文档顺序读取，背景图片按主题关系解析', () => {
    const f = parseTheme(theme, RELS).formats
    expect(f.name).toBe('格式')
    expect(f.fills.map((x) => x.kind)).toEqual(['solid', 'none'])
    expect(f.lines.map((x) => x.width)).toEqual([6350, 12700])
    expect(f.effects).toEqual([
      { effects: [], scene3d: null, shape3d: null },
      {
        effects: [{ kind: 'other', name: 'effectDag' }],
        scene3d: null,
        shape3d: {
          extrusion: 0,
          contour: 0,
          top: { width: 76200, height: 76200, preset: 'circle' },
          bottom: null,
          material: 'warmMatte',
        },
      },
    ])
    const bg = f.backgroundFills[1]!
    expect(bg.kind === 'picture' ? bg.image.part : null).toBe('/ppt/media/a.png')
  })

  test('样式矩阵索引：0 与 1000 为无，1–999 取填充列表，1001 起取背景填充列表，超出为 null', () => {
    const f = parseTheme(theme, RELS).formats
    expect(styleFill(f, 0)).toBeNull()
    expect(styleFill(f, 1000)).toBeNull()
    expect(styleFill(f, 1)?.kind).toBe('solid')
    expect(styleFill(f, 2)?.kind).toBe('none')
    expect(styleFill(f, 3)).toBeNull()
    expect(styleFill(f, 1001)?.kind).toBe('none')
    expect(styleFill(f, 1002)?.kind).toBe('picture')
    expect(styleFill(f, 1003)).toBeNull()
    expect(styleLine(f, 0)).toBeNull()
    expect(styleLine(f, 2)?.width).toBe(12700)
    expect(styleLine(f, 3)).toBeNull()
    expect(styleEffect(f, 0)).toBeNull()
    expect(styleEffect(f, 2)?.shape3d?.top?.preset).toBe('circle')
  })

  test('没有 fmtScheme 时各列表为空', () => {
    const f = parseTheme(`<a:theme ${A}><a:themeElements/></a:theme>`).formats
    expect(f).toEqual({ name: '', fills: [], lines: [], effects: [], backgroundFills: [] })
  })
})
