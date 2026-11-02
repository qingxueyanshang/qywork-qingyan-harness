/**
 * `cmap` 表：码位到字形编号。支持格式 4（BMP 分段）与格式 12（完整 Unicode 分组）。
 */

import { FontFormatError } from './sfnt.ts'

/**
 * 子表的选用顺序：完整 Unicode 优先于 BMP，Unicode 编码优先于符号编码。
 * 平台 3 编码 0 是符号字体（Wingdings 等），码位位于 U+F000–U+F0FF：按原码位查询，U+0020–U+00FF 没有字形时取
 * U+F000 加该码位的字形（`symbolLookup`）。
 */
const PREFERENCE: [platform: number, encoding: number][] = [
  [3, 10],
  [0, 6],
  [0, 4],
  [3, 1],
  [0, 3],
  [0, 2],
  [0, 1],
  [0, 0],
  [3, 0],
]

type Lookup = (codePoint: number) => number

function format4(v: DataView, at: number): Lookup {
  const segments = v.getUint16(at + 6) / 2
  const ends = at + 14
  const starts = ends + 2 * segments + 2
  const deltas = starts + 2 * segments
  const ranges = deltas + 2 * segments
  return (c) => {
    if (c > 0xffff) return 0
    let lo = 0
    let hi = segments - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (v.getUint16(ends + 2 * mid) < c) lo = mid + 1
      else hi = mid
    }
    if (segments === 0 || v.getUint16(ends + 2 * lo) < c) return 0
    const start = v.getUint16(starts + 2 * lo)
    if (c < start) return 0
    const delta = v.getUint16(deltas + 2 * lo)
    const rangeAt = ranges + 2 * lo
    const range = v.getUint16(rangeAt)
    if (range === 0) return (c + delta) & 0xffff
    const glyph = v.getUint16(rangeAt + range + 2 * (c - start))
    return glyph === 0 ? 0 : (glyph + delta) & 0xffff
  }
}

function format12(v: DataView, at: number): Lookup {
  const groups = v.getUint32(at + 12)
  const base = at + 16
  return (c) => {
    let lo = 0
    let hi = groups - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const rec = base + 12 * mid
      if (c < v.getUint32(rec)) hi = mid - 1
      else if (c > v.getUint32(rec + 4)) lo = mid + 1
      else return v.getUint32(rec + 8) + (c - v.getUint32(rec))
    }
    return 0
  }
}

/**
 * 符号编码的子表：U+0020–U+00FF 按原码位没有字形时取 U+F000 加该码位的字形。WPS 输出 `w:sym` 与符号字体字段中的这些字符时
 * 同样换算（WPS 实测，构造文档 w16 sym：Wingdings 的 `w:char="00A8"`、`"F0A8"` 与字段文字「¨」都输出 U+F0A8，「l」输出 U+F06C）。
 */
function symbolLookup(lookup: Lookup): Lookup {
  return (c) => {
    const g = lookup(c)
    return g !== 0 || c < 0x20 || c > 0xff ? g : lookup(0xf000 + c)
  }
}

/**
 * 按选用顺序取第一个格式受支持的子表。字体中没有格式 4 或 12 的 Unicode 子表时抛出
 * `FontFormatError`，不返回恒为 0 的查询：恒为 0 会使全部字符按 `.notdef` 的宽度排版。
 */
export function readCmap(table: Uint8Array): Lookup {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const count = v.getUint16(2)
  const records = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const rec = 4 + 8 * i
    records.set(`${v.getUint16(rec)}/${v.getUint16(rec + 2)}`, v.getUint32(rec + 4))
  }
  for (const [platform, encoding] of PREFERENCE) {
    const at = records.get(`${platform}/${encoding}`)
    if (at === undefined) continue
    const format = v.getUint16(at)
    const lookup = format === 12 ? format12(v, at) : format === 4 ? format4(v, at) : null
    if (lookup === null) continue
    return platform === 3 && encoding === 0 ? symbolLookup(lookup) : lookup
  }
  throw new FontFormatError('cmap 中没有格式 4 或 12 的 Unicode 子表')
}
