/**
 * 账本读写。
 *
 * 每个函数都是「一次完整的事实变更」，不暴露裸 SQL 给上层——账本的一致性规则
 * （step 原地更新、usage 累加口径、run 终态唯一）必须集中在这里，散到调用方就守不住。
 */

import type {
  CompactionManifest,
  Conversation,
  ConversationId,
  EffortLevel,
  Message,
  MessageId,
  Run,
  RunId,
  RunUsage,
  Step,
  StepId,
  StopReason,
  ToolActionStatus,
  Workspace,
  WorkspaceId,
} from '@qywork/core'
import { newConversationId, newMessageId, newRunId, newStepId, newWorkspaceId } from '@qywork/core'
import type { Store } from './db.ts'
import { readJson, writeJson } from './db.ts'

const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: 0,
  cost: 0,
  currency: 'USD',
  turns: [],
}

// ─────────────────────────────── 工作区 ───────────────────────────────

export function upsertWorkspace(store: Store, rootPath: string, name: string): Workspace {
  const now = Date.now()
  const existing = store.db
    .query<Record<string, any>, [string]>('SELECT * FROM workspaces WHERE root_path = ?')
    .get(rootPath)
  if (existing) {
    // `removed_at` 一并清掉：重新添加一个移除过的路径就是「把它加回来」，
    // 它原来的会话随之回到列表——那些数据从来没被删过（见 `removeWorkspace`）。
    store.db
      .query('UPDATE workspaces SET last_opened_at = ?, name = ?, removed_at = NULL WHERE id = ?')
      .run(now, name, existing.id)
    return { ...rowToWorkspace(existing), lastOpenedAt: now, name }
  }
  const ws: Workspace = {
    id: newWorkspaceId(),
    name,
    rootPath,
    lastOpenedAt: now,
    createdAt: now,
  }
  store.db
    .query(
      'INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES (?,?,?,?,?)',
    )
    .run(ws.id, ws.name, ws.rootPath, ws.lastOpenedAt, ws.createdAt)
  return ws
}

/**
 * 置顶的在前，其余按「最近打开」倒序。**已移除的不在其中**（`removed_at IS NULL`）。
 *
 * `pinned_at IS NULL` 作为第一排序键：SQLite 里 false(0) 排在 true(1) 前，
 * 所以这一条把「有置顶时间的」提到最上面，再按置顶时间倒序（后置顶的更靠前）。
 *
 * 次级排序键 `id DESC` 不是装饰：同一毫秒 upsert 的两个项目 `last_opened_at` 会并列，
 * 只按它排序时 SQLite 退回插入顺序，结果正好是反的。而这个顺序现在有实际后果——
 * 不带 `?ws=` 的请求落到第一条，git 轮询也盯着第一条。
 * （与 `listConversations` 是同一条教训。）
 */
export function listWorkspaces(store: Store): Workspace[] {
  return store.db
    .query<Record<string, any>, []>(
      `SELECT * FROM workspaces WHERE removed_at IS NULL
       ORDER BY pinned_at IS NULL, pinned_at DESC, last_opened_at DESC, id DESC`,
    )
    .all()
    .map(rowToWorkspace)
}

/**
 * 置顶 / 取消置顶。
 *
 * 幂等：已经是目标状态时返回 false，由调用方回 404 之外的处理——
 * 和 `removeWorkspace` 同一条纪律，静默当成功会让界面以为生效了，刷新又回去。
 */
export function setWorkspacePinned(store: Store, id: WorkspaceId, pinned: boolean): boolean {
  const sql = pinned
    ? 'UPDATE workspaces SET pinned_at = ? WHERE id = ? AND pinned_at IS NULL'
    : 'UPDATE workspaces SET pinned_at = NULL WHERE id = ? AND pinned_at IS NOT NULL'
  const q = store.db.query(sql)
  return (pinned ? q.run(Date.now(), id) : q.run(id)).changes > 0
}

export function getWorkspace(store: Store, id: WorkspaceId): Workspace | null {
  const row = store.db
    .query<Record<string, any>, [string]>('SELECT * FROM workspaces WHERE id = ?')
    .get(id)
  return row ? rowToWorkspace(row) : null
}

/**
 * 这个项目下有几条会话——**口径与 `listConversations` 完全一致**。
 *
 * 同样只数用户会话、同样排除已归档的。两处口径必须一样：卡片上写「111 个任务」
 * 而列表里一条都没有，用户只会认为列表坏了。
 */
export function countConversations(store: Store, id: WorkspaceId): number {
  const row = store.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM conversations
       WHERE workspace_id = ? AND source IS NULL AND archived_at IS NULL`,
    )
    .get(id)
  return row?.n ?? 0
}

/**
 * 把一个项目从列表里移除。**数据一条不动。**
 *
 * 打 `removed_at` 标记，不 `DELETE`。行必须留下：`conversations.workspace_id` 是
 * `ON DELETE CASCADE`，而 `workspaceOf` 要 join 这一行才答得出「这条会话跑在哪个根」
 * ——删了行，它的会话就成了永远打不开的孤儿。
 *
 * 所以移除只改「列表里显不显示」（`listWorkspaces` 过滤它），不改「能不能读回来」
 * （`workspaceOf` / `getWorkspace` 不过滤）。重新添加同一个路径就整个回来：
 * `root_path` 是 UNIQUE，`upsertWorkspace` 命中同一行并清掉这个标记。
 *
 * `usage_ledger` 本来就不受影响：它刻意没有外键，「这个月花了多少」不该因为项目
 * 从列表里消失而少一笔（理由写在 `schema.ts` 第 3 条迁移里）。
 *
 * 返回是否真的改动了一行。id 不存在、或它已经是移除状态时返回 false，
 * 由调用方回 404——静默当成功会让界面以为移除了，刷新之后它又回来。
 */
export function removeWorkspace(store: Store, id: WorkspaceId): boolean {
  return (
    store.db
      .query('UPDATE workspaces SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
      .run(Date.now(), id).changes > 0
  )
}

/**
 * 这条会话跑在哪个目录下。
 *
 * **这是「哪个根」的唯一权威。** 服务进程曾经自己拿着一个 `workspaceRoot` 常量
 * （启动时的 `--cwd`），于是一个进程只服务得了一个项目，换项目只能重启。
 * 那个常量是这两张表的一份缓存，删掉之后一律来这里查。
 *
 * 查不到返回 `null`，**调用方必须停下来**：回落到某个默认根等于拿着 A 项目的
 * 会话去 B 项目的目录里跑命令，而工具的路径约束正是以这个根为边界的。
 */
export function workspaceOf(store: Store, id: ConversationId): Workspace | null {
  const row = store.db
    .query<Record<string, any>, [string]>(
      `SELECT w.* FROM conversations c
       JOIN workspaces w ON w.id = c.workspace_id
       WHERE c.id = ?`,
    )
    .get(id)
  return row ? rowToWorkspace(row) : null
}

// ─────────────────────────────── 会话 ───────────────────────────────

export function createConversation(
  store: Store,
  input: {
    workspaceId: WorkspaceId
    model: string
    title?: string
    effort?: EffortLevel
    source?: Conversation['source']
    sourceRef?: string
  },
): Conversation {
  const now = Date.now()
  const conv: Conversation = {
    id: newConversationId(),
    workspaceId: input.workspaceId,
    title: input.title ?? '',
    model: input.model,
    effort: input.effort ?? null,
    compactionManifest: null,
    cacheGeneration: 0,
    source: input.source ?? null,
    sourceRef: input.sourceRef ?? null,
    createdAt: now,
    updatedAt: now,
  }
  store.db
    .query(
      `INSERT INTO conversations
       (id, workspace_id, title, model, effort, compaction_manifest, cache_generation, source, source_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      conv.id,
      conv.workspaceId,
      conv.title,
      conv.model,
      conv.effort,
      null,
      0,
      conv.source,
      conv.sourceRef,
      now,
      now,
    )
  return conv
}

export function getConversation(store: Store, id: ConversationId): Conversation | null {
  const row = store.db
    .query<Record<string, any>, [string]>('SELECT * FROM conversations WHERE id = ?')
    .get(id)
  return row ? rowToConversation(row) : null
}

/**
 * 跨工作区的最近会话。
 *
 * `listConversations` 要工作区 id，那是界面用的——界面永远开在某个工作区里。
 * CLI 不是：`qy export` 可能在任何目录下跑，而账本是全局一份，
 * 用户想导的很可能是别的工作区里那个会话。要求它先切目录才能列出来，是把
 * 数据模型的形状强加给使用方式。
 */
export function listRecentConversations(store: Store, limit = 20): Conversation[] {
  return store.db
    .query<Record<string, any>, [number]>(
      // `source IS NULL` = 用户会话；编排产生的机器会话不列，
      // 与 listConversations 用同一条判据（不是另发明一个 kind 列）。
      `SELECT * FROM conversations WHERE source IS NULL
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(limit)
    .map(rowToConversation)
}

export function listConversations(store: Store, workspaceId: WorkspaceId): Conversation[] {
  return store.db
    .query<Record<string, any>, [string]>(
      // 只列用户会话：编排产生的机器会话不进会话列表，
      // 它们由父会话的协作视图展示。
      //
      // 已归档的也不列（`archived_at IS NULL`）。归档只改「显不显示」，
      // `getConversation` 不过滤——按 id 仍然读得回来。
      //
      // 次级排序键 id DESC 不是装饰：同一毫秒创建的会话（批量导入、同秒连续操作）
      // updated_at 会并列，只按它排序时 SQLite 退回插入顺序，结果看起来是反的。
      // id 单调递增，保证并列时顺序仍然正确且可复现。
      `SELECT * FROM conversations
       WHERE workspace_id = ? AND source IS NULL AND archived_at IS NULL
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(workspaceId)
    .map(rowToConversation)
}

/**
 * 归档一个项目下当前的全部会话。
 *
 * **不是删除**：数据一条不动，只是从 `listConversations` 里消失；此后在这个项目里
 * 新建的会话照常显示（新行的 `archived_at` 是 NULL）。
 *
 * 与 `runtime/src/archive.ts` 同名不同物——那个是导出成 markdown / json。
 *
 * 只归档用户会话（`source IS NULL`）：机器会话本来就不在列表里，
 * 给它们打标记等于给一个没有消费者的字段写值。
 *
 * 返回归档了几条。已经归档的不重复计数（`archived_at IS NULL` 卡住），
 * 界面据此说「归档了 N 条」而不是「操作成功」。
 */
export function archiveWorkspaceConversations(store: Store, workspaceId: WorkspaceId): number {
  return store.db
    .query(
      `UPDATE conversations SET archived_at = ?
       WHERE workspace_id = ? AND source IS NULL AND archived_at IS NULL`,
    )
    .run(Date.now(), workspaceId).changes
}

export function touchConversation(store: Store, id: ConversationId, title?: string): void {
  if (title === undefined) {
    store.db.query('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  } else {
    store.db
      .query('UPDATE conversations SET updated_at = ?, title = ? WHERE id = ?')
      .run(Date.now(), title, id)
  }
}

/**
 * 切换会话模型。
 *
 * 模型是**会话级**属性，不是全局配置项——同一个工作区里一个会话用 Opus 深度改代码、
 * 另一个用 Haiku 快速问答是常态。曾经这里没有写入路径，`conversation.setModel`
 * 指令是个静默返回的空分支：切换看起来成功了，实际每一轮还在用配置文件里的模型，
 * 而界面按新模型的价目表显示费用。
 *
 * 返回 null 表示会话不存在（客户端拿的是过期的 id）。
 */
export function setConversationModel(
  store: Store,
  id: ConversationId,
  model: string,
): Conversation | null {
  const changed = store.db
    .query('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?')
    .run(model, Date.now(), id)
  if (changed.changes === 0) return null
  return getConversation(store, id)
}

/**
 * 切换会话思考强度。
 *
 * `null` 是合法值，表示**回到跟随配置默认**——所以这里不能用「假值即不改」的
 * 写法，那会让「清除」这个动作永远没法执行。
 */
export function setConversationEffort(
  store: Store,
  id: ConversationId,
  effort: EffortLevel | null,
): Conversation | null {
  const changed = store.db
    .query('UPDATE conversations SET effort = ?, updated_at = ? WHERE id = ?')
    .run(effort, Date.now(), id)
  if (changed.changes === 0) return null
  return getConversation(store, id)
}

/**
 * 写入压缩投影。
 *
 * 只动 conversations.compaction_manifest 这一列——**Message / Step / 正文库一个字节不动**。
 * 压缩是投影不是销毁：历史面板永远显示完整会话，压缩可撤销、可重放。
 * 做成「删掉旧消息换成摘要」的话，用户翻历史会发现前面的对话凭空消失。
 */
export function setCompactionManifest(
  store: Store,
  id: ConversationId,
  manifest: CompactionManifest | null,
): void {
  store.db
    .query('UPDATE conversations SET compaction_manifest = ?, updated_at = ? WHERE id = ?')
    .run(writeJson(manifest), Date.now(), id)
}

// ─────────────────────────────── 消息 ───────────────────────────────

export function appendMessage(
  store: Store,
  input: {
    conversationId: ConversationId
    role: Message['role']
    content: string
    attachments?: Message['attachments']
  },
): Message {
  const msg: Message = {
    id: newMessageId(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    attachments: input.attachments ?? [],
    createdAt: Date.now(),
  }
  store.db
    .query(
      'INSERT INTO messages (id, conversation_id, role, content, attachments, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(
      msg.id,
      msg.conversationId,
      msg.role,
      msg.content,
      writeJson(msg.attachments),
      msg.createdAt,
    )
  return msg
}

/**
 * 读取会话历史。
 *
 * `upperBound` 是 run 创建时定格的消息高水位：执行锁在 run 创建之后才拿到，
 * 排队期间用户可能又发了几条消息——那些消息**不属于**本 run 的历史，
 * 让它们穿越进来会让模型看到「未来」。
 */
/**
 * 所有被消息引用过的附件路径。
 *
 * 给附件目录的 GC 用：**没有任何消息引用的文件就是孤儿**——用户选了图、
 * 没发出去就换了话题，那份字节永远不会再被读到。
 *
 * 一次全表扫。附件是低频操作，消息表再大也只需要在**启动时**跑这一次；
 * 为它单开一张索引表等于给自己加一本要维护的账。
 */
export function referencedAttachmentPaths(store: Store): Set<string> {
  const rows = store.db
    .query<{ attachments: string | null }, []>(
      "SELECT attachments FROM messages WHERE attachments IS NOT NULL AND attachments != ''",
    )
    .all()
  const out = new Set<string>()
  for (const r of rows) {
    for (const a of readJson<{ path?: unknown }[]>(r.attachments, [])) {
      if (typeof a?.path === 'string' && a.path) out.add(a.path)
    }
  }
  return out
}

export function listMessages(
  store: Store,
  conversationId: ConversationId,
  upperBound?: MessageId | null,
): Message[] {
  const rows = upperBound
    ? store.db
        .query<Record<string, any>, [string, string]>(
          'SELECT * FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id ASC',
        )
        .all(conversationId, upperBound)
    : store.db
        .query<Record<string, any>, [string]>(
          'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC',
        )
        .all(conversationId)
  return rows.map(rowToMessage)
}

// ─────────────────────────────── Run ───────────────────────────────

export function createRun(
  store: Store,
  input: {
    conversationId: ConversationId
    workspaceId: WorkspaceId
    model: string
    clientRequestId: string
    userMessageId: MessageId | null
    messageIdUpperBound: MessageId | null
    retryOfRunId?: RunId | null
  },
): Run {
  const now = Date.now()
  const run: Run = {
    id: newRunId(),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userMessageId: input.userMessageId,
    messageIdUpperBound: input.messageIdUpperBound,
    assistantMessageId: null,
    model: input.model,
    clientRequestId: input.clientRequestId,
    status: 'queued',
    stopReason: null,
    usage: { ...EMPTY_USAGE },
    stepCount: 0,
    errorMessage: null,
    errorCode: null,
    contextTokens: 0,
    contextLimit: 0,
    contextPercent: 0,
    retryOfRunId: input.retryOfRunId ?? null,
    supersededBy: null,
    createdAt: now,
    finishedAt: null,
  }
  store.db
    .query(
      `INSERT INTO runs
       (id, conversation_id, workspace_id, user_message_id, message_id_upper_bound, assistant_message_id,
        model, client_request_id, status, stop_reason, input_tokens, output_tokens, cached_tokens,
        cache_write_tokens, reasoning_tokens, cost, currency, usage_turns, step_count, error_message, error_code,
        context_tokens, context_limit, context_percent, retry_of_run_id, superseded_by,
        created_at, finished_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,NULL,NULL,0,0,'USD','[]',0,NULL,NULL,0,0,0,?,NULL,?,NULL)`,
    )
    .run(
      run.id,
      run.conversationId,
      run.workspaceId,
      run.userMessageId,
      run.messageIdUpperBound,
      null,
      run.model,
      run.clientRequestId,
      run.status,
      null,
      run.retryOfRunId,
      now,
    )
  return run
}

/** 幂等：同一 (conversationId, clientRequestId) 已有 run 时直接返回它。 */
export function findRunByClientRequest(
  store: Store,
  conversationId: ConversationId,
  clientRequestId: string,
): Run | null {
  const row = store.db
    .query<Record<string, any>, [string, string]>(
      'SELECT * FROM runs WHERE conversation_id = ? AND client_request_id = ?',
    )
    .get(conversationId, clientRequestId)
  return row ? rowToRun(row) : null
}

export function getRun(store: Store, id: RunId): Run | null {
  const row = store.db
    .query<Record<string, any>, [string]>('SELECT * FROM runs WHERE id = ?')
    .get(id)
  return row ? rowToRun(row) : null
}

export function markRunRunning(store: Store, id: RunId): void {
  store.db.query("UPDATE runs SET status = 'running' WHERE id = ?").run(id)
}

export function updateRunUsage(store: Store, id: RunId, usage: RunUsage): void {
  store.db
    .query(
      `UPDATE runs SET input_tokens = ?, output_tokens = ?, cached_tokens = ?,
       cache_write_tokens = ?, reasoning_tokens = ?, cost = ?, currency = ?, usage_turns = ? WHERE id = ?`,
    )
    .run(
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      usage.reasoningTokens,
      usage.cost,
      usage.currency,
      JSON.stringify(usage.turns),
      id,
    )
}

export function updateRunContext(
  store: Store,
  id: RunId,
  ctx: { tokens: number; limit: number; percent: number },
): void {
  store.db
    .query(
      'UPDATE runs SET context_tokens = ?, context_limit = ?, context_percent = ? WHERE id = ?',
    )
    .run(ctx.tokens, ctx.limit, ctx.percent, id)
}

/**
 * Run 收尾。stopReason 必填——废除「静默 done」，前端要能回答用户
 * 「它为什么停了」，不能只显示一个绿勾。
 */
export function finishRun(
  store: Store,
  id: RunId,
  input: {
    status: 'done' | 'failed' | 'interrupted'
    stopReason: StopReason
    assistantMessageId?: MessageId | null
    errorMessage?: string | null
    errorCode?: string | null
  },
): void {
  store.db
    .query(
      `UPDATE runs SET status = ?, stop_reason = ?, assistant_message_id = COALESCE(?, assistant_message_id),
       error_message = ?, error_code = ?, finished_at = ? WHERE id = ?`,
    )
    .run(
      input.status,
      input.stopReason,
      input.assistantMessageId ?? null,
      input.errorMessage ?? null,
      input.errorCode ?? null,
      Date.now(),
      id,
    )
}

/**
 * 标记某个 run 已被重试接替。
 *
 * 被接替的 run **不删除、不隐藏**：那些步骤是真实发生过的，工具真的跑过、
 * 文件真的改过、token 真的花了。UI 把它降透明度保留，用户能回看「上一次是怎么错的」。
 * 删掉它等于让账本对不上——费用统计里那笔钱找不到对应的执行记录。
 *
 * 只对已终结的 run 生效：还在跑的 run 应当先中断再重试，否则会出现两个 run
 * 同时往同一个工作区写文件。
 */
export function markRunSuperseded(store: Store, id: RunId, by: RunId): boolean {
  const changed = store.db
    .query(
      "UPDATE runs SET superseded_by = ? WHERE id = ? AND status IN ('done','failed','interrupted')",
    )
    .run(by, id)
  return changed.changes > 0
}

/**
 * 启动时回收上次进程留下的 running / queued run。
 *
 * 为什么不能靠进程内的 finally：`finally` 只在生成器正常关闭时执行，
 * SIGKILL、断电、Tauri 外壳崩溃时一行都不跑。留下的 running run 会让
 * 会话永远显示「执行中」，而且 `isBusy` 判定会拒绝用户发新消息——**会话被永久锁死**。
 *
 * 分流依据是 **step 的 `execution_started_at`**（ARCHITECTURE.md 第 6 节的歧义边界），
 * 不是 run 上的字段：
 *
 * - 存在「`execution_started_at` 非空但 status 仍是 running」的 step
 *   = 进了执行器却没落终态。那个工具**可能已经跑完并产生了副作用**，
 *   也可能刚进去就崩了——**无法区分**，所以整轮结果不可信。
 * - 没有这样的 step = 所有工具要么没开始、要么已有确定结果，本轮没有未知副作用。
 *
 * 两者都标终态，区别在 `stopReason`——**不要为了界面干净统一成 user_interrupt**，
 * 那会让「进程崩了」和「用户点了停止」在事后无法区分。
 *
 * 曾经有一个 `runs.execution_state` 列，从未被写入过——拿它做判据会让所有 run
 * 都被判成「安全可重放」，正好是最危险的那个方向。已连同 `ExecutionState` 一起删掉，
 * 判据只有一个：**steps 表里那条带 `execution_started_at` 的 running 行**。
 */
export function recoverStaleRuns(store: Store): { recovered: number; ambiguous: number } {
  const rows = store.db
    .query<Record<string, any>, []>(
      `SELECT r.id AS id,
              EXISTS (
                SELECT 1 FROM steps s
                WHERE s.run_id = r.id
                  AND s.execution_started_at IS NOT NULL
                  AND s.status = 'running'
              ) AS ambiguous
       FROM runs r
       WHERE r.status IN ('running','queued')`,
    )
    .all()
  if (rows.length === 0) return { recovered: 0, ambiguous: 0 }

  let ambiguous = 0
  const now = Date.now()
  const finishStmt = store.db.query(
    `UPDATE runs SET status = 'interrupted', stop_reason = ?, error_code = ?, error_message = ?,
     finished_at = ? WHERE id = ?`,
  )
  // 卡在 running 的 step 也要落终态，否则 UI 上留一张永远转圈的工具卡。
  const settleStepsStmt = store.db.query(
    `UPDATE steps SET status = 'failure', payload = ? WHERE run_id = ? AND status = 'running'`,
  )
  const orphanPayload = JSON.stringify({
    kind: 'tool_result',
    outcome: {
      status: 'failure',
      // executed 无法判定，所以取**保守值 true**：假设它执行过。
      // 反过来标 false 等于向模型和用户断言「没有副作用」，而我们并不知道。
      executed: true,
      message: '进程在该工具执行期间退出，结果未知',
    },
  })

  store.db.transaction(() => {
    for (const r of rows) {
      const isAmbiguous = Number(r.ambiguous) === 1
      if (isAmbiguous) ambiguous++
      settleStepsStmt.run(orphanPayload, r.id)
      finishStmt.run(
        isAmbiguous ? 'internal_guard' : 'user_interrupt',
        isAmbiguous ? 'internal_error' : null,
        isAmbiguous ? '上次进程在工具执行期间退出，本轮结果不可信' : '上次进程退出，本轮未开始执行',
        now,
        r.id,
      )
    }
  })()

  return { recovered: rows.length, ambiguous }
}

export function listRuns(store: Store, conversationId: ConversationId): Run[] {
  return store.db
    .query<Record<string, any>, [string]>(
      'SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(conversationId)
    .map(rowToRun)
}

// ─────────────────────────────── Step ───────────────────────────────

export function appendStep(
  store: Store,
  input: {
    runId: RunId
    seq: number
    kind: Step['kind']
    toolName?: string | null
    toolCallId?: string | null
    providerBatchId?: string | null
    callIndex?: number | null
    executionWaveIndex?: number | null
    content?: string | null
    payload?: Step['payload']
    status?: Step['status']
  },
): Step {
  const step: Step = {
    id: newStepId(),
    runId: input.runId,
    seq: input.seq,
    kind: input.kind,
    toolName: input.toolName ?? null,
    toolCallId: input.toolCallId ?? null,
    providerBatchId: input.providerBatchId ?? null,
    callIndex: input.callIndex ?? null,
    executionWaveIndex: input.executionWaveIndex ?? null,
    executionStartedAt: null,
    content: input.content ?? null,
    payload: input.payload ?? null,
    status: input.status ?? 'done',
    createdAt: Date.now(),
  }
  store.db
    .query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, tool_call_id, provider_batch_id,
       call_index, execution_wave_index, execution_started_at, content, payload, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      step.id,
      step.runId,
      step.seq,
      step.kind,
      step.toolName,
      step.toolCallId,
      step.providerBatchId,
      step.callIndex,
      step.executionWaveIndex,
      null,
      step.content,
      writeJson(step.payload),
      step.status,
      step.createdAt,
    )
  store.db.query('UPDATE runs SET step_count = step_count + 1 WHERE id = ?').run(input.runId)
  return step
}

/**
 * 标记工具即将执行。
 *
 * 必须在调用执行器**之前**单独提交：这条时间戳就是崩溃恢复的歧义边界。
 * 有它 = 可能已经执行过（不可重放）；没有 = 确定没执行（可安全重放）。
 */
export function markStepExecuting(store: Store, id: StepId): void {
  store.db.query('UPDATE steps SET execution_started_at = ? WHERE id = ?').run(Date.now(), id)
}

/** 一次调用一行，原地从 running 更新到终态；不产生第二行。 */
export function settleToolStep(
  store: Store,
  id: StepId,
  status: ToolActionStatus,
  payload: Step['payload'],
): void {
  store.db
    .query('UPDATE steps SET status = ?, payload = ? WHERE id = ?')
    .run(status, writeJson(payload), id)
}

export function appendTextToStep(store: Store, id: StepId, text: string): void {
  store.db.query("UPDATE steps SET content = COALESCE(content,'') || ? WHERE id = ?").run(text, id)
}

export function listSteps(store: Store, runId: RunId): Step[] {
  return store.db
    .query<Record<string, any>, [string]>('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC')
    .all(runId)
    .map(rowToStep)
}

// ─────────────────────────────── 行 → 领域对象 ───────────────────────────────

function rowToWorkspace(r: Record<string, any>): Workspace {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    lastOpenedAt: r.last_opened_at,
    createdAt: r.created_at,
    // 键不存在与键为 undefined 在 exactOptionalPropertyTypes 下不是一回事，
    // 所以按 null 判断后再决定加不加这个键。
    ...(r.pinned_at === null || r.pinned_at === undefined ? {} : { pinnedAt: r.pinned_at }),
  }
}

function rowToConversation(r: Record<string, any>): Conversation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    model: r.model,
    effort: r.effort ?? null,
    compactionManifest: readJson(r.compaction_manifest, null),
    cacheGeneration: r.cache_generation,
    source: r.source,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToMessage(r: Record<string, any>): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    attachments: readJson(r.attachments, []),
    createdAt: r.created_at,
  }
}

function rowToRun(r: Record<string, any>): Run {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    workspaceId: r.workspace_id,
    userMessageId: r.user_message_id,
    messageIdUpperBound: r.message_id_upper_bound,
    assistantMessageId: r.assistant_message_id,
    model: r.model,
    clientRequestId: r.client_request_id,
    status: r.status,
    stopReason: r.stop_reason,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      // 直接透传 null，不要 ?? 0——见 schema 注释。
      cachedTokens: r.cached_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      reasoningTokens: r.reasoning_tokens,
      cost: r.cost,
      currency: r.currency,
      turns: readJson(r.usage_turns, []),
    },
    stepCount: r.step_count,
    errorMessage: r.error_message,
    errorCode: r.error_code,
    contextTokens: r.context_tokens,
    contextLimit: r.context_limit,
    contextPercent: r.context_percent,
    retryOfRunId: r.retry_of_run_id,
    supersededBy: r.superseded_by,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }
}

function rowToStep(r: Record<string, any>): Step {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    kind: r.kind,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    providerBatchId: r.provider_batch_id,
    callIndex: r.call_index,
    executionWaveIndex: r.execution_wave_index,
    executionStartedAt: r.execution_started_at,
    content: r.content,
    payload: readJson(r.payload, null),
    status: r.status,
    createdAt: r.created_at,
  }
}
