/**
 * SQLite 账本表结构。
 *
 * 三条结构约束：
 *
 * - **主键用带前缀的字符串 ID，不用自增整数。** 这几张表都有删除路径，普通
 *   INTEGER PRIMARY KEY 会复用被删的最高 id，导致 retry_of_run_id /
 *   step.artifact_id 这类跨引用静默指向另一行。字符串 ID 从结构上消灭这个问题。
 * - **FK 引用列一律建索引。** PRAGMA foreign_keys=ON 下，父行每删一条 SQLite 都要
 *   在子表里找引用者，无索引即退化成全表扫描——删一个长会话会被拖到十几秒并撞
 *   busy_timeout。
 * - **cached_tokens 可空。** null=provider 未回报，与真实 0 命中是两回事。
 */

import type { Database } from 'bun:sqlite'
import type {
  ConversationId,
  Currency,
  MessageId,
  ProviderKind,
  ProviderRequestId,
  ProviderRequestStatus,
  ResourceId,
  ResourceStatus,
  RunId,
  RunStatus,
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
 * 迁移 26 之前寄生在工具行上的思考正文，改成当前独立 step。
 *
 * 受影响 run 的 seq 全部映射成 `old * 2 + 1`，新思考落在 `old * 2`。这样顺序与
 * batch 的终止戳都可机械换算，不需要猜哪里有“空位”。会话压缩边界只含两处 step
 * 戳，一并重写；迁移完成后运行时便不再读取 `tool_action.content`。
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

/** 把能从旧账本本身证明的字段改成当前唯一结构；未知事实绝不按配置猜。 */
function canonicalizeRuntimeRecords(db: Database): void {
  migrateEmbeddedThinking(db)

  // 旧投影把缺 batch id 的每条工具行各自当一批；把这个既有语义固化进账本。
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

  // 旧会话只有在逐请求账能唯一证明接口时才补。零证据或多条路线都保持空串，
  // 新运行路径会明确要求重新选择，不能拿当前默认接口伪造历史归属。
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

/** 旧服务给临时子 agent 的显示名，迁移 41 沿用它，不拿任务正文当名字。 */
const TEMP_LABEL = '临时子 agent'

/**
 * 旧的派活目标字段 `agent` 换成按 kind 记：`ad-hoc` 与空值是临时子 agent，
 * `cli:<id>` 是外部 CLI，其余是角色 id。临时子 agent 的名字用给定的回落名。
 */
function kindFieldsOf(agent: unknown, fallbackName: string): Record<string, string> {
  if (typeof agent !== 'string' || agent === '' || agent === 'ad-hoc') {
    return { kind: 'temp', name: fallbackName }
  }
  if (agent.startsWith('cli:')) return { kind: 'cli', cli: agent.slice('cli:'.length) }
  return { kind: 'role', role: agent }
}

/**
 * 迁移 41 对一条派活 step 的改写。返回 false = 这一行已经是新形状，不用写回。
 *
 * 回执里的逐节点终态是每一格状态的真值：续接调用没有逐格状态的从回执折出来，
 * 首派那条由迁移 40 按 step 终态估出来的也以回执为准。
 */
function rewriteDelegationPayload(payload: Record<string, unknown>, toolName: string): boolean {
  let changed = false
  const args = payload.args as Record<string, unknown> | undefined
  const nodes = (payload.nodes ?? {}) as Record<string, Record<string, unknown>>
  if (toolName === 'subagent' && args && 'agent' in args) {
    const { agent, ...rest } = args
    const target = kindFieldsOf(agent, TEMP_LABEL)
    payload.args = { ...target, ...rest }
    // 旧服务给临时子会话起的标题是任务正文，迁移 40 把它抄成了格子的名字，与卡上的任务行重复。
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
  -- NULL 表示 provider 未回报缓存用量；不要 COALESCE 成 0。
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
  -- 进入执行器前立即写入。崩溃恢复必须把「有时间戳的 running 行」当作「可能已执行」，
  -- 而不是「没执行过，可以安全重放」——副作用工具重放一次的代价远高于漏掉一次。
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
-- 正文**不在这里**——它在另一个数据库（qywork_content.sqlite3）里，按 content_hash 寻址。
-- 这张表只存定位事实：谁产生的、多大、什么类型、哈希是多少。
--
-- 跨库没有外键，所以「blob 存在」这件事由写入顺序保证：
-- 先在正文库定稿 blob，再往这里插行。反过来做会让这张表指向不存在的正文，
-- 而那种损坏要到模型来读的时候才发现。
--
-- content_hash 可空：status='failed' 的资源（抓取中途断了）没有定稿的正文，
-- 但登记必须保留——模型要能看到「这里本来有一条结果，没拿到」，
-- 而不是什么都看不到，读起来像工具没跑过。
CREATE TABLE intermediate_resources (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id       TEXT,
  tool_name     TEXT NOT NULL,
  -- 产生它的语义来源：web_fetch / shell / download …，决定预览方式。
  source_type   TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('complete','partial','failed')),
  content_hash  TEXT,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  mime_type     TEXT,
  -- 覆盖事实：截断了多少、原始有多少行、查询是什么。模型据此判断「我看到的是不是全部」。
  coverage      TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_ir_run ON intermediate_resources(run_id, created_at);
-- GC 要按哈希反查引用，没有索引就是全表扫。
CREATE INDEX idx_ir_hash ON intermediate_resources(content_hash);
`,
  },
  {
    id: 3,
    name: 'usage_ledger',
    sql: /* sql */ `
-- 独立用量账本。
--
-- 为什么不直接查 runs：**账目必须比业务数据活得久**。删一个会话、清一批 run
-- 都是正常操作，而「这个月花了多少」不该因此少一笔。所以这张表：
--
-- * **没有外键**，也就没有 ON DELETE CASCADE。run_id / conversation_id 只是线索，
--   指向的行没了不影响账目成立。
-- * **一次 run 只写一行**，在 run 收尾时写。中途的 usage 是累计值，
--   每次都记会把同一笔钱记很多遍。
-- * **kind 区分来源**。压缩用的那次摘要调用也花钱，而它不属于任何一个 run 的
--   usage——之前那笔钱是完全看不见的。
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
-- 同一个 run 只能有一行：收尾逻辑万一被走两遍（重连补发、异常路径），
-- 这条约束会把它挡住，而不是让账目静默翻倍。
CREATE UNIQUE INDEX uq_usage_run ON usage_ledger(run_id) WHERE run_id IS NOT NULL;
`,
  },
  {
    id: 4,
    name: 'usage_kind_classifier',
    /**
     * 账本的 kind 加上 `classifier`（权限裁决的那次小模型调用）。
     *
     * **加 kind 必须同时加迁移**：`kind` 上有 CHECK 约束，只改 TS 类型的话插入会
     * 违反约束抛错，而 `recordUsage` 只吞唯一约束冲突、其余打到 stderr——
     * 那个 catch 一旦被放宽成吞全部错误，现象就是「分类器正常、命令放行、
     * 账本一行都没有、哪里都不报错」。
     *
     * 重建表而不是 ALTER：SQLite 改不了 CHECK 约束，只能建新表搬数据。
     * 既然要搬，索引也一并重建。
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
     * 删掉三处从来没被写入过的列。
     *
     * - `artifacts` 表与 `steps.artifact_id`：没有任何生产者，界面也没有对应渲染。
     * - `runs.execution_state`：**这个最该删**。它从未被写入，而崩溃恢复如果
     *   拿它做判据，会把所有 run 都判成「安全可重放」——正好是最危险的方向。
     *   真正的判据一直是 steps 表里那条带 `execution_started_at` 的 running 行。
     *
     * 保留空表/空列不叫兼容，叫留一个下次有人误用的机会。
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
     * 思考强度下沉到会话，形状与 `model` 完全一致。
     *
     * 迁移前只有 `config.effort` 一个全局值。它确实被主循环消费（不是死链路），
     * 但和模型不同层：模型是会话级的，切一个会话去用 Haiku 不会影响另一个会话，
     * 而思考强度切一次是全局的。两个本该并排的旋钮分处两层，改一个还会改到别处。
     *
     * `NULL` = 跟随配置里的默认值，不是「关掉思考」——所以这里不给 DEFAULT，
     * 给了就再也分不出「用户显式选了这一档」和「还没选过」。
     */
    sql: `ALTER TABLE conversations ADD COLUMN effort TEXT;`,
  },
  {
    id: 7,
    name: 'multi_currency_cost',
    /**
     * 账本与 run 改成多币种，**不做汇率换算**。
     *
     * 起因是内置目录扩到九家厂商：阿里 / 月之暗面 / 智谱三家官网按人民币标价。
     * 三条路摆在面前——
     *
     * 1. 换算成美元：要一个汇率。汇率天天变，落盘的那个数字第二天就不对了，
     *    而它看起来仍然是个确切的金额。
     * 2. 把 ¥ 数字塞进 `cost_usd`：字段名与实际币种不符，差七倍且界面上看不出来。
     * 3. 记下币种，各币种分开合计。**选这条。**
     *
     * 列名一并从 `cost_usd` 改成 `cost`。这不违反「已落盘的键名不改」——
     * 那条防的是读不回旧数据，而 RENAME COLUMN 把数据原样带过去了；
     * 留一个名称与内容不符的列才会误导下一个读表的人。
     *
     * 存量行一律记 `'USD'`：迁移之前目录里只有 Anthropic 与 DeepSeek 两家，
     * 都是美元标价，所以这个默认值是事实，不是猜测。
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
     * 会话级的「这一轮不用某个技能 / MCP / 插件 / 记忆」。
     *
     * **为什么必须落盘，而不是只在内存里。** 它要跨重启存活：关掉某个 MCP 之后重开应用它又出现，等
     * 同于开关没生效。而**它只属于这一条会话**——写进全局配置就不是「这一轮」了，那是另一个语义，
     * 别处无处安放。
     *
     * **只存「关掉的」，不存「开着的」。** 默认全开，所以没有行 = 全开。反过来存的话，每装一个新技
     * 能都要给所有历史会话补一行，漏补的表现是「新装的技能在老会话里不生效」——而那是一条谁都不
     * 会去查的路径。
     *
     * `key` 形如 `skill:release` / `mcp:github` / `plugin:foo` / `memory:style`，
     * 前缀就是类目。不拆成两列：这张表只被「按会话取全集」这一种方式读，
     * 拆开只会多一个 join 条件。
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
     * 「从列表里移除项目」不再等于「删掉这个项目的全部数据」。
     *
     * **行必须留下。** `conversations.workspace_id` 是 `ON DELETE CASCADE`，而 `workspaceOf` 要
     * join 这一行才能答出「这条会话跑在哪个根」。删了行，会话就永远打不开。「不留中间态」的办法不
     * 止删行一种——**行留着，但不出现在列表里**。
     *
     * 移除只改「列表里显不显示」，不改「能不能读回来」：`listWorkspaces` 过滤
     * `removed_at IS NULL`，而 `workspaceOf` / `getWorkspace` **一律不过滤**。
     * 会话、消息、run、step 一条不动，重新添加同一个路径就整个回来
     * （`root_path` 是 UNIQUE，upsert 命中同一行并清掉这个标记）。
     *
     * 这样「移除」和别处一致：`usage_ledger` 早就是这个立场——它刻意不设外键，
     * 「这个月花了多少」不该因为项目从列表里消失而少一笔。
     *
     * **不提供「彻底删除」。** 没有这个需求就不做（B5）。真要清数据的人现在有备份、有 SQL，
     * 而多一个入口就要多一套「确认几次才算数」的交互和一条能永久毁数据的路径。
     *
     * `NULL` = 在列表里。用时间戳而不是布尔：移除时间迟早要显示，
     * 而布尔到时候只能再加一列。
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
     * `last_opened_at` 倒序答的是「最近打开过哪个」，不是「哪个常用」。项目攒多之后
     * 常用的那个会被一次临时切换挤下去——而用户对「常用」的预期是稳定位置。
     *
     * 存时间戳不存布尔：多个置顶项目之间也要有确定顺序（后置顶的在前），
     * 布尔到时候只能再加一列。`NULL` = 没置顶。
     */
    sql: `
ALTER TABLE workspaces ADD COLUMN pinned_at INTEGER;
`,
  },
  {
    id: 11,
    name: 'conversation_archived_at',
    /**
     * 归档会话：**从会话列表里去掉，此后新建的照常显示**。
     *
     * **和 `runtime/src/archive.ts` 同名不同物。** 那个是「会话**导出**」——产出 markdown / json，
     * 只读，产出物是死的，不承诺能导回来。这里的归档是「不在列表里显示」，数据一条不动。两个都叫
     * archive 会持续制造误读，所以这里点名说清；导出那套保持原名。
     *
     * **数据不删，但界面上够不着。** `listConversations` 过滤它，`getConversation` **不过滤**——按
     * id 仍然读得回来。这与迁移 9「移除项目」的立场一致：状态标记只改「显不显示」。区别是移除项目
     * 能靠「重新添加同一路径」回来，而归档没有对应的翻回入口 ——**这是用户点名要的行为**（原话：不
     * 是列表收敛，是不在会话里面显示了，新开对话还是会显示新的），不是疏漏。将来若要翻回，加的是一
     * 个视图，不是改这条语义。
     */
    sql: `
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
`,
  },
  {
    id: 12,
    name: 'drop_conversation_effort',
    /**
     * 思考强度**收回成一个变量**，会话上这一列删掉。
     *
     * 迁移 6 把它下沉到会话，理由是「模型是会话级的，思考强度该跟模型同层」。
     * 那个理由站不住：它造出了第二条线——输入区的 chip 写会话、设置页的下拉写
     * `config.effort`，两处各写各的。表现是**在 chip 上选的档换个会话就没了**，
     * 而设置页里那个值看着还在，两边谁也不知道对方改过。
     *
     * 档位不是会话属性：它是配置里与 model 并排的一个字段，每轮请求现取。
     */
    sql: `ALTER TABLE conversations DROP COLUMN effort;`,
  },
  {
    id: 13,
    name: 'provider_request_ledger',
    /**
     * 逐请求账**接上**，`runs` 上那三列同时删掉。
     *
     * `provider_requests` 建于迁移 1 但一直零读写，面板只能读 `runs.context_tokens`，
     * 而那三列每个 step 覆盖一次，一个 run 只剩最后一次请求的读数——
     * 「这一轮上下文怎么长起来的」在账本里不存在。
     *
     * 两列一删一加：
     *
     * - 加 `omitted_categories`：面板要回答「什么被拿掉了」。压缩把历史换成摘要、
     *   把工具结果换成定位符之后，原文仍在账本里，只是没进这次请求——
     *   这个数就是那部分。只有 `sent_categories` 是半张账。
     * - 删 `runs` 的 `context_tokens/limit/percent`：真源改成本表之后它们就是
     *   第二本账，而两本账迟早漂。留空列不叫兼容，叫留一个下次有人误用的机会
     *   （同迁移 5 的立场）。
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
     * run 记下**是谁在跑它**，启动回收据此跳过仍在运行的那些。
     *
     * **为什么必须有这两列。** `recoverStaleRuns` **不能无差别扫全库的 running/queued**：一台机器上
     * 可以有好几个进程写同一个账本（两个工作区各一个 sidecar、开发态的热重载、终端里的 `qy exec
     * `），无差别扫的话**后起的那个进程一启动，就把前一个正在跑的那一轮判成中断**，而那个进程仍在
     * 运行、仍在写入。实测形状：一条跑了 40 步的 run 在第 27 次请求发出后 257 毫秒被判为中断，写
     * 入者是另一个刚起来的进程。
     *
     * 判「仍在运行」需要两个信号，缺一不可：
     *
     * - `owner_pid`：进程没了就该回收，这条保证不能弱化。
     *   只有它不行：Windows 会复用 pid，一个不相干的新进程占了同一个号，
     *   已结束的那条 run 就永远判成运行中，会话被永久锁死。
     * - `heartbeat_at`：运行中的进程每隔十秒把它推一次。pid 被复用（或进程仍在
     *   但那一轮已废弃）时，心跳停了就是停了，超时即回收。
     *
     * 反过来只有心跳也不行：进程崩溃后立刻重启，心跳才过去两秒，按超时判仍在运行,
     * 那条 run 就躲过了回收——而它已经没有任何人在跑，会话就此锁死。
     * **两个信号各自堵的是对方的漏，所以两列都要。**
     *
     * 可空：迁移之前的历史行没有归属，按「无归属」处理，照旧回收。
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
     * 「写之前必须先读过」的那条记录，从进程内存挪进账本，按**会话**归属。
     *
     * **不能挂在 `ToolContext.state` 上。** 那张 map 是 **run 内的便签**（批级预算、计划快照也在里
     * 面，两者都必须每轮清零），挂上去「读过 x.ts」就每轮清零一次：模型上一轮读过、这一轮直接改，
     * 必然先失败一次「本轮未读取过」，补一次 read 再改才成。
     *
     * 服务端**每条消息新建一个 Session**（`run-control.ts` 的注释写明了），
     * 所以进程里没有「会话级」这个生命周期可挂。而账本里有：会话就是一行，
     * 删会话时这些行随 `ON DELETE CASCADE` 一起走，不需要另外发明淘汰策略。
     * 同一条推理让上下文面板改成从账本现算（`runtime/context-panel.ts`）。
     *
     * **这条守卫管的是新鲜度，不是记性。** 存的是**整份文件内容的哈希**，部分读（offset/limit）也记
     * 全量哈希——所以它从来不承诺「模型看过全文」，它只回答「要写的这份，是不是读到的那份」。
     * 新鲜度的判据是磁盘现值，与 run 边界无关，因此挪长生命周期不放宽任何约束：文件被别人改过照样
     * 拦得住，拦它的是哈希比对。
     *
     * 主键 (conversation_id, path)：同一文件重复读就覆盖，只留最近那次。
     * `path` 存**解析后的绝对路径**，与内存那版同一个键——模型写的相对路径
     * 形态不唯一（`js/a.js` / `./js/a.js`），拿它当键会漏。
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
     * 动作轴从九个值收敛到六个，**已经落盘的行跟着转**。
     *
     * 不转的后果实测见过：动作枚举在代码里改完了，账本里的老 step 还带着
     * `execute` / `search` / `plan`，回放时前端查不到动词，卡片标题掉回原始工具名，
     * 界面上直接出现 `update_plan` 这种机制字段。**改了协议不转数据，就叫没改完。**
     *
     * 映射逐条有据：
     * `execute` / `delegate` → `run`（跑命令、跑编排节点都是运行）、
     * `search` → `query`（搜索是查询的一种）、`fetch` → `read`（取一份已知的资源）、
     * `plan` → `write`（那个工具是提交待办清单，首建是创建）。
     *
     * `plan` 那条同时把对象名从「计划」改成「待办」：它产出的一直是待办清单，
     * 「计划／方案」是另一件事（一篇讲清怎么做的文档），名字得还回去。
     *
     * **这是一次性转换，不是兼容层**：转完之后代码里没有任何分支还认识老值。
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
     * `update_plan` 改名 `write_todos`，**落库的 `tool_name` 跟着转**。
     *
     * 不转的后果是实测确认的：待办面板整个空了。面板不由事件驱动——
     * 重拉会话时从账本投影（`web` 的 `todosFromSteps`：找最后一条成功的
     * 待办提交，整表就在它的 `args` 里），而投影按新名字找，老行还叫旧名字，
     * 因此一条都匹配不上。用户看到的是「之前的数据没了」。
     *
     * **为什么改而不是在投影里兼容两个名字**：那就是一条兼容分支，而它会一直留着
     * （B3）。同一个工具换了个名字，账本里记的「这一步调了哪个工具」应该跟着换，
     * 否则模型回放历史时还会看到一个当前工具表里不存在的名字。
     *
     * 这不违反「已落盘的键名是历史事实」——那条说的是**结构键名**（列名、
     * schema 版本键、迁移标记），不是记录内容里的一个值。
     */
    sql: `
UPDATE steps SET tool_name = 'write_todos' WHERE tool_name = 'update_plan';
`,
  },
  {
    id: 18,
    name: 'todos_message_wording_again',
    /**
     * 再扫一遍待办回执里的「计划已更新」：迁移 16 只转到它执行那一刻，
     * 而回执文案比动作轴晚一批改，中间跑过的轮次落成了「新动作 + 旧文案」
     * （卡片标题读作「创建待办」，展开体里写着「计划已更新（1/3）」）。
     *
     * 幂等：转完之后不存在以「计划已更新」开头的回执，重复执行命中零行。
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
     * MCP 与插件的工具落到动作轴上的新值 `call`，**已经落盘的行跟着转**。
     *
     * 不转的表现不是报错：回放历史会话时，同一个 MCP 工具的老行写着「运行」
     * （destructive 的写着「删除」、resource 那两个写着「读取」），
     * 而它今天调一次记的是「调用」——同一件事在同一条时间线上有两种说法。
     *
     * **判据是工具名里的 `__`。** 双下划线只由两条产名路径造出来：
     * `mcp__<server>__<tool>` 与插件的 `<id>__<tool>`；内置工具名一个都不含它
     * （`read_file` / `write_todos` / `run_command` 这些是单下划线）。
     * 所以「含 `__`」等价于「这是一个外置工具的调用」，不需要另外维护一份内置名单
     * ——那会是第二本账，加一个内置工具就得记得回来改它。
     *
     * **不按旧值挑，一律改写。** 存量行里外置工具记过 run（普通 MCP 工具）、
     * delete（destructive hint）、read（resource 那两个）、以及插件清单自己声明的
     * 任意一个值；今天它们全归 call，所以转换的目标只由「谁产生的」决定。
     *
     * 幂等：转完之后再跑一次命中同样的行，写进去的还是 `call`。
     * 没有 `action` 的行被 WHERE 挡在外面——`json_set` 会给它凭空长出一个键。
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
     * 外置工具的对象名收成「MCP」/「插件」两个类名，**已经落盘的行跟着转**。
     *
     * 工具卡是**动词 + 对象 + 目标**三层。存量行里外置工具把具体的
     * `mcp:<server>/<tool>`（插件是清单自己声明的那个词）填进了对象名，
     * 因此标题和目标写着一模一样的串，目标那一层白占一格。对象名应当填类名，
     * 具体那个串归 `action.target`。
     *
     * 不转的表现不是报错：回放历史时老卡片写着「调用mcp:github/search」，
     * 新卡片写着「调用MCP · mcp:github/search」——同一件事两种说法。
     *
     * 判据与迁移 19 同一条：**工具名里的 `__`**，只由 `mcp__<server>__<tool>` 与
     * 插件的 `<id>__<tool>` 两条产名路径造出来，内置工具名一个都不含。
     * 两者的区分是**是否以 `mcp__` 开头**。
     *
     * **`action.target` 不动**——它本来就该是具体的那个，这次改的是对象名那一层。
     *
     * 幂等：转完之后再跑一次写进去的还是同样两个类名。
     * 没有 `action` 的行被 WHERE 挡在外面——`json_set` 会给它凭空长出一个键。
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
     * `memory` 一个名字四个动作，拆成 `read_memory` / `write_memory` /
     * `delete_memory` 三个，**落库的老行按行内的 `args.action` 分流**。
     *
     * 不转的表现不是报错：回放历史时模型看到一个当前工具表里不存在的名字
     * （`transcript.ts` 把账本里的 `tool_name` 与 `args` 原样重放成一次工具调用）。
     *
     * `list` 归 `read_memory`——语义最接近，而且那个动作已经不是工具了：
     * 全部 key 每轮都在尾区列着。缺 `action` 或值非法的一并归它：那些行本来就
     * 分不出动作，落到读上最保守。
     *
     * **`args.action` 一并清掉。** 名字改了之后这一行已经不是那次调用的
     * 逐字记录，留着反而给出一个今天不合法的调用形状——三个新 schema 都是
     * `additionalProperties: false`，模型照着历史仿一个 `action` 出来就是废一轮。
     * 一条 UPDATE 里两个 SET：SQL 的赋值右侧读的是改动前的行，所以名字仍由老
     * `action` 算出。
     *
     * 幂等：转完之后没有 `tool_name = 'memory'` 的行，重复执行命中零行。
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
     * 目标与自动续起的账本。
     *
     * **每次变更一行，带完整快照。** 不是「一行目标就地 UPDATE」：目标要回答
     * 「它为什么停在这」，而就地更新只留得下最后那一次状态，中间的暂停、改写、
     * 轮次推进全部丢失——而那正是用户回头要看的部分。
     *
     * **`conversation_extras` 装不下它**：那是「会话关掉了哪几项」的两列成员表，
     * 没有版本、没有顺序、没有快照。
     *
     * **主键就是 `(goal_id, revision)`，不另发一个事件 id。** 复合主键把
     * 「同一个 revision 不许写两次」变成数据库层的约束，两个写入方撞车时
     * 后到的那个直接抛，而不是静默追加出第二条同版本的记录。
     *
     * **「这条会话最新的目标」靠 `ORDER BY goal_id DESC` 取**：`gl_` 前缀后面
     * 是定宽单调 id（`core/domain/ids.ts`），字典序严格等于创建顺序。
     * 所以这里不需要自增列，也就不会有自增列被删后复用的老问题。
     *
     * 索引带 `conversation_id`：FK 的级联删除要靠它，无索引即全表扫描。
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
     * 「这条会话已经把哪几个外部工具装进工具表了」。
     *
     * **为什么必须落盘。** 服务端**每条消息新建一个 Session**，进程内的「已加载」集合活不过这条消
     * 息。不落盘的话模型每一轮都得重新 `load_tool` 一遍——而它在 transcript 里看得见上一轮装过、
     * 工具表里却没有，会反复去试。那种每轮固定一次的往返开销，反而输给「全部常驻」，按需加载就白做
     * 了。
     *
     * **为什么不写进 `conversation_extras`。** 那张表是**「这一轮关掉了哪几项」**的成员表（没有行 =
     * 全开）。这里记的是「已经打开了哪几项」，默认相反、写入方不同、清理时机也不同。共表就是两套账
     * 共用一个键空间，迟早有人按前缀过滤时把对方的行一起算进去。
     *
     * 主键 (conversation_id, tool_name)：同一个工具装两次是同一件事，
     * `INSERT OR IGNORE` 直接落到这条约束上。它同时充当 FK 的索引
     * （级联删除按 conversation_id 前缀查），所以不另建。
     *
     * 存的是**注册名**（`mcp__<server>__<tool>` / `<插件id>__<tool>`）——
     * 它就是模型调用时用的那个名字，也是待加载池里的键。
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
     * 会话记住「发给哪个接口」。
     *
     * `model` 一直只是 ModelRef 的一半。另一半靠 `resolveModel` 现猜：
     * 找哪个接口声明了这个模型，多个则当前接口优先。两家中转站都转
     * `claude-opus-5` 时这个猜必错一半，而错的表现是请求发去了另一个端点、
     * 用了另一把 key、按另一份价目表记账——三样都不报错。
     *
     * 空串 = 本次迁移之前建的会话，没有记过接口。迁移 37 会按逐请求账的唯一证据
     * 补齐；无法证明的保持空串并要求用户重新选择，不再按模型 id 猜。
     */
    sql: `ALTER TABLE conversations ADD COLUMN provider TEXT NOT NULL DEFAULT '';`,
  },
  {
    id: 25,
    name: 'provider_finish_reason',
    /**
     * 账本记下 provider 的**原话**，并删掉一个永远说不出真话的标志位。
     *
     * 加 `finish_reason`：`runs.stop_reason` 存的是本仓自己的词表
     * （`completed` / `output_truncated` / …），是归一化之后的结论。
     * 因此「模型说完了」（`stop`）与「模型要调工具但一条都没解析出来」
     * （`tool_calls` + 零调用）在账本上长得一模一样，事后分不出是哪一种。
     * 空串 = 本次迁移之前的行，或流断在拿到 finish_reason 之前。
     *
     * 删 `measurement_exact`：三条协议都不在热路径上实测 token，写入端是常量
     * `false`，读出来之后没有任何消费者。一个永远为假的能力位比没有更坏——
     * 下一个人会把它当成生效的能力位。真值一直由 `provider_*_tokens` 那几列给。
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
     * 思考有自己的行，不再寄生在工具行的 `content` 上。
     *
     * 寄生的推论就是它的失效形状：这一轮没有工具调用 → 没有 `tool_action` 行 →
     * 思考无处可放 → 直接丢弃。纯文本轮的思考因此从来没有落过盘。
     *
     * **重建表而不是 ALTER**：SQLite 改不了 CHECK 约束，只能建新表搬数据
     * （同迁移 3 的做法）。既然要搬，索引一并重建。
     *
     * 一并把 `artifact` 与 `progress` 从 CHECK 里去掉：`StepKind` 里没有它们，
     * 没有任何生产者能写出这两个值，留着只是给下一个人一个误用的机会（同迁移 5）。
     *
     * 这一版先保留 `tool_action.content`；迁移 37 会在可同时改写 compaction step 戳时
     * 把它们转成独立 thinking step，运行时不再保留第二种读取形状。
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
     * 工具结果里的图像字节改成数组：`data.imageData` + `data.mime`
     * → `data.images: [{data, mime}]`。
     *
     * 不转的后果是实测撞出来的，而且不报错：摘字节的 `envelopeResult` 与产图像块的
     * `imagesOf`（都在 `agent/loop.ts`）现在都只认 `images`，旧行两边都对不上，
     * 因此整串 base64 原样进信封当**文本**发出去。同一份会话实测 12 条旧行
     * 2.79 MB base64：本地按 4 字符/token 记 732k，provider 侧约 1.9M，
     * 一次请求直接被容量拒绝；压缩收掉大半之后仍有两张留在窗口里，
     * 占了 1M 窗口的 42%（428k），而它们走图像块的成本实测是每张约 1k。
     *
     * **只改键名，不重编码。** 这些图长边 1600，只比 `MAX_EDGE` 大 2%，
     * 而 `tools/image.ts` 顶上那条实测说明重编码 PNG 会大 2.4 倍；
     * 作为图像块发出去的成本与像素数有关、与字节数无关，重编码一分钱不省。
     *
     * `mime` 一并搬进数组元素：旧形状里它就是这张图的 mime，留在 `data` 上会让
     * `envelopeResult` 把它当成「除图像之外还有别的结果」而在信封里留一个
     * `{"mime":"image/png"}`，与新行不同形——同一次调用在两轮里长得不一样，
     * 前缀缓存从那里断掉。
     *
     * 幂等：转完 `$.outcome.data.imageData` 不存在，重复执行命中零行。
     * WHERE 认的是 JSON 路径不是文本，所以正文里含 `imageData` 这个标识符的
     * `write_file` / `grep` 记录不会被误伤（实测库里有 10 条这样的行）。
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
     * 一次工具调用跑了多久，落库。
     *
     * 这个数 `loop.ts` 早就量出来了（`Date.now()` 差，随 `tool.finished` 发出去），
     * 但只活在连接期：前端把它写进内存里那条 item，刷新就没了。表现是派活卡上
     * 那一格的耗时刷新之后消失，而编排那张图不受影响——它的耗时是编排器另外量的，
     * 旧记录落在 `outcome.data.nodes[]`，新 workflow 转移落在 `outcome.data.receipts[]`。
     *
     * **落在列上，不落进 payload。** 耗时是这一步的属性，不是工具结果的一部分；
     * 塞进 `outcome.data` 的话它会跟着结果进模型上下文，而那是给模型看的载荷。
     *
     * 与 `execution_started_at` 分工：那个是「进执行器之前」的时间戳，为崩溃恢复
     * 判定歧义边界而写；这个是执行完的时长。两者都在，但**不要拿它们相减**——
     * 前者在提交事务时写，与执行器实际起跑差着一次落盘。
     *
     * 存量行为 NULL：那些调用真实发生过，时长没有落库。界面按「没有就不显示」
     * 处理，不为它编一个数。
     */
    sql: `ALTER TABLE steps ADD COLUMN duration_ms INTEGER;`,
  },
  {
    id: 29,
    name: 'user_step_kind',
    /**
     * run 跑到一半时用户插进来的那句话，有自己的行。
     *
     * **它不能写进 `messages`。** 历史投影的骨架是「messages 按 id 升序，每条后面
     * 挂 `userMessageId` 指向它的那些 run 的全部 steps」（`runtime/transcript.ts`
     * 的 `buildHistory`），中途落进 `messages` 的行下一轮会被重排到整个 run 的全部
     * 步骤之后：注入发生在第 K 步，回放却把它排在全部步骤之后。
     * 落 steps 则位置由 seq 决定，活的 transcript 与回放逐条同位。
     *
     * **重建表而不是 ALTER**：SQLite 改不了 CHECK 约束（同迁移 3、26）。
     * 列清单以**此刻的表**为准，不是照抄迁移 26——它之后又加过 `duration_ms`
     * （迁移 28），照抄会把那一列搬丢。
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
     * 手动重试整条移除，这两列随之失去生产者与消费者。
     *
     * 产品上只保留两种重试：`AgentLoop` 轮内的原样重发（`run.retrying`，不落库），
     * 以及用户自己再发一次消息（那是一条普通的新 run）。「拿同一条消息重开一个 run
     * 并把旧 run 标为被接替」这个语义不再存在。
     *
     * **索引必须先删**：SQLite 拒绝 DROP 一个仍被索引引用的列，
     * 顺序反了整条迁移失败，库停在 29。
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
     * 被 provider 拒绝时把它的原话留在逐请求账本。
     *
     * `error_code` 是本仓归一化后的分类，只能回答「哪一类错」；限速响应里真正能
     * 定位账号、端点或上游策略的正文此前只活在异常对象里，进程一过就丢。它也
     * 不能挂到 `runs.error_message` 代替这里：一个 run 可以重发多次，每次请求各有
     * 自己的回执，真源必须仍是一请求一行。
     *
     * NULL = provider 没给正文、请求在连接层失败，或本次迁移之前的存量行。
     */
    sql: `ALTER TABLE provider_requests ADD COLUMN error_message TEXT;`,
  },
  {
    id: 32,
    name: 'run_context_snapshot',
    /**
     * 一次 run 开始时看到的非对话上下文快照。它跟 run 同行原子落库，重启、压缩
     * 与重放都从这里读，不再靠每次 provider 请求临时重算。
     *
     * NULL 只代表迁移前的历史 run；新 run 必须写 JSON 数组（空数组也写 `[]`）。
     */
    sql: `ALTER TABLE runs ADD COLUMN context_snapshot TEXT;`,
  },
  {
    id: 33,
    name: 'provider_request_transport_metrics',
    /**
     * 只记录传输旁路事实，不保存请求正文：接口/协议用于分路线，字节数与四个时刻
     * 用来区分请求放大、首包等待和生成阶段。NULL 表示迁移前旧行，没有就不编 0。
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
     * 补齐两段此前只活在进程内的事实：run 是被谁中断的，以及一次 provider 失败
     * 为什么重发/为什么没有重发。两列都存 JSON，因为它们是同一事实的结构化详情，
     * 不是供 SQL 聚合的第二套状态；终态仍由 runs / provider_requests 原列负责。
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
     * 按真实表结构补列，不改写已落盘的迁移标记。开发数据库可能已经用其他结构占用
     * 迁移编号 34，仅按编号跳过会让运行期查询引用不存在的列。
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
     * 两种旧生产器写进 runs 的错误事实直接在账本里收敛：
     *
     * - 连接计时器与 AgentLoop 曾各拼一次同一段静默时长；
     * - 已废除的固定步数终态不再代表任何当前运行机制。
     *
     * 这是一次数据修复，不在 UI 保留按字符串识别旧记录的并行展示分支。
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
     * 旧结构在这里一次性收口，读路径不再长期维护两套语义。
     *
     * 可证明的事实原地迁移；provider 归属若没有唯一账本证据则宁可保持未绑定，
     * 由用户重新选择，也不按当前配置枚举顺序猜错端点、key 与计价。
     */
    apply(db) {
      canonicalizeRuntimeRecords(db)
    },
  },
  {
    id: 38,
    name: 'conversation_parent',
    /**
     * 子会话属于哪条父会话。派活时就写死，此后账本汇总、级联删除、运行页三件事
     * 都从这一列推出来，不再从 step 的 JSON 里反查两种形状。
     *
     * `ON DELETE CASCADE`：删父会话时子会话跟着走，不留孤儿。账目不受影响——
     * `usage_ledger` 没有外键，那些行按设计比业务数据活得久。
     *
     * NULL = 顶层会话，或迁移之前建的子会话。
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
     * 子会话的 `source` 改记子 agent 的种类：`role` / `temp` / `cli`。之前一律写
     * `workflow`，角色与临时靠 `source_ref` 是不是 `ad-hoc` 区分。
     * 新列 `external_session` 存外部 CLI 的会话句柄，续接时交回给它。
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
     * 派活卡的节点事实收成 `$.nodes` 一份：之前派一件写 `$.childConversationId`、
     * 一张图写 `$.children`，两个键都只有子会话 id，没有状态。旧行按 step 的终态
     * 折出每一格的 phase，名字取子会话标题。
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
     * 派活参数与回执改按 kind 记之后，旧行还按旧形状写着：节点 `kind: 'agent'` 加
     * `agent`（角色 id / `ad-hoc` / `cli:<id>`），单派的 `agent` 为空表示临时，
     * 回执带 `agent` 与 `conversationId`，卡头对象名是「编排」。新解析器认不出旧行，
     * 那张图就折不起来。旧行按同一规则改写；续接调用的逐格状态从它的回执折出来。
     */
    apply(db) {
      const rows = db
        .query<{ id: string; tool_name: string; payload: string }, []>(
          `SELECT id, tool_name, payload FROM steps
           WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent') AND payload IS NOT NULL`,
        )
        .all()
      const update = db.query('UPDATE steps SET payload = ? WHERE id = ?')
      for (const row of rows) {
        const payload = JSON.parse(row.payload) as Record<string, unknown>
        if (rewriteDelegationPayload(payload, row.tool_name)) {
          update.run(JSON.stringify(payload), row.id)
        }
      }
    },
  },
  {
    id: 42,
    name: 'temp_subagent_names',
    /**
     * 迁移 41 的第一版给旧的临时子 agent 起的名字是子会话标题，而旧服务的标题就是任务正文，
     * 卡上任务行与格子名因此是同一句话。名字是任务正文开头的那些行改回「临时子 agent」。
     */
    apply(db) {
      const rows = db
        .query<{ id: string; payload: string }, []>(
          `SELECT id, payload FROM steps
           WHERE kind = 'tool_action' AND tool_name = 'subagent' AND payload IS NOT NULL`,
        )
        .all()
      const update = db.query('UPDATE steps SET payload = ? WHERE id = ?')
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
    },
  },
  {
    id: 43,
    name: 'subagent_names',
    /**
     * 子 agent 的名字只有一份：新建时给的 name（角色按 role id，外部 CLI 按 cli id），
     * 子会话标题与卡上那一格用的都是它。旧行的格子名是子会话标题（旧服务写的是任务正文），
     * 迁移 42 又把单派的临时子 agent 叫成了「临时子 agent」——都不是名字。
     * 格子名取派发参数里的目标名，没有名字的临时子 agent 取它的模型 id。
     *
     * 预编译语句用 prepare 并在末尾 finalize：留着没执行过的缓存语句会让库文件在 close 之后
     * 仍被占用，Windows 上删不掉。
     */
    apply(db) {
      const rows = db
        .query<{ id: string; tool_name: string; payload: string }, []>(
          `SELECT id, tool_name, payload FROM steps
           WHERE kind = 'tool_action' AND tool_name IN ('workflow', 'subagent') AND payload IS NOT NULL
           ORDER BY created_at ASC, seq ASC`,
        )
        .all()
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
]

/**
 * 当前 schema 版本 = 最后一条迁移的 id。
 *
 * **派生而不是手写。** 手写的值跟迁移表之间没有任何约束——加一条迁移忘了改它，
 * 它就与迁移表不一致，而且不会有人发现：真正决定迁移的是 `_migrations` 表，
 * 这个常量没有消费者会去校验它。派生之后它不可能再不一致。
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id

/*
 * ─────────────────────────────── 落盘行的形状 ───────────────────────────────
 *
 * **这是上面那张迁移表跑完之后的镜像，不是第二份定义。** 加列、改列名、改可空性时
 * 同时改这里；忘了改的话 `schema.test.ts` 里那条按 `PRAGMA table_info` 逐表比对的
 * 测试会红。没有那条测试的话，这几个接口就是一份没人校验的第二账本。
 *
 * **只列映射函数真的读的那几张表。** 写入走 INSERT 的具名参数，不需要行类型。
 *
 * 两处「声明即断言」，写在这里而不是散在每个映射函数里：
 *
 * - **主键列按非空给。** SQLite 的 `TEXT PRIMARY KEY` 不隐含 NOT NULL，`PRAGMA`
 *   因此报它可空；但主键写不进 NULL，取出来一定有值。
 * - **id 列按带牌子的 id 类型给。** 写入侧只可能塞 `newRunId()` 这类值进去，
 *   所以列里躺的确实是那个类型。在这里断言一次，好过在六个映射函数里断言三十次。
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
  /** CHECK 没管这一列，但写入侧只写这两个值中的一个。 */
  source: 'role' | 'temp' | 'cli' | null
  source_ref: string | null
  external_session: string | null
  /** 派活建出来的子会话指向它的父会话；顶层会话为 NULL。 */
  parent_conversation_id: ConversationId | null
  archived_at: number | null
  created_at: number
  updated_at: number
}

export interface MessageRow {
  id: MessageId
  conversation_id: ConversationId
  /** `CHECK (role IN ('user','assistant'))`。 */
  role: 'user' | 'assistant'
  content: string
  attachments: string | null
  created_at: number
}

export interface RunRow {
  id: RunId
  conversation_id: ConversationId
  workspace_id: WorkspaceId
  user_message_id: MessageId | null
  message_id_upper_bound: MessageId | null
  assistant_message_id: MessageId | null
  model: string
  client_request_id: string
  /** `CHECK (status IN ('queued','running','done','failed','interrupted'))`。 */
  status: RunStatus
  stop_reason: StopReason | null
  input_tokens: number
  output_tokens: number
  /** NULL = provider 未回报，与真实 0 命中是两回事。不要 COALESCE 成 0。 */
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
  /** 这次工具调用跑了多久。存量行与非工具行为 null。 */
  duration_ms: number | null
}

export interface ProviderRequestRow {
  id: ProviderRequestId
  run_id: RunId
  turn_index: number
  retry_index: number
  provider_name: string | null
  provider_kind: ProviderKind | null
  model: string
  /** `CHECK (status IN ('pending','in_flight','received','uncertain','rejected'))`。 */
  status: ProviderRequestStatus
  measured_input_tokens: number
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
  payload_hash: string
  request_bytes: number | null
  cache_route_fingerprint: string | null
  sent_at: number | null
  first_event_at: number | null
  first_content_at: number | null
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

/**
 * 表名 → 这张表的列名。**给比对测试用**——接口的键在运行时取不到，所以列名单独列一份，
 * 而这份与接口写在同一处、同一次修改里，漏改一处会被测试逮到。
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
  messages: ['id', 'conversation_id', 'role', 'content', 'attachments', 'created_at'],
  runs: [
    'id',
    'conversation_id',
    'workspace_id',
    'user_message_id',
    'message_id_upper_bound',
    'assistant_message_id',
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
    'heartbeat_at',
    'created_at',
    'finished_at',
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
    'provider_name',
    'provider_kind',
    'model',
    'status',
    'measured_input_tokens',
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
    'payload_hash',
    'request_bytes',
    'cache_route_fingerprint',
    'sent_at',
    'first_event_at',
    'first_content_at',
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
}
