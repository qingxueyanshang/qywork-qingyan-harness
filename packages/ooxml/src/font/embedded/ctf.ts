/**
 * 紧凑表格式（CTF）还原为 TrueType：MicroType Express 第一数据块是表目录与各表，其中 `glyf`、`cvt `、
 * `hdmx`、`VDMX` 为压缩形式，`loca` 偏移与长度均为 0；第二、第三数据块为字形指令的入栈数据与其余指令。
 *
 * - 字形按 `maxp.numGlyphs` 顺序排列：简单字形的点以三元组编码（相对前一点的位移与是否在曲线上），
 *   包围盒缺省时由点坐标计算；组合字形的组件与 TrueType 相同。指令由入栈数据重新生成入栈指令，
 *   与其余指令相接。
 * - CFF 轮廓的字体（`OTTO`）没有 `glyf`，各表原样保留。
 * - 输出的 `loca` 为长格式（`head.indexToLocFormat` 置 1）；`maxp.maxSizeOfInstructions` 不小于重新生成的指令长度。
 *   表的顺序与其余表的字节保持不变，校验和重新计算。
 */

import { FontFormatError } from '../sfnt.ts'

class Reader {
  pos: number
  private readonly view: DataView

  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.length,
  ) {
    this.pos = start
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private need(n: number): void {
    if (this.pos + n > this.end) throw new FontFormatError('CTF 数据提前结束')
  }

  u8(): number {
    this.need(1)
    return this.bytes[this.pos++]!
  }

  u16(): number {
    this.need(2)
    const v = this.view.getUint16(this.pos)
    this.pos += 2
    return v
  }

  i16(): number {
    this.need(2)
    const v = this.view.getInt16(this.pos)
    this.pos += 2
    return v
  }

  u32(): number {
    this.need(4)
    const v = this.view.getUint32(this.pos)
    this.pos += 4
    return v
  }

  take(n: number): Uint8Array {
    this.need(n)
    const out = this.bytes.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** 255USHORT。 */
  u255(): number {
    const code = this.u8()
    if (code === 253) return this.u16()
    if (code === 255) return 253 + this.u8()
    if (code === 254) return 506 + this.u8()
    return code
  }

  /** 255SHORT。 */
  s255(): number {
    let code = this.u8()
    if (code === 253) return this.i16()
    let sign = 1
    if (code === 250) {
      sign = -1
      code = this.u8()
    }
    const v = code === 255 ? 250 + this.u8() : code === 254 ? 500 + this.u8() : code
    return v * sign
  }
}

class Writer {
  private buf = new Uint8Array(1024)
  length = 0

  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.length + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }

  u8(v: number): void {
    this.grow(1)
    this.buf[this.length++] = v & 0xff
  }

  u16(v: number): void {
    this.u8(v >> 8)
    this.u8(v)
  }

  u32(v: number): void {
    this.u16(v >>> 16)
    this.u16(v & 0xffff)
  }

  bytes(b: Uint8Array): void {
    this.grow(b.length)
    this.buf.set(b, this.length)
    this.length += b.length
  }

  align(n: number): void {
    while (this.length % n !== 0) this.u8(0)
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

interface Table {
  readonly tag: string
  readonly data: Uint8Array
}

const HOP3 = 251
const HOP4 = 252
const ARG_1_AND_2_ARE_WORDS = 0x0001
const WE_HAVE_A_SCALE = 0x0008
const MORE_COMPONENTS = 0x0020
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040
const WE_HAVE_A_TWO_BY_TWO = 0x0080
const WE_HAVE_INSTRUCTIONS = 0x0100

/** 入栈数据：255SHORT，`HOP3`、`HOP4` 重复两项之前的值。 */
function readPushData(r: Reader, count: number): number[] {
  const out: number[] = []
  while (out.length < count) {
    const code = r.bytes[r.pos]
    if (code === HOP3 || code === HOP4) {
      r.pos++
      const a = out[out.length - 2] ?? 0
      out.push(a, r.s255(), a)
      if (code === HOP4) out.push(r.s255(), a)
    } else {
      out.push(r.s255())
    }
  }
  return out.slice(0, count)
}

/** 入栈指令：连续的 0–255 用字节入栈，其余用字入栈，每条指令最多 255 个值。 */
function pushInstructions(values: readonly number[], out: Writer): void {
  let i = 0
  while (i < values.length) {
    const isByte = (v: number) => v >= 0 && v <= 255
    const bytes = isByte(values[i]!)
    let j = i
    while (j < values.length && j - i < 255 && isByte(values[j]!) === bytes) j++
    const n = j - i
    if (n <= 8) out.u8((bytes ? 0xb0 : 0xb8) + n - 1)
    else {
      out.u8(bytes ? 0x40 : 0x41)
      out.u8(n)
    }
    for (let k = i; k < j; k++) {
      if (bytes) out.u8(values[k]!)
      else out.u16(values[k]! & 0xffff)
    }
    i = j
  }
}

interface Streams {
  readonly glyf: Reader
  readonly push: Reader
  readonly code: Reader
}

function instructions(s: Streams): Uint8Array {
  const pushCount = s.glyf.u255()
  const codeSize = s.glyf.u255()
  const w = new Writer()
  pushInstructions(readPushData(s.push, pushCount), w)
  w.bytes(s.code.take(codeSize))
  return w.result()
}

function withSign(flag: number, value: number): number {
  return flag & 1 ? value : -value
}

/** 三元组编码的点位移。 */
function triplet(flag: number, r: Reader): [number, number] {
  if (flag < 10) return [0, withSign(flag, ((flag & 14) << 7) + r.u8())]
  if (flag < 20) return [withSign(flag, (((flag - 10) & 14) << 7) + r.u8()), 0]
  if (flag < 84) {
    const b0 = flag - 20
    const b1 = r.u8()
    return [
      withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4)),
      withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f)),
    ]
  }
  if (flag < 120) {
    const b0 = flag - 84
    const x = r.u8()
    const y = r.u8()
    return [
      withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + x),
      withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + y),
    ]
  }
  if (flag < 124) {
    const a = r.u8()
    const b = r.u8()
    const c = r.u8()
    return [withSign(flag, (a << 4) + (b >> 4)), withSign(flag >> 1, ((b & 0x0f) << 8) + c)]
  }
  const a = r.u16()
  const b = r.u16()
  return [withSign(flag, a), withSign(flag >> 1, b)]
}

function simpleGlyph(contours: number, box: number[] | null, s: Streams, out: Writer): number {
  const r = s.glyf
  const ends: number[] = []
  for (let c = 0; c < contours; c++) {
    const v = r.u255()
    ends.push(c === 0 ? v : ends[c - 1]! + v)
  }
  const points = contours === 0 ? 0 : ends[contours - 1]! + 1
  const flags = r.take(points).slice()
  const xs = new Int32Array(points)
  const ys = new Int32Array(points)
  let x = 0
  let y = 0
  for (let p = 0; p < points; p++) {
    const [dx, dy] = triplet(flags[p]! & 0x7f, r)
    x += dx
    y += dy
    xs[p] = x
    ys[p] = y
  }
  const instr = instructions(s)
  let bbox = box
  if (bbox === null) {
    bbox = [0, 0, 0, 0]
    if (points > 0) {
      bbox = [xs[0]!, ys[0]!, xs[0]!, ys[0]!]
      for (let p = 1; p < points; p++) {
        bbox[0] = Math.min(bbox[0]!, xs[p]!)
        bbox[1] = Math.min(bbox[1]!, ys[p]!)
        bbox[2] = Math.max(bbox[2]!, xs[p]!)
        bbox[3] = Math.max(bbox[3]!, ys[p]!)
      }
    }
  }
  out.u16(contours)
  for (const v of bbox) out.u16(v & 0xffff)
  for (const e of ends) out.u16(e)
  out.u16(instr.length)
  out.bytes(instr)
  // 坐标一律以 16 位相对值写出：标志只保留是否在曲线上。
  for (let p = 0; p < points; p++) out.u8(flags[p]! & 0x80 ? 0 : 1)
  let prev = 0
  for (let p = 0; p < points; p++) {
    out.u16((xs[p]! - prev) & 0xffff)
    prev = xs[p]!
  }
  prev = 0
  for (let p = 0; p < points; p++) {
    out.u16((ys[p]! - prev) & 0xffff)
    prev = ys[p]!
  }
  return instr.length
}

function compositeGlyph(s: Streams, out: Writer): number {
  const r = s.glyf
  const start = r.pos
  out.u16(0xffff)
  for (let i = 0; i < 4; i++) out.u16(r.i16() & 0xffff)
  let flags: number
  do {
    flags = r.u16()
    r.u16()
    r.pos += flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2
    if (flags & WE_HAVE_A_SCALE) r.pos += 2
    else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) r.pos += 4
    else if (flags & WE_HAVE_A_TWO_BY_TWO) r.pos += 8
  } while (flags & MORE_COMPONENTS)
  out.bytes(r.bytes.subarray(start + 8, r.pos))
  if (!(flags & WE_HAVE_INSTRUCTIONS)) return 0
  const instr = instructions(s)
  out.u16(instr.length)
  out.bytes(instr)
  return instr.length
}

function decodeGlyphs(
  glyf: Uint8Array,
  numGlyphs: number,
  push: Uint8Array,
  code: Uint8Array,
): { glyf: Uint8Array; loca: Uint8Array; maxInstructions: number } {
  const s: Streams = { glyf: new Reader(glyf), push: new Reader(push), code: new Reader(code) }
  const out = new Writer()
  const loca = new Writer()
  let maxInstructions = 0
  for (let g = 0; g < numGlyphs; g++) {
    loca.u32(out.length)
    const contours = s.glyf.i16()
    if (contours === -1) {
      maxInstructions = Math.max(maxInstructions, compositeGlyph(s, out))
    } else if (contours === 0x7fff) {
      const real = s.glyf.i16()
      const box = [s.glyf.i16(), s.glyf.i16(), s.glyf.i16(), s.glyf.i16()]
      maxInstructions = Math.max(maxInstructions, simpleGlyph(real, box, s, out))
    } else if (contours > 0) {
      maxInstructions = Math.max(maxInstructions, simpleGlyph(contours, null, s, out))
    }
    out.align(4)
  }
  loca.u32(out.length)
  return { glyf: out.result(), loca: loca.result(), maxInstructions }
}

/** `cvt `：数量之后为相对前一项的差值，按 1–3 字节编码。 */
function decodeCvt(data: Uint8Array): Uint8Array {
  const r = new Reader(data)
  const n = r.u16()
  const out = new Writer()
  let value = 0
  for (let i = 0; i < n; i++) {
    const code = r.u8()
    let delta: number
    if (code < 238) delta = code
    else if (code >= 248) delta = 238 * (code - 247) + r.u8()
    else if (code >= 239) delta = -(238 * (code - 239) + r.u8())
    else delta = r.i16()
    value = (value + delta) & 0xffff
    out.u16(value)
  }
  return out.result()
}

/** 大小相关编码的位流：0 个 1 后跟 0 为 0；n 个 1 后跟 0 与符号位为 ±n。位按字节从低位到高位排列。 */
class MagnitudeReader {
  private bit = 0

  constructor(
    private readonly bytes: Uint8Array,
    private pos: number,
  ) {}

  private next(): number {
    const b = this.bytes[this.pos] ?? 0
    const v = (b >> this.bit) & 1
    if (++this.bit === 8) {
      this.bit = 0
      this.pos++
    }
    return v
  }

  value(): number {
    let n = 0
    while (this.next() === 1) n++
    if (n === 0) return 0
    return this.next() === 1 ? -n : n
  }

  /** 下一个字节的位置（位于字节中间时取下一字节）。 */
  byteAddress(): number {
    return this.bit === 0 ? this.pos : this.pos + 1
  }
}

function readU16(b: Uint8Array, at: number): number {
  return ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
}

function readI16(b: Uint8Array, at: number): number {
  const v = readU16(b, at)
  return v >= 0x8000 ? v - 0x10000 : v
}

/** `hdmx`：各尺寸的步进宽度以按 `hmtx` 预测值之差存储；版本为 0xFFFF 减实际版本时为未压缩的原始数据。 */
function decodeHdmx(data: Uint8Array, advances: readonly number[], unitsPerEm: number): Uint8Array {
  const version = readU16(data, 0)
  if (version > 0x7fff) {
    const out = data.slice()
    out[0] = ((0xffff - version) >> 8) & 0xff
    out[1] = (0xffff - version) & 0xff
    return out
  }
  const numRecords = readU16(data, 2)
  const numGlyphs = advances.length
  const recordSize = (2 + numGlyphs + 3) & ~3
  const sizes: [number, number][] = []
  for (let i = 0; i < numRecords; i++) sizes.push([data[8 + 2 * i] ?? 0, data[9 + 2 * i] ?? 0])
  const mr = new MagnitudeReader(data, 8 + 2 * numRecords)
  const out = new Writer()
  out.u16(version)
  out.u16(numRecords)
  out.u32(recordSize)
  for (const [ppem, maxWidth] of sizes) {
    const start = out.length
    out.u8(ppem)
    out.u8(maxWidth)
    for (let g = 0; g < numGlyphs; g++) {
      const predicted = Math.floor(
        (Math.floor((64 * ppem * advances[g]! + Math.floor(unitsPerEm / 2)) / unitsPerEm) + 32) /
          64,
      )
      out.u8(predicted + mr.value())
    }
    while (out.length - start < recordSize) out.u8(0)
  }
  return out.result()
}

/** `VDMX`：各组的高度记录以预测误差存储；版本为 0xFFFF 减实际版本时为未压缩的原始数据。 */
function decodeVdmx(data: Uint8Array): Uint8Array {
  const version = readU16(data, 0)
  if (version > 0x7fff) {
    const out = data.slice()
    out[0] = ((0xffff - version) >> 8) & 0xff
    out[1] = (0xffff - version) & 0xff
    return out
  }
  const numRecs = readU16(data, 2)
  const numRatios = readU16(data, 4)
  const headerEnd = 6 + 4 * numRatios + 2 * numRatios
  let at = readU16(data, 6 + 4 * numRatios)
  const groups: Uint8Array[] = []
  const groupOffsets: number[] = []
  const inputOffsets: number[] = []
  for (let i = 0; i < numRatios; i++) inputOffsets.push(readU16(data, 6 + 4 * numRatios + 2 * i))
  const inputStarts: number[] = []
  for (let g = 0; g < numRecs; g++) {
    inputStarts.push(at)
    const recs = readU16(data, at)
    const yMaxMult = readI16(data, at + 2)
    const yMinMult = readI16(data, at + 4)
    const mr = new MagnitudeReader(data, at + 6)
    const w = new Writer()
    w.u16(recs)
    let startsz = 0
    let endsz = 0
    const entries = new Writer()
    let predictedPpem = 8
    for (let j = 0; j < recs; j++) {
      const ppem = predictedPpem + mr.value()
      const yMax = Math.floor((ppem * yMaxMult + 1024) / 2048) + mr.value()
      const yMin = -Math.floor((ppem * yMinMult + 1024) / 2048) + mr.value()
      if (j === 0) startsz = ppem
      endsz = ppem
      entries.u16(ppem)
      entries.u16(yMax & 0xffff)
      entries.u16(yMin & 0xffff)
      predictedPpem = ppem + 1
    }
    w.u8(startsz)
    w.u8(endsz)
    w.bytes(entries.result())
    groups.push(w.result())
    at = mr.byteAddress()
  }
  const out = new Writer()
  out.u16(version)
  out.u16(numRecs)
  out.u16(numRatios)
  out.bytes(data.subarray(6, 6 + 4 * numRatios))
  let offset = headerEnd
  for (const g of groups) {
    groupOffsets.push(offset)
    offset += g.length
  }
  // 比例组按其在输入中指向的组序号重定向到输出中的组。
  for (const o of inputOffsets) {
    const index = inputStarts.indexOf(o)
    out.u16(groupOffsets[index < 0 ? 0 : index] ?? headerEnd)
  }
  for (const g of groups) out.bytes(g)
  return out.result()
}

function checksum(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const v =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0)
    sum = (sum + (v >>> 0)) >>> 0
  }
  return sum
}

/** 由表构造 sfnt 字节：表目录按标签升序，表体按给定顺序排列并 4 字节对齐。 */
function buildSfnt(version: number, tables: readonly Table[]): Uint8Array {
  const n = tables.length
  let entrySelector = 0
  while (2 ** (entrySelector + 1) <= n) entrySelector++
  const searchRange = 2 ** entrySelector * 16
  const out = new Writer()
  out.u32(version)
  out.u16(n)
  out.u16(searchRange)
  out.u16(entrySelector)
  out.u16(n * 16 - searchRange)
  let offset = 12 + 16 * n
  const placed = tables.map((t) => {
    const at = offset
    offset += (t.data.length + 3) & ~3
    return { ...t, at }
  })
  for (const t of [...placed].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0))) {
    for (let i = 0; i < 4; i++) out.u8(t.tag.charCodeAt(i))
    out.u32(checksum(t.data))
    out.u32(t.at)
    out.u32(t.data.length)
  }
  for (const t of placed) {
    out.bytes(t.data)
    out.align(4)
  }
  const font = out.result()
  const head = placed.find((t) => t.tag === 'head')
  if (head !== undefined && head.data.length >= 12) {
    const v = new DataView(font.buffer)
    v.setUint32(head.at + 8, 0)
    v.setUint32(head.at + 8, (0xb1b0afba - checksum(font)) >>> 0)
  }
  return font
}

/** 由三个解压后的数据块还原 TrueType 字体字节。 */
export function ctfToTrueType(rest: Uint8Array, push: Uint8Array, code: Uint8Array): Uint8Array {
  const r = new Reader(rest)
  const version = r.u32()
  const numTables = r.u16()
  r.pos += 6
  const records: { tag: string; offset: number; length: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const tag = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8())
    r.u32()
    const offset = r.u32()
    const length = r.u32()
    records.push({ tag, offset, length })
  }
  records.sort((a, b) => a.offset - b.offset)
  const raw = new Map<string, Uint8Array>()
  for (const t of records) {
    if (t.offset + t.length > rest.length) throw new FontFormatError(`CTF 表 ${t.tag} 超出数据范围`)
    raw.set(t.tag, rest.subarray(t.offset, t.offset + t.length))
  }
  const head = raw.get('head')
  const maxp = raw.get('maxp')
  const hhea = raw.get('hhea')
  const hmtx = raw.get('hmtx')
  const glyfIn = raw.get('glyf')
  if (!head || !maxp) throw new FontFormatError('CTF 缺少 head 或 maxp')
  const numGlyphs = readU16(maxp, 4)
  const unitsPerEm = readU16(head, 18)
  // CFF 轮廓的字体没有 glyf 与 loca，各表原样保留。
  const glyphs = glyfIn ? decodeGlyphs(glyfIn, numGlyphs, push, code) : null

  const advances: number[] = []
  if (hhea && hmtx) {
    const metrics = readU16(hhea, 34)
    for (let g = 0; g < numGlyphs; g++) advances.push(readU16(hmtx, 4 * Math.min(g, metrics - 1)))
  }

  const tables: Table[] = []
  for (const t of records) {
    let data = raw.get(t.tag)!
    switch (t.tag) {
      case 'glyf':
        data = glyphs?.glyf ?? data
        break
      case 'loca':
        data = glyphs?.loca ?? data
        break
      case 'cvt ':
        data = decodeCvt(data)
        break
      case 'hdmx':
        data = decodeHdmx(data, advances, unitsPerEm)
        break
      case 'VDMX':
        data = decodeVdmx(data)
        break
      case 'head': {
        if (glyphs === null) break
        data = data.slice()
        data[50] = 0
        data[51] = 1
        break
      }
      case 'maxp': {
        if (glyphs === null) break
        data = data.slice()
        if (data.length >= 28 && readU16(data, 26) < glyphs.maxInstructions) {
          data[26] = glyphs.maxInstructions >> 8
          data[27] = glyphs.maxInstructions & 0xff
        }
        break
      }
    }
    tables.push({ tag: t.tag, data })
  }
  if (glyphs !== null && !raw.has('loca')) tables.push({ tag: 'loca', data: glyphs.loca })
  return buildSfnt(version, tables)
}
