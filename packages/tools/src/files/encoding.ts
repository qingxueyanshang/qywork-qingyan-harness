/**
 * 文本文件的编码：读取、修改与覆盖写入按同一个判定解码，写回时沿用文件原有的编码。
 *
 * 不要改为一律按 UTF-8 读写：本机按「ANSI」保存的文件（中文 Windows 上为 GBK）按 UTF-8 解码时，
 * 每个汉字变为 U+FFFD，写回后原字节无法恢复；修改其中一行英文即会破坏整份文件中的全部中文。
 */

import { decoderFor, localCharset } from '../process/decode.ts'

export interface TextCodec {
  /** `TextDecoder` 的标签，如 `utf-8`、`gb18030`。 */
  readonly charset: string
  /** 无法用该编码表示的字符按出现顺序列出，不写入替代字符。 */
  encode(text: string): Uint8Array | { unencodable: string[] }
}

export const UTF8: TextCodec = {
  charset: 'utf-8',
  encode: (text) => new TextEncoder().encode(text),
}

/** 保留 BOM：与 `readFile(abs, 'utf8')`、`StringDecoder` 的结果一致。 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** 按标签创建严格解码器：遇到非法序列即抛出异常。 */
export function strictDecoder(charset: string): TextDecoder {
  return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0], {
    fatal: true,
    ignoreBOM: true,
  })
}

/** 代码页的反向映射（字符 → 字节），按标签缓存。 */
const reverseTables = new Map<string, Map<string, Uint8Array>>()

/**
 * 由解码器反推的编码表：逐个解码全部单字节与双字节序列，结果为单个字符的记入。
 * 同一字符有多个字节序列时取先遇到的一个；`decodeText` 以往返核对保证这不会改动未修改的部分。
 * 双字节的范围覆盖 GBK、Big5、Shift_JIS、EUC-KR；单字节代码页只用到前一段。
 */
function reverseTable(charset: string): Map<string, Uint8Array> {
  const cached = reverseTables.get(charset)
  if (cached) return cached
  const decoder = decoderFor(charset)
  const table = new Map<string, Uint8Array>()
  const add = (bytes: Uint8Array) => {
    const ch = decoder.decode(bytes)
    if (ch.includes('�') || [...ch].length !== 1 || table.has(ch)) return
    table.set(ch, bytes)
  }
  for (let b = 0x80; b <= 0xff; b++) add(Uint8Array.of(b))
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) add(Uint8Array.of(lead, trail))
  }
  reverseTables.set(charset, table)
  return table
}

function codePage(charset: string): TextCodec {
  return {
    charset,
    encode(text) {
      const table = reverseTable(charset)
      const out: number[] = []
      const unencodable: string[] = []
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0
        if (code < 0x80) out.push(code)
        else {
          const bytes = table.get(ch)
          if (bytes) out.push(...bytes)
          else unencodable.push(ch)
        }
      }
      return unencodable.length ? { unencodable } : Uint8Array.from(out)
    },
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * 文件字节的正文与写回用的编码。
 *
 * 正文的判定依次为：严格 UTF-8 合法时按 UTF-8；否则本机代码页能无错解码时按代码页；否则按 UTF-8 有损解码。
 * `read_file` 流式读取时按同一顺序判定（`files.ts` 的 `decodeFile` 与 `decodeCodePage`），
 * 两侧的正文必须相同，否则读取记录的哈希与写入前的核对始终不一致。
 *
 * `codec` 为 null 表示不能按字符串写回：有损解码，或按代码页重新编码后与原字节不完全相同。
 * 此时修改会改动未修改的部分，调用方不得以 `codec` 以外的方式写回。
 */
export function decodeText(bytes: Uint8Array): { text: string; codec: TextCodec | null } {
  try {
    return { text: utf8Strict.decode(bytes), codec: UTF8 }
  } catch {
    // 不是 UTF-8，尝试本机代码页。
  }
  const charset = localCharset()
  if (charset !== 'utf-8') {
    try {
      const text = strictDecoder(charset).decode(bytes)
      const codec = codePage(charset)
      const again = codec.encode(text)
      return { text, codec: again instanceof Uint8Array && sameBytes(again, bytes) ? codec : null }
    } catch {
      // 代码页同样无法解码，按 UTF-8 有损解码。
    }
  }
  return { text: Buffer.from(bytes).toString('utf8'), codec: null }
}

/** 文件无法按字符串写回时的回执（`decodeText` 的 `codec` 为 null）。 */
export function undecodableMessage(path: string): string {
  return `${path} 不是 UTF-8 编码，也无法按本机代码页（${localCharset()}）无损解码，未写入。需要修改时用 run_command 按其实际编码处理。`
}

/** 新内容中有字符无法用文件原有的编码表示时的回执。 */
export function unencodableMessage(path: string, charset: string, chars: string[]): string {
  const shown = [...new Set(chars)].slice(0, 10).join('')
  return `${path} 的编码是 ${charset}，新内容中的「${shown}」无法用该编码表示，未写入。`
}
