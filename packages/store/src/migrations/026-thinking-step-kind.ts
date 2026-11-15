import type { Migration } from './shared.ts'

export const migration026: Migration = {
  id: 26,
  name: 'thinking_step_kind',
  /**
   * 思考使用独立的行，不再附在工具行的 `content` 上。
   *
   * 附在工具行上的失败方式：本轮没有工具调用 → 没有 `tool_action` 行 →
   * 思考无处存放 → 直接丢弃。纯文本轮的思考因此从未写入磁盘。
   *
   * **重建表而不是 ALTER**：SQLite 无法修改 CHECK 约束，只能新建表并迁移数据
   * （与迁移 3 的做法相同）。迁移数据时索引一并重建。
   *
   * 同时将 `artifact` 与 `progress` 从 CHECK 中删除：`StepKind` 不含这两个值，
   * 没有任何生产者能写入它们，保留只会留下被误用的可能（与迁移 5 相同）。
   *
   * 本迁移保留 `tool_action.content`；迁移 37 在可同时改写 compaction step 戳时
   * 将其转为独立的 thinking step，运行时不再保留第二种读取结构。
   */
  sql: `
CREATE TABLE steps_new (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('text','tool_action','compaction','thinking')),
  tool_name   TEXT,
  tool_call_id TEXT,
  provider_batch_id TEXT,
  call_index  INTEGER,
  execution_wave_index INTEGER,
  execution_started_at INTEGER,
  content     TEXT,
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'done',
  created_at  INTEGER NOT NULL
);
INSERT INTO steps_new SELECT
  id, run_id, seq, kind, tool_name, tool_call_id, provider_batch_id, call_index,
  execution_wave_index, execution_started_at, content, payload, status, created_at
FROM steps;
DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE INDEX idx_step_run_seq ON steps(run_id, seq);
`,
}
