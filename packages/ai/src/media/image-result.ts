/** 图片结果引用的保存与物化；恢复只读取已返回的产物。 */
import { download, sniffMime } from './http.ts'
import {
  MediaError,
  type MediaFile,
  type MediaImageResult,
  type MediaResult,
  type MediaRunOptions,
} from './types.ts'

export async function resolveImages(
  result: MediaImageResult,
  opts: MediaRunOptions,
  read: (url: string) => Promise<MediaFile> = (url) => download(url, opts.signal),
): Promise<MediaResult> {
  if (!result.sources.length) throw new MediaError('接口没有返回图片')
  await opts.onImageResult?.(result)
  const files: MediaFile[] = []
  for (const source of result.sources) {
    opts.signal.throwIfAborted()
    if ('url' in source) files.push(await read(source.url))
    else {
      const bytes = new Uint8Array(Buffer.from(source.base64, 'base64'))
      if (!bytes.length) throw new MediaError('接口返回的图片内容为空')
      files.push({ bytes, mime: sniffMime(bytes) ?? source.mime })
    }
  }
  return {
    files,
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.warning ? { warning: result.warning } : {}),
  }
}

/** 任务记录可能被外部修改，恢复前校验完整来源列表。 */
export function isImageResult(value: unknown): value is MediaImageResult {
  if (!value || typeof value !== 'object') return false
  const sources = (value as MediaImageResult).sources
  return (
    Array.isArray(sources) &&
    sources.length > 0 &&
    sources.every((source) => {
      if (!source || typeof source !== 'object') return false
      if ('url' in source) {
        if (typeof source.url !== 'string') return false
        try {
          return ['https:', 'http:'].includes(new URL(source.url).protocol)
        } catch {
          return false
        }
      }
      return typeof source.base64 === 'string' && !!source.base64 && typeof source.mime === 'string'
    })
  )
}
