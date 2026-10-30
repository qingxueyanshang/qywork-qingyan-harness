/**
 * 读取工作区中图片、视频与 Art 页面的像素宽高，供画布节点按实际比例确定尺寸。只读取文件头与索引，不解码画面。
 * 播放时长不在此读取，见 `@qywork/agent` 的 `mediaDurationOfFile`。
 *
 * 图片支持 PNG / JPEG / GIF / WebP（`imageSizeOf`）；视频支持 ISO 基础媒体格式（mp4 / mov / m4v），
 * 取第一条宽高非零的轨道；HTML 取 viewport 标签声明的宽高（`artViewportOf`）。
 * 其余格式与无法读取的文件返回 `null`，调用方按默认尺寸处理。
 */

import { open } from 'node:fs/promises'
import { movieMetadataOfFile } from '@qywork/agent'
import { artViewportOf, type CanvasPixels, imageSizeOf, isInlineImage } from '@qywork/core'

/** JPEG 的尺寸位于第一个 SOF 段中，其前可能有带缩略图的 EXIF（上限 64 KB），读取该长度即足够。 */
const IMAGE_HEAD = 256 * 1024
const VIDEO_RE = /\.(mp4|mov|m4v)$/i
const HTML_RE = /\.html?$/i
/** viewport 标签位于 `<head>` 中，读取文件开头这一段即足够。 */
const HTML_HEAD = 64 * 1024

export async function mediaSizeOf(abs: string): Promise<CanvasPixels | null> {
  try {
    if (isInlineImage(abs)) return await imageHead(abs)
    if (VIDEO_RE.test(abs)) return movieMetadataOfFile(abs)?.pixels ?? null
    if (HTML_RE.test(abs)) return await htmlSize(abs)
  } catch {
    // 无法读取时按默认尺寸处理：尺寸只影响显示比例。
  }
  return null
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
