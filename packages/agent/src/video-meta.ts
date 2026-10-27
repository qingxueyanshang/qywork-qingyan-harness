/**
 * 视频文件的字节数、时长与画面尺寸。只读取 ISO 媒体容器（mp4 / mov / m4v）的 `moov`，不解码画面。
 * 估算、投递额度与画布尺寸共用；同步读取，因为请求装配（`toolResultContent`）与压缩的单元估算都是同步的。
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import type { VideoMeta } from '@qywork/ai'
import { mediaBoxAt, movieMetadataOf } from '@qywork/core'

/** `moov` 只存储索引，长视频也在数 MB 以内；超过此值视为异常文件，不读取。 */
const MAX_MOOV = 64 * 1024 * 1024
const CACHE_LIMIT = 256
const cache = new Map<string, VideoMeta>()

/**
 * 在顶层逐个读取 box 头以跳过 `mdat` 等较大的 box，找到 `moov` 后整块读入并解析。`moov` 位于文件末尾时同样能找到。
 * 不是 ISO 容器或无法读取时返回 null。
 */
export function movieMetadataOfFile(abs: string): ReturnType<typeof movieMetadataOf> | null {
  let fd: number
  try {
    fd = openSync(abs, 'r')
  } catch {
    return null
  }
  try {
    return moovOf(fd, fstatSync(fd).size)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function moovOf(fd: number, total: number): ReturnType<typeof movieMetadataOf> | null {
  const head = new Uint8Array(16)
  let at = 0
  while (at + 8 <= total) {
    readSync(fd, head, 0, 16, at)
    const box = mediaBoxAt(head, 0, total - at)
    if (!box) return null
    if (box.type === 'moov') {
      if (box.size > MAX_MOOV) return null
      const body = new Uint8Array(box.size - box.header)
      readSync(fd, body, 0, body.length, at + box.header)
      return movieMetadataOf(body)
    }
    at += box.size
  }
  return null
}

/**
 * 估算用的视频信息。文件不存在时返回 null；时长不为正数或读不出画面尺寸时对应项为 null。
 * 按路径、修改时间与大小缓存：请求装配每一步都会对历史中的视频调用本函数。
 */
export function videoMetaOf(abs: string): VideoMeta | null {
  let fd: number
  try {
    fd = openSync(abs, 'r')
  } catch {
    return null
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) return null
    const key = `${abs}|${info.mtimeMs}|${info.size}`
    const hit = cache.get(key)
    if (hit) return hit
    let movie: ReturnType<typeof movieMetadataOf> | null = null
    try {
      movie = moovOf(fd, info.size)
    } catch {
      // 读取中途出错按读不出处理：时长与尺寸为 null，字节数仍有效。
    }
    const meta: VideoMeta = {
      bytes: info.size,
      seconds: movie?.duration && movie.duration > 0 ? movie.duration : null,
      size: movie?.pixels ? { width: movie.pixels.w, height: movie.pixels.h } : null,
    }
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, meta)
    return meta
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
