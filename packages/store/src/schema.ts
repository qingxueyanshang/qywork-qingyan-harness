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
  {
    id: 9,
    name: 'workspace_removed_at',
    /**
     * 「从列表里移除项目」不再等于「删掉这个项目的全部数据」。
     *
     * ## 为什么原来是删
     *
     * `conversations.workspace_id` 是 `ON DELETE CASCADE`，而 `workspaceOf` 要 join
     * 这一行才能答出「这条会话跑在哪个根」。删了行，会话就永远打不开——所以当时的
     * 结论是「不能留中间态」，只能连着删。那个推理没错，错在结论：**不留中间态的
     * 办法不止「删行」一种，还可以「行留着，但不出现在列表里」。**
     *
     * ## 所以行必须留下
     *
     * 移除只改「列表里显不显示」，不改「能不能读回来」：`listWorkspaces` 过滤
     * `removed_at IS NULL`，而 `workspaceOf` / `getWorkspace` **一律不过滤**。
     * 会话、消息、run、step 一条不动，重新添加同一个路径就整个回来
     * （`root_path` 是 UNIQUE，upsert 命中同一行并清掉这个标记）。
     *
     * 这样「移除」和别处一致：`usage_ledger` 早就是这个立场——它刻意不设外键，
     * 「这个月花了多少」不该因为项目从列表里消失而少一笔。
     *
     * ## 不提供「彻底删除」
     *
     * 没有这个需求就不做（B5）。真要清数据的人现在有备份、有 SQL，
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
     * `last_opened_at` 倒序答的是「最近碰过哪个」，不是「我关心哪个」。项目攒多之后
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
     * ## 和 `runtime/src/archive.ts` 同名不同物
     *
     * 那个是「会话**导出**」——产出 markdown / json，只读，产出物是死的，
     * 不承诺能导回来。这里的归档是「不在列表里显示」，数据一条不动。
     * 两个都叫 archive 会持续制造误读，所以这里点名说清；导出那套保持原名。
     *
     * ## 数据不删，但界面上够不着
     *
     * `listConversations` 过滤它，`getConversation` **不过滤**——按 id 仍然读得回来。
     * 这与迁移 9「移除项目」的立场一致：状态标记只改「显不显示」。
     * 区别是移除项目能靠「重新添加同一路径」回来，而归档没有对应的翻回入口
     * ——**这是用户点名要的行为**（原话：不是列表收敛，是不在会话里面显示了，
     * 新开对话还是会显示新的），不是疏漏。将来若要翻回，加的是一个视图，
     * 不是改这条语义。
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
     * 对照三家真实实现，档位都只是**全局配置里的一个字段**，与 model 并排，
     * 会话不存自己的那一份：
     *
     * ```
     * Codex        ~/.codex/config.toml     model_reasoning_effort = "xhigh"
     * Claude Code  ~/.claude/settings.json  "effortLevel": "xhigh"
     * ```
     *
     * Codex 的 `session_meta` 里连 model 都不记，只有 cwd / git / provider——
     * 档位不是会话属性，每轮请求从那个全局值取。
     */
    sql: `ALTER TABLE conversations DROP COLUMN effort;`,
  },
  {
    id: 13,
    name: 'provider_request_ledger',
    /**
     * 逐请求账**接上**，`runs` 上那三列同时删掉。
     *
     * ## 表早就在，只是没有人写
     *
     * `provider_requests` 建于迁移 1，列是照青研魔盒 `agent_provider_requests`
     * 直译的。此后全项目**零读写**——只有 `newProviderRequestId()` 这个类型活着。
     * 面板于是只能读 `runs.context_tokens`，而那三列每个 step 覆盖一次，
     * 一个 run 只剩最后一次请求的读数。「这一轮上下文怎么长起来的」在账本里
     * 根本不存在，「为什么第三轮比第二轮还低」也就无从查起。
     *
     * ## 两列一删一加
     *
     * - 加 `omitted_categories`：面板要回答「什么被拿掉了」。压缩把历史换成摘要、
     *   把工具结果换成定位符之后，原文仍在账本里，只是没进这次请求——
     *   这个数就是那部分。原来的表只有 `sent_categories`，是半张账。
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
     * run 记下**是谁在跑它**，启动回收据此放过还活着的那些。
     *
     * ## 为什么必须有这两列
     *
     * `recoverStaleRuns` 原来无差别扫全库的 running/queued。而一台机器上可以有
     * 好几个进程写同一个账本——两个工作区各一个 sidecar（`server.ts` 自己的注释
     * 就这么写着）、开发态的热重载、终端里的 `qy exec`。**后起的那个进程一启动，
     * 就把前一个正在跑的那一轮判成中断**，而那个进程还活着、还在往下写。
     * 实测撞到过：一条跑了 40 步的 run 在第 27 次请求发出后 257 毫秒被判死，
     * 写入者是另一个刚起来的进程。
     *
     * 判「还活着」需要两个信号，缺一不可：
     *
     * - `owner_pid`：进程没了就该回收——这是**原来那条保证**，不能弱化。
     *   只有它不行：Windows 会复用 pid，一个不相干的新进程占了同一个号，
     *   死掉的那条 run 就永远判成「还活着」，会话被永久锁死。
     * - `heartbeat_at`：跑着的进程每隔十秒把它推一次。pid 被复用（或进程活着
     *   但那一轮早就废了）时，心跳停了就是停了，超时即回收。
     *
     * 反过来只有心跳也不行：进程崩溃后立刻重启，心跳才过去两秒，按超时判还「活着」,
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
     * ## 原来住错了地方
     *
     * 它存在 `ToolContext.state` 里，而那张 map 是 **run 内的便签**
     * （批级预算、计划快照也在里面，两者都必须每轮清零）。于是「读过 x.ts」
     * 这件事每轮清零一次：模型上一轮读过、这一轮直接改，必然先失败一次
     * 「本轮未读取过」，补一次 read 再改才成——账本里三次 edit_file 失败全是它。
     *
     * 服务端**每条消息新建一个 Session**（`run-control.ts` 的注释写明了），
     * 所以进程里根本没有「会话级」这个生命周期可挂。而账本里有：会话就是一行，
     * 删会话时这些行随 `ON DELETE CASCADE` 一起走，不需要另外发明淘汰策略。
     * 同一条推理让上下文面板改成从账本现算（`runtime/context-panel.ts`）。
     *
     * ## 这条守卫管的是新鲜度，不是记性
     *
     * 存的是**整份文件内容的哈希**，部分读（offset/limit）也记全量哈希——
     * 所以它从来不承诺「模型看过全文」，它只回答「你要写的这份，还是你读到的那份吗」。
     * 新鲜度的判据是磁盘现值，与 run 边界无关，因此挪长生命周期不放宽任何东西：
     * 文件被别人改过照样拦得住，拦它的是哈希比对。
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
     * 映射逐条有据（对齐青研魔盒 `contracts.py` 的六枚举）：
     * `execute` / `delegate` → `run`（跑命令、跑编排节点都是运行）、
     * `search` → `query`（搜索是查询的一种）、`fetch` → `read`（取一份已知的东西）、
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
]

/**
 * 当前 schema 版本 = 最后一条迁移的 id。
 *
 * **派生而不是手写。** 手写的那个值当时是对的，但它跟迁移表之间没有任何约束——
 * 加一条迁移忘了改它，它就开始说谎，而且不会有人发现：真正决定迁移的是
 * `_migrations` 表，这个常量没有消费者会去校验。派生之后它不可能再不一致。
 */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id
