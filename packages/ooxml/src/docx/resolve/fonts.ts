/**
 * 字体名的解决：主题字体换算为字体名，未指定或主题中为空时取缺省字体。
 *
 * - `*Ascii`、`*HAnsi` 取主题字体集的 `latin`；`*EastAsia` 取 `ea`，为空时按 `themeFontLang/@w:eastAsia` 的文种取
 *   按文种字体；`*Bidi` 取 `cs`，为空时按 `themeFontLang/@w:bidi` 的文种取。
 * - 未指定的字体取主题的次要字体（`minorHAnsi`、`minorEastAsia`、`minorBidi`）。WPS 实测：没有样式部件、样式部件为空、
 *   `docDefaults` 只给出西文字体的文档，有主题部件时东亚文字为主题 `Hans` 字体（等线，行高 14.2 磅）。
 * - 缺省字体：主题中也没有时 `ascii` 与 `hAnsi` 为 Calibri、`eastAsia` 为宋体、`cs` 为 Times New Roman。
 *   WPS 打开没有字体设置与主题的文档时各类字体即为这些值（实测）。
 */

import type { FontCollection, FontScheme } from '../../drawingml/theme.ts'
import type { FontNames } from '../model.ts'
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
