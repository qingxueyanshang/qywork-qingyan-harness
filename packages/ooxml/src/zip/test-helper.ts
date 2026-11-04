/**
 * 测试夹具：生成含给定流的 CFB 复合文档（512 字节扇区，不使用 DIFAT）。
 *
 * - 长度小于 4096 的流写入迷你流，其余写入普通扇区；扇区依次为 FAT、目录、迷你 FAT、迷你流、各普通流。
 * - 根存储的子项从目录项 1 起依次以右兄弟相连，名称按给定写法写入。
 */

const SECTOR = 512
const MINI = 64
const CUTOFF = 4096
const FREE = 0xffffffff
const END = 0xfffffffe
const FAT_MARK = 0xfffffffd

export function buildCfb(streams: Record<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  const items = Object.entries(streams)
  const sectorsOf = (bytes: number) => Math.ceil(bytes / SECTOR)
  const small = items.filter(([, d]) => d.length < CUTOFF)
  const miniOffsets = new Map<string, number>()
  let miniSectors = 0
  for (const [name, d] of small) {
    miniOffsets.set(name, miniSectors)
    miniSectors += Math.ceil(d.length / MINI)
  }
  const directorySectors = sectorsOf((items.length + 1) * 128)
  const miniFatSectors = sectorsOf(miniSectors * 4)
  const miniStreamSectors = sectorsOf(miniSectors * MINI)
  const regular = items.filter(([, d]) => d.length >= CUTOFF)
  const dataSectors =
    directorySectors +
    miniFatSectors +
    miniStreamSectors +
    regular.reduce((n, [, d]) => n + sectorsOf(d.length), 0)
  let fatSectors = 1
  while (fatSectors * 128 < fatSectors + dataSectors) fatSectors++

  const fat: number[] = Array.from({ length: fatSectors * 128 }, () => FREE)
  let next = 0
  const run = (count: number): number => {
    const start = next
    for (let i = 0; i < count; i++) fat[start + i] = i === count - 1 ? END : start + i + 1
    next += count
    return count === 0 ? END : start
  }
  for (let i = 0; i < fatSectors; i++) fat[next++] = FAT_MARK
  const directoryStart = run(directorySectors)
  const miniFatStart = run(miniFatSectors)
  const miniStreamStart = run(miniStreamSectors)
  const regularStart = new Map(regular.map(([name, d]) => [name, run(sectorsOf(d.length))]))

  const bytes = new Uint8Array((next + 1) * SECTOR)
  const view = new DataView(bytes.buffer)
  const at = (sector: number) => (sector + 1) * SECTOR
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  view.setUint16(24, 0x3e, true)
  view.setUint16(26, 3, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, 9, true)
  view.setUint16(32, 6, true)
  view.setUint32(44, fatSectors, true)
  view.setUint32(48, directoryStart, true)
  view.setUint32(56, CUTOFF, true)
  view.setUint32(60, miniFatStart, true)
  view.setUint32(64, miniFatSectors, true)
  view.setUint32(68, END, true)
  for (let i = 0; i < 109; i++) view.setUint32(76 + i * 4, i < fatSectors ? i : FREE, true)
  for (const [i, v] of fat.entries()) {
    view.setUint32(at(Math.floor(i / 128)) + (i % 128) * 4, v, true)
  }

  for (let i = 0; i < miniSectors; i++) {
    const v = small.some(
      ([name, d]) => miniOffsets.get(name)! + Math.ceil(d.length / MINI) - 1 === i,
    )
      ? END
      : i + 1
    view.setUint32(at(miniFatStart) + i * 4, v, true)
  }
  for (const [name, d] of small) bytes.set(d, at(miniStreamStart) + miniOffsets.get(name)! * MINI)
  for (const [name, d] of regular) {
    const start = regularStart.get(name)!
    for (let i = 0; i * SECTOR < d.length; i++) {
      bytes.set(d.subarray(i * SECTOR, (i + 1) * SECTOR), at(start + i))
    }
  }

  const entry = (id: number) => at(directoryStart + Math.floor(id / 4)) + (id % 4) * 128
  const writeEntry = (id: number, name: string, type: number, start: number, size: number) => {
    const p = entry(id)
    for (let i = 0; i < name.length; i++) view.setUint16(p + i * 2, name.charCodeAt(i), true)
    view.setUint16(p + 64, (name.length + 1) * 2, true)
    view.setUint8(p + 66, type)
    view.setUint32(p + 68, FREE, true)
    view.setUint32(p + 72, id >= 1 && id < items.length ? id + 1 : FREE, true)
    view.setUint32(p + 76, id === 0 && items.length > 0 ? 1 : FREE, true)
    view.setUint32(p + 116, start, true)
    view.setUint32(p + 120, size, true)
  }
  writeEntry(0, 'Root Entry', 5, miniStreamStart, miniSectors * MINI)
  items.forEach(([name, d], i) => {
    const start = d.length < CUTOFF ? miniOffsets.get(name)! : regularStart.get(name)!
    writeEntry(i + 1, name, 2, start, d.length)
  })
  for (let id = items.length + 1; id < directorySectors * 4; id++) {
    const p = entry(id)
    view.setUint32(p + 68, FREE, true)
    view.setUint32(p + 72, FREE, true)
    view.setUint32(p + 76, FREE, true)
  }
  return bytes
}
