/** ISO 媒体容器的索引解析。画布尺寸、时间线和生成参考视频共用，不解码画面。 */
import type { CanvasPixels } from './canvas.ts'

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

/** 读取 box 头；left 为该 box 所在容器的剩余长度，允许只传入文件头。 */
export function mediaBoxAt(
  bytes: Uint8Array,
  at: number,
  left: number,
): { type: string; size: number; header: number } | null {
  if (at + 8 > bytes.length) return null
  const view = viewOf(bytes)
  let size = view.getUint32(at)
  const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
  let header = 8
  if (size === 1) {
    if (at + 16 > bytes.length) return null
    size = Number(view.getBigUint64(at + 8))
    header = 16
  } else if (size === 0) size = left
  return Number.isSafeInteger(size) && size >= header && size <= left
    ? { type, size, header }
    : null
}

function* children(parent: Uint8Array, type: string): Generator<Uint8Array> {
  let at = 0
  while (at + 8 <= parent.length) {
    const box = mediaBoxAt(parent, at, parent.length - at)
    if (!box) return
    if (box.type === type) yield parent.subarray(at + box.header, at + box.size)
    at += box.size
  }
}

/** moov 的 mvhd 保存时长，第一条宽高非零的 trak/tkhd 保存画面尺寸。 */
export function movieMetadataOf(moov: Uint8Array): {
  duration: number | null
  pixels: CanvasPixels | null
} {
  let duration: number | null = null
  for (const mvhd of children(moov, 'mvhd')) {
    const wide = mvhd[0] === 1
    const at = wide ? 20 : 12
    if (mvhd.length < at + (wide ? 12 : 8)) break
    const view = viewOf(mvhd)
    const scale = view.getUint32(at)
    const ticks = wide ? Number(view.getBigUint64(at + 4)) : view.getUint32(at + 4)
    duration = scale > 0 ? ticks / scale : null
    break
  }
  let pixels: CanvasPixels | null = null
  for (const trak of children(moov, 'trak')) {
    for (const tkhd of children(trak, 'tkhd')) {
      pixels = trackPixels(tkhd)
      if (pixels) break
    }
    if (pixels) break
  }
  return { duration, pixels }
}

/** 从完整 MP4 / MOV 文件中取得索引；moov 位于文件末尾时同样可读取。 */
export function videoMetadataOf(bytes: Uint8Array): ReturnType<typeof movieMetadataOf> | null {
  for (const moov of children(bytes, 'moov')) return movieMetadataOf(moov)
  return null
}

/** tkhd 的矩阵表示旋转 90° 或 270° 时显示宽高对调，宽高为 16.16 定点数。 */
function trackPixels(bytes: Uint8Array): CanvasPixels | null {
  const matrix = bytes[0] === 1 ? 52 : 40
  if (bytes.length < matrix + 44) return null
  const view = viewOf(bytes)
  const a = view.getInt32(matrix)
  const w = Math.round(view.getUint32(matrix + 36) / 65536)
  const h = Math.round(view.getUint32(matrix + 40) / 65536)
  if (w <= 0 || h <= 0) return null
  return a === 0 ? { w: h, h: w } : { w, h }
}
