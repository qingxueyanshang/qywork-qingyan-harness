/**
 * 覆盖 `theme.ts`（`parseTheme`）：颜色方案各槽位、`sysClr` 与带变换的槽位、字体方案的 `latin`、`ea`、`cs` 与按文种的字体，
 * 不同前缀、Strict 命名空间、`extraClrSchemeLst` 不混入、缺失的槽位与 XML 结构错误。
 */

import { describe, expect, test } from 'bun:test'
import { XmlSyntaxError } from '../xml/index.ts'
import { colorToHex, SCHEME_SLOTS } from './color.ts'
import { parseTheme } from './theme.ts'

function theme(prefix: string, ns: string, colors: string, extra = ''): string {
  const p = prefix ? `${prefix}:` : ''
  const decl = prefix ? `xmlns:${prefix}="${ns}"` : `xmlns="${ns}"`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${p}theme ${decl} name="Office 主题">
  <${p}themeElements>
    <${p}clrScheme name="Office">${colors}</${p}clrScheme>
    <${p}fontScheme name="Office">
      <${p}majorFont>
        <${p}latin typeface="Calibri Light" panose="020F0302020204030204"/>
        <${p}ea typeface=""/>
        <${p}cs typeface=""/>
        <${p}font script="Jpan" typeface="游ゴシック Light"/>
        <${p}font script="Hans" typeface="等线 Light"/>
        <${p}font script="Hans" typeface="重复"/>
      </${p}majorFont>
      <${p}minorFont>
        <${p}latin typeface="Calibri"/>
        <${p}ea typeface="宋体"/>
        <${p}font script="Hans" typeface="等线"/>
        <${p}font script="Arab" typeface="Arial"/>
      </${p}minorFont>
    </${p}fontScheme>
    <${p}fmtScheme name="Office"><${p}fillStyleLst><${p}solidFill><${p}schemeClr val="phClr"/></${p}solidFill></${p}fillStyleLst></${p}fmtScheme>
  </${p}themeElements>
  <${p}objectDefaults/>
  ${extra}
</${p}theme>`
}

const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

function slots(p: string): string {
  const q = p ? `${p}:` : ''
  return [
    `<${q}dk1><${q}sysClr val="windowText" lastClr="000000"/></${q}dk1>`,
    `<${q}lt1><${q}sysClr val="window" lastClr="FFFFFF"/></${q}lt1>`,
    `<${q}dk2><${q}srgbClr val="44546A"/></${q}dk2>`,
    `<${q}lt2><${q}srgbClr val="E7E6E6"/></${q}lt2>`,
    `<${q}accent1><${q}srgbClr val="4472C4"/></${q}accent1>`,
    `<${q}accent2><${q}srgbClr val="ED7D31"/></${q}accent2>`,
    `<${q}accent3><${q}srgbClr val="A5A5A5"/></${q}accent3>`,
    `<${q}accent4><${q}srgbClr val="FFC000"/></${q}accent4>`,
    `<${q}accent5><${q}srgbClr val="5B9BD5"/></${q}accent5>`,
    `<${q}accent6><${q}srgbClr val="70AD47"/></${q}accent6>`,
    `<${q}hlink><${q}srgbClr val="0563C1"/></${q}hlink>`,
    `<${q}folHlink><${q}srgbClr val="954F72"/></${q}folHlink>`,
  ].join('')
}

function hexes(t: ReturnType<typeof parseTheme>): Record<string, string | null> {
  return Object.fromEntries(
    SCHEME_SLOTS.map((s) => [s, t.colors[s] === null ? null : colorToHex(t.colors[s]!)]),
  )
}

const OFFICE = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '44546A',
  lt2: 'E7E6E6',
  accent1: '4472C4',
  accent2: 'ED7D31',
  accent3: 'A5A5A5',
  accent4: 'FFC000',
  accent5: '5B9BD5',
  accent6: '70AD47',
  hlink: '0563C1',
  folHlink: '954F72',
}

describe('parseTheme', () => {
  test('颜色方案与字体方案', () => {
    const t = parseTheme(theme('a', A, slots('a')))
    expect(t.name).toBe('Office 主题')
    expect(t.colorSchemeName).toBe('Office')
    expect(hexes(t)).toEqual(OFFICE)
    expect(t.fonts.name).toBe('Office')
    expect(t.fonts.major.latin).toBe('Calibri Light')
    expect(t.fonts.major.ea).toBe('')
    expect([...t.fonts.major.scripts]).toEqual([
      ['Jpan', '游ゴシック Light'],
      ['Hans', '等线 Light'],
    ])
    expect(t.fonts.minor).toEqual({
      latin: 'Calibri',
      ea: '宋体',
      cs: '',
      scripts: new Map([
        ['Hans', '等线'],
        ['Arab', 'Arial'],
      ]),
    })
  })

  test('不同前缀、默认命名空间与 Strict 命名空间结果相同', () => {
    const base = parseTheme(theme('a', A, slots('a')))
    expect(parseTheme(theme('d', A, slots('d')))).toEqual(base)
    expect(parseTheme(theme('', A, slots('')))).toEqual(base)
    expect(parseTheme(theme('a', 'http://purl.oclc.org/ooxml/drawingml/main', slots('a')))).toEqual(
      base,
    )
  })

  test('extraClrSchemeLst 中的颜色方案不混入', () => {
    const extra =
      '<a:extraClrSchemeLst><a:extraClrScheme><a:clrScheme name="其他">' +
      '<a:dk1><a:srgbClr val="FF0000"/></a:dk1></a:clrScheme></a:extraClrScheme></a:extraClrSchemeLst>'
    const t = parseTheme(theme('a', A, slots('a'), extra))
    expect(t.colorSchemeName).toBe('Office')
    expect(hexes(t).dk1).toBe('000000')
  })

  test('槽位中的变换生效；缺失、无法解析或引用主题色的槽位为 null', () => {
    const colors =
      '<a:dk1><a:srgbClr val="00FF00"><a:lumMod val="50000"/></a:srgbClr></a:dk1>' +
      '<a:lt1><a:sysClr val="window"/></a:lt1>' +
      '<a:dk2><a:schemeClr val="accent1"/></a:dk2>' +
      '<a:accent1><a:srgbClr val="4472C4"/><a:srgbClr val="FF0000"/></a:accent1>'
    const h = hexes(parseTheme(theme('a', A, colors)))
    expect(h.dk1).toBe('008000')
    expect(h.lt1).toBeNull()
    expect(h.dk2).toBeNull()
    expect(h.accent1).toBe('4472C4')
    expect(h.accent2).toBeNull()
  })

  test('AlternateContent 取 Fallback', () => {
    const colors =
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:z="urn:ext"><mc:Choice Requires="z"><a:dk1><a:srgbClr val="FF0000"/></a:dk1></mc:Choice>' +
      '<mc:Fallback><a:dk1><a:srgbClr val="0000FF"/></a:dk1></mc:Fallback></mc:AlternateContent>'
    expect(hexes(parseTheme(theme('a', A, colors))).dk1).toBe('0000FF')
  })

  test('XML 结构错误时抛出 XmlSyntaxError', () => {
    expect(() => parseTheme('<a:theme><a:themeElements></a:theme>')).toThrow(XmlSyntaxError)
  })
})
