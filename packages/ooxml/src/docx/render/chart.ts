/**
 * 图表与 SmartArt 文字的单色字形（`ScreenText`），作为字体缓存的 `glyphs` 传入 `FaceCache`（见 `graphic.ts`）：
 * 行高与基线仍按演示文稿的规则，只改变字形的绘制方式。点阵条件与正文相同（`EmbeddedBitmaps.screenMode`）：
 * WPS 文字实测宋体 9–13 磅的图表文字不平滑、14 磅为平滑的轮廓，新宋体 10.5 磅同样不平滑。
 * 字形取自 `EmbeddedBitmaps.glyph`（点阵、提示后的轮廓、合成斜体的倾斜轮廓）。
 */

import type { ScreenText } from '../../drawingml/text/fonts.ts'
import { emboldenBitmap } from '../../font/index.ts'
import type { GraphicFonts } from '../page/model.ts'
import type { DocxFace } from './fonts.ts'
import type { PageFonts } from './paint.ts'

function family(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * `table` 登记的字体（含回退字体）按族名取得点阵；字形请求粗体而字体不是粗体时点阵按 GDI 的方式加粗。
 * 族名与 `FaceCache` 绘制字形的 `PaintFace.family` 相同（取自登记的 `FaceRef.family`）。
 */
export function chartGlyphs(table: GraphicFonts, fonts: PageFonts): ScreenText {
  const byFamily = new Map<string, DocxFace[]>()
  for (const index of [table.fallback, ...table.named.map((n) => n.face)]) {
    const ref = fonts.faces[index]
    const face = ref === undefined ? null : fonts.draw(ref)
    if (ref === undefined || face === null) continue
    const list = byFamily.get(family(ref.family)) ?? []
    if (!list.includes(face)) list.push(face)
    byFamily.set(family(ref.family), list)
  }
  return {
    bitmap(face, codePoint, ppem) {
      const list = byFamily.get(family(face.family)) ?? []
      const f =
        list.find((x) => x.bold === face.bold && x.italic === face.italic) ??
        list.find((x) => x.italic === face.italic) ??
        list[0]
      if (!f?.bitmaps?.screenMode(ppem)) return null
      const raw = f.bitmaps.glyph(ppem, f.text.metrics.glyphId(codePoint), face.italic && !f.italic)
      if (raw === null) return null
      const { ascent, descent } = f.pixelVertical(ppem)
      return { glyph: face.bold && !f.bold ? emboldenBitmap(raw) : raw, ascent, descent }
    },
  }
}
