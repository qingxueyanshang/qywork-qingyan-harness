import type { Migration } from './shared.ts'

export const migration064: Migration = {
  id: 64,
  name: 'media_spend',
  /**
   * 生成花费：`runs.media_usage` 存储本轮每次生成的花费（`MediaSpend[]` JSON），账本的 kind 允许 `media`。
   *
   * 账本重建而不是 ALTER：SQLite 无法修改 CHECK 约束。列顺序与当前表一致（`currency` 由迁移 7 追加，位于最后），
   * `INSERT … SELECT *` 的列才能一一对应。`team` / `classifier` 两个值原样保留，是否删除由用户决定。
   */
  sql: `
ALTER TABLE runs ADD COLUMN media_usage TEXT NOT NULL DEFAULT '[]';
CREATE TABLE usage_ledger_new (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('run','summary','team','classifier','media')),
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
  cost            REAL NOT NULL DEFAULT 0,
  occurred_at     INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'USD'
);
INSERT INTO usage_ledger_new SELECT * FROM usage_ledger;
DROP TABLE usage_ledger;
ALTER TABLE usage_ledger_new RENAME TO usage_ledger;
CREATE INDEX idx_usage_time ON usage_ledger(occurred_at);
CREATE INDEX idx_usage_ws ON usage_ledger(workspace_id, occurred_at);
CREATE INDEX idx_usage_model ON usage_ledger(model, occurred_at);
CREATE UNIQUE INDEX uq_usage_run ON usage_ledger(run_id) WHERE run_id IS NOT NULL AND kind = 'run';
`,
}
