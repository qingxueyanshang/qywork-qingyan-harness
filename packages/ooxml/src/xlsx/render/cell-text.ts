/**
 * 单元格的显示文本与文字布局：数字格式、「常规」对齐、溢出到相邻空单元格、宽度不足的数字显示 `#`、
 * 自动换行、缩小字体填充、分散对齐、填充对齐、文字旋转。纯函数，不依赖 Canvas，结果以像素坐标给出。
 *
 * - 「常规」对齐：数字与日期靠右，文本靠左，逻辑值与错误值居中；垂直对齐默认靠下。
 * - 溢出：不换行、不旋转、不缩小的文本可以越过相邻的空单元格显示；靠左向右溢出，靠右向左溢出，
 *   居中向两侧对称溢出。数字、日期、逻辑值与错误值不溢出。
 * - 数字宽度不足：「常规」格式先减少小数位或改用科学计数（`generalFit`），其余格式以 `#` 填满单元格。
 *   容纳判定比留白之间的宽度宽松（见 `GENERAL_SLACK` 与 `FORMAT_SLACK`）。
 * - 留白：文字到左、右网格线的距离见 `textPadding`（随单元格字体变化）；垂直位置见 `firstLineTop`。
 */

import { type FormatPart, formatNumber, formatText } from '../../numfmt/format.ts'
import { generalFit } from '../../numfmt/general.ts'
import type { CellAlignment, CellValue, FontStyle, HorizontalAlign, Workbook } from '../model.ts'
import type { FontSet } from './fonts.ts'
import { type TextPadding, textPadding } from './geometry.ts'
import {
  lineBoxOf,
  lineMetrics,
  makeRun,
  runWidth,
  type TextRun,
  wrappedLineMetrics,
  wrapRuns,
} from './text.ts'

export type ValueKind = 'number' | 'text' | 'boolean' | 'error'

export interface CellContent {
  readonly kind: ValueKind
  readonly parts: readonly FormatPart[]
  /** 富文本各段；有分段时忽略数字格式的文本节。 */
  readonly runs: readonly { readonly text: string; readonly font: FontStyle | null }[] | null
  /** 数字格式节指定的颜色。 */
  readonly color: string | null
  /** 值无法按格式显示，以 `#` 填满单元格。 */
  readonly invalid: boolean
  /** 「常规」格式的数字：显示文本随可用宽度调整。 */
  readonly general: number | null
}

export function cellContent(value: CellValue, numFmt: string, wb: Workbook): CellContent {
  const opts = { date1904: wb.date1904, palette: wb.palette }
  switch (value.type) {
    case 'number': {
      if (/^\s*general\s*$/i.test(numFmt) || numFmt.trim() === '') {
        return {
          kind: 'number',
          parts: [],
          runs: null,
          color: null,
          invalid: false,
          general: value.value,
        }
      }
      const f = formatNumber(value.value, numFmt, opts)
      return {
        kind: 'number',
        parts: f.parts,
        runs: null,
        color: f.color,
        invalid: f.invalid,
        general: null,
      }
    }
    case 'string': {
      if (value.runs) {
        return {
          kind: 'text',
          parts: [],
          runs: value.runs,
          color: null,
          invalid: false,
          general: null,
        }
      }
      const f = formatText(value.value, numFmt, opts)
      return {
        kind: 'text',
        parts: f.parts,
        runs: null,
        color: f.color,
        invalid: false,
        general: null,
      }
    }
    case 'formula':
      return plain('text', value.value)
    case 'boolean':
      return plain('boolean', value.value ? 'TRUE' : 'FALSE')
    case 'error':
      return plain('error', value.value)
  }
}

function plain(kind: ValueKind, text: string): CellContent {
  return {
    kind,
    parts: [{ kind: 'text', text }],
    runs: null,
    color: null,
    invalid: false,
    general: null,
  }
}

/** 「常规」水平对齐按值的类型确定。 */
export function resolveHorizontal(align: HorizontalAlign, kind: ValueKind): HorizontalAlign {
  if (align !== 'general') return align
  if (kind === 'number') return 'right'
  if (kind === 'text') return 'left'
  return 'center'
}

export interface TextFragment {
  readonly text: string
  /** 起点 x 与基线 y，像素。 */
  readonly x: number
  readonly y: number
  readonly run: TextRun
  readonly width: number
  readonly color: string
}

export interface CellTextLayout {
  readonly fragments: readonly TextFragment[]
  /** 文字的裁剪矩形。 */
  readonly clip: {
    readonly left: number
    readonly top: number
    readonly right: number
    readonly bottom: number
  }
  /** 绕 (cx, cy) 旋转，角度为逆时针度数；不旋转时为 `null`。 */
  readonly rotate: { readonly angle: number; readonly cx: number; readonly cy: number } | null
  /** 文字占用的列范围（含本列），溢出时大于单元格本身；相邻列之间的网格线被文字覆盖时不绘制。 */
  readonly firstCol: number
  readonly lastCol: number
}

/** 单元格（或合并区域）的像素矩形与可溢出的相邻列。 */
export interface CellBox {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly col: number
  readonly lastCol: number
  readonly merged: boolean
  /** 第 `col` 列的左右边界；溢出时逐列查询。 */
  readonly colLeft: (col: number) => number
  readonly colRight: (col: number) => number
  /** 该列在本行为空且不属于合并区域：文字可以越过它显示。 */
  readonly spillable: (col: number) => boolean
}

/** 旋转文字到上、下网格线的留白（未对照 WPS 核对）。 */
const BOTTOM_PADDING = 0
const TOP_PADDING = 2
/** 溢出时最多越过的列数。 */
const MAX_SPILL = 64

export interface LayoutInput {
  readonly content: CellContent
  readonly alignment: CellAlignment
  readonly font: FontStyle
  /** 条件格式等指定的文字颜色，优先于数字格式颜色与字体颜色。 */
  readonly colorOverride: string | null
  readonly fonts: FontSet
  /** 缩进一级的像素宽度。 */
  readonly indentUnit: number
}

/** 一段文字：`gap` 只占与文字等宽的空白，`fill` 在剩余宽度内重复（见 `FormatPart`）。 */
interface Piece {
  readonly run: TextRun
  readonly kind: FormatPart['kind']
}

/**
 * 数字宽度的容纳判定允许超出留白之间的宽度（像素）。WPS 屏幕显示实测（构造文件，列宽逐像素变化）：
 * 「常规」数字以字符数乘最大数字宽度（`TextPadding.digit`）估计宽度，宋体、楷体、黑体、等线、Arial、
 * Times New Roman、微软雅黑 9–16 磅的常规与粗体（留白 3+2 与 4+3）都在估计宽度 ≤ 留白之间的宽度 + 1 时容纳；
 * 其他格式以实际宽度判定，宋体、楷体、Arial 的 8 种格式在实际宽度 ≤ 留白之间的宽度 + 3 时容纳。
 * 不要改为按实际宽度判定「常规」数字：西文字体中小数点窄于数字，按实际宽度会多显示一位小数。
 */
const GENERAL_SLACK = 1
const FORMAT_SLACK = 3

function piecesOf(
  input: LayoutInput,
  available: number,
  digit: number,
): { pieces: Piece[]; hashes: boolean } {
  const { content, font, fonts } = input
  if (content.runs) {
    const pieces = content.runs.map(
      (r): Piece => ({ run: makeRun(r.text, r.font ?? font, fonts), kind: 'text' }),
    )
    return { pieces, hashes: false }
  }
  if (content.general !== null) {
    const text = generalFit(content.general, (s) => s.length * digit <= available + GENERAL_SLACK)
    if (text === null) return { pieces: [], hashes: true }
    return { pieces: [{ run: makeRun(text, font, fonts), kind: 'text' }], hashes: false }
  }
  if (content.invalid) return { pieces: [], hashes: true }
  // `_x` 的空白取空格的宽度，与其后的字符无关（WPS 实测：Arial 中 `0_W`、`0_0` 与 `0_ ` 的留白相同）。
  return {
    pieces: content.parts.map((p) => ({
      run: makeRun(p.kind === 'gap' ? ' ' : p.text, font, fonts),
      kind: p.kind,
    })),
    hashes: false,
  }
}

/**
 * 去掉末尾的空白：`_x` 的空白与文字末尾的空格。自动换行的单元格中数字按文本排版，行末空白不占宽度
 * （WPS 实测：`0_ `、`#,##0_ `、`0" "` 在自动换行时与 `0` 靠右的位置相同，不换行时留出空白；开头的空白保留）。
 */
function trimTrailingBlanks(pieces: readonly Piece[]): Piece[] {
  const out = [...pieces]
  while (out.length > 0) {
    const last = out[out.length - 1]!
    if (last.kind === 'fill') break
    const text = last.run.text.replace(/ +$/, '')
    if (text !== '') {
      if (text !== last.run.text) out[out.length - 1] = { ...last, run: { ...last.run, text } }
      break
    }
    out.pop()
  }
  return out
}

function measure(piece: Piece): number {
  return piece.kind === 'fill' ? 0 : runWidth(piece.run)
}

function hashPieces(input: LayoutInput, available: number): Piece[] {
  const probe = makeRun('#', input.font, input.fonts)
  const w = runWidth(probe)
  const n = w > 0 ? Math.floor(available / w) : 0
  return n > 0 ? [{ run: { ...probe, text: '#'.repeat(n) }, kind: 'text' }] : []
}

function fontColor(input: LayoutInput, run: TextRun): string {
  if (input.colorOverride) return input.colorOverride
  if (input.content.color) return input.content.color
  return run.font.color ?? '#000000'
}

/**
 * 布局一个单元格的文字。`box` 为单元格（或合并区域）的矩形；返回 `null` 表示没有可显示的文字。
 */
export function layoutCell(input: LayoutInput, box: CellBox): CellTextLayout | null {
  const { content, alignment } = input
  const horizontal = resolveHorizontal(alignment.horizontal, content.kind)
  const indent = alignment.indent * input.indentUnit
  const pad = textPadding(input.font, input.fonts)
  const innerLeft = box.left + pad.left
  const innerRight = box.right - pad.right
  const available = Math.max(0, innerRight - innerLeft - indent)
  const rotation = alignment.rotation
  const numeric = content.kind === 'number'
  // 自动换行与分散对齐都在单元格内排版，不溢出。只有文本按行排版；数字、逻辑值与错误值按单行排版
  // （WPS 实测：自动换行单元格中的逻辑值居中时与不换行的位置相同）。
  const wrap = alignment.wrap || horizontal === 'justify' || alignment.vertical === 'justify'
  const built = piecesOf(input, available, pad.digit)
  let pieces = wrap && numeric ? trimTrailingBlanks(built.pieces) : built.pieces
  if (built.hashes) pieces = hashPieces(input, available)
  else if (numeric && content.general === null && !alignment.shrink && rotation === 0) {
    // 非常规格式的数字宽度不足时整格显示 `#`。
    const width = pieces.reduce((s, p) => s + measure(p), 0)
    if (width > available + FORMAT_SLACK + 0.01) pieces = hashPieces(input, available)
  }
  if (pieces.length === 0) return null
  let runs = pieces.map((p) => p.run)

  const top = box.top
  const bottom = box.bottom

  if (rotation !== 0) {
    const metrics = lineMetrics(runs)
    return layoutRotated(input, box, runs, metrics.ascent + metrics.descent, metrics, pad)
  }

  if (wrap && content.kind === 'text') {
    const lines = wrapRuns(runs, Math.max(1, innerRight - innerLeft - indent))
    const boxes = lines.map(lineBoxOf)
    const total = boxes.reduce((sum, b) => sum + b.height, 0)
    let lineTop = firstLineTop(alignment.vertical, top, bottom, total, lines.length > 1)
    const fragments: TextFragment[] = []
    lines.forEach((line, i) => {
      const b = boxes[i]!
      const baseline = lineTop + b.baseline
      lineTop += b.height
      let x = innerLeft + indent
      if (horizontal === 'right') x = innerRight - indent - line.width
      else if (horizontal === 'center' || horizontal === 'centerContinuous') {
        // 自动换行的行居中时余量为奇数向左取整，不换行的文字向右取整（WPS 实测，7 种字体两种列宽奇偶）。
        x = Math.floor((innerLeft + innerRight - line.width) / 2)
      }
      for (const run of line.runs) {
        const w = runWidth(run)
        fragments.push({
          text: run.text,
          x,
          y: baseline,
          run,
          width: w,
          color: fontColor(input, run),
        })
        x += w
      }
    })
    return { fragments, clip: box, rotate: null, firstCol: box.col, lastCol: box.lastCol }
  }

  // 单行。
  let scale = 1
  let width = pieces.reduce((s, p) => s + measure(p), 0)
  if (alignment.shrink && width > available && width > 0) {
    scale = available / width
    pieces = pieces.map((p) => ({ ...p, run: { ...p.run, px: p.run.px * scale } }))
    runs = pieces.map((p) => p.run)
    width = available
  }
  const metrics = wrappedLineMetrics(runs)
  const baseline = Math.round(
    firstLineTop(alignment.vertical, top, bottom, metrics.height * scale, false) +
      metrics.baseline * scale,
  )

  // `*x` 填充与填充对齐：在可用宽度内重复字符。
  if (horizontal === 'fill' || pieces.some((p) => p.kind === 'fill')) {
    return layoutFill(input, box, pieces, baseline, horizontal, indent, pad)
  }

  let firstCol = box.col
  let lastCol = box.lastCol
  let clipLeft = box.left
  let clipRight = box.right
  let x = innerLeft + indent
  if (horizontal === 'distributed' && runs.length === 1 && !numeric) {
    return layoutDistributed(input, box, runs[0]!, baseline, indent, pad)
  }
  if (horizontal === 'right') x = innerRight - indent - width
  else if (horizontal === 'center' || horizontal === 'centerContinuous') {
    x = (innerLeft + innerRight - width) / 2
  }

  // 溢出：只有文本可以越过相邻的空单元格。
  const spills = content.kind === 'text' && !box.merged && !alignment.shrink
  if (spills && width > available) {
    if (horizontal === 'left' || horizontal === 'general' || horizontal === 'justify') {
      ;({ lastCol, clipRight } = spillRight(box, x + width + pad.right))
    } else if (horizontal === 'right') {
      ;({ firstCol, clipLeft } = spillLeft(box, x - pad.left))
    } else if (horizontal === 'center' || horizontal === 'centerContinuous') {
      ;({ lastCol, clipRight } = spillRight(box, x + width + pad.right))
      ;({ firstCol, clipLeft } = spillLeft(box, x - pad.left))
    }
  }

  const fragments: TextFragment[] = []
  for (const p of pieces) {
    const w = measure(p)
    if (p.kind === 'text') {
      fragments.push({
        text: p.run.text,
        x,
        y: baseline,
        run: p.run,
        width: w,
        color: fontColor(input, p.run),
      })
    }
    x += w
  }
  return {
    fragments,
    clip: { left: clipLeft, top, right: clipRight, bottom },
    rotate: null,
    firstCol,
    lastCol,
  }
}

/**
 * 首行的行顶（WPS 屏幕显示逐格实测）。`top`、`bottom` 为上、下网格线的坐标，`total` 为各行 `height` 之和，
 * 基线在行顶之下 `LineBox.baseline`：靠上时行顶即上网格线；靠下时末行行底与下网格线重合；
 * 居中时为 `top + (行高 − total) / 2` 向零取整，单行文字高于行高时差值为负，不要改为向下取整：向下取整使文字低 1 像素；
 * 多行文字高于行高时首行靠上（差值取 0，经验规则，机制未查明）。靠下的多行文字高于行高时仍按行底定位。
 */
function firstLineTop(
  vertical: CellAlignment['vertical'],
  top: number,
  bottom: number,
  total: number,
  multiline: boolean,
): number {
  if (vertical === 'top') return top
  if (vertical === 'center' || vertical === 'distributed') {
    const offset = Math.trunc((bottom - top - total) / 2)
    return top + (multiline ? Math.max(0, offset) : offset)
  }
  return bottom - total
}

function spillRight(box: CellBox, needRight: number): { lastCol: number; clipRight: number } {
  let lastCol = box.lastCol
  let clipRight = box.right
  for (let c = box.lastCol + 1; c <= box.lastCol + MAX_SPILL && clipRight < needRight; c++) {
    if (!box.spillable(c)) break
    lastCol = c
    clipRight = box.colRight(c)
  }
  return { lastCol, clipRight }
}

function spillLeft(box: CellBox, needLeft: number): { firstCol: number; clipLeft: number } {
  let firstCol = box.col
  let clipLeft = box.left
  for (let c = box.col - 1; c >= Math.max(0, box.col - MAX_SPILL) && clipLeft > needLeft; c--) {
    if (!box.spillable(c)) break
    firstCol = c
    clipLeft = box.colLeft(c)
  }
  return { firstCol, clipLeft }
}

/**
 * 填充对齐与 `*x` 填充。`*x` 的字符重复整数次：取总宽不超过可用宽度加 `FORMAT_SLACK` 的最大次数，
 * 之后整段按水平对齐放置（靠左、居中，其余靠右）。不要改为把填充拉伸到单元格两侧：WPS 屏幕显示实测
 * （宋体、Arial，常规与粗体，列宽逐像素变化）靠左与居中时数字的位置随列宽以填充字符宽度为周期往复变化。
 */
function layoutFill(
  input: LayoutInput,
  box: CellBox,
  pieces: Piece[],
  baseline: number,
  horizontal: HorizontalAlign,
  indent: number,
  pad: TextPadding,
): CellTextLayout {
  const left = box.left + pad.left + indent
  const right = box.right - pad.right
  const fragments: TextFragment[] = []
  const first = pieces[0]!.run
  if (horizontal === 'fill') {
    // 填充对齐：整段文字重复到填满单元格，不足一次时显示一次。
    const text = pieces.map((p) => p.run.text).join('')
    const w = runWidth({ ...first, text })
    const n = w > 0 ? Math.max(1, Math.floor((right - left) / w)) : 1
    const run = { ...first, text: text.repeat(n) }
    fragments.push({
      text: run.text,
      x: left,
      y: baseline,
      run,
      width: w * n,
      color: fontColor(input, first),
    })
    return { fragments, clip: box, rotate: null, firstCol: box.col, lastCol: box.lastCol }
  }
  const fixed = pieces.reduce((s, p) => s + measure(p), 0)
  const fillIndex = pieces.findIndex((p) => p.kind === 'fill')
  const fill = pieces[fillIndex]!.run
  const charWidth = runWidth(fill)
  const count =
    charWidth > 0 ? Math.floor(Math.max(0, right - left + FORMAT_SLACK - fixed) / charWidth) : 0
  const total = fixed + count * charWidth
  let x = right - total
  if (horizontal === 'left') x = left
  else if (horizontal === 'center' || horizontal === 'centerContinuous')
    x = (left + right - total) / 2
  pieces.forEach((p, i) => {
    if (i === fillIndex) {
      const text = fill.text.repeat(count)
      if (text) {
        const run = { ...fill, text }
        fragments.push({
          text,
          x,
          y: baseline,
          run,
          width: count * charWidth,
          color: fontColor(input, fill),
        })
      }
      x += count * charWidth
      return
    }
    const w = measure(p)
    if (p.kind === 'text') {
      fragments.push({
        text: p.run.text,
        x,
        y: baseline,
        run: p.run,
        width: w,
        color: fontColor(input, p.run),
      })
    }
    x += w
  })
  return { fragments, clip: box, rotate: null, firstCol: box.col, lastCol: box.lastCol }
}

/** 分散对齐：字符间距均分剩余宽度；只有一个字符时居中。 */
function layoutDistributed(
  input: LayoutInput,
  box: CellBox,
  run: TextRun,
  baseline: number,
  indent: number,
  pad: TextPadding,
): CellTextLayout {
  const left = box.left + pad.left + indent
  const right = box.right - pad.right - indent
  const chars = [...run.text]
  const widths = chars.map((c) => run.chain.width(c, run.px))
  const total = widths.reduce((a, b) => a + b, 0)
  const fragments: TextFragment[] = []
  if (chars.length === 1 || total >= right - left) {
    const x = chars.length === 1 ? (left + right - total) / 2 : left
    fragments.push({
      text: run.text,
      x,
      y: baseline,
      run,
      width: total,
      color: fontColor(input, run),
    })
  } else {
    const gap = (right - left - total) / (chars.length - 1)
    let x = left
    chars.forEach((c, i) => {
      const r = { ...run, text: c }
      fragments.push({
        text: c,
        x,
        y: baseline,
        run: r,
        width: widths[i]!,
        color: fontColor(input, run),
      })
      x += widths[i]! + gap
    })
  }
  return { fragments, clip: box, rotate: null, firstCol: box.col, lastCol: box.lastCol }
}

/**
 * 旋转的文字：0–90 逆时针，91–180 顺时针 `值 − 90` 度，255 为竖排（字符自上而下）。
 * 文字绕自身中心旋转后放在单元格内，按水平、垂直对齐靠边。
 */
function layoutRotated(
  input: LayoutInput,
  box: CellBox,
  runs: TextRun[],
  lineHeight: number,
  metrics: { ascent: number; descent: number },
  pad: TextPadding,
): CellTextLayout {
  const { alignment } = input
  const horizontal = resolveHorizontal(alignment.horizontal, input.content.kind)
  const rot = alignment.rotation
  const text = runs.map((r) => r.text).join('')
  const run = { ...runs[0]!, text }
  const width = runWidth(run)
  const innerLeft = box.left + pad.left
  const innerRight = box.right - pad.right
  const innerTop = box.top + TOP_PADDING
  const innerBottom = box.bottom - BOTTOM_PADDING
  if (rot === 255) {
    // 竖排：每个字符一行，水平居中于列。
    const chars = [...text]
    const total = chars.length * lineHeight
    let y0 = innerBottom - total
    if (alignment.vertical === 'top') y0 = innerTop
    else if (alignment.vertical === 'center') y0 = (box.top + box.bottom - total) / 2
    const fragments = chars.map((c, i): TextFragment => {
      const r = { ...run, text: c }
      const w = runWidth(r)
      let x = (innerLeft + innerRight - w) / 2
      if (horizontal === 'left') x = innerLeft
      else if (horizontal === 'right') x = innerRight - w
      return {
        text: c,
        x,
        y: y0 + i * lineHeight + metrics.ascent,
        run: r,
        width: w,
        color: fontColor(input, run),
      }
    })
    return { fragments, clip: box, rotate: null, firstCol: box.col, lastCol: box.lastCol }
  }
  const angle = rot <= 90 ? rot : -(rot - 90)
  const rad = (Math.abs(angle) * Math.PI) / 180
  // 旋转后外接矩形的宽与高。
  const boundW = width * Math.cos(rad) + lineHeight * Math.sin(rad)
  const boundH = width * Math.sin(rad) + lineHeight * Math.cos(rad)
  let cx = (innerLeft + innerRight) / 2
  if (horizontal === 'left') cx = innerLeft + boundW / 2
  else if (horizontal === 'right') cx = innerRight - boundW / 2
  let cy = innerBottom - boundH / 2
  if (alignment.vertical === 'top') cy = innerTop + boundH / 2
  else if (alignment.vertical === 'center') cy = (box.top + box.bottom) / 2
  const fragment: TextFragment = {
    text,
    x: cx - width / 2,
    y: cy + (metrics.ascent - metrics.descent) / 2,
    run,
    width,
    color: fontColor(input, run),
  }
  return {
    fragments: [fragment],
    clip: box,
    rotate: { angle, cx, cy },
    firstCol: box.col,
    lastCol: box.lastCol,
  }
}
