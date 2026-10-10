/**
 * SQLite 账本表结构。
 *
 * 三条结构约束：
 *
 * - **主键使用带前缀的字符串 ID，不使用自增整数。** 这些表都有删除路径，普通
 *   INTEGER PRIMARY KEY 会复用已删除的最大 id，使不带外键的跨表引用（如
 *   `usage_ledger.run_id`）指向另一行且不报错。字符串 ID 在结构上排除这一问题。
 * - **外键引用列一律建索引。** PRAGMA foreign_keys=ON 时，每删除一条父行，SQLite 都要
 *   在子表中查找引用行，无索引即退化为全表扫描；删除一个长会话会耗时十几秒并触发
 *   busy_timeout。
 * - **cached_tokens 可空。** null 表示 provider 未回报，与实际命中为 0 含义不同。
 */

import type { Database } from 'bun:sqlite'
import type {
  ConversationId,
  Currency,
  MessageId,
  ProviderKind,
  ProviderRequestContentKind,
  ProviderRequestId,
  ProviderRequestStatus,
  ResourceId,
  ResourceStatus,
  RunId,
  RunStatus,
  ScheduleKind,
  StepId,
  StepKind,
  StopReason,
  ToolActionStatus,
  WorkspaceId,
} from '@qywork/core'

interface Migration {
  id: number
  name: string
  sql?: string
  apply?: (db: Database) => void
}

function addTextColumnIfMissing(
  db: Database,
  table: 'provider_requests' | 'runs',
  column: 'diagnostic' | 'interruption_detail',
): void {
  const exists = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
}

/** 带盘符的路径中 `/` 替换为 `\`，其余路径不变。判据与理由见迁移 55。 */
function windowsSeparators(path: string): string {
  return /^[A-Za-z]:/.test(path) ? path.replaceAll('/', '\\') : path
}

function parsedObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 迁移 26 之前附在工具行 `content` 上的思考正文，改写为独立的 thinking step。
 *
 * 受影响 run 的 seq 全部映射为 `old * 2 + 1`，新的思考 step 写在 `old * 2`。step 顺序与
 * batch 的截止 step 戳因此都可按公式换算，无需推测空位。会话压缩边界只含两处 step
 * 戳，一并重写；迁移完成后运行时不再读取 `tool_action.content`。
 */
function migrateEmbeddedThinking(db: Database): void {
  const rows = db
    .query<{ id: string; run_id: string; seq: number; content: string; created_at: number }, []>(
      `SELECT id, run_id, seq, content, created_at
       FROM steps
       WHERE kind = 'tool_action' AND trim(COALESCE(content, '')) <> ''
       ORDER BY run_id, seq`,
    )
    .all()
  if (rows.length === 0) return

  const runs = new Set(rows.map((row) => row.run_id))
  const updateSeq = db.query('UPDATE steps SET seq = seq * 2 + 1 WHERE run_id = ?')
  for (const runId of runs) updateSeq.run(runId)

  const insert = db.query(
    `INSERT INTO steps
     (id, run_id, seq, kind, content, status, created_at)
     VALUES (?, ?, ?, 'thinking', ?, 'done', ?)`,
  )
  const clear = db.query(`UPDATE steps SET content = NULL WHERE id = ?`)
  const added = new Map<string, number>()
  for (const row of rows) {
    insert.run(
      `st_migrated_thinking_${row.id}`,
      row.run_id,
      row.seq * 2,
      row.content,
      row.created_at,
    )
    clear.run(row.id)
    added.set(row.run_id, (added.get(row.run_id) ?? 0) + 1)
  }
  const count = db.query('UPDATE runs SET step_count = step_count + ? WHERE id = ?')
  for (const [runId, amount] of added) count.run(amount, runId)

  const rewriteStamp = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    for (const runId of runs) {
      const prefix = `${runId}:`
      if (!value.startsWith(prefix)) continue
      const seq = Number(value.slice(prefix.length))
      if (!Number.isSafeInteger(seq) || seq < 0) return value
      return `${prefix}${String(seq * 2 + 1).padStart(9, '0')}`
    }
    return value
  }
  const manifests = db
    .query<{ id: string; compaction_manifest: string }, []>(
      `SELECT id, compaction_manifest FROM conversations WHERE compaction_manifest IS NOT NULL`,
    )
    .all()
  const updateManifest = db.query('UPDATE conversations SET compaction_manifest = ? WHERE id = ?')
  for (const row of manifests) {
    const manifest = parsedObject(row.compaction_manifest)
    if (!manifest) continue
    let changed = false
    if (typeof manifest.compactedThroughStep === 'string') {
      const next = rewriteStamp(manifest.compactedThroughStep)
      changed ||= next !== manifest.compactedThroughStep
      manifest.compactedThroughStep = next
    }
    const condensed = manifest.condensedThrough
    if (condensed && typeof condensed === 'object' && !Array.isArray(condensed)) {
      const cut = condensed as Record<string, unknown>
      if (typeof cut.step === 'string') {
        const next = rewriteStamp(cut.step)
        changed ||= next !== cut.step
        cut.step = next
      }
    }
    if (changed) updateManifest.run(JSON.stringify(manifest), row.id)
  }
}

/** 将能由旧账本自身证明的字段改写为当前唯一结构；无法证明的事实不按配置推测。 */
function canonicalizeRuntimeRecords(db: Database): void {
  migrateEmbeddedThinking(db)

  // 旧投影将缺少 batch id 的每条工具行各视为一批；此处将该语义写入账本。
  db.exec(`
UPDATE steps
SET provider_batch_id = 'migrated:' || id
WHERE kind = 'tool_action' AND trim(COALESCE(provider_batch_id, '')) = '';
`)

  const rows = db
    .query<
      {
        id: string
        kind: string
        tool_name: string | null
        payload: string | null
        status: string
      },
      []
    >(`SELECT id, kind, tool_name, payload, status FROM steps WHERE payload IS NOT NULL`)
    .all()
  const updatePayload = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    if (!payload) continue
    let changed = false

    if (row.kind === 'tool_action') {
      const outcome =
        payload.outcome && typeof payload.outcome === 'object' && !Array.isArray(payload.outcome)
          ? (payload.outcome as Record<string, unknown>)
          : null
      const data =
        outcome?.data && typeof outcome.data === 'object' && !Array.isArray(outcome.data)
          ? (outcome.data as Record<string, unknown>)
          : null
      const child = textValue(data?.conversationId)
      if (row.tool_name === 'subagent' && !textValue(payload.childConversationId) && child) {
        payload.childConversationId = child
        changed = true
      }

      if (
        row.tool_name === 'workflow' &&
        data &&
        !Array.isArray(data.receipts) &&
        Array.isArray(data.nodes)
      ) {
        const receipts = data.nodes.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null
          const node = value as Record<string, unknown>
          const nodeId = textValue(node.nodeId)
          const agent = textValue(node.agent)
          const status = node.status
          const durationMs = node.durationMs
          if (
            !nodeId ||
            !agent ||
            (status !== 'done' && status !== 'failed' && status !== 'skipped') ||
            typeof durationMs !== 'number'
          ) {
            return null
          }
          return {
            nodeId,
            agent,
            label: textValue(node.label) || agent,
            status,
            output: typeof node.output === 'string' ? node.output : '',
            ...(typeof node.error === 'string' ? { error: node.error } : {}),
            durationMs,
            ...(typeof node.session === 'string' ? { session: node.session } : {}),
            ...(typeof node.conversationId === 'string'
              ? { conversationId: node.conversationId }
              : {}),
          }
        })
        if (receipts.every((receipt) => receipt !== null)) {
          const args =
            payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
              ? (payload.args as Record<string, unknown>)
              : null
          data.workflowId = textValue(data.workflowId) || textValue(args?.workflowId) || row.id
          data.phase = outcome?.status === 'success' ? 'completed' : 'failed'
          data.receipts = receipts
          delete data.nodes
          changed = true
        }
      }
    } else if (row.kind === 'compaction' && !textValue(payload.phase)) {
      payload.phase = row.status === 'failure' ? 'failed' : 'done'
      changed = true
    }

    if (changed) updatePayload.run(JSON.stringify(payload), row.id)
  }

  // 仅当逐请求账能唯一证明接口时，才为旧会话补写接口。没有证据或存在多个接口时保持空串，
  // 运行时要求用户重新选择；不以当前默认接口伪造历史归属。
  const conversations = db
    .query<{ id: string; model: string }, []>(
      `SELECT id, model FROM conversations WHERE trim(provider) = ''`,
    )
    .all()
  const routes = db.query<{ provider_name: string }, [string, string]>(
    `SELECT DISTINCT pr.provider_name
     FROM provider_requests pr
     JOIN runs r ON r.id = pr.run_id
     WHERE r.conversation_id = ? AND pr.model = ?
       AND trim(COALESCE(pr.provider_name, '')) <> ''`,
  )
  const updateProvider = db.query('UPDATE conversations SET provider = ? WHERE id = ?')
  for (const conversation of conversations) {
    const hits = routes.all(conversation.id, conversation.model)
    if (hits.length === 1) updateProvider.run(hits[0]!.provider_name, conversation.id)
  }
}

/** 旧服务为临时子 agent 设定的显示名。迁移 41 沿用该名称，不以任务正文作为名字。 */
const TEMP_LABEL = '临时子 agent'

/**
 * 旧的派发目标字段 `agent` 改为按 kind 记录：`ad-hoc` 与空值是临时子 agent，
 * `cli:<id>` 是外部 CLI，其余是角色 id。临时子 agent 的名字使用传入的后备名称。
 */
function kindFieldsOf(agent: unknown, fallbackName: string): Record<string, string> {
  if (typeof agent !== 'string' || agent === '' || agent === 'ad-hoc') {
    return { kind: 'temp', name: fallbackName }
  }
  if (agent.startsWith('cli:')) return { kind: 'cli', cli: agent.slice('cli:'.length) }
  return { kind: 'role', role: agent }
}

/**
 * 迁移 41 对单条派发任务 step 的改写。返回 false 表示该行已是新结构，无需写回。
 *
 * 回执中的逐节点终态是各节点状态的真值：续接调用缺少逐节点状态时由回执推导；
 * 首次派发的记录中由迁移 40 按 step 终态估算的状态，同样以回执为准。
 */
function rewriteDelegationPayload(payload: Record<string, unknown>, toolName: string): boolean {
  let changed = false
  const args = payload.args as Record<string, unknown> | undefined
  const nodes = (payload.nodes ?? {}) as Record<string, Record<string, unknown>>
  if (toolName === 'subagent' && args && 'agent' in args) {
    const { agent, ...rest } = args
    const target = kindFieldsOf(agent, TEMP_LABEL)
    payload.args = { ...target, ...rest }
    // 旧服务以任务正文作为临时子会话的标题，迁移 40 将其复制为节点名称，与卡片上的任务行重复。
    if (target.kind === 'temp' && nodes.child) nodes.child.label = TEMP_LABEL
    changed = true
  }
  if (toolName === 'workflow' && args && Array.isArray(args.nodes)) {
    args.nodes = args.nodes.map((raw) => {
      const node = raw as Record<string, unknown>
      if (node.kind === 'checkpoint' || !('agent' in node || node.kind === 'agent')) return node
      const { kind: _kind, agent, ...rest } = node
      changed = true
      return { ...kindFieldsOf(agent, TEMP_LABEL), ...rest }
    })
  }
  const data = (payload.outcome as { data?: Record<string, unknown> } | undefined)?.data
  const receipts = data?.receipts
  if (data && Array.isArray(receipts)) {
    const rewritten = receipts.map((raw) => {
      const receipt = raw as Record<string, unknown>
      if (!('agent' in receipt) && !('conversationId' in receipt)) return receipt
      const { agent: _agent, conversationId, ...rest } = receipt
      changed = true
      return {
        ...rest,
        ...(typeof conversationId === 'string' ? { subagentId: conversationId } : {}),
      }
    })
    data.receipts = rewritten
    for (const raw of rewritten) {
      const receipt = raw as Record<string, unknown>
      const id = typeof receipt.nodeId === 'string' ? receipt.nodeId : ''
      if (!id) continue
      const status = receipt.status
      const known = nodes[id]
      const subagentId =
        typeof receipt.subagentId === 'string' ? receipt.subagentId : known?.subagentId
      const state = {
        phase: status === 'done' ? 'done' : status === 'skipped' ? 'skipped' : 'failed',
        label: typeof receipt.label === 'string' ? receipt.label : (known?.label ?? ''),
        ...(typeof subagentId === 'string' ? { subagentId } : {}),
        ...(typeof receipt.durationMs === 'number' ? { durationMs: receipt.durationMs } : {}),
        ...(typeof receipt.error === 'string' && receipt.error ? { error: receipt.error } : {}),
      }
      if (JSON.stringify(known) !== JSON.stringify(state)) {
        nodes[id] = state
        changed = true
      }
    }
    if (Object.keys(nodes).length) payload.nodes = nodes
  }
  const action = payload.action as { objectLabel?: string } | undefined
  if (action?.objectLabel === '编排') {
    action.objectLabel = '工作流'
    changed = true
  }
  return changed
}

export const MIGRATIONS: Migration[] = [
  {
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
  },
  {
    id: 2,
    name: 'intermediate_resources',
    sql: /* sql */ `
-- 中间资源登记表。
--
-- 正文不在本表，而在另一个数据库（qywork_content.sqlite3）中，按 content_hash 寻址。
-- 本表只存定位信息：产生者、大小、类型与哈希。
--
-- 跨库没有外键，blob 的存在由写入顺序保证：
-- 先在正文库写定 blob，再向本表插入行。顺序颠倒会使本表指向不存在的正文，
-- 且该损坏要到模型读取时才会暴露。
--
-- content_hash 可空：status='failed' 的资源（获取中途中断）没有写定的正文，
-- 但登记必须保留：模型需要看到此处有一条未能取得的结果，
-- 否则读起来与工具未执行无法区分。
CREATE TABLE intermediate_resources (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id       TEXT,
  tool_name     TEXT NOT NULL,
  -- 资源的语义来源（web_fetch / shell / download 等），决定预览方式。
  source_type   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('complete','partial','failed')),
  content_hash  TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  mime_type     TEXT,
  -- 覆盖范围：截断量、原始行数与查询条件。模型据此判断所见内容是否完整。
  coverage      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_ir_run ON intermediate_resources(run_id, created_at);
-- GC 按哈希反查引用，无索引即全表扫描。
CREATE INDEX idx_ir_hash ON intermediate_resources(content_hash);
`,
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    id: 6,
    name: 'conversation_effort',
    /**
     * 思考强度移到会话级，结构与 `model` 完全一致。
     *
     * 迁移前只有 `config.effort` 一个全局值。主循环读取它（并非未接通的链路），
     * 但它与模型不在同一层级：模型是会话级的，一个会话切换到 Haiku 不影响另一个会话，
     * 而思考强度的切换是全局的。两个同级设置分处两层，修改一处会影响其他会话。
     *
     * `NULL` 表示跟随配置中的默认值，不表示关闭思考。因此此列不设 DEFAULT，
     * 设置后将无法区分用户显式选择的档位与尚未选择。
     */
    sql: `ALTER TABLE conversations ADD COLUMN effort TEXT;`,
  },
  {
    id: 7,
    name: 'multi_currency_cost',
    /**
     * 账本与 run 改为多币种，**不做汇率换算**。
     *
     * 内置目录扩展到九家厂商后，阿里 / 月之暗面 / 智谱三家官网按人民币标价。
     * 可选方案有三种：
     *
     * 1. 换算为美元：需要汇率。汇率持续变动，写入磁盘的数值很快不再准确，
     *    但看起来仍是确切的金额。
     * 2. 将人民币金额写入 `cost_usd`：字段名与实际币种不符，数值相差约七倍且界面上无法分辨。
     * 3. 记录币种，各币种分开合计。**采用此方案。**
     *
     * 列名一并从 `cost_usd` 改为 `cost`。这不违反「已落盘的键名不改」：
     * 该规则防止的是无法读取旧数据，而 RENAME COLUMN 会原样保留数据；
     * 保留名称与内容不符的列反而会误导后续读表的人。
     *
     * 存量行一律记为 `'USD'`：迁移之前目录中只有 Anthropic 与 DeepSeek 两家，
     * 均以美元标价，因此该默认值是事实，不是推测。
     */
    sql: `
ALTER TABLE runs RENAME COLUMN cost_usd TO cost;
ALTER TABLE runs ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE usage_ledger RENAME COLUMN cost_usd TO cost;
ALTER TABLE usage_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
`,
  },
  {
    id: 8,
    name: 'conversation_extras',
    /**
     * 会话级的技能 / MCP / 插件 / 记忆关闭项。
     *
     * **必须写入磁盘，不能只存于内存。** 关闭项需要在重启后保留：关闭某个 MCP 后重启应用，
     * 若该 MCP 重新出现，等同于开关未生效。关闭项只属于当前会话，写入全局配置会变成另一种语义，
     * 因此只能单独建表。
     *
     * **只存已关闭项，不存已开启项。** 默认全部开启，没有行即全部开启。反向存储时，每安装一个新技
     * 能都要为所有历史会话补写一行；遗漏补写会使新安装的技能在旧会话中不生效，
     * 且这一路径很少有人检查。
     *
     * `key` 形如 `skill:release` / `mcp:github` / `plugin:foo` / `memory:style`，
     * 前缀即类目。不拆成两列：本表只按会话读取全集，
     * 拆开只会增加一个 join 条件。
     */
    sql: `
CREATE TABLE conversation_extras (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  PRIMARY KEY (conversation_id, key)
);
`,
  },
  {
    id: 9,
    name: 'workspace_removed_at',
    /**
     * 从列表中移除项目不再等于删除该项目的全部数据。
     *
     * **行必须保留。** `conversations.workspace_id` 是 `ON DELETE CASCADE`，而 `workspaceOf` 需要
     * join 该行才能确定会话在哪个根目录下运行。删除该行后，会话将无法打开。避免中间态的办法不只
     * 删除行一种：**行保留，但不出现在列表中**。
     *
     * 移除只改变列表中是否显示，不改变能否读取：`listWorkspaces` 过滤
     * `removed_at IS NULL`，而 `workspaceOf` / `getWorkspace` **一律不过滤**。
     * 会话、消息、run、step 均不改动，重新添加同一路径即全部恢复
     * （`root_path` 是 UNIQUE，upsert 命中同一行并清除该标记）。
     *
     * 移除的语义因此与其他部分一致：`usage_ledger` 同样刻意不设外键，
     * 本月花费不应因项目从列表中移除而减少。
     *
     * **不提供彻底删除。** 没有该需求即不实现（B5）。需要清理数据时可使用备份与 SQL；
     * 增加一个入口就要增加一套多次确认的交互，以及一条可永久删除数据的路径。
     *
     * `NULL` 表示在列表中。使用时间戳而不是布尔值：移除时间将来需要显示，
     * 届时布尔值只能再增加一列。
     */
    sql: `
ALTER TABLE workspaces ADD COLUMN removed_at INTEGER;
`,
  },
  {
    id: 10,
    name: 'workspace_pinned_at',
    /**
     * 置顶项目。
     *
     * 按 `last_opened_at` 倒序得到的是最近打开的项目，不是常用项目。项目增多后，
     * 一次临时切换就会使常用项目的位置下移，而用户预期常用项目位置稳定。
     *
     * 存时间戳不存布尔值：多个置顶项目之间也需要确定顺序（后置顶的在前），
     * 布尔值届时只能再增加一列。`NULL` 表示未置顶。
     */
    sql: `
ALTER TABLE workspaces ADD COLUMN pinned_at INTEGER;
`,
  },
  {
    id: 11,
    name: 'conversation_archived_at',
    /**
     * 归档会话：**从会话列表中移除，此后新建的会话照常显示**。
     *
     * **与 `runtime/src/archive.ts` 名称相同而含义不同。** 后者是会话**导出**：产出 markdown / json，
     * 只读，产出物是静态的，不承诺可写回。此处的归档是不在列表中显示，数据均不改动。两者都称为
     * archive 容易造成误读，因此在此说明；导出部分保持原名。
     *
     * **数据不删除，但界面上无法访问。** `listConversations` 过滤归档会话，`getConversation` **不过滤**，
     * 按 id 仍可读取。这与迁移 9 移除项目的处理一致：状态标记只改变是否显示。区别是移除的项目
     * 可通过重新添加同一路径恢复，而归档没有对应的恢复入口。**这是用户明确要求的行为**（原话：「不
     * 是列表收敛，是不在会话里面显示了，新开对话还是会显示新的」），不是遗漏。将来若需要恢复，应增加一
     * 个视图，而不是修改此语义。
     */
    sql: `
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
`,
  },
  {
    id: 12,
    name: 'drop_conversation_effort',
    /**
     * 思考强度**恢复为单一配置项**，删除会话上的该列。
     *
     * 迁移 6 将它移到会话级，理由是模型是会话级的，思考强度应与模型同层。
     * 该理由不成立：它形成了第二条写入路径，输入区的 chip 写会话、设置页的下拉框写
     * `config.effort`，两处各自写入。结果是**在 chip 上选择的档位切换会话后即失效**，
     * 而设置页中的值看似仍在，两处都无法感知对方的修改。
     *
     * 档位不是会话属性：它是配置中与 model 同级的字段，每轮请求时读取。
     */
    sql: `ALTER TABLE conversations DROP COLUMN effort;`,
  },
  {
    id: 13,
    name: 'provider_request_ledger',
    /**
     * 接通逐请求账，同时删除 `runs` 上的三列。
     *
     * `provider_requests` 建于迁移 1，但一直没有读写，面板只能读取 `runs.context_tokens`；
     * 而这三列每个 step 覆盖一次，一个 run 只保留最后一次请求的读数，
     * 账本中无法得知本轮上下文的增长过程。
     *
     * 增加一列，删除三列：
     *
     * - 增加 `omitted_categories`：面板需要说明哪些内容被省略。压缩将历史替换为摘要、
     *   将工具结果替换为定位符之后，原文仍在账本中，只是未进入本次请求；
     *   该列记录的就是这部分。只有 `sent_categories` 时账目不完整。
     * - 删除 `runs` 的 `context_tokens/limit/percent`：真源改为本表之后，它们就是
     *   第二本账，两本账终将不一致。保留空列不构成兼容，只会留下被误用的可能
     *   （与迁移 5 的处理一致）。
     */
    sql: `
ALTER TABLE provider_requests ADD COLUMN omitted_categories TEXT NOT NULL DEFAULT '{}';
ALTER TABLE runs DROP COLUMN context_tokens;
ALTER TABLE runs DROP COLUMN context_limit;
ALTER TABLE runs DROP COLUMN context_percent;
`,
  },
  {
    id: 14,
    name: 'run_lease',
    /**
     * run 记录**运行它的进程**，启动回收据此跳过仍在运行的 run。
     *
     * **这两列不可缺少。** `recoverStaleRuns` **不能不加区分地扫描全库的 running/queued**：同一台机器上
     * 可能有多个进程写同一个账本（两个工作区各一个 sidecar、开发环境的热重载、终端中的 `qy exec
     * `）。不加区分地扫描时，**后启动的进程会将前一个进程正在运行的轮次判定为中断**，而该进程仍在
     * 运行、仍在写入。实测记录：一个执行了 40 步的 run 在第 27 次请求发出后 257 毫秒被判定为中断，写
     * 入者是另一个刚启动的进程。
     *
     * 判定仍在运行需要两个信号，缺一不可：
     *
     * - `owner_pid`：进程已退出即应回收，此保证不能弱化。
     *   仅有 pid 不够：Windows 会复用 pid，无关的新进程占用同一编号时，
     *   已结束的 run 将始终被判定为运行中，会话被永久锁定。
     * - `heartbeat_at`：运行中的进程每十秒更新一次。pid 被复用（或进程仍在
     *   但该轮已废弃）时，心跳停止更新，超时即回收。
     *
     * 仅有心跳同样不够：进程崩溃后立即重启时，心跳仅过去两秒，按超时判定仍在运行，
     * 该 run 因此不会被回收，而它已没有任何进程在运行，会话随之锁定。
     * **两个信号分别覆盖对方的缺口，因此两列都需要。**
     *
     * 可空：迁移之前的历史行没有归属，按无归属处理，照常回收。
     */
    sql: `
ALTER TABLE runs ADD COLUMN owner_pid INTEGER;
ALTER TABLE runs ADD COLUMN heartbeat_at INTEGER;
`,
  },
  {
    id: 15,
    name: 'file_reads',
    /**
     * 「写入前必须先读取」的读取记录从进程内存移入账本，按**会话**归属。
     *
     * **不能存放在 `ToolContext.state` 上。** 该 map 只在 **run 内有效**（投递额度、计划快照也存放其
     * 中，前者每次决策重置），存入其中时读取记录每轮清零：模型上一轮读取过、本轮直接修改，
     * 必然先失败一次「本轮未读取过」，补一次 read 后才能修改。
     *
     * 服务端**每条消息新建一个 Session**（见 `run-control.ts` 的注释），
     * 因此进程中没有会话级的生命周期可用。账本中有：每个会话是一行，
     * 删除会话时这些行随 `ON DELETE CASCADE` 一并删除，无需另设淘汰策略。
     * 上下文面板基于同一理由改为从账本实时计算（`runtime/context-panel.ts`）。
     *
     * **该守卫负责新鲜度，不负责记忆。** 存储的是**整份文件内容的哈希**，部分读取（offset/limit）也记录
     * 全量哈希，因此它不承诺模型看过全文，只判定待写入的文件是否与读取时一致。
     * 新鲜度以磁盘当前内容为准，与 run 边界无关，因此延长生命周期不放宽任何约束：文件被他人修改后同样
     * 会被拦截，拦截依据是哈希比对。
     *
     * 主键 (conversation_id, path)：同一文件重复读取时覆盖，只保留最近一次。
     * `path` 存储**解析后的绝对路径**，与内存中的键一致；模型写的相对路径
     * 形态不唯一（`js/a.js` / `./js/a.js`），以它为键会遗漏。
     */
    sql: `
CREATE TABLE file_reads (
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  path            TEXT    NOT NULL,
  hash            TEXT    NOT NULL,
  read_at         INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, path)
);
`,
  },
  {
    id: 16,
    name: 'action_kind_six',
    /**
     * 动作轴从九个值收敛为六个，**已写入磁盘的行同步转换**。
     *
     * 不转换的后果已经实测：代码中的动作枚举修改完成后，账本中的旧 step 仍带有
     * `execute` / `search` / `plan`，回放时前端查不到动词，卡片标题退回原始工具名，
     * 界面上直接出现 `update_plan` 这类内部字段。**修改协议而不转换数据，修改即不完整。**
     *
     * 每条映射均有依据：
     * `execute` / `delegate` → `run`（运行命令、运行编排节点都属于运行）、
     * `search` → `query`（搜索是查询的一种）、`fetch` → `read`（读取一份已知资源）、
     * `plan` → `write`（该工具提交待办清单，首次提交即创建）。
     *
     * `plan` 的映射同时将对象名从「计划」改为「待办」：该工具产出的始终是待办清单，
     * 「计划／方案」指另一类内容（说明实施方法的文档），名称应予区分。
     *
     * **这是一次性转换，不是兼容层**：转换完成后，代码中没有任何分支识别旧值。
     */
    sql: `
UPDATE steps
SET payload = json_set(payload, '$.action.objectLabel', '待办')
WHERE json_extract(payload, '$.action.kind') = 'plan';

UPDATE steps
SET payload = json_set(
  payload,
  '$.action.kind',
  CASE json_extract(payload, '$.action.kind')
    WHEN 'execute'  THEN 'run'
    WHEN 'delegate' THEN 'run'
    WHEN 'search'   THEN 'query'
    WHEN 'fetch'    THEN 'read'
    WHEN 'plan'     THEN 'write'
  END
)
WHERE json_extract(payload, '$.action.kind') IN ('execute', 'delegate', 'search', 'fetch', 'plan');

UPDATE steps
SET payload = json_set(
  payload,
  '$.outcome.message',
  replace(json_extract(payload, '$.outcome.message'), '计划已更新', '待办已更新')
)
WHERE json_extract(payload, '$.outcome.message') LIKE '计划已更新%';
`,
  },
  {
    id: 17,
    name: 'tool_renamed_write_todos',
    /**
     * `update_plan` 改名为 `write_todos`，**已落库的 `tool_name` 同步转换**。
     *
     * 不转换的后果已经实测确认：待办面板完全为空。面板不由事件驱动，
     * 重新加载会话时从账本投影（`web` 的 `todosFromSteps`：查找最后一次成功的
     * 待办提交，整表在其 `args` 中），而投影按新名称查找，旧行仍是旧名称，
     * 因此没有任何一行匹配，界面上表现为历史数据丢失。
     *
     * **在数据中改名而不在投影中兼容两个名称**：后者是一条兼容分支，且会长期保留
     * （B3）。同一个工具改名后，账本中记录的工具名应随之更改，
     * 否则模型回放历史时会看到当前工具表中不存在的名称。
     *
     * 这不违反「已落盘的键名是历史事实」：该规则指的是**结构键名**（列名、
     * schema 版本键、迁移标记），不是记录内容中的值。
     */
    sql: `
UPDATE steps SET tool_name = 'write_todos' WHERE tool_name = 'update_plan';
`,
  },
  {
    id: 18,
    name: 'todos_message_wording_again',
    /**
     * 再次转换待办回执中的「计划已更新」：迁移 16 只覆盖其执行时已有的行，
     * 而回执文案晚于动作轴修改，其间运行的轮次写入了新动作与旧文案的组合
     * （卡片标题为「创建待办」，展开内容为「计划已更新（1/3）」）。
     *
     * 幂等：转换完成后不存在以「计划已更新」开头的回执，重复执行命中零行。
     */
    sql: `
UPDATE steps
SET payload = json_set(
  payload,
  '$.outcome.message',
  replace(json_extract(payload, '$.outcome.message'), '计划已更新', '待办已更新')
)
WHERE json_extract(payload, '$.outcome.message') LIKE '计划已更新%';
`,
  },
  {
    id: 19,
    name: 'external_tools_action_call',
    /**
     * MCP 与插件工具的动作改为动作轴上的新值 `call`，**已写入磁盘的行同步转换**。
     *
     * 不转换时不会报错：回放历史会话时，同一个 MCP 工具的旧行显示「运行」
     * （destructive 工具显示「删除」，两个 resource 工具显示「读取」），
     * 而当前调用记录为「调用」，同一件事在同一条时间线上有两种说法。
     *
     * **判据是工具名中的 `__`。** 双下划线只由两条命名路径产生：
     * `mcp__<server>__<tool>` 与插件的 `<id>__<tool>`；内置工具名均不含双下划线
     * （`read_file` / `write_todos` / `run_command` 等是单下划线）。
     * 因此含 `__` 等价于外置工具的调用，无需另外维护内置工具名单；
     * 该名单是第二本账，每增加一个内置工具都必须同步修改。
     *
     * **不按旧值筛选，一律改写。** 存量行中外置工具记录过 run（普通 MCP 工具）、
     * delete（destructive hint）、read（两个 resource 工具），以及插件清单自行声明的
     * 任意值；当前它们全部归为 call，因此转换目标只由产生者决定。
     *
     * 幂等：转换完成后再次执行命中相同的行，写入的仍是 `call`。
     * 没有 `action` 的行由 WHERE 排除：否则 `json_set` 会为其新增一个键。
     */
    sql: `
UPDATE steps
SET payload = json_set(payload, '$.action.kind', 'call')
WHERE tool_name IS NOT NULL
  AND instr(tool_name, '__') > 0
  AND json_extract(payload, '$.action.kind') IS NOT NULL;
`,
  },
  {
    id: 20,
    name: 'external_tools_object_label',
    /**
     * 外置工具的对象名统一为「MCP」/「插件」两个类名，**已写入磁盘的行同步转换**。
     *
     * 工具卡由**动词 + 对象 + 目标**三层组成。存量行中外置工具将具体的
     * `mcp:<server>/<tool>`（插件为清单自行声明的名称）写入了对象名，
     * 因此标题与目标是完全相同的字符串，目标层重复且不提供信息。对象名应写类名，
     * 具体字符串归 `action.target`。
     *
     * 不转换时不会报错：回放历史时旧卡片显示「调用mcp:github/search」，
     * 新卡片显示「调用MCP · mcp:github/search」，同一件事有两种说法。
     *
     * 判据与迁移 19 相同：**工具名中的 `__`**，只由 `mcp__<server>__<tool>` 与
     * 插件的 `<id>__<tool>` 两条命名路径产生，内置工具名均不含。
     * 两者以**是否以 `mcp__` 开头**区分。
     *
     * **`action.target` 不改动**：它应是具体字符串，本次只修改对象名层。
     *
     * 幂等：转换完成后再次执行，写入的仍是同样的两个类名。
     * 没有 `action` 的行由 WHERE 排除：否则 `json_set` 会为其新增一个键。
     */
    sql: `
UPDATE steps
SET payload = json_set(
  payload,
  '$.action.objectLabel',
  CASE WHEN instr(tool_name, 'mcp__') = 1 THEN 'MCP' ELSE '插件' END
)
WHERE tool_name IS NOT NULL
  AND instr(tool_name, '__') > 0
  AND json_extract(payload, '$.action.objectLabel') IS NOT NULL;
`,
  },
  {
    id: 21,
    name: 'memory_tool_split',
    /**
     * `memory` 一个工具名对应四个动作，拆分为 `read_memory` / `write_memory` /
     * `delete_memory` 三个工具，**已落库的旧行按行内的 `args.action` 分别改名**。
     *
     * 不转换时不会报错：回放历史时模型会看到当前工具表中不存在的名称
     * （`transcript.ts` 将账本中的 `tool_name` 与 `args` 原样重放为一次工具调用）。
     *
     * `list` 归入 `read_memory`：语义最接近，且该动作已不再是工具，
     * 全部 key 每轮都列在上下文末尾。缺少 `action` 或值非法的行一并归入：这些行
     * 无法确定动作，归为读取最稳妥。
     *
     * **`args.action` 一并删除。** 改名后该行已不是原调用的
     * 逐字记录，保留该字段会呈现一个当前不合法的调用结构：三个新 schema 都是
     * `additionalProperties: false`，模型按历史仿写一个 `action` 会浪费一轮请求。
     * 一条 UPDATE 中有两个赋值：SQL 赋值右侧读取的是修改前的行，因此新名称仍由旧
     * `action` 计算。
     *
     * 幂等：转换完成后不存在 `tool_name = 'memory'` 的行，重复执行命中零行。
     */
    sql: `
UPDATE steps
SET tool_name = CASE json_extract(payload, '$.args.action')
    WHEN 'write'  THEN 'write_memory'
    WHEN 'delete' THEN 'delete_memory'
    ELSE 'read_memory'
  END,
  payload = json_remove(payload, '$.args.action')
WHERE tool_name = 'memory';
`,
  },
  {
    id: 22,
    name: 'goals',
    /**
     * 目标与自动继续的账本。
     *
     * **每次变更写一行，附带完整快照。** 不采用单行目标就地 UPDATE：目标需要说明
     * 停止的原因，而就地更新只保留最后一次状态，中间的暂停、改写、
     * 轮次推进全部丢失，而这些正是用户回看时需要的内容。
     *
     * **主键即 `(goal_id, revision)`，不另设事件 id。** 复合主键将
     * 「同一 revision 不得写入两次」变为数据库层的约束，两个写入方冲突时
     * 后写入者直接抛错，而不是追加第二条同版本的记录且不报错。
     *
     * **会话的最新目标通过 `ORDER BY goal_id DESC` 获取**：`gl_` 前缀之后
     * 是定宽单调 id（`core/domain/ids.ts`），字典序严格等于创建顺序。
     * 因此无需自增列，也不存在自增 id 删除后被复用的问题。
     *
     * 索引包含 `conversation_id`：外键的级联删除依赖它，无索引即全表扫描。
     */
    sql: /* sql */ `
CREATE TABLE goal_events (
  goal_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL,
  snapshot        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (goal_id, revision)
);
CREATE INDEX idx_goal_events_conv ON goal_events(conversation_id, goal_id);
`,
  },
  {
    id: 23,
    name: 'conversation_loaded_tools',
    /**
     * 记录会话已加载到工具表中的外部工具。
     *
     * **必须写入磁盘。** 服务端**每条消息新建一个 Session**，进程内已加载集合的生命周期
     * 不超过该条消息。不写入磁盘时模型每一轮都需重新 `load_tool`：它在 transcript 中看到上一轮已加载、
     * 工具表中却没有，会反复尝试。每轮固定一次的往返开销高于全部常驻，按需加载因此失去意义。
     *
     * 主键 (conversation_id, tool_name)：同一工具加载两次视为同一操作，
     * `INSERT OR IGNORE` 依赖该约束。主键同时充当外键的索引
     * （级联删除按 conversation_id 前缀查找），因此不另建索引。
     *
     * 存储的是**注册名**（`mcp__<server>__<tool>` / `<插件id>__<tool>`），
     * 即模型调用时使用的名称，也是待加载池中的键。
     */
    sql: /* sql */ `
CREATE TABLE conversation_loaded_tools (
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool_name       TEXT    NOT NULL,
  loaded_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, tool_name)
);
`,
  },
  {
    id: 24,
    name: 'conversation_provider',
    /**
     * 会话记录请求所用的接口。
     *
     * `model` 只是 ModelRef 的一半。另一半原由 `resolveModel` 临时推测：
     * 查找声明了该模型的接口，有多个时当前接口优先。两家中转站都提供
     * `claude-opus-5` 时该推测必有一半出错，后果是请求发往另一个端点、
     * 使用另一个 key、按另一份价目表记账，且三者都不报错。
     *
     * 空串表示本次迁移之前创建的会话，没有记录接口。迁移 37 按逐请求账的唯一证据
     * 补齐；无法证明的保持空串并要求用户重新选择，不再按模型 id 推测。
     */
    sql: `ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT '';`,
  },
  {
    id: 25,
    name: 'provider_finish_reason',
    /**
     * 账本记录 provider 返回的**原始值**，并删除一个始终为假的标志位。
     *
     * 增加 `finish_reason`：`runs.stop_reason` 存储的是本仓库自定义的词表
     * （`completed` / `output_truncated` / …），是归一化之后的结论。
     * 因此模型正常结束（`stop`）与模型请求调用工具但未解析出任何调用
     * （`tool_calls` + 零调用）在账本中完全相同，事后无法区分。
     * 空串表示本次迁移之前的行，或流在取得 finish_reason 之前中断。
     *
     * 删除 `measurement_exact`：三种协议都不在热路径上实测 token，写入端是常量
     * `false`，读取后没有任何消费者。始终为假的能力位比不存在更有害：
     * 后续维护者会将其视为有效的能力位。真值始终由 `provider_*_tokens` 各列提供。
     */
    sql: `
ALTER TABLE provider_requests ADD COLUMN finish_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE provider_requests DROP COLUMN measurement_exact;
`,
  },
  {
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
  },
  {
    id: 27,
    name: 'tool_image_bytes_array',
    /**
     * 工具结果中的图像字节改为数组：`data.imageData` + `data.mime`
     * → `data.images: [{data, mime}]`。
     *
     * 不迁移的后果已经实测确认，且不报错：剥离字节的 `envelopeResult` 与生成图像块的
     * `imagesOf`（均在 `agent/loop/request.ts`）只识别 `images`，旧行与两者都不匹配，
     * 因此整段 base64 原样进入信封，作为**文本**发出。同一会话实测 12 条旧行共
     * 2.79 MB base64：本地按 4 字符/token 计为 732k，provider 侧约 1.9M，
     * 一次请求直接因超出容量被拒绝；压缩清除大部分后仍有两张图留在窗口中，
     * 占 1M 窗口的 42%（428k），而以图像块发送的实测成本为每张约 1k。
     *
     * **只改键名，不重新编码。** 这些图长边为 1600，只比 `MAX_EDGE` 大 2%，
     * 而 `tools/image.ts` 文件头的实测说明重新编码 PNG 会使体积增大 2.4 倍；
     * 以图像块发送的成本取决于像素数而不是字节数，重新编码不节省任何费用。
     *
     * `mime` 一并移入数组元素：旧结构中它就是该图的 mime，留在 `data` 上会使
     * `envelopeResult` 将其视为图像之外的其他结果，在信封中保留一个
     * `{"mime":"image/png"}`，与新行结构不同；同一次调用在两轮中的内容不一致，
     * 前缀缓存从该处失效。
     *
     * 幂等：转换完成后 `$.outcome.data.imageData` 不存在，重复执行命中零行。
     * WHERE 按 JSON 路径匹配而不是按文本，因此正文中含 `imageData` 标识符的
     * `write_file` / `grep` 记录不受影响（实测库中有 10 条这样的行）。
     */
    sql: `
UPDATE steps
SET payload = json_remove(
  json_set(
    payload,
    '$.outcome.data.images',
    json_array(json_object(
      'data', json_extract(payload, '$.outcome.data.imageData'),
      'mime', json_extract(payload, '$.outcome.data.mime')
    ))
  ),
  '$.outcome.data.imageData',
  '$.outcome.data.mime'
)
WHERE json_extract(payload, '$.outcome.data.imageData') IS NOT NULL;
`,
  },
  {
    id: 28,
    name: 'step_duration',
    /**
     * 将工具调用的执行时长写入数据库。
     *
     * 该值由 `agent/loop/tool-wave.ts` 测得（`Date.now()` 之差，随 `tool.finished` 发出），
     * 但只存在于连接期间：前端将其写入内存中的 item，刷新即丢失。因此派发任务卡上
     * 对应节点的耗时在刷新后消失；工作流图不受影响，其耗时由编排器单独测量，
     * 旧记录写在 `outcome.data.nodes[]`，转换后的 workflow 记录写在 `outcome.data.receipts[]`。
     *
     * **写入列，不写入 payload。** 耗时是该 step 的属性，不是工具结果的一部分；
     * 写入 `outcome.data` 会使其随结果进入模型上下文，而 `outcome.data` 是发给模型的内容。
     *
     * 与 `execution_started_at` 的分工：后者是进入执行器之前的时间戳，用于崩溃恢复
     * 判定不确定边界；本列是执行完成后的时长。两者并存，但**不要将两者相减**：
     * 前者在提交事务时写入，与执行器实际开始执行相差一次磁盘写入。
     *
     * 存量行为 NULL：这些调用确实发生过，但时长未写入数据库。界面在无值时不显示，
     * 不为其编造数值。
     */
    sql: `ALTER TABLE steps ADD COLUMN duration_ms INTEGER;`,
  },
  {
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
  },
  {
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
  },
  {
    id: 31,
    name: 'provider_error_message',
    /**
     * 请求被 provider 拒绝时，将其返回的错误原文保存在逐请求账本中。
     *
     * `error_code` 是本仓库归一化后的分类，只能说明错误类别；限速响应中能够
     * 定位账号、端点或上游策略的正文此前只存在于异常对象中，进程结束即丢失。它也
     * 不能写入 `runs.error_message` 代替本列：一个 run 可以重发多次，每次请求各有
     * 自己的回执，真源必须仍是每个请求一行。
     *
     * NULL 表示 provider 未返回正文、请求在连接层失败，或本次迁移之前的存量行。
     */
    sql: `ALTER TABLE provider_requests ADD COLUMN error_message TEXT;`,
  },
  {
    id: 32,
    name: 'run_context_snapshot',
    /**
     * run 开始时的非对话上下文快照。它与 run 在同一行原子写入，重启、压缩
     * 与重放都从此处读取，不再在每次 provider 请求时临时重新计算。
     *
     * NULL 只表示迁移前的历史 run；新 run 必须写入 JSON 数组（空数组也写 `[]`）。
     */
    sql: `ALTER TABLE runs ADD COLUMN context_snapshot TEXT;`,
  },
  {
    id: 33,
    name: 'provider_request_transport_metrics',
    /**
     * 只记录传输层的观测数据，不保存请求正文：接口/协议用于区分路线，字节数与四个时刻
     * 用于区分请求体积膨胀、首包等待与生成阶段。NULL 表示迁移前的旧行，无数据时不写 0。
     */
    sql: `
ALTER TABLE provider_requests ADD COLUMN provider_name TEXT;
ALTER TABLE provider_requests ADD COLUMN provider_kind TEXT;
ALTER TABLE provider_requests ADD COLUMN request_bytes INTEGER;
ALTER TABLE provider_requests ADD COLUMN first_event_at INTEGER;
ALTER TABLE provider_requests ADD COLUMN first_content_at INTEGER;
ALTER TABLE provider_requests ADD COLUMN completed_at INTEGER;
`,
  },
  {
    id: 34,
    name: 'execution_failure_diagnostics',
    /**
     * 补齐两项此前只存在于进程内的事实：run 由谁中断，以及 provider 失败后
     * 重发或不重发的原因。两列都存 JSON，因为它们是同一事实的结构化详情，
     * 不是供 SQL 聚合的第二套状态；终态仍由 runs / provider_requests 的原有列负责。
     */
    sql: `
ALTER TABLE runs ADD COLUMN interruption_detail TEXT;
ALTER TABLE provider_requests ADD COLUMN diagnostic TEXT;
`,
  },
  {
    id: 35,
    name: 'ensure_execution_failure_diagnostics',
    /**
     * 按实际表结构补列，不改写已写入的迁移标记。开发数据库可能已由其他结构占用
     * 迁移编号 34，仅按编号跳过会使运行期查询引用不存在的列。
     */
    apply(db) {
      addTextColumnIfMissing(db, 'runs', 'interruption_detail')
      addTextColumnIfMissing(db, 'provider_requests', 'diagnostic')
    },
  },
  {
    id: 36,
    name: 'normalize_run_failure_messages',
    /**
     * 两种旧生产者写入 runs 的错误信息直接在账本中统一：
     *
     * - 连接计时器与 AgentLoop 各拼接过一次同一段静默时长；
     * - 已废除的固定步数终态不再对应任何当前运行机制。
     *
     * 这是一次数据修复，界面不保留按字符串识别旧记录的并行展示分支。
     */
    apply(db) {
      const duplicate = /^连接超时：(\d+) 秒内没有收到响应，\1 秒未收到响应(?=，|$)/
      const rows = db
        .query<{ id: string; error_message: string }, []>(
          `SELECT id, error_message FROM runs WHERE error_message IS NOT NULL`,
        )
        .all()
      const update = db.query(`UPDATE runs SET error_message = ? WHERE id = ?`)
      for (const row of rows) {
        const normalized = row.error_message.replace(duplicate, '连接超时，$1 秒未收到响应')
        if (normalized !== row.error_message) update.run(normalized, row.id)
      }

      db.exec(`
UPDATE runs
SET stop_reason = CASE WHEN stop_reason = 'max_steps' THEN NULL ELSE stop_reason END,
    error_message = CASE
      WHEN trim(COALESCE(error_message, '')) IN ('已达步数上限', '旧版本：已达步数上限') THEN NULL
      ELSE error_message
    END
WHERE stop_reason = 'max_steps'
   OR trim(COALESCE(error_message, '')) IN ('已达步数上限', '旧版本：已达步数上限');
`)
    },
  },
  {
    id: 37,
    name: 'canonical_runtime_records',
    /**
     * 旧结构在此一次性转换完毕，读取路径不再长期维护两套语义。
     *
     * 可证明的事实原地迁移；provider 归属没有唯一账本证据时保持未绑定，
     * 由用户重新选择，不按当前配置的枚举顺序推测，以免选错端点、key 与计价。
     */
    apply(db) {
      canonicalizeRuntimeRecords(db)
    },
  },
  {
    id: 38,
    name: 'conversation_parent',
    /**
     * 子会话所属的父会话。派发任务时写入，此后账本汇总、级联删除、运行页三项
     * 都以此列为依据，不再从 step 的 JSON 中反查两种结构。
     *
     * `ON DELETE CASCADE`：删除父会话时子会话一并删除，不留下孤立记录。账目不受影响：
     * `usage_ledger` 没有外键，按设计这些行的生命周期长于业务数据。
     *
     * NULL 表示顶层会话，或迁移之前创建的子会话。
     */
    sql: `
ALTER TABLE conversations
  ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX idx_conv_parent ON conversations(parent_conversation_id);
`,
  },
  {
    id: 39,
    name: 'subagent_kind',
    /**
     * 子会话的 `source` 改为记录子 agent 的种类：`role` / `temp` / `cli`。此前一律写
     * `workflow`，角色与临时子 agent 以 `source_ref` 是否为 `ad-hoc` 区分。
     * 新列 `external_session` 存储外部 CLI 的会话句柄，续接时传回该 CLI。
     */
    sql: `
ALTER TABLE conversations ADD COLUMN external_session TEXT;
UPDATE conversations SET source = 'temp', source_ref = NULL
  WHERE source = 'workflow' AND source_ref = 'ad-hoc';
UPDATE conversations SET source = 'role' WHERE source = 'workflow';
`,
  },
  {
    id: 40,
    name: 'step_nodes',
    /**
     * 派发任务卡的节点信息合并为 `$.nodes` 一份：旧格式中单个派发写 `$.childConversationId`、
     * 工作流图写 `$.children`，两个键都只有子会话 id，没有状态。旧行按 step 的终态
     * 推导每个节点的 phase，名称取子会话标题。
     */
    sql: `
UPDATE steps
SET payload = json_set(
      json_remove(payload, '$.childConversationId'),
      '$.nodes',
      json_object('child', json_object(
        'phase', CASE status WHEN 'success' THEN 'done' WHEN 'failure' THEN 'failed' ELSE 'interrupted' END,
        'label', coalesce((SELECT title FROM conversations
                           WHERE id = json_extract(steps.payload, '$.childConversationId')), ''),
        'subagentId', json_extract(payload, '$.childConversationId'))))
WHERE kind = 'tool_action' AND json_type(payload, '$.childConversationId') = 'text';
UPDATE steps
SET payload = json_set(
      json_remove(payload, '$.children'),
      '$.nodes',
      (SELECT json_group_object(je.key, json_object(
         'phase', CASE steps.status WHEN 'success' THEN 'done' WHEN 'failure' THEN 'failed' ELSE 'interrupted' END,
         'label', coalesce((SELECT title FROM conversations WHERE id = je.value), ''),
         'subagentId', je.value))
       FROM json_each(steps.payload, '$.children') je))
WHERE kind = 'tool_action' AND json_type(payload, '$.children') = 'object';
`,
  },
  {
    id: 41,
    name: 'delegation_kind_args',
    /**
     * 派发任务参数与回执改为按 kind 记录之后，旧行仍是旧结构：节点为 `kind: 'agent'` 加
     * `agent`（角色 id / `ad-hoc` / `cli:<id>`），单个派发的 `agent` 为空表示临时子 agent，
     * 回执带 `agent` 与 `conversationId`，卡片标题的对象名是「编排」。新解析器无法识别旧行，
     * 工作流图因此无法生成。旧行按同一规则改写；续接调用的逐节点状态由其回执推导。
     */
    apply(db) {
      const select = db.prepare<{ id: string; tool_name: string; payload: string }, []>(
        `SELECT id, tool_name, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent') AND payload IS NOT NULL`,
      )
      const rows = select.all()
      select.finalize()
      if (rows.length === 0) return
      const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>
        if (rewriteDelegationPayload(payload, row.tool_name)) {
          update.run(JSON.stringify(payload), row.id)
        }
      }
      update.finalize()
    },
  },
  {
    id: 42,
    name: 'temp_subagent_names',
    /**
     * 迁移 41 曾以子会话标题作为旧临时子 agent 的名字，而旧服务的标题就是任务正文，
     * 卡片上的任务行与节点名称因此内容相同。名字为任务正文开头部分的行改为「临时子 agent」。
     */
    apply(db) {
      const select = db.prepare<{ id: string; payload: string }, []>(
        `SELECT id, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name = 'subagent' AND payload IS NOT NULL`,
      )
      const rows = select.all()
      select.finalize()
      if (rows.length === 0) return
      const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as {
          args?: { kind?: unknown; name?: unknown; task?: unknown }
          nodes?: Record<string, { label?: unknown }>
        }
        const args = payload.args
        if (
          args?.kind !== 'temp' ||
          typeof args.name !== 'string' ||
          typeof args.task !== 'string'
        ) {
          continue
        }
        const head = args.name.replace(/…$/, '')
        if (!head || !args.task.startsWith(head)) continue
        args.name = TEMP_LABEL
        const child = payload.nodes?.child
        if (child) child.label = TEMP_LABEL
        update.run(JSON.stringify(payload), row.id)
      }
      update.finalize()
    },
  },
  {
    id: 43,
    name: 'subagent_names',
    /**
     * 子 agent 的名字只有一份：新建时给定的 name（角色取 role id，外部 CLI 取 cli id），
     * 子会话标题与卡片上对应节点使用的都是它。旧行的节点名称是子会话标题（旧服务写入的是任务正文），
     * 迁移 42 又将单个派发的临时子 agent 命名为「临时子 agent」，两者都不是名字。
     * 节点名称取派发参数中的目标名，没有名字的临时子 agent 取其模型 id。
     *
     * 预编译语句使用 prepare 并在末尾 finalize：未执行的缓存语句会使数据库文件在 close 之后
     * 仍被占用，在 Windows 上无法删除。
     */
    apply(db) {
      const select = db.prepare<{ id: string; tool_name: string; payload: string }, []>(
        `SELECT id, tool_name, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent') AND payload IS NOT NULL
         ORDER BY created_at ASC, seq ASC`,
      )
      const rows = select.all()
      select.finalize()
      if (rows.length === 0) return
      const convOf = db.prepare<{ title: string; model: string }, [string]>(
        'SELECT title, model FROM conversations WHERE id = ?',
      )
      const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
      const nameOf = (target: Record<string, unknown>, subagentId?: string): string | undefined => {
        for (const key of ['name', 'role', 'cli']) {
          const value = target[key]
          if (typeof value === 'string' && value && value !== TEMP_LABEL) return value
        }
        if (target.kind === 'temp' && subagentId) return convOf.get(subagentId)?.model
        return undefined
      }
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as {
          args?: Record<string, unknown>
          nodes?: Record<string, { label?: unknown; subagentId?: unknown }>
        }
        const targets: Record<string, Record<string, unknown>> = {}
        if (row.tool_name === 'subagent' && payload.args) targets.child = payload.args
        if (row.tool_name === 'workflow' && Array.isArray(payload.args?.nodes)) {
          for (const raw of payload.args.nodes) {
            const node = raw as Record<string, unknown>
            if (typeof node.id === 'string') targets[node.id] = node
          }
        }
        let changed = false
        for (const [id, state] of Object.entries(payload.nodes ?? {})) {
          const subagentId = typeof state.subagentId === 'string' ? state.subagentId : undefined
          const label = typeof state.label === 'string' ? state.label : ''
          const copied =
            label === TEMP_LABEL ||
            (subagentId !== undefined && label === convOf.get(subagentId)?.title)
          const target = targets[id]
          if (copied && target) {
            const name = nameOf(target, subagentId)
            if (name && name !== label) {
              state.label = name
              if (target.kind === 'temp' && target.name === TEMP_LABEL) target.name = name
              changed = true
            }
          }
        }
        if (changed) update.run(JSON.stringify(payload), row.id)
      }
      convOf.finalize()
      update.finalize()
    },
  },
  {
    id: 44,
    name: 'temp_cells_by_model',
    /** 临时子 agent 的节点名称统一为其模型名；存量行中混有节点 id、给定名等多种名称。 */
    apply(db) {
      const select = db.prepare<{ id: string; payload: string }, []>(
        `SELECT id, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent')
           AND json_type(payload, '$.nodes') = 'object'`,
      )
      const rows = select.all()
      select.finalize()
      if (rows.length === 0) return
      const convOf = db.prepare<{ source: string | null; model: string }, [string]>(
        'SELECT source, model FROM conversations WHERE id = ?',
      )
      const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as {
          nodes: Record<string, { label?: unknown; subagentId?: unknown }>
        }
        let changed = false
        for (const state of Object.values(payload.nodes)) {
          if (typeof state.subagentId !== 'string') continue
          const conversation = convOf.get(state.subagentId)
          if (conversation?.source !== 'temp' || state.label === conversation.model) continue
          state.label = conversation.model
          changed = true
        }
        if (changed) update.run(JSON.stringify(payload), row.id)
      }
      convOf.finalize()
      update.finalize()
    },
  },
  {
    id: 45,
    name: 'single_cell_duration',
    /** 单个派发的节点耗时即本次调用的耗时。旧服务只记录在 step 上，节点中没有，此处复制到节点。 */
    apply(db) {
      const select = db.prepare<{ id: string; duration_ms: number; payload: string }, []>(
        `SELECT id, duration_ms, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name = 'subagent' AND duration_ms IS NOT NULL
           AND json_type(payload, '$.nodes.child') = 'object'
           AND json_extract(payload, '$.nodes.child.durationMs') IS NULL`,
      )
      const rows = select.all()
      select.finalize()
      if (rows.length === 0) return
      const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as { nodes: { child: { durationMs?: number } } }
        payload.nodes.child.durationMs = row.duration_ms
        update.run(JSON.stringify(payload), row.id)
      }
      update.finalize()
    },
  },
  {
    id: 46,
    name: 'temp_cells_by_name',
    /**
     * 临时子 agent 创建时必须给定名字，该名字即子会话标题；节点显示该名字，不显示模型名。
     * 迁移 44 将节点名称统一为模型名，此处改回标题；单个派发参数中的 name 同步修改。
     */
    apply(db) {
      const select = db.prepare<{ id: string; tool_name: string; payload: string }, []>(
        `SELECT id, tool_name, payload FROM steps
         WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent')
           AND json_type(payload, '$.nodes') = 'object'`,
      )
      const rows = select.all()
      select.finalize()
      if (rows.length === 0) return
      const convOf = db.prepare<{ source: string | null; title: string }, [string]>(
        'SELECT source, title FROM conversations WHERE id = ?',
      )
      const update = db.prepare('UPDATE steps SET payload = ? WHERE id = ?')
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as {
          args?: { kind?: unknown; name?: unknown }
          nodes: Record<string, { label?: unknown; subagentId?: unknown }>
        }
        let changed = false
        for (const [id, state] of Object.entries(payload.nodes)) {
          if (typeof state.subagentId !== 'string') continue
          const conversation = convOf.get(state.subagentId)
          if (conversation?.source !== 'temp' || !conversation.title) continue
          if (state.label !== conversation.title) {
            state.label = conversation.title
            changed = true
          }
          if (
            id === 'child' &&
            row.tool_name === 'subagent' &&
            payload.args?.kind === 'temp' &&
            payload.args.name !== conversation.title
          ) {
            payload.args.name = conversation.title
            changed = true
          }
        }
        if (changed) update.run(JSON.stringify(payload), row.id)
      }
      convOf.finalize()
      update.finalize()
    },
  },
  {
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
  },
  {
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
  },
  {
    id: 49,
    name: 'provider_requests_purpose',
    /**
     * 轮内压缩产生的摘要请求按本轮的普通请求写入（占用一个 turn 编号，usage 计入本轮），
     * 以本列与主请求区分：上下文锚点、命中率只统计 turn，摘要长度统计只统计 summary。
     * 旧行均为主请求。
     */
    sql: `
ALTER TABLE provider_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'turn' CHECK (purpose IN ('turn','summary'));
`,
  },
  {
    id: 50,
    name: 'message_origin',
    /**
     * 子 agent 与 workflow 的回执以 user 角色发给模型，写入数据库时以本列与用户本人的消息区分。
     * 可空：旧行与用户发送的消息均为 NULL，不回填。
     */
    sql: `
ALTER TABLE messages ADD COLUMN origin TEXT CHECK (origin IN ('subagent','workflow'));
`,
  },
  {
    id: 51,
    name: 'run_dispatch',
    /**
     * 子会话的每一轮由哪次任务派发产生，在创建 run 时写入该行：父会话中派发任务卡的 step 与卡片上的对应节点。
     * 变更投影据此将子会话的写入归入父轮，不按时间推断：派发任务在派出后立即返回，父 step 一百多毫秒即结束，
     * 子会话的 run 在此之后才创建，按执行窗口推断会将其全部排除。
     * 旧行回填：归入该轮创建之前最近一次派发该子会话的节点。
     */
    sql: `
ALTER TABLE runs ADD COLUMN dispatch_step_id TEXT;
ALTER TABLE runs ADD COLUMN dispatch_node_id TEXT;
CREATE INDEX idx_runs_dispatch ON runs(dispatch_step_id);
UPDATE runs SET
  dispatch_step_id = (
    SELECT s.id FROM steps s
    JOIN runs pr ON pr.id = s.run_id
    JOIN json_each(s.payload, '$.nodes') n
    WHERE pr.conversation_id = (SELECT parent_conversation_id FROM conversations WHERE id = runs.conversation_id)
      AND s.payload IS NOT NULL
      AND json_extract(n.value, '$.subagentId') = runs.conversation_id
      AND s.created_at <= runs.created_at
    ORDER BY s.created_at DESC, n.key LIMIT 1),
  dispatch_node_id = (
    SELECT n.key FROM steps s
    JOIN runs pr ON pr.id = s.run_id
    JOIN json_each(s.payload, '$.nodes') n
    WHERE pr.conversation_id = (SELECT parent_conversation_id FROM conversations WHERE id = runs.conversation_id)
      AND s.payload IS NOT NULL
      AND json_extract(n.value, '$.subagentId') = runs.conversation_id
      AND s.created_at <= runs.created_at
    ORDER BY s.created_at DESC, n.key LIMIT 1)
WHERE conversation_id IN (SELECT id FROM conversations WHERE parent_conversation_id IS NOT NULL);
`,
  },
  {
    id: 52,
    name: 'watcher_hidden_dirs',
    /**
     * 清除工作区观察器按点前缀排除的规则生效期间记入账本的隐藏目录路径（`.xxx/` 下的路径）。
     * 只清除观察器判定的记录（没有 `additions` 的），文件类工具的精确明细不改动；派发任务卡各节点的
     * `fileChanges` 全部来自观察器，按路径清除。
     *
     * 观察器此后按 Git 的忽略规则判定，项目自身的点路径不再被排除。本迁移不重新执行，
     * 也不恢复已清除的记录。
     */
    sql: `
UPDATE steps SET payload = json_set(payload, '$.outcome.fileChanges',
  (SELECT json_group_array(json(c.value)) FROM json_each(steps.payload, '$.outcome.fileChanges') c
    WHERE NOT (json_extract(c.value, '$.additions') IS NULL
               AND (json_extract(c.value, '$.path') LIKE '.%/%'
                    OR json_extract(c.value, '$.path') LIKE '%/.%/%'))))
WHERE json_type(payload, '$.outcome.fileChanges') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.outcome.fileChanges') c
              WHERE json_extract(c.value, '$.additions') IS NULL
                AND (json_extract(c.value, '$.path') LIKE '.%/%'
                     OR json_extract(c.value, '$.path') LIKE '%/.%/%'));
UPDATE steps SET payload = json_set(payload, '$.nodes',
  (SELECT json_group_object(n.key,
     CASE WHEN json_type(n.value, '$.fileChanges') = 'array'
          THEN json(json_set(n.value, '$.fileChanges',
                 (SELECT json_group_array(json(c.value)) FROM json_each(n.value, '$.fileChanges') c
                   WHERE NOT (json_extract(c.value, '$.path') LIKE '.%/%'
                              OR json_extract(c.value, '$.path') LIKE '%/.%/%'))))
          ELSE json(n.value) END)
   FROM json_each(steps.payload, '$.nodes') n))
WHERE json_type(payload, '$.nodes') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.nodes') n, json_each(n.value, '$.fileChanges') c
              WHERE json_extract(c.value, '$.path') LIKE '.%/%'
                 OR json_extract(c.value, '$.path') LIKE '%/.%/%');
`,
  },
  {
    id: 53,
    name: 'watcher_dot_paths',
    /**
     * 迁移 52 清除的是隐藏目录下的路径，以点开头的单个文件（脚本生成的 `.tmp-verify`、`.fin`
     * 等临时标记）与已删除的 `.chk` 文件仍留在账本中。已执行的迁移不修改内容，
     * 剩余部分由本迁移处理，清除方法与 52 相同。
     *
     * 同 52：观察器此后按 Git 的忽略规则判定，本迁移不重新执行。
     */
    sql: `
UPDATE steps SET payload = json_set(payload, '$.outcome.fileChanges',
  (SELECT json_group_array(json(c.value)) FROM json_each(steps.payload, '$.outcome.fileChanges') c
    WHERE NOT (json_extract(c.value, '$.additions') IS NULL
               AND (json_extract(c.value, '$.path') LIKE '.%'
                    OR json_extract(c.value, '$.path') LIKE '%/.%'))))
WHERE json_type(payload, '$.outcome.fileChanges') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.outcome.fileChanges') c
              WHERE json_extract(c.value, '$.additions') IS NULL
                AND (json_extract(c.value, '$.path') LIKE '.%'
                     OR json_extract(c.value, '$.path') LIKE '%/.%'));
UPDATE steps SET payload = json_set(payload, '$.nodes',
  (SELECT json_group_object(n.key,
     CASE WHEN json_type(n.value, '$.fileChanges') = 'array'
          THEN json(json_set(n.value, '$.fileChanges',
                 (SELECT json_group_array(json(c.value)) FROM json_each(n.value, '$.fileChanges') c
                   WHERE NOT (json_extract(c.value, '$.path') LIKE '.%'
                              OR json_extract(c.value, '$.path') LIKE '%/.%'))))
          ELSE json(n.value) END)
   FROM json_each(steps.payload, '$.nodes') n))
WHERE json_type(payload, '$.nodes') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.nodes') n, json_each(n.value, '$.fileChanges') c
              WHERE json_extract(c.value, '$.path') LIKE '.%'
                 OR json_extract(c.value, '$.path') LIKE '%/.%');
`,
  },
  {
    id: 54,
    name: 'schedules',
    /**
     * 定时任务从全机共用的 JSON 文件迁入主账本。
     *
     * 到期判定、认领与创建会话必须在同一个写事务中完成，否则两个服务实例会对同一条到期
     * 任务各启动一轮；JSON 只能在单进程内排队，无法跨进程裁决。
     *
     * 表中只有配置与触发游标：上一次的执行结果按 `last_run_conversation_id` 关联的 Run 读取。
     * 会话被删除时该列置空，`last_run_at` 保留：触发已发生是事实，与执行记录是否存在无关。
     *
     * 建表不包含数据迁移：旧文件的读取与改名由运行装配层执行，迁移不读取开发机的全局配置目录。
     */
    sql: `
CREATE TABLE schedules (
  id                       TEXT PRIMARY KEY,
  workspace_root           TEXT NOT NULL,
  title                    TEXT NOT NULL,
  prompt                   TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('interval','daily')),
  every_minutes            INTEGER,
  at_hour                  INTEGER,
  at_minute                INTEGER,
  enabled                  INTEGER NOT NULL,
  created_at               INTEGER NOT NULL,
  last_run_at              INTEGER,
  last_run_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX idx_schedules_workspace ON schedules(workspace_root);
CREATE INDEX idx_schedules_last_conversation ON schedules(last_run_conversation_id);
`,
  },
  {
    id: 55,
    name: 'workspace_root_separator',
    /**
     * 工作区根路径按分隔符归一化，同一目录的重复行合并到最早创建的行。
     *
     * `root_path` 是 UNIQUE，但按字符串比较：`C:/x/ws` 与 `C:\x\ws` 指向同一目录却
     * 各占一行，该目录下的会话因此分散在两个项目中。此后的写入与按根路径查找都经由
     * `repos.ts` 的 `normalizeWorkspaceRoot`。
     *
     * **本迁移只做分隔符归一化。** `path.resolve` 的基准是写入时的进程工作目录，对已写入
     * 的行无法复现，因此相对路径不合并；符号链接、盘符大小写、8.3 短名同样不合并。
     * 是否为 Windows 路径按盘符判定，不按运行平台：POSIX 上 `\` 是合法的文件名字符。
     *
     * 合并保留最早一行的全部字段（名字、置顶、`last_opened_at`、`removed_at`），
     * 其余行的会话、run、权限规则与审计、账目改为指向该行后删除。
     * `uq_permission_scope` 不允许一个工作区下有两条相同 scope 的规则，两行都有时保留最早一行的规则。
     */
    apply: (db) => {
      // 迁移只执行一次，语句使用 `prepare` 并在用完后 `finalize`。不要换成 `db.query`：它将语句
      // 永久缓存在连接上，占用的缓存槽位会使后续「写入失败 → 读取 → 事务」序列之后的
      // `close()` 无法完全释放，主库文件在进程退出前一直被占用。
      const keeper = new Map<string, string>()
      const merged: [string, string][] = []
      const renamed: [string, string][] = []
      const rowsStmt = db.prepare<{ id: string; root_path: string }, []>(
        'SELECT id, root_path FROM workspaces ORDER BY created_at ASC, id ASC',
      )
      const rows = rowsStmt.all()
      rowsStmt.finalize()
      for (const row of rows) {
        const root = windowsSeparators(row.root_path)
        const first = keeper.get(root)
        if (first === undefined) {
          keeper.set(root, row.id)
          if (root !== row.root_path) renamed.push([row.id, root])
        } else {
          merged.push([row.id, first])
        }
      }

      if (merged.length > 0) {
        const dropRules = db.prepare(
          `DELETE FROM permission_rules WHERE workspace_id = ?
             AND scope IN (SELECT scope FROM permission_rules WHERE workspace_id = ?)`,
        )
        const repoint = [
          'conversations',
          'runs',
          'permission_rules',
          'permission_audit',
          'usage_ledger',
        ].map((table) => db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`))
        const dropWorkspace = db.prepare('DELETE FROM workspaces WHERE id = ?')
        for (const [from, to] of merged) {
          dropRules.run(from, to)
          for (const stmt of repoint) stmt.run(to, from)
          dropWorkspace.run(from)
        }
        for (const stmt of [dropRules, ...repoint, dropWorkspace]) stmt.finalize()
      }
      // 先删除重复行再改名：保留行的目标字符串可能正是某个重复行当前的值，
      // 顺序颠倒会触发 root_path 的 UNIQUE 冲突。
      if (renamed.length > 0) {
        const rename = db.prepare('UPDATE workspaces SET root_path = ? WHERE id = ?')
        for (const [id, root] of renamed) rename.run(root, id)
        rename.finalize()
      }

      const rootsStmt = db.prepare<{ workspace_root: string }, []>(
        'SELECT DISTINCT workspace_root FROM schedules',
      )
      const roots = rootsStmt.all()
      rootsStmt.finalize()
      const renameSchedule = db.prepare(
        'UPDATE schedules SET workspace_root = ? WHERE workspace_root = ?',
      )
      for (const row of roots) {
        const root = windowsSeparators(row.workspace_root)
        if (root === row.workspace_root) continue
        renameSchedule.run(root, row.workspace_root)
      }
      renameSchedule.finalize()
    },
  },
  {
    id: 56,
    name: 'control_object_labels',
    /**
     * 两组控制类工具的对象名改为「电脑控制」「浏览器控制」，已写入磁盘的 step 同步转换。
     *
     * 对象名随 step 写入数据库，会话回放按写入的值拼接「动词 + 对象」。只修改工具声明时，
     * 同一会话中改名前后的步骤会显示两个不同的名称。
     *
     * 只转换这两组工具自身的 step：按工具名前缀限定，不按对象名全表替换，
     * 因为「浏览器」也可能是其他工具或插件声明的对象名。桌面工具没有具体目标时将对象名
     * 同时写入了 `target`，该字段一并转换。
     *
     * 一次性转换，不是兼容层：转换完成后，代码中没有分支识别旧名称。
     */
    sql: `
UPDATE steps
SET payload = json_set(payload, '$.action.objectLabel', '电脑控制')
WHERE tool_name LIKE 'desktop\\_%' ESCAPE '\\'
  AND json_extract(payload, '$.action.objectLabel') = '电脑操作';

UPDATE steps
SET payload = json_set(payload, '$.action.target', '电脑控制')
WHERE tool_name LIKE 'desktop\\_%' ESCAPE '\\'
  AND json_extract(payload, '$.action.target') = '电脑操作';

UPDATE steps
SET payload = json_set(payload, '$.action.objectLabel', '浏览器控制')
WHERE tool_name LIKE 'browser\\_%' ESCAPE '\\'
  AND json_extract(payload, '$.action.objectLabel') = '浏览器';
`,
  },
  {
    id: 57,
    name: 'schedule_conversation',
    /**
     * 定时任务绑定会话：`last_run_conversation_id` 改名为 `conversation_id`，
     * 语义是最近一次触发所进入的会话。
     *
     * 默认触发将 prompt 作为一条用户消息发送到该列指向的会话，上下文在多次触发间延续；
     * 已有行指向最近一次触发创建的会话，保留原值即完成绑定。
     *
     * `new_conversation = 1` 的任务每次触发另建一个会话，各次互不可见，该列仍写入本次进入的
     * 会话，忙碌状态判定与终态投影因此使用同一路径。存量行默认为 0。
     *
     * 索引一并重建：`RENAME COLUMN` 会改写索引中的列引用，但不修改索引名。
     * 外键仍是 `ON DELETE SET NULL`：会话被删除后，下一次触发新建会话并写回该列。
     */
    sql: `
ALTER TABLE schedules RENAME COLUMN last_run_conversation_id TO conversation_id;
ALTER TABLE schedules ADD COLUMN new_conversation INTEGER NOT NULL DEFAULT 0;
DROP INDEX idx_schedules_last_conversation;
CREATE INDEX idx_schedules_conversation ON schedules(conversation_id);
`,
  },
  {
    id: 58,
    name: 'provider_request_headers_at',
    /**
     * 观察到响应头到达的时刻。它与 `first_event_at` 含义不同：响应头已到达而首个
     * 协议事件未到达的区间，是中转站接受请求之后、模型产出之前的等待，只有本列能将其
     * 与连接尚未建立区分开。NULL 表示迁移前的旧行或响应头未到达。
     */
    sql: `ALTER TABLE provider_requests ADD COLUMN headers_at INTEGER;`,
  },
  {
    id: 59,
    name: 'provider_request_input_image_batch_id',
    /**
     * 本次输入实际完整携带的一批工具图片，值是产生该批调用的请求 id。
     * 它与 `steps.provider_batch_id` 含义不同：后者记录生成归属，
     * 本列记录输入事实。能力过滤与压缩都会移除图片、保留文字，因此一次成功的请求
     * 不能证明模型看到过图片。NULL 表示迁移前的旧行、本次未携带图片，或图片未完整
     * 进入请求体；不按时间回填。
     */
    sql: `ALTER TABLE provider_requests ADD COLUMN input_image_batch_id TEXT;`,
  },
  {
    id: 60,
    name: 'provider_request_last_content_at',
    /**
     * 观察到最后一段非空正文、思考或新增工具参数到达的时刻。
     * `first_content_at` 无法反映当前已静默多久：持续输出时首个内容的时刻与当前的间隔不断增大。
     * 心跳、空 delta、响应头与用量都不更新本列。NULL 表示迁移前的旧行或本次尚无内容。
     */
    sql: `ALTER TABLE provider_requests ADD COLUMN last_content_at INTEGER;`,
  },
  {
    id: 61,
    name: 'provider_request_visible_progress',
    // 内容类别与可见时刻同属请求账本；不从旧行的首内容时刻推测可见进展。
    sql: `
ALTER TABLE provider_requests ADD COLUMN last_content_kind TEXT CHECK (last_content_kind IN ('thinking','text','tool_arguments','other'));
ALTER TABLE provider_requests ADD COLUMN last_visible_at INTEGER;
`,
  },
  {
    id: 62,
    name: 'drop_permission_rules_and_audit',
    // 两张表没有任何读写方：权限裁决由 `Session.decide` 按模式与命令实时判定，不存储规则，也不记录审计。
    sql: `
DROP TABLE permission_rules;
DROP TABLE permission_audit;
`,
  },
  {
    id: 63,
    name: 'drop_conversation_extras',
    // 没有读写方：会话装配不再按会话关闭技能 / 记忆 / 扩展工具，界面也没有入口。
    sql: `DROP TABLE conversation_extras;`,
  },
  {
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
  },
  {
    id: 65,
    name: 'user_only_messages',
    /**
     * `messages` 只存储用户发送的消息：助手回复与工具记录始终在 `steps` 中，`role = 'assistant'` 没有写入方，
     * `runs.assistant_message_id` 恒为 NULL。
     *
     * 表重建而不是 ALTER：SQLite 无法修改 CHECK 约束。存量库若有助手行，本迁移在插入时失败并整体回滚；
     * 不要改为先删除再插入，那样会丢失数据且不报错。没有表以外键引用 `messages`，重建不会引发级联删除。
     */
    sql: `
CREATE TABLE messages_new (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role = 'user'),
  content         TEXT NOT NULL DEFAULT '',
  attachments     TEXT,
  created_at      INTEGER NOT NULL,
  origin          TEXT CHECK (origin IN ('subagent','workflow'))
);
INSERT INTO messages_new (id, conversation_id, role, content, attachments, created_at, origin)
  SELECT id, conversation_id, role, content, attachments, created_at, origin FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_msg_conv ON messages(conversation_id, id);
ALTER TABLE runs DROP COLUMN assistant_message_id;
`,
  },
  {
    id: 66,
    name: 'provider_request_occupancy_tokens',
    /**
     * 发出本次请求时运行中的上下文读数（`RunState.meter`：上一次回执的输入与输出加上其后的
     * 本地增量），即界面读数条显示的值。面板对尚无回执的请求直接读取本列，不重新计算。
     * NULL 表示摘要请求或迁移前的旧行；不回填。
     */
    sql: `ALTER TABLE provider_requests ADD COLUMN occupancy_tokens INTEGER;`,
  },
  {
    id: 67,
    name: 'provider_request_configuration',
    sql: `ALTER TABLE provider_requests ADD COLUMN configuration TEXT;`,
  },
  {
    id: 68,
    name: 'run_owner_kind',
    /**
     * 占用该轮的进程类别：`serve`（桌面端与手机端连接的服务）或 `cli`（终端的 qy）。
     * 另一个进程在同一会话上启动一轮被拒绝时，提示据此说明占用方的位置。
     * NULL 表示迁移前的旧行，或建库时未声明进程类别（测试）。不回填。
     */
    sql: `ALTER TABLE runs ADD COLUMN owner_kind TEXT;`,
  },
  {
    id: 69,
    name: 'provider_request_hedge',
    /**
     * 响应头之前补发的第二份请求：发出时刻，以及最终采用的是否为它（0/1）。两份请求都已发出、都可能计费，
     * 逐请求表据此与服务商账单对照。NULL 表示未补发或迁移前的旧行；不回填。
     */
    sql: `
ALTER TABLE provider_requests ADD COLUMN hedge_sent_at INTEGER;
ALTER TABLE provider_requests ADD COLUMN hedge_won INTEGER;
`,
  },
]

/**
 * 当前 schema 版本 = 最后一条迁移的 id。
 *
 * **由迁移表派生，不手写。** 手写的值与迁移表之间没有任何约束：新增迁移时遗漏修改，
 * 它就与迁移表不一致且无法察觉，因为实际决定迁移的是 `_migrations` 表，
 * 没有任何消费者校验该常量。派生后两者必然一致。
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id

/*
 * ─────────────────────────────── 数据库行的结构 ───────────────────────────────
 *
 * **以下接口是上方迁移表执行完毕后的镜像，不是第二份定义。** 增加列、修改列名或可空性时
 * 必须同时修改此处；遗漏时 `schema.test.ts` 中按 `PRAGMA table_info` 逐表比对的
 * 测试会失败。若没有该测试，这些接口就是一份无人校验的第二本账。
 *
 * **只列出映射函数实际读取的表。** 写入使用 INSERT 的具名参数，不需要行类型。
 *
 * 两处以类型声明代替断言，集中写在此处，而不是分散在各个映射函数中：
 *
 * - **主键列声明为非空。** SQLite 的 `TEXT PRIMARY KEY` 不隐含 NOT NULL，`PRAGMA`
 *   因此报告其可空；但主键无法写入 NULL，读取时一定有值。
 * - **id 列声明为品牌化 id 类型。** 写入侧只会写入 `newRunId()` 这类值，
 *   因此列中的值确实是该类型。在此处断言一次，优于在六个映射函数中断言三十次。
 */

export interface WorkspaceRow {
  id: WorkspaceId
  name: string
  root_path: string
  last_opened_at: number
  created_at: number
  removed_at: number | null
  pinned_at: number | null
}

export interface ConversationRow {
  id: ConversationId
  workspace_id: WorkspaceId
  title: string
  provider: string
  model: string
  compaction_manifest: string | null
  cache_generation: number
  /** 该列没有 CHECK 约束，但写入侧只写入 `role` / `temp` / `cli` 之一。 */
  source: 'role' | 'temp' | 'cli' | null
  source_ref: string | null
  external_session: string | null
  /** 派发任务创建的子会话指向它的父会话；顶层会话为 NULL。 */
  parent_conversation_id: ConversationId | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: MessageId
  conversation_id: ConversationId
  /** `CHECK (role = 'user')`：助手回复与工具记录在 `steps`。 */
  role: 'user'
  content: string
  attachments: string | null
  /** `CHECK (origin IN ('subagent','workflow'))`。NULL 表示用户本人发送的消息。 */
  origin: 'subagent' | 'workflow' | null
  created_at: number
}

export interface RunRow {
  id: RunId
  conversation_id: ConversationId
  workspace_id: WorkspaceId
  user_message_id: MessageId | null
  message_id_upper_bound: MessageId | null
  model: string
  client_request_id: string
  /** `CHECK (status IN ('queued','running','done','failed','interrupted'))`。 */
  status: RunStatus
  stop_reason: StopReason | null
  input_tokens: number
  output_tokens: number
  /** NULL 表示 provider 未回报，与实际命中为 0 含义不同。不要用 COALESCE 转为 0。 */
  cached_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number
  cost: number
  currency: Currency
  usage_turns: string
  step_count: number
  error_message: string | null
  error_code: string | null
  /** `RunInterruption` JSON。NULL = 未中断、普通失败或迁移前记录。 */
  interruption_detail: string | null
  /** NULL = 迁移前存量；新 run 写入 `RunContextSegment[]` JSON。 */
  context_snapshot: string | null
  owner_pid: number | null
  heartbeat_at: number | null
  /** `RunOwner`；NULL = 迁移前旧行或未声明进程类别。 */
  owner_kind: string | null
  /** 派发来源，见 `Run.dispatchStepId`。NULL = 并非派发产生。 */
  dispatch_step_id: StepId | null
  dispatch_node_id: string | null
  /** 本轮的生成花费，`MediaSpend[]` JSON。 */
  media_usage: string
  created_at: number
  finished_at: number | null
}

export interface StepRow {
  id: StepId
  run_id: RunId
  seq: number
  /** `CHECK (kind IN ('text','tool_action','compaction','thinking','user'))`。 */
  kind: StepKind
  tool_name: string | null
  tool_call_id: string | null
  provider_batch_id: string | null
  call_index: number | null
  execution_wave_index: number | null
  execution_started_at: number | null
  content: string | null
  payload: string | null
  status: ToolActionStatus | 'done'
  created_at: number
  /** 工具调用的执行时长。存量行与非工具行为 null。 */
  duration_ms: number | null
}

export interface ProviderRequestRow {
  id: ProviderRequestId
  run_id: RunId
  turn_index: number
  retry_index: number
  purpose: string
  provider_name: string | null
  provider_kind: ProviderKind | null
  model: string
  /** `CHECK (status IN ('pending','in_flight','received','uncertain','rejected'))`。 */
  status: ProviderRequestStatus
  measured_input_tokens: number
  /** 发出时的运行中读数；见 `ProviderRequest.occupancyTokens`。 */
  occupancy_tokens: number | null
  provider_input_tokens: number | null
  provider_output_tokens: number | null
  provider_cached_tokens: number | null
  provider_cache_write_tokens: number | null
  sent_categories: string
  omitted_categories: string
  finish_reason: string
  error_code: string | null
  error_message: string | null
  /** `ProviderRequestDiagnostic` JSON。 */
  diagnostic: string | null
  configuration: string | null
  payload_hash: string
  request_bytes: number | null
  cache_route_fingerprint: string | null
  /** 已停止写入：媒体的保留与移除改为按字节预算换出后，不再记录批次送达凭证。存量行保留原值，不删除该列。 */
  input_image_batch_id: string | null
  sent_at: number | null
  headers_at: number | null
  /** 补发第二份请求的时刻；未补发为 NULL。 */
  hedge_sent_at: number | null
  /** SQLite 没有布尔类型，使用 0/1。1 表示采用的是补发的一份；未补发为 NULL。 */
  hedge_won: number | null
  first_event_at: number | null
  first_content_at: number | null
  last_content_at: number | null
  last_content_kind: ProviderRequestContentKind | null
  last_visible_at: number | null
  completed_at: number | null
  created_at: number
}

export interface IntermediateResourceRow {
  id: ResourceId
  run_id: RunId
  step_id: StepId | null
  tool_name: string
  source_type: string
  /** `CHECK (status IN ('complete','partial','failed'))`。 */
  status: ResourceStatus
  content_hash: string | null
  size_bytes: number
  mime_type: string | null
  coverage: string
  created_at: number
}

export interface ScheduleRow {
  id: string
  workspace_root: string
  title: string
  prompt: string
  /** `CHECK (kind IN ('interval','daily'))`。 */
  kind: ScheduleKind
  every_minutes: number | null
  at_hour: number | null
  at_minute: number | null
  /** SQLite 没有布尔类型，使用 0/1。 */
  enabled: number
  created_at: number
  last_run_at: number | null
  /** `ON DELETE SET NULL`：最近一次触发所进入的会话；会话被删除后置空，触发游标保留。 */
  conversation_id: string | null
  /** SQLite 没有布尔类型，使用 0/1。1 表示每次触发另建一个会话。 */
  new_conversation: number
}

/**
 * 表名 → 该表的列名。**供比对测试使用**：接口的键在运行时无法获取，因此列名单独列出一份；
 * 它与接口写在同一处、在同一次修改中更新，遗漏修改会被测试发现。
 */
export const ROW_COLUMNS: Record<string, readonly string[]> = {
  workspaces: [
    'id',
    'name',
    'root_path',
    'last_opened_at',
    'created_at',
    'removed_at',
    'pinned_at',
  ],
  conversations: [
    'id',
    'workspace_id',
    'title',
    'provider',
    'model',
    'compaction_manifest',
    'cache_generation',
    'source',
    'source_ref',
    'parent_conversation_id',
    'external_session',
    'archived_at',
    'created_at',
    'updated_at',
  ],
  messages: ['id', 'conversation_id', 'role', 'content', 'attachments', 'origin', 'created_at'],
  runs: [
    'id',
    'conversation_id',
    'workspace_id',
    'user_message_id',
    'message_id_upper_bound',
    'model',
    'client_request_id',
    'status',
    'stop_reason',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'cost',
    'currency',
    'usage_turns',
    'step_count',
    'error_message',
    'error_code',
    'interruption_detail',
    'context_snapshot',
    'owner_pid',
    'owner_kind',
    'heartbeat_at',
    'created_at',
    'finished_at',
    'dispatch_step_id',
    'dispatch_node_id',
    'media_usage',
  ],
  steps: [
    'id',
    'run_id',
    'seq',
    'kind',
    'tool_name',
    'tool_call_id',
    'provider_batch_id',
    'call_index',
    'execution_wave_index',
    'execution_started_at',
    'content',
    'payload',
    'status',
    'created_at',
    'duration_ms',
  ],
  provider_requests: [
    'id',
    'run_id',
    'turn_index',
    'retry_index',
    'purpose',
    'provider_name',
    'provider_kind',
    'model',
    'status',
    'measured_input_tokens',
    'occupancy_tokens',
    'provider_input_tokens',
    'provider_output_tokens',
    'provider_cache_write_tokens',
    'provider_cached_tokens',
    'sent_categories',
    'omitted_categories',
    'finish_reason',
    'error_code',
    'error_message',
    'diagnostic',
    'configuration',
    'payload_hash',
    'request_bytes',
    'cache_route_fingerprint',
    'input_image_batch_id',
    'sent_at',
    'headers_at',
    'hedge_sent_at',
    'hedge_won',
    'first_event_at',
    'first_content_at',
    'last_content_at',
    'last_content_kind',
    'last_visible_at',
    'completed_at',
    'created_at',
  ],
  intermediate_resources: [
    'id',
    'run_id',
    'step_id',
    'tool_name',
    'source_type',
    'status',
    'content_hash',
    'size_bytes',
    'mime_type',
    'coverage',
    'created_at',
  ],
  schedules: [
    'id',
    'workspace_root',
    'title',
    'prompt',
    'kind',
    'every_minutes',
    'at_hour',
    'at_minute',
    'enabled',
    'created_at',
    'last_run_at',
    'conversation_id',
    'new_conversation',
  ],
}
