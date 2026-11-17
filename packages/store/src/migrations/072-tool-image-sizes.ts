import type { Database } from 'bun:sqlite'
import { type ImageSize, imageSizeOf } from '@qywork/core'
import type { ContentStore } from '../content.ts'
import { isStoredToolImage } from '../tool-images.ts'
import { type Migration, parsedObject } from './shared.ts'

/** 迁移 72 每批读取的候选行数。图像已移入正文库，每行只有引用，单批耗时主要在读取文件头。 */
const IMAGE_SIZE_BATCH_ROWS = 64

/** 依次读取的文件头长度：PNG、GIF、WebP 的尺寸在开头数十字节；JPEG 的 SOF 之前可能有带缩略图的 EXIF。 */
const IMAGE_HEADS = [4096, 256 * 1024]

/**
 * 迁移 72 的一批：为入库时尚未记录尺寸的工具图片补充像素宽高（`StoredToolImage.size`），估算按尺寸计算。
 *
 * 只改写缺少 `size` 键的引用；正文缺失或文件头无法识别时记为 null。按 rowid 推进，理由同迁移 70。
 */
function addToolImageSizesBatch(db: Database, content: ContentStore, after: number): number | null {
  const rows = db
    .query<{ rid: number; id: string; payload: string | null }, [number, number]>(
      `SELECT rowid AS rid, id, payload FROM steps
       WHERE rowid > ? AND kind = 'tool_action' AND instr(payload, '"resourceId"') > 0
       ORDER BY rowid LIMIT ?`,
    )
    .all(after, IMAGE_SIZE_BATCH_ROWS)
  if (!rows.length) return null
  const hashOf = db.query<{ content_hash: string | null }, [string]>(
    'SELECT content_hash FROM intermediate_resources WHERE id = ?',
  )
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  const sizeOf = (resourceId: string): ImageSize | null => {
    const hash = hashOf.get(resourceId)?.content_hash
    if (!hash) return null
    for (const n of IMAGE_HEADS) {
      const size = imageSizeOf(content.readRange(hash, 0, n))
      if (size) return size
    }
    return null
  }
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    const outcome = payload?.outcome as Record<string, unknown> | undefined
    const data = outcome?.data as Record<string, unknown> | undefined
    const images = data?.images
    if (payload?.kind !== 'tool_result' || !Array.isArray(images)) continue
    const missing = (e: unknown) => isStoredToolImage(e) && !('size' in e)
    if (!images.some(missing)) continue
    const sized = images.map((e) =>
      isStoredToolImage(e) && !('size' in e) ? { ...e, size: sizeOf(e.resourceId) } : e,
    )
    write.run(
      JSON.stringify({ ...payload, outcome: { ...outcome, data: { ...data, images: sized } } }),
      row.id,
    )
  }
  return rows.at(-1)!.rid
}

export const migration072: Migration = {
  id: 72,
  name: 'tool_image_sizes',
  /**
   * 工具图片的引用补充像素宽高，见 `addToolImageSizesBatch`。估算按宽高与各模型的图片规则计算；
   * 补齐之前的引用按尺寸未知计（该模型的像素上限）。
   */
  background: addToolImageSizesBatch,
}
