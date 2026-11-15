import type { Migration } from './shared.ts'

export const migration029: Migration = {
  id: 29,
  name: 'user_step_kind',
  /**
   * run 执行过程中用户插入的消息使用独立的行。
   *
   * **不能写入 `messages`。** 历史投影的结构是：messages 按 id 升序，每条之后
   * 接上 `userMessageId` 指向它的各个 run 的全部 steps（`runtime/transcript.ts`
   * 的 `buildHistory`）。中途写入 `messages` 的行在下一轮会被重排到整个 run 的全部
   * 步骤之后：插入发生在第 K 步，回放却将其排在全部步骤之后。
   * 写入 steps 时位置由 seq 决定，运行中的 transcript 与回放逐条位置一致。
   *
   * **重建表而不是 ALTER**：SQLite 无法修改 CHECK 约束（同迁移 3、26）。
   * 列清单以**当前的表**为准，不能沿用迁移 26 的列清单：其后迁移 28 增加了 `duration_ms`，
   * 沿用会丢失该列。
   */
  sql: `
CREATE TABLE steps_new (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('text','tool_action','compaction','thinking','user')),
  tool_name   TEXT,
  tool_call_id TEXT,
  provider_batch_id TEXT,
  call_index  INTEGER,
  execution_wave_index INTEGER,
  execution_started_at INTEGER,
  content     TEXT,
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'done',
  created_at  INTEGER NOT NULL,
  duration_ms INTEGER
);
INSERT INTO steps_new SELECT
  id, run_id, seq, kind, tool_name, tool_call_id, provider_batch_id, call_index,
  execution_wave_index, execution_started_at, content, payload, status, created_at,
  duration_ms
FROM steps;
DROP TABLE steps;
ALTER TABLE steps_new RENAME TO steps;
CREATE INDEX idx_step_run_seq ON steps(run_id, seq);
`,
}
