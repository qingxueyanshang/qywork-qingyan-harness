/**
 * 图表与 SmartArt 的绘制设置：按页面的 `GraphicFonts` 构造两者文字的字体缓存，并列出图表读取的图片。
 *
 * - 图表与 SmartArt 的文字以 `../../drawingml/text/` 排版与绘制，字体按字体名取得：`GraphicFonts.named` 中登记的字体由
 *   `PageFonts.draw` 取得度量，族名取登记的 `FaceRef.family`，与正文文字注册的 `FontFace` 相同。
 * - 主机没有的字体取 `GraphicFonts.fallback`，西文字符另按 `MISSING_LATIN`（见 `FaceCache`）。
 * - 行高与基线按演示文稿的规则，字形的点阵与 ClearType 字形见 `chart.ts`。
 */

import type { Chart } from '../../drawingml/chart/model.ts'
import { collectChartImages } from '../../drawingml/chart/resolve.ts'
import type { TextSettings } from '../../drawingml/text/body.ts'
import { FaceCache, SINGLE_LINE, type SlideFont } from '../../drawingml/text/fonts.ts'
import type { GraphicFonts } from '../page/model.ts'
import { chartClearType, chartGlyphs } from './chart.ts'
import type { PageClearType, PageFonts } from './paint.ts'

/** `GraphicFonts.named` 的查找键：字体名不区分大小写与首尾空白。 */
export function namedFontKey(name: string, bold: boolean, italic: boolean): string {
  return `${name.trim().toLowerCase()}\u0000${bold ? 1 : 0}${italic ? 1 : 0}`
}

/**
 * 图表与 SmartArt 文字的排版设置；回退字体在主机上不可用时为 `null`（图表不绘制，SmartArt 不绘制文字）。
 * `clearType` 为 `null` 时平滑字号以 `fillText` 绘制。
 */
export function graphicSettings(
  table: GraphicFonts,
  fonts: PageFonts,
  clearType: PageClearType | null,
): TextSettings | null {
  const slide = (index: number): SlideFont | null => {
    const ref = fonts.faces[index]
    const face = ref === undefined ? null : fonts.draw(ref)
    if (ref === undefined || face === null) return null
    return { face: face.text, family: ref.family, bold: ref.bold, italic: ref.italic }
  }
  const fallback = slide(table.fallback)
  if (fallback === null) return null
  const named = new Map<string, SlideFont>()
  for (const n of table.named) {
    const f = slide(n.face)
    if (f !== null) named.set(namedFontKey(n.name, n.bold, n.italic), f)
  }
  const source = {
    face: (name: string, bold: boolean, italic: boolean) =>
      named.get(namedFontKey(name, bold, italic)) ?? null,
    fallback,
  }
  return {
    faces: new FaceCache(
      source,
      SINGLE_LINE,
      null,
      chartGlyphs(table, fonts),
      clearType === null ? null : chartClearType(table, fonts, clearType),
    ),
    slideNumber: null,
  }
}

/** 图表中图片填充读取的图片（`parts` 的下标）加入 `out`。 */
export function chartImages(chart: Chart, parts: readonly string[], out: Set<number>): void {
  const names = new Set<string>()
  collectChartImages(names, chart)
  for (const name of names) {
    const i = parts.indexOf(name)
    if (i >= 0) out.add(i)
  }
}
