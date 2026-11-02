/**
 * OpenType Coverage 表（`GSUB`、`GPOS`、`MATH` 共用）：字形编号 → 覆盖序号。
 */

import { FontFormatError } from '../sfnt.ts'

/** `at` 为 Coverage 表在 `v` 中的偏移；返回的函数对不在表中的字形返回 -1。 */
export function readCoverage(v: DataView, at: number): (glyph: number) => number {
  const format = v.getUint16(at)
  if (format === 1) {
    const count = v.getUint16(at + 2)
    const glyphs = new Map<number, number>()
    for (let i = 0; i < count; i++) glyphs.set(v.getUint16(at + 4 + 2 * i), i)
    return (g) => glyphs.get(g) ?? -1
  }
  if (format === 2) {
    const count = v.getUint16(at + 2)
    const ranges: [number, number, number][] = []
    for (let i = 0; i < count; i++) {
      const r = at + 4 + 6 * i
      ranges.push([v.getUint16(r), v.getUint16(r + 2), v.getUint16(r + 4)])
    }
    return (g) => {
      for (const [start, end, index] of ranges) if (g >= start && g <= end) return index + g - start
      return -1
    }
  }
  throw new FontFormatError(`不支持的 Coverage 格式 ${format}`)
}
