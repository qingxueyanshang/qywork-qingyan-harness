import type { Database } from 'bun:sqlite'
import { type Migration, parsedObject } from './shared.ts'

/** 迁移 82 每批读取的候选行数。候选行按回执正文中的「被中断」预先筛选，数量远少于全部工具行。 */
const BATCH_ROWS = 500

/** 停止时收尾写入的两种回执正文，与 `settleRunningSteps` 写入的原文相同。 */
const UNKNOWN = '执行期间被中断，结果未知'
const NOT_STARTED = '未开始执行即被中断'

function markBatch(db: Database, after: number): number | null {
  const rows = db
    .query<{ rid: number; id: string; payload: string | null }, [number, number]>(
      `SELECT rowid AS rid, id, payload FROM steps
       WHERE rowid > ? AND kind = 'tool_action' AND status = 'failure' AND instr(payload, '被中断') > 0
       ORDER BY rowid LIMIT ?`,
    )
    .all(after, BATCH_ROWS)
  if (!rows.length) return null
  const write = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    const outcome = payload?.outcome as Record<string, unknown> | undefined
    if (payload?.kind !== 'tool_result' || !outcome || outcome.errorKind) continue
    if (outcome.message !== UNKNOWN && outcome.message !== NOT_STARTED) continue
    const marked = {
      ...outcome,
      errorKind: 'interrupted',
      ...(outcome.message === UNKNOWN ? { resultState: 'unknown' } : {}),
    }
    write.run(JSON.stringify({ ...payload, outcome: marked }), row.id)
  }
  return rows.at(-1)!.rid
}

export const migration082: Migration = {
  id: 82,
  name: 'interrupted_steps',
  /**
   * 停止时被收尾改写为终态的历史工具行补写错误类别 `interrupted`，执行期间被中断的另写 `resultState: 'unknown'`：
   * 工具行据此显示「已中断」「结果不明」，与新写入的行一致。不补写时这些行显示「失败」。
   *
   * 按回执原文识别，原文由 `settleRunningSteps` 写入且没有其他写入方。分批执行，理由同迁移 81。
   */
  background: (db, _content, after) => markBatch(db, after),
}
