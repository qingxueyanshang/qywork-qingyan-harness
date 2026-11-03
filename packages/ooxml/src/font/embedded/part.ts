/**
 * 文档嵌入字体部件的还原：WordprocessingML 按 `w:fontKey` 混淆的字体（`.odttf`），以及 PresentationML 的 EOT 或 sfnt 部件。
 *
 * - 混淆（ISO/IEC 29500-1 §17.8.1）：字体文件的前 32 字节与密钥逐字节异或，密钥为 `fontKey` 的 32 个十六进制数字自末尾起
 *   每两位一字节取得的 16 字节，循环使用两次。
 * - 去混淆后的字节为 sfnt 时原样使用，否则按 EOT 读取（`readEmbeddedOpenType`）。
 */

import { FontFormatError, readFaces } from '../sfnt.ts'
import { readEmbeddedOpenType } from './eot.ts'

const OBFUSCATED_LENGTH = 32

/** `fontKey`（GUID 字符串，含或不含花括号与连字符）的 16 字节密钥；格式不符时抛出 `FontFormatError`。 */
function obfuscationKey(fontKey: string): Uint8Array {
  const hex = fontKey.replace(/[{}-]/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new FontFormatError('fontKey 不是 GUID')
  const key = new Uint8Array(16)
  for (let i = 0; i < 16; i++) key[i] = Number.parseInt(hex.slice(30 - 2 * i, 32 - 2 * i), 16)
  return key
}

/** 字节本身是否为可读的 sfnt 字体。 */
function isSfnt(bytes: Uint8Array): boolean {
  try {
    readFaces(bytes)
    return true
  } catch (e) {
    if (e instanceof FontFormatError) return false
    throw e
  }
}

/**
 * 还原嵌入字体部件为 TrueType 或 CFF 字体字节。`fontKey` 为 `null` 时部件未混淆。结构不符、密钥格式不符或解压失败时
 * 抛出 `FontFormatError`。不修改 `bytes`。
 */
export function decodeEmbeddedFont(bytes: Uint8Array, fontKey: string | null): Uint8Array {
  let data = bytes
  if (fontKey !== null) {
    if (bytes.length < OBFUSCATED_LENGTH) throw new FontFormatError('混淆字体过短')
    const key = obfuscationKey(fontKey)
    data = bytes.slice()
    for (let i = 0; i < OBFUSCATED_LENGTH; i++) data[i] = data[i]! ^ key[i % 16]!
  }
  return isSfnt(data) ? data : readEmbeddedOpenType(data).font
}
