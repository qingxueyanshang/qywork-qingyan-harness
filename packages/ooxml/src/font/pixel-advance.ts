/**
 * 整数像素字号下的前进宽度，与 Windows GDI（ClearType，`GetCharWidth32`）的整数结果一致。
 *
 * - 有 `hdmx` 且其中有该 ppem 的记录时取记录中的宽度。
 * - 否则，`head.flags` 第 4 位为 0（指令不改变前进宽度）时按线性宽度四舍五入；等宽字体（`post.isFixedPitch`
 *   非 0，或 `OS/2` 的 panose 比例为 9）中前进宽度不小于 1 em 的字形取 `2 × round(线性宽度 / 2)`：GDI 按半角宽度的 2 倍给出全角宽度。
 *   不要把判据放宽为「宽于半 em」：西文等宽字体（Consolas 等）的字形都略宽于半 em，按线性宽度四舍五入。
 * - 其余情形（指令可能改变宽度且没有对应的 `hdmx` 记录）无法由字体表确定，返回 `null`。
 */

import { readMetrics } from './metrics.ts'
import { FontFormatError, type SfntFace, tableBytes } from './sfnt.ts'

/** `head.flags` 第 4 位：指令可能改变前进宽度。 */
const INSTRUCTIONS_ALTER_ADVANCE = 0x10
const PANOSE_MONOSPACED = 9
/** `OS/2` 中 panose 比例字段的位置。 */
const OS2_PANOSE_PROPORTION = 35

/** `hdmx` 各记录：ppem → 按字形编号排列的宽度。 */
function readHdmx(table: Uint8Array, numGlyphs: number): Map<number, Uint8Array> {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  if (table.byteLength < 8) throw new FontFormatError('hdmx 表长度不足')
  const count = v.getInt16(2)
  const size = v.getInt32(4)
  if (count < 0 || size < 2 + numGlyphs || table.byteLength < 8 + count * size) {
    throw new FontFormatError('hdmx 记录超出表范围')
  }
  const out = new Map<number, Uint8Array>()
  for (let i = 0; i < count; i++) {
    const at = 8 + i * size
    out.set(v.getUint8(at), table.subarray(at + 2, at + 2 + numGlyphs))
  }
  return out
}

function isMonospaced(bytes: Uint8Array, face: SfntFace): boolean {
  if (face.tables.has('post')) {
    const post = tableBytes(bytes, face, 'post')
    if (post.byteLength >= 16) {
      const v = new DataView(post.buffer, post.byteOffset, post.byteLength)
      if (v.getUint32(12) !== 0) return true
    }
  }
  if (face.tables.has('OS/2')) {
    const os2 = tableBytes(bytes, face, 'OS/2')
    if (
      os2.byteLength > OS2_PANOSE_PROPORTION &&
      os2[OS2_PANOSE_PROPORTION] === PANOSE_MONOSPACED
    ) {
      return true
    }
  }
  return false
}

/**
 * 返回按码位与 ppem 求整数前进宽度（像素）的函数；无法确定时返回 `null`，调用方按线性宽度处理。
 * 码位不在 `cmap` 中时按 `.notdef` 计算。`bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。
 */
export function readPixelAdvances(
  bytes: Uint8Array,
  face: SfntFace,
): (codePoint: number, ppem: number) => number | null {
  const metrics = readMetrics(bytes, face)
  const head = tableBytes(bytes, face, 'head')
  const flags = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(16)
  const linear = (flags & INSTRUCTIONS_ALTER_ADVANCE) === 0
  const hdmx = face.tables.has('hdmx')
    ? readHdmx(tableBytes(bytes, face, 'hdmx'), metrics.numGlyphs)
    : new Map<number, Uint8Array>()
  const mono = linear && isMonospaced(bytes, face)
  const upm = metrics.unitsPerEm
  return (codePoint, ppem) => {
    const record = hdmx.get(ppem)
    if (record) return record[metrics.glyphId(codePoint)]!
    if (!linear) return null
    const units = metrics.advanceWidth(codePoint)
    // 整数运算：四舍五入（0.5 进位）不经浮点。
    if (mono && units >= upm) return 2 * Math.floor((units * ppem + upm) / (2 * upm))
    return Math.floor((2 * units * ppem + upm) / (2 * upm))
  }
}
