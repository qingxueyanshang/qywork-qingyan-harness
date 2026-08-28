/**
 * 账本读写。
 *
 * 每个函数都是「一次完整的事实变更」，不暴露裸 SQL 给上层——账本的一致性规则
 * （step 原地更新、usage 累加口径、run 终态唯一）必须集中在这里，散到调用方就守不住。
 */

import type {
  CompactionManifest,
  ContextBreakdown,
  ContextOmitted,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  ProviderRequest,
  ProviderRequestId,
  ProviderRequestStatus,
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
import {
  emptyBreakdown,
  emptyOmitted,
  newConversationId,
  newMessageId,
  newProviderRequestId,
  newRunId,
  newStepId,
  newWorkspaceId,
} from '@qywork/core'
import type { Store } from './db.ts'
import { readJson, writeJson } from './db.ts'
import type {
  ConversationRow,
  MessageRow,
  ProviderRequestRow,
  RunRow,
  StepRow,
  WorkspaceRow,
} from './schema.ts'

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
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE root_path = ?')
    .get(rootPath)
  if (existing) {
    // `removed_at` 一并清掉：重新添加一个移除过的路径就是「把它加回来」，
    // 它的会话随之回到列表——那些数据从来没被删过（见 `removeWorkspace`）。
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
 * 侧栏里的顺序：**置顶的在前，其余按添加先后**。已移除的不在其中。
 *
 * **不按「最近打开」排。** 那样切一次项目它就跳到最前，而置顶已经是一个显式按钮——
 * 自动重排等于把那个按钮的语义抢掉，代价是列表在用户眼皮底下来回跳，
 * 上一秒点的位置下一秒是另一个项目。
 *
 * `pinned_at IS NULL` 作为第一排序键：SQLite 里 false(0) 排在 true(1) 前，
 * 所以这一条把「有置顶时间的」提到最上面，再按置顶时间倒序（后置顶的更靠前）。
 *
 * 「哪个是最近打开的」由 `mostRecentWorkspace` 单独回答——那是**启动挂哪儿**的
 * 判据，和**显示顺序**不是一件事，合用一条查询就是这次跳动的根因。
 */
export function listWorkspaces(store: Store): Workspace[] {
  return store.db
    .query<WorkspaceRow, []>(
      `SELECT * FROM workspaces WHERE removed_at IS NULL
       ORDER BY pinned_at IS NULL, pinned_at DESC, created_at ASC, id ASC`,
    )
    .all()
    .map(rowToWorkspace)
}

/**
 * 最近打开的那个项目。**启动挂哪儿**用它，不是显示顺序。
 *
 * 与 `listWorkspaces` 分开：显示顺序要稳定（不能切一次就重排），
 * 而「上次在用哪个」必须跟着 `last_opened_at` 走。一条查询同时担两个职责，
 * 就会出现「为了让启动记得住，列表只好跟着跳」。
 */
export function mostRecentWorkspace(store: Store): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, []>(
      `SELECT * FROM workspaces WHERE removed_at IS NULL
       ORDER BY last_opened_at DESC, id DESC LIMIT 1`,
    )
    .get()
  return row ? rowToWorkspace(row) : null
}

/**
 * 置顶 / 取消置顶。
 *
 * 幂等：已经是目标状态时返回 false，由调用方回 404 之外的处理——
 * 和 `removeWorkspace` 同一条纪律，静默当成功则界面显示已生效，刷新后又回到原状。
 */
export function setWorkspacePinned(store: Store, id: WorkspaceId, pinned: boolean): boolean {
  const sql = pinned
    ? 'UPDATE workspaces SET pinned_at = ? WHERE id = ? AND pinned_at IS NULL'
    : 'UPDATE workspaces SET pinned_at = NULL WHERE id = ? AND pinned_at IS NOT NULL'
  const q = store.db.query(sql)
  return (pinned ? q.run(Date.now(), id) : q.run(id)).changes > 0
}

/**
 * 按路径找那一行。**不过滤 `removed_at`**——移除过的也要找得到。
 *
 * 存在的理由：`upsertWorkspace` 会覆盖名字，而「切到另一个项目」走的是同一条
 * upsert。不先查一次的话，每切一次就把用户自己起的项目名重置成目录名。
 */
export function getWorkspaceByPath(store: Store, rootPath: string): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE root_path = ?')
    .get(rootPath)
  return row ? rowToWorkspace(row) : null
}

export function getWorkspace(store: Store, id: WorkspaceId): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE id = ?')
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
 * 由调用方回 404——静默当成功则界面显示已移除，刷新之后它又出现。
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
 * **这是「哪个根」的唯一权威。** 服务进程不许自己拿一个 `workspaceRoot` 常量
 * （启动时的 `--cwd`）：那样一个进程只服务得了一个项目，换项目只能重启，
 * 而那个常量本身就是这两张表的一份缓存。
 *
 * 查不到返回 `null`，**调用方必须停下来**：回落到某个默认根等于拿着 A 项目的
 * 会话去 B 项目的目录里跑命令，而工具的路径约束正是以这个根为边界的。
 */
export function workspaceOf(store: Store, id: ConversationId): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>(
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
    /** 接口名。与 `model` 一对，建会话时就定死，不留给下游去猜。 */
    provider: string
    model: string
    title?: string
    source?: Conversation['source']
    sourceRef?: string
  },
): Conversation {
  const now = Date.now()
  const conv: Conversation = {
    id: newConversationId(),
    workspaceId: input.workspaceId,
    title: input.title ?? '',
    provider: input.provider,
    model: input.model,
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
       (id, workspace_id, title, provider, model, compaction_manifest, cache_generation, source, source_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      conv.id,
      conv.workspaceId,
      conv.title,
      conv.provider,
      conv.model,
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
    .query<ConversationRow, [string]>('SELECT * FROM conversations WHERE id = ?')
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
    .query<ConversationRow, [number]>(
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
    .query<ConversationRow, [string]>(
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

/**
 * 归档一条会话：只写标记，数据一条不动。`listConversations` 不再列它，
 * `getConversation` 按 id 仍读得回。返回 false = 不存在，或本来就已归档。
 */
export function archiveConversation(store: Store, id: ConversationId): boolean {
  return (
    store.db
      .query('UPDATE conversations SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(Date.now(), id).changes > 0
  )
}

/**
 * 硬删一条会话。消息、run、步骤、provider 请求等随 FK 级联一起没
 * （`schema.ts` 各表的 `ON DELETE CASCADE`）。
 *
 * 附件目录不在这里删——它在磁盘上不在库里，由 `api/conversations.ts` 的 DELETE
 * 分支紧接着删掉。**那边只删本会话的目录，绝不按 `Attachment.path` 逐条删**：
 * 路径型附件指向的是用户自己的文件。
 *
 * **调用方必须先确认没有在跑的 run**：级联删掉的行那一轮还在往里写。
 */
export function deleteConversation(store: Store, id: ConversationId): boolean {
  return store.db.query('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
}

/**
 * 重命名。**不动 `updated_at`**：改名不是「有了新内容」，推进它会让列表重排、
 * 侧栏那个时间与实际内容更新时间不符。返回 null = 会话不存在。
 */
export function setConversationTitle(
  store: Store,
  id: ConversationId,
  title: string,
): Conversation | null {
  const changed = store.db.query('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
  if (changed.changes === 0) return null
  return getConversation(store, id)
}

/**
 * 切换会话的「接口 × 模型」。
 *
 * 模型是**会话级**属性，不是全局配置项——同一个工作区里一个会话用 Opus 深度改代码、
 * 另一个用 Haiku 快速问答是常态。**这条写入路径不能没有**：少了它
 * `conversation.setModel` 就是个静默返回的空分支——切换看起来成功了，实际每一轮
 * 还在用配置文件里的模型，而界面按新模型的价目表显示费用。
 *
 * **两列一起写。** 只写 `model` 的话，同一个模型 id 挂在两个接口下时，
 * 这条会话归谁取决于枚举顺序，而错的表现是端点、key、价目表三样一起换掉且不报错。
 *
 * 返回 null 表示会话不存在（客户端拿的是过期的 id）。
 */
export function setConversationModel(
  store: Store,
  id: ConversationId,
  ref: { provider: string; model: string },
): Conversation | null {
  const changed = store.db
    .query('UPDATE conversations SET provider = ?, model = ?, updated_at = ? WHERE id = ?')
    .run(ref.provider, ref.model, Date.now(), id)
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
  /*
   * 会话的「最近修改」跟着消息走，**这是它唯一一次因内容而推进**：这张表只有
   * user 行（assistant 的回合由 steps 投影），所以「有人说话」就等于走到这里。
   * 不推进的话，列表排序与侧栏时间都停在建会话那一刻。
   */
  store.db
    .query('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(msg.createdAt, msg.conversationId)
  return msg
}

/**
 * 记下这个会话读到某个文件时的内容哈希。写前的新鲜度校验就靠它。
 *
 * 同一文件重复读只留最近那次：判据是「手上那份还是不是磁盘上这份」，
 * 旧哈希对这个问题没有任何贡献，留着只会让表白涨。
 */
export function recordFileRead(
  store: Store,
  conversationId: ConversationId,
  path: string,
  hash: string,
): void {
  store.db
    .query(
      `INSERT INTO file_reads (conversation_id, path, hash, read_at) VALUES (?,?,?,?)
       ON CONFLICT(conversation_id, path) DO UPDATE SET hash = excluded.hash, read_at = excluded.read_at`,
    )
    .run(conversationId, path, hash, Date.now())
}

/** 这个会话读到那个文件时的内容哈希；没读过返回 null。 */
export function fileReadHash(
  store: Store,
  conversationId: ConversationId,
  path: string,
): string | null {
  const row = store.db
    .query<{ hash: string }, [string, string]>(
      'SELECT hash FROM file_reads WHERE conversation_id = ? AND path = ?',
    )
    .get(conversationId, path)
  return row?.hash ?? null
}

/**
 * 读取会话历史。
 *
 * `upperBound` 是 run 创建时定格的消息高水位：执行锁在 run 创建之后才拿到，
 * 排队期间用户可能又发了几条消息——那些消息**不属于**本 run 的历史，
 * 让它们穿越进来会让模型看到「未来」。
 */
export function listMessages(
  store: Store,
  conversationId: ConversationId,
  upperBound?: MessageId | null,
): Message[] {
  const rows = upperBound
    ? store.db
        .query<MessageRow, [string, string]>(
          'SELECT * FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id ASC',
        )
        .all(conversationId, upperBound)
    : store.db
        .query<MessageRow, [string]>(
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
    createdAt: now,
    finishedAt: null,
  }
  store.db
    .query(
      `INSERT INTO runs
       (id, conversation_id, workspace_id, user_message_id, message_id_upper_bound, assistant_message_id,
        model, client_request_id, status, stop_reason, input_tokens, output_tokens, cached_tokens,
        cache_write_tokens, reasoning_tokens, cost, currency, usage_turns, step_count, error_message, error_code,
        created_at, finished_at, owner_pid, heartbeat_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,0,NULL,NULL,0,0,'USD','[]',0,NULL,NULL,?,NULL,?,?)`,
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
      now,
      // 归属从建行那一刻就写上。晚一步写的话，「刚 createRun 就崩」留下的那条
      // 无归属行会被下一个进程按老规矩回收——那正是本来就该发生的事，
      // 但归属如果只在跑起来之后才补，同一条路径上会多出一段判据不同的窗口。
      process.pid,
      now,
    )
  return run
}

/**
 * 心跳：告诉别的进程「这一轮还有人在跑」。
 *
 * 只推 running 的行——已经落终态的 run 再推心跳没有意义，
 * 而且会让「心跳新 = 还在跑」这句话在事后读起来是假的。
 */
export function touchRun(store: Store, id: RunId): void {
  store.db
    .query("UPDATE runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .run(Date.now(), id)
}

/** 幂等：同一 (conversationId, clientRequestId) 已有 run 时直接返回它。 */
export function findRunByClientRequest(
  store: Store,
  conversationId: ConversationId,
  clientRequestId: string,
): Run | null {
  const row = store.db
    .query<RunRow, [string, string]>(
      'SELECT * FROM runs WHERE conversation_id = ? AND client_request_id = ?',
    )
    .get(conversationId, clientRequestId)
  return row ? rowToRun(row) : null
}

export function getRun(store: Store, id: RunId): Run | null {
  const row = store.db.query<RunRow, [string]>('SELECT * FROM runs WHERE id = ?').get(id)
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
 * 判据只有一个：**steps 表里那条带 `execution_started_at` 的 running 行**。
 * 别再给 `runs` 加一个 `execution_state` 之类的列——没有写入方的列拿来做判据，
 * 会让所有 run 都被判成「安全可重放」，正好是最危险的那个方向。
 *
 * **只回收没人在跑的那些，不能无差别扫全库**：账本是共享的，一台机器上同时有好几个写入者（两个工作
 * 区的 sidecar、开发态热重载、终端里的 `qy exec`），扫全库就是**后起的进程把别的进程正在跑的那一轮
 * 判死**。判据见 `isOrphan`，两个信号缺一不可。
 */
export function recoverStaleRuns(store: Store): {
  recovered: number
  ambiguous: number
  /** 有归属、且那个归属仍在运行，本次跳过的。启动日志要说出来，否则「回收了 0 个」有歧义。 */
  heldByOthers: number
} {
  // 这一趟取的是**投影**不是表行：列名改过，`ambiguous` 还是算出来的，
  // 所以形状就地声明，不去借哪张表的行类型。
  const all = store.db
    .query<
      { id: RunId; ownerPid: number | null; heartbeatAt: number | null; ambiguous: number },
      []
    >(
      `SELECT r.id AS id, r.owner_pid AS ownerPid, r.heartbeat_at AS heartbeatAt,
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

  const rows = all.filter((r) => isOrphan(r.ownerPid, r.heartbeatAt))
  const heldByOthers = all.length - rows.length

  // **不能在这里提前返回。** 下面还有一趟「终态 run 底下的孤儿 step」要扫，
  // 而那趟与本次有没有 stale run 无关——相反，最常见的情形就是
  // 「run 都是终态的、但底下留着 running step」。早退会让那趟永远不执行。
  let ambiguous = 0
  const now = Date.now()
  const finishStmt = store.db.query(
    `UPDATE runs SET status = 'interrupted', stop_reason = ?, error_code = ?, error_message = ?,
     finished_at = ? WHERE id = ?`,
  )

  store.db.transaction(() => {
    for (const r of rows) {
      const isAmbiguous = Number(r.ambiguous) === 1
      if (isAmbiguous) ambiguous++
      settleRunningSteps(store, r.id)
      finishStmt.run(
        // 干净那条是 `process_exit`，**不是 `user_interrupt`**——上面那段注释要求的
        // 「事后分得出崩了和用户点了停止」，写成 user_interrupt 就当场作废：
        // 界面上只剩一句「已中断」，而用户没点过停止。
        isAmbiguous ? 'internal_guard' : 'process_exit',
        isAmbiguous ? 'internal_error' : null,
        // 干净那条不能写「本轮未开始执行」——判据只说明「没有工具停在执行中」，
        // 完全兼容一个已经跑了几十步、恰好停在等模型回复那一刻的 run。
        isAmbiguous ? '上次进程在工具执行期间退出，结果不可信' : '上次进程退出，本轮中断',
        now,
        r.id,
      )
    }

    // **终态 run 底下也会留孤儿 step。** 上面那次扫描按 run 状态取，漏掉了它们。
    //
    // 产生路径是真实的：`tool.started` 的 yield 处被生成器 `.return()` 掐断
    // （客户端断连、用户切走），step 已经 openToolStep 成 running 但没人收尾；
    // 随后 session 的 finally 把 run 标成 interrupted 终态。因此这条 step
    // **永远碰不到恢复流程**，在库里永久保持 running。
    //
    // 后果不是「UI 上一张转圈的卡」那么轻——历史投影必须跳过含未终结调用的整个
    // batch（provider 要求每个 tool call 有配对结果），一条孤儿会让**同一批次里
    // 已经成功的写文件结果一起从历史里消失**。跨轮记忆修好了，中断过的那一轮
    // 反而还是失忆的。
    const orphanRuns = store.db
      .query<{ run_id: string }, []>(
        `SELECT DISTINCT s.run_id AS run_id FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE s.status = 'running' AND r.status NOT IN ('running','queued')`,
      )
      .all()
    for (const o of orphanRuns) settleRunningSteps(store, o.run_id as RunId)
  })()

  return { recovered: rows.length, ambiguous, heldByOthers }
}

/** 心跳超过这么久没推，就当那个进程已经不在跑它了。心跳是十秒一次，给六倍余量。 */
const HEARTBEAT_STALE_MS = 60_000

/**
 * 这条 run 还有没有活人在跑。
 *
 * **四条判据的顺序是有意的**，每一条堵的都是前一条的漏：
 *
 * 1. **没有归属** —— 迁移之前的历史行。按老规矩回收，不能因为不认识就放过。
 * 2. **归属是本进程的 pid** —— 本进程刚启动，不可能拥有任何 run，所以这一定是
 *    上一个进程留下的、而 Windows 把同一个号复用给了本进程。**这条必须在心跳之前**：
 *    崩溃后立刻重启时心跳只过去两三秒，按超时判会认定它仍在运行，
 *    因此那条 run 永远没人回收，会话被永久锁死。
 * 3. **那个 pid 已经不在** —— 进程没了，回收。这是本函数原本的全部意义，不能弱化。
 *    `EPERM` 算存活：宁可晚一分钟由心跳兜底，也不误杀一条真在跑的。
 * 4. **pid 还在但心跳停了** —— pid 被复用，或者那个进程仍在但那一轮已废弃。
 *
 * 只有 pid 会被 pid 复用误判，只有心跳会被「崩溃后立刻重启」误判。两个都要。
 */
function isOrphan(ownerPid: unknown, heartbeatAt: unknown): boolean {
  const pid = Number(ownerPid)
  if (!Number.isInteger(pid) || pid <= 0) return true
  if (pid === process.pid) return true
  if (!pidAlive(pid)) return true
  const beat = Number(heartbeatAt)
  return !Number.isFinite(beat) || Date.now() - beat > HEARTBEAT_STALE_MS
}

function pidAlive(pid: number): boolean {
  try {
    // 信号 0 不投递信号，只做存在性与权限检查。
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * 把一个 run 底下所有还挂着 running 的 step 落终态。
 *
 * **分两种，不能统一成一种。** 判据是 `execution_started_at`——**这是那条歧义边界的全部意义**：
 *
 * - **非空**：已经进了执行器。工具可能已经跑完并产生了副作用，也可能刚进去就崩了，
 *   两者无法区分。所以 `executed: true`（保守假设它执行过）+ 「结果未知」。
 *   向模型断言「没执行」等于让它重做——如果那是 `write_file` 或 `run_command`，
 *   就是重复副作用。
 * - **为空**：还没进执行器。这是**确定**没有发生的事，如实标 `executed: false`。
 *   把它也说成「结果未知」会让模型对每一次中断都花一轮去核实所有工具，
 *   包括那些明显没跑成的。
 *
 * **两种必须分开 UPDATE**：用同一份 payload 一起盖掉的话，「确定没跑」会被记成
 * 「可能跑过」。
 *
 * **只落 outcome，不许整份换掉 payload。** 两条都走 `json_set`，动的只有 `$.kind` 和 `$.outcome`；
 * `$.action` 与 `$.args` 原封不动留着。**`action` 是前端唯一的标题来源**（落库时那句注释已经写明：
 * 它由 ToolSpec 按参数解析，前端回猜不出来），整份 payload 换成只有 outcome 的那份，这条 step 在会
 * 话流里就只剩一个红色的「失败」——没有动词、没有对象、没有目标，和旁边每一行都不一样，而用户根本
 * 看不出它是哪一步崩的。
 */
export function settleRunningSteps(store: Store, runId: RunId): void {
  const settle = (executionStarted: boolean, outcome: Record<string, unknown>) =>
    store.db
      .query(
        `UPDATE steps
         SET status = 'failure',
             payload = json_set(coalesce(payload, '{}'), '$.kind', 'tool_result', '$.outcome', json(?))
         WHERE run_id = ? AND status = 'running'
           AND execution_started_at IS ${executionStarted ? 'NOT NULL' : 'NULL'}`,
      )
      .run(JSON.stringify(outcome), runId)

  settle(true, {
    status: 'failure',
    executed: true,
    message: '执行期间被中断，结果未知',
  })
  settle(false, {
    status: 'failure',
    executed: false,
    message: '未开始执行即被中断',
  })
}

export function listRuns(store: Store, conversationId: ConversationId): Run[] {
  return store.db
    .query<RunRow, [string]>(
      'SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(conversationId)
    .map(rowToRun)
}

// ─────────────────────────── 逐请求账 ───────────────────────────

/**
 * 记一次即将发出的模型请求。
 *
 * 在**装配完成之后、真正发出之前**调用，所以状态是 `pending`：此刻要发什么
 * 已经确定（分组占用、指纹都算得出来），provider 是否接收仍未知。
 * 把这两件事分开记，是为了让「发出去了但没回」和「没发出去」在账本上
 * 可区分——它们对上下文占用的含义完全不同。
 */
export function openProviderRequest(
  store: Store,
  input: {
    runId: RunId
    turnIndex: number
    retryIndex: number
    model: string
    measuredInputTokens: number
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
    cacheRouteFingerprint?: string | null
  },
): ProviderRequest {
  const row: ProviderRequest = {
    id: newProviderRequestId(),
    runId: input.runId,
    turnIndex: input.turnIndex,
    retryIndex: input.retryIndex,
    model: input.model,
    status: 'pending',
    measuredInputTokens: input.measuredInputTokens,
    providerInputTokens: null,
    providerOutputTokens: null,
    providerCachedTokens: null,
    providerCacheWriteTokens: null,
    finishReason: '',
    sentCategories: input.sentCategories,
    omittedCategories: input.omittedCategories,
    errorCode: null,
    errorMessage: null,
    payloadHash: input.payloadHash,
    cacheRouteFingerprint: input.cacheRouteFingerprint ?? null,
    sentAt: null,
    createdAt: Date.now(),
  }
  store.db
    .query(
      `INSERT INTO provider_requests
       (id, run_id, turn_index, retry_index, model, status, measured_input_tokens,
        provider_input_tokens, provider_output_tokens, provider_cached_tokens, provider_cache_write_tokens,
        sent_categories, omitted_categories, error_code, payload_hash, cache_route_fingerprint,
        sent_at, created_at)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,NULL,?,?,NULL,?)`,
    )
    .run(
      row.id,
      row.runId,
      row.turnIndex,
      row.retryIndex,
      row.model,
      row.status,
      row.measuredInputTokens,
      writeJson(row.sentCategories),
      writeJson(row.omittedCategories),
      row.payloadHash,
      row.cacheRouteFingerprint,
      row.createdAt,
    )
  return row
}

/** 请求真的发出去了。`sent_at` 只在这里置——面板据它选「最近一次已发送」。 */
export function markProviderRequestSent(store: Store, id: ProviderRequestId): void {
  store.db
    .query("UPDATE provider_requests SET status = 'in_flight', sent_at = ? WHERE id = ?")
    .run(Date.now(), id)
}

/**
 * 请求终态。
 *
 * `usage` 为 null 表示 provider 没回报——**四个字段保持 null，不要填 0**。
 * 中转站漏 usage 是常态，记成 0 会让上下文锚点误判成「这次请求什么都没占」。
 */
export function settleProviderRequest(
  store: Store,
  id: ProviderRequestId,
  status: Exclude<ProviderRequestStatus, 'pending' | 'in_flight'>,
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens: number | null
    cacheWriteTokens: number | null
  } | null,
  errorCode: string | null = null,
  finishReason = '',
  errorMessage: string | null = null,
): void {
  store.db
    .query(
      `UPDATE provider_requests
       SET status = ?, provider_input_tokens = ?, provider_output_tokens = ?,
           provider_cached_tokens = ?, provider_cache_write_tokens = ?, error_code = ?,
           finish_reason = ?, error_message = ?
       WHERE id = ?`,
    )
    .run(
      status,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
      usage?.cachedTokens ?? null,
      usage?.cacheWriteTokens ?? null,
      errorCode,
      finishReason,
      errorMessage,
      id,
    )
}

/** 本会话最近一次**已发送**的请求。面板的锚点从这里取。 */
export function latestSentProviderRequest(
  store: Store,
  conversationId: ConversationId,
): ProviderRequest | null {
  const row = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr
       JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.sent_at IS NOT NULL
       ORDER BY pr.sent_at DESC, pr.id DESC
       LIMIT 1`,
    )
    .get(conversationId)
  return row ? rowToProviderRequest(row) : null
}

/**
 * 本会话最近一次**带 usage 回报**的请求。
 *
 * 与上一个的区别是判据：这个要求 provider 真的报了数。锚点必须用这一个——
 * 一次超时或漏 usage 的请求也是「已发送」，拿它当锚等于把锚点归零。
 */
export function latestAnchoredProviderRequest(
  store: Store,
  conversationId: ConversationId,
): ProviderRequest | null {
  const row = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr
       JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.provider_input_tokens IS NOT NULL
       ORDER BY pr.sent_at DESC, pr.id DESC
       LIMIT 1`,
    )
    .get(conversationId)
  return row ? rowToProviderRequest(row) : null
}

export function listProviderRequests(store: Store, runId: RunId): ProviderRequest[] {
  return store.db
    .query<ProviderRequestRow, [string]>(
      'SELECT * FROM provider_requests WHERE run_id = ? ORDER BY turn_index ASC, retry_index ASC',
    )
    .all(runId)
    .map(rowToProviderRequest)
}

function rowToProviderRequest(r: ProviderRequestRow): ProviderRequest {
  return {
    id: r.id,
    runId: r.run_id,
    turnIndex: r.turn_index,
    retryIndex: r.retry_index,
    model: r.model,
    status: r.status,
    measuredInputTokens: r.measured_input_tokens,
    providerInputTokens: r.provider_input_tokens,
    providerOutputTokens: r.provider_output_tokens,
    providerCachedTokens: r.provider_cached_tokens,
    providerCacheWriteTokens: r.provider_cache_write_tokens,
    sentCategories: { ...emptyBreakdown(), ...readJson(r.sent_categories, {}) },
    omittedCategories: { ...emptyOmitted(), ...readJson(r.omitted_categories, {}) },
    errorCode: r.error_code,
    errorMessage: r.error_message,
    payloadHash: r.payload_hash,
    finishReason: r.finish_reason ?? '',
    cacheRouteFingerprint: r.cache_route_fingerprint,
    sentAt: r.sent_at,
    createdAt: r.created_at,
  }
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
    durationMs: null,
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
  /**
   * 这次调用跑了多久。**由执行方给，不在这里算**——它量的是执行器的起止，
   * 而这里能看到的只有落盘时刻。
   */
  durationMs?: number,
): void {
  store.db
    .query('UPDATE steps SET status = ?, payload = ?, duration_ms = ? WHERE id = ?')
    .run(status, writeJson(payload), durationMs ?? null, id)
}

/**
 * 把一次尝试留下的思考 step 落成失败终态。
 *
 * 轮内自动重发时用。思考 step 出生即 `done`，`settleRunningSteps` 只认 `running`，
 * 两者都覆盖不到这一格。
 *
 * **不删除。** 那几条 step 真实发生过、也已经逐 delta 渲染给用户看过；
 * 删掉会让已渲染的思考从界面上消失。标 `failure` 的用处在投影侧：
 * `stepsToUnits` 据它把失败那次的思考排除在模型视图之外，
 * 否则它会和重发那次的思考拼成一条回传给 provider。
 */
export function failThinkingSteps(store: Store, ids: StepId[]): void {
  if (ids.length === 0) return
  const marks = ids.map(() => '?').join(',')
  store.db
    .query(`UPDATE steps SET status = 'failure' WHERE kind = 'thinking' AND id IN (${marks})`)
    .run(...ids)
}

export function appendTextToStep(store: Store, id: StepId, text: string): void {
  store.db.query("UPDATE steps SET content = COALESCE(content,'') || ? WHERE id = ?").run(text, id)
}

/** 一个模型在一段时间里的请求收尾情况。分母是这段时间里为它开过的全部账本行。 */
export interface ModelFinishRate {
  model: string
  total: number
  /** 流按协议收完尾的次数。 */
  received: number
  /** 连接层面没成，收没收到、计没计费都不确定。 */
  uncertain: number
  /** provider 带状态码明确回绝。 */
  rejected: number
  /** 这段时间里出现最多的那个错误码；一次错都没有则为 null。 */
  topErrorCode: string | null
}

/**
 * 按模型统计请求收尾率。
 *
 * 用途：回答「这条端点在本机稳不稳」。这个问题今天只能靠反复试来回答，
 * 而账本里逐行记着答案。
 *
 * **边界：样本随会话删除**（`provider_requests.run_id` 是 ON DELETE CASCADE），
 * 所以统计的是现存会话，不是历史全量。
 */
export function providerFinishRates(store: Store, since: number): ModelFinishRate[] {
  return store.db
    .query<
      {
        model: string
        total: number
        received: number
        uncertain: number
        rejected: number
        top_error: string | null
      },
      [number, number]
    >(
      `SELECT model,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'received'  THEN 1 ELSE 0 END) AS received,
              SUM(CASE WHEN status = 'uncertain' THEN 1 ELSE 0 END) AS uncertain,
              SUM(CASE WHEN status = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
              (SELECT p2.error_code FROM provider_requests p2
                WHERE p2.model = p1.model AND p2.created_at >= ? AND p2.error_code IS NOT NULL
                GROUP BY p2.error_code ORDER BY COUNT(*) DESC LIMIT 1) AS top_error
         FROM provider_requests p1
        WHERE p1.created_at >= ?
        GROUP BY model
        ORDER BY total DESC`,
    )
    .all(since, since)
    .map((r) => ({
      model: r.model,
      total: r.total,
      received: r.received,
      uncertain: r.uncertain,
      rejected: r.rejected,
      topErrorCode: r.top_error,
    }))
}

export function listSteps(store: Store, runId: RunId): Step[] {
  return store.db
    .query<StepRow, [string]>('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC')
    .all(runId)
    .map(rowToStep)
}

// ─────────────────────────────── 行 → 领域对象 ───────────────────────────────

function rowToWorkspace(r: WorkspaceRow): Workspace {
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

function rowToConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    provider: r.provider,
    model: r.model,
    compactionManifest: readJson(r.compaction_manifest, null),
    cacheGeneration: r.cache_generation,
    source: r.source,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    attachments: readJson(r.attachments, []),
    createdAt: r.created_at,
  }
}

function rowToRun(r: RunRow): Run {
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
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }
}

function rowToStep(r: StepRow): Step {
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
    durationMs: r.duration_ms,
    content: r.content,
    payload: readJson(r.payload, null),
    status: r.status,
    createdAt: r.created_at,
  }
}
