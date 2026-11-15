import type { Migration } from './shared.ts'

export const migration003: Migration = {
  id: 3,
  name: 'usage_ledger',
  sql: /* sql */ `
-- 独立用量账本。
--
-- 不直接查询 runs 的原因：账目的生命周期必须长于业务数据。删除会话、清理 run
-- 都是正常操作，而本月花费不应因此减少。因此本表：
--
-- * 没有外键，因而也没有 ON DELETE CASCADE。run_id / conversation_id 只是线索，
--   所指向的行被删除不影响账目成立。
-- * 每个 run 只写一行，在 run 收尾时写入。中途的 usage 是累计值，
--   每次都记录会将同一笔费用重复记账。
-- * kind 区分来源。压缩所用的摘要调用同样计费，但不属于任何 run 的
--   usage，不单独记录则这部分费用无处可查。
CREATE TABLE usage_ledger (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('run','summary','team')),
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
CREATE INDEX idx_usage_time ON usage_ledger(occurred_at);
CREATE INDEX idx_usage_ws ON usage_ledger(workspace_id, occurred_at);
CREATE INDEX idx_usage_model ON usage_ledger(model, occurred_at);
-- 每个 run 只能有一行：收尾逻辑若执行两次（重连补发、异常路径），
-- 该约束拒绝第二次写入，避免账目翻倍且不报错。
CREATE UNIQUE INDEX uq_usage_run ON usage_ledger(run_id) WHERE run_id IS NOT NULL;
`,
}
