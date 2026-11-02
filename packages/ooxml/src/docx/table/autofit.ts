/**
 * 自动调整布局（`tblLayout` 不为 `fixed`）的列宽，WPS 12.1 实测（构造文档 w10a、w10b、w10e、w10k、w14 t15、t14 与语料表格的变体
 * w10v1）。
 * 长度单位为磅，宽度均含单元格左右边距。网格（`tblGrid`）只用于没有单列单元格的列。
 *
 * - 单元格的最小与最大宽度：各段落最小与最大内容宽度（`ParagraphLayouter.contentWidths`）中的最大值，嵌套表格两者都取其网格
 *   宽度；`noWrap` 的单元格两者都取最大内容宽度；内容宽度不小于 0.3 磅（只有空段落的单元格为边距加 0.3 磅）。加左右边距后
 *   向上取整到 1/20 磅。
 * - 首选宽度：`tcW` 为 `dxa` 且大于 0 时给出；`auto`、`nil`、`pct` 与缺省都不给出（`pct` 另见下文）。列中有首选宽度的
 *   单元格时为定宽列，取其中最大的首选宽度，否则为自动列。列的初值：定宽列为首选宽度与第一个给出首选宽度的单元格之后各自动单元格最大宽度中的较大者，
 *   该单元格之前的单元格不计入（自上而下为 auto 的 12 字与 dxa 的 100 磅时列宽 100 磅，次序相反时为 12 字宽）；给出首选宽度的
 *   单元格本身的最大宽度不计入（首选 50 磅、内容 52.8 磅的列宽 50 磅）。自动列为各单元格最大宽度中的最大值。都不小于最小宽度。
 * - 合并单元格（`gridSpan`）在各列初值求得之后计入，取整到 1 缇：最小宽度大于所跨各列初值之和时，所跨各列改为该最小宽度按各列
 *   最小宽度与初值之和的比例分得的值，各列最小宽度不小于此值（不可断开的 40 个数字跨 4 字与 8 字两列时为 86 与 134.8 磅，
 *   4 字列为 100 磅的定宽列时为 112.8 与 108 磅；不要改为按初值的比例，那样为 79 与 141.8 磅）；之后首选宽度（没有时为最大宽度）大于各列
 *   之和时，差额按各列的比例分到各列。最小宽度不大于各列之和时不改变初值（跨 4 字与 16 字两列时不变），只把差额按初值的比例
 *   计入各列最小宽度，不超过初值。
 * - 表格宽度：`tblW` 为 `dxa` 时为其值，为 `pct` 时为该比例乘以基准宽度，否则为各列初值之和与可用宽度中的较小者；不小于各列
 *   最小宽度之和，`dxa` 大于区域宽度时不缩小。基准宽度：兼容模式 15 为区域宽度减表格左右框线（`tblBorders`，不含单元格自身
 *   的边框）的一半，低于 15 为区域宽度加表格左右边距，与左缩进无关（左缩进 25、-25 磅时 100% 与 50% 的表格宽度不变）；
 *   可用宽度为基准宽度减左对齐表格的左缩进。
 * - 各列初值之和大于表格宽度时先收窄自动列，各列的收窄量与其初值减最小宽度成正比；自动列都到最小宽度仍不够时，定宽列按同一
 *   规则收窄。小于表格宽度时差额只分给自动列，与其初值成正比；没有自动列时分给全部列。各列宽度取整到 1 缇。
 * - 有列的 `tcW` 为 `pct`（取列中各单列单元格的最大比例）时按 `percentColumns` 求列宽，`dxa` 首选宽度只计入初值。
 *   未实现：比例之和大于 1，或等于 1 而另有其他列（按以上规则处理；两列各 100% 时 WPS 为 73.5 与 21.3 磅）。
 */

import { borderSpace } from '../border.ts'
import type { TableBlock, TableCell } from '../model.ts'
import type { TableContext } from './layout.ts'

/** 没有内容的单元格的内容宽度。 */
const EMPTY_CONTENT = 0.3

const EPSILON = 1e-6

/**
 * 向上取整到 1/20 磅。WPS 实测：最小内容宽度 172.9245 与 50.457 磅的列为 172.95 与 50.5 磅；不要改为四舍五入，
 * 那样得到 172.9 与 50.45。容差抵消浮点误差，使恰为 1/20 磅整数倍的值不进位。
 */
function ceilTwips(v: number): number {
  return Math.ceil(v * 20 - 1e-9) / 20
}

function roundTwips(v: number): number {
  return Math.round(v * 20) / 20
}

/** 单元格的最小与最大宽度（含左右边距，见文件头）。 */
function cellWidths(cell: TableCell, cx: TableContext): { min: number; max: number } {
  let min = EMPTY_CONTENT
  let max = EMPTY_CONTENT
  for (const b of cell.content) {
    const w =
      b.kind === 'paragraph'
        ? cx.layouter.contentWidths(b)
        : { min: b.grid.reduce((a, g) => a + g, 0), max: b.grid.reduce((a, g) => a + g, 0) }
    min = Math.max(min, w.min)
    max = Math.max(max, w.max)
  }
  if (cell.noWrap) min = max
  const m = cell.margins.left + cell.margins.right
  return { min: ceilTwips(min + m), max: ceilTwips(Math.max(min, max) + m) }
}

function preferred(cell: TableCell): number | null {
  const w = cell.width
  return w !== null && w.type === 'dxa' && w.value > 0 ? w.value : null
}

/** `tcW` 为 `pct` 且大于 0 时的比例。 */
function share(cell: TableCell): number | null {
  const w = cell.width
  return w !== null && w.type === 'pct' && w.value > 0 ? w.value : null
}

/**
 * 有 `pct` 列时的列宽：`shares` 为各列的比例（没有为 `null`），比例之和为 P；`width` 为 `tblW` 给出的表格宽度（没有为 `null`）。
 * 表格宽度为 `width`，否则为各 `pct` 列初值除以其比例、其余列初值之和除以 1 − P 中的最大者，不超过 `avail`。没有其余列时
 * 各 `pct` 列按比例分满表格宽度；否则各 `pct` 列为表格宽度乘以其比例，余下的按初值的比例分给其余列。
 * WPS 实测：20% 与 40% 的两列内容为 4 字与 8 字时为 88 与 176 磅，内容为 8 字与 4 字时超出可用宽度、为其 1/3 与 2/3；
 * `tblW` 为 300 磅时为 100 与 200 磅；20% 的 4 字列与 8 字的自动列或 150 磅的定宽列为 52.8 与 211.2 磅。
 * 比例之和大于 1，或等于 1 而另有其他列时返回 `null`。
 */
function percentColumns(
  init: readonly number[],
  shares: readonly (number | null)[],
  width: number | null,
  avail: number,
): number[] | null {
  const pct = shares.flatMap((p, k) => (p === null ? [] : [k]))
  const rest = shares.flatMap((p, k) => (p === null ? [k] : []))
  const total = pct.reduce((a, k) => a + shares[k]!, 0)
  if (total > 1 + EPSILON || (rest.length > 0 && total > 1 - EPSILON)) return null
  const restInit = rest.reduce((a, k) => a + init[k]!, 0)
  let natural = Math.max(...pct.map((k) => init[k]! / shares[k]!))
  if (rest.length > 0) natural = Math.max(natural, restInit / (1 - total))
  const tw = width ?? Math.min(natural, avail)
  const out = init.slice()
  for (const k of pct) out[k] = (tw * shares[k]!) / (rest.length > 0 ? 1 : total)
  if (rest.length > 0) {
    const left = tw * (1 - total)
    for (const k of rest) out[k] = 0
    spread(out, rest, init, left)
  }
  return out.map(roundTwips)
}

/** 按 `weights` 的比例把 `amount` 分到 `cols` 各列（权重之和为 0 时平均分配）。 */
function spread(
  values: number[],
  cols: readonly number[],
  weights: readonly number[],
  amount: number,
): void {
  const total = cols.reduce((a, k) => a + weights[k]!, 0)
  for (const k of cols)
    values[k] = values[k]! + amount * (total > EPSILON ? weights[k]! / total : 1 / cols.length)
}

/** 各网格列的宽度（见文件头）。`columns` 为网格列数，`region` 为区域宽度。 */
export function autofitColumns(
  t: TableBlock,
  columns: number,
  region: number,
  cx: TableContext,
): number[] {
  const min: number[] = Array.from({ length: columns }, () => 0)
  const init: number[] = Array.from({ length: columns }, () => 0)
  const pref: (number | null)[] = Array.from({ length: columns }, () => null)
  const shares: (number | null)[] = Array.from({ length: columns }, () => null)
  const covered: boolean[] = Array.from({ length: columns }, () => false)
  const spans: { col: number; span: number; cell: TableCell; min: number; max: number }[] = []
  for (const row of t.rows) {
    let c = row.gridBefore
    for (const cell of row.cells) {
      const span = Math.min(Math.max(1, cell.span), columns - c)
      if (span <= 0) break
      if (cell.vMerge !== 'continue') {
        const w = cellWidths(cell, cx)
        if (span > 1) spans.push({ col: c, span, cell, ...w })
        else {
          covered[c] = true
          min[c] = Math.max(min[c]!, w.min)
          const p = share(cell)
          if (p !== null) shares[c] = Math.max(shares[c] ?? 0, p)
          const v = preferred(cell)
          if (v === null) init[c] = Math.max(init[c]!, w.max)
          else {
            if (pref[c] === null) init[c] = 0
            pref[c] = Math.max(pref[c] ?? 0, v)
          }
        }
      }
      c += span
    }
  }
  for (let c = 0; c < columns; c++) {
    if (!covered[c]) init[c] = t.grid[c] ?? 0
    init[c] = Math.max(init[c]!, pref[c] ?? 0, min[c]!)
  }
  for (const s of spans) {
    const cols = Array.from({ length: s.span }, (_, k) => s.col + k)
    const sum = cols.reduce((a, k) => a + init[k]!, 0)
    if (s.min > sum + EPSILON) {
      const weights = init.map((v, k) => v + min[k]!)
      const scale = s.min / cols.reduce((a, k) => a + weights[k]!, 0)
      for (const k of cols) {
        init[k] = roundTwips(weights[k]! * scale)
        min[k] = Math.max(min[k]!, init[k]!)
      }
    }
    const want = Math.max(preferred(s.cell) ?? s.max, s.min)
    const spanned = cols.reduce((a, k) => a + init[k]!, 0)
    if (want > spanned + EPSILON) {
      spread(init, cols, init, want - spanned)
      for (const k of cols) init[k] = roundTwips(init[k]!)
    }
    const floor = cols.reduce((a, k) => a + min[k]!, 0)
    if (s.min > floor + EPSILON) {
      spread(min, cols, init, s.min - floor)
      for (const k of cols) min[k] = Math.min(min[k]!, init[k]!)
    }
  }

  const all = Array.from({ length: columns }, (_, k) => k)
  const autos = all.filter((k) => pref[k] === null)
  const fixed = all.filter((k) => pref[k] !== null)
  const sumInit = init.reduce((a, v) => a + v, 0)
  const sumMin = min.reduce((a, v) => a + v, 0)
  const base =
    cx.compatibilityMode >= 15
      ? region - (borderSpace(t.borders.left) + borderSpace(t.borders.right)) / 2
      : region + t.margins.left + t.margins.right
  const tw = t.width
  const given =
    tw !== null && tw.type === 'dxa' && tw.value > 0
      ? tw.value
      : tw !== null && tw.type === 'pct' && tw.value > 0
        ? tw.value * base
        : null
  const avail = base - (t.align === 'left' ? t.indent : 0)
  if (shares.some((p) => p !== null)) {
    const widths = percentColumns(init, shares, given, avail)
    if (widths !== null) return widths
  }
  const target = Math.max(given ?? Math.min(sumInit, avail), sumMin)

  const out = init.slice()
  if (sumInit > target + EPSILON) {
    let need = sumInit - target
    for (const group of [autos, fixed]) {
      const room = group.reduce((a, k) => a + out[k]! - min[k]!, 0)
      if (room <= EPSILON) continue
      const f = Math.min(1, need / room)
      for (const k of group) out[k] = out[k]! - (out[k]! - min[k]!) * f
      need -= room * f
      if (need <= EPSILON) break
    }
  } else if (sumInit < target - EPSILON) {
    spread(out, autos.length > 0 ? autos : all, init, target - sumInit)
  }
  return out.map(roundTwips)
}
