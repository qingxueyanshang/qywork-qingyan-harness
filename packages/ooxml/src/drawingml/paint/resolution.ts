/**
 * 图片文件记录的分辨率（每英寸像素数），平铺图片填充按它计算单元尺寸（见 `fill.ts` 的 `paintImageFill`）。
 *
 * 实测（WPS 演示导出图，120 × 90 的图片平铺，`blipFill/@dpi` 不起作用）：
 * - PNG 读取 `pHYs`，单位为米时换算为每英寸；单位为 0 或没有 `pHYs` 时为 96。
 * - JPEG 有 JFIF 段时只读取 JFIF 的密度：单位 1 为每英寸、2 为每厘米，单位 0 时为 96，不读取 EXIF；
 *   没有 JFIF 段时读取 EXIF 的 `XResolution`、`YResolution`。
 * - BMP 读取 `biXPelsPerMeter`、`biYPelsPerMeter`；GIF 与其他格式为 96。
 * 只读取文件头，不解码像素；文件损坏或截断时按没有记录处理。
 */

export interface ImageResolution {
  readonly x: number
  readonly y: number
}

/** 文件中没有分辨率记录时的分辨率。 */
export const SCREEN_RESOLUTION: ImageResolution = { x: 96, y: 96 }

const INCH_PER_METER = 0.0254
const CM_PER_INCH = 2.54

function u16be(b: Uint8Array, i: number): number {
  return (b[i]! << 8) | b[i + 1]!
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
}

function u32le(b: Uint8Array, i: number): number {
  return (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0
}

function positive(x: number, y: number): ImageResolution | null {
  return x > 0 && y > 0 && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function png(b: Uint8Array): ImageResolution | null {
  let i = 8
  while (i + 8 <= b.length) {
    const length = u32be(b, i)
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!)
    if (type === 'IDAT' || type === 'IEND') return null
    if (type === 'pHYs' && length >= 9 && i + 17 <= b.length) {
      if (b[i + 16] !== 1) return null
      return positive(u32be(b, i + 8) * INCH_PER_METER, u32be(b, i + 12) * INCH_PER_METER)
    }
    i += 12 + length
  }
  return null
}

/** EXIF（TIFF 结构）第 0 个 IFD 中的分辨率；`t` 为 TIFF 头在 `b` 中的位置。 */
function exif(b: Uint8Array, t: number, end: number): ImageResolution | null {
  if (t + 8 > end) return null
  const little = b[t] === 0x49
  const u16 = (i: number) => (little ? b[i]! | (b[i + 1]! << 8) : u16be(b, i))
  const u32 = (i: number) => (little ? u32le(b, i) : u32be(b, i))
  const ifd = t + u32(t + 4)
  if (ifd + 2 > end) return null
  const count = u16(ifd)
  let x = 0
  let y = 0
  let unit = 2
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > end) break
    const tag = u16(e)
    if (tag === 296) unit = u16(e + 8)
    if (tag !== 282 && tag !== 283) continue
    const at = t + u32(e + 8)
    if (at + 8 > end) continue
    const den = u32(at + 4)
    const value = den === 0 ? 0 : u32(at) / den
    if (tag === 282) x = value
    else y = value
  }
  if (unit === 3) return positive(x * CM_PER_INCH, y * CM_PER_INCH)
  return unit === 2 ? positive(x, y) : null
}

function jpeg(b: Uint8Array): ImageResolution | null {
  let i = 2
  let fromExif: ImageResolution | null = null
  while (i + 4 <= b.length && b[i] === 0xff) {
    const marker = b[i + 1]!
    if (marker === 0xda || marker === 0xd9) break
    const length = u16be(b, i + 2)
    const start = i + 4
    const end = Math.min(b.length, i + 2 + length)
    if (marker === 0xe0 && end - start >= 12 && ascii(b, start, 5) === 'JFIF\u0000') {
      const units = b[start + 7]
      const x = u16be(b, start + 8)
      const y = u16be(b, start + 10)
      if (units === 1) return positive(x, y)
      if (units === 2) return positive(x * CM_PER_INCH, y * CM_PER_INCH)
      return null
    }
    if (marker === 0xe1 && fromExif === null && ascii(b, start, 6) === 'Exif\u0000\u0000')
      fromExif = exif(b, start + 6, end)
    i += 2 + length
  }
  return fromExif
}

function bmp(b: Uint8Array): ImageResolution | null {
  if (b.length < 46 || u32le(b, 14) < 40) return null
  return positive(u32le(b, 38) * INCH_PER_METER, u32le(b, 42) * INCH_PER_METER)
}

function ascii(b: Uint8Array, i: number, n: number): string {
  let s = ''
  for (let k = 0; k < n && i + k < b.length; k++) s += String.fromCharCode(b[i + k]!)
  return s
}

/** 按文件头识别格式并读取分辨率；没有记录、格式不支持或文件损坏时为 `SCREEN_RESOLUTION`。 */
export function imageResolution(bytes: Uint8Array): ImageResolution {
  const b = bytes
  let found: ImageResolution | null = null
  if (b.length >= 8 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) found = png(b)
  else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) found = jpeg(b)
  else if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) found = bmp(b)
  return found ?? SCREEN_RESOLUTION
}
