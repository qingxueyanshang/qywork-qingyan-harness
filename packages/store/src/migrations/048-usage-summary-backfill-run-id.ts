import type { Migration } from './shared.ts'

export const migration048: Migration = {
  id: 48,
  name: 'usage_summary_backfill_run_id',
  /**
   * 迁移 47 之前写入的摘要行没有 run_id。同一会话的轮次不重叠，摘要发生在哪一轮的时间窗口内
   * 即属于该轮；手动压缩只在没有轮次运行时发生，不在任何窗口内，run_id 仍为空。
   */
  sql: `
UPDATE usage_ledger SET run_id = (
  SELECT r.id FROM runs r
   WHERE r.conversation_id = usage_ledger.conversation_id
     AND r.created_at <= usage_ledger.occurred_at
     AND (r.finished_at IS NULL OR usage_ledger.occurred_at <= r.finished_at)
   ORDER BY r.created_at DESC LIMIT 1)
 WHERE kind = 'summary' AND run_id IS NULL AND conversation_id IS NOT NULL;
`,
}
