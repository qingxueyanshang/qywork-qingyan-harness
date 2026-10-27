/**
 * Matroska / WebM 容器（mkv / webm）的索引解析：时长与第一条视频轨的像素宽高，不解码画面。
 *
 * 只读取文件开头：`Info` 与 `Tracks` 位于第一个 `Cluster` 之前。浏览器录制的 WebM 不写 `Duration`，
 * 此时时长为 null；百炼与智谱对这类文件都以 400 拒绝，调用方据此改为抽帧，不要改为从末尾推算时长后照常发送。
 */
import type { CanvasPixels } from './canvas.ts'

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const CLUSTER = 0x1f43b675
const INFO = 0x1549a966
const TIMESTAMP_SCALE = 0x2ad7b1
const DURATION = 0x4489
const TRACKS = 0x1654ae6b
const TRACK_ENTRY = 0xae
const TRACK_TYPE = 0x83
const VIDEO = 0xe0
const PIXEL_WIDTH = 0xb0
const PIXEL_HEIGHT = 0xba
/** `TrackType` 中视频轨的取值。 */
const VIDEO_TRACK = 1

interface Element {
  id: number
  /** 载荷起点。 */
  at: number
  /** 载荷终点；大小未知（直播写出的 `Segment` / `Cluster`）时为 null。 */
  end: number | null
}

/** EBML 变长整数：首字节前导零的个数加一为字节数。`id` 保留长度标记位，大小去掉标记位；全 1 表示大小未知。 */
function vint(
  bytes: Uint8Array,
  at: number,
  id: boolean,
): { value: number | null; next: number } | null {
  const first = bytes[at]
  if (first === undefined || first === 0) return null
  const length = Math.clz32(first) - 23
  if (at + length > bytes.length) return null
  let value = id ? first : first & (0xff >> length)
  let unknown = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    const b = bytes[at + i]!
    value = value * 256 + b
    if (b !== 0xff) unknown = false
  }
  return { value: !id && unknown ? null : value, next: at + length }
}

function elementAt(bytes: Uint8Array, at: number): Element | null {
  const id = vint(bytes, at, true)
  if (!id || id.value === null) return null
  const size = vint(bytes, id.next, false)
  if (!size) return null
  return { id: id.value, at: size.next, end: size.value === null ? null : size.next + size.value }
}

/** 逐个列出 [from, to) 内的子元素；大小未知的元素之后无法定位下一个，到此为止。 */
function* children(bytes: Uint8Array, from: number, to: number): Generator<Element> {
  let at = from
  while (at < to) {
    const el = elementAt(bytes, at)
    if (!el) return
    yield el
    if (el.end === null) return
    at = el.end
  }
}

function uint(bytes: Uint8Array, el: Element): number {
  let value = 0
  for (let i = el.at; i < (el.end ?? el.at); i++) value = value * 256 + bytes[i]!
  return value
}

function float(bytes: Uint8Array, el: Element): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset + el.at, (el.end ?? el.at) - el.at)
  if (view.byteLength === 4) return view.getFloat32(0)
  if (view.byteLength === 8) return view.getFloat64(0)
  return null
}

/** 载荷完整位于已读取的字节内的子元素。 */
const within = (bytes: Uint8Array, el: Element): el is Element & { end: number } =>
  el.end !== null && el.end <= bytes.length

function videoPixels(bytes: Uint8Array, tracks: Element & { end: number }): CanvasPixels | null {
  for (const entry of children(bytes, tracks.at, tracks.end)) {
    if (entry.id !== TRACK_ENTRY || !within(bytes, entry)) continue
    let type = 0
    let pixels: CanvasPixels | null = null
    for (const field of children(bytes, entry.at, entry.end)) {
      if (!within(bytes, field)) continue
      if (field.id === TRACK_TYPE) type = uint(bytes, field)
      if (field.id !== VIDEO) continue
      let w = 0
      let h = 0
      for (const v of children(bytes, field.at, field.end)) {
        if (!within(bytes, v)) continue
        if (v.id === PIXEL_WIDTH) w = uint(bytes, v)
        if (v.id === PIXEL_HEIGHT) h = uint(bytes, v)
      }
      if (w > 0 && h > 0) pixels = { w, h }
    }
    if (type === VIDEO_TRACK && pixels) return pixels
  }
  return null
}

/**
 * 从文件开头的字节中读取时长（秒）与第一条视频轨的像素宽高。不是 EBML 文件时返回 null；
 * 读不出的项为 null（没有 `Duration`、`Tracks` 不在已读取的范围内）。
 */
export function matroskaMetadataOf(
  head: Uint8Array,
): { duration: number | null; pixels: CanvasPixels | null } | null {
  const header = elementAt(head, 0)
  if (!header || header.id !== EBML || header.end === null) return null
  const segment = elementAt(head, header.end)
  if (!segment || segment.id !== SEGMENT) return null
  let duration: number | null = null
  let pixels: CanvasPixels | null = null
  for (const el of children(head, segment.at, Math.min(segment.end ?? head.length, head.length))) {
    if (el.id === CLUSTER) break
    if (!within(head, el)) continue
    if (el.id === INFO) {
      let scale = 1_000_000
      let ticks: number | null = null
      for (const field of children(head, el.at, el.end)) {
        if (!within(head, field)) continue
        if (field.id === TIMESTAMP_SCALE) scale = uint(head, field)
        if (field.id === DURATION) ticks = float(head, field)
      }
      duration = ticks !== null && ticks > 0 ? (ticks * scale) / 1e9 : null
    }
    if (el.id === TRACKS) pixels = videoPixels(head, el)
  }
  return { duration, pixels }
}
