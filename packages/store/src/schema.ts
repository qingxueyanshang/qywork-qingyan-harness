/**
 * SQLite 账本表结构。
 *
 * 移植自 Python 版 harness/models.py，但改掉了它踩过的坑：
 *
 * - **主键用带前缀的字符串 ID，不用自增整数。** Python 版五张表都有删除路径，
 *   普通 INTEGER PRIMARY KEY 会复用被删的最高 id，导致 retry_of_run_id /
 *   step.artifact_id 这类跨引用悄悄指到别人身上；那边靠给每张表挂
 *   sqlite_autoincrement 兜底。字符串 ID 从结构上消灭这个问题。
 * - **FK 引用列一律建索引。** PRAGMA foreign_keys=ON 下，父行每删一条 SQLite 都要
 *   在子表里找引用者，无索引即退化成全表扫描——Python 版实测删一个会话被拖到十几秒
 *   并撞 busy_timeout 报 500。
 * - **cached_tokens 可空。** null=provider 未回报，与真实 0 命中是两回事。
 */

export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
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
-- 但登记必须保留——模型要能看到「这里本来有个东西，没拿到」，
-- 而不是什么都看不到然后以为工具没跑过。
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
-- 这条约束会把它挡住，而不是让账目悄悄翻倍。
CREATE UNIQUE INDEX uq_usage_run ON usage_ledger(run_id) WHERE run_id IS NOT NULL;
`,
  },
  {
    id: 4,
    name: 'usage_kind_classifier',
    /**
     * 账本的 kind 加上 `classifier`（权限裁决的那次小模型调用）。
     *
     * ## 这条迁移是被一次静默失败逼出来的
     *
     * 加 `classifier` 时只改了 TS 类型，没想到 schema 上有 CHECK 约束。
     * 插入直接违反约束抛错——而 `recordUsage` 的 catch 是为「同一个 run 重复记账」
     * 写的，它把**所有**错误一起吞了。于是现象是：分类器正常工作、命令正常放行、
     * 账本里一行都没有，任何地方都不报错。
     *
     * 教训不在「忘了加迁移」，在**一个为特定错误写的 catch 覆盖了全部错误**。
     * `recordUsage` 已经改成只吞唯一约束冲突，其余一律打到 stderr。
     *
     * ## 为什么要重建表而不是 ALTER
     *
     * SQLite 改不了 CHECK 约束，只能建新表搬数据。既然要搬，索引也一并重建。
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
     * 删掉三处从来没被写入过的东西。
     *
     * - `artifacts` 表与 `steps.artifact_id`：产物是从 Python 版带过来的概念，
     *   qywork 里没有任何生产者，界面也没有对应渲染。
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
     * 之前只有 `config.effort` 一个全局值。它确实被主循环消费（不是死链路），
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
     * 2. 把 ¥ 数字塞进 `cost_usd`：字段名直接说谎，差七倍且界面上看不出来。
     * 3. 记下币种，各币种分开合计。**选这条。**
     *
     * 列名一并从 `cost_usd` 改成 `cost`。这不违反「已落盘的键名不改」——
     * 那条防的是读不回旧数据，而 RENAME COLUMN 把数据原样带过去了；
     * 留一个名字说谎的列才是真的会误导后来的人。
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
     * ## 为什么必须落盘，而不是只在内存里
     *
     * 它要跨重启活着：关掉一个吵闹的 MCP 之后重开应用又冒出来，用户会以为
     * 开关没生效。而**它只属于这一条会话**——写进全局配置就不是「这一轮」了，
     * 那是另一个语义，别处无处安放。这是本轮唯一新增的一份状态账。
     *
     * ## 只存「关掉的」，不存「开着的」
     *
     * 默认全开，所以没有行 = 全开。反过来存的话，每装一个新技能都要给所有
     * 历史会话补一行，漏补的表现是「新装的技能在老会话里不生效」——
     * 而那是一条谁都不会去查的路径。
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
]

/**
 * 当前 schema 版本 = 最后一条迁移的 id。
 *
 * **派生而不是手写。** 手写的那个值当时是对的，但它跟迁移表之间没有任何约束——
 * 加一条迁移忘了改它，它就开始说谎，而且不会有人发现：真正决定迁移的是
 * `_migrations` 表，这个常量没有消费者会去校验。派生之后它不可能再不一致。
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id
