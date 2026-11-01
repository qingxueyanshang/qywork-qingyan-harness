/**
 * 单元格文字排版：按字体链测宽、自动换行与行高。宽度一律由 `FontSet` 依据字体文件计算。
 *
 * - 自动换行：断点与行首行尾禁则取 `../../text` 的 `canBreakBetween` 与简体中文缺省禁则表，与 Word、PPT 共用一套规则。
 *   逐行贪心：空格不换到下一行，超出行宽的字符回退到本行最近的断点，没有断点时在超出处断开。
 *   显式换行符强制断行；自动换行产生的行不以空格开头，行末的空格不计宽度、不显示。
 * - 行高：单行为 `lineBox` 的 `height`（WPS 的单行行高），自动换行时每行按 `lineBoxOf` 取行高；单位为像素。
 */

import {
  type BreakRules,
  canBreakBetween,
  DEFAULT_NO_LINE_BREAK_AFTER,
  DEFAULT_NO_LINE_BREAK_BEFORE,
} from '../../text/index.ts'
import type { FontStyle } from '../model.ts'
import {
  type FaceChain,
  type FontSet,
  type LoadedFace,
  pixelSize,
  pointsToPixels,
} from './fonts.ts'

export interface TextRun {
  readonly text: string
  readonly font: FontStyle
  readonly chain: FaceChain
  /** 字号，像素。 */
  readonly px: number
}

export interface TextLine {
  readonly runs: readonly TextRun[]
  readonly width: number
  /** 以换行符结束的行为换行符所在的段，否则为 `null`；换行符计入行度量，见 `lineBoxOf`。 */
  readonly breakRun: TextRun | null
}

export function makeRun(text: string, font: FontStyle, fonts: FontSet): TextRun {
  const px = pointsToPixels(font.size) * (font.vertAlign === 'baseline' ? 1 : 2 / 3)
  return { text, font, chain: fonts.chain(font.name, font.bold, font.italic), px }
}

export function runWidth(run: TextRun): number {
  return run.chain.width(run.text, run.px)
}

export function runsWidth(runs: readonly TextRun[]): number {
  let w = 0
  for (const r of runs) w += runWidth(r)
  return w
}

/**
 * 一行文字的像素度量（WPS 屏幕显示，96 dpi）。`ascent`、`descent` 为 GDI 的 `tmAscent`、`tmDescent`；
 * `height` 为单行行高 `ppem + descent + 1 + 2·extra`，`extra = max(0, ascent − ppem, ⌊(externalLeading − 1)/2⌋)`，
 * 多行时每行占 `height`。下降不超过 1 像素且有外部行距时（宋体、黑体的 ppem 8–10，即 6–7.5 磅）`extra` 至少为 1：
 * WPS 实测比上式多 2 像素，机制未查明，判据只覆盖实测到的情形。
 */
export interface LineBox {
  readonly height: number
  readonly ascent: number
  readonly descent: number
  /**
   * 行顶到基线的距离 `ppem + 1 + extra`：`2·extra` 在文字上下各分一半（WPS 屏幕显示逐格实测，
   * 10 种字体、6–28 磅、三种垂直对齐一致）。不要改为 `height − descent`，`extra` 大于 0 时基线低 `extra` 像素。
   */
  readonly baseline: number
}

/** 字体在 `pt` 磅下的行度量；没有字体时按 ppem 的 0.8 与 0.2 估计上升、下降高度。 */
export function lineBox(face: LoadedFace | undefined, pt: number): LineBox {
  const ppem = pixelSize(pt)
  if (!face) {
    const ascent = Math.round(ppem * 0.8)
    const descent = ppem - ascent
    return { height: ppem + descent + 1, ascent, descent, baseline: ppem + 1 }
  }
  const v = face.vertical(ppem)
  const small = v.descent <= 1 && v.externalLeading >= 1 ? 1 : 0
  const extra = Math.max(0, small, v.ascent - ppem, Math.floor((v.externalLeading - 1) / 2))
  return {
    height: ppem + v.descent + 1 + 2 * extra,
    ascent: v.ascent,
    descent: v.descent,
    baseline: ppem + 1 + extra,
  }
}

/** 没有字符的行不占高度；以换行符结束的空行另计入换行符，见 `lineBoxOf`。 */
const EMPTY_LINE: LineBox = { height: 0, ascent: 0, descent: 0, baseline: 0 }

/**
 * 一行中有多个字体（富文本、缺字回退）时取行高最大的一个的整组度量，行高相同时取先出现的
 * （经验规则，WPS 实测：西文字体单元格中「国H」按宋体定位、「H国」按西文字体定位）。不要改为逐项取大：
 * 两个字体的 `baseline` 不同时，逐项取大使基线低 1–2 像素。
 */
function tallest(boxes: readonly LineBox[]): LineBox {
  let best = EMPTY_LINE
  for (const b of boxes) if (b.height > best.height) best = b
  return best
}

/** 各段主字体的行度量，多段时见 `tallest`。 */
export function lineMetrics(runs: readonly TextRun[]): LineBox {
  return tallest(runs.map((r) => lineBox(r.chain.faces[0], r.font.size)))
}

/**
 * 一行文字按实际使用的字体（含缺字回退）取行度量（如西文字体单元格中只有汉字时按回退字体），多个字体时见 `tallest`：
 * 不换行单元格文字的纵向定位按它计算，自动换行的行见 `lineBoxOf`。不换行单元格的行高按各段主字体（`lineMetrics`），
 * 与文字内容无关。`runs` 中没有字符时按主字体。
 */
export function wrappedLineMetrics(runs: readonly TextRun[]): LineBox {
  const boxes: LineBox[] = []
  for (const r of runs) {
    for (const seg of r.chain.segments(r.text, r.px))
      boxes.push(lineBox(seg.face ?? undefined, r.font.size))
  }
  return boxes.length > 0 ? tallest(boxes) : lineMetrics(runs)
}

/**
 * 自动换行的一行的度量：`wrappedLineMetrics`，以换行符结束时换行符按所在段的主字体计入
 * （经验规则，WPS 实测：Arial 11 的「国⏎国」行高 19 + 18，自动断行产生的行不计入）。两个换行符之间的空行因此取主字体的行高。
 */
export function lineBoxOf(line: TextLine): LineBox {
  const box = wrappedLineMetrics(line.runs)
  if (!line.breakRun) return box
  return tallest([box, lineBox(line.breakRun.chain.faces[0], line.breakRun.font.size)])
}

/** 单元格没有段落属性，按禁则开启、西文单词保持完整处理。 */
const CELL_BREAK_RULES: BreakRules = {
  kinsoku: true,
  wordWrap: true,
  noLineBreakBefore: DEFAULT_NO_LINE_BREAK_BEFORE,
  noLineBreakAfter: DEFAULT_NO_LINE_BREAK_AFTER,
}

/** 放置判定的容差：宽度由浮点累加得到，恰好排满一行时不因舍入误差移到下一行。 */
const EPSILON = 1e-6
const NEWLINE = 0x0a
const SPACE = 0x20

interface Unit {
  /** 所属段的下标。 */
  readonly run: number
  readonly ch: string
  readonly cp: number
  readonly width: number
}

/**
 * 按 `maxWidth` 断行。`runs` 为同一单元格的各段（富文本），换行后每行保留各段的字体。
 */
export function wrapRuns(runs: readonly TextRun[], maxWidth: number): TextLine[] {
  const units: Unit[] = []
  runs.forEach((run, index) => {
    for (const ch of run.text) {
      units.push({ run: index, ch, cp: ch.codePointAt(0)!, width: run.chain.width(ch, run.px) })
    }
  })
  const lines: TextLine[] = []
  const n = units.length
  let i = 0
  // 空格总是留在本行（不会被换到下一行），因此自动换行产生的行不以空格开头；显式换行之后的行保留行首空格。
  do {
    const s = i
    let x = 0
    let breakAt = -1
    let end = n
    let forced = false
    while (i < n) {
      const u = units[i]!
      if (u.cp === NEWLINE) {
        end = i
        forced = true
        break
      }
      if (i > s && canBreakBetween(units[i - 1]!.cp, u.cp, CELL_BREAK_RULES)) breakAt = i
      if (i === s || u.cp === SPACE || x + u.width <= maxWidth + EPSILON) {
        x += u.width
        i++
        continue
      }
      end = breakAt > s ? breakAt : i
      break
    }
    lines.push(lineOf(runs, units, s, end, forced ? runs[units[end]!.run]! : null))
    i = forced ? end + 1 : end
  } while (i < n)
  return lines
}

/** `units[s, e)` 组成的一行：去掉行末空格，相邻且属于同一段的字符合并为一段。 */
function lineOf(
  runs: readonly TextRun[],
  units: readonly Unit[],
  s: number,
  e: number,
  breakRun: TextRun | null,
): TextLine {
  let last = e
  while (last > s && units[last - 1]!.cp === SPACE) last--
  const out: TextRun[] = []
  let width = 0
  for (let k = s; k < last; k++) {
    const u = units[k]!
    const prev = out.at(-1)
    if (prev && units[k - 1]!.run === u.run)
      out[out.length - 1] = { ...prev, text: prev.text + u.ch }
    else out.push({ ...runs[u.run]!, text: u.ch })
    width += u.width
  }
  return { runs: out, width, breakRun }
}
