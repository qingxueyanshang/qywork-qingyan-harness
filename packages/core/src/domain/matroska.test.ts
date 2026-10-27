/** 覆盖范围：`matroska.ts` 的 `matroskaMetadataOf`。 */

import { expect, test } from 'bun:test'
import { matroskaMetadataOf } from './matroska.ts'

/** EBML 元素：`id` 按原样写入（含长度标记），大小用 8 字节变长整数；`unknown` 写出全 1 的未知大小。 */
function el(id: number, payload: Uint8Array, unknown = false): Uint8Array {
  const idBytes: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) idBytes.unshift(v % 256)
  const size = new Uint8Array(8)
  size[0] = 0x01
  if (unknown) size.fill(0xff, 1)
  else new DataView(size.buffer).setUint32(4, payload.length)
  const out = new Uint8Array(idBytes.length + 8 + payload.length)
  out.set(idBytes, 0)
  out.set(size, idBytes.length)
  out.set(payload, idBytes.length + 8)
  return out
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const u = (n: number, bytes = 2) => {
  const out = new Uint8Array(bytes)
  for (let i = bytes - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256
  return out
}
const f64 = (n: number) => {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setFloat64(0, n)
  return out
}

const header = el(0x1a45dfa3, el(0x4282, new TextEncoder().encode('webm')))
const info = (durationMs: number | null) =>
  el(
    0x1549a966,
    cat(
      el(0x2ad7b1, u(1_000_000, 3)),
      ...(durationMs === null ? [] : [el(0x4489, f64(durationMs))]),
    ),
  )
const track = (type: number, w = 0, h = 0) =>
  el(0xae, cat(el(0x83, u(type, 1)), ...(w ? [el(0xe0, cat(el(0xb0, u(w)), el(0xba, u(h))))] : [])))
const cluster = el(0x1f43b675, el(0xe7, u(0)), true)

test('读取时长与第一条视频轨的像素宽高；音轨在前时跳过', () => {
  const file = cat(
    header,
    el(
      0x18538067,
      cat(
        el(0xec, new Uint8Array(32)),
        info(10_040),
        el(0x1654ae6b, cat(track(2), track(1, 854, 480))),
        cluster,
      ),
      true,
    ),
  )
  expect(matroskaMetadataOf(file)).toEqual({ duration: 10.04, pixels: { w: 854, h: 480 } })
})

test('浏览器录制的 WebM 不写 Duration：时长为 null，尺寸照常读出', () => {
  const file = cat(
    header,
    el(0x18538067, cat(info(null), el(0x1654ae6b, track(1, 1280, 720)), cluster), true),
  )
  expect(matroskaMetadataOf(file)).toEqual({ duration: null, pixels: { w: 1280, h: 720 } })
})

test('不是 EBML 文件时返回 null；Tracks 超出已读取的范围时尺寸为 null', () => {
  expect(matroskaMetadataOf(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))).toBeNull()
  const whole = cat(header, el(0x18538067, cat(info(5000), el(0x1654ae6b, track(1, 640, 360)))))
  expect(matroskaMetadataOf(whole.subarray(0, whole.length - 4))).toEqual({
    duration: 5,
    pixels: null,
  })
})
