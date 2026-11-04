/**
 * OfficeArt 图片库（BStore）：按形状属性 `pib`（从 1 起）取得图片。
 *
 * - BStore 位于绘图组容器（`DGG_CONTAINER`）中，每项为一个 FBSE：36 字节头、`cbName` 字节的名称，其后为内嵌的图片记录；
 *   没有内嵌记录时图片记录位于另一个流（`delay`，.ppt 为 `Pictures` 流）中 FBSE 的 `foDelay` 处。
 * - 图片记录：实例为奇数时有两个 16 字节标识，否则一个。
 *   - 位图（JPEG、PNG、DIB）在标识之后另有 1 字节标记，其后为文件数据；DIB 没有文件头，补上 14 字节的 BMP 文件头后按 `image/bmp` 给出。
 *   - 图元文件（EMF、WMF）在标识之后为 34 字节的图元文件头：第 0 字节起为解压后的长度，第 28 字节起为数据长度，
 *     第 32 字节为压缩方式（0 为带 zlib 头的 deflate，0xFE 为不压缩），其后为数据。WMF 数据没有可放置文件头，
 *     图片框取记录设置的窗口（`../metafile/wmf.ts`）：图元文件头中的边界矩形在 .ppt 语料中与记录的窗口不一致，不使用。
 * - PICT、TIFF、无法解压的图元文件与位置无效的项为 `null`。
 */

import { inflate } from '../zip/index.ts'
import { ART, type ArtRecord, readArtRecord, readArtRecords } from './records.ts'

export interface Blip {
  readonly contentType: string
  readonly bytes: Uint8Array
}

const BITMAPS: Readonly<Record<number, string>> = {
  [ART.BLIP_JPEG]: 'image/jpeg',
  [ART.BLIP_JPEG_CMYK]: 'image/jpeg',
  [ART.BLIP_PNG]: 'image/png',
}

const METAFILES: Readonly<Record<number, string>> = {
  [ART.BLIP_EMF]: 'image/x-emf',
  [ART.BLIP_WMF]: 'image/x-wmf',
}

const METAFILE_HEADER = 34
const COMPRESSED = 0x00
const UNCOMPRESSED = 0xfe

/** BITMAPINFOHEADER 之后的调色板与位域掩码的字节数。 */
function dibColorBytes(view: DataView): number {
  const size = view.getUint32(0, true)
  if (size < 40) {
    const core = view.getUint16(10, true)
    return core <= 8 ? 3 << core : 0
  }
  const bits = view.getUint16(14, true)
  const compression = view.getUint32(16, true)
  const used = view.getUint32(32, true)
  const masks =
    size === 40 && (compression === 3 || compression === 6) ? (compression === 3 ? 12 : 16) : 0
  return masks + 4 * (used !== 0 ? used : bits <= 8 ? 1 << bits : 0)
}

/** 没有文件头的 DIB 补上 BMP 文件头；信息头不完整时为 `null`。 */
function bmpFile(dib: Uint8Array): Uint8Array | null {
  if (dib.length < 12) return null
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength)
  if (dib.length < view.getUint32(0, true)) return null
  const offset = 14 + view.getUint32(0, true) + dibColorBytes(view)
  const out = new Uint8Array(14 + dib.length)
  const head = new DataView(out.buffer)
  head.setUint16(0, 0x4d42, true)
  head.setUint32(2, out.length, true)
  head.setUint32(10, offset, true)
  out.set(dib, 14)
  return out
}

async function metafile(blip: ArtRecord, start: number): Promise<Uint8Array | null> {
  const data = blip.data
  if (data.length < start + METAFILE_HEADER) return null
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const size = view.getUint32(start, true)
  const saved = view.getUint32(start + 28, true)
  const body = data.slice(start + METAFILE_HEADER, start + METAFILE_HEADER + saved)
  const compression = data[start + 32]
  if (compression === UNCOMPRESSED) return body
  if (compression !== COMPRESSED) return null
  const out = await inflate(body, 'deflate')
  return out !== null && out.length === size ? out : null
}

/** 一条图片记录的内容；种类不支持或数据不完整时为 `null`。 */
async function readBlip(blip: ArtRecord): Promise<Blip | null> {
  const start = blip.instance & 1 ? 32 : 16
  const bitmap = BITMAPS[blip.type]
  if (bitmap !== undefined) {
    return blip.data.length > start + 1
      ? { contentType: bitmap, bytes: blip.data.slice(start + 1) }
      : null
  }
  if (blip.type === ART.BLIP_DIB) {
    const bytes = bmpFile(blip.data.subarray(start + 1))
    return bytes === null ? null : { contentType: 'image/bmp', bytes }
  }
  const type = METAFILES[blip.type]
  if (type === undefined) return null
  const bytes = await metafile(blip, start)
  return bytes === null ? null : { contentType: type, bytes }
}

export interface BlipStore {
  /** 图片库的项数。 */
  readonly size: number
  /** 第 `pib` 项（从 1 起）；超出范围或无法读取时为 `null`。 */
  read(pib: number): Promise<Blip | null>
}

/**
 * 一个 FBSE 的图片：内嵌的图片记录，没有时为 `delay` 流中 `foDelay` 处的记录。不是 FBSE、数据不完整或种类不支持时为 `null`。
 * 图片库的各项与 .doc 内嵌图片（`Data` 流中 PICF 之后的内联容器）中的 FBSE 都经此读取。
 */
export async function readFbse(entry: ArtRecord, delay: Uint8Array | null): Promise<Blip | null> {
  if (entry.type !== ART.FBSE || entry.data.length < 36) return null
  const view = new DataView(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
  const inline = readArtRecords(entry.data.subarray(36 + entry.data[33]!))[0]
  const blip = inline ?? (delay === null ? null : readArtRecord(delay, view.getUint32(28, true)))
  return blip === null ? null : await readBlip(blip)
}

/**
 * `group` 为绘图组容器的数据（容器内的子记录序列），`delay` 为 FBSE 中没有内嵌图片记录时图片记录所在的流
 * （没有时为 `null`）。只在读取某一项时解压该项。
 */
export function openBlipStore(group: readonly ArtRecord[], delay: Uint8Array | null): BlipStore {
  const store = group.find((r) => r.type === ART.BSTORE_CONTAINER)
  const entries = store === undefined ? [] : readArtRecords(store.data)
  return {
    size: entries.length,
    async read(pib) {
      const entry = entries[pib - 1]
      return entry === undefined ? null : await readFbse(entry, delay)
    },
  }
}

/** 图片库的全部项，按 `pib` 的顺序（下标为 `pib - 1`）。 */
export async function readBlipStore(
  group: readonly ArtRecord[],
  delay: Uint8Array | null,
): Promise<(Blip | null)[]> {
  const store = openBlipStore(group, delay)
  const out: (Blip | null)[] = []
  for (let pib = 1; pib <= store.size; pib++) out.push(await store.read(pib))
  return out
}
