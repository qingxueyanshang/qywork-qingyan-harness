/**
 * `kern` 表（Microsoft 格式，版本 0）的字偶调整值，字体单位。
 *
 * - 只读取横排、非最小值、非交叉方向的格式 0 子表，多个子表的值相加。
 * - 子表的 `length` 字段只有 16 位，字偶多的字体（Calibri、Cambria）超出后被截断：格式 0 子表的长度按字偶数计算，不读取该字段。
 * - 不读取 `GPOS` 的 `kern` 特性：WPS 文字只按 `kern` 表调整（实测 Georgia、等线只有 `GPOS` 字偶，开启字距调整后位置不变）。
 */

import { FontFormatError, type SfntFace, tableBytes } from '../sfnt.ts'

/** 字偶调整值（字体单位，负值为收紧）；没有该字偶时为 0。 */
export type GlyphKerning = (left: number, right: number) => number

const HORIZONTAL = 0x1
const MINIMUM = 0x2
const CROSS_STREAM = 0x4

/** `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。字体没有可用的子表时返回 `null`。 */
export function readKerning(bytes: Uint8Array, face: SfntFace): GlyphKerning | null {
  if (!face.tables.has('kern')) return null
  const t = tableBytes(bytes, face, 'kern')
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength)
  if (t.byteLength < 4 || v.getUint16(0) !== 0) return null
  const subtables: { at: number; count: number }[] = []
  let off = 4
  for (let i = v.getUint16(2); i > 0 && off + 6 <= t.byteLength; i--) {
    const length = v.getUint16(off + 2)
    const coverage = v.getUint16(off + 4)
    const format = coverage >> 8
    if (format === 0) {
      if (off + 14 > t.byteLength) throw new FontFormatError('kern 子表长度不足')
      const count = v.getUint16(off + 6)
      if (off + 14 + 6 * count > t.byteLength) throw new FontFormatError('kern 字偶超出表范围')
      if ((coverage & (HORIZONTAL | MINIMUM | CROSS_STREAM)) === HORIZONTAL)
        subtables.push({ at: off + 14, count })
      off += 14 + 6 * count
    } else {
      if (length < 6) throw new FontFormatError('kern 子表长度不正确')
      off += length
    }
  }
  if (subtables.length === 0) return null
  let pairs: Map<number, number> | null = null
  const load = (): Map<number, number> => {
    const out = new Map<number, number>()
    for (const { at, count } of subtables) {
      for (let k = 0; k < count; k++) {
        const p = at + 6 * k
        const key = v.getUint16(p) * 0x10000 + v.getUint16(p + 2)
        out.set(key, (out.get(key) ?? 0) + v.getInt16(p + 4))
      }
    }
    return out
  }
  return (left, right) => {
    pairs ??= load()
    return pairs.get(left * 0x10000 + right) ?? 0
  }
}
