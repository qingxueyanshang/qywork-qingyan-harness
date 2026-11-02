/**
 * ClearType 绘制（WPS 经 GDI 在平滑字号下的文字）：字形的子像素覆盖与按 GDI 的方式混合到画布像素。
 * xlsx 单元格文字、DrawingML 文字与 docx 共用。
 */

export {
  type ClearTypeDisplay,
  type DeviceRect,
  type GlyphRun,
  type PixelCanvas,
  type PixelData,
  type PlacedGlyph,
  paintGlyphRuns,
} from './blend.ts'
export type { CoverageGlyph } from './coverage.ts'
export { type ClearTypeGlyphs, readClearTypeGlyphs } from './glyphs.ts'
