import type { Database } from 'bun:sqlite'
import { type Migration, nextWindow, parsedObject, SCAN_ROWS } from './shared.ts'

/** 停止时收尾写入的两种回执正文，与 `settleRunningSteps` 写入的原文相同。 */
const UNKNOWN = '执行期间被中断，结果未知'
const NOT_STARTED = '未开始执行即被中断'

function markBatch(db: Database, after: number): number | null {
  const rows = db
    .query<{ id: string; payload: string | null }, [number, number]>(
      `SELECT id, payload FROM steps
       WHERE rowid > ? AND rowid <= ? AND kind = 'tool_action' AND status = 'failure'
         AND instr(payload, '被中断') > 0`,
    )
    .all(after, after + SCAN_ROWS)
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
  return nextWindow(db, after)
}

export const migration082: Migration = {
  id: 82,
  name: 'interrupted_steps',
  /**
   * 停止时被收尾改写为终态的历史工具行补写错误类别 `interrupted`，执行期间被中断的另写 `resultState: 'unknown'`：
   * 工具行据此显示「已中断」「结果不明」，与新写入的行一致。不补写时这些行显示「失败」。
   *
   * 按回执原文识别，原文由 `settleRunningSteps` 写入且没有其他写入方。按 rowid 区间分批执行（`SCAN_ROWS`）。
   */
  background: (db, _content, after) => markBatch(db, after),
}
