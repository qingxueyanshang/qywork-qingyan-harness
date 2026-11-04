/**
 * .doc 的正文文字与字符、段落属性的位置：片段表（Clx）与 CHPX、PAPX 的 FKP。
 *
 * - 片段表把字符位置（CP）分段映射到 `WordDocument` 流中的位置（FC）。压缩的片段每个字符 1 字节（按 Windows-1252 解码），
 *   位于 `fc / 2`；未压缩的片段每个字符 2 字节（UTF-16LE）。快速保存的文件中片段的顺序与流中的顺序不同，文字只能经片段表取得。
 * - 每个片段带一个属性修改（Prm）：`fComplex` 为 1 时是 Clx 中第 `igrpprl` 个 Prc 的 sprm 序列；为 0 时是单个 sprm，
 *   按 `PRM0_SPRMS` 换算操作码。
 * - 字符与段落属性按 FC 查找：PlcfBteChpx、PlcfBtePapx 给出各 FC 区间所在的 FKP 页（`WordDocument` 流中 512 字节的页），
 *   页内再按 FC 区间给出 CHPX 或 PAPX。段落属性取段落标记所在 FC 的 PAPX。不在任何区间中的 FC 没有直接属性。
 * - PAPX 的前两个字节为段落样式（istd），其后为 sprm 序列。
 */

import { Plc } from './fib.ts'

export interface Piece {
  readonly cpStart: number
  readonly cpEnd: number
  /** 片段第一个字符的 FC（压缩的片段已除以 2）。 */
  readonly fc: number
  readonly compressed: boolean
  /** 片段的属性修改：sprm 序列；没有时为 `null`。 */
  readonly prm: Uint8Array | null
}

/**
 * `Prm0.isprm` 到 sprm 操作码；表中没有的下标不修改属性。下标 0 为 sprmCLbcCRJ，只在操作数不为 0 时生效，
 * 该属性不影响显示，按不修改处理。
 */
const PRM0_SPRMS: ReadonlyMap<number, number> = new Map([
  [0x04, 0x2602],
  [0x05, 0x2461],
  [0x07, 0x2405],
  [0x08, 0x2406],
  [0x09, 0x2407],
  [0x0c, 0x260a],
  [0x0e, 0x240c],
  [0x18, 0x2416],
  [0x19, 0x2417],
  [0x1d, 0x261b],
  [0x25, 0x2423],
  [0x2c, 0x242a],
  [0x32, 0x2430],
  [0x33, 0x2431],
  [0x35, 0x2433],
  [0x36, 0x2434],
  [0x37, 0x2435],
  [0x38, 0x2436],
  [0x39, 0x2437],
  [0x3a, 0x2438],
  [0x41, 0x0800],
  [0x42, 0x0801],
  [0x43, 0x0802],
  [0x47, 0x0806],
  [0x4b, 0x080a],
  [0x4d, 0x2a0c],
  [0x4e, 0x0858],
  [0x4f, 0x2859],
  [0x50, 0x0811],
  [0x51, 0x0818],
  [0x53, 0x2a33],
  [0x55, 0x0835],
  [0x56, 0x0836],
  [0x57, 0x0837],
  [0x58, 0x0838],
  [0x59, 0x0839],
  [0x5a, 0x083a],
  [0x5b, 0x083b],
  [0x5c, 0x083c],
  [0x5e, 0x2a3e],
  [0x62, 0x2a42],
  [0x68, 0x2a48],
  [0x73, 0x2a53],
  [0x74, 0x0854],
  [0x75, 0x0855],
  [0x76, 0x0856],
  [0x78, 0x2640],
  [0x7b, 0x2a90],
  [0x7c, 0x2a86],
  [0x7e, 0x2443],
])

const windows1252 = new TextDecoder('windows-1252')

export interface PieceTable {
  readonly pieces: readonly Piece[]
  /** 片段表覆盖的字符数。 */
  readonly length: number
}

/** Clx：若干 Prc（`clxt` 为 1）之后是 Pcdt（`clxt` 为 2）。结构不完整时返回 `null`。 */
export function readPieces(table: Uint8Array, fc: number, lcb: number): PieceTable | null {
  if (fc + lcb > table.length) return null
  const v = new DataView(table.buffer, table.byteOffset, table.byteLength)
  const end = fc + lcb
  const prcs: Uint8Array[] = []
  let p = fc
  while (p < end && table[p] === 1) {
    if (p + 3 > end) return null
    const cb = v.getInt16(p + 1, true)
    if (cb < 0 || p + 3 + cb > end) return null
    prcs.push(table.subarray(p + 3, p + 3 + cb))
    p += 3 + cb
  }
  if (p + 5 > end || table[p] !== 2) return null
  const size = v.getUint32(p + 1, true)
  const plc = new Plc(table, p + 5, Math.min(size, end - p - 5), 8)
  if (plc.count === 0) return null
  const pieces: Piece[] = []
  for (let i = 0; i < plc.count; i++) {
    const at = plc.item(i)
    const raw = v.getUint32(at + 2, true)
    const compressed = (raw & 0x40000000) !== 0
    const offset = raw & 0x3fffffff
    const prmWord = v.getUint16(at + 6, true)
    let prm: Uint8Array | null = null
    if (prmWord & 1) prm = prcs[prmWord >> 1] ?? null
    else {
      const op = PRM0_SPRMS.get((prmWord >> 1) & 0x7f)
      if (op !== undefined) prm = Uint8Array.of(op & 0xff, op >> 8, prmWord >> 8)
    }
    const cpStart = plc.position(i)
    const cpEnd = plc.position(i + 1)
    if (cpEnd < cpStart) return null
    pieces.push({ cpStart, cpEnd, fc: compressed ? offset / 2 : offset, compressed, prm })
  }
  return { pieces, length: plc.position(plc.count) }
}

/** 字符位置 `[0, length)` 的文字、各字符的 FC 与所在片段；超出 `WordDocument` 流的字符为空字符。 */
export interface DocText {
  readonly text: string
  readonly fc: Int32Array
  readonly piece: Int32Array
}

export function readText(word: Uint8Array, table: PieceTable, length: number): DocText {
  const codes = new Uint16Array(length)
  const fc = new Int32Array(length).fill(-1)
  const piece = new Int32Array(length).fill(-1)
  const v = new DataView(word.buffer, word.byteOffset, word.byteLength)
  table.pieces.forEach((pc, index) => {
    const end = Math.min(pc.cpEnd, length)
    for (let cp = Math.max(pc.cpStart, 0); cp < end; cp++) {
      const k = cp - pc.cpStart
      const at = pc.fc + (pc.compressed ? k : 2 * k)
      piece[cp] = index
      fc[cp] = at
      if (pc.compressed) {
        if (at < word.length) codes[cp] = word[at]!
      } else if (at + 2 <= word.length) codes[cp] = v.getUint16(at, true)
    }
  })
  let text = ''
  const CHUNK = 8192
  for (let i = 0; i < length; i += CHUNK) {
    text += String.fromCharCode(...codes.subarray(i, i + CHUNK))
  }
  // 压缩的片段按 Windows-1252 解码：0x80–0x9F 中的字节不是 Unicode 码位。
  return { text: decodeCompressed(text, table, length), fc, piece }
}

function decodeCompressed(text: string, table: PieceTable, length: number): string {
  if (!table.pieces.some((p) => p.compressed)) return text
  const chars = text.split('')
  for (const pc of table.pieces) {
    if (!pc.compressed) continue
    for (let cp = pc.cpStart; cp < Math.min(pc.cpEnd, length); cp++) {
      const code = chars[cp]!.charCodeAt(0)
      if (code >= 0x80 && code <= 0x9f) chars[cp] = windows1252.decode(Uint8Array.of(code))
    }
  }
  return chars.join('')
}

/** FKP 中一项属性：`key` 在同一文件中唯一标识这项属性的字节，供合并相邻字段。 */
export interface FkpEntry {
  readonly key: number
  readonly bytes: Uint8Array
}

const PAGE = 512
const EMPTY: FkpEntry = { key: -1, bytes: new Uint8Array(0) }

/** CHPX 或 PAPX 的 FKP 查找。 */
export class FkpIndex {
  private readonly bte: Plc
  private readonly cache = new Map<number, FkpEntry>()

  constructor(
    private readonly word: Uint8Array,
    table: Uint8Array,
    fc: number,
    lcb: number,
    private readonly kind: 'chpx' | 'papx',
  ) {
    this.bte = new Plc(table, fc, lcb, 4)
    this.bteView = new DataView(table.buffer, table.byteOffset, table.byteLength)
  }

  private readonly bteView: DataView

  /** FC 为 `fc` 的字符的属性；没有时为空字节序列（`key` 为 -1）。 */
  at(fc: number): FkpEntry {
    const i = this.bte.find(fc)
    if (i < 0) return EMPTY
    const pn = this.bteView.getUint32(this.bte.item(i), true) & 0x3fffff
    const base = pn * PAGE
    if (base + PAGE > this.word.length) return EMPTY
    const page = this.word.subarray(base, base + PAGE)
    const v = new DataView(page.buffer, page.byteOffset, PAGE)
    const n = page[PAGE - 1]!
    if (4 * (n + 1) > PAGE) return EMPTY
    let lo = 0
    let hi = n - 1
    let j = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (fc < v.getUint32(mid * 4, true)) hi = mid - 1
      else if (fc >= v.getUint32(mid * 4 + 4, true)) lo = mid + 1
      else {
        j = mid
        break
      }
    }
    if (j < 0) return EMPTY
    const slot = 4 * (n + 1) + j * (this.kind === 'chpx' ? 1 : 13)
    const offset = page[slot]! * 2
    if (offset === 0) return EMPTY
    const key = base + offset
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    let bytes: Uint8Array
    if (this.kind === 'chpx') {
      bytes = page.subarray(offset + 1, Math.min(PAGE, offset + 1 + page[offset]!))
    } else {
      const cb = page[offset]!
      const start = cb === 0 ? offset + 2 : offset + 1
      const size = cb === 0 ? 2 * page[offset + 1]! : 2 * cb - 1
      bytes = page.subarray(start, Math.min(PAGE, start + size))
    }
    const entry = { key, bytes }
    this.cache.set(key, entry)
    return entry
  }
}
