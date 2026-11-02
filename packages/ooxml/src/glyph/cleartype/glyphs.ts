/**
 * 一个字体的 ClearType 字形：提示后的轮廓（`GlyphHinting.clearTypeOutline`）经取样与滤波得到子像素覆盖，
 * 按字形编号、ppem、合成粗体与合成斜体缓存。
 */

import { readGlyphHinting, type SfntFace } from '../../font/index.ts'
import {
  type CoverageGlyph,
  emboldenSamples,
  filterSamples,
  SMOOTH_ROWS,
  sampleOutline,
} from './coverage.ts'

export interface ClearTypeGlyphs {
  /**
   * 字形 `glyphId` 在 `ppem` 下的覆盖。`bold` 为合成粗体（见 `emboldenSamples`），`oblique` 为合成斜体
   * （提示后倾斜，与单色字形相同）。没有轮廓的字形为 0×0。字形数据不合法时抛出 `FontFormatError`。
   */
  glyph(glyphId: number, ppem: number, bold: boolean, oblique: boolean): CoverageGlyph
}

/** 读取 ClearType 绘制所需的表；字体没有 TrueType 轮廓（CFF）时返回 `null`。 */
export function readClearTypeGlyphs(bytes: Uint8Array, face: SfntFace): ClearTypeGlyphs | null {
  const hinting = readGlyphHinting(bytes, face)
  if (hinting === null) return null
  const cache = new Map<number, CoverageGlyph>()
  return {
    glyph(glyphId, ppem, bold, oblique) {
      const key = ((ppem * 0x10000 + glyphId) * 2 + (bold ? 1 : 0)) * 2 + (oblique ? 1 : 0)
      let g = cache.get(key)
      if (g === undefined) {
        const rows = hinting.clearTypeRange(ppem).smoothY ? SMOOTH_ROWS : 1
        const samples = sampleOutline(hinting.clearTypeOutline(glyphId, ppem, oblique), rows)
        g = filterSamples(bold ? emboldenSamples(samples) : samples, rows)
        cache.set(key, g)
      }
      return g
    },
  }
}
