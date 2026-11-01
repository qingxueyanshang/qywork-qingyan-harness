/**
 * CFB 复合文档：只读取根存储下的直接子项，返回其中流的名称，用于区分加密的 OOXML 与旧二进制格式。
 *
 * - 只读取文件头、跟随目录链所需的 FAT 项与目录扇区，不读取任何流的内容，也不读取迷你流。
 * - 名称转为大写返回：CFB 的目录名按不区分大小写比较，实际文件中存在 `WORKBOOK` 等写法。
 * - 结构不完整（文件头无效、扇区超出数据范围、链或目录树成环）时返回 `null`。
 */

const HEADER_SIZE = 512
const HEADER_DIFAT_COUNT = 109
const ENTRY_SIZE = 128
const MAX_REGULAR_SECTOR = 0xfffffffa
const END_OF_CHAIN = 0xfffffffe
const NO_STREAM = 0xffffffff
const TYPE_STREAM = 2
const TYPE_ROOT = 5

export function cfbRootStreams(view: DataView): Set<string> | null {
  if (view.byteLength < HEADER_SIZE || view.getUint16(28, true) !== 0xfffe) return null
  const shift = view.getUint16(30, true)
  if (shift !== 9 && shift !== 12) return null
  const sectorSize = 1 << shift
  const perFatSector = sectorSize / 4
  const difatCount = view.getUint32(72, true)

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

  const directory: number[] = []
  const maxSectors = Math.ceil(view.byteLength / sectorSize)
  for (let s = view.getUint32(48, true); s !== END_OF_CHAIN; s = nextSector(s)) {
    if (s < 0 || s > MAX_REGULAR_SECTOR || directory.length >= maxSectors) return null
    directory.push(s)
  }

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
  const names = new Set<string>()
  const pending = [view.getUint32(root + 76, true)]
  const limit = directory.length * perDirectorySector
  let visited = 0
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (id === NO_STREAM) continue
    const entry = entryAt(id)
    if (entry < 0 || ++visited > limit) return null
    if (view.getUint8(entry + 66) === TYPE_STREAM) names.add(entryName(view, entry))
    pending.push(view.getUint32(entry + 68, true), view.getUint32(entry + 72, true))
  }
  return names
}

/** 名称为 UTF-16LE，最多 31 个码元；第 64 字节处的长度以字节计，含结尾的空字符。 */
function entryName(view: DataView, entry: number): string {
  const units = Math.min(Math.max(Math.floor(view.getUint16(entry + 64, true) / 2) - 1, 0), 31)
  let name = ''
  for (let i = 0; i < units; i++) name += String.fromCharCode(view.getUint16(entry + i * 2, true))
  return name.toUpperCase()
}
