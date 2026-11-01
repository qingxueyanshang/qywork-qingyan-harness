/**
 * 前进宽度：`head`、`hhea`、`maxp`、`hmtx` 与 `cmap`。
 *
 * 排版宽度只由字体文件决定，不调用 Canvas `measureText`：后者在各平台的取整方式不同，
 * 同一字体、同一段文字处在行宽边界上时，断行位置会随平台改变。
 */

import { readCmap } from './cmap.ts'
import { FontFormatError, type SfntFace, tableBytes } from './sfnt.ts'

const HEAD_MAGIC = 0x5f0f3cf5

export interface HeadInfo {
  unitsPerEm: number
  /** `head.macStyle` 的粗体位与斜体位。 */
  bold: boolean
  italic: boolean
}

export function readHead(table: Uint8Array): HeadInfo {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  if (v.getUint32(12) !== HEAD_MAGIC) throw new FontFormatError('head 表标识不正确')
  const unitsPerEm = v.getUint16(18)
  if (unitsPerEm === 0) throw new FontFormatError('unitsPerEm 为 0')
  const style = v.getUint16(44)
  return { unitsPerEm, bold: (style & 1) !== 0, italic: (style & 2) !== 0 }
}

export interface FontMetrics {
  unitsPerEm: number
  numGlyphs: number
  /**
   * 码位不在 `cmap` 中时为 0（`.notdef`），`cmap` 给出的编号不小于字形数时同样为 0。
   * 调用方据此判断是否需要换用其他字体。
   */
  glyphId(codePoint: number): number
  /** 字体单位。码位不在 `cmap` 中时为 `.notdef` 的宽度。 */
  advanceWidth(codePoint: number): number
  /** 按字号换算，单位与 `size` 相同（传入 px 得 px，传入 pt 得 pt）。 */
  advance(codePoint: number, size: number): number
}

/** `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。 */
export function readMetrics(bytes: Uint8Array, face: SfntFace): FontMetrics {
  const { unitsPerEm } = readHead(tableBytes(bytes, face, 'head'))
  const hhea = tableBytes(bytes, face, 'hhea')
  const maxp = tableBytes(bytes, face, 'maxp')
  const hmtx = tableBytes(bytes, face, 'hmtx')
  const lookup = readCmap(tableBytes(bytes, face, 'cmap'))

  const numGlyphs = new DataView(maxp.buffer, maxp.byteOffset, maxp.byteLength).getUint16(4)
  const metricCount = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength).getUint16(34)
  if (metricCount === 0 || metricCount > numGlyphs) {
    throw new FontFormatError('hhea.numberOfHMetrics 不在 1 与字形数之间')
  }
  if (hmtx.byteLength < 4 * metricCount) throw new FontFormatError('hmtx 表长度不足')
  const metrics = new DataView(hmtx.buffer, hmtx.byteOffset, hmtx.byteLength)

  const glyphId = (codePoint: number): number => {
    const g = lookup(codePoint)
    return g < numGlyphs ? g : 0
  }
  // 编号不小于 numberOfHMetrics 的字形只存 leftSideBearing，前进宽度取最后一项的值。
  const glyphAdvance = (g: number): number => metrics.getUint16(4 * Math.min(g, metricCount - 1))
  const advanceWidth = (codePoint: number): number => glyphAdvance(glyphId(codePoint))
  return {
    unitsPerEm,
    numGlyphs,
    glyphId,
    advanceWidth,
    advance: (codePoint, size) => (advanceWidth(codePoint) * size) / unitsPerEm,
  }
}
