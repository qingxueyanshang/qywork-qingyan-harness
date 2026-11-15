import type { Database } from 'bun:sqlite'
import type { ContentStore } from '../content.ts'
import { hasImageBytes, storeToolImages } from '../tool-images.ts'
import { type Migration, parsedObject } from './shared.ts'

/** 迁移 70 每批读取的候选行数。一行最多约 10 MB（一次取回多张图）；本机实测单批最长 0.49 秒。 */
const IMAGE_BATCH_ROWS = 32

/**
 * 迁移 70 的一批：工具结果中的图像字节从 payload 移入正文库，payload 只存引用（`tool-images.ts`）。
 *
 * 调用方已持有主库 IMMEDIATE 事务，锁顺序同 `RuntimeSink.land`：正文定稿后再登记引用；主库回滚时正文库中
 * 留下的正文无人引用，由下一次回收删除。`instr` 只用于缩小范围，是否改写由解析后的 `outcome.data.images`
 * 决定：参数正文中含同样字样的行、已改为引用的行都不改写。按 rowid 推进而不是重复查询剩余的行：
 * 不改写的候选行会被每次查询重新返回，迁移无法结束。
 */
function moveToolImagesBatch(db: Database, content: ContentStore, after: number): number | null {
  const rows = db
    .query<
      { rid: number; id: string; payload: string | null; run_id: string; tool_name: string | null },
      [number, number]
    >(
      `SELECT rowid AS rid, id, payload, run_id, tool_name FROM steps
       WHERE rowid > ? AND kind = 'tool_action' AND instr(payload, '"images":[{') > 0
       ORDER BY rowid LIMIT ?`,
    )
    .all(after, IMAGE_BATCH_ROWS)
  if (!rows.length) return null
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    const outcome = payload?.outcome as Record<string, unknown> | undefined
    if (payload?.kind !== 'tool_result' || !hasImageBytes(outcome?.data)) continue
    const data = storeToolImages(
      { db },
      content,
      { runId: row.run_id, stepId: row.id, toolName: row.tool_name ?? '' },
      outcome!.data as Record<string, unknown>,
    )
    write.run(JSON.stringify({ ...payload, outcome: { ...outcome, data } }), row.id)
  }
  return rows.at(-1)!.rid
}

export const migration070: Migration = {
  id: 70,
  name: 'tool_images_to_content_store',
  /**
   * 工具结果中的图像字节移入正文库，见 `moveToolImagesBatch`。迁移前图像 base64 占 steps.payload 的九成以上，
   * 同一张图每被读取或取回一次即存一份。本机 4.2 GB 的账本实测：后台 310 批共 41 秒，VACUUM 1.6 秒，
   * 主库降至 0.21 GB，正文库 1.76 GB（13,651 张引用去重为 8,872 份）；迁移前后每个会话重建出的请求历史逐字节相同。
   */
  background: moveToolImagesBatch,
}
