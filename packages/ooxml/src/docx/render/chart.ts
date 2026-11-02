/**
 * 图表与 SmartArt 文字的屏幕字形，交给 `FaceCache`（见 `graphic.ts`）：行高与基线仍按演示文稿的规则，只改变字形的绘制方式。
 * - 单色字形（`chartGlyphs`，`FaceCache` 的 `glyphs`）：点阵条件与正文相同（`EmbeddedBitmaps.screenMode`）：
 *   WPS 文字实测宋体 9–13 磅的图表文字不平滑、14 磅为平滑的轮廓，新宋体 10.5 磅同样不平滑。
 *   字形取自 `EmbeddedBitmaps.glyph`（点阵、提示后的轮廓、合成斜体的倾斜轮廓）。
 * - 其余字号在主机使用 ClearType 时按 ClearType 字形绘制（`chartClearType`，`FaceCache` 的 `clearType`），与正文相同。
 */

import type { ClearTypeGlyph, ScreenText, TextClearType } from '../../drawingml/text/fonts.ts'
import { emboldenBitmap } from '../../font/index.ts'
import { paintGlyphRuns } from '../../glyph/cleartype/index.ts'
import type { GraphicFonts } from '../page/model.ts'
import type { DocxFace } from './fonts.ts'
import type { PageClearType, PageFonts } from './paint.ts'

function family(name: string): string {
  return name.trim().toLowerCase()
}

/** 绘制字形的族名与字形（`PaintFace` 的这三项）。 */
interface FaceStyle {
  readonly family: string
  readonly bold: boolean
  readonly italic: boolean
}

/**
 * `table` 登记的字体（含回退字体）按族名与字形取得：先取字形相同的，再取斜体相同的，最后取第一个。
 * 族名与 `FaceCache` 绘制字形的 `PaintFace.family` 相同（取自登记的 `FaceRef.family`）。
 */
function familyFaces(
  table: GraphicFonts,
  fonts: PageFonts,
): (face: FaceStyle) => DocxFace | undefined {
  const byFamily = new Map<string, DocxFace[]>()
  for (const index of [table.fallback, ...table.named.map((n) => n.face)]) {
    const ref = fonts.faces[index]
    const face = ref === undefined ? null : fonts.draw(ref)
    if (ref === undefined || face === null) continue
    const list = byFamily.get(family(ref.family)) ?? []
    if (!list.includes(face)) list.push(face)
    byFamily.set(family(ref.family), list)
  }
  return (face) => {
    const list = byFamily.get(family(face.family)) ?? []
    return (
      list.find((x) => x.bold === face.bold && x.italic === face.italic) ??
      list.find((x) => x.italic === face.italic) ??
      list[0]
    )
  }
}

/** 单色字形；字形请求粗体而字体不是粗体时点阵按 GDI 的方式加粗。 */
export function chartGlyphs(table: GraphicFonts, fonts: PageFonts): ScreenText {
  const pick = familyFaces(table, fonts)
  return {
    bitmap(face, codePoint, ppem) {
      const f = pick(face)
      if (!f?.bitmaps?.screenMode(ppem)) return null
      const raw = f.bitmaps.glyph(ppem, f.text.metrics.glyphId(codePoint), face.italic && !f.italic)
      if (raw === null) return null
      const { ascent, descent } = f.pixelVertical(ppem)
      return { glyph: face.bold && !f.bold ? emboldenBitmap(raw) : raw, ascent, descent }
    },
  }
}

/**
 * ClearType 字形：每段文字立即混合到 `clearType.target`，不暂存。图表与 SmartArt 的绘制在文字之间穿插非文字绘制，
 * 不调用 `TextClearType.flush`。字体没有 TrueType 轮廓或没有该字时为 `null`（以 `fillText` 绘制）；
 * 请求粗体或斜体而字体没有该字形时按 GDI 的方式合成。
 */
export function chartClearType(
  table: GraphicFonts,
  fonts: PageFonts,
  clearType: PageClearType,
): TextClearType {
  const pick = familyFaces(table, fonts)
  return {
    target: clearType.target,
    paint: (runs) => paintGlyphRuns(clearType.target, runs, clearType.display),
    flush: () => {},
    glyph(face, codePoint, ppem): ClearTypeGlyph | null {
      const f = pick(face)
      const glyphs = f?.clearType
      if (!f || !glyphs) return null
      const id = f.text.metrics.glyphId(codePoint)
      if (id === 0) return null
      const { ascent, descent } = f.pixelVertical(ppem)
      const glyph = glyphs.glyph(id, ppem, face.bold && !f.bold, face.italic && !f.italic)
      return { glyph, ascent, descent }
    },
  }
}
