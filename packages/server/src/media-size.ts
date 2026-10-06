/**
 * 读取工作区中图片、视频的像素宽高，供画布节点按实际比例确定尺寸；读取视频时长，用于核对时间线片段。只读取文件头与索引，不解码画面。
 *
 * 图片支持 PNG / JPEG / GIF / WebP（`imageSizeOf`）；视频支持 ISO 基础媒体格式（mp4 / mov / m4v），
 * 取第一条宽高非零的轨道。其余格式与无法读取的文件返回 `null`，调用方按默认尺寸处理。
 */

import { open } from 'node:fs/promises'
import { type CanvasPixels, isInlineImage } from '@qywork/core'
import { imageSizeOf } from '@qywork/tools'

/** JPEG 的尺寸位于第一个 SOF 段中，其前可能有带缩略图的 EXIF（上限 64 KB），读取该长度即足够。 */
const IMAGE_HEAD = 256 * 1024
/** `moov` 只存储索引，长视频也在数 MB 以内；超过此值视为异常文件，不读取。 */
const MAX_MOOV = 64 * 1024 * 1024
const VIDEO_RE = /\.(mp4|mov|m4v)$/i

export async function mediaSizeOf(abs: string): Promise<CanvasPixels | null> {
  try {
    if (isInlineImage(abs)) return await imageHead(abs)
    if (VIDEO_RE.test(abs)) return await videoSize(abs)
  } catch {
    // 无法读取时按默认尺寸处理：尺寸只影响显示比例。
  }
  return null
}

/** 视频的时长（秒），取自 `mvhd`。不是 mp4 / mov / m4v 或无法读取时返回 `null`，调用方不做时长核对。 */
export async function mediaDurationOf(abs: string): Promise<number | null> {
  try {
    if (!VIDEO_RE.test(abs)) return null
    const moov = await readMoov(abs)
    return moov ? movieDuration(moov) : null
  } catch {
    return null
  }
}

async function imageHead(abs: string): Promise<CanvasPixels | null> {
  const fh = await open(abs, 'r')
  try {
    const buf = new Uint8Array(IMAGE_HEAD)
    const { bytesRead } = await fh.read(buf, 0, IMAGE_HEAD, 0)
    const size = imageSizeOf(buf.subarray(0, bytesRead))
    return size && size.width > 0 && size.height > 0 ? { w: size.width, h: size.height } : null
  } finally {
    await fh.close()
  }
}

async function videoSize(abs: string): Promise<CanvasPixels | null> {
  const moov = await readMoov(abs)
  return moov ? trackSize(moov) : null
}

/** 在顶层逐个读取 box 头以跳过 `mdat` 等较大的 box，找到 `moov` 后整块读入。`moov` 位于文件末尾时同样能找到。 */
async function readMoov(abs: string): Promise<Buffer | null> {
  const fh = await open(abs, 'r')
  try {
    const total = (await fh.stat()).size
    const head = Buffer.alloc(16)
    let at = 0
    while (at + 8 <= total) {
      await fh.read(head, 0, 16, at)
      const box = boxAt(head, 0, total - at)
      if (!box) return null
      if (box.type === 'moov') {
        if (box.size > MAX_MOOV) return null
        const body = Buffer.alloc(box.size - box.header)
        await fh.read(body, 0, body.length, at + box.header)
        return body
      }
      at += box.size
    }
    return null
  } finally {
    await fh.close()
  }
}

/** 读取 `at` 处的 box 头。`size` 为 1 时实际长度在其后 8 字节，为 0 时延伸到末尾（`left`）。 */
function boxAt(
  buf: Buffer,
  at: number,
  left: number,
): { type: string; size: number; header: number } | null {
  if (at + 8 > buf.length) return null
  let size = buf.readUInt32BE(at)
  const type = buf.toString('latin1', at + 4, at + 8)
  let header = 8
  if (size === 1) {
    if (at + 16 > buf.length) return null
    size = Number(buf.readBigUInt64BE(at + 8))
    header = 16
  } else if (size === 0) {
    size = left
  }
  return size >= header ? { type, size, header } : null
}

/** `mvhd`：版本 0 的时间字段 4 字节、版本 1 的 8 字节，时长 = duration / timescale。 */
function movieDuration(moov: Buffer): number | null {
  for (const mvhd of children(moov, 'mvhd')) {
    const wide = mvhd[0] === 1
    const at = wide ? 20 : 12
    if (mvhd.length < at + (wide ? 12 : 8)) return null
    const scale = mvhd.readUInt32BE(at)
    const duration = wide ? Number(mvhd.readBigUInt64BE(at + 4)) : mvhd.readUInt32BE(at + 4)
    return scale > 0 ? duration / scale : null
  }
  return null
}

/** `moov` 中各 `trak` 的 `tkhd`：第一条宽高非零的即为画面轨道。 */
function trackSize(moov: Buffer): CanvasPixels | null {
  for (const trak of children(moov, 'trak')) {
    for (const tkhd of children(trak, 'tkhd')) {
      const size = tkhdSize(tkhd)
      if (size) return size
    }
  }
  return null
}

function* children(parent: Buffer, type: string): Generator<Buffer> {
  let at = 0
  while (at + 8 <= parent.length) {
    const box = boxAt(parent, at, parent.length - at)
    if (!box || at + box.size > parent.length) return
    if (box.type === type) yield parent.subarray(at + box.header, at + box.size)
    at += box.size
  }
}

/**
 * `tkhd`：版本 0 与 1 的时间字段分别为 4 字节与 8 字节，之后是 3×3 变换矩阵与 16.16 定点数的宽高。
 * 矩阵表示旋转 90° 或 270° 时（a = 0）显示宽高对调：手机竖拍的视频常按横向存储，依靠矩阵旋转为正向。
 */
function tkhdSize(body: Buffer): CanvasPixels | null {
  const matrix = body[0] === 1 ? 52 : 40
  if (body.length < matrix + 44) return null
  const a = body.readInt32BE(matrix)
  const w = Math.round(body.readUInt32BE(matrix + 36) / 65536)
  const h = Math.round(body.readUInt32BE(matrix + 40) / 65536)
  if (w <= 0 || h <= 0) return null
  return a === 0 ? { w: h, h: w } : { w, h }
}
