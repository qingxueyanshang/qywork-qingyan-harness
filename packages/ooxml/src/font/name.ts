/**
 * `name` 表：字体家族名。
 *
 * 只取 nameID 1（家族名），不取 nameID 16（排版家族名）。文档按 nameID 1 引用字体：
 * 「微软雅黑 Light」的 nameID 16 是「微软雅黑」，并入后同一家族名下出现两个同为常规样式的字体。
 */

import { FontFormatError } from './sfnt.ts'

const FAMILY = 1

/** Mac Roman 0x80–0xFF 对应的字符，按 WHATWG 编码标准的 macintosh 索引。 */
const MAC_ROMAN_HIGH = [
  'ÄÅÇÉÑÖÜá',
  'àâäãåçéè',
  'êëíìîïñó',
  'òôöõúùûü',
  '†°¢£§•¶ß',
  '®©™´¨≠ÆØ',
  '∞±≤≥¥µ∂∑',
  '∏π∫ªºΩæø',
  '¿¡¬√ƒ≈∆«',
  '»… ÀÃÕŒœ',
  '–—“”‘’÷◊',
  'ÿŸ⁄€‹›ﬁﬂ',
  '‡·‚„‰ÂÊÁ',
  'ËÈÍÎÏÌÓÔ',
  'ÒÚÛÙıˆ˜',
  '¯˘˙˚¸˝˛ˇ',
].join('')

/** 逐个 16 位码元解码，代理对按原样保留为合法的字符串。 */
function utf16be(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!)
  }
  return s
}

function macRoman(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : MAC_ROMAN_HIGH[b - 0x80]
  return s
}

/**
 * 记录所用的解码函数；不支持的编码返回 `null`。
 *
 * 不使用 `TextDecoder`：Bun 的类型声明只接受三种编码名，按实际支持的编码名调用须绕过类型检查。
 * 平台 0（Unicode）与平台 3 的编码 0（符号）、1（BMP）、10（完整 Unicode）为 UTF-16BE；
 * 平台 1 只解码编码 0（Mac Roman）。平台 1 的中日韩编码与平台 3 的旧式双字节编码不解码：
 * 现行字体同时带有平台 3 的 Unicode 记录，家族名从那里取得。
 */
function decoderFor(platform: number, encoding: number): ((bytes: Uint8Array) => string) | null {
  if (platform === 0) return utf16be
  if (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10)) return utf16be
  if (platform === 1 && encoding === 0) return macRoman
  return null
}

/** 全部语言的家族名，去重后按表中顺序返回（含本地化名称，如「宋体」与「SimSun」）。 */
export function readFamilyNames(table: Uint8Array): string[] {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const count = v.getUint16(2)
  const storage = v.getUint16(4)
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    const rec = 6 + 12 * i
    if (v.getUint16(rec + 6) !== FAMILY) continue
    const decode = decoderFor(v.getUint16(rec), v.getUint16(rec + 2))
    if (!decode) continue
    const start = storage + v.getUint16(rec + 10)
    const end = start + v.getUint16(rec + 8)
    if (end > table.byteLength) throw new FontFormatError('name 表记录超出表范围')
    const name = decode(table.subarray(start, end)).trim()
    if (name) names.add(name)
  }
  return [...names]
}
