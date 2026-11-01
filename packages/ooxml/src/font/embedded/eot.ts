/**
 * 嵌入式 OpenType（EOT）：pptx 的嵌入字体部件（`.fntdata`）使用的封装。
 *
 * - 文件头为小端序；字体数据位于文件末尾的 `FontDataSize` 字节（各版本的文件头长度不同，字体数据总在最后）。
 * - 处理标志：`0x10000000` 为逐字节与 0x50 异或，`0x4` 为 MicroType Express 压缩（先解异或再解压）。
 * - MicroType Express：1 字节版本、3 字节复制距离上限、两个 3 字节偏移（第二、第三数据块起点，自文件起算），
 *   第一数据块自第 10 字节起；三个数据块各自经 LZCOMP 解压后由 `ctfToTrueType` 还原为 TrueType。
 */

import { FontFormatError } from '../sfnt.ts'
import { ctfToTrueType } from './ctf.ts'
import { lzcompDecode } from './lzcomp.ts'

const MAGIC = 0x504c
const FLAG_COMPRESSED = 0x00000004
const FLAG_XOR = 0x10000000
const XOR_KEY = 0x50

export interface EmbeddedOpenType {
  /** 文件头中的英文家族名（`name` 表 nameID 1）。 */
  readonly family: string
  /** `Weight` 字段（400 常规、700 粗体）。 */
  readonly weight: number
  readonly italic: boolean
  /** 只含文档用到的字符（`TTEMBED_SUBSET`）。 */
  readonly subset: boolean
  /** 还原后的 TrueType 字体字节。 */
  readonly font: Uint8Array
}

/** UTF-16 小端序字符串，遇到 U+0000 截止。 */
function utf16le(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const c = bytes[i]! | (bytes[i + 1]! << 8)
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

/** 解开 MicroType Express 压缩的字体数据。 */
export function decodeMicroTypeExpress(data: Uint8Array): Uint8Array {
  if (data.length < 10) throw new FontFormatError('MicroType Express 数据过短')
  const u24 = (at: number) => (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!
  const offset2 = u24(4)
  const offset3 = u24(7)
  if (!(10 <= offset2 && offset2 <= offset3 && offset3 <= data.length)) {
    throw new FontFormatError('MicroType Express 数据块偏移不正确')
  }
  const rest = lzcompDecode(data.subarray(10, offset2))
  const push = offset3 > offset2 ? lzcompDecode(data.subarray(offset2, offset3)) : new Uint8Array()
  const code = data.length > offset3 ? lzcompDecode(data.subarray(offset3)) : new Uint8Array()
  return ctfToTrueType(rest, push, code)
}

/** 读取 EOT 文件；结构不符或解压失败时抛出 `FontFormatError`。 */
export function readEmbeddedOpenType(bytes: Uint8Array): EmbeddedOpenType {
  if (bytes.length < 84) throw new FontFormatError('EOT 文件头过短')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eotSize = v.getUint32(0, true)
  const dataSize = v.getUint32(4, true)
  const flags = v.getUint32(12, true)
  if (v.getUint16(34, true) !== MAGIC) throw new FontFormatError('EOT 标识不正确')
  if (eotSize > bytes.length || dataSize > eotSize) throw new FontFormatError('EOT 长度字段不正确')
  const italic = bytes[27] === 1
  const weight = v.getUint32(28, true)
  // 家族名：80 字节处为 Padding1，其后为长度与 UTF-16 字符串。
  const familySize = v.getUint16(82, true)
  const family = utf16le(bytes.subarray(84, 84 + familySize))
  let data: Uint8Array = bytes.slice(eotSize - dataSize, eotSize)
  if (flags & FLAG_XOR) for (let i = 0; i < data.length; i++) data[i] = data[i]! ^ XOR_KEY
  if (flags & FLAG_COMPRESSED) data = decodeMicroTypeExpress(data)
  return { family, weight, italic, subset: (flags & 1) !== 0, font: data }
}
