/**
 * 图元文件（WMF、EMF）的读取与绘制，不依赖 DOM。
 *
 * - `readMetafile` 按文件头识别格式并读取为绘制命令；不是图元文件时返回 `null`。同一份字节只读取一次。
 * - `unsupported` 不为空的图元文件整张不绘制，不绘制已实现的部分：缺少的记录可能是图片的主体，绘制其余部分得到的是
 *   与原图不同的内容。调用方把它与无法解码的图片同样计入能力边界。
 * - EMF+ 记录未实现：双格式文件按其中的 EMF 记录绘制。
 * - 位图由调用方解码为可绘制的图片（`../drawingml/paint/picture.ts` 的 `decodePicture`），再与命令一起交给 `playMetafile`。
 */

import { isEmf, readEmf } from './emf.ts'
import type { Metafile } from './model.ts'
import { isWmf, readWmf } from './wmf.ts'

export type { Pixels } from './dib.ts'
export type { Metafile } from './model.ts'
export {
  type MetafileFace,
  type MetafileFonts,
  type MetafileTarget,
  playMetafile,
} from './play.ts'

const cache = new WeakMap<Uint8Array, Metafile | null>()

/** 读取 WMF 或 EMF；字节不是图元文件时返回 `null`。 */
export function readMetafile(bytes: Uint8Array): Metafile | null {
  const known = cache.get(bytes)
  if (known !== undefined) return known
  const mf = isEmf(bytes) ? readEmf(bytes) : isWmf(bytes) ? readWmf(bytes) : null
  cache.set(bytes, mf)
  return mf
}
