/**
 * CFB 复合文档：读取目录与根存储下的流。
 *
 * - 只遍历根存储的直接子项。名称转为大写：CFB 的目录名按不区分大小写比较，实际文件中存在 `WORKBOOK` 等写法。
 * - 长度小于迷你流阈值（文件头第 56 字节，规范定为 4096）的流位于迷你流中，以 64 字节为单位经迷你 FAT 链接；
 *   其余流位于普通扇区中，经 FAT 链接。迷你流本身是根目录项所指的普通流。
 * - 文件头无效、目录扇区超出数据范围、目录链或目录树成环时 `openCfb` 返回 `null`；目录完整而某个流的链
 *   不完整（越界、成环、长度不足）时，该流的 `stream` 返回 `null`。
 * - 流长度只取目录项第 120 字节起的低 32 位：主文档流不超过 4 GB，高 32 位在版本 3 中规定为 0。
 */

const HEADER_SIZE = 512
const HEADER_DIFAT_COUNT = 109
const ENTRY_SIZE = 128
const MINI_SECTOR_SIZE = 64
const MAX_REGULAR_SECTOR = 0xfffffffa
const END_OF_CHAIN = 0xfffffffe
const NO_STREAM = 0xffffffff
const TYPE_STREAM = 2
const TYPE_ROOT = 5

export interface CfbFile {
  /** 根存储下各流的名称，大写。 */
  readonly names: ReadonlySet<string>
  /** 读取根存储下名为 `name` 的流（不区分大小写）。流不存在或链不完整时为 `null`。 */
  stream(name: string): Uint8Array | null
}

interface StreamEntry {
  readonly start: number
  readonly size: number
}

export function openCfb(view: DataView): CfbFile | null {
  if (view.byteLength < HEADER_SIZE || view.getUint16(28, true) !== 0xfffe) return null
  const shift = view.getUint16(30, true)
  if (shift !== 9 && shift !== 12) return null
  const sectorSize = 1 << shift
  const perFatSector = sectorSize / 4
  const difatCount = view.getUint32(72, true)
  const maxSectors = Math.ceil(view.byteLength / sectorSize)

  /** 扇区 `sector` 内第 `byte` 字节的绝对偏移；扇区号无效或所需的 `length` 字节超出数据时返回 -1。 */
  const offsetIn = (sector: number, byte: number, length: number): number => {
    if (sector > MAX_REGULAR_SECTOR) return -1
    const offset = (sector + 1) * sectorSize + byte
    return offset + length <= view.byteLength ? offset : -1
  }

  /** 第 `index` 个 FAT 扇区的位置：前 109 个记在文件头，其余记在 DIFAT 扇区链中，每个 DIFAT 扇区末项指向下一个。 */
  const fatSectorAt = (index: number): number => {
    if (index < HEADER_DIFAT_COUNT) return view.getUint32(76 + index * 4, true)
    let rest = index - HEADER_DIFAT_COUNT
    let difat = view.getUint32(68, true)
    for (let step = 0; step < difatCount; step++) {
      const slot = rest < perFatSector - 1 ? rest : perFatSector - 1
      const offset = offsetIn(difat, slot * 4, 4)
      if (offset < 0) return -1
      if (slot === rest) return view.getUint32(offset, true)
      difat = view.getUint32(offset, true)
      rest -= perFatSector - 1
    }
    return -1
  }

  const nextSector = (sector: number): number => {
    const fat = fatSectorAt(Math.floor(sector / perFatSector))
    if (fat < 0) return -1
    const offset = offsetIn(fat, (sector % perFatSector) * 4, 4)
    return offset < 0 ? -1 : view.getUint32(offset, true)
  }

  /** 自 `start` 起的扇区链；越界、成环或链中出现无效扇区号时返回 `null`。 */
  const chain = (start: number): number[] | null => {
    const out: number[] = []
    for (let s = start; s !== END_OF_CHAIN; s = nextSector(s)) {
      if (s < 0 || s > MAX_REGULAR_SECTOR || out.length >= maxSectors) return null
      out.push(s)
    }
    return out
  }

  const directory = chain(view.getUint32(48, true))
  if (directory === null) return null
  const perDirectorySector = sectorSize / ENTRY_SIZE
  const entryAt = (id: number): number => {
    const sector = directory[Math.floor(id / perDirectorySector)]
    return sector === undefined
      ? -1
      : offsetIn(sector, (id % perDirectorySector) * ENTRY_SIZE, ENTRY_SIZE)
  }

  const root = entryAt(0)
  if (root < 0 || view.getUint8(root + 66) !== TYPE_ROOT) return null
  // 根存储的子项组成以 `child` 为根、经左右兄弟相连的二叉树；访问数超过目录项总数说明成环。
  const entries = new Map<string, StreamEntry>()
  const pending = [view.getUint32(root + 76, true)]
  const limit = directory.length * perDirectorySector
  let visited = 0
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === NO_STREAM) continue
    const entry = entryAt(id)
    if (entry < 0 || ++visited > limit) return null
    if (view.getUint8(entry + 66) === TYPE_STREAM) {
      entries.set(entryName(view, entry), {
        start: view.getUint32(entry + 116, true),
        size: view.getUint32(entry + 120, true),
      })
    }
    pending.push(view.getUint32(entry + 68, true), view.getUint32(entry + 72, true))
  }

  /** 按扇区链拼接 `size` 字节；链不足 `size` 字节或扇区越界时返回 `null`。 */
  const regular = (start: number, size: number): Uint8Array | null => {
    const sectors = chain(start)
    if (sectors === null || sectors.length * sectorSize < size) return null
    const out = new Uint8Array(size)
    for (let i = 0; i * sectorSize < size; i++) {
      const length = Math.min(sectorSize, size - i * sectorSize)
      const offset = offsetIn(sectors[i]!, 0, length)
      if (offset < 0) return null
      out.set(new Uint8Array(view.buffer, view.byteOffset + offset, length), i * sectorSize)
    }
    return out
  }

  const cutoff = view.getUint32(56, true)
  let mini: { readonly data: Uint8Array; readonly fat: DataView } | null | undefined
  /** 迷你流与迷你 FAT，首次读取迷你流中的流时取得；任一不完整时为 `null`。 */
  const miniStream = () => {
    if (mini !== undefined) return mini
    const data = regular(view.getUint32(root + 116, true), view.getUint32(root + 120, true))
    const fatStart = view.getUint32(60, true)
    const fatBytes =
      fatStart === END_OF_CHAIN
        ? new Uint8Array(0)
        : regular(fatStart, view.getUint32(64, true) * sectorSize)
    mini =
      data === null || fatBytes === null
        ? null
        : { data, fat: new DataView(fatBytes.buffer, fatBytes.byteOffset, fatBytes.byteLength) }
    return mini
  }

  const fromMini = (start: number, size: number): Uint8Array | null => {
    const m = miniStream()
    if (m === null) return null
    const out = new Uint8Array(size)
    const count = m.fat.byteLength / 4
    let s = start
    for (let i = 0; i * MINI_SECTOR_SIZE < size; i++) {
      const offset = s * MINI_SECTOR_SIZE
      const length = Math.min(MINI_SECTOR_SIZE, size - i * MINI_SECTOR_SIZE)
      if (s > MAX_REGULAR_SECTOR || i > count || offset + length > m.data.length) return null
      out.set(m.data.subarray(offset, offset + length), i * MINI_SECTOR_SIZE)
      s = s < count ? m.fat.getUint32(s * 4, true) : END_OF_CHAIN
    }
    return out
  }

  return {
    names: new Set(entries.keys()),
    stream(name) {
      const entry = entries.get(name.toUpperCase())
      if (entry === undefined) return null
      return entry.size < cutoff
        ? fromMini(entry.start, entry.size)
        : regular(entry.start, entry.size)
    },
  }
}

/** 名称为 UTF-16LE，最多 31 个码元；第 64 字节处的长度以字节计，含结尾的空字符。 */
function entryName(view: DataView, entry: number): string {
  const units = Math.min(Math.max(Math.floor(view.getUint16(entry + 64, true) / 2) - 1, 0), 31)
  let name = ''
  for (let i = 0; i < units; i++) name += String.fromCharCode(view.getUint16(entry + i * 2, true))
  return name.toUpperCase()
}
