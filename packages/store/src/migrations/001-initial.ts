import type { Migration } from './shared.ts'

export const migration001: Migration = {
  id: 1,
  name: 'initial',
  sql: /* sql */ `
CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  root_path     TEXT NOT NULL UNIQUE,
  last_opened_at INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title         TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL,
  compaction_manifest TEXT,
  cache_generation INTEGER NOT NULL DEFAULT 0,
  source        TEXT,
  source_ref    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_conv_workspace ON conversations(workspace_id, updated_at DESC);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL DEFAULT '',
  attachments     TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv ON messages(conversation_id, id);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL,
  user_message_id TEXT,
  message_id_upper_bound TEXT,
  assistant_message_id   TEXT,
  model           TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','interrupted')),
  stop_reason     TEXT,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  -- NULL 表示 provider 未回报缓存用量；不要用 COALESCE 转为 0。
  cached_tokens   INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  usage_turns     TEXT NOT NULL DEFAULT '[]',
  step_count      INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  error_code      TEXT,
  execution_state TEXT,
  context_tokens  INTEGER NOT NULL DEFAULT 0,
  context_limit   INTEGER NOT NULL DEFAULT 0,
  context_percent INTEGER NOT NULL DEFAULT 0,
  retry_of_run_id TEXT,
  superseded_by   TEXT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE UNIQUE INDEX uq_run_client_request ON runs(conversation_id, client_request_id);
CREATE INDEX idx_run_conv ON runs(conversation_id, created_at);
CREATE INDEX idx_run_retry_of ON runs(retry_of_run_id);

CREATE TABLE steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('text','tool_action','artifact','progress','compaction')),
  tool_name   TEXT,
  tool_call_id TEXT,
  provider_batch_id TEXT,
  call_index  INTEGER,
  execution_wave_index INTEGER,
  -- 进入执行器前立即写入。崩溃恢复必须将有时间戳的 running 行视为可能已执行，
  -- 而不是未执行、可安全重放：有副作用的工具重复执行一次的代价远高于遗漏一次。
  execution_started_at INTEGER,
  content     TEXT,
  payload     TEXT,
  status      TEXT NOT NULL DEFAULT 'done',
  artifact_id TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_step_run_seq ON steps(run_id, seq);

CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  run_id          TEXT,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  version         INTEGER NOT NULL DEFAULT 1,
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_artifact_conv ON artifacts(conversation_id);

CREATE TABLE provider_requests (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_index      INTEGER NOT NULL,
  retry_index     INTEGER NOT NULL DEFAULT 0,
  model           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','in_flight','received','uncertain','rejected')),
  measured_input_tokens INTEGER NOT NULL DEFAULT 0,
  measurement_exact INTEGER NOT NULL DEFAULT 0,
  provider_input_tokens  INTEGER,
  provider_output_tokens INTEGER,
  provider_cached_tokens INTEGER,
  provider_cache_write_tokens INTEGER,
  sent_categories TEXT NOT NULL DEFAULT '{}',
  error_code      TEXT,
  payload_hash    TEXT NOT NULL,
  cache_route_fingerprint TEXT,
  sent_at         INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_provider_run_turn ON provider_requests(run_id, turn_index, retry_index);
CREATE INDEX idx_provider_run_status ON provider_requests(run_id, status);

CREATE TABLE permission_rules (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  effect        TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_permission_scope ON permission_rules(workspace_id, scope);

CREATE TABLE permission_audit (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  run_id        TEXT,
  action        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  granted       INTEGER NOT NULL,
  resolved_by   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_audit_workspace ON permission_audit(workspace_id, created_at DESC);
`,
}
