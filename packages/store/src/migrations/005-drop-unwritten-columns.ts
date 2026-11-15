import type { Migration } from './shared.ts'

export const migration005: Migration = {
  id: 5,
  name: 'drop_unwritten_columns',
  /**
   * 删除三处从未被写入的表与列。
   *
   * - `artifacts` 表与 `steps.artifact_id`：没有任何生产者，界面也没有对应渲染。
   * - `runs.execution_state`：优先级最高。它从未被写入，崩溃恢复若
   *   以它为判据，会将所有 run 判定为可安全重放，这是风险最高的方向。
   *   实际判据是 steps 表中带 `execution_started_at` 的 running 行。
   *
   * 保留空表/空列不构成兼容，只会留下被误用的可能。
   */
  sql: `
DROP INDEX IF EXISTS idx_artifact_conv;
DROP TABLE IF EXISTS artifacts;
ALTER TABLE steps DROP COLUMN artifact_id;
ALTER TABLE runs DROP COLUMN execution_state;
`,
}
