import type { Migration } from './shared.ts'

export const migration036: Migration = {
  id: 36,
  name: 'normalize_run_failure_messages',
  /**
   * 两种旧生产者写入 runs 的错误信息直接在账本中统一：
   *
   * - 连接计时器与 AgentLoop 各拼接过一次同一段静默时长；
   * - 已废除的固定步数终态不再对应任何当前运行机制。
   *
   * 这是一次数据修复，界面不保留按字符串识别旧记录的并行展示分支。
   */
  apply(db) {
    const duplicate = /^连接超时：(\d+) 秒内没有收到响应，\1 秒未收到响应(?=，|$)/
    const rows = db
      .query<{ id: string; error_message: string }, []>(
        `SELECT id, error_message FROM runs WHERE error_message IS NOT NULL`,
      )
      .all()
    const update = db.query(`UPDATE runs SET error_message = ? WHERE id = ?`)
    for (const row of rows) {
      const normalized = row.error_message.replace(duplicate, '连接超时，$1 秒未收到响应')
      if (normalized !== row.error_message) update.run(normalized, row.id)
    }

    db.exec(`
UPDATE runs
SET stop_reason = CASE WHEN stop_reason = 'max_steps' THEN NULL ELSE stop_reason END,
    error_message = CASE
      WHEN trim(COALESCE(error_message, '')) IN ('已达步数上限', '旧版本：已达步数上限') THEN NULL
      ELSE error_message
    END
WHERE stop_reason = 'max_steps'
   OR trim(COALESCE(error_message, '')) IN ('已达步数上限', '旧版本：已达步数上限');
`)
  },
}
