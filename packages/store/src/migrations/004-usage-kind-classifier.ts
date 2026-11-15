import type { Migration } from './shared.ts'

export const migration004: Migration = {
  id: 4,
  name: 'usage_kind_classifier',
  /**
   * 账本的 kind 增加 `classifier`（权限裁决所用的小模型调用）。
   *
   * **新增 kind 必须同时新增迁移**：`kind` 上有 CHECK 约束，只修改 TS 类型时插入会
   * 违反约束并抛错；`recordUsage` 只忽略唯一约束冲突，其余错误输出到 stderr。
   * 若该 catch 被放宽为忽略全部错误，分类器与命令放行均正常，
   * 账本却没有任何记录，且任何地方都不报错。
   *
   * 重建表而不是 ALTER：SQLite 无法修改 CHECK 约束，只能新建表并迁移数据。
   * 迁移数据时索引一并重建。
   */
  sql: `
CREATE TABLE usage_ledger_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('run','summary','team','classifier')),
  run_id          TEXT,
  conversation_id TEXT,
  workspace_id    TEXT,
  model           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  occurred_at     INTEGER NOT NULL
);
INSERT INTO usage_ledger_new SELECT * FROM usage_ledger;
DROP TABLE usage_ledger;
ALTER TABLE usage_ledger_new RENAME TO usage_ledger;
CREATE INDEX idx_usage_time ON usage_ledger(occurred_at);
CREATE INDEX idx_usage_ws ON usage_ledger(workspace_id, occurred_at);
CREATE INDEX idx_usage_model ON usage_ledger(model, occurred_at);
CREATE UNIQUE INDEX uq_usage_run ON usage_ledger(run_id) WHERE run_id IS NOT NULL;
`,
}
