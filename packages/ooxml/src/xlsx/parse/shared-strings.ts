/**
 * 共享字符串表（`sharedStrings.xml`）与单元格内联字符串（`<is>`）。
 *
 * - 一项的文本为其 `t` 与各 `r/t` 的拼接；`rPh`（注音）不计入显示文本。
 * - 富文本的 `rPr` 换算为完整字体，缺失的字体名与字号取「常规」样式的字体；没有 `rPr` 的段沿用单元格字体。
 *   只有一段且没有 `rPr` 时不保留分段。
 */

import { XmlScanner } from '../../xml/index.ts'
import type { FontStyle, RichRun } from '../model.ts'
import type { ColorContext } from './color.ts'
import { readFont, resolveFont } from './styles.ts'
import { decodeEscapes, readText, type Scanner, skipElement } from './xml-util.ts'

export interface SharedString {
  readonly text: string
  readonly runs: readonly RichRun[] | null
}

/** 读取 `si` 或 `is` 元素的内容；调用时位于其开始标签，返回时位于其结束标签。 */
export function readStringItem(
  x: Scanner,
  base: FontStyle,
  colors: ColorContext,
  fontNames: Set<string>,
): SharedString {
  const depth = x.depth
  let text = ''
  const runs: RichRun[] = []
  let rich = false
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    const local = x.local
    if (local === 'rPh' || local === 'phoneticPr') {
      skipElement(x)
    } else if (local === 't' && x.depth === depth + 1) {
      const s = decodeEscapes(readText(x))
      text += s
      runs.push({ text: s, font: null })
    } else if (local === 'r') {
      const run = readRun(x, base, colors)
      if (run.font) {
        rich = true
        fontNames.add(run.font.name)
      }
      text += run.text
      runs.push(run)
    }
  }
  return { text, runs: rich ? runs : null }
}

function readRun(x: Scanner, base: FontStyle, colors: ColorContext): RichRun {
  const depth = x.depth
  let font: FontStyle | null = null
  let text = ''
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'end' && x.depth === depth) break
    if (t !== 'start') continue
    if (x.local === 'rPr') font = resolveFont(readFont(x), base, colors)
    else if (x.local === 't') text += decodeEscapes(readText(x))
  }
  return { text, font }
}

export function parseSharedStrings(
  xml: string | null,
  base: FontStyle,
  colors: ColorContext,
  fontNames: Set<string>,
): SharedString[] {
  if (xml === null) return []
  const out: SharedString[] = []
  const x = new XmlScanner(xml)
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'start' && x.depth === 2 && x.local === 'si') {
      out.push(readStringItem(x, base, colors, fontNames))
    }
  }
  return out
}
