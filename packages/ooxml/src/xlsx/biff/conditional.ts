/**
 * .xls 的条件格式：CONDFMT 与其后的 CF 记录换算为 `ConditionalFormat`，规则与求值同 xlsx（`../render/conditional.ts`）。
 *
 * - CF 的条件为「单元格值」（对应 `cellIs`）或「公式」（对应 `expression`）；公式由 `formula.ts` 反编译为文本，
 *   相对引用以区域列表中第一个区域的左上角为基准，与求值时的平移基准相同。
 * - BIFF8 只应用第一个成立的条件：规则按出现顺序编号为优先级，`stopIfTrue` 为真。CFEX 中的优先级不读取，
 *   它只在区域重叠时改变结果。
 * - 差异样式（DXFN）：字体的颜色、粗体、倾斜、删除线与下划线，图案填充，四边与对角线边框，数字格式；
 *   标记为不改变（Ninch）的项为 `null`。纯色填充的颜色取背景色（与 xlsx 差异样式的 `bgColor` 相同）。
 * - 反编译失败的规则不进入模型，由调用方计入 `conditionalFormat`；能反编译而求值器不支持的规则保留在模型中并计入，与 xlsx 相同。
 */

import { formatCodeFor } from '../../numfmt/format.ts'
import type {
  BorderLine,
  CellBorder,
  CellRange,
  CfRule,
  CfRuleKind,
  DifferentialFill,
  DifferentialStyle,
  UnderlineStyle,
} from '../model.ts'
import { formulaText } from './formula.ts'
import { BORDER_STYLES, PATTERNS, UNDERLINES } from './globals.ts'
import { type Bytes, unicodeString } from './records.ts'

type Operator = Extract<CfRuleKind, { type: 'cellIs' }>['operator']

const OPERATORS: readonly (Operator | null)[] = [
  null,
  'between',
  'notBetween',
  'equal',
  'notEqual',
  'greaterThan',
  'lessThan',
  'greaterThanOrEqual',
  'lessThanOrEqual',
]

export interface CfContext {
  readonly palette: readonly string[]
  readonly formats: ReadonlyMap<number, string>
}

/** CONDFMT 的区域列表（SqRefU）。 */
export function readRanges(b: Bytes): CellRange[] {
  const out: CellRange[] = []
  for (let k = 0; k < b.u16(12) && 14 + k * 8 + 8 <= b.length; k++) {
    const p = 14 + k * 8
    out.push({ top: b.u16(p), bottom: b.u16(p + 2), left: b.u16(p + 4), right: b.u16(p + 6) })
  }
  return out
}

/** 一条 CF 记录；无法换算时返回 `null`。 */
export function readRule(
  b: Bytes,
  ranges: readonly CellRange[],
  priority: number,
  ctx: CfContext,
): CfRule | null {
  const cce1 = b.u16(2)
  const cce2 = b.u16(4)
  const end = b.length
  if (6 + cce1 + cce2 > end) return null
  const anchor = ranges[0]
  const fctx = {
    sheetName: () => null,
    base: { row: anchor?.top ?? 0, col: anchor?.left ?? 0 },
  }
  const f1 = cce1 > 0 ? formulaText(b.data.subarray(end - cce1 - cce2, end - cce2), fctx) : null
  const f2 = cce2 > 0 ? formulaText(b.data.subarray(end - cce2), fctx) : null
  let kind: CfRuleKind | null = null
  if (b.u8(0) === 1) {
    const operator = OPERATORS[b.u8(1)] ?? null
    const two = operator === 'between' || operator === 'notBetween'
    if (operator !== null && f1 !== null && (!two || f2 !== null)) {
      kind = { type: 'cellIs', operator, formulas: two ? [f1, f2!] : [f1] }
    }
  } else if (b.u8(0) === 2 && f1 !== null) kind = { type: 'expression', formula: f1 }
  if (kind === null) return null
  return { ...kind, priority, stopIfTrue: true, dxf: readDxf(b, 6, ctx) }
}

/** DXFN：4 字节标志与 2 字节标志之后，依次为数字格式、字体、对齐、边框、图案与保护，各自按标志出现。 */
function readDxf(b: Bytes, start: number, ctx: CfContext): DifferentialStyle {
  const flags = b.u32(start)
  const ninch = (bit: number) => (flags & (1 << bit)) !== 0
  const icv = (index: number): string | null => ctx.palette[index] ?? null
  let p = start + 6
  let numFmt: string | null = null
  if (flags & (1 << 25)) {
    if (b.u16(start + 4) & 1) {
      if (!ninch(19)) numFmt = unicodeString(b, p + 2).text
      p += b.u16(p)
    } else {
      if (!ninch(19)) numFmt = formatCodeFor(b.u8(p + 1), ctx.formats)
      p += 2
    }
  }
  const style: {
    bold: boolean | null
    italic: boolean | null
    strike: boolean | null
    underline: UnderlineStyle | null
    color: string | null
  } = { bold: null, italic: null, strike: null, underline: null, color: null }
  if (flags & (1 << 26)) {
    const ts = b.u32(p + 68)
    const tsNinch = b.u32(p + 88)
    const color = b.u32(p + 80)
    if (color !== 0xffffffff) style.color = icv(color)
    if (!(tsNinch & 0x02)) style.italic = (ts & 0x02) !== 0
    if (!(tsNinch & 0x80)) style.strike = (ts & 0x80) !== 0
    if (b.u32(p + 96) === 0) style.underline = UNDERLINES[b.u8(p + 76)] ?? 'none'
    if (b.u32(p + 100) === 0 && b.u16(p + 72) !== 0xffff) style.bold = b.u16(p + 72) >= 700
    p += 118
  }
  if (flags & (1 << 27)) p += 8
  let border: CellBorder | null = null
  if (flags & (1 << 28)) {
    const lines = b.u32(p)
    const more = b.u32(p + 4)
    const side = (bit: number, style: number, index: number): BorderLine | null => {
      const s = ninch(bit) ? null : (BORDER_STYLES[style] ?? null)
      return s === null ? null : { style: s, color: icv(index) ?? '#000000' }
    }
    const diagonal = (bit: number) => side(bit, (more >>> 21) & 15, (more >>> 14) & 127)
    border = {
      left: side(10, lines & 15, (lines >>> 16) & 127),
      right: side(11, (lines >>> 4) & 15, (lines >>> 23) & 127),
      top: side(12, (lines >>> 8) & 15, more & 127),
      bottom: side(13, (lines >>> 12) & 15, (more >>> 7) & 127),
      diagonalDown: lines & (1 << 30) ? diagonal(14) : null,
      diagonalUp: lines & (1 << 31) ? diagonal(15) : null,
    }
    if (Object.values(border).every((v) => v === null)) border = null
    p += 8
  }
  let fill: DifferentialFill | null = null
  if (flags & (1 << 29)) {
    const pattern = ninch(16) ? 'solid' : (PATTERNS[(b.u16(p) >>> 10) & 63] ?? null)
    const colors = b.u16(p + 2)
    const bg = ninch(18) ? null : icv((colors >>> 7) & 127)
    if (pattern !== null) {
      fill = {
        kind: 'pattern',
        pattern,
        fg: pattern === 'solid' ? bg : ninch(17) ? null : icv(colors & 127),
        bg,
      }
    }
  }
  return { ...style, fill, border, numFmt }
}
