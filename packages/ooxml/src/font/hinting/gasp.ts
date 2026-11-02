/**
 * `gasp` 表：按 ppem 决定 ClearType 绘制是否执行指令（网格对齐）与是否在 y 方向平滑。单色绘制不读取本表，一律执行指令。
 * 规则为 GDI 实测（构造字体与本机字体的前进宽度、字形图像）：
 *
 * - 版本 1：`GASP_SYMMETRIC_GRIDFIT`（位 2）为 1 时执行指令；位 2 为 0 或 `GASP_SYMMETRIC_SMOOTHING`（位 3）为 1 时
 *   y 方向平滑。微软雅黑 ppem 8 以下的记录只有位 2，ClearType 的前进宽度与单色的提示结果相同；Arial ppem 8 以下的记录
 *   没有位 0、2，前进宽度为线性宽度取整；Arial ppem 9–17 的记录为位 0、2，不平滑，ppem 18 起另有位 3，平滑。
 * - 版本 0 的记录不影响 ClearType：一律执行指令并平滑。Arial Bold ppem 7–8 的记录只有 `GASP_DOGRAY`，ClearType 的
 *   前进宽度仍与单色的提示结果相同；楷体各字号的字形均为平滑的图像。
 * - 没有 `gasp` 表时执行指令并平滑；ppem 超出最后一条记录时按最后一条记录。
 */

import { FontFormatError, type SfntFace, tableBytes } from '../sfnt.ts'

const SYMMETRIC_GRIDFIT = 0x0004
const SYMMETRIC_SMOOTHING = 0x0008

/** ClearType 绘制在某一 ppem 下的方式。 */
export interface ClearTypeRange {
  /** 执行指令。 */
  readonly gridFit: boolean
  /** y 方向平滑（每像素纵向取样多次）。 */
  readonly smoothY: boolean
}

const DEFAULT_RANGE: ClearTypeRange = { gridFit: true, smoothY: true }

/** 返回按 ppem 取 ClearType 绘制方式的函数。表结构不完整时抛出 `FontFormatError`。 */
export function readClearTypeRanges(
  bytes: Uint8Array,
  face: SfntFace,
): (ppem: number) => ClearTypeRange {
  if (!face.tables.has('gasp')) return () => DEFAULT_RANGE
  const t = tableBytes(bytes, face, 'gasp')
  if (t.byteLength < 4) throw new FontFormatError('gasp 表长度不足')
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength)
  const version = v.getUint16(0)
  const count = v.getUint16(2)
  if (t.byteLength < 4 + 4 * count) throw new FontFormatError('gasp 记录超出表范围')
  const ranges: [max: number, range: ClearTypeRange][] = []
  for (let i = 0; i < count; i++) {
    const flags = v.getUint16(6 + 4 * i)
    const range: ClearTypeRange =
      version >= 1
        ? {
            gridFit: (flags & SYMMETRIC_GRIDFIT) !== 0,
            smoothY: (flags & SYMMETRIC_GRIDFIT) === 0 || (flags & SYMMETRIC_SMOOTHING) !== 0,
          }
        : DEFAULT_RANGE
    ranges.push([v.getUint16(4 + 4 * i), range])
  }
  return (ppem) => {
    for (const [max, range] of ranges) if (ppem <= max) return range
    return ranges.at(-1)?.[1] ?? DEFAULT_RANGE
  }
}
