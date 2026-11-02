/**
 * 单色字形的绘制（WPS 经 GDI 在 ClearType 下的点阵模式，见 `EmbeddedBitmaps.screenMode`）：内嵌点阵与提示后光栅化的轮廓，
 * xlsx、DrawingML 文字与 docx 共用。
 */

import type { BitmapGlyph } from '../font/index.ts'

/** 绘制点阵所需的 Canvas 2D 接口子集。 */
export interface BitmapCanvas {
  fillRect(x: number, y: number, w: number, h: number): void
}

/**
 * 按行把着墨像素合并为横向线段，以当前 `fillStyle` 填充；基线以上 `ascent`、以下 `descent` 之外的行不绘制（与 GDI 相同）。
 * `x`、`baseline` 为整数像素坐标。
 */
export function fillBitmap(
  ctx: BitmapCanvas,
  g: BitmapGlyph,
  x: number,
  baseline: number,
  ascent: number,
  descent: number,
): void {
  const left = x + g.bearingX
  const top = baseline - g.bearingY
  for (let r = 0; r < g.height; r++) {
    const y = top + r
    if (y < baseline - ascent || y >= baseline + descent) continue
    const row = r * g.width
    let c = 0
    while (c < g.width) {
      if (!g.pixels[row + c]) {
        c++
        continue
      }
      const start = c
      while (c < g.width && g.pixels[row + c]) c++
      ctx.fillRect(left + start, y, c - start, 1)
    }
  }
}
