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
import { prefixFont, windowsFontSubstitute } from '../../text/index.ts'
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

/**
 * 字体表条目的字符集为中日韩字符集而没有可用的 `w:altName` 时所取的字体：GB2312 在前缀匹配之前，其余在其后（见 `substitutes`
 * 第 5、7 步）。
 */
const CHARSET_DEFAULTS: ReadonlyMap<number, string> = new Map([
  [0x80, 'Yu Gothic'],
  [0x81, 'Malgun Gothic'],
  [0x86, '宋体'],
  [0x88, 'MingLiU-ExtB'],
])

/** `w:charset` 的 GB2312 字符集。 */
const GB2312 = 0x86

/**
 * WPS 文字自带的替换（见 `substitutes` 第 3 步），按小写的字体名：西文与东亚字体相同，不区分大小写（WPS 实测，构造文档
 * f1-fonts、f2-subst-a：`hei`、`HEI` 与 Hei 相同，`TIMES-ROMAN` 与 Times-Roman 相同；`Hei X` 为 Segoe Print、
 * `方正行楷简体 X` 为宋体，只按整个名称）。行高与替换目标相同。
 */
const WPS_SUBSTITUTES: ReadonlyMap<string, string> = new Map([
  ['hei', '微软雅黑'],
  ['方正行楷简体', '微软雅黑'],
  ['times-roman', 'Times New Roman'],
  ['lucida grande', 'Courier New'],
])

/**
 * 名称中含这些字的字体名取对应的字体（见 `substitutes` 第 4 步），按先后取第一个：「仿宋」须在「宋」之前。
 * 含「黑」与「宋」或「楷」的名称未实测。
 */
const NAME_KEYWORDS: readonly (readonly [string, string])[] = [
  ['黑', '黑体'],
  ['仿宋', '仿宋'],
  ['楷', '宋体'],
  ['宋', '宋体'],
]

/**
 * 主机没有字体 `name` 时 WPS 文字依次尝试的字体，调用方取第一个主机有且满足 `codePages` 的；都没有时取缺字与缺少字体时使用的字体
 * （宋体）。同一文档中按用途与不区分大小写的名称沿用第一次的结果（调用方实现，见 `../layout.ts` 的 `ParagraphLayouter`）。
 * WPS 实测（构造文档 w12 f1–f5、w13 p1–p3、q01–q31、w14 r1e、r1a、r2e、r2a、w15 p1、p2：缺失字体名在西文、东亚与复杂文种字体中的
 * 绘制字体与行高；正文与页眉页脚相同）：
 * 1. 字体表中该名称第一个条目的 `w:altName`。条目的 `w:charset` 为中日韩字符集时要求替代字体含该代码页：altName 为 Georgia、
 *    Times New Roman、Arial、Yu Gothic 而 charset 为 86 时不取，为 Times New Roman 而 charset 为 80 时不取，为 Georgia、宋体而
 *    charset 为 81 时不取，为 Times New Roman、宋体而 charset 为 88 时不取。
 * 2. Windows 字体替换表（`windowsFontSubstitute`，区分大小写），与 charset 无关（`MS Shell Dlg 2` 在 charset 为 86 时仍取 Tahoma）。
 * 3. WPS 自带的替换（`WPS_SUBSTITUTES`）：Hei 与方正行楷简体为微软雅黑，Times-Roman 为 Times New Roman，Lucida Grande 为
 *    Courier New。在第 1 步之后（altName 为 Georgia 时四者都为 Georgia）、第 4、5 步之前（方正行楷简体不按「楷」取宋体，charset
 *    为 86 时四者不变，Lucida Grande 不按前缀取 Lucida 开头的字体）；与第 2 步没有同名的项，两者的先后无法区分（构造文档 f2-subst-a、
 *    b、c）。
 * 4. 名称含「黑」时为黑体，含「仿宋」时为仿宋，含「楷」或其余的「宋」时为宋体（`NAME_KEYWORDS`），西文与东亚字体相同：
 *    altName 为楷体时仍取楷体，altName 因代码页不取时取本步；charset 为 80、81、86、88 时都取本步（`方正黑体_C` 的 charset
 *    为 80 时为黑体，`微软雅黑 Fake` 的 charset 为 86 时为黑体）；先于前缀匹配（`微软雅黑 Fake` 为黑体，`楷体 Fake`、`新宋体 Fake`
 *    的西文为宋体，`楷X`、`宋X` 的西文同样为宋体）。
 * 5. 条目的 charset 为 86 时为宋体（`Calibri FakeX`、`Lucida` 的 charset 为 86 时西文为宋体）。
 * 6. 按主机字体族名的前缀匹配（`prefixFont`，`hostLocal` 为主机字体按界面语言取的族名）。
 * 7. 条目的 charset 为 80 时为 Yu Gothic，81 时为 Malgun Gothic，88 时为 MingLiU-ExtB（含西文字体；`Noto Serif` 的 charset 为
 *    80 时为 Noto Serif CJK SC Medium）。
 * 8. 东亚字体为宋体；其余字体为 Segoe Print（`MISSING_LATIN`），与 `w:family`、`w:pitch` 无关。
 * 取自主题的东亚字体不按以上各步替代，直接为宋体（WPS 实测：主题的 Hans 或 Jpan 字体为本机没有的字体时，字体表中 altName 为楷体、
 * Yu Gothic 的条目不起作用；取自主题的西文字体照常替代）。
 * WPS 按自带度量排版的字体（`../../text/wps-fonts.ts` 的 `WPS_METRIC_FONTS`）先于以上各步，不经本函数（`DocxFontSource.metric`）；
 * 文档的嵌入字体与主机字体同样经 `FontSource.face` 取得，先于自带度量（见 `../render/fonts.ts` 的 `embeddedFaces`）。
 * 未实现：按 `w:panose1` 或 `w:sig` 匹配主机字体；没有西文字形的字体（Segoe MDL2 Assets、HoloLens MDL2 Assets）WPS 以 Arial
 * 排版与绘制西文，本方按缺字形改用 `FontSource.fallback`。
 */
export function substitutes(
  name: string,
  use: FontUse,
  table: ReadonlyMap<string, FontTableEntry>,
  hostLocal: readonly string[],
): FontCandidate[] {
  const out: FontCandidate[] = []
  if (use === 'themeEastAsia') return out
  const entry = table.get(name)
  const charset = entry?.charset ?? null
  const codePages = charset === null ? 0 : (CHARSET_CODE_PAGES.get(charset) ?? 0)
  if (entry !== undefined && entry.altName !== '' && entry.altName !== name)
    out.push({ name: entry.altName, codePages })
  const windows = windowsFontSubstitute(name, false)
  if (windows !== null) out.push({ name: windows, codePages: 0 })
  const wps = WPS_SUBSTITUTES.get(name.toLowerCase())
  if (wps !== undefined) out.push({ name: wps, codePages: 0 })
  const keyword = NAME_KEYWORDS.find(([part]) => name.includes(part))
  if (keyword !== undefined) out.push({ name: keyword[1], codePages: 0 })
  const byCharset = charset === null ? undefined : CHARSET_DEFAULTS.get(charset)
  if (byCharset !== undefined && charset === GB2312) out.push({ name: byCharset, codePages: 0 })
  const prefix = prefixFont(name, hostLocal)
  if (prefix !== null) out.push({ name: prefix, codePages: 0 })
  if (byCharset !== undefined && charset !== GB2312) out.push({ name: byCharset, codePages: 0 })
  if (use === 'other') out.push({ name: MISSING_LATIN, codePages: 0 })
  return out
}
