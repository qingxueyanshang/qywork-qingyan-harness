/**
 * 读取工作区中图片、视频与 Art 页面的像素宽高，供画布节点按实际比例确定尺寸；读取视频时长，用于核对时间线片段。
 * 只读取文件头与索引，不解码画面。
 *
 * 图片支持 PNG / JPEG / GIF / WebP（`imageSizeOf`）；视频支持 ISO 基础媒体格式（mp4 / mov / m4v），
 * 取第一条宽高非零的轨道；HTML 取 viewport 标签声明的宽高（`artViewportOf`）。
 * 其余格式与无法读取的文件返回 `null`，调用方按默认尺寸处理。
 */

import { open } from 'node:fs/promises'
import {
  artViewportOf,
  type CanvasPixels,
  isInlineImage,
  mediaBoxAt,
  movieMetadataOf,
} from '@qywork/core'
import { imageSizeOf } from '@qywork/tools'

/** JPEG 的尺寸位于第一个 SOF 段中，其前可能有带缩略图的 EXIF（上限 64 KB），读取该长度即足够。 */
const IMAGE_HEAD = 256 * 1024
/** `moov` 只存储索引，长视频也在数 MB 以内；超过此值视为异常文件，不读取。 */
const MAX_MOOV = 64 * 1024 * 1024
const VIDEO_RE = /\.(mp4|mov|m4v)$/i
const HTML_RE = /\.html?$/i
/** viewport 标签位于 `<head>` 中，读取文件开头这一段即足够。 */
const HTML_HEAD = 64 * 1024

export async function mediaSizeOf(abs: string): Promise<CanvasPixels | null> {
  try {
    if (isInlineImage(abs)) return await imageHead(abs)
    if (VIDEO_RE.test(abs)) return await videoSize(abs)
    if (HTML_RE.test(abs)) return await htmlSize(abs)
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
    return moov ? movieMetadataOf(moov).duration : null
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

async function htmlSize(abs: string): Promise<CanvasPixels | null> {
  const fh = await open(abs, 'r')
  try {
    const buf = new Uint8Array(HTML_HEAD)
    const { bytesRead } = await fh.read(buf, 0, HTML_HEAD, 0)
    return artViewportOf(new TextDecoder().decode(buf.subarray(0, bytesRead)))
  } finally {
    await fh.close()
  }
}

async function videoSize(abs: string): Promise<CanvasPixels | null> {
  const moov = await readMoov(abs)
  return moov ? movieMetadataOf(moov).pixels : null
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
      const box = mediaBoxAt(head, 0, total - at)
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
