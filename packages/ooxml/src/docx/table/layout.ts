/**
 * 表格排版：列宽、表格位置、单元格内容、边框与行高。长度单位为磅，坐标相对表格所在区域（栏、单元格或文本框的文字区）
 * 的左边与表格顶边。规则均为 WPS 12.1 实测结果。
 *
 * - 列宽取网格（`tblGrid`）；固定布局不看 `tcW` 与 `tblW`。自动调整布局中每列不小于其中单列单元格的最小内容宽度
 *   （最长的不可断开部分加左右边距，向上取整到 1/20 磅；`noWrap` 的单元格为整段宽度），`tblW` 为百分比时各列按比例缩放到该宽度
 *   （兼容模式低于 15 时为区域宽度加表格左右边距，15 时为区域宽度减左右边框的一半）。
 * - 横向位置：兼容模式低于 15 时，左对齐的表格文字与区域左边加 `tblInd` 对齐（单元格左边在其左侧一个左边距处），
 *   右对齐时文字右端与区域右边对齐；兼容模式 15 时左对齐的单元格左边在 `tblInd` 加左边框一半处，右对齐时单元格右边
 *   在区域右边减右边框一半处。居中时按网格宽度居中，与兼容模式无关。
 * - 行高：行顶边框（本行各列上边框中最宽者）计入本行；固定行高（`exact`）含该边框；最小行高（`atLeast`）与自动行高
 *   为边框加内容高度（单元格上下边距与内容）与最小值中的较大者。表格底边框在最后一行之后另占高度。
 *   纵向合并的单元格内容高于所跨各行时，最后一行加高。
 * - 边框占用的高度：双线为线宽的 3 倍，三线为 5 倍，其余为线宽。
 * - 相邻单元格边框冲突：各边取单元格明确给出的边框，未给出时取表格的外框或内框；两侧都有边框时取较宽者，宽度相同时
 *   取上方或左侧单元格的边框；一侧为无边框时取另一侧。
 * - 单元格内容：第一段的段前间距与最后一段的段后间距都计入；段落之间取上段段后与下段段前的较大者。
 */

import { contextSpacing, type ParagraphLayout, type ParagraphLayouter } from '../layout.ts'
import type { Block, Border, CellBorders, Paragraph, TableBlock, TableCell } from '../model.ts'

/** 单元格内容中的一项，`top` 相对单元格文字区顶边，`x` 相对文字区左边。 */
export type StackItem =
  | {
      readonly kind: 'paragraph'
      readonly block: number
      readonly paragraph: Paragraph
      readonly layout: ParagraphLayout
      readonly top: number
      /** 第一行之前的段前间距：段落顶边在 `top` 之上这么多。 */
      readonly space: number
    }
  | {
      readonly kind: 'table'
      readonly block: number
      readonly table: TableLayout
      readonly top: number
    }

export interface Stack {
  readonly items: readonly StackItem[]
  readonly height: number
}

export interface CellBox {
  readonly cell: TableCell
  /** 起始网格列与跨越的列数、行数。 */
  readonly col: number
  readonly span: number
  readonly rowSpan: number
  /** 单元格左边（相对表格左边）与宽度。 */
  readonly x: number
  readonly width: number
  readonly content: Stack
}

export interface RowBox {
  /** 行高，含行顶边框。 */
  readonly height: number
  /** 行顶边框占用的高度。 */
  readonly border: number
  readonly rule: 'auto' | 'atLeast' | 'exact'
  readonly header: boolean
  readonly cantSplit: boolean
  /** 行中有设置 `keepNext` 的段落：本行与下一行同页。 */
  readonly keepNext: boolean
  /** 自本行开始的单元格（纵向合并的后续单元格不在其中）。 */
  readonly cells: readonly CellBox[]
}

/** 一条边框线段：横线的 `y` 为线的上沿，竖线的 `x` 为线的中线。 */
export interface EdgeLine {
  readonly vertical: boolean
  readonly x: number
  readonly y: number
  readonly length: number
  /** `null` 为无边框（显示表格虚框）。 */
  readonly border: Border | null
}

export interface TableLayout {
  readonly table: TableBlock
  /** 表格左边（第一列单元格的左边）相对区域左边。 */
  readonly x: number
  readonly width: number
  /** 各网格列的左边，最后一项为表格右边（相对表格左边）。 */
  readonly columns: readonly number[]
  readonly rows: readonly RowBox[]
  /** 表格底边框占用的高度。 */
  readonly bottom: number
  readonly height: number
  /** 横向边框：`[r][c]` 为第 `r` 行上沿（`r` 等于行数时为表格底边）第 `c` 列的边框。 */
  readonly horizontal: readonly (readonly (Border | null | undefined)[])[]
  /** 纵向边框：`[r][c]` 为第 `r` 行第 `c` 列左边（`c` 等于列数时为表格右边）的边框；合并单元格内部为 `undefined`。 */
  readonly vertical: readonly (readonly (Border | null | undefined)[])[]
}

export interface TableContext {
  readonly layouter: ParagraphLayouter
  readonly compatibilityMode: number
}

/** 边框在排版中占用的宽度。 */
export function borderSpace(b: Border | null | undefined): number {
  if (b == null) return 0
  if (b.style === 'double') return b.width * 3
  if (b.style === 'triple') return b.width * 5
  return b.width
}

/** 在宽度为 `region` 的区域中排版一组块（单元格、文本框或页眉页脚的内容）。 */
export function layoutStack(blocks: readonly Block[], region: number, cx: TableContext): Stack {
  const items: StackItem[] = []
  let y = 0
  let prevAfter = 0
  blocks.forEach((b, i) => {
    if (b.kind === 'paragraph') {
      const sp = contextSpacing(blocks, i)
      const space = i === 0 ? sp.before : Math.max(prevAfter, sp.before)
      y += space
      const layout = cx.layouter.layout(b, i, region, sp)
      items.push({ kind: 'paragraph', block: i, paragraph: b, layout, top: y, space })
      y += layout.text.height
      prevAfter = sp.after
      return
    }
    y += prevAfter
    prevAfter = 0
    const table = layoutTable(b, region, cx)
    items.push({ kind: 'table', block: i, table, top: y })
    y += table.height
  })
  return { items, height: y + prevAfter }
}

/**
 * 向上取整到 1/20 磅。WPS 实测：最小内容宽度 172.9245 与 50.457 磅的列为 172.95 与 50.5 磅；不要改为四舍五入，
 * 那样得到 172.9 与 50.45。容差抵消浮点误差，使恰为 1/20 磅整数倍的值不进位。
 */
function ceilTwips(v: number): number {
  return Math.ceil(v * 20 - 1e-9) / 20
}

/** 单元格的最小内容宽度（不含边距）；嵌套表格取其宽度。 */
function minContent(cell: TableCell, cx: TableContext): number {
  let w = 0
  for (const b of cell.content) {
    if (b.kind === 'paragraph') w = Math.max(w, cx.layouter.contentWidth(b, cell.noWrap))
    else
      w = Math.max(
        w,
        b.grid.reduce((a, g) => a + g, 0),
      )
  }
  return w
}

interface Slot {
  readonly cell: TableCell
  readonly row: number
  readonly index: number
  readonly col: number
  readonly span: number
}

/** 网格占用：`[r][c]` 为占用该格的单元格（纵向合并中起始行以下的各行指向起始单元格），没有单元格时为 `null`。 */
function occupancy(t: TableBlock, columns: number): (Slot | null)[][] {
  const grid: (Slot | null)[][] = []
  t.rows.forEach((row, r) => {
    const line: (Slot | null)[] = Array.from({ length: columns }, () => null)
    let c = row.gridBefore
    row.cells.forEach((cell, index) => {
      const span = Math.max(1, cell.span)
      let slot: Slot = { cell, row: r, index, col: c, span }
      if (cell.vMerge === 'continue') {
        const above = grid[r - 1]?.[c]
        if (above != null && above.col === c) slot = above
      }
      for (let k = 0; k < span && c + k < columns; k++) line[c + k] = slot
      c += span
    })
    grid.push(line)
  })
  return grid
}

/** 两侧边框的取舍（见文件头）。`undefined` 为该侧没有单元格。 */
function resolveEdge(a: Border | null | undefined, b: Border | null | undefined): Border | null {
  if (a == null) return b ?? null
  if (b == null) return a
  return borderSpace(b) > borderSpace(a) ? b : a
}

function side(
  borders: CellBorders,
  key: 'top' | 'left' | 'bottom' | 'right',
  fallback: Border | null,
): Border | null {
  const own = borders[key]
  return own === undefined ? fallback : own
}

export function layoutTable(t: TableBlock, region: number, cx: TableContext): TableLayout {
  const n = t.grid.length
  const columnsCount = Math.max(
    n,
    ...t.rows.map((r) => r.gridBefore + r.cells.reduce((a, c) => a + Math.max(1, c.span), 0)),
  )
  const widths = Array.from({ length: columnsCount }, (_, c) => t.grid[c] ?? 0)
  const grid = occupancy(t, columnsCount)
  const tb = t.borders
  const c15 = cx.compatibilityMode >= 15
  const lastRow = t.rows.length - 1

  // 边框：先求每格各边的取值，再对相邻两格取舍。
  const edge = (
    slot: Slot | null,
    key: 'top' | 'left' | 'bottom' | 'right',
    r: number,
    c: number,
  ) => {
    if (slot === null) return undefined
    const outer =
      key === 'top'
        ? r === 0
        : key === 'bottom'
          ? r === lastRow
          : key === 'left'
            ? c === 0 || grid[r]?.[c - 1] === null
            : c === columnsCount - 1 || grid[r]?.[c + 1] === null
    const fallback =
      key === 'top' || key === 'bottom'
        ? outer
          ? tb[key]
          : tb.insideH
        : outer
          ? tb[key]
          : tb.insideV
    return side(slot.cell.borders, key, fallback)
  }
  const horizontal: (Border | null | undefined)[][] = []
  for (let r = 0; r <= t.rows.length; r++) {
    const line: (Border | null | undefined)[] = []
    for (let c = 0; c < columnsCount; c++) {
      const above = r > 0 ? (grid[r - 1]?.[c] ?? null) : null
      const below = r <= lastRow ? (grid[r]?.[c] ?? null) : null
      if (above !== null && above === below) {
        line.push(undefined)
        continue
      }
      line.push(
        above === null && below === null
          ? undefined
          : resolveEdge(edge(above, 'bottom', r - 1, c), edge(below, 'top', r, c)),
      )
    }
    horizontal.push(line)
  }
  const vertical: (Border | null | undefined)[][] = []
  for (let r = 0; r <= lastRow; r++) {
    const line: (Border | null | undefined)[] = []
    for (let c = 0; c <= columnsCount; c++) {
      const left = c > 0 ? (grid[r]?.[c - 1] ?? null) : null
      const right = c < columnsCount ? (grid[r]?.[c] ?? null) : null
      if (left !== null && left === right) {
        line.push(undefined)
        continue
      }
      line.push(
        left === null && right === null
          ? undefined
          : resolveEdge(edge(left, 'right', r, c - 1), edge(right, 'left', r, c)),
      )
    }
    vertical.push(line)
  }

  // 列宽。
  if (t.layout === 'autofit') {
    t.rows.forEach((_, r) => {
      for (const slot of grid[r] ?? []) {
        if (slot === null || slot.row !== r || slot.span !== 1 || slot.cell.vMerge === 'continue')
          continue
        const m = slot.cell.margins
        const need = ceilTwips(minContent(slot.cell, cx) + m.left + m.right)
        if (need > widths[slot.col]!) widths[slot.col] = need
      }
    })
    if (t.width?.type === 'pct' && t.width.value > 0) {
      const lb = borderSpace(vertical[0]?.[0])
      const rb = borderSpace(vertical[0]?.[columnsCount])
      const target = c15
        ? region * t.width.value - (lb + rb) / 2
        : region * t.width.value + t.margins.left + t.margins.right
      const sum = widths.reduce((a, w) => a + w, 0)
      if (sum > 0) for (let c = 0; c < columnsCount; c++) widths[c] = (widths[c]! * target) / sum
    }
  }
  const columns: number[] = [0]
  for (const w of widths) columns.push(columns[columns.length - 1]! + w)
  const width = columns[columnsCount]!

  // 横向位置。
  const leftBorder = borderSpace(vertical[0]?.[t.rows[0]?.gridBefore ?? 0])
  const rightBorder = borderSpace(vertical[0]?.[columnsCount])
  let x: number
  if (t.align === 'center') x = (region - width) / 2
  else if (t.align === 'right')
    x = c15 ? region - width - rightBorder / 2 : region - width + t.margins.right
  else x = c15 ? t.indent + leftBorder / 2 : t.indent - t.margins.left

  // 单元格内容与行高。
  const rows: RowBox[] = []
  const pendingMerged: { box: CellBox; first: number; need: number }[] = []
  t.rows.forEach((row, r) => {
    let border = 0
    for (let c = 0; c < columnsCount; c++)
      border = Math.max(border, borderSpace(horizontal[r]?.[c]))
    const cells: CellBox[] = []
    let need = 0
    for (const slot of grid[r] ?? []) {
      if (slot === null || slot.row !== r || cells.some((b) => b.cell === slot.cell)) continue
      let rowSpan = 1
      while (grid[r + rowSpan]?.[slot.col] === slot) rowSpan++
      const cw = columns[Math.min(columnsCount, slot.col + slot.span)]! - columns[slot.col]!
      const m = slot.cell.margins
      const content = layoutStack(slot.cell.content, Math.max(0, cw - m.left - m.right), cx)
      const box: CellBox = {
        cell: slot.cell,
        col: slot.col,
        span: slot.span,
        rowSpan,
        x: columns[slot.col]!,
        width: cw,
        content,
      }
      cells.push(box)
      const h = m.top + content.height + m.bottom
      if (rowSpan === 1) need = Math.max(need, h)
      else pendingMerged.push({ box, first: r, need: h })
    }
    const rule = row.height?.rule ?? 'auto'
    const value = row.height?.value ?? 0
    const height =
      rule === 'exact' ? value : border + Math.max(rule === 'atLeast' ? value : 0, need)
    const keepNext = row.cells.some((c) =>
      c.content.some((b) => b.kind === 'paragraph' && b.props.keepNext),
    )
    rows.push({
      height,
      border,
      rule,
      header: row.header,
      cantSplit: row.cantSplit,
      keepNext,
      cells,
    })
  })
  for (const m of pendingMerged) {
    const lastIndex = m.first + m.box.rowSpan - 1
    let available = -rows[m.first]!.border
    for (let r = m.first; r <= lastIndex; r++) available += rows[r]!.height
    const last = rows[lastIndex]!
    if (m.need > available && last.rule !== 'exact')
      rows[lastIndex] = { ...last, height: last.height + m.need - available }
  }
  let bottom = 0
  for (let c = 0; c < columnsCount; c++)
    bottom = Math.max(bottom, borderSpace(horizontal[t.rows.length]?.[c]))
  const height = rows.reduce((a, row) => a + row.height, 0) + bottom
  return { table: t, x, width, columns, rows, bottom, height, horizontal, vertical }
}

/** 单元格内容在所跨各行中的纵向偏移（`vAlign`）：`space` 为文字区高度。 */
export function alignOffset(cell: CellBox, space: number): number {
  const free = space - cell.content.height
  if (free <= 0) return 0
  return cell.cell.vAlign === 'center' ? free / 2 : cell.cell.vAlign === 'bottom' ? free : 0
}
