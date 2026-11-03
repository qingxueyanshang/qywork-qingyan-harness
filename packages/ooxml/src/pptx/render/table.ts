/**
 * 表格：行高列宽、单元格填充与边框、单元格文字与合并。坐标为表格局部坐标（96 dpi 像素，原点为表格左上角）。
 *
 * - 列宽取 `gridCol`；行高取 `tr/@h` 与该行单元格文字所需高度（文字高度加上下边距）中的较大者。
 *   跨行单元格所需高度超出所跨各行之和时，差额加到所跨的最后一行。
 * - 被合并的单元格（`hMerge`、`vMerge`）不绘制；合并起点的单元格覆盖 `gridSpan × rowSpan` 的区域。
 * - 绘制顺序：表格背景、各单元格填充、各单元格文字、各单元格边框（上、下、左、右、两条对角线）。
 *   相邻单元格共用的边两侧的线相同时只画一次，不同时两侧各画一次。
 * - 边框的线宽按设备像素四舍五入（至少 1 个设备像素），不足 1 磅的边框另把不透明度乘以磅数；线的位置不取整。
 *   实测（WPS 演示导出图，2 × 2 表格四边同线宽，0.5–4.5 磅，边框在像素内的 4 种位置）：内部竖线与横线的覆盖量
 *   0.5 磅为 0.5 像素、0.75 磅为 0.75 像素、1 磅（1.33 像素）为 1 像素、2 磅（2.67 像素）为 3 像素，与只画一次相同。
 *   不要把取整移到形状共用的 `lineWidth`：语料中形状的虚线曲线取整后线段变短变细（精创第 2 页下降 0.0049）。
 * - `vert`、`eaVert`、`vert270` 的单元格文字按旋转绘制（`eaVert` 的东亚文字直立）；其他竖排方式不绘制（计入 `verticalText`）。
 */

import type { Line } from '../../drawingml/fill.ts'
import type { ShapePath } from '../../drawingml/geometry/path.ts'
import {
  type Matrix,
  multiply,
  type PaintContext,
  rotation,
  scaling,
  setMatrix,
  translation,
} from '../../drawingml/paint/context.ts'
import {
  deviceScale,
  type PaintResources,
  paintFill,
  traceRect,
} from '../../drawingml/paint/fill.ts'
import { paintLine } from '../../drawingml/paint/line.ts'
import {
  type BodyLayout,
  layoutBody,
  paintBody,
  type TextSettings,
} from '../../drawingml/text/body.ts'
import type { Table, TableCell } from '../model.ts'

const EMU_PER_PX = 9525
const EMU_PER_PT = 12700
const PX_PER_PT = 4 / 3
/** 按旋转绘制的文字方向；其余竖排方式不绘制。 */
const ROTATED = new Set(['vert', 'vert270', 'eaVert'])

export interface CellLayout {
  readonly cell: TableCell
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** 竖排方式不绘制时为 `null`。 */
  readonly body: BodyLayout | null
}

export interface TableLayout {
  /** 各列左边与最后一列右边的横坐标。 */
  readonly columns: readonly number[]
  /** 各行上边与最后一行下边的纵坐标。 */
  readonly rows: readonly number[]
  readonly cells: readonly CellLayout[]
}

/** 单元格文字区域的宽度（磅）：竖排时为单元格内容区的高度。 */
function textWidth(cell: TableCell, width: number, height: number): number {
  const w = width - (cell.marginLeft + cell.marginRight) / EMU_PER_PX
  const h = height - (cell.marginTop + cell.marginBottom) / EMU_PER_PX
  return (cell.vertical === 'horz' ? w : h) / PX_PER_PT
}

export function layoutTable(table: Table, settings: TextSettings): TableLayout {
  const colX = [0]
  for (const w of table.columns) colX.push(colX.at(-1)! + w / EMU_PER_PX)
  const heights = table.rows.map((r) => r.height / EMU_PER_PX)
  const spanWidth = (c: number, span: number) =>
    colX[Math.min(colX.length - 1, c + span)]! - colX[Math.min(colX.length - 1, c)]!

  const bodies = new Map<TableCell, BodyLayout>()
  const needs: { r: number; span: number; need: number }[] = []
  table.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell.hMerge || cell.vMerge) return
      const width = spanWidth(c, Math.max(1, cell.gridSpan))
      // 竖排单元格的文字宽度取决于行高，行高确定后再排版，且不参与行高。
      if (cell.vertical !== 'horz') return
      const body = layoutBody(cell.text, textWidth(cell, width, 0), settings)
      bodies.set(cell, body)
      const need = body.height * PX_PER_PT + (cell.marginTop + cell.marginBottom) / EMU_PER_PX
      needs.push({ r, span: Math.max(1, cell.rowSpan), need })
    })
  })
  for (const n of needs) if (n.span === 1) heights[n.r] = Math.max(heights[n.r]!, n.need)
  for (const n of needs) {
    if (n.span === 1) continue
    const last = Math.min(heights.length, n.r + n.span) - 1
    let sum = 0
    for (let i = n.r; i <= last; i++) sum += heights[i]!
    if (n.need > sum) heights[last] = heights[last]! + n.need - sum
  }
  const rowY = [0]
  for (const h of heights) rowY.push(rowY.at(-1)! + h)

  const cells: CellLayout[] = []
  table.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell.hMerge || cell.vMerge) return
      const x = colX[Math.min(colX.length - 1, c)]!
      const y = rowY[r]!
      const width = spanWidth(c, Math.max(1, cell.gridSpan))
      const height = rowY[Math.min(rowY.length - 1, r + Math.max(1, cell.rowSpan))]! - y
      const body =
        cell.vertical === 'horz'
          ? (bodies.get(cell) ?? null)
          : ROTATED.has(cell.vertical)
            ? layoutBody(cell.text, textWidth(cell, width, height), settings)
            : null
      cells.push({ cell, x, y, width, height, body })
    })
  })
  return { columns: colX, rows: rowY, cells }
}

function edge(x0: number, y0: number, x1: number, y1: number): ShapePath[] {
  return [
    {
      fill: 'none',
      stroke: true,
      segments: [
        { kind: 'move', x: x0, y: y0 },
        { kind: 'line', x: x1, y: y1 },
      ],
    },
  ]
}

/** 单元格文字区域到设备坐标的变换（磅）与区域尺寸。 */
function cellTextFrame(
  layout: CellLayout,
  matrix: Matrix,
): { matrix: Matrix; width: number; height: number } {
  const cell = layout.cell
  const left = layout.x + cell.marginLeft / EMU_PER_PX
  const top = layout.y + cell.marginTop / EMU_PER_PX
  const w = layout.width - (cell.marginLeft + cell.marginRight) / EMU_PER_PX
  const h = layout.height - (cell.marginTop + cell.marginBottom) / EMU_PER_PX
  const vertical = cell.vertical !== 'horz'
  const aw = vertical ? h : w
  const ah = vertical ? w : h
  const angle =
    cell.vertical === 'vert' || cell.vertical === 'eaVert'
      ? Math.PI / 2
      : cell.vertical === 'vert270'
        ? -Math.PI / 2
        : 0
  const m = multiply(
    matrix,
    multiply(
      translation(left + w / 2, top + h / 2),
      multiply(
        rotation(angle),
        multiply(translation(-aw / 2, -ah / 2), scaling(PX_PER_PT, PX_PER_PT)),
      ),
    ),
  )
  return { matrix: m, width: aw / PX_PER_PT, height: ah / PX_PER_PT }
}

/** 绘制表格。`matrix` 为表格局部坐标到设备坐标；`scale` 为每个 96 dpi 像素对应的设备像素数。 */
export function paintTable(
  ctx: PaintContext,
  table: Table,
  layout: TableLayout,
  matrix: Matrix,
  scale: number,
  res: PaintResources,
  canvas: { width: number; height: number },
  settings: TextSettings,
): void {
  const width = layout.columns.at(-1) ?? 0
  const height = layout.rows.at(-1) ?? 0
  setMatrix(ctx, matrix)
  paintFill(ctx, () => traceRect(ctx, width, height), table.fill, { width, height, matrix }, res)
  for (const c of layout.cells) {
    const m = multiply(matrix, translation(c.x, c.y))
    setMatrix(ctx, m)
    paintFill(
      ctx,
      () => traceRect(ctx, c.width, c.height),
      c.cell.fill,
      { width: c.width, height: c.height, matrix: m },
      res,
    )
  }
  for (const c of layout.cells) {
    if (c.body === null) continue
    const frame = cellTextFrame(c, matrix)
    const free = frame.height - c.body.height
    const anchor = c.cell.anchor
    const dy = anchor === 'ctr' ? free / 2 : anchor === 'b' ? free : 0
    paintBody(
      ctx,
      c.body,
      { ...frame, matrix: multiply(frame.matrix, translation(0, dy)), scale },
      settings.faces,
      res,
      canvas,
      [],
    )
  }
  // 单元格文字的 ClearType 字形可以暂存（见 `TextClearType`）：边框画在其上。
  settings.faces.clearType?.flush()
  const borders: [Line | null, ShapePath[]][] = []
  for (const c of layout.cells) {
    const b = c.cell.borders
    const x1 = c.x + c.width
    const y1 = c.y + c.height
    borders.push(
      [b.top, edge(c.x, c.y, x1, c.y)],
      [b.bottom, edge(c.x, y1, x1, y1)],
      [b.left, edge(c.x, c.y, c.x, y1)],
      [b.right, edge(x1, c.y, x1, y1)],
      [b.diagonalDown, edge(c.x, c.y, x1, y1)],
      [b.diagonalUp, edge(c.x, y1, x1, c.y)],
    )
  }
  const drawn = new Set<string>()
  const device = deviceScale(matrix)
  for (const [line, paths] of borders) {
    if (line === null) continue
    const key = JSON.stringify([line, paths])
    if (drawn.has(key)) continue
    drawn.add(key)
    const px = Math.max(1, Math.round((line.width / EMU_PER_PX) * device)) / device
    ctx.save()
    if (line.width > 0) ctx.globalAlpha *= Math.min(1, line.width / EMU_PER_PT)
    paintLine(
      ctx,
      paths,
      { ...line, width: px * EMU_PER_PX },
      { width, height, matrix },
      res,
      canvas,
    )
    ctx.restore()
  }
}
