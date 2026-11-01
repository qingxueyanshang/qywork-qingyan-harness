/**
 * ZIP 读取：反扫中央目录取得成员表，按需解压单个成员。
 *
 * - 结果一律以 `ZipResult` 返回，文件内容引起的失败不抛出。失败分四类：
 *   CFB 复合文档按根存储下的流区分：`EncryptedPackage` 为已加密，`Workbook`、`WordDocument`、
 *   `PowerPoint Document` 为旧二进制格式，两者都没有或结构不完整为已损坏；
 *   既不是 CFB 也不以 ZIP 本地文件头开始为不是 Office 文件；ZIP 成员设置加密标志位为已加密；
 *   ZIP 的结构、解压与校验错误为已损坏。
 * - 压缩方法只支持 0（存储）与 8（deflate）。deflate 由 `DecompressionStream('deflate-raw')` 解压，
 *   Bun、Worker 与各端 WebView 共用这一条路径。运行环境缺少该接口时抛出，不归入已损坏。
 * - 不支持 ZIP64：遇到 ZIP64 标记值时返回已损坏。
 * - 成员名按通用标志位第 11 位选择 UTF-8 或 CP437 解码；查找按成员名精确匹配。
 * - 成员按文本读取时以字节序标记选择编码：`FF FE` 为 UTF-16LE，`FE FF` 为 UTF-16BE，其余按严格 UTF-8；
 *   XML 声明中的 `encoding` 不参与判断。
 */

import { cfbRootStreams } from './cfb.ts'
import { decodeCp437 } from './cp437.ts'
import { crc32 } from './crc32.ts'

/**
 * 已损坏的具体原因，供日志与测试区分。界面只按 `ZipFailure.kind` 显示。
 *
 * - `end-record`：未找到中央目录结束记录，截断的文件落入此类。
 * - `central-directory` / `local-header`：记录签名错误或超出数据范围。
 * - `zip64`：出现 ZIP64 标记值。
 * - `method`：压缩方法不是 0 或 8。
 * - `inflate`：deflate 数据无法解压。
 * - `size` / `crc`：解压结果的长度或 CRC 与中央目录不一致。
 * - `encoding`：按文本读取时不是合法的 UTF-8 或带字节序标记的 UTF-16。
 * - `cfb-structure`：CFB 文件头、FAT 或目录不完整。
 * - `cfb-unrecognized`：CFB 根存储下既没有加密包，也没有旧二进制格式的文档流。
 */
export type ZipCorruptReason =
  | 'end-record'
  | 'central-directory'
  | 'local-header'
  | 'zip64'
  | 'method'
  | 'inflate'
  | 'size'
  | 'crc'
  | 'encoding'
  | 'cfb-structure'
  | 'cfb-unrecognized'

export type ZipFailure =
  | { readonly kind: 'not-office' }
  | { readonly kind: 'encrypted' }
  | { readonly kind: 'legacy' }
  | { readonly kind: 'corrupt'; readonly reason: ZipCorruptReason }

export type ZipResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ZipFailure }

export interface ZipArchive {
  /** 全部成员名，按中央目录顺序。 */
  readonly paths: readonly string[]
  /** 解压并校验一个成员。成员不存在时 `value` 为 `null`。返回的字节不与输入共享内存。 */
  bytes(path: string): Promise<ZipResult<Uint8Array | null>>
  /** 同 `bytes`，再按字节序标记选择 UTF-8 或 UTF-16 解码；字节序标记不计入结果。 */
  text(path: string): Promise<ZipResult<string | null>>
}

interface Entry {
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly headerOffset: number
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50
const LOCAL_SIZE = 30
const CENTRAL_SIZE = 46
const END_SIZE = 22
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
/** 旧二进制格式的主文档流：Excel 97–2003、Word 97–2003、PowerPoint 97–2003。名称为大写。 */
const LEGACY_STREAMS = ['WORKBOOK', 'WORDDOCUMENT', 'POWERPOINT DOCUMENT']
const FLAG_ENCRYPTED = 0x0001
const FLAG_UTF8 = 0x0800
const U16_MAX = 0xffff
const U32_MAX = 0xffffffff

const nameDecoder = new TextDecoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
/**
 * WHATWG 编码标签 `utf-16` 即 UTF-16LE。不要改为 `utf-16le` / `utf-16be` 两个解码器：
 * Bun 的类型声明只接受 `utf-8`、`windows-1252`、`utf-16` 三个标签，UTF-16BE 先逐对交换字节再按 LE 解码。
 */
const utf16Decoder = new TextDecoder('utf-16', { fatal: true })

/** 按字节序标记解码，标记不计入结果。内容不合法时抛出。 */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return utf16Decoder.decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return utf16Decoder.decode(swapPairs(bytes))
  return utf8Decoder.decode(bytes)
}

/** 逐对交换字节。长度为奇数时末字节原样保留，解码时按内容不完整报错。 */
function swapPairs(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out[i] = bytes[i + 1]!
    out[i + 1] = bytes[i]!
  }
  if (bytes.length % 2 === 1) out[bytes.length - 1] = bytes[bytes.length - 1]!
  return out
}

function ok<T>(value: T): ZipResult<T> {
  return { ok: true, value }
}

function fail(failure: ZipFailure): { readonly ok: false; readonly failure: ZipFailure } {
  return { ok: false, failure }
}

function corrupt(reason: ZipCorruptReason) {
  return fail({ kind: 'corrupt', reason })
}

/** 只解析中央目录，不解压任何成员。 */
export function openZip(data: Uint8Array<ArrayBuffer>): ZipResult<ZipArchive> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data.length >= CFB_SIGNATURE.length && CFB_SIGNATURE.every((b, i) => data[i] === b)) {
    return fail(classifyCfb(view))
  }
  if (data.length < 4 || view.getUint32(0, true) !== SIG_LOCAL) return fail({ kind: 'not-office' })

  const end = findEndRecord(view)
  if (end < 0) return corrupt('end-record')
  const count = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryStart = view.getUint32(end + 16, true)
  if (count === U16_MAX || directorySize === U32_MAX || directoryStart === U32_MAX) {
    return corrupt('zip64')
  }
  const directoryEnd = directoryStart + directorySize
  if (directoryEnd > end) return corrupt('central-directory')

  const paths: string[] = []
  const entries = new Map<string, Entry>()
  let p = directoryStart
  for (let i = 0; i < count; i++) {
    if (p + CENTRAL_SIZE > directoryEnd || view.getUint32(p, true) !== SIG_CENTRAL) {
      return corrupt('central-directory')
    }
    const flags = view.getUint16(p + 8, true)
    const nameLength = view.getUint16(p + 28, true)
    const next =
      p + CENTRAL_SIZE + nameLength + view.getUint16(p + 30, true) + view.getUint16(p + 32, true)
    if (next > directoryEnd) return corrupt('central-directory')
    const compressedSize = view.getUint32(p + 20, true)
    const size = view.getUint32(p + 24, true)
    const headerOffset = view.getUint32(p + 42, true)
    if (compressedSize === U32_MAX || size === U32_MAX || headerOffset === U32_MAX) {
      return corrupt('zip64')
    }
    if (flags & FLAG_ENCRYPTED) return fail({ kind: 'encrypted' })
    const rawName = data.subarray(p + CENTRAL_SIZE, p + CENTRAL_SIZE + nameLength)
    const path = flags & FLAG_UTF8 ? nameDecoder.decode(rawName) : decodeCp437(rawName)
    paths.push(path)
    entries.set(path, {
      method: view.getUint16(p + 10, true),
      crc: view.getUint32(p + 16, true),
      compressedSize,
      size,
      headerOffset,
    })
    p = next
  }
  return ok(new Archive(data, view, paths, entries))
}

function classifyCfb(view: DataView): ZipFailure {
  const streams = cfbRootStreams(view)
  if (streams === null) return { kind: 'corrupt', reason: 'cfb-structure' }
  if (streams.has('ENCRYPTEDPACKAGE')) return { kind: 'encrypted' }
  if (LEGACY_STREAMS.some((name) => streams.has(name))) return { kind: 'legacy' }
  return { kind: 'corrupt', reason: 'cfb-unrecognized' }
}

/** 结束记录之后最多跟 65535 字节注释，因此只在末尾这一段内反向查找签名。 */
function findEndRecord(view: DataView): number {
  const min = Math.max(0, view.byteLength - END_SIZE - U16_MAX)
  for (let p = view.byteLength - END_SIZE; p >= min; p--) {
    if (
      view.getUint32(p, true) === SIG_END &&
      p + END_SIZE + view.getUint16(p + 20, true) <= view.byteLength
    ) {
      return p
    }
  }
  return -1
}

/**
 * 解压失败返回 `null`。
 *
 * - `DecompressionStream` 在 `try` 之外构造：环境缺少该接口时不得归入已损坏。
 * - 直接写入流，不要改为 `new Blob([raw]).stream()`：Chromium 中每次构造 Blob 约多耗 0.25 ms，
 *   成员上千的文件累计数百毫秒。
 * - 写入、关闭与读取放在同一个 `Promise.all` 中：三者必须同时进行，且任一方的拒绝都须有处理方。
 */
async function inflateRaw(raw: Uint8Array<ArrayBuffer>): Promise<Uint8Array | null> {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  try {
    const [, , out] = await Promise.all([
      writer.write(raw),
      writer.close(),
      new Response(stream.readable).arrayBuffer(),
    ])
    return new Uint8Array(out)
  } catch {
    return null
  }
}

class Archive implements ZipArchive {
  constructor(
    private readonly data: Uint8Array<ArrayBuffer>,
    private readonly view: DataView,
    readonly paths: readonly string[],
    private readonly entries: ReadonlyMap<string, Entry>,
  ) {}

  async bytes(path: string): Promise<ZipResult<Uint8Array | null>> {
    const entry = this.entries.get(path)
    if (entry === undefined) return ok(null)
    const h = entry.headerOffset
    if (h + LOCAL_SIZE > this.data.length || this.view.getUint32(h, true) !== SIG_LOCAL) {
      return corrupt('local-header')
    }
    // 数据长度取中央目录的值：设置了数据描述符标志（第 3 位）时，本地文件头中的长度为 0。
    const start =
      h + LOCAL_SIZE + this.view.getUint16(h + 26, true) + this.view.getUint16(h + 28, true)
    if (start + entry.compressedSize > this.data.length) return corrupt('local-header')
    const raw = this.data.subarray(start, start + entry.compressedSize)

    let out: Uint8Array
    if (entry.method === 0) {
      out = raw.slice()
    } else if (entry.method === 8) {
      const inflated = await inflateRaw(raw)
      if (inflated === null) return corrupt('inflate')
      out = inflated
    } else {
      return corrupt('method')
    }
    if (out.length !== entry.size) return corrupt('size')
    if (crc32(out) !== entry.crc) return corrupt('crc')
    return ok(out)
  }

  async text(path: string): Promise<ZipResult<string | null>> {
    const read = await this.bytes(path)
    if (!read.ok) return read
    if (read.value === null) return ok(null)
    try {
      return ok(decodeText(read.value))
    } catch {
      return corrupt('encoding')
    }
  }
}
