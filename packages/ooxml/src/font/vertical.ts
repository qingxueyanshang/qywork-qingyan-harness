/**
 * 纵向度量与平均字宽：`hhea` 的上下沿与行距、`OS/2` 的 Windows 上下沿、平均字宽、代码页与上下标的字号与偏移。
 *
 * 只读取原始字段，不做取舍：行高取哪一组字段、怎样换算由排版模块决定。
 */

import { readHead } from './metrics.ts'
import { FontFormatError, type SfntFace, tableBytes } from './sfnt.ts'

/** `OS/2` 中直到 `ulCodePageRange2` 的长度（版本 1 起）。版本 0 的表没有代码页字段。 */
const OS2_CODE_PAGE_END = 86
/** `OS/2` 中直到 `usWinDescent` 的长度。 */
const OS2_WIN_END = 78
const HHEA_LENGTH = 36

/** `ulCodePageRange1` 的第 17–21 位：日文、简体中文、韩文（Wansung）、繁体中文、韩文（Johab）。 */
const EAST_ASIAN_CODE_PAGES = 0x003e0000

export interface VerticalMetrics {
  unitsPerEm: number
  /** `hhea.ascender`，字体单位，向上为正。 */
  hheaAscender: number
  /** `hhea.descender`，字体单位，向下为负。 */
  hheaDescender: number
  hheaLineGap: number
  /** `OS/2.usWinAscent`，字体单位，非负。 */
  winAscent: number
  /** `OS/2.usWinDescent`，字体单位，非负（向下为正）。 */
  winDescent: number
  /** `OS/2.xAvgCharWidth`，字体单位。 */
  averageWidth: number
  /** `OS/2.ulCodePageRange1` 含中文、日文或韩文代码页。版本 0 的表没有该字段，为 `false`。 */
  eastAsianCodePage: boolean
  /** `OS/2.ySuperscriptYSize`，字体单位：上标字号为原字号乘以该值除以 `unitsPerEm`。 */
  superscriptSize: number
  /** `OS/2.ySuperscriptYOffset`，字体单位，基线向上为正。 */
  superscriptOffset: number
  /** `OS/2.ySubscriptYSize`，字体单位。 */
  subscriptSize: number
  /** `OS/2.ySubscriptYOffset`，字体单位，基线向下为正。 */
  subscriptOffset: number
}

/** `OS/2.ulCodePageRange1`。版本 0 的表没有该字段，返回 0。 */
export function codePageRange1(os2: Uint8Array): number {
  const o = new DataView(os2.buffer, os2.byteOffset, os2.byteLength)
  return os2.byteLength >= OS2_CODE_PAGE_END && o.getUint16(0) >= 1 ? o.getUint32(78) : 0
}

/** `bytes` 是整个文件的字节（单个字体或 TTC），`face` 取自 `readFaces(bytes)`。字体缺少 `OS/2` 表时抛出。 */
export function readVerticalMetrics(bytes: Uint8Array, face: SfntFace): VerticalMetrics {
  const { unitsPerEm } = readHead(tableBytes(bytes, face, 'head'))
  const hhea = tableBytes(bytes, face, 'hhea')
  const os2 = tableBytes(bytes, face, 'OS/2')
  if (hhea.byteLength < HHEA_LENGTH) throw new FontFormatError('hhea 表长度不足')
  if (os2.byteLength < OS2_WIN_END) throw new FontFormatError('OS/2 表长度不足')
  const h = new DataView(hhea.buffer, hhea.byteOffset, hhea.byteLength)
  const o = new DataView(os2.buffer, os2.byteOffset, os2.byteLength)
  return {
    unitsPerEm,
    hheaAscender: h.getInt16(4),
    hheaDescender: h.getInt16(6),
    hheaLineGap: h.getInt16(8),
    winAscent: o.getUint16(74),
    winDescent: o.getUint16(76),
    averageWidth: o.getInt16(2),
    eastAsianCodePage: (codePageRange1(os2) & EAST_ASIAN_CODE_PAGES) !== 0,
    subscriptSize: o.getInt16(12),
    subscriptOffset: o.getInt16(16),
    superscriptSize: o.getInt16(20),
    superscriptOffset: o.getInt16(24),
  }
}
