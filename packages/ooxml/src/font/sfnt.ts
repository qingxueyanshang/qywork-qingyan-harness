/**
 * sfnt 容器：TTC 合集头、表目录、按表取字节、从合集中拆出单个字体。
 *
 * 只依赖 `DataView` 与 `Uint8Array`，服务端与浏览器共用同一份实现。
 * 表记录中的偏移一律相对于文件起点（TTC 中各字体的表目录同样如此），因此表字节始终从整个文件中截取。
 */

/** 字节不符合 sfnt 结构。调用方据此区分「不是可读的字体」与其他错误。 */
export class FontFormatError extends Error {
  override name = 'FontFormatError'
}

export interface TableRecord {
  tag: string
  checksum: number
  offset: number
  length: number
}

export interface SfntFace {
  /** `0x00010000` 或 `true` 为 TrueType 轮廓，`OTTO` 为 CFF 轮廓。 */
  version: number
  tables: ReadonlyMap<string, TableRecord>
}

const TTCF = 0x74746366
const OTTO = 0x4f54544f
const TRUE = 0x74727565
const SFNT_VERSIONS = new Set([0x00010000, OTTO, TRUE])

/** CFF 轮廓的字体（`OTTO`）。服务端据此选择 `font/otf` 或 `font/ttf`。 */
export function isCffOutline(face: SfntFace): boolean {
  return face.version === OTTO
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function tagAt(v: DataView, offset: number): string {
  return String.fromCharCode(
    v.getUint8(offset),
    v.getUint8(offset + 1),
    v.getUint8(offset + 2),
    v.getUint8(offset + 3),
  )
}

function need(bytes: Uint8Array, end: number, what: string): void {
  if (end > bytes.byteLength) throw new FontFormatError(`${what}超出已读取的字节范围`)
}

/**
 * 各字体的表目录偏移。单个字体文件返回 `[0]`。
 */
function faceOffsets(bytes: Uint8Array): number[] {
  need(bytes, 12, '文件头')
  const v = view(bytes)
  if (v.getUint32(0) !== TTCF) return [0]
  const count = v.getUint32(8)
  if (count === 0) throw new FontFormatError('合集中没有字体')
  need(bytes, 12 + 4 * count, 'TTC 合集头')
  return Array.from({ length: count }, (_, i) => v.getUint32(12 + 4 * i))
}

/**
 * 解析文件中全部字体的表目录。
 *
 * `bytes` 必须从文件起点开始，覆盖 TTC 合集头与全部表目录；表数据本身可以不在其中，
 * 此时以 `fileSize` 核对各表是否越界。服务端建立索引时只读取文件开头，依赖这一约定。
 */
export function readFaces(bytes: Uint8Array, fileSize: number = bytes.byteLength): SfntFace[] {
  const v = view(bytes)
  return faceOffsets(bytes).map((at) => {
    need(bytes, at + 12, '表目录')
    const version = v.getUint32(at)
    if (!SFNT_VERSIONS.has(version)) throw new FontFormatError('不是 TrueType 或 OpenType 字体')
    const count = v.getUint16(at + 4)
    need(bytes, at + 12 + 16 * count, '表目录')
    const tables = new Map<string, TableRecord>()
    for (let i = 0; i < count; i++) {
      const rec = at + 12 + 16 * i
      const record: TableRecord = {
        tag: tagAt(v, rec),
        checksum: v.getUint32(rec + 4),
        offset: v.getUint32(rec + 8),
        length: v.getUint32(rec + 12),
      }
      if (record.offset + record.length > fileSize) {
        throw new FontFormatError(`表 ${record.tag} 超出文件范围`)
      }
      tables.set(record.tag, record)
    }
    return { version, tables }
  })
}

/** 表记录；字体缺少该表时抛出 `FontFormatError`。 */
export function tableRecord(face: SfntFace, tag: string): TableRecord {
  const record = face.tables.get(tag)
  if (!record) throw new FontFormatError(`缺少 ${tag} 表`)
  return record
}

/** 从整个文件的字节中截取一张表，不复制。 */
export function tableBytes(bytes: Uint8Array, face: SfntFace, tag: string): Uint8Array {
  const { offset, length } = tableRecord(face, tag)
  need(bytes, offset + length, `表 ${tag} `)
  return bytes.subarray(offset, offset + length)
}

/** 按 4 字节对齐后求和，结果取 32 位无符号数。调用方保证填充字节为 0 且在缓冲区内。 */
function checksum(v: DataView, offset: number, length: number): number {
  let sum = 0
  const end = offset + ((length + 3) & ~3)
  for (let i = offset; i < end; i += 4) sum = (sum + v.getUint32(i)) >>> 0
  return sum
}

/**
 * 第 `index` 个字体的独立字节，可直接交给浏览器 `FontFace`。
 *
 * 单个字体文件原样返回。TTC 中的字体重写为独立的 sfnt：表按标签升序排列并 4 字节对齐，
 * 重新计算各表校验和与 `head.checkSumAdjustment`。合集中各字体共用的表（如 `glyf`）各复制一份。
 */
export function extractFace(bytes: Uint8Array, index: number): Uint8Array {
  const faces = readFaces(bytes)
  const face = faces[index]
  if (!face) throw new FontFormatError(`合集中没有第 ${index} 个字体`)
  if (view(bytes).getUint32(0) !== TTCF) return bytes

  const tables = [...face.tables.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1))
  const headerLength = 12 + 16 * tables.length
  let size = headerLength
  const placed = tables.map((t) => {
    const at = size
    size += (t.length + 3) & ~3
    return at
  })

  const out = new Uint8Array(size)
  const v = view(out)
  const selector = Math.floor(Math.log2(tables.length))
  const searchRange = 2 ** selector * 16
  v.setUint32(0, face.version)
  v.setUint16(4, tables.length)
  v.setUint16(6, searchRange)
  v.setUint16(8, selector)
  v.setUint16(10, tables.length * 16 - searchRange)

  let headAt = -1
  tables.forEach((t, i) => {
    const at = placed[i]!
    out.set(bytes.subarray(t.offset, t.offset + t.length), at)
    if (t.tag === 'head') {
      headAt = at
      // 校验和按 checkSumAdjustment 为 0 计算。
      v.setUint32(at + 8, 0)
    }
    const rec = 12 + 16 * i
    for (let k = 0; k < 4; k++) v.setUint8(rec + k, t.tag.charCodeAt(k))
    v.setUint32(rec + 4, checksum(v, at, t.length))
    v.setUint32(rec + 8, at)
    v.setUint32(rec + 12, t.length)
  })
  if (headAt < 0) throw new FontFormatError('缺少 head 表')
  v.setUint32(headAt + 8, (0xb1b0afba - checksum(v, 0, size)) >>> 0)
  return out
}
