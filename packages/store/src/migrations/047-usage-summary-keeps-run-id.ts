import type { Migration } from './shared.ts'

export const migration047: Migration = {
  id: 47,
  name: 'usage_summary_keeps_run_id',
  /**
   * 摘要账目记录其所属轮次。唯一索引只约束轮次收尾时写入的行（每个 run 只写一行），
   * 摘要行带相同 run_id 时不再冲突；手动压缩不属于任何轮次，run_id 仍为空。
   */
  sql: `
DROP INDEX uq_usage_run;
CREATE UNIQUE INDEX uq_usage_run ON usage_ledger(run_id) WHERE run_id IS NOT NULL AND kind = 'run';
`,
}
