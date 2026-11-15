import type { Migration } from './shared.ts'

export const migration030: Migration = {
  id: 30,
  name: 'drop_manual_retry',
  /**
   * 手动重试已整体移除，这两列随之失去生产者与消费者。
   *
   * 产品只保留两种重试：`AgentLoop` 轮内的原样重发（`run.retrying`，不写入数据库），
   * 以及用户再次发送消息（即一个普通的新 run）。以同一条消息重新启动 run
   * 并将旧 run 标记为已被替代的语义不再存在。
   *
   * **必须先删除索引**：SQLite 拒绝 DROP 仍被索引引用的列，
   * 顺序颠倒会使整条迁移失败，数据库停留在版本 29。
   */
  sql: `
DROP INDEX IF EXISTS idx_run_retry_of;
ALTER TABLE runs DROP COLUMN retry_of_run_id;
ALTER TABLE runs DROP COLUMN superseded_by;
`,
}
