/**
 * 演示文稿的字体：用到的字体名（调用方据此预先取得字体），以及绘制时的字体来源 `SlideFonts`
 * （排版规则见 `../../drawingml/text/fonts.ts`）。
 *
 * - 字体来源除排版度量外另带内嵌点阵：WPS 演示的形状、表格与图表文字按 GDI 的点阵条件绘制（`slideGlyphs`）。
 */

import { collectChartFonts } from '../../drawingml/chart/resolve.ts'
import { collectDiagramFonts } from '../../drawingml/diagram/resolve.ts'
import {
  collectTextFonts,
  MISSING_LATIN,
  type ScreenGlyph,
  type ScreenText,
  type SlideFont,
  type SlideFontSource,
} from '../../drawingml/text/fonts.ts'
import {
  type EmbeddedBitmaps,
  emboldenBitmap,
  type PixelVerticalMetrics,
  readEmbeddedBitmaps,
  readFaces,
  readMetrics,
  readPixelVerticalMetrics,
  readVerticalMetrics,
} from '../../font/index.ts'
import { fillBitmap } from '../../glyph/bitmap.ts'
import type { MetafileFace, MetafileFonts } from '../../metafile/index.ts'
import type { Presentation, Shape } from '../model.ts'

function addShape(out: Set<string>, s: Shape): void {
  if (s.kind === 'shape' && s.text !== null) collectTextFonts(out, s.text)
  else if (s.kind === 'chart') collectChartFonts(out, s.chart)
  else if (s.kind === 'diagram') collectDiagramFonts(out, s.diagram)
  else if (s.kind === 'group') for (const c of s.children) addShape(out, c)
  else if (s.kind === 'table') {
    for (const row of s.rows) for (const cell of row.cells) collectTextFonts(out, cell.text)
  }
}

/** 演示文稿中出现的全部字体名（含图元文件文字的字体），按首次出现的顺序，不含空串；末项为 `MISSING_LATIN`。 */
export function presentationFonts(p: Presentation): string[] {
  const out = new Set<string>()
  for (const slide of p.slides) for (const s of slide.shapes) addShape(out, s)
  for (const name of p.metafileFonts) out.add(name)
  out.delete(MISSING_LATIN)
  out.add(MISSING_LATIN)
  return [...out]
}

/** 幻灯片字体：排版度量之外另带内嵌点阵与 ppem 下的纵向度量。 */
export interface SlideFace extends SlideFont {
  /** 内嵌点阵；字体没有点阵时为 `null`。 */
  readonly bitmaps: EmbeddedBitmaps | null
  /** ppem 下的 GDI 纵向度量：点阵超出基线以上 `ascent`、以下 `descent` 的行不绘制。 */
  readonly pixelVertical: (ppem: number) => PixelVerticalMetrics
}

export interface SlideFonts extends SlideFontSource {
  face(name: string, bold: boolean, italic: boolean): SlideFace | null
  readonly fallback: SlideFace
  /** 族名（`SlideFont.family`）为 `family` 的各字形；绘制时按族名取得点阵。 */
  family(family: string): readonly SlideFace[]
}

/** 读取字体字节（字体合集取第一个字体）；没有字体时为 `null`，字体表不完整时抛出 `FontFormatError`。 */
export function readSlideFace(
  bytes: Uint8Array,
  family: string,
  bold: boolean,
  italic: boolean,
): SlideFace | null {
  const sfnt = readFaces(bytes)[0]
  if (!sfnt) return null
  return {
    face: { metrics: readMetrics(bytes, sfnt), vertical: readVerticalMetrics(bytes, sfnt) },
    family,
    bold,
    italic,
    bitmaps: readEmbeddedBitmaps(bytes, sfnt),
    pixelVertical: readPixelVerticalMetrics(bytes, sfnt),
  }
}

/**
 * 幻灯片文字的单色字形：WPS 演示对形状、表格与图表文字按 GDI 的点阵条件（`EmbeddedBitmaps.screenMode`）不做平滑，
 * 实测宋体 9–13 磅（含粗体、斜体）与新宋体 10.5 磅不平滑、14 磅为平滑的轮廓，形状文字与图表文字相同。
 * 字形取自 `EmbeddedBitmaps.glyph`（点阵、提示后的轮廓、合成斜体的倾斜轮廓）；请求粗体而字体不是粗体时按 GDI 的方式加粗。
 */
export function slideGlyphs(fonts: SlideFonts): ScreenText {
  return { bitmap: (face, codePoint, ppem) => slideBitmap(fonts, face, codePoint, ppem) }
}

function slideBitmap(
  fonts: SlideFonts,
  face: { readonly family: string; readonly bold: boolean; readonly italic: boolean },
  codePoint: number,
  ppem: number,
): ScreenGlyph | null {
  const list = fonts.family(face.family)
  const f =
    list.find((x) => x.bold === face.bold && x.italic === face.italic) ??
    list.find((x) => x.italic === face.italic) ??
    list[0]
  if (!f?.bitmaps?.screenMode(ppem)) return null
  const raw = f.bitmaps.glyph(ppem, f.face.metrics.glyphId(codePoint), face.italic && !f.italic)
  if (raw === null) return null
  const { ascent, descent } = f.pixelVertical(ppem)
  return { glyph: face.bold && !f.bold ? emboldenBitmap(raw) : raw, ascent, descent }
}

function quote(family: string): string {
  return `"${family.replace(/["\\]/g, '')}"`
}

/**
 * 图元文件中文字的字体：按字体名与字形取得幻灯片字体，主机没有时取 `fallback`。字形按幻灯片文字的点阵条件绘制
 * （`slideGlyphs`），其余按族名交给浏览器；请求粗体或斜体而字体没有该字形时由点阵或浏览器合成。
 */
export function slideMetafileFonts(fonts: SlideFonts): MetafileFonts {
  const cache = new Map<string, MetafileFace>()
  return {
    face: (name, bold, italic) => {
      const key = `${name}|${bold}|${italic}`
      const known = cache.get(key)
      if (known !== undefined) return known
      const f = fonts.face(name, bold, italic) ?? fonts.fallback
      const v = f.face.vertical
      const paint = { family: f.family, bold, italic }
      const css = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}`
      const out: MetafileFace = {
        vertical: (ppem) => f.pixelVertical(ppem),
        emPerCell: v.unitsPerEm / (v.winAscent + v.winDescent || v.unitsPerEm),
        advance: (cp, ppem) => f.face.metrics.advance(cp, ppem),
        draw: (c, text, x, baseline, ppem) => {
          const g = slideBitmap(fonts, paint, text.codePointAt(0)!, ppem)
          if (g !== null) {
            fillBitmap(c, g.glyph, x, baseline, g.ascent, g.descent)
            return
          }
          c.font = `${css}${ppem}px ${quote(f.family)}`
          c.fillText(text, x, baseline)
        },
      }
      cache.set(key, out)
      return out
    },
  }
}
