/**
 * 条件格式求值：单元格在绘制时叠加的样式、色阶颜色与数据条。
 *
 * - 规则按 `priority` 升序求值，同一属性取优先级最高的命中规则；命中 `stopIfTrue` 的规则后不再求值更低的规则。
 * - 规则引用的公式（`cellIs` 的操作数、`expression`）由 `formula.ts` 求值，相对引用以规则第一个区域的
 *   左上角为基准平移。无法求值的公式（未支持的函数或语法、错误值）不命中。
 * - `cellIs` 中空白单元格（含文件中没有的单元格）按空值参与比较，即与 0 和空串相等（WPS 实测：等于空白单元格、
 *   等于 0、等于 `""`、小于 5、介于 −1 与 1 均命中，等于 `" "` 不命中）；没有缓存值的公式不参与。
 * - 差异样式的填充以 `overlay` 叠加到单元格原填充上，缺失的颜色按其规则补齐。
 * - 色阶、数据条、前 N 项、高于平均值、重复值按规则全部区域内的值统计，统计结果按规则缓存。
 */

import {
  compareOperator,
  evaluateFormula,
  isError,
  type Scalar,
  scalarOf,
  truthy,
} from '../formula.ts'
import type {
  CellBorder,
  CellFill,
  CellRange,
  CellValue,
  CfRule,
  CfThreshold,
  DifferentialFill,
  UnderlineStyle,
  Workbook,
  Worksheet,
} from '../model.ts'

export interface CfEffect {
  readonly fill: DifferentialFill | null
  readonly color: string | null
  readonly bold: boolean | null
  readonly italic: boolean | null
  readonly strike: boolean | null
  readonly underline: UnderlineStyle | null
  readonly border: CellBorder | null
  readonly numFmt: string | null
  /** 数据条：长度比例 0–1。 */
  readonly bar: { readonly ratio: number; readonly color: string } | null
}

interface Entry {
  readonly rule: CfRule
  readonly ranges: readonly CellRange[]
}

interface Stats {
  readonly numbers: readonly number[]
  readonly counts: ReadonlyMap<string, number>
}

function inRanges(ranges: readonly CellRange[], row: number, col: number): boolean {
  for (const r of ranges) {
    if (row >= r.top && row <= r.bottom && col >= r.left && col <= r.right) return true
  }
  return false
}

function keyOf(v: Scalar): string | null {
  if (v === null || v === '' || isError(v)) return null
  return typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`
}

export class ConditionalFormats {
  private readonly entries: Entry[]
  /** 同一 `conditionalFormatting` 下的规则共用区域，统计按区域数组缓存。 */
  private readonly stats = new Map<readonly CellRange[], Stats>()
  /** `overlay` 的结果按两个输入对象缓存：绘制按填充对象分组，相同输入须得到同一对象。 */
  private readonly overlays = new Map<DifferentialFill, Map<CellFill | null, CellFill>>()

  constructor(
    private readonly wb: Workbook,
    private readonly sheet: Worksheet,
  ) {
    const entries: Entry[] = []
    for (const cf of sheet.conditionalFormats) {
      for (const rule of cf.rules) entries.push({ rule, ranges: cf.ranges })
    }
    entries.sort((a, b) => a.rule.priority - b.rule.priority)
    this.entries = entries
  }

  get empty(): boolean {
    return this.entries.length === 0
  }

  /**
   * 差异样式的填充叠加到单元格原填充 `base` 上。WPS 实测：图案色缺失时为黑色；底色缺失时取单元格原填充的纯色，
   * 没有纯色填充时为白色（只有 `fgColor` 的纯色差异样式因此不改变单元格的颜色，但照常遮住网格线）。
   */
  overlay(fill: DifferentialFill, base: CellFill | null): CellFill {
    if (fill.kind === 'gradient') return fill
    let cache = this.overlays.get(fill)
    if (!cache) {
      cache = new Map()
      this.overlays.set(fill, cache)
    }
    let out = cache.get(base)
    if (!out) {
      const under = base?.kind === 'pattern' && base.pattern === 'solid' ? base.fg : '#ffffff'
      const bg = fill.bg ?? under
      const fg = fill.pattern === 'solid' ? bg : (fill.fg ?? '#000000')
      out = { kind: 'pattern', pattern: fill.pattern, fg, bg }
      cache.set(base, out)
    }
    return out
  }

  at(row: number, col: number, value: CellValue | null): CfEffect | null {
    if (this.entries.length === 0) return null
    let effect:
      | {
          -readonly [K in keyof CfEffect]: CfEffect[K]
        }
      | null = null
    const v = scalarOf(value)
    const unknown = value?.type === 'formula'
    for (const { rule, ranges } of this.entries) {
      if (!inRanges(ranges, row, col)) continue
      const e = this.evaluate(rule, ranges, row, col, v, unknown)
      if (!e) continue
      effect ??= {
        fill: null,
        color: null,
        bold: null,
        italic: null,
        strike: null,
        underline: null,
        border: null,
        numFmt: null,
        bar: null,
      }
      for (const k of Object.keys(e) as (keyof CfEffect)[]) {
        if (effect[k] === null && e[k] !== null && e[k] !== undefined) {
          ;(effect as Record<string, unknown>)[k] = e[k]
        }
      }
      if (rule.stopIfTrue) break
    }
    return effect
  }

  private evaluate(
    rule: CfRule,
    ranges: readonly CellRange[],
    row: number,
    col: number,
    v: Scalar,
    unknown: boolean,
  ): Partial<CfEffect> | null {
    const anchor = ranges[0] ?? { top: row, left: col, bottom: row, right: col }
    const evalFormula = (f: string) =>
      evaluateFormula(f, this.wb, this.sheet, row - anchor.top, col - anchor.left)
    let matched = false
    switch (rule.type) {
      case 'colorScale': {
        if (typeof v !== 'number') return null
        const color = this.scaleColor(rule, ranges, v)
        return color ? { fill: { kind: 'pattern', pattern: 'solid', fg: color, bg: color } } : null
      }
      case 'dataBar': {
        if (typeof v !== 'number') return null
        const [lo, hi] = this.bounds(rule.thresholds, ranges, [0, 1])
        const ratio = hi > lo ? (v - lo) / (hi - lo) : 1
        return { bar: { ratio: Math.min(1, Math.max(0, ratio)), color: rule.color } }
      }
      case 'cellIs': {
        if (unknown || isError(v)) return null
        const ops = rule.formulas.map(evalFormula)
        if (ops.some((o) => o === undefined || isError(o))) return null
        matched = compareOperator(rule.operator, v, ops as Scalar[])
        break
      }
      case 'expression': {
        const r = evalFormula(rule.formula)
        matched = r !== undefined && truthy(r)
        break
      }
      case 'containsText':
      case 'notContainsText':
      case 'beginsWith':
      case 'endsWith': {
        const text = v === null || isError(v) ? '' : String(v).toLowerCase()
        const needle = rule.text.toLowerCase()
        const hit =
          rule.type === 'beginsWith'
            ? text.startsWith(needle)
            : rule.type === 'endsWith'
              ? text.endsWith(needle)
              : text.includes(needle)
        matched = rule.type === 'notContainsText' ? !hit : hit && (v !== null || needle === '')
        break
      }
      case 'containsBlanks':
      case 'notContainsBlanks': {
        const blank = v === null || (typeof v === 'string' && v.trim() === '')
        matched = rule.type === 'containsBlanks' ? blank : !blank
        break
      }
      case 'containsErrors':
      case 'notContainsErrors':
        matched = rule.type === 'containsErrors' ? isError(v) : !isError(v)
        break
      case 'duplicateValues':
      case 'uniqueValues': {
        const k = keyOf(v)
        if (k === null) return null
        const n = this.statsFor(ranges).counts.get(k) ?? 0
        matched = rule.type === 'duplicateValues' ? n > 1 : n === 1
        break
      }
      case 'top10': {
        if (typeof v !== 'number') return null
        const nums = [...this.statsFor(ranges).numbers].sort((a, b) =>
          rule.bottom ? a - b : b - a,
        )
        const n = rule.percent
          ? Math.max(1, Math.floor((nums.length * rule.rank) / 100))
          : rule.rank
        const edge = nums[Math.min(n, nums.length) - 1]
        matched = edge !== undefined && (rule.bottom ? v <= edge : v >= edge)
        break
      }
      case 'aboveAverage': {
        if (typeof v !== 'number') return null
        const nums = this.statsFor(ranges).numbers
        if (nums.length === 0) return null
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length
        matched = rule.above
          ? v > avg || (rule.equal && v === avg)
          : v < avg || (rule.equal && v === avg)
        break
      }
    }
    if (!matched) return null
    const dxf = rule.dxf
    if (!dxf) return {}
    return {
      fill: dxf.fill,
      color: dxf.color,
      bold: dxf.bold,
      italic: dxf.italic,
      strike: dxf.strike,
      underline: dxf.underline,
      border: dxf.border,
      numFmt: dxf.numFmt,
    }
  }

  private statsFor(ranges: readonly CellRange[]): Stats {
    let s = this.stats.get(ranges)
    if (s) return s
    const numbers: number[] = []
    const counts = new Map<string, number>()
    for (const [row, line] of this.sheet.cells) {
      for (const [col, cell] of line) {
        if (!inRanges(ranges, row, col)) continue
        const v = scalarOf(cell.value)
        if (typeof v === 'number') numbers.push(v)
        const k = keyOf(v)
        if (k !== null) counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
    s = { numbers, counts }
    this.stats.set(ranges, s)
    return s
  }

  private threshold(t: CfThreshold, ranges: readonly CellRange[], fallback: number): number {
    const nums = this.statsFor(ranges).numbers
    const sorted = [...nums].sort((a, b) => a - b)
    const min = sorted[0] ?? 0
    const max = sorted[sorted.length - 1] ?? 0
    switch (t.type) {
      case 'min':
      case 'autoMin':
        return min
      case 'max':
      case 'autoMax':
        return max
      case 'num':
        return t.value ?? fallback
      case 'percent':
        return min + ((max - min) * (t.value ?? 0)) / 100
      case 'percentile': {
        if (sorted.length === 0) return fallback
        const pos = ((sorted.length - 1) * (t.value ?? 0)) / 100
        const lo = Math.floor(pos)
        const hi = Math.ceil(pos)
        return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
      }
      case 'formula':
        return t.value ?? fallback
    }
  }

  private bounds(
    thresholds: readonly CfThreshold[],
    ranges: readonly CellRange[],
    fallback: [number, number],
  ) {
    const lo = thresholds[0] ? this.threshold(thresholds[0], ranges, fallback[0]) : fallback[0]
    const hi = thresholds[1] ? this.threshold(thresholds[1], ranges, fallback[1]) : fallback[1]
    return [lo, hi] as const
  }

  private scaleColor(
    rule: Extract<CfRule, { type: 'colorScale' }>,
    ranges: readonly CellRange[],
    v: number,
  ) {
    const points = rule.thresholds.map((t) => this.threshold(t, ranges, 0))
    const colors = rule.colors
    if (points.length < 2 || colors.length < points.length) return null
    if (v <= points[0]!) return colors[0]!
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!
      const b = points[i]!
      if (v <= b) return lerpColor(colors[i - 1]!, colors[i]!, b > a ? (v - a) / (b - a) : 1)
    }
    return colors[points.length - 1]!
  }
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16)
  const pb = Number.parseInt(b.slice(1), 16)
  const ch = (shift: number) => {
    const x = (pa >> shift) & 0xff
    const y = (pb >> shift) & 0xff
    return Math.round(x + (y - x) * t)
  }
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`
}
