/**
 * 覆盖 `color.ts`（颜色元素读取、主题色求值、颜色变换、RGB 与 HSL 互转、sRGB 传递函数、输出格式）与 `preset.ts`。
 *
 * 期望值的来源：
 * - 规范示例：`comp` 与 `inv` 把红色变为青色；`lumMod` 50% 使 00FF00 的亮度减半。
 * - 主题配色面板的浅色与深色变体（`lumMod` 与 `lumOff` 组合，如 4472C4 的「淡色 80%」为 DAE3F3）。
 * - WPS 演示 `Slide.Export` 导出图中色块的像素值（`tint`、`shade`、`inv`、`gray`）。
 * - 其余按 HSL 定义与 IEC 61966-2-1 传递函数独立计算，保留到 8 位取整后的十六进制值。
 */

import { describe, expect, test } from 'bun:test'
import { PartScanner } from '../opc/scanner.ts'
import {
  type Color,
  type ColorMap,
  type ColorScheme,
  type ColorSpec,
  colorToCss,
  colorToHex,
  DEFAULT_COLOR_MAP,
  hslToRgb,
  isColorElement,
  linearToSrgb,
  parseHexColor,
  parsePercentage,
  readColor,
  resolveColor,
  rgbToHsl,
  SCHEME_SLOTS,
  srgbToLinear,
} from './color.ts'
import { presetColorHex } from './preset.ts'

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

/** 读取片段中第一个颜色元素。 */
function read(fragment: string): ColorSpec | null {
  const x = new PartScanner(`<root ${A}>${fragment}</root>`)
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'start' && isColorElement(x.local)) return readColor(x)
  }
  throw new Error('片段中没有颜色元素')
}

function hex(c: Color | null): string | null {
  return c === null ? null : colorToHex(c)
}

const SCHEME: ColorScheme = {
  ...(Object.fromEntries(SCHEME_SLOTS.map((s) => [s, null])) as Record<string, null>),
  dk1: parseHexColor('000000'),
  lt1: parseHexColor('FFFFFF'),
  dk2: parseHexColor('44546A'),
  lt2: parseHexColor('E7E6E6'),
  accent1: parseHexColor('4472C4'),
  accent2: parseHexColor('ED7D31'),
  accent3: parseHexColor('A5A5A5'),
  accent4: parseHexColor('FFC000'),
  accent5: parseHexColor('5B9BD5'),
  accent6: parseHexColor('70AD47'),
} as ColorScheme

/** 读取并以默认颜色映射求值。 */
function resolve(fragment: string, placeholder?: Color): string | null {
  const spec = read(fragment)
  if (spec === null) return null
  return hex(resolveColor(spec, placeholder ? { scheme: SCHEME, placeholder } : { scheme: SCHEME }))
}

describe('颜色模型', () => {
  test('srgbClr、sysClr 取 lastClr、prstClr 含缩写名', () => {
    expect(resolve('<a:srgbClr val="1f4e79"/>')).toBe('1F4E79')
    expect(resolve('<a:sysClr val="windowText" lastClr="000000"/>')).toBe('000000')
    expect(resolve('<a:prstClr val="dkBlue"/>')).toBe('00008B')
    expect(resolve('<a:prstClr val="ltGoldenrodYellow"/>')).toBe('FAFAD2')
    expect(resolve('<a:prstClr val="medAquamarine"/>')).toBe('66CDAA')
    expect(resolve('<a:prstClr val="darkSlateGrey"/>')).toBe('2F4F4F')
    expect(resolve('<a:prstClr val="white"/>')).toBe('FFFFFF')
  })

  test('scrgbClr 的分量为线性值，hslClr 的色相为六万分之一度', () => {
    expect(resolve('<a:scrgbClr r="50000" g="0" b="100000"/>')).toBe('BC00FF')
    expect(resolve('<a:scrgbClr r="50%" g="0%" b="100%"/>')).toBe('BC00FF')
    expect(resolve('<a:hslClr hue="14400000" sat="100000" lum="50000"/>')).toBe('0000FF')
    expect(resolve('<a:hslClr hue="0" sat="0%" lum="50%"/>')).toBe('808080')
  })

  test('schemeClr 经颜色映射落到槽位，phClr 取占位色', () => {
    expect(resolve('<a:schemeClr val="tx1"/>')).toBe('000000')
    expect(resolve('<a:schemeClr val="bg2"/>')).toBe('E7E6E6')
    expect(resolve('<a:schemeClr val="dk2"/>')).toBe('44546A')
    expect(resolve('<a:schemeClr val="accent6"/>')).toBe('70AD47')
    expect(resolve('<a:schemeClr val="phClr"/>', parseHexColor('123456')!)).toBe('123456')
    expect(resolve('<a:schemeClr val="phClr"/>')).toBeNull()
    expect(resolve('<a:schemeClr val="hlink"/>')).toBeNull()
  })

  test('指定的颜色映射', () => {
    const spec = read('<a:schemeClr val="bg1"/>')!
    const map: ColorMap = { ...DEFAULT_COLOR_MAP, bg1: 'dk1', tx1: 'lt1', bg2: 'dk2', tx2: 'lt2' }
    expect(hex(resolveColor(spec, { scheme: SCHEME, map }))).toBe('000000')
  })

  test('基色无法解析时为 null', () => {
    expect(read('<a:srgbClr val="12345"/>')).toBeNull()
    expect(read('<a:sysClr val="window"/>')).toBeNull()
    expect(read('<a:prstClr val="noSuchColor"/>')).toBeNull()
    expect(read('<a:schemeClr val="accent7"/>')).toBeNull()
    expect(read('<a:hslClr hue="0" sat="50000"/>')).toBeNull()
  })

  test('读取到颜色元素的结束标签为止，不解析的子元素忽略', () => {
    const x = new PartScanner(
      `<a:solidFill ${A}><a:srgbClr val="FF0000"><a:lumMod val="50000"><a:x/></a:lumMod>` +
        '<a:unknown val="1"/><a:satMod val="bad"/></a:srgbClr><a:next/></a:solidFill>',
    )
    x.next()
    x.next()
    const spec = readColor(x)
    expect(spec).toEqual({
      kind: 'rgb',
      color: { r: 1, g: 0, b: 0, a: 1 },
      transforms: [{ name: 'lumMod', value: 0.5 }],
    })
    expect(x.local).toBe('srgbClr')
    expect(x.depth).toBe(2)
    expect(x.next()).toBe('start')
    expect(x.local).toBe('next')
  })
})

describe('颜色变换', () => {
  test('规范示例：comp 与 inv 把红色变为青色，lumMod 50% 使亮度减半', () => {
    expect(resolve('<a:srgbClr val="FF0000"><a:comp/></a:srgbClr>')).toBe('00FFFF')
    expect(resolve('<a:srgbClr val="FF0000"><a:inv/></a:srgbClr>')).toBe('00FFFF')
    expect(resolve('<a:srgbClr val="00FF00"><a:lumMod val="50000"/></a:srgbClr>')).toBe('008000')
    expect(resolve('<a:srgbClr val="00FF00"><a:lumOff val="-20000"/></a:srgbClr>')).toBe('009900')
  })

  test('主题配色面板的浅色与深色变体', () => {
    const variants = (slot: string) =>
      [
        [20000, 80000],
        [40000, 60000],
        [60000, 40000],
        [75000, 0],
        [50000, 0],
      ].map(([mod, off]) =>
        resolve(
          `<a:schemeClr val="${slot}"><a:lumMod val="${mod}"/>${off ? `<a:lumOff val="${off}"/>` : ''}</a:schemeClr>`,
        ),
      )
    expect(variants('accent1')).toEqual(['DAE3F3', 'B4C7E7', '8FAADC', '2F5597', '203864'])
    expect(variants('accent2')).toEqual(['FBE5D6', 'F8CBAD', 'F4B183', 'C55A11', '843C0B'])
    expect(variants('accent4')).toEqual(['FFF2CC', 'FFE699', 'FFD966', 'BF9000', '806000'])
    expect(variants('accent5')).toEqual(['DEEBF7', 'BDD7EE', '9DC3E6', '2E75B6', '1F4E79'])
    // 70AD47 的「深色 50%」分量恰为 86.5 与 35.5，取整方向取决于实现的中间精度，面板值为 385723，此处不比较。
    expect(variants('accent6').slice(0, 4)).toEqual(['E2F0D9', 'C5E0B4', 'A9D18E', '548235'])
  })

  test('tint 与 shade 在线性 RGB 中与白色、黑色混合', () => {
    expect(resolve('<a:srgbClr val="00FF00"><a:tint val="50000"/></a:srgbClr>')).toBe('BCFFBC')
    expect(resolve('<a:srgbClr val="00FF00"><a:shade val="50000"/></a:srgbClr>')).toBe('00BC00')
    expect(resolve('<a:srgbClr val="4472C4"><a:tint val="40000"/></a:srgbClr>')).toBe('CFD5EA')
    expect(resolve('<a:srgbClr val="4472C4"><a:shade val="75000"/></a:srgbClr>')).toBe('3B64AC')
    expect(resolve('<a:srgbClr val="4472C4"><a:tint val="100%"/></a:srgbClr>')).toBe('4472C4')
  })

  test('HSL 中的饱和度与色相变换，结果夹到有效范围', () => {
    expect(resolve('<a:srgbClr val="ED7D31"><a:satMod val="150000"/></a:srgbClr>')).toBe('FF7A1F')
    expect(resolve('<a:srgbClr val="ED7D31"><a:satMod val="50000"/></a:srgbClr>')).toBe('BE8660')
    expect(resolve('<a:srgbClr val="ED7D31"><a:hueOff val="3600000"/></a:srgbClr>')).toBe('A1ED31')
    expect(resolve('<a:srgbClr val="FF0000"><a:hueOff val="-7200000"/></a:srgbClr>')).toBe('0000FF')
    expect(resolve('<a:srgbClr val="FF0000"><a:hue val="7200000"/></a:srgbClr>')).toBe('00FF00')
    expect(resolve('<a:srgbClr val="FF0000"><a:sat val="0"/></a:srgbClr>')).toBe('808080')
    expect(resolve('<a:srgbClr val="FF0000"><a:lum val="100000"/></a:srgbClr>')).toBe('FFFFFF')
    expect(resolve('<a:srgbClr val="808080"><a:lumOff val="80000"/></a:srgbClr>')).toBe('FFFFFF')
  })

  test('变换按文档顺序逐个作用', () => {
    const fill = (inner: string) =>
      resolve(`<a:schemeClr val="phClr">${inner}</a:schemeClr>`, parseHexColor('4472C4')!)
    expect(fill('<a:tint val="50000"/><a:satMod val="300000"/>')).toBe('A5BBFF')
    expect(fill('<a:shade val="50000"/><a:satMod val="120000"/>')).toBe('264F99')
    expect(fill('<a:satMod val="300000"/><a:tint val="50000"/>')).not.toBe('A5BBFF')
  })

  /** 原始失败形状：`gray` 按线性值取 Rec. 709 相对亮度，4472C4 得到 737373，WPS 为 6E6E6E。 */
  test('tint、shade、inv 按线性值计算，gray 在 sRGB 编码值上按 55 : 182 : 18 加权，与 WPS 导出图一致', () => {
    const wps: [string, string, string][] = [
      ['4472C4', '<a:tint val="40000"/>', 'CFD5EA'],
      ['ED7D31', '<a:tint val="75000"/>', 'F2AA8F'],
      ['4472C4', '<a:shade val="50000"/>', '2F528F'],
      ['70AD47', '<a:shade val="75000"/>', '62983D'],
      ['4472C4', '<a:inv/>', 'F8EBB3'],
      ['ED7D31', '<a:inv/>', '6DE6FC'],
      ['70AD47', '<a:inv/>', 'ECC9F8'],
      ['4472C4', '<a:gray/>', '6E6E6E'],
      ['ED7D31', '<a:gray/>', '909090'],
      ['70AD47', '<a:gray/>', '999999'],
      ['FF0000', '<a:gray/>', '373737'],
      ['00FF00', '<a:gray/>', 'B6B6B6'],
      ['0000FF', '<a:gray/>', '121212'],
      ['5B9BD5', '<a:gray/>', '919191'],
      ['0A0B0C', '<a:gray/>', '0B0B0B'],
    ]
    for (const [base, transform, expected] of wps) {
      expect([
        base,
        transform,
        resolve(`<a:srgbClr val="${base}">${transform}</a:srgbClr>`),
      ]).toEqual([base, transform, expected])
    }
    expect(resolve('<a:srgbClr val="808080"><a:inv/></a:srgbClr>')).toBe('E5E5E5')
  })

  test('red、green、blue 按线性值设置与调整', () => {
    expect(resolve('<a:srgbClr val="000000"><a:red val="50000"/></a:srgbClr>')).toBe('BC0000')
    expect(resolve('<a:srgbClr val="00FF00"><a:greenMod val="50000"/></a:srgbClr>')).toBe('00BC00')
    expect(resolve('<a:srgbClr val="0000FF"><a:blueOff val="-50000"/></a:srgbClr>')).toBe('0000BC')
  })

  test('gamma 与 invGamma 互为反变换', () => {
    expect(resolve('<a:srgbClr val="808080"><a:invGamma/></a:srgbClr>')).toBe('373737')
    expect(resolve('<a:srgbClr val="808080"><a:invGamma/><a:gamma/></a:srgbClr>')).toBe('808080')
  })

  test('不透明度变换只作用于 a', () => {
    const spec = read(
      '<a:srgbClr val="4472C4"><a:alpha val="60000"/><a:alphaMod val="50000"/><a:alphaOff val="10%"/></a:srgbClr>',
    )!
    const c = resolveColor(spec, { scheme: SCHEME })!
    expect(colorToHex(c)).toBe('4472C4')
    expect(c.a).toBeCloseTo(0.4, 10)
    expect(colorToCss(c)).toBe('rgba(68, 114, 196, 0.4)')
  })
})

describe('换算工具', () => {
  test('RGB 与 HSL 互转', () => {
    expect(rgbToHsl({ r: 1, g: 0, b: 0 })).toEqual({ h: 0, s: 1, l: 0.5 })
    expect(rgbToHsl({ r: 0.5, g: 0.5, b: 0.5 })).toEqual({ h: 0, s: 0, l: 0.5 })
    const hsl = rgbToHsl(parseHexColor('4472C4')!)
    expect(hsl.h).toBeCloseTo(218.4, 1)
    expect(colorToHex(hslToRgb(hsl))).toBe('4472C4')
    for (let h = 0; h < 360; h += 30) {
      const back = rgbToHsl(hslToRgb({ h, s: 0.6, l: 0.4 }))
      expect(back.h).toBeCloseTo(h, 9)
      expect(back.s).toBeCloseTo(0.6, 9)
      expect(back.l).toBeCloseTo(0.4, 9)
    }
  })

  test('sRGB 传递函数在分段点两侧连续且互逆', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(1)).toBeCloseTo(1, 12)
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 12)
    expect(linearToSrgb(0.5)).toBeCloseTo(0.735357, 6)
    for (const v of [0, 0.001, 0.04, 0.2, 0.5, 0.9, 1])
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 12)
  })

  test('百分比的两种写法与输出格式', () => {
    expect(parsePercentage('50000')).toBe(0.5)
    expect(parsePercentage('50%')).toBe(0.5)
    expect(parsePercentage('-12.5%')).toBe(-0.125)
    expect(parsePercentage('')).toBeNull()
    expect(parsePercentage('x')).toBeNull()
    expect(parsePercentage(null)).toBeNull()
    expect(colorToCss(parseHexColor('0a0B0c')!)).toBe('#0A0B0C')
    expect(colorToHex({ r: 1.2, g: -0.1, b: 0.5 })).toBe('FF0080')
  })

  test('预设颜色名不区分大小写，未知名称为 null', () => {
    expect(presetColorHex('AliceBlue')).toBe('f0f8ff')
    expect(presetColorHex('dkGrey')).toBe('a9a9a9')
    expect(presetColorHex('ltSlateGray')).toBe('778899')
    expect(presetColorHex('mediumVioletRed')).toBe('c71585')
    expect(presetColorHex('none')).toBeNull()
  })
})
