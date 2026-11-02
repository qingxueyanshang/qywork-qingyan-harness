/**
 * `name` 表：字体家族名（全部语言的名称与按语言取的 Windows 名称）。
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

const PLATFORM_WINDOWS = 3

/** en-US 的语言标识：`localFamilyName` 在没有所求语言的名称时取它。 */
export const LANGUAGE_EN_US = 0x0409

interface FamilyRecord {
  readonly platform: number
  readonly language: number
  readonly name: string
}

/** 可解码的家族名记录，按表中顺序；去掉首尾空白后为空的记录不列出。 */
function familyRecords(table: Uint8Array): FamilyRecord[] {
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const count = v.getUint16(2)
  const storage = v.getUint16(4)
  const out: FamilyRecord[] = []
  for (let i = 0; i < count; i++) {
    const rec = 6 + 12 * i
    if (v.getUint16(rec + 6) !== FAMILY) continue
    const platform = v.getUint16(rec)
    const decode = decoderFor(platform, v.getUint16(rec + 2))
    if (!decode) continue
    const start = storage + v.getUint16(rec + 10)
    const end = start + v.getUint16(rec + 8)
    if (end > table.byteLength) throw new FontFormatError('name 表记录超出表范围')
    const name = decode(table.subarray(start, end)).trim()
    if (name) out.push({ platform, language: v.getUint16(rec + 4), name })
  }
  return out
}

/** 全部语言的家族名，去重后按表中顺序返回（含本地化名称，如「宋体」与「SimSun」）。 */
export function readFamilyNames(table: Uint8Array): string[] {
  return [...new Set(familyRecords(table).map((r) => r.name))]
}

/**
 * Windows 平台按语言标识 `language` 取的家族名：没有该语言时取 en-US，再没有时取第一个 Windows 平台的家族名；
 * 没有 Windows 平台的家族名时为 `null`。Windows 的 GDI 按界面语言列出字体时取同样的名称，WPS 按主机字体名的前缀
 * 匹配缺失字体时只用这些名称（WPS 实测：中文界面中 `等线 Fake` 取等线，`SimHei Fake`、`新細明體-ExtB X` 不匹配，
 * `MingLiU-ExtB X` 取 MingLiU-ExtB）。
 */
export function localFamilyName(table: Uint8Array, language: number): string | null {
  const found = new Map<number, string>()
  let first: string | null = null
  for (const r of familyRecords(table)) {
    if (r.platform !== PLATFORM_WINDOWS) continue
    first ??= r.name
    if (!found.has(r.language)) found.set(r.language, r.name)
  }
  return found.get(language) ?? found.get(LANGUAGE_EN_US) ?? first
}
