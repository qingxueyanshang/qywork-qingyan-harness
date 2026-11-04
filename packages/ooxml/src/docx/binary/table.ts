/**
 * .doc 的表格：行结束段落中的表格属性（TAP）与由各行组成的表格。
 *
 * - 单元格的边界（缇）取 sprmTDefTable 的 `rgdxaCenter`，各单元格的格式取其后的 TC80（20 字节：标记、首选宽度、四边的 BRC80）；
 *   其后的 sprm 按单元格下标区间修改边框、底纹、边距、宽度、纵向合并与对齐。
 * - 网格为同一表格各行边界的并集；单元格跨越的网格列数与行首空出的列数由边界换算。横向合并的后续单元格（`fMerged`）
 *   并入其前的单元格。
 * - 单元格边距：sprmTCellPaddingDefault 与表格样式中的边距优先，都没有时左右取 `dxaGapHalf`。
 *   缩进按兼容模式 15 之前的规则（文字起点）换算：第一个单元格的左边界加左边距（`../table/layout.ts` 以缩进减左边距为表格左边）。
 * - TC80 的边框为 0 时该边沿用表格的边框，为全 1（nil）时为无边框。
 * - 单元格的文字方向（`textFlow`）与调整宽度（`fFitText`）由调用方计数。
 */

import type { TableWidth } from '../model.ts'
import type { RawBorder } from '../parse/properties.ts'
import type {
  RawCellProps,
  RawEdges,
  RawRowProps,
  RawTableBorders,
  RawTableProps,
} from '../parse/table.ts'
import { borderStyle, brc, brc80, colorRef, i16, type Sprm, shd, shd80, u16, u32 } from './sprm.ts'

export interface TapCell {
  /** 左右边界（缇）。 */
  left: number
  right: number
  props: RawCellProps
  /** 横向合并：本单元格并入其前的单元格。 */
  merged: boolean
  /** 文字方向不是横排，或设置了调整宽度。 */
  textFlow: boolean
  fitText: boolean
}

export interface Tap {
  readonly table: RawTableProps
  readonly row: RawRowProps
  readonly cells: TapCell[]
}

const TC_SIZE = 20

/** `ftsWidth` 与宽度：1 为自动，2 为五十分之一百分数，3 为缇，0 为未指定（`null`）。 */
function widthOf(fts: number, value: number): TableWidth | null {
  if (fts === 1) return { type: 'auto', value: 0 }
  if (fts === 2) return { type: 'pct', value: value / 5000 }
  if (fts === 3) return { type: 'dxa', value: value / 20 }
  return null
}

/** 四边的顺序：TC80 中的 BRC80 与 sprmTBrcTopCv 至 sprmTBrcRightCv（0xD61A–0xD61D）都按此顺序。 */
const SIDES = ['top', 'left', 'bottom', 'right'] as const

/** 按单元格下标区间修改：CSSA 与同类操作数的前两个字节为 `itcFirst`、`itcLim`。 */
function eachCell(cells: TapCell[], d: Uint8Array, fn: (c: TapCell) => void): void {
  const last = Math.min(cells.length, d[1] ?? 0)
  for (let i = d[0] ?? 0; i < last; i++) fn(cells[i]!)
}

/** CSSA 的边距：`grfbrc` 的位 1、2、4、8 依次为上、左、下、右；只取以缇给出的值。 */
function cssaEdges(d: Uint8Array, base: RawEdges | undefined): RawEdges {
  const out: RawEdges = { ...base }
  if (d[3] !== 3) return out
  const v = u16(d, 4) / 20
  SIDES.forEach((side, i) => {
    if ((d[2]! >> i) & 1) out[side] = v
  })
  return out
}

function tableBorders(d: Uint8Array, size: 4 | 8): RawTableBorders {
  const read = size === 4 ? brc80 : brc
  const at = (i: number) => read(d, i * size)
  return {
    top: at(0),
    left: at(1),
    bottom: at(2),
    right: at(3),
    insideH: at(4),
    insideV: at(5),
  }
}

/** TC80 中一边的边框：0 为沿用表格的边框（`undefined`）。 */
function cellBorder(d: Uint8Array, at: number): RawBorder | null | undefined {
  return u32(d, at) === 0 ? undefined : brc80(d, at)
}

function readTc(d: Uint8Array, at: number, left: number, right: number): TapCell {
  const props: RawCellProps = {}
  const flags = u16(d, at)
  if (flags & 0x20) props.vMerge = flags & 0x40 ? 'restart' : 'continue'
  const v = (flags >> 7) & 3
  if (v === 1) props.vAlign = 'center'
  else if (v === 2) props.vAlign = 'bottom'
  if (flags & 0x2000) props.noWrap = true
  props.width = widthOf((flags >> 9) & 7, u16(d, at + 2)) ?? {
    type: 'dxa',
    value: (right - left) / 20,
  }
  const borders: RawTableBorders = {}
  SIDES.forEach((side, i) => {
    const b = cellBorder(d, at + 4 + i * 4)
    if (b !== undefined) borders[side] = b
  })
  if (Object.keys(borders).length > 0) props.borders = borders
  return {
    left,
    right,
    props,
    merged: (flags & 0x02) !== 0,
    textFlow: (flags & 0x1c) !== 0,
    fitText: (flags & 0x1000) !== 0,
  }
}

/** 表格样式中的表格属性（UPX 的表格部分）：只取作用于整表的项。 */
export function applyTableStyle(sprms: readonly Sprm[]): RawTableProps {
  return readTap(sprms, {}).table
}

/** 一行的表格属性；`style` 为表格样式的表格属性（决定未给出的边距）。 */
export function readTap(sprms: readonly Sprm[], style: RawTableProps): Tap {
  // 没有 sprmTFAutofit 时为固定列宽：列宽取单元格边界。
  const table: RawTableProps = { layout: 'fixed' }
  const row: RawRowProps = {}
  let cells: TapCell[] = []
  let gapHalf: number | null = null
  let indent: number | null = null
  /** 浮动表格的定位：`set` 为出现过定位 sprm。 */
  const float = { set: false, horz: 0, vert: 2, x: 0, y: 0 }
  const shadeCells = (
    d: Uint8Array,
    first: number,
    size: number,
    read: (d: Uint8Array, at: number) => string | null,
  ) => {
    for (let i = 0; i * size + size <= d.length; i++) {
      const c = cells[first + i]
      if (c !== undefined) c.props.shading = read(d, i * size)
    }
  }
  for (const s of sprms) {
    const d = s.data
    switch (s.op) {
      case 0xd608: {
        const n = d[0] ?? 0
        const centers = Array.from({ length: n + 1 }, (_, i) => i16(d, 1 + i * 2))
        const tcAt = 1 + (n + 1) * 2
        cells = Array.from({ length: n }, (_, i) =>
          tcAt + (i + 1) * TC_SIZE <= d.length
            ? readTc(d, tcAt + i * TC_SIZE, centers[i]!, centers[i + 1]!)
            : {
                left: centers[i]!,
                right: centers[i + 1]!,
                props: { width: { type: 'dxa', value: (centers[i + 1]! - centers[i]!) / 20 } },
                merged: false,
                textFlow: false,
                fitText: false,
              },
        )
        break
      }
      case 0x9602: {
        const next = i16(d)
        if (gapHalf !== null && cells[0] !== undefined) cells[0].left += gapHalf - next
        gapHalf = next
        break
      }
      case 0x5400:
      case 0x548a: {
        const v = u16(d)
        table.align = v === 1 ? 'center' : v === 2 ? 'right' : 'left'
        break
      }
      case 0x3403:
      case 0x3466:
        row.cantSplit = d[0] !== 0
        break
      case 0x3404:
        row.header = d[0] !== 0
        break
      case 0x9407: {
        const h = i16(d)
        row.height = h === 0 ? null : { rule: h < 0 ? 'exact' : 'atLeast', value: Math.abs(h) / 20 }
        break
      }
      case 0xd605:
        table.borders = tableBorders(d, 4)
        break
      case 0xd613:
        table.borders = tableBorders(d, 8)
        break
      case 0xf614: {
        const w = widthOf(d[0]!, u16(d, 1))
        if (w !== null) table.width = w
        break
      }
      case 0x3615:
        table.layout = d[0] !== 0 ? 'autofit' : 'fixed'
        break
      case 0xd609:
        shadeCells(d, 0, 2, shd80)
        break
      case 0xd612:
      case 0xd670:
        shadeCells(d, 0, 10, shd)
        break
      case 0xd616:
      case 0xd671:
        shadeCells(d, 22, 10, shd)
        break
      case 0xd60c:
      case 0xd672:
        shadeCells(d, 44, 10, shd)
        break
      case 0xd620:
      case 0xd62f: {
        const b = s.op === 0xd620 ? brc80(d, 3) : brc(d, 3)
        eachCell(cells, d, (c) => {
          const borders = { ...c.props.borders }
          SIDES.forEach((side, i) => {
            if ((d[2]! >> i) & 1) borders[side] = b
          })
          c.props.borders = borders
        })
        break
      }
      case 0xd61a:
      case 0xd61b:
      case 0xd61c:
      case 0xd61d: {
        // 各单元格该边边框的 COLORREF：TC80 的边框颜色只是调色板中的近似色。
        const side = SIDES[s.op - 0xd61a]!
        cells.forEach((c, i) => {
          const b = c.props.borders?.[side]
          if (b != null && (i + 1) * 4 <= d.length)
            c.props.borders = { ...c.props.borders, [side]: { ...b, color: colorRef(d, i * 4) } }
        })
        break
      }
      case 0xd662:
        // 各单元格四边的边框类型：BRC80 不能表示的类型（如凸出、凹入）在 TC80 中是近似类型。
        cells.forEach((c, i) => {
          SIDES.forEach((side, k) => {
            const b = c.props.borders?.[side]
            const type = d[i * 4 + k]
            if (b == null || type === undefined) return
            const style = borderStyle(type)
            c.props.borders = {
              ...c.props.borders,
              [side]: style === null ? null : { ...b, style },
            }
          })
        })
        break
      case 0xd62b: {
        const c = cells[d[0] ?? -1]
        if (c === undefined) break
        if (d[1] === 0) delete c.props.vMerge
        else c.props.vMerge = d[1] === 3 ? 'restart' : 'continue'
        break
      }
      case 0xd62c: {
        const v = d[2]
        eachCell(cells, d, (c) => {
          c.props.vAlign = v === 1 ? 'center' : v === 2 ? 'bottom' : 'top'
        })
        break
      }
      case 0xd634:
        table.margins = cssaEdges(d, table.margins)
        break
      case 0xd632:
        eachCell(cells, d, (c) => {
          c.props.margins = cssaEdges(d, c.props.margins)
        })
        break
      case 0xd635: {
        const w = widthOf(d[2]!, u16(d, 3))
        if (w !== null)
          eachCell(cells, d, (c) => {
            c.props.width = w
          })
        break
      }
      case 0xd639:
        eachCell(cells, d, (c) => {
          c.props.noWrap = d[2] !== 0
        })
        break
      case 0xf661:
        if (d[0] === 3) indent = i16(d, 1)
        break
      case 0x563a:
        table.style = String(u16(d))
        break
      case 0x360d:
        float.set = true
        // 低 2 位为横向基准，其上 2 位为纵向基准；3 为不改变。
        if ((d[0]! & 3) !== 3) float.horz = d[0]! & 3
        if (((d[0]! >> 2) & 3) !== 3) float.vert = (d[0]! >> 2) & 3
        break
      case 0x940e:
        float.set = true
        float.x = i16(d)
        break
      case 0x940f:
        float.set = true
        float.y = i16(d)
        break
    }
  }
  if (table.margins === undefined && style.margins === undefined && gapHalf !== null)
    table.margins = { left: gapHalf / 20, right: gapHalf / 20 }
  const marginLeft = table.margins?.left ?? style.margins?.left ?? 0
  const first = cells[0]
  if (indent !== null) table.indent = indent / 20
  else if (first !== undefined) table.indent = first.left / 20 + marginLeft
  if (float.set) {
    const FROM = ['text', 'margin', 'page'] as const
    const VERTICAL = ['margin', 'page', 'text'] as const
    // 负的偏移是对齐方式的代码（居中、靠右等），按 0 处理。
    table.float = {
      from: FROM[float.horz] ?? 'text',
      x: Math.max(0, float.x) / 20,
      vertical: VERTICAL[float.vert] ?? 'text',
      y: Math.max(0, float.y) / 20,
    }
  }
  return { table, row, cells }
}
