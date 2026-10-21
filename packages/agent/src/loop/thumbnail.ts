/**
 * 换出时图片替换成的缩略图（`request.ts` 的 `evictedMedia` 与 `materialize`）。
 *
 * 实测（2026-10，photon 0.3.4）：1568×882 的幻灯片页缩小到长边 768、JPEG(75) 为 45–85 KB，
 * 40 张平均约 55 KB，标题与正文仍可辨认。同一输入两次生成的字节相同。
 */
import { createHash } from 'node:crypto'

/** 缩略图的长边像素，写入发给模型的说明。 */
export const THUMBNAIL_EDGE = 768

/**
 * 换出预算中每张缩略图计入的字节数，原图更小时按原图计。
 *
 * 这是估算值：实际字节在解码之后才能得到，而换出在装配时同步计算，且必须只依赖消息序列。
 */
export const THUMBNAIL_BYTES = 64 * 1024

const THUMBNAIL_QUALITY = 75

/** 进程内缓存的缩略图数。单个会话的请求中最多约 48 张缩略图（`THUMBNAIL_RETAIN_BYTES`）。 */
const CACHE_LIMIT = 128

const cache = new Map<string, { data: string; mime: string }>()

/**
 * 生成图片的缩略图，返回 base64 与 MIME 类型；无法解码时返回 null。
 *
 * 输出必须逐字稳定：缩略图位于缓存断点之前，每次构造请求都重新物化。缓存按原图内容的哈希索引，
 * 不按正文库 id 索引：附件图片没有 id。有透明像素时输出 PNG，JPEG 没有透明通道；
 * 编码结果不小于原图时返回原图。
 */
export async function thumbnailOf(
  bytes: Uint8Array,
  mime: string,
): Promise<{ data: string; mime: string } | null> {
  const key = createHash('sha1').update(bytes).digest('hex')
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  let out: { data: string; mime: string }
  try {
    // 动态 import：photon 包含 2.2 MB 的 wasm，没有换出的会话不加载。
    const photon = await import('@silvia-odwyer/photon-node')
    const img = photon.PhotonImage.new_from_byteslice(bytes)
    const width = img.get_width()
    const height = img.get_height()
    const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(width, height))
    const small =
      scale < 1
        ? photon.resize(
            img,
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)),
            photon.SamplingFilter.Lanczos3,
          )
        : img
    const pixels = small.get_raw_pixels()
    let opaque = true
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]! < 255) {
        opaque = false
        break
      }
    }
    const encoded = opaque
      ? { bytes: small.get_bytes_jpeg(THUMBNAIL_QUALITY), mime: 'image/jpeg' }
      : { bytes: small.get_bytes(), mime: 'image/png' }
    const best = encoded.bytes.length < bytes.length ? encoded : { bytes, mime }
    out = { data: Buffer.from(best.bytes).toString('base64'), mime: best.mime }
  } catch {
    return null
  }
  cache.set(key, out)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return out
}
