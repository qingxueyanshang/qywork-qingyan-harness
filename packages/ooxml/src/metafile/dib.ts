/**
 * 设备无关位图（DIB）解码为非预乘的 RGBA 像素，行序自上而下。
 *
 * - 信息头为 `BITMAPCOREHEADER`（12 字节）或 `BITMAPINFOHEADER` 及其扩展（40、52、56、108、124 字节）。
 * - 支持 1、4、8 位调色板与 16、24、32 位色深；压缩方式只支持 `BI_RGB` 与 `BI_BITFIELDS`，其余返回 `null`。
 * - 颜色表只支持 RGB 颜色（`DIB_RGB_COLORS`）；调色板索引（`DIB_PAL_COLORS`）由调用方判定为不支持。
 * - `alpha` 为真时 32 位像素的第 4 字节为预乘的不透明度（`AlphaBlend` 的 `AC_SRC_ALPHA`），解码时还原为非预乘；
 *   为假时像素一律不透明。
 */

export interface Pixels {
  readonly width: number
  readonly height: number
  /** 非预乘的 RGBA，自上而下逐行，每行 `width × 4` 字节。 */
  readonly data: Uint8ClampedArray<ArrayBuffer>
}

/** 位图头的尺寸与行序。 */
interface DibInfo {
  readonly width: number
  readonly height: number
  /** 文件中的行序为自下而上（`biHeight` 为正）。 */
  readonly bottomUp: boolean
}

const BI_RGB = 0
const BI_BITFIELDS = 3

/** 读取位图头；头部不完整或尺寸为 0 时返回 `null`。 */
function dibInfo(bmi: Uint8Array): DibInfo | null {
  if (bmi.length < 12) return null
  const v = new DataView(bmi.buffer, bmi.byteOffset, bmi.byteLength)
  const size = v.getUint32(0, true)
  if (size === 12) {
    const width = v.getUint16(4, true)
    const height = v.getUint16(6, true)
    return width === 0 || height === 0 ? null : { width, height, bottomUp: true }
  }
  if (size < 40 || bmi.length < 40) return null
  const width = v.getInt32(4, true)
  const h = v.getInt32(8, true)
  if (width <= 0 || h === 0) return null
  return { width, height: Math.abs(h), bottomUp: h > 0 }
}

/** 掩码的右移位数与位宽。 */
function maskShift(mask: number): { shift: number; bits: number } {
  if (mask === 0) return { shift: 0, bits: 0 }
  let shift = 0
  while (((mask >>> shift) & 1) === 0) shift++
  let bits = 0
  while (((mask >>> (shift + bits)) & 1) === 1) bits++
  return { shift, bits }
}

function channel(value: number, mask: number): number {
  const { shift, bits } = maskShift(mask)
  if (bits === 0) return 0
  const max = 2 ** bits - 1
  return Math.round((((value & mask) >>> shift) * 255) / max)
}

/**
 * 解码 `bmi`（位图头与颜色表）与 `bits`（像素数据）。格式不支持、数据不完整时返回 `null`。
 */
export function decodeDib(bmi: Uint8Array, bits: Uint8Array, alpha: boolean): Pixels | null {
  const info = dibInfo(bmi)
  if (info === null) return null
  const v = new DataView(bmi.buffer, bmi.byteOffset, bmi.byteLength)
  const size = v.getUint32(0, true)
  const core = size === 12
  const bpp = core ? v.getUint16(10, true) : v.getUint16(14, true)
  const compression = core ? BI_RGB : v.getUint32(16, true)
  if (compression !== BI_RGB && compression !== BI_BITFIELDS) return null
  if (compression === BI_BITFIELDS && bpp !== 16 && bpp !== 32) return null
  const { width, height, bottomUp } = info
  const stride = Math.ceil((width * bpp) / 32) * 4
  if (bits.length < stride * height) return null
  const out = new Uint8ClampedArray(width * height * 4)
  if (bpp === 1 || bpp === 4 || bpp === 8) {
    const used = core ? 0 : v.getUint32(32, true)
    const count = used === 0 ? 2 ** bpp : Math.min(used, 2 ** bpp)
    const entry = core ? 3 : 4
    if (bmi.length < size + count * entry) return null
    const palette: number[] = []
    for (let i = 0; i < count; i++) {
      const at = size + i * entry
      palette.push((bmi[at + 2]! << 16) | (bmi[at + 1]! << 8) | bmi[at]!)
    }
    const mask = 2 ** bpp - 1
    for (let y = 0; y < height; y++) {
      const row = (bottomUp ? height - 1 - y : y) * stride
      for (let x = 0; x < width; x++) {
        const bit = x * bpp
        const index = (bits[row + (bit >> 3)]! >> (8 - bpp - (bit & 7))) & mask
        const c = palette[index] ?? 0
        const o = (y * width + x) * 4
        out[o] = c >> 16
        out[o + 1] = (c >> 8) & 0xff
        out[o + 2] = c & 0xff
        out[o + 3] = 255
      }
    }
    return { width, height, data: out }
  }
  if (bpp !== 16 && bpp !== 24 && bpp !== 32) return null
  let masks: [number, number, number] =
    bpp === 16 ? [0x7c00, 0x03e0, 0x001f] : [0xff0000, 0x00ff00, 0x0000ff]
  if (compression === BI_BITFIELDS) {
    // 信息头为 40 字节时掩码紧随其后；更长的信息头中掩码位于第 40 字节起。
    if (bmi.length < 52) return null
    masks = [v.getUint32(40, true), v.getUint32(44, true), v.getUint32(48, true)]
  }
  const bv = new DataView(bits.buffer, bits.byteOffset, bits.byteLength)
  for (let y = 0; y < height; y++) {
    const row = (bottomUp ? height - 1 - y : y) * stride
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (bpp === 24) {
        const at = row + x * 3
        out[o] = bits[at + 2]!
        out[o + 1] = bits[at + 1]!
        out[o + 2] = bits[at]!
        out[o + 3] = 255
        continue
      }
      const value = bpp === 16 ? bv.getUint16(row + x * 2, true) : bv.getUint32(row + x * 4, true)
      let r = channel(value, masks[0])
      let g = channel(value, masks[1])
      let b = channel(value, masks[2])
      let a = 255
      if (alpha && bpp === 32) {
        a = value >>> 24
        if (a === 0) r = g = b = 0
        else if (a < 255) {
          r = Math.min(255, Math.round((r * 255) / a))
          g = Math.min(255, Math.round((g * 255) / a))
          b = Math.min(255, Math.round((b * 255) / a))
        }
      }
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }
  return { width, height, data: out }
}
