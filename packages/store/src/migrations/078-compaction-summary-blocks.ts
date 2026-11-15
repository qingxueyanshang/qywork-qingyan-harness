import type { Database } from 'bun:sqlite'
import { type Migration, parsedObject } from './shared.ts'

/**
 * manifest 的摘要改为块列表：已有摘要成为唯一的一块，覆盖到原摘要线；没有摘要线时块列表为空。
 * 顶层的 `summary`、`compactedThroughMessageId`、`compactedThroughStep` 随之删除。
 * 只有一块时投影正文与迁移前逐字相同，已有摘要的会话不因迁移失去缓存前缀。
 */
function migrateSummaryBlocks(db: Database): void {
  const rows = db
    .query<{ id: string; compaction_manifest: string }, []>(
      `SELECT id, compaction_manifest FROM conversations WHERE compaction_manifest IS NOT NULL`,
    )
    .all()
  const update = db.query('UPDATE conversations SET compaction_manifest = ? WHERE id = ?')
  for (const row of rows) {
    const manifest = parsedObject(row.compaction_manifest)
    if (!manifest || Array.isArray(manifest.summaries)) continue
    const {
      summary,
      compactedThroughMessageId: messageId,
      compactedThroughStep: step,
      ...rest
    } = manifest
    const summaries =
      typeof messageId === 'string' && messageId
        ? [
            {
              text: typeof summary === 'string' ? summary : '',
              through: { messageId, ...(typeof step === 'string' && step ? { step } : {}) },
            },
          ]
        : []
    update.run(JSON.stringify({ ...rest, summaries }), row.id)
  }
}

export const migration078: Migration = {
  id: 78,
  name: 'compaction_summary_blocks',
  /** manifest 的摘要改为块列表，见 `migrateSummaryBlocks`。只改写 JSON 列，表结构不变。 */
  apply: migrateSummaryBlocks,
}
