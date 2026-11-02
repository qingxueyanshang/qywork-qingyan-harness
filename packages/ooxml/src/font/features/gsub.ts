/**
 * `GSUB` 表中按特性标签取得的单字替换（查找类型 1，含经扩展查找类型 7 包装的子表）。
 *
 * 取特性表中全部同名特性的查找，不按文种与语言系统区分；其他查找类型不读取。
 */

import { FontFormatError, type SfntFace, tableBytes } from '../sfnt.ts'
import { readCoverage } from './coverage.ts'

/** 字形编号的替换结果；不在替换范围内的字形原样返回。 */
export type GlyphSubstitution = (glyph: number) => number

const SINGLE = 1
const EXTENSION = 7

/**
 * `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`；`feature` 为四字符特性标签（如 `flac`）。
 * 字体没有 `GSUB` 表或没有该特性的单字替换时返回 `null`。
 */
export function readSingleSubstitution(
  bytes: Uint8Array,
  face: SfntFace,
  feature: string,
): GlyphSubstitution | null {
  if (!face.tables.has('GSUB')) return null
  const t = tableBytes(bytes, face, 'GSUB')
  if (t.byteLength < 10) throw new FontFormatError('GSUB 表长度不足')
  const v = new DataView(t.buffer, t.byteOffset, t.byteLength)
  const featureList = v.getUint16(6)
  const lookupList = v.getUint16(8)
  const lookups = new Set<number>()
  const featureCount = v.getUint16(featureList)
  for (let i = 0; i < featureCount; i++) {
    const rec = featureList + 2 + 6 * i
    const tag = String.fromCharCode(
      v.getUint8(rec),
      v.getUint8(rec + 1),
      v.getUint8(rec + 2),
      v.getUint8(rec + 3),
    )
    if (tag !== feature) continue
    const at = featureList + v.getUint16(rec + 4)
    const count = v.getUint16(at + 2)
    for (let k = 0; k < count; k++) lookups.add(v.getUint16(at + 4 + 2 * k))
  }
  /** 各查找的子表：同一查找中取第一个覆盖该字形的子表，各查找依次作用。 */
  const steps: ((glyph: number) => number | null)[][] = []
  for (const index of [...lookups].sort((a, b) => a - b)) {
    if (index >= v.getUint16(lookupList)) throw new FontFormatError('GSUB 查找序号超出范围')
    const at = lookupList + v.getUint16(lookupList + 2 + 2 * index)
    const type = v.getUint16(at)
    const count = v.getUint16(at + 4)
    const subtables: ((glyph: number) => number | null)[] = []
    for (let k = 0; k < count; k++) {
      let sub = at + v.getUint16(at + 6 + 2 * k)
      let subType = type
      if (type === EXTENSION) {
        subType = v.getUint16(sub + 2)
        sub += v.getUint32(sub + 4)
      }
      if (subType === SINGLE) subtables.push(single(v, sub))
    }
    if (subtables.length > 0) steps.push(subtables)
  }
  if (steps.length === 0) return null
  return (glyph) => {
    let g = glyph
    for (const subtables of steps) {
      for (const sub of subtables) {
        const next = sub(g)
        if (next !== null) {
          g = next
          break
        }
      }
    }
    return g
  }
}

/** 单字替换子表：不覆盖该字形时为 `null`。 */
function single(v: DataView, at: number): (glyph: number) => number | null {
  const format = v.getUint16(at)
  const cover = readCoverage(v, at + v.getUint16(at + 2))
  if (format === 1) {
    const delta = v.getInt16(at + 4)
    return (g) => (cover(g) < 0 ? null : (g + delta) & 0xffff)
  }
  if (format === 2) {
    const count = v.getUint16(at + 4)
    return (g) => {
      const i = cover(g)
      return i < 0 || i >= count ? null : v.getUint16(at + 6 + 2 * i)
    }
  }
  throw new FontFormatError(`不支持的单字替换格式 ${format}`)
}
