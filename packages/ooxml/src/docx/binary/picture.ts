/**
 * .doc 的内嵌图片：图片字符（0x01）的 sprmCPicLocation 给出 `Data` 流中 PICF 的位置。
 *
 * - PICF 68 字节：`lcb` 为 PICF 与其后数据的总长，`cbHeader` 为 PICF 的长度，`mfpf.mm` 为其后数据的种类；第 28 字节起为
 *   图片的原始尺寸 `dxaGoal`、`dyaGoal`（缇）与缩放 `mx`、`my`（千分之一），显示尺寸为两者之积。
 * - `mm` 为 MM_SHAPE（0x64）或 MM_SHAPEFILE（0x66，其后另有一个以长度字节开头的文件名）时，其后为 OfficeArt 内联容器：
 *   形状容器与若干 FBSE。形状的 `pib` 是文档图片库中的序号而不是容器中的序号，容器只带图片所用的 FBSE，图片取第一个。
 * - 其余 `mm` 与图片种类不支持时 `blip` 为 `null`，只给出尺寸。内联容器中没有 FBSE 时没有图片数据（`empty`）：SHAPE 域中画布
 *   的占位即如此，图形是同一域结果中的浮动对象。
 */

import { type Blip, readFbse } from '../../officeart/blip.ts'
import { ART, readArtRecords } from '../../officeart/records.ts'
import { i16, u16, u32 } from './sprm.ts'

export interface DocPicture {
  /** 显示尺寸（磅）。 */
  readonly width: number
  readonly height: number
  readonly blip: Blip | null
  /** 没有图片数据：只占对象框，不是无法显示的图片。 */
  readonly empty: boolean
}

const PICF_SIZE = 68
const MM_SHAPE = 0x64
const MM_SHAPEFILE = 0x66
const TWIP = 20

/** `Data` 流中第 `at` 字节起的图片；PICF 超出流的范围或尺寸不为正时为 `null`。 */
export async function readPicture(data: Uint8Array, at: number): Promise<DocPicture | null> {
  if (at + PICF_SIZE > data.length) return null
  const end = Math.min(data.length, at + u32(data, at))
  const width = (i16(data, at + 28) * u16(data, at + 32)) / 1000 / TWIP
  const height = (i16(data, at + 30) * u16(data, at + 34)) / 1000 / TWIP
  if (!(width > 0 && height > 0)) return null
  const mm = i16(data, at + 6)
  let p = at + u16(data, at + 4)
  if (mm === MM_SHAPEFILE) p += 1 + (data[p] ?? 0)
  const fbse =
    mm === MM_SHAPE || mm === MM_SHAPEFILE
      ? readArtRecords(data.subarray(Math.min(p, end), end)).find((r) => r.type === ART.FBSE)
      : undefined
  if (fbse === undefined)
    return { width, height, blip: null, empty: mm === MM_SHAPE || mm === MM_SHAPEFILE }
  return { width, height, blip: await readFbse(fbse, data), empty: false }
}
