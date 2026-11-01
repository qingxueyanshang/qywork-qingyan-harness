/**
 * 演示文稿用到的字体名：调用方据此预先取得字体，绘制时经 `SlideFontSource` 提供（见 `../../drawingml/text/fonts.ts`）。
 */

import { collectChartFonts } from '../../drawingml/chart/resolve.ts'
import { collectTextFonts, MISSING_LATIN } from '../../drawingml/text/fonts.ts'
import type { Presentation, Shape } from '../model.ts'

function addShape(out: Set<string>, s: Shape): void {
  if (s.kind === 'shape' && s.text !== null) collectTextFonts(out, s.text)
  else if (s.kind === 'chart') collectChartFonts(out, s.chart)
  else if (s.kind === 'group') for (const c of s.children) addShape(out, c)
  else if (s.kind === 'table') {
    for (const row of s.rows) for (const cell of row.cells) collectTextFonts(out, cell.text)
  }
}

/** 演示文稿中出现的全部字体名，按首次出现的顺序，不含空串；末项为 `MISSING_LATIN`。 */
export function presentationFonts(p: Presentation): string[] {
  const out = new Set<string>()
  for (const slide of p.slides) for (const s of slide.shapes) addShape(out, s)
  out.delete(MISSING_LATIN)
  out.add(MISSING_LATIN)
  return [...out]
}
