/**
 * 自动调整布局（`tblLayout` 不为 `fixed`）的列宽，WPS 12.1 实测（构造文档 w10a、w10b、w10e、w10k 与语料表格的变体 w10v1）。
 * 长度单位为磅，宽度均含单元格左右边距。网格（`tblGrid`）只用于没有单列单元格的列。
 *
 * - 单元格的最小与最大宽度：各段落最小与最大内容宽度（`ParagraphLayouter.contentWidths`）中的最大值，嵌套表格两者都取其网格
 *   宽度；`noWrap` 的单元格两者都取最大内容宽度；内容宽度不小于 0.3 磅（只有空段落的单元格为边距加 0.3 磅）。加左右边距后
 *   向上取整到 1/20 磅。
 * - 首选宽度：`tcW` 为 `dxa` 且大于 0 时给出；`auto`、`nil`、`pct` 与缺省都不给出。列中有首选宽度的单元格时为定宽列，取其中
 *   最大的首选宽度，否则为自动列。列的初值：定宽列为首选宽度与第一个给出首选宽度的单元格之后各自动单元格最大宽度中的较大者，
 *   该单元格之前的单元格不计入（自上而下为 auto 的 12 字与 dxa 的 100 磅时列宽 100 磅，次序相反时为 12 字宽）；给出首选宽度的
 *   单元格本身的最大宽度不计入（首选 50 磅、内容 52.8 磅的列宽 50 磅）。自动列为各单元格最大宽度中的最大值。都不小于最小宽度。
 * - 合并单元格（`gridSpan`）在各列初值求得之后计入：其首选宽度（没有时为最大宽度）或最小宽度大于所跨各列之和时，差额按各列
 *   初值的比例分到各列，取整到 1 缇。
 * - 表格宽度：`tblW` 为 `dxa` 时为其值，为 `pct` 时为该比例乘以基准宽度，否则为各列初值之和与可用宽度中的较小者；不小于各列
 *   最小宽度之和，`dxa` 大于区域宽度时不缩小。基准宽度：兼容模式 15 为区域宽度减表格左右框线（`tblBorders`，不含单元格自身
 *   的边框）的一半，低于 15 为区域宽度加表格左右边距；可用宽度为基准宽度减左对齐表格的左缩进（`pct` 的基准是否减左缩进未与 WPS 核对）。
 * - 各列初值之和大于表格宽度时先收窄自动列，各列的收窄量与其初值减最小宽度成正比；自动列都到最小宽度仍不够时，定宽列按同一
 *   规则收窄。小于表格宽度时差额只分给自动列，与其初值成正比；没有自动列时分给全部列。各列宽度取整到 1 缇。
 * - 未实现：`pct` 的 `tcW`（按自动处理）；合并单元格的不可断开内容宽于所跨各列时，WPS 的分配与按初值的比例不同。
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
    const want = Math.max(preferred(s.cell) ?? s.max, s.min)
    const sum = cols.reduce((a, k) => a + init[k]!, 0)
    if (want > sum + EPSILON) {
      spread(init, cols, init, want - sum)
      for (const k of cols) init[k] = roundTwips(init[k]!)
    }
    const floor = cols.reduce((a, k) => a + min[k]!, 0)
    if (s.min > floor + EPSILON) {
      spread(min, cols, init, s.min - floor)
      for (const k of cols) init[k] = Math.max(init[k]!, min[k]!)
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
  let target: number
  if (tw !== null && tw.type === 'dxa' && tw.value > 0) target = tw.value
  else if (tw !== null && tw.type === 'pct' && tw.value > 0) target = tw.value * base
  else target = Math.min(sumInit, base - (t.align === 'left' ? t.indent : 0))
  target = Math.max(target, sumMin)

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
