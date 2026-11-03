/**
 * 表格排版：列宽、表格位置、单元格内容、边框与行高。长度单位为磅，坐标相对表格所在区域（栏、单元格或文本框的文字区）
 * 的左边与表格顶边。规则均为 WPS 12.1 实测结果。
 *
 * - 列宽：固定布局取网格（`tblGrid`），不看 `tcW` 与 `tblW`；自动调整布局按内容与首选宽度求得（`autofit.ts`）。
 * - 横向位置：兼容模式低于 15 时，左对齐的表格文字与区域左边加 `tblInd` 对齐（单元格左边在其左侧一个左边距处），
 *   右对齐时文字右端与区域右边对齐；兼容模式 15 时左对齐的单元格左边在 `tblInd` 加左框线一半处，右对齐时单元格右边
 *   在区域右边减右框线一半处。框线取表格的 `tblBorders`，不看单元格自身的边框（WPS 实测，构造文档 w10g：表格没有左框线、
 *   第一列单元格左边框 3 磅时单元格左边与区域左边对齐）。居中时按列宽之和居中，与兼容模式无关。
 *   浮动表格（`tblpPr`）的横向位置由调用方按基准加 `tblpX` 另行给出（`page/build.ts`），不看对齐方式；`text` 基准为栏。
 *   兼容模式 15 时单元格左边在该处，不看 `tblInd` 与框线；低于 15 时文字在该处加 `tblInd` 处（WPS 实测，构造文档 w11b）。
 * - 行高：行顶边框计入本行：各列取本行单元格自身的上边框（未给出时为表格的内框线或上框线）与上一行单元格的下边框
 *   减去本行单元格上边距中的较大者，再取各列的最大值。即上一行的下边框与本行的上边距重叠，本行的上边框与上边距相加
 *   （WPS 实测：上边距 5 磅时，上一行 1.5 磅的下边框不使内容下移，本行 1.5 磅的上边框或内框线使内容下移 1.5 磅；
 *   上边距 1 磅时上一行 1.25 磅的下边框使内容下移 0.25 磅）。绘制的线仍按相邻单元格的取舍。自动行高为边框加单元格上下边距与内容；最小行高（`atLeast`）的
 *   设定值不含单元格上下边距，行高为边框加上下边距加内容与设定值中的较大者；固定行高（`exact`）的设定值含边框与上边距、
 *   不含下边距，行高为设定值加下边距（WPS 实测：上下边距各 5 磅、内容 13.6 磅时，最小值 30 磅的行高 40 磅，固定值 30 磅
 *   的行高 35 磅；只有上边距 5 磅时固定值 30 磅的行高 30 磅，只有下边距 5 磅时 35 磅）。表格底边框在最后一行之后另占高度。
 *   纵向合并的单元格内容高于所跨各行时，最后一行加高。
 * - 跨页处的边框：续页部分的第一行（不含重复的标题行）顶边按表格的第一行求取（单元格的上边框，未给出时为表格的上框线）；
 *   未以最后一行结束的页面部分，底边按表格的最后一行求取。从续页开头放置的整行占用该顶边的高度而不是本行的行顶边框，
 *   切开的行在续页的部分仍占用本行的行顶边框（WPS 实测：上下框线 1.5 磅、内框横线 0.5 磅或无的表格跨页时，续页顶部与本页
 *   底部都绘制 1.5 磅的框线；续页第一行为整行时内容下移 1.5 磅，为切开的行时下移 0.5 磅）。
 * - 边框占用的高度：各条线与间距之和（`../border.ts`）。
 * - 相邻单元格边框冲突：各边取单元格明确给出的边框，未给出时取表格的外框或内框；两侧都有边框时取较宽者，宽度相同时
 *   取上方或左侧单元格的边框。一侧为无边框时另一侧须胜过表格虚框（0.5 磅、#c8c8c8）：线宽大于 0.5 磅，或等于 0.5 磅
 *   且亮度（R + B + 2G）不高于虚框，否则该边为无边框（WPS 实测，构造文档 w11j、w11k：0.25 磅与 0.375 磅的线、
 *   0.5 磅的 #d0d0d0 与 #e7e7e7 不绘制，0.5 磅的 #c8c8c8、#ffff00 与 0.75 磅的 #e7e7e7 绘制；竖边相同）。
 *   表格外沿没有另一侧，边框照常绘制。
 * - 单元格内容：第一段的段前间距与最后一段的段后间距都计入；段落之间取上段段后与下段段前的较大者，段落边框占用的高度
 *   另加（`ParagraphLayout.borderTop`、`borderBottom`）。
 */

import { borderSpace } from '../border.ts'
import { contextSpacing, type ParagraphLayout, type ParagraphLayouter } from '../layout.ts'
import type { Block, Border, CellBorders, Paragraph, TableBlock, TableCell } from '../model.ts'
import { autofitColumns } from './autofit.ts'

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
  /** 本行整行位于续页部分开头时顶边框占用的高度（`TableLayout.pageTop`）。 */
  readonly pageBorder: number
  /** 本行整行紧接在续页重复的标题行之后时顶边框占用的高度（`TableLayout.afterHeader`）。 */
  readonly headerBorder: number
  /** 本行为页面部分的最后一行时底边框占用的高度（`TableLayout.pageBottom`；最后一行即表格底边框）。 */
  readonly pageBottomBorder: number
  /** 不含行顶边框的最小高度：最小行高的设定值加单元格上下边距；其他行为 0。切开后续页的部分同样不小于此值。 */
  readonly minimum: number
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
  /** 第 `r` 行位于续页部分开头时的顶边、位于页面部分末尾时的底边（见文件头）：`[r][c]`，没有单元格处为 `undefined`。 */
  readonly pageTop: readonly (readonly (Border | null | undefined)[])[]
  readonly pageBottom: readonly (readonly (Border | null | undefined)[])[]
  /**
   * 第 `r` 行紧接在续页重复的标题行之后时的顶边：标题行最后一行的底边与本行顶边取舍，`[r][c]`（WPS 实测：标题行底边
   * 1.25 磅、数据行顶边为 nil 时续页绘制该线，其后各行下移 0.25 磅，与第一页标题行之下相同）。没有标题行时各行为空。
   */
  readonly afterHeader: readonly (readonly (Border | null | undefined)[])[]
}

export interface TableContext {
  readonly layouter: ParagraphLayouter
  readonly compatibilityMode: number
}

/** 在宽度为 `region` 的区域中排版一组块（单元格、文本框或页眉页脚的内容）。 */
export function layoutStack(blocks: readonly Block[], region: number, cx: TableContext): Stack {
  const items: StackItem[] = []
  let y = 0
  let prevAfter = 0
  blocks.forEach((b, i) => {
    if (b.kind === 'paragraph') {
      const sp = contextSpacing(blocks, i)
      const layout = cx.layouter.layout(b, i, region, sp)
      const space = (i === 0 ? sp.before : Math.max(prevAfter, sp.before)) + layout.borderTop
      y += space
      items.push({ kind: 'paragraph', block: i, paragraph: b, layout, top: y, space })
      y += layout.text.height + layout.borderBottom
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

/**
 * 第 `r` 行第 `c` 列的行顶边框占用的高度（见文件头）：本行单元格的上边框，与上一行单元格的下边框减去本行上边距中的较大者；
 * `edge` 为单元格某一边未经相邻取舍的边框，`continued` 为第 `r` 行该列纵向合并的后续单元格（`vMerge` 为 `continue`）。
 * 纵向合并的单元格内部同样按此计算，本行一侧取后续单元格自身的上边框（WPS 实测，构造文档 w10m：合并单元格内部
 * 只有起始单元格 3 磅的下边框或只有后续单元格 3 磅的上边框时，相邻一列的下一行都下移 3 磅；两者都没有时不下移）；
 * 不绘制。本行该列没有单元格时取上一行单元格的下边框。
 */
function rowTopSpace(
  grid: readonly (readonly (Slot | null)[])[],
  r: number,
  c: number,
  edge: (
    slot: Slot | null,
    key: 'top' | 'bottom',
    r: number,
    c: number,
  ) => Border | null | undefined,
  continued: { readonly top: Border | null; readonly margin: number } | null,
  upper = r - 1,
): number {
  const below = grid[r]?.[c] ?? null
  const above = upper >= 0 ? (grid[upper]?.[c] ?? null) : null
  if (below === null && above === null) return 0
  if (below === above) {
    if (continued === null) return 0
    const own = borderSpace(continued.top)
    return Math.max(own, borderSpace(edge(above, 'bottom', r - 1, c)) - continued.margin)
  }
  if (below === null) return borderSpace(edge(above, 'bottom', upper, c))
  const own = borderSpace(edge(below, 'top', r, c))
  if (above === null) return own
  return Math.max(own, borderSpace(edge(above, 'bottom', upper, c)) - below.cell.margins.top)
}

/** 两侧边框的取舍（见文件头）。`undefined` 为该侧没有单元格。 */
function resolveEdge(a: Border | null | undefined, b: Border | null | undefined): Border | null {
  if (a === undefined) return b ?? null
  if (b === undefined) return a
  if (a === null) return b !== null && beatsGridline(b) ? b : null
  if (b === null) return beatsGridline(a) ? a : null
  return borderSpace(b) > borderSpace(a) ? b : a
}

/** 表格虚框作为无边框一侧的边框参与取舍：0.5 磅，亮度为 #c8c8c8 的亮度。 */
const GRIDLINE_WIDTH = 0.5
const GRIDLINE_BRIGHTNESS = brightness('#c8c8c8')

/** 亮度：R + B + 2G；自动颜色为黑色。 */
function brightness(color: string | null): number {
  if (color === null) return 0
  const v = Number.parseInt(color.slice(1), 16)
  return (v >> 16) + (v & 0xff) + 2 * ((v >> 8) & 0xff)
}

/** 边框胜过表格虚框：线宽更大，或线宽相同且亮度不高于虚框。 */
function beatsGridline(b: Border): boolean {
  if (b.width !== GRIDLINE_WIDTH) return b.width > GRIDLINE_WIDTH
  return brightness(b.color) <= GRIDLINE_BRIGHTNESS
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
  const grid = occupancy(t, columnsCount)
  /** 第 `r` 行覆盖第 `c` 列的纵向合并后续单元格的上边框（未给出时为表格的内框横线）与上边距；没有时为 `null`。 */
  const continuedAt = (r: number, c: number) => {
    const row = t.rows[r]
    if (row === undefined) return null
    let col = row.gridBefore
    for (const cell of row.cells) {
      const span = Math.max(1, cell.span)
      if (c >= col && c < col + span)
        return cell.vMerge === 'continue'
          ? { top: side(cell.borders, 'top', t.borders.insideH), margin: cell.margins.top }
          : null
      col += span
    }
    return null
  }
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
  let headerRows = 0
  while (headerRows <= lastRow && t.rows[headerRows]!.header) headerRows++
  const lastHeader = headerRows - 1
  const afterHeader: (Border | null | undefined)[][] = []
  for (let r = 0; r <= lastRow; r++) {
    const line: (Border | null | undefined)[] = []
    for (let c = 0; c < columnsCount && headerRows > 0 && r > lastHeader; c++) {
      const above = grid[lastHeader]?.[c] ?? null
      const below = grid[r]?.[c] ?? null
      line.push(
        (above === null && below === null) || above === below
          ? undefined
          : resolveEdge(edge(above, 'bottom', lastHeader, c), edge(below, 'top', r, c)),
      )
    }
    afterHeader.push(line)
  }
  const pageTop: (Border | null | undefined)[][] = []
  const pageBottom: (Border | null | undefined)[][] = []
  for (let r = 0; r <= lastRow; r++) {
    const slots = grid[r] ?? []
    pageTop.push(slots.map((s) => (s === null ? undefined : side(s.cell.borders, 'top', tb.top))))
    pageBottom.push(
      slots.map((s) => (s === null ? undefined : side(s.cell.borders, 'bottom', tb.bottom))),
    )
  }

  const widths =
    t.layout === 'autofit'
      ? autofitColumns(t, columnsCount, region, cx)
      : Array.from({ length: columnsCount }, (_, c) => t.grid[c] ?? 0)
  const columns: number[] = [0]
  for (const w of widths) columns.push(columns[columns.length - 1]! + w)
  const width = columns[columnsCount]!

  // 横向位置。
  const leftBorder = borderSpace(tb.left)
  const rightBorder = borderSpace(tb.right)
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
    let pageBorder = 0
    let headerBorder = 0
    let pageBottomBorder = 0
    for (let c = 0; c < columnsCount; c++) {
      border = Math.max(border, rowTopSpace(grid, r, c, edge, continuedAt(r, c)))
      pageBorder = Math.max(pageBorder, borderSpace(pageTop[r]?.[c]))
      if (r > lastHeader && headerRows > 0)
        headerBorder = Math.max(headerBorder, rowTopSpace(grid, r, c, edge, null, lastHeader))
      pageBottomBorder = Math.max(pageBottomBorder, borderSpace(pageBottom[r]?.[c]))
    }
    const cells: CellBox[] = []
    let need = 0
    let margins = 0
    let bottomMargin = 0
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
      margins = Math.max(margins, m.top + m.bottom)
      bottomMargin = Math.max(bottomMargin, m.bottom)
      const h = m.top + content.height + m.bottom
      if (rowSpan === 1) need = Math.max(need, h)
      else pendingMerged.push({ box, first: r, need: h })
    }
    const rule = row.height?.rule ?? 'auto'
    const value = row.height?.value ?? 0
    const minimum = rule === 'atLeast' ? value + margins : 0
    const height = rule === 'exact' ? value + bottomMargin : border + Math.max(minimum, need)
    const keepNext = row.cells.some((c) =>
      c.content.some((b) => b.kind === 'paragraph' && b.props.keepNext),
    )
    rows.push({
      height,
      border,
      pageBorder,
      headerBorder,
      pageBottomBorder,
      minimum,
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
  return {
    table: t,
    x,
    width,
    columns,
    rows,
    bottom,
    height,
    horizontal,
    vertical,
    pageTop,
    pageBottom,
    afterHeader,
  }
}

/** 单元格内容在所跨各行中的纵向偏移（`vAlign`）：`space` 为文字区高度。 */
export function alignOffset(cell: CellBox, space: number): number {
  const free = space - cell.content.height
  if (free <= 0) return 0
  return cell.cell.vAlign === 'center' ? free / 2 : cell.cell.vAlign === 'bottom' ? free : 0
}
