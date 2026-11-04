/**
 * 图案填充（填充类型 1）的图案位图：8 × 8 的单色图片，旧版本写为 DIB，PowerPoint 2007 起写为调色板 PNG。
 *
 * - 结果为 8 行，自上而下，每行一个字节，最高位为最左像素，1 为前景（填充色 `fillColor`）。
 * - 前景为图中的浅色像素。WPS 演示实测：黑白 PNG 中 62.5% 为黑色像素的图案，导出图中 62.5% 为背景色（`fillBackColor`），
 *   其余为填充色。
 * - PNG 只接受 8 × 8、位深 1–8 的调色板或灰度图，按扫描线的过滤方式还原；其他图片为 `null`。
 */

import { inflate } from '../zip/index.ts'
import type { Blip } from './blip.ts'

function luminance(r: number, g: number, b: number): number {
  return r * 0.299 + g * 0.587 + b * 0.114
}

/** 8 个像素的亮度为一行：亮于 128 的像素为 1。 */
function row(values: readonly number[]): number {
  return values.reduce((v, l, i) => (l > 128 ? v | (0x80 >> i) : v), 0)
}

function bmpRows(bytes: Uint8Array): number[] | null {
  if (bytes.length < 62) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const header = view.getUint32(14, true)
  const height = view.getInt32(22, true)
  if (view.getInt32(18, true) !== 8 || Math.abs(height) !== 8 || view.getUint16(28, true) !== 1) {
    return null
  }
  if (offset + 32 > bytes.length || 14 + header + 8 > bytes.length) return null
  const palette = [0, 1].map((i) => {
    const p = 14 + header + i * 4
    return luminance(bytes[p + 2]!, bytes[p + 1]!, bytes[p]!)
  })
  return Array.from({ length: 8 }, (_, y) => {
    const byte = bytes[offset + (height > 0 ? 7 - y : y) * 4]!
    return row(Array.from({ length: 8 }, (_, x) => palette[(byte >> (7 - x)) & 1]!))
  })
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

async function pngRows(bytes: Uint8Array): Promise<number[] | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 33 || view.getUint32(12) !== 0x49484452) return null
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const depth = bytes[24]!
  const colorType = bytes[25]!
  if (
    width !== 8 ||
    height !== 8 ||
    depth > 8 ||
    (colorType !== 0 && colorType !== 3) ||
    bytes[28] !== 0
  ) {
    return null
  }
  let palette: number[] = []
  const data: Uint8Array[] = []
  for (let p = 8; p + 12 <= bytes.length; ) {
    const length = view.getUint32(p)
    const type = view.getUint32(p + 4)
    const body = bytes.subarray(p + 8, p + 8 + length)
    if (type === 0x504c5445) {
      palette = Array.from({ length: Math.floor(body.length / 3) }, (_, i) =>
        luminance(body[i * 3]!, body[i * 3 + 1]!, body[i * 3 + 2]!),
      )
    } else if (type === 0x49444154) data.push(body)
    p += 12 + length
  }
  const packed = new Uint8Array(data.reduce((n, d) => n + d.length, 0))
  let at = 0
  for (const d of data) {
    packed.set(d, at)
    at += d.length
  }
  const raw = await inflate(packed, 'deflate')
  const stride = Math.ceil((8 * depth) / 8)
  if (raw === null || raw.length < 8 * (stride + 1)) return null
  const out: number[] = []
  let previous = new Uint8Array(stride)
  for (let y = 0; y < 8; y++) {
    const filter = raw[y * (stride + 1)]!
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i > 0 ? line[i - 1]! : 0
      const b = previous[i]!
      const c = i > 0 ? previous[i - 1]! : 0
      const add =
        filter === 1
          ? a
          : filter === 2
            ? b
            : filter === 3
              ? (a + b) >> 1
              : filter === 4
                ? paeth(a, b, c)
                : 0
      line[i] = (line[i]! + add) & 0xff
    }
    previous = line
    const max = (1 << depth) - 1
    out.push(
      row(
        Array.from({ length: 8 }, (_, x) => {
          const bit = x * depth
          const v = (line[bit >> 3]! >> (8 - depth - (bit & 7))) & max
          return colorType === 3 ? (palette[v] ?? 0) : (v * 255) / max
        }),
      ),
    )
  }
  return out
}

/** 图案位图的 8 行；不是 8 × 8 的 DIB 或 PNG 时为 `null`。 */
export async function patternRows(blip: Blip): Promise<number[] | null> {
  if (blip.contentType === 'image/bmp') return bmpRows(blip.bytes)
  if (blip.contentType === 'image/png') return pngRows(blip.bytes)
  return null
}
