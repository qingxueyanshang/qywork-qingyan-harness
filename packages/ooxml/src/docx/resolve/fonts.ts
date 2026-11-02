/**
 * 字体名的解决：主题字体换算为字体名，未指定或主题中为空时取缺省字体。
 *
 * - `*Ascii`、`*HAnsi` 取主题字体集的 `latin`；`*EastAsia` 取 `ea`，为空时按 `themeFontLang/@w:eastAsia` 的文种取
 *   按文种字体；`*Bidi` 取 `cs`，为空时按 `themeFontLang/@w:bidi` 的文种取。
 * - 未指定的字体取主题的次要字体（`minorHAnsi`、`minorEastAsia`、`minorBidi`）。WPS 实测：没有样式部件、样式部件为空、
 *   `docDefaults` 只给出西文字体的文档，有主题部件时东亚文字为主题 `Hans` 字体（等线，行高 14.2 磅）。
 * - 缺省字体：主题中也没有时 `ascii` 与 `hAnsi` 为 Calibri、`eastAsia` 为宋体、`cs` 为 Times New Roman。
 *   WPS 打开没有字体设置与主题的文档时各类字体即为这些值（实测）。
 * - 主机没有的字体按 `substitutes` 替代。
 */

import { MISSING_LATIN } from '../../drawingml/text/fonts.ts'
import type { FontCollection, FontScheme } from '../../drawingml/theme.ts'
import type { FontNames, FontTableEntry } from '../model.ts'
import type { FontRef, FontSlotName, ThemeFont } from '../parse/properties.ts'

export const DEFAULT_FONTS: FontNames = {
  ascii: 'Calibri',
  hAnsi: 'Calibri',
  eastAsia: '宋体',
  cs: 'Times New Roman',
}

export interface FontContext {
  readonly scheme: FontScheme | null
  readonly eastAsiaLanguage: string
  readonly bidiLanguage: string
}

/** 语言标记到主题字体方案中的文种代码。 */
function scriptOf(language: string): string | null {
  const lang = language.toLowerCase()
  if (lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo') return 'Hant'
  if (lang.startsWith('zh')) return 'Hans'
  if (lang.startsWith('ja')) return 'Jpan'
  if (lang.startsWith('ko')) return 'Hang'
  if (lang.startsWith('ar') || lang.startsWith('fa') || lang.startsWith('ur')) return 'Arab'
  if (lang.startsWith('he')) return 'Hebr'
  if (lang.startsWith('th')) return 'Thai'
  return null
}

function themeFont(theme: ThemeFont, ctx: FontContext): string {
  const scheme = ctx.scheme
  if (scheme === null) return ''
  const collection: FontCollection = theme.startsWith('major') ? scheme.major : scheme.minor
  if (theme.endsWith('EastAsia')) {
    if (collection.ea !== '') return collection.ea
    const script = scriptOf(ctx.eastAsiaLanguage)
    return script === null ? '' : (collection.scripts.get(script) ?? '')
  }
  if (theme.endsWith('Bidi')) {
    if (collection.cs !== '') return collection.cs
    const script = scriptOf(ctx.bidiLanguage)
    return script === null ? '' : (collection.scripts.get(script) ?? '')
  }
  return collection.latin
}

/** 未指定字体时所取的主题字体。 */
const UNSPECIFIED: Readonly<Record<FontSlotName, ThemeFont>> = {
  ascii: 'minorHAnsi',
  hAnsi: 'minorHAnsi',
  eastAsia: 'minorEastAsia',
  cs: 'minorBidi',
}

export function fontName(ref: FontRef | undefined, slot: FontSlotName, ctx: FontContext): string {
  const name =
    ref === undefined
      ? themeFont(UNSPECIFIED[slot], ctx)
      : 'theme' in ref
        ? themeFont(ref.theme, ctx)
        : ref.name
  return name === '' ? DEFAULT_FONTS[slot] : name
}

/**
 * 字体名在字段中的用途：西文与复杂文种字体（`other`），直接指定的东亚字体（`eastAsia`），取自主题的东亚字体
 * （`themeEastAsia`：`w:eastAsiaTheme` 或未指定时的主题次要字体）。
 */
export type FontUse = 'other' | 'eastAsia' | 'themeEastAsia'

/** 字体引用取自主题：`w:*Theme` 或未指定（取主题的次要字体）。 */
export function fromTheme(ref: FontRef | undefined): boolean {
  return ref === undefined || 'theme' in ref
}

/** 替代字体：`codePages` 为该字体 `OS/2.ulCodePageRange1` 须含的位，0 为不要求。 */
export interface FontCandidate {
  readonly name: string
  readonly codePages: number
}

/** `w:charset` 中日韩字符集对应的 `OS/2.ulCodePageRange1` 位。 */
const CHARSET_CODE_PAGES: ReadonlyMap<number, number> = new Map([
  [0x80, 1 << 17],
  [0x86, 1 << 18],
  [0x81, 1 << 19],
  [0x88, 1 << 20],
])

/** 字体表条目的字符集为 Shift-JIS 或 GB2312 而没有可用的 `w:altName` 时所取的字体。 */
const CHARSET_DEFAULTS: ReadonlyMap<number, string> = new Map([
  [0x80, 'Yu Gothic'],
  [0x86, '宋体'],
])

/**
 * 主机没有字体 `name` 时 WPS 文字依次尝试的字体，调用方取第一个主机有且满足 `codePages` 的；都没有时取缺字与缺少字体时使用的字体
 * （宋体）。WPS 实测（构造文档 f1–f5：50 余个缺失字体名在西文、东亚与复杂文种字体中的绘制字体与行高；正文与页眉页脚相同）：
 * 1. 字体表中该名称第一个条目的 `w:altName`。条目的 `w:charset` 为中日韩字符集时要求替代字体含该代码页：altName 为 Georgia、
 *    Times New Roman、Arial、Yu Gothic 而 charset 为 86 时不取，为 Times New Roman 而 charset 为 80 时不取。
 * 2. 条目的 charset 为 80 时为 Yu Gothic，为 86 时为宋体（含西文字体）。
 * 3. 东亚字体为宋体；其余字体为 Segoe Print（`MISSING_LATIN`），与 `w:family`、`w:pitch` 无关。
 * 取自主题的东亚字体不按 1、2 替代，直接为宋体（WPS 实测：主题的 Hans 或 Jpan 字体为本机没有的字体时，字体表中 altName 为楷体、
 * Yu Gothic 的条目不起作用；取自主题的西文字体照常按 altName 替代）。
 * 未实现（调用方只能按字体名查找主机字体）：名称以主机字体名开头或为其前缀时取该字体（`Calibri Fake` 取 Calibri，
 * `Noto Serif CJK SC` 取 Noto Serif CJK SC Medium）、Windows 字体替换表（`Helvetica` 取 Arial）、按 `w:panose1` 或 `w:sig`
 * 匹配主机字体，charset 为 81、88 时的替代（WPS 取 Malgun Gothic、MingLiU-ExtB），以及 WPS 自带度量的字体（方正仿宋_GB2312、
 * 华文行楷、思源黑体 CN Medium、Arial Unicode MS 等按其度量排版、以其他字体绘制）。
 */
export function substitutes(
  name: string,
  use: FontUse,
  table: ReadonlyMap<string, FontTableEntry>,
): FontCandidate[] {
  const out: FontCandidate[] = []
  if (use === 'themeEastAsia') return out
  const entry = table.get(name)
  const charset = entry?.charset ?? null
  const codePages = charset === null ? 0 : (CHARSET_CODE_PAGES.get(charset) ?? 0)
  if (entry !== undefined && entry.altName !== '' && entry.altName !== name)
    out.push({ name: entry.altName, codePages })
  const byCharset = charset === null ? undefined : CHARSET_DEFAULTS.get(charset)
  if (byCharset !== undefined) out.push({ name: byCharset, codePages: 0 })
  if (use === 'other') out.push({ name: MISSING_LATIN, codePages: 0 })
  return out
}
