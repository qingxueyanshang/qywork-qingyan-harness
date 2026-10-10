/**
 * 账本读写。
 *
 * 每个函数完成一次完整的事实变更，不向上层暴露 SQL：账本的一致性规则
 * （step 原地更新、usage 累加口径、run 终态唯一）必须集中在此处，分散到调用方后无法保证。
 */

import { resolve } from 'node:path'
import type {
  CompactionManifest,
  ContextBreakdown,
  ContextOmitted,
  Conversation,
  ConversationChangeStep,
  ConversationChangesPageResponse,
  ConversationHistoryPage,
  ConversationId,
  FileChange,
  MediaSpend,
  Message,
  MessageId,
  NodePhase,
  NodeState,
  ProviderHedge,
  ProviderKind,
  ProviderRequest,
  ProviderRequestConfiguration,
  ProviderRequestContentKind,
  ProviderRequestDiagnostic,
  ProviderRequestId,
  ProviderRequestPurpose,
  ProviderRequestStatus,
  Run,
  RunContextSegment,
  RunId,
  RunInterruption,
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
  foldFileChanges,
  newConversationId,
  newMessageId,
  newProviderRequestId,
  newRunId,
  newStepId,
  newWorkspaceId,
} from '@qywork/core'
import type { RunOwner, Store } from './db.ts'
import { readJson, writeJson } from './db.ts'
import type {
  ConversationRow,
  MessageRow,
  ProviderRequestRow,
  RunRow,
  StepRow,
  WorkspaceRow,
} from './schema.ts'
import { latestTodos } from './todos.ts'

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

/**
 * 工作区根路径的落盘形式：绝对路径 + 本平台分隔符。
 *
 * `root_path` 有 UNIQUE 约束，但按字符串比较。Windows 上同一目录写成 `C:/x/ws` 与
 * `C:\x\ws` 会各建一行，该目录下的会话因此分属两个项目。写入与按根目录查找
 * 都必须先经过本函数，`schedules.ts` 的 `workspace_root` 使用同一函数。
 *
 * 边界：不访问文件系统。符号链接、盘符大小写、8.3 短名不在规范化范围内。
 */
export function normalizeWorkspaceRoot(rootPath: string): string {
  return resolve(rootPath)
}

/**
 * 不存在时插入一行，已存在时更新 `last_opened_at` 与名称。
 *
 * 用一条语句完成，不要拆成先 SELECT 再 INSERT：同一目录首次被两个进程同时打开时，
 * 两个进程都查询到不存在，后插入的一方触发 `root_path` 的 UNIQUE 冲突，启动随即失败。
 *
 * `removed_at` 一并清空：重新添加已移除的路径即恢复该项目，
 * 其会话随之回到列表，这些数据从未删除（见 `removeWorkspace`）。
 */
export function upsertWorkspace(store: Store, rootPath: string, name: string): Workspace {
  const now = Date.now()
  const row = store.db
    .query<WorkspaceRow, [string, string, string, number, number]>(
      `INSERT INTO workspaces (id, name, root_path, last_opened_at, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(root_path) DO UPDATE
         SET last_opened_at = excluded.last_opened_at, name = excluded.name, removed_at = NULL
       RETURNING *`,
    )
    .get(newWorkspaceId(), name, normalizeWorkspaceRoot(rootPath), now, now)
  if (!row) throw new Error('[qywork] 写入工作区未返回行')
  return rowToWorkspace(row)
}

/**
 * 侧栏中的顺序：置顶的项目在前，其余按添加顺序排列。不含已移除的项目。
 *
 * 不按最近打开时间排序：按该时间排序时，每次切换都会把项目移到最前，
 * 与显式的置顶按钮作用重叠，且列表位置随切换变化，同一点击位置会对应不同项目。
 *
 * `pinned_at IS NULL` 作为第一排序键：SQLite 中 false(0) 排在 true(1) 之前，
 * 因此有置顶时间的项目排在最前，其间按置顶时间倒序（后置顶的在前）。
 *
 * 最近打开的项目由 `mostRecentWorkspace` 单独查询：它决定启动时打开哪个项目，
 * 与显示顺序是两个问题，合用一条查询会使列表顺序随切换变化。
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
 * 最近打开的项目。用于确定启动时打开哪个项目，不用于显示顺序。
 *
 * 与 `listWorkspaces` 分开：显示顺序必须稳定，不随切换重排；
 * 上次使用的项目必须按 `last_opened_at` 确定。一条查询同时承担两个职责时，
 * 为记住启动项目，列表顺序也会随切换变化。
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
 * id 不存在或已处于目标状态时返回 false，由调用方返回 404。
 * 与 `removeWorkspace` 的约定相同：静默视为成功时，界面显示已生效，刷新后恢复原状。
 */
export function setWorkspacePinned(store: Store, id: WorkspaceId, pinned: boolean): boolean {
  const sql = pinned
    ? 'UPDATE workspaces SET pinned_at = ? WHERE id = ? AND pinned_at IS NULL'
    : 'UPDATE workspaces SET pinned_at = NULL WHERE id = ? AND pinned_at IS NOT NULL'
  const q = store.db.query(sql)
  return (pinned ? q.run(Date.now(), id) : q.run(id)).changes > 0
}

/**
 * 按路径查找工作区行。不过滤 `removed_at`：已移除的项目也必须能查到。
 *
 * 用途：`upsertWorkspace` 会覆盖名称，而切换项目使用同一个
 * upsert。不先查询时，每次切换都会把用户设置的项目名重置为目录名。
 */
export function getWorkspaceByPath(store: Store, rootPath: string): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE root_path = ?')
    .get(normalizeWorkspaceRoot(rootPath))
  return row ? rowToWorkspace(row) : null
}

export function getWorkspace(store: Store, id: WorkspaceId): Workspace | null {
  const row = store.db
    .query<WorkspaceRow, [string]>('SELECT * FROM workspaces WHERE id = ?')
    .get(id)
  return row ? rowToWorkspace(row) : null
}

/**
 * 项目下的会话数，统计口径与 `listConversations` 完全一致。
 *
 * 只统计用户会话，并排除已归档的会话。两处口径必须一致：卡片显示「111 个任务」
 * 而列表为空时，用户会认为列表出错。
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
 * 将项目从列表中移除，不修改任何数据。
 *
 * 写入 `removed_at` 标记，不执行 `DELETE`。该行必须保留：`conversations.workspace_id` 是
 * `ON DELETE CASCADE`，且 `workspaceOf` 需要 join 该行才能确定会话在哪个根目录下运行；
 * 删除该行后，其会话将无法打开。
 *
 * 因此移除只影响列表中是否显示（`listWorkspaces` 过滤该行），不影响读取
 * （`workspaceOf` / `getWorkspace` 不过滤）。重新添加同一路径即完整恢复：
 * `root_path` 有 UNIQUE 约束，`upsertWorkspace` 命中同一行并清除该标记。
 *
 * `usage_ledger` 不受影响：该表有意不设外键，本月花费不应因项目
 * 从列表中移除而减少（理由见 `schema.ts` 第 3 条迁移）。
 *
 * 返回是否实际改动了一行。id 不存在或已处于移除状态时返回 false，
 * 由调用方返回 404：静默视为成功时，界面显示已移除，刷新后该项目重新出现。
 */
export function removeWorkspace(store: Store, id: WorkspaceId): boolean {
  return (
    store.db
      .query('UPDATE workspaces SET removed_at = ? WHERE id = ? AND removed_at IS NULL')
      .run(Date.now(), id).changes > 0
  )
}

/**
 * 会话运行所在的目录。
 *
 * 本函数是会话根目录的唯一权威。服务进程不得自行持有 `workspaceRoot` 常量
 * （启动时的 `--cwd`）：否则一个进程只能服务一个项目，切换项目必须重启，
 * 且该常量本身就是这两张表的一份缓存。
 *
 * 未查到时返回 `null`，调用方必须停止：回退到默认根目录等于让 A 项目的
 * 会话在 B 项目的目录中运行命令，而工具的路径约束正是以该根目录为边界。
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
    /** 接口名。与 `model` 成对，创建会话时即确定，不交给下游推测。 */
    provider: string
    model: string
    title?: string
    source?: Conversation['source']
    sourceRef?: string
    /** 派发任务创建子会话时必须提供：归属只能在创建时正确写入，事后无法从任何来源推导。 */
    parentConversationId?: ConversationId
    externalSession?: string
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
    parentConversationId: input.parentConversationId ?? null,
    externalSession: input.externalSession ?? null,
    createdAt: now,
    updatedAt: now,
  }
  store.db
    .query(
      `INSERT INTO conversations
       (id, workspace_id, title, provider, model, compaction_manifest, cache_generation, source, source_ref, parent_conversation_id, external_session, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      conv.parentConversationId,
      conv.externalSession,
      now,
      now,
    )
  return conv
}

/** 外部 CLI 子 agent 每次执行后返回的会话句柄，下一次续接时传回给它。 */
export function setConversationExternalSession(
  store: Store,
  id: ConversationId,
  session: string,
): void {
  store.db.query('UPDATE conversations SET external_session = ? WHERE id = ?').run(session, id)
}

/** 该会话派发的子会话，按创建时间排序。没有子会话时返回空数组。 */
export function listChildConversations(store: Store, id: ConversationId): Conversation[] {
  return store.db
    .query<ConversationRow, [string]>(
      'SELECT * FROM conversations WHERE parent_conversation_id = ? ORDER BY created_at',
    )
    .all(id)
    .map(rowToConversation)
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
 * `listConversations` 需要工作区 id，供界面使用：界面始终打开某个工作区。
 * CLI 不同：`qy export` 可能在任意目录下运行，而账本全局只有一份，
 * 用户要导出的会话可能属于其他工作区。要求先切换目录才能列出，
 * 是让使用方式迁就数据模型。
 */
export function listRecentConversations(store: Store, limit = 20): Conversation[] {
  return store.db
    .query<ConversationRow, [number]>(
      // `source IS NULL` 表示用户会话；不列出编排产生的机器会话，
      // 与 listConversations 使用同一判据，不另设 kind 列。
      `SELECT * FROM conversations WHERE source IS NULL
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
    .all(limit)
    .map(rowToConversation)
}

export function listConversations(store: Store, workspaceId: WorkspaceId): Conversation[] {
  return store.db
    .query<ConversationRow, [string]>(
      // 只列出用户会话：编排产生的机器会话不进入会话列表，
      // 由父会话的协作视图展示。
      //
      // 已归档的会话同样不列出（`archived_at IS NULL`）。归档只影响是否显示，
      // `getConversation` 不过滤，按 id 仍可读取。
      //
      // 次级排序键 id DESC 不可省略：同一毫秒创建的会话（批量导入、连续操作）
      // updated_at 相同，只按它排序时 SQLite 按插入顺序返回，结果与预期顺序相反。
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
 * 不是删除：数据不变，只从 `listConversations` 中移除；此后在该项目中
 * 新建的会话照常显示（新行的 `archived_at` 为 NULL）。
 *
 * 与 `runtime/src/archive.ts` 名称相同但用途不同：后者将会话导出为 markdown / json。
 *
 * 只归档用户会话（`source IS NULL`）：机器会话不在列表中，
 * 为其写入标记等于向没有读取方的字段写值。
 *
 * 返回归档的条数。已归档的会话不重复计数（由 `archived_at IS NULL` 限定），
 * 界面据此显示「归档了 N 条」而不是「操作成功」。
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
 * 归档一条会话：只写入标记，数据不变。`listConversations` 不再列出该会话，
 * `getConversation` 按 id 仍可读取。返回 false 表示会话不存在或已归档。
 */
export function archiveConversation(store: Store, id: ConversationId): boolean {
  return (
    store.db
      .query('UPDATE conversations SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      .run(Date.now(), id).changes > 0
  )
}

/**
 * 永久删除一条会话。消息、run、步骤、provider 请求等经外键级联一并删除
 * （`schema.ts` 各表的 `ON DELETE CASCADE`）。
 *
 * 附件目录不在此处删除：它位于磁盘而不在数据库中，由 `api/conversations.ts` 的 DELETE
 * 分支随后删除。该分支只删除本会话的目录，不按 `Attachment.path` 逐条删除：
 * 路径型附件指向用户自己的文件。
 *
 * 调用方必须先确认没有运行中的 run：运行中的轮次仍在向级联删除的行写入。
 */
export function deleteConversation(store: Store, id: ConversationId): boolean {
  return store.db.query('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
}

/**
 * 重命名。不修改 `updated_at`：改名不属于内容更新，推进该值会使列表重排，
 * 侧栏显示的时间与实际内容更新时间不一致。返回 null 表示会话不存在，或指定了 `onlyIfEmpty` 而标题非空。
 *
 * `onlyIfEmpty` 供自动生成标题使用：标题是否为空在写入的同一条语句中判断。不要改成调用方先读后写：
 * 读写之间用户修改的名称会被自动标题覆盖。
 */
export function setConversationTitle(
  store: Store,
  id: ConversationId,
  title: string,
  opts: { onlyIfEmpty?: boolean } = {},
): Conversation | null {
  const changed = store.db
    .query(
      `UPDATE conversations SET title = ? WHERE id = ?${opts.onlyIfEmpty ? " AND title = ''" : ''}`,
    )
    .run(title, id)
  if (changed.changes === 0) return null
  return getConversation(store, id)
}

/**
 * 切换会话的「接口 × 模型」。
 *
 * 模型是会话级属性，不是全局配置项：同一工作区中一个会话用 Opus 修改代码、
 * 另一个用 Haiku 快速问答是常见用法。本写入路径不可缺少：缺少时
 * `conversation.setModel` 是一个静默返回的空分支，界面显示切换成功，而每一轮
 * 仍使用配置文件中的模型，界面却按新模型的价目表显示费用。
 *
 * 两列同时写入。只写 `model` 时，若同一模型 id 属于两个接口，
 * 会话归属取决于枚举顺序，出错时端点、key、价目表一并更换且不报错。
 *
 * 返回 null 表示会话不存在（客户端持有的 id 已过期）。
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
 * 只修改 conversations.compaction_manifest 一列，Message / Step / 正文库均不修改。
 * 压缩是投影而不是销毁：历史面板始终显示完整会话，压缩可撤销、可重放。
 * 若实现为删除旧消息并替换为摘要，用户翻阅历史时前面的对话将缺失。
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
    /** 缺失表示用户本人发送，写入 NULL。见 `Message.origin`。 */
    origin?: 'subagent' | 'workflow'
  },
): Message {
  const msg: Message = {
    id: newMessageId(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    attachments: input.attachments ?? [],
    origin: input.origin ?? null,
    createdAt: Date.now(),
  }
  store.db
    .query(
      'INSERT INTO messages (id, conversation_id, role, content, attachments, origin, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      msg.id,
      msg.conversationId,
      msg.role,
      msg.content,
      writeJson(msg.attachments),
      msg.origin,
      msg.createdAt,
    )
  /*
   * 会话的最近修改时间随消息推进，这是它唯一因内容而推进的位置：该表只有
   * user 行（assistant 的回合由 steps 投影），因此每条新消息都经过此处。
   * 不推进时，列表排序与侧栏时间都停留在会话创建时刻。
   */
  store.db
    .query('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(msg.createdAt, msg.conversationId)
  return msg
}

/**
 * 记录会话读取某个文件时的内容哈希，供写入前的新鲜度校验使用。
 *
 * 同一文件重复读取时只保留最近一次：校验判断的是已读取的内容是否仍与磁盘一致，
 * 旧哈希对此没有作用，保留只会使该表无谓增长。
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

/** 会话读取该文件时的内容哈希；未读取过时返回 null。 */
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
 * `upperBound` 是 run 创建时固定的消息上界：执行锁在 run 创建之后才取得，
 * 排队期间用户可能又发送了消息，这些消息不属于本 run 的历史，
 * 纳入后模型会看到本轮之后才发送的消息。
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

/**
 * 为界面读取一页完整的用户轮次。
 *
 * 不要改为分别读取 messages、runs 并为每个 run 读取一次 steps：请求数随轮数线性增长，
 * 浏览器需等待全部请求、解析全部 JSON 并一次挂载整棵 DOM。分页边界与批量读取
 * 由账本层负责：一页只选 `limit` 条用户消息，再一次取齐它们的 run 与 steps。模型重建历史仍使用无分页的 `listMessages` / `buildHistory`，不受影响。
 */
export function listConversationHistoryPage(
  store: Store,
  conversationId: ConversationId,
  input: { before?: MessageId | null; limit: number },
): ConversationHistoryPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)))
  const before = input.before ?? null
  const rows = before
    ? store.db
        .query<MessageRow, [string, string, number]>(
          `SELECT * FROM messages
           WHERE conversation_id = ? AND id < ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(conversationId, before, limit + 1)
    : store.db
        .query<MessageRow, [string, number]>(
          `SELECT * FROM messages
           WHERE conversation_id = ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(conversationId, limit + 1)

  const hasMore = rows.length > limit
  const selected = rows.slice(0, limit)
  const oldest = selected.at(-1)?.id ?? null
  if (!oldest) {
    return {
      messages: [],
      runs: [],
      steps: [],
      todos: latestTodos(store, conversationId) ?? [],
      workflowStarts: [],
      nextCursor: null,
    }
  }

  const messages = selected.toReversed().map(rowToMessage)

  const userIds = selected.map((row) => row.id)
  const marks = userIds.map(() => '?').join(',')
  const runs = store.db
    .query<RunRow, string[]>(
      `SELECT * FROM runs
       WHERE conversation_id = ? AND user_message_id IN (${marks})
       ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId, ...userIds)
    .map(rowToRun)

  const runIds = runs.map((run) => run.id)
  const steps = runIds.length
    ? store.db
        .query<StepRow, string[]>(
          `SELECT s.* FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.run_id IN (${runIds.map(() => '?').join(',')})
           ORDER BY r.created_at ASC, r.id ASC, s.seq ASC`,
        )
        .all(...runIds)
        .map(rowToStep)
    : []

  // 续接调用引用的首次调用不在本页时一并读取：图结构只记录在首次调用的参数中。只读取本会话的 step。
  const inPage = new Set<string>(steps.map((step) => step.id))
  const wanted = new Set<string>()
  for (const step of steps) {
    if (step.toolName !== 'workflow') continue
    const payload = step.payload
    const workflowId =
      payload?.kind === 'tool_call' || payload?.kind === 'tool_result'
        ? payload.args?.workflowId
        : undefined
    if (typeof workflowId === 'string' && workflowId && !inPage.has(workflowId)) {
      wanted.add(workflowId)
    }
  }
  const workflowStarts = [...wanted].flatMap((id) => {
    const row = store.db
      .query<StepRow, [string, string]>(
        `SELECT s.* FROM steps s JOIN runs r ON r.id = s.run_id
         WHERE s.id = ? AND r.conversation_id = ?`,
      )
      .get(id, conversationId)
    return row ? [rowToStep(row)] : []
  })

  return {
    messages,
    runs,
    steps,
    // 与 tools/runtime 读取待办使用同一账本投影；不属于分页结果。
    todos: latestTodos(store, conversationId) ?? [],
    workflowStarts,
    nextCursor: hasMore ? (oldest as MessageId) : null,
  }
}

/**
 * 变更面板的一页：该会话中写入过文件的轮次，最新的在前。
 *
 * 与历史页分开：历史页按完整用户轮次切分，一页中可能没有任何文件写入，面板若用它翻页
 * 会把整段会话流一并加载到主区。此处只选取有写入的用户消息；游标与历史页相同，
 * 为用户消息 id，作为排他上界。
 *
 * 一轮的写入有三个来源，返回同一形状（`ConversationChangeStep`）：
 * - 本会话 step 的 `outcome.fileChanges`；
 * - 内置子 agent 在子会话中的 step：子会话的 run 建行时记录了 `dispatch_step_id`（父会话中
 *   派发任务卡的 step），据此归入父轮次。这是创建 run 时写入的事实，不是按时间推断的；
 * - 外部 CLI 节点：父 step 的 `nodes[*].fileChanges`，由观察器提供，不含行数。
 *
 * `totals` 是整条会话的合计：三个来源合并计算，按轮次分别折叠后再相加。界面中的各行
 * 使用同一个 `foldFileChanges`，两处各自折叠时表头与行不一致。
 */
export function listConversationChangesPage(
  store: Store,
  conversationId: ConversationId,
  input: { before?: MessageId | null; limit: number },
): ConversationChangesPageResponse {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)))
  const before = input.before ?? null
  type Params = Record<string, string | number>
  const base: Params = { $conv: conversationId, $now: Date.now() }
  const rows = <T>(sql: string, extra: Params = {}): T[] =>
    store.db.query<T, [Params]>(sql).all({ ...base, ...extra })

  // 三个来源的写入清单，不含 args。`delegated` 按子会话 run 上的 `dispatch_step_id` 归入父轮次；
  // 名称取子会话标题，与派发任务卡上对应节点的 label 同源。
  const cte = `
    WITH own AS (
      SELECT r.user_message_id AS turn_id, s.id AS step_id
      FROM runs r JOIN steps s ON s.run_id = r.id
      WHERE r.conversation_id = $conv AND r.user_message_id IS NOT NULL
        AND json_array_length(json_extract(s.payload, '$.outcome.fileChanges')) > 0
    ),
    nodes AS (
      SELECT r.user_message_id AS turn_id, s.id AS step_id, s.created_at AS at,
             coalesce(s.duration_ms, r.finished_at - s.created_at, $now - s.created_at) AS duration,
             n.key AS node_id,
             json_extract(n.value, '$.subagentId') AS subagent_id,
             json_extract(n.value, '$.label') AS label,
             coalesce(json_array_length(json_extract(n.value, '$.fileChanges')), 0) AS cli_writes
      FROM runs r
      JOIN steps s ON s.run_id = r.id AND s.payload IS NOT NULL
        AND json_type(s.payload, '$.nodes') = 'object'
      JOIN json_each(s.payload, '$.nodes') n
      WHERE r.conversation_id = $conv AND r.user_message_id IS NOT NULL
    ),
    delegated AS (
      SELECT r.user_message_id AS turn_id, cs.id AS step_id,
             (SELECT title FROM conversations WHERE id = cr.conversation_id) AS label
      FROM runs r
      JOIN steps s ON s.run_id = r.id
      JOIN runs cr ON cr.dispatch_step_id = s.id
      JOIN steps cs ON cs.run_id = cr.id
      WHERE r.conversation_id = $conv AND r.user_message_id IS NOT NULL
        AND json_array_length(json_extract(cs.payload, '$.outcome.fileChanges')) > 0
    )`

  type TurnRow = Pick<MessageRow, 'id' | 'content' | 'origin' | 'created_at'>
  const turnRows = rows<TurnRow>(
    `${cte}
     SELECT m.id, m.content, m.origin, m.created_at FROM messages m
     WHERE m.conversation_id = $conv ${before ? 'AND m.id < $before' : ''}
       AND (EXISTS (SELECT 1 FROM own WHERE own.turn_id = m.id)
         OR EXISTS (SELECT 1 FROM delegated WHERE delegated.turn_id = m.id)
         OR EXISTS (SELECT 1 FROM nodes WHERE nodes.turn_id = m.id AND nodes.cli_writes > 0))
     ORDER BY m.id DESC LIMIT $limit`,
    { $limit: limit + 1, ...(before ? { $before: before } : {}) },
  )

  /*
   * 整条会话的合计，按轮次折叠后再相加：同一路径在一轮中创建后又删除时不应计入
   * （`foldFileChanges`），而这一判断只在同一轮次的范围内成立。
   *
   * 三个来源与选取轮次使用同一套 CTE；排序取 `steps.rowid`：三条支路都取自该表，
   * rowid 即写入顺序，而折叠只依赖先后顺序。选取轮次与合计只读取 fileChange 的四个字段，
   * 不把 args（整份文件内容）读入内存。
   */
  const totalRows = rows<{
    turn_id: string
    path: string
    change_type: FileChange['changeType']
    additions: number | null
    deletions: number | null
  }>(
    `${cte}
     SELECT turn_id, path, change_type, additions, deletions FROM (
       SELECT own.turn_id AS turn_id, json_extract(c.value, '$.path') AS path,
              json_extract(c.value, '$.changeType') AS change_type,
              json_extract(c.value, '$.additions') AS additions,
              json_extract(c.value, '$.deletions') AS deletions, s.rowid AS ord
       FROM own JOIN steps s ON s.id = own.step_id
       JOIN json_each(s.payload, '$.outcome.fileChanges') c
       UNION ALL
       SELECT delegated.turn_id, json_extract(c.value, '$.path'),
              json_extract(c.value, '$.changeType'), json_extract(c.value, '$.additions'),
              json_extract(c.value, '$.deletions'), cs.rowid
       FROM delegated JOIN steps cs ON cs.id = delegated.step_id
       JOIN json_each(cs.payload, '$.outcome.fileChanges') c
       UNION ALL
       SELECT nodes.turn_id, json_extract(c.value, '$.path'),
              json_extract(c.value, '$.changeType'), json_extract(c.value, '$.additions'),
              json_extract(c.value, '$.deletions'), s.rowid
       FROM nodes JOIN steps s ON s.id = nodes.step_id
       JOIN json_each(s.payload, '$.nodes') n ON n.key = nodes.node_id
       JOIN json_each(n.value, '$.fileChanges') c
       WHERE nodes.cli_writes > 0
     ) WHERE path IS NOT NULL ORDER BY turn_id, ord`,
  )
  const perTurn = new Map<string, FileChange[]>()
  for (const row of totalRows) {
    const list = perTurn.get(row.turn_id) ?? []
    list.push({
      path: row.path,
      changeType: row.change_type,
      ...(row.additions === null ? {} : { additions: row.additions }),
      ...(row.deletions === null ? {} : { deletions: row.deletions }),
    })
    perTurn.set(row.turn_id, list)
  }
  const totals = { paths: [] as string[], additions: 0, deletions: 0 }
  for (const list of perTurn.values()) {
    for (const folded of foldFileChanges(list)) {
      if (!totals.paths.includes(folded.path)) totals.paths.push(folded.path)
      totals.additions += folded.additions
      totals.deletions += folded.deletions
    }
  }

  const hasMore = turnRows.length > limit
  const selected = turnRows.slice(0, limit)
  if (selected.length === 0) return { turns: [], totals, nextCursor: null }
  const ids = JSON.stringify(selected.map((row) => row.id))
  const inSelected = 'IN (SELECT value FROM json_each($ids))'

  interface WriteRow {
    turn_id: string
    id: string
    tool_name: string | null
    payload: string | null
    at: number
    seq: number
    label: string | null
    via: 0 | 1
  }
  const writeRows = [
    ...rows<WriteRow>(
      `${cte}
       SELECT own.turn_id, s.id, s.tool_name, s.payload, s.created_at AS at, s.seq, NULL AS label, 0 AS via
       FROM own JOIN steps s ON s.id = own.step_id WHERE own.turn_id ${inSelected}`,
      { $ids: ids },
    ),
    ...rows<WriteRow>(
      `${cte}
       SELECT d.turn_id, cs.id, cs.tool_name, cs.payload, cs.created_at AS at, cs.seq, d.label, 1 AS via
       FROM delegated d JOIN steps cs ON cs.id = d.step_id WHERE d.turn_id ${inSelected}`,
      { $ids: ids },
    ),
  ]
  interface CliRow {
    turn_id: string
    step_id: string
    node_id: string
    label: string | null
    at: number
    duration: number
    changes: string
  }
  const cliRows = rows<CliRow>(
    `${cte}
     SELECT nodes.turn_id, nodes.step_id, nodes.node_id, nodes.label, nodes.at, nodes.duration,
            json_extract(n.value, '$.fileChanges') AS changes
     FROM nodes JOIN steps s ON s.id = nodes.step_id
     JOIN json_each(s.payload, '$.nodes') n ON n.key = nodes.node_id
     WHERE nodes.cli_writes > 0 AND nodes.turn_id ${inSelected}`,
    { $ids: ids },
  )

  const byTurn = new Map<string, { at: number; seq: number; step: ConversationChangeStep }[]>()
  const push = (turnId: string, at: number, seq: number, step: ConversationChangeStep) => {
    const list = byTurn.get(turnId) ?? []
    list.push({ at, seq, step })
    byTurn.set(turnId, list)
  }
  for (const row of writeRows) {
    const payload = readJson<Step['payload']>(row.payload, null)
    if (payload?.kind !== 'tool_result' || !payload.outcome.fileChanges?.length) continue
    push(row.turn_id, row.at, row.seq, {
      id: row.id,
      toolName: row.tool_name ?? '',
      ...(payload.args ? { args: payload.args } : {}),
      fileChanges: payload.outcome.fileChanges,
      via: row.via ? { name: row.label ?? '' } : null,
    })
  }
  for (const row of cliRows) {
    // 按派发 step 结束的时刻排序；同一毫秒内排在子会话的写入之后。
    push(row.turn_id, row.at + row.duration, Number.MAX_SAFE_INTEGER, {
      id: `${row.step_id}:${row.node_id}`,
      toolName: 'cli',
      fileChanges: readJson<FileChange[]>(row.changes, []),
      via: { name: row.label ?? '' },
    })
  }

  return {
    turns: selected.map((row) => ({
      userMessageId: row.id as MessageId,
      text: row.content,
      origin: row.origin,
      createdAt: row.created_at,
      steps: (byTurn.get(row.id) ?? [])
        .sort((a, b) => a.at - b.at || a.seq - b.seq)
        .map((entry) => entry.step),
    })),
    totals,
    nextCursor: hasMore ? (selected.at(-1)?.id as MessageId) : null,
  }
}

// ─────────────────────────────── Run ───────────────────────────────

/** 同一会话的轮次被另一个仍在运行的进程占用。 */
export class ConversationBusyError extends Error {
  constructor(readonly holder: { runId: RunId; ownerPid: number; ownerKind: RunOwner | null }) {
    const where =
      holder.ownerKind === 'serve'
        ? '桌面端'
        : holder.ownerKind === 'cli'
          ? '终端的 qy 中'
          : '另一个进程中'
    super(`该会话已在${where}执行（pid ${holder.ownerPid}），请先在该处中断`)
    this.name = 'ConversationBusyError'
  }
}

/**
 * 创建一轮。会话当前能否开始新一轮的跨进程判定只在此处进行：服务端与 CLI 的每一轮、
 * 压缩轮都经过本函数。
 *
 * 在同一个 IMMEDIATE 事务中先查询该会话是否有其他进程占用的 running / queued 行，
 * 有则抛出 `ConversationBusyError`，不插入。占用即 `isOrphan` 判定为不可回收：
 * 该进程仍存在且心跳未过期，与崩溃回收使用同一判据。进程崩溃（pid 不存在）或停滞（心跳停止）
 * 都不算占用，因此不会永久锁死。本进程自身的行由 `isOrphan` 排除：本进程内的并发由
 * 服务端的 `RunManager` 在同步块中拦截，CLI 一个进程同时只运行一轮。
 *
 * 不要把查询移到事务外：两个进程会同时查询到无人占用，各自创建一轮。
 */
export function createRun(
  store: Store,
  input: {
    conversationId: ConversationId
    workspaceId: WorkspaceId
    model: string
    clientRequestId: string
    userMessageId: MessageId | null
    messageIdUpperBound: MessageId | null
    contextSnapshot: RunContextSegment[]
    /** 由派发任务产生的轮次携带来源；用户会话不携带。 */
    dispatch?: { stepId: StepId; nodeId: string }
  },
): Run {
  return store.tx(() => {
    const holder = liveHolder(store, input.conversationId)
    if (holder) throw new ConversationBusyError(holder)
    return insertRun(store, input)
  })
}

/** 该会话被其他进程占用的轮次；没有时返回 null。判据见 `createRun`。 */
function liveHolder(
  store: Store,
  conversationId: ConversationId,
): ConversationBusyError['holder'] | null {
  const rows = store.db
    .query<
      {
        id: RunId
        owner_pid: number | null
        owner_kind: string | null
        heartbeat_at: number | null
      },
      [string]
    >(
      `SELECT id, owner_pid, owner_kind, heartbeat_at FROM runs
       WHERE conversation_id = ? AND status IN ('running','queued')`,
    )
    .all(conversationId)
  const held = rows.find((r) => !isOrphan(r.owner_pid, r.heartbeat_at))
  if (!held) return null
  const kind = held.owner_kind
  return {
    runId: held.id,
    ownerPid: Number(held.owner_pid),
    ownerKind: kind === 'serve' || kind === 'cli' ? kind : null,
  }
}

function insertRun(store: Store, input: Parameters<typeof createRun>[1]): Run {
  const now = Date.now()
  const run: Run = {
    id: newRunId(),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userMessageId: input.userMessageId,
    messageIdUpperBound: input.messageIdUpperBound,
    model: input.model,
    clientRequestId: input.clientRequestId,
    dispatchStepId: input.dispatch?.stepId ?? null,
    dispatchNodeId: input.dispatch?.nodeId ?? null,
    status: 'queued',
    stopReason: null,
    usage: { ...EMPTY_USAGE },
    stepCount: 0,
    errorMessage: null,
    errorCode: null,
    interruption: null,
    createdAt: now,
    finishedAt: null,
  }
  store.db
    .query(
      `INSERT INTO runs
       (id, conversation_id, workspace_id, user_message_id, message_id_upper_bound,
        model, client_request_id, status, stop_reason, input_tokens, output_tokens, cached_tokens,
         cache_write_tokens, reasoning_tokens, cost, currency, usage_turns, step_count, error_message, error_code,
         context_snapshot, created_at, finished_at, owner_pid, owner_kind, heartbeat_at, dispatch_step_id, dispatch_node_id)
        VALUES (?,?,?,?,?,?,?,?,?,0,0,NULL,NULL,0,0,'USD','[]',0,NULL,NULL,?,?,NULL,?,?,?,?,?)`,
    )
    .run(
      run.id,
      run.conversationId,
      run.workspaceId,
      run.userMessageId,
      run.messageIdUpperBound,
      run.model,
      run.clientRequestId,
      run.status,
      null,
      writeJson(input.contextSnapshot),
      now,
      // 归属在建行时即写入。若延后到开始执行之后补写，createRun 后立即崩溃留下的
      // 无归属行仍会被下一个进程按无归属规则回收，结果正确；
      // 但同一条路径上会多出一段判据不同的时间窗口。
      process.pid,
      store.owner,
      now,
      run.dispatchStepId,
      run.dispatchNodeId,
    )
  return run
}

/**
 * 心跳：告知其他进程该轮仍有进程在运行。
 *
 * 只更新 running 的行：已进入终态的 run 更新心跳没有意义，
 * 且会使「心跳未过期即仍在运行」这一判断在事后不成立。
 */
export function touchRun(store: Store, id: RunId): void {
  store.db
    .query("UPDATE runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .run(Date.now(), id)
}

/** 幂等：同一 (conversationId, clientRequestId) 已有 run 时直接返回该 run。 */
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

/** 整份写入本轮的生成花费。只由会话层在每次生成成功时调用，与模型用量分列，两者互不覆盖。 */
export function updateRunMedia(store: Store, id: RunId, media: MediaSpend[]): void {
  store.db.query('UPDATE runs SET media_usage = ? WHERE id = ?').run(JSON.stringify(media), id)
}

/** 没有生成时不含 `media` 键，与 `RunUsage.media` 的约定一致。 */
function mediaOf(raw: string): { media?: MediaSpend[] } {
  const media = readJson<MediaSpend[]>(raw, [])
  return media.length ? { media } : {}
}

/**
 * Run 收尾。stopReason 必填：不允许没有原因的 done，前端必须能向用户说明
 * 停止原因，不能只显示一个完成标记。
 */
export function finishRun(
  store: Store,
  id: RunId,
  input: {
    status: 'done' | 'failed' | 'interrupted'
    stopReason: StopReason
    errorMessage?: string | null
    errorCode?: string | null
    interruption?: RunInterruption | null
  },
): void {
  store.tx(() => {
    store.db
      .query(
        `UPDATE runs SET status = ?, stop_reason = ?,
       error_message = ?, error_code = ?, interruption_detail = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        input.status,
        input.stopReason,
        input.errorMessage ?? null,
        input.errorCode ?? null,
        input.interruption ? writeJson(input.interruption) : null,
        Date.now(),
        id,
      )
    // 调用方关闭生成器时同样必须结算请求记录，不等到下次启动时误记为进程退出。
    const diagnostic: ProviderRequestDiagnostic = {
      causes: [
        {
          name: 'RunEnded',
          code: input.stopReason,
          message: '所属轮次已结束，未收到该请求的完整终态；sentAt 为空表示未交给发送阶段。',
        },
      ],
      providerEvents: null,
      silentMs: null,
      transport: null,
      assistantChars: null,
      toolCallCount: null,
      retry: { decision: 'run_ended', attempt: null, max: 0, backoffMs: null, at: null },
    }
    store.db
      .query(
        "UPDATE provider_requests SET status = 'uncertain', completed_at = COALESCE(completed_at, ?), diagnostic = COALESCE(diagnostic, ?) WHERE run_id = ? AND status IN ('pending','in_flight')",
      )
      .run(Date.now(), writeJson(diagnostic), id)
  })
}

export interface ProcessExitObservation {
  source: 'desktop_sidecar'
  observedAt: number
  exitKind: 'terminated' | 'output_channel_closed'
  exitCode: number | null
  signal: number | null
  stderrTail: string | null
}

/**
 * 启动时回收上次进程留下的 running / queued run。
 *
 * 不能依赖进程内的 finally：`finally` 只在生成器正常关闭时执行，
 * SIGKILL、断电、Tauri 外壳崩溃时不会执行。遗留的 running run 会使
 * 会话始终显示「执行中」，且 `isBusy` 判定会拒绝用户发送新消息，会话被永久锁死。
 *
 * 分流依据是 step 的 `execution_started_at`（ARCHITECTURE.md 第 6 节的歧义边界），
 * 不是 run 上的字段：
 *
 * - 存在 `execution_started_at` 非空而 status 仍为 running 的 step：
 *   已进入执行器但未进入终态。该工具可能已执行完毕并产生副作用，
 *   也可能刚进入就崩溃，两者无法区分，因此整轮结果不可信。
 * - 不存在这样的 step：所有工具要么未开始，要么已有确定结果，本轮没有未知副作用。
 *
 * 两者都标记为终态，区别在 `stopReason`。不要为了界面简洁统一写成 user_interrupt：
 * 否则事后无法区分进程崩溃与用户停止。
 *
 * 判据只有一个：steps 表中带 `execution_started_at` 的 running 行。
 * 不要为 `runs` 另加 `execution_state` 等列：以没有写入方的列作为判据，
 * 会使所有 run 都被判定为可安全重放，即最危险的方向。
 *
 * 只回收无进程运行的 run，不能扫描全库：账本是共享的，一台机器上同时有多个写入者（两个工作
 * 区的 sidecar、开发态热重载、终端中的 `qy exec`），扫描全库会使后启动的进程把其他进程正在运行的轮次
 * 判定为中断。判据见 `isOrphan`，两个信号缺一不可。
 */
export function recoverStaleRuns(
  store: Store,
  previousExit?: ProcessExitObservation,
): {
  recovered: number
  ambiguous: number
  /** 有归属且归属进程仍在运行、本次跳过的 run 数。启动日志必须输出该数，否则「回收了 0 个」有歧义。 */
  heldByOthers: number
} {
  // 该查询取的是投影而不是表行：列名经过重命名，`ambiguous` 是计算列，
  // 因此行类型就地声明，不复用表的行类型。
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

  // 不能在此处提前返回。下方还有一次针对终态 run 下孤儿 step 的扫描，
  // 该扫描与本次是否有遗留 run 无关，最常见的情形正是
  // run 均已进入终态而其下仍有 running step。提前返回会使该扫描不执行。
  let ambiguous = 0
  const now = Date.now()
  const finishStmt = store.db.query(
    `UPDATE runs SET status = 'interrupted', stop_reason = ?, error_code = ?, error_message = ?,
     interruption_detail = ?, finished_at = ? WHERE id = ?`,
  )

  // 使用 `store.tx()` 而不是 `db.transaction`：此段先 SELECT 再 UPDATE，DEFERRED 事务
  // 在其他进程持有写锁时需从读事务升级，SQLite 直接返回 SQLITE_BUSY 且不经过 busy_timeout。
  // 两个实例同时启动是正常情形（两个工作区的 sidecar、开发态热重载）。
  store.tx(() => {
    for (const r of rows) {
      const isAmbiguous = Number(r.ambiguous) === 1
      if (isAmbiguous) ambiguous++
      settleRunningSteps(store, r.id)
      interruptRunningNodes(store, r.id)
      /*
       * 进程退出时已发出的 provider 请求，送达与计费都无法确认。run 收尾时必须
       * 同步写为 uncertain；保持 in_flight 会使账本始终显示后台仍在执行。
       * usage 保持原样（通常为 NULL），不得补 0 或用上一条回报填充。
       */
      const interruption: RunInterruption = {
        source: previousExit?.source ?? 'orphan_recovery',
        observedAt: previousExit?.observedAt ?? now,
        recordedAt: now,
        ownerPid: r.ownerPid,
        lastHeartbeatAt: r.heartbeatAt,
        ...(previousExit
          ? {
              exitKind: previousExit.exitKind,
              exitCode: previousExit.exitCode,
              signal: previousExit.signal,
              stderrTail: previousExit.stderrTail,
            }
          : {}),
        ambiguousToolExecution: isAmbiguous,
      }
      const requestDiagnostic: ProviderRequestDiagnostic = {
        causes: [],
        providerEvents: null,
        silentMs: null,
        transport: null,
        assistantChars: null,
        toolCallCount: null,
        // 进程已退出，不存在剩余重发次数；0 表示恢复流程不发送请求。
        retry: { decision: 'process_exit', attempt: null, max: 0, backoffMs: null, at: null },
      }
      store.db
        .query(
          `UPDATE provider_requests
           SET status = 'uncertain', completed_at = COALESCE(completed_at, ?),
               diagnostic = COALESCE(diagnostic, ?)
           WHERE run_id = ? AND status IN ('pending','in_flight')`,
        )
        .run(now, writeJson(requestDiagnostic), r.id)
      finishStmt.run(
        // 无歧义的情形写 `process_exit`，不写 `user_interrupt`：写成 user_interrupt 后
        // 事后无法区分进程崩溃与用户停止，
        // 界面只显示「已中断」，而用户并未停止。
        isAmbiguous ? 'internal_guard' : 'process_exit',
        isAmbiguous ? 'internal_error' : null,
        // 无歧义的情形不能写「本轮未开始执行」：判据只说明没有工具停留在执行中，
        // 已执行几十步、恰好在等待模型回复时中断的 run 同样满足该判据。
        isAmbiguous
          ? previousExit?.exitCode !== null && previousExit?.exitCode !== undefined
            ? `服务进程在工具执行期间退出（exit code ${previousExit.exitCode}），结果不可信`
            : '服务进程在工具执行期间退出，结果不可信'
          : previousExit?.exitCode !== null && previousExit?.exitCode !== undefined
            ? `服务进程退出（exit code ${previousExit.exitCode}），本轮中断`
            : '服务进程退出，本轮中断',
        writeJson(interruption),
        now,
        r.id,
      )
    }

    // 终态 run 下同样可能遗留孤儿 step。上方的扫描按 run 状态选取，不包含这些 step。
    //
    // 产生路径：生成器在 `tool.started` 的 yield 处被 `.return()` 终止
    // （客户端断开、用户切换会话），step 已由 openToolStep 写为 running 但无人收尾；
    // 随后 session 的 finally 把 run 标记为 interrupted 终态。因此该 step
    // 不会进入恢复流程，在库中永久保持 running。
    //
    // 影响不限于界面上一张持续显示加载状态的卡片：历史投影必须跳过含未终结调用的整个
    // batch（provider 要求每个 tool call 有配对结果），一条孤儿 step 会使同一批次中
    // 已成功的写文件结果一并从历史中移除，中断过的轮次在跨轮记忆中
    // 因此缺失这些结果。
    //
    // 派发任务卡上未进入终态的节点同理，且没有对应的 running step：派发后立即返回，
    // 子 agent 的生命周期与会话一致，其终态写在一张早已返回的卡上。重启之后
    // 进程中已无接收方处理该回执，节点停留在「进行中」时，该图既无法 approve
    // 也无法 revise。
    const orphanRuns = store.db
      .query<{ run_id: string }, []>(
        `SELECT DISTINCT s.run_id AS run_id FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.status NOT IN ('running','queued')
           AND (s.status = 'running'
                OR (json_type(s.payload, '$.nodes') = 'object'
                    AND EXISTS (
                      SELECT 1 FROM json_each(s.payload, '$.nodes') n
                      WHERE json_extract(n.value, '$.phase')
                            NOT IN ('done','failed','skipped','interrupted')
                    )))`,
      )
      .all()
    for (const o of orphanRuns) {
      settleRunningSteps(store, o.run_id as RunId)
      interruptRunningNodes(store, o.run_id as RunId)
    }

    // 与上方的孤儿 step 同理：账本中可能存在 run 已收尾而已发送请求未写入终态的记录。
    // 终态 run 不可能合法地持有 in_flight 请求，只能按送达未知写为 uncertain。
    const orphanRequestDiagnostic: ProviderRequestDiagnostic = {
      causes: [],
      providerEvents: null,
      silentMs: null,
      transport: null,
      assistantChars: null,
      toolCallCount: null,
      retry: { decision: 'run_ended', attempt: null, max: 0, backoffMs: null, at: null },
    }
    store.db
      .query(
        `UPDATE provider_requests SET status = 'uncertain', completed_at = COALESCE(completed_at, ?),
             diagnostic = COALESCE(diagnostic, ?)
         WHERE status IN ('pending','in_flight')
           AND run_id IN (SELECT id FROM runs WHERE status NOT IN ('running','queued'))`,
      )
      .run(now, writeJson(orphanRequestDiagnostic))
  })

  return { recovered: rows.length, ambiguous, heldByOthers }
}

/** 心跳超过该时长未更新时，视为对应进程已不再运行该 run。心跳间隔为十秒，此值留六倍余量。 */
const HEARTBEAT_STALE_MS = 60_000

/**
 * 该 run 是否仍有进程在运行。
 *
 * 四条判据的顺序不可调换，每一条覆盖前一条的遗漏：
 *
 * 1. 没有归属：迁移之前的历史行。按原有规则回收，不能因无法识别而跳过。
 * 2. 归属是本进程的 pid：本进程刚启动，不可能拥有任何 run，因此该行必然是
 *    上一个进程留下的，且 Windows 把同一个 pid 复用给了本进程。本条必须在心跳判据之前：
 *    崩溃后立即重启时心跳只过去两三秒，按超时判定会认为它仍在运行，
 *    该 run 因此无人回收，会话被永久锁死。
 * 3. 该 pid 已不存在：进程已退出，回收。这是本函数的基本用途，不能弱化。
 *    `EPERM` 视为存活：宁可晚一分钟由心跳判据回收，也不误回收确实在运行的 run。
 * 4. pid 仍存在但心跳停止：pid 被复用，或该进程仍在但该轮已废弃。
 *
 * pid 判据只会因 pid 复用而误判，心跳判据只会因崩溃后立即重启而误判，因此两者都必须保留。
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
 * 将一个 run 下所有仍为 running 的 step 写为终态。
 *
 * 分两种情形处理，不能合并。判据是 `execution_started_at`，即崩溃恢复的歧义边界：
 *
 * - 非空：已进入执行器。工具可能已执行完毕并产生副作用，也可能刚进入就崩溃，
 *   两者无法区分。因此写 `executed: true`（保守假设已执行）与「结果未知」。
 *   向模型断言未执行等于让它重做；若该工具是 `write_file` 或 `run_command`，
 *   会产生重复副作用。
 * - 为空：未进入执行器。这是确定未发生的事，如实标记 `executed: false`。
 *   同样写成「结果未知」会使模型在每次中断后都用一轮核实所有工具，
 *   包括明显未执行的工具。
 *
 * 两种情形必须分别 UPDATE：用同一份 payload 一并覆盖时，「确定未执行」会被记为
 * 「可能执行过」。
 *
 * 只写入 outcome，不得整份替换 payload。两条语句都使用 `json_set`，只修改 `$.kind` 与 `$.outcome`；
 * `$.action` 与 `$.args` 保持不变。`action` 是前端唯一的标题来源（它由 ToolSpec 按参数
 * 解析，前端无法推测）；整份 payload 替换为只含 outcome 的对象后，该 step 在会话流中
 * 只显示一个红色的「失败」，没有动词、对象与目标，用户无法判断中断发生在哪一步。
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

/**
 * 将该轮派发任务卡上未进入终态的节点标记为中断，返回改动过的节点。
 *
 * 不在 run 收尾时调用。子 agent 的生命周期与会话一致，不随派发它的轮次结束：
 * 收尾时扫描会把仍在运行的节点记为中断，而其回执几分钟后才到达。
 * 调用点只有两处：用户停止会话，以及重启回收（进程中已无接收方处理这些回执）。
 *
 * 不限于仍为 running 的卡：派发后立即返回，节点的终态写在一张已返回的卡上。
 */
export function interruptRunningNodes(
  store: Store,
  runId: RunId,
): { stepId: string; nodeId: string; state: NodeState }[] {
  const cards = store.db
    .query<{ id: string; payload: string }, [string]>(
      `SELECT id, payload FROM steps
       WHERE run_id = ? AND json_type(payload, '$.nodes') = 'object'`,
    )
    .all(runId)
  const changed: { stepId: string; nodeId: string; state: NodeState }[] = []
  for (const card of cards) {
    const payload = JSON.parse(card.payload) as { nodes: Record<string, NodeState> }
    let dirty = false
    for (const [nodeId, state] of Object.entries(payload.nodes)) {
      if (SETTLED_PHASES.has(state.phase)) continue
      const next: NodeState = { ...state, phase: 'interrupted', error: '调用中断' }
      payload.nodes[nodeId] = next
      changed.push({ stepId: card.id, nodeId, state: next })
      dirty = true
    }
    if (!dirty) continue
    store.db
      .query('UPDATE steps SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), card.id)
  }
  return changed
}

export function listRuns(store: Store, conversationId: ConversationId): Run[] {
  return store.db
    .query<RunRow, [string]>(
      'SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(conversationId)
    .map(rowToRun)
}

/**
 * runtime 重建模型历史所需的内部快照。公开的 `Run` 有意不含该输入，避免 UI/API
 * 把内部上下文误认为可编辑的 run 属性。
 */
export function listRunContextSnapshots(
  store: Store,
  conversationId: ConversationId,
): { runId: RunId; userMessageId: MessageId | null; segments: RunContextSegment[] }[] {
  return store.db
    .query<Pick<RunRow, 'id' | 'user_message_id' | 'context_snapshot'>, [string]>(
      `SELECT id, user_message_id, context_snapshot
       FROM runs
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId)
    .map((row) => ({
      runId: row.id,
      userMessageId: row.user_message_id,
      segments: readJson(row.context_snapshot, []),
    }))
}

// ─────────────────────────── 逐请求账 ───────────────────────────

/**
 * 记录一次即将发出的模型请求。
 *
 * 在装配完成之后、实际发出之前调用，因此状态为 `pending`：此时请求内容
 * 已经确定（分组占用、指纹均可计算），provider 是否接收仍未知。
 * 两者分开记录，使「已发出但无响应」与「未发出」在账本中
 * 可以区分：二者对上下文占用的含义完全不同。
 */
export function openProviderRequest(
  store: Store,
  input: {
    runId: RunId
    turnIndex: number
    retryIndex: number
    /** 缺省为主请求；摘要请求由主循环标记为 summary。 */
    purpose?: ProviderRequestPurpose
    providerName?: string
    providerKind?: ProviderKind
    model: string
    measuredInputTokens: number
    /** 摘要请求不提供。 */
    occupancyTokens?: number
    configuration?: ProviderRequestConfiguration
    sentCategories: ContextBreakdown
    omittedCategories: ContextOmitted
    payloadHash: string
    requestBytes?: number
    cacheRouteFingerprint?: string | null
  },
): ProviderRequest {
  const row: ProviderRequest = {
    id: newProviderRequestId(),
    runId: input.runId,
    turnIndex: input.turnIndex,
    retryIndex: input.retryIndex,
    purpose: input.purpose ?? 'turn',
    providerName: input.providerName ?? null,
    providerKind: input.providerKind ?? null,
    model: input.model,
    status: 'pending',
    measuredInputTokens: input.measuredInputTokens,
    occupancyTokens: input.occupancyTokens ?? null,
    providerInputTokens: null,
    providerOutputTokens: null,
    providerCachedTokens: null,
    providerCacheWriteTokens: null,
    finishReason: '',
    sentCategories: input.sentCategories,
    omittedCategories: input.omittedCategories,
    errorCode: null,
    errorMessage: null,
    diagnostic: null,
    configuration: input.configuration ?? null,
    payloadHash: input.payloadHash,
    requestBytes: input.requestBytes ?? null,
    cacheRouteFingerprint: input.cacheRouteFingerprint ?? null,
    sentAt: null,
    headersAt: null,
    hedge: null,
    firstEventAt: null,
    firstContentAt: null,
    lastContentAt: null,
    lastContentKind: null,
    lastVisibleAt: null,
    completedAt: null,
    createdAt: Date.now(),
  }
  store.db
    .query(
      `INSERT INTO provider_requests
       (id, run_id, turn_index, retry_index, purpose, provider_name, provider_kind, model, status,
        measured_input_tokens, occupancy_tokens, provider_input_tokens, provider_output_tokens, provider_cached_tokens,
        provider_cache_write_tokens, sent_categories, omitted_categories, error_code, payload_hash,
        request_bytes, cache_route_fingerprint, sent_at, headers_at, first_event_at, first_content_at,
        completed_at, created_at, configuration)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,?,?,NULL,?,?,?,NULL,NULL,NULL,NULL,NULL,?,?)`,
    )
    .run(
      row.id,
      row.runId,
      row.turnIndex,
      row.retryIndex,
      row.purpose,
      row.providerName,
      row.providerKind,
      row.model,
      row.status,
      row.measuredInputTokens,
      row.occupancyTokens,
      writeJson(row.sentCategories),
      writeJson(row.omittedCategories),
      row.payloadHash,
      row.requestBytes,
      row.cacheRouteFingerprint,
      row.createdAt,
      row.configuration === null ? null : writeJson(row.configuration),
    )
  return row
}

/** 请求已实际发出。`sent_at` 只在此处写入，面板据此选取最近一次已发送的请求。 */
export function markProviderRequestSent(store: Store, id: ProviderRequestId): void {
  store.db
    .query("UPDATE provider_requests SET status = 'in_flight', sent_at = ? WHERE id = ?")
    .run(Date.now(), id)
}

/**
 * 响应头到达的时刻。`at` 由传输层观测，不要在此处取当前时刻：
 * 事件从适配器传到此处已延迟若干毫秒，而该列的用途正是与 `sent_at`
 * 相减得出首包等待时间。重复调用时保留首次的值。
 */
export function markProviderRequestHeaders(store: Store, id: ProviderRequestId, at: number): void {
  store.db
    .query('UPDATE provider_requests SET headers_at = COALESCE(headers_at, ?) WHERE id = ?')
    .run(at, id)
}

/** 响应头之前补发的第二份请求。`hedge` 来自传输层读数：成功时经 `response_started`，失败时经诊断中的传输读数。 */
export function markProviderRequestHedge(
  store: Store,
  id: ProviderRequestId,
  hedge: ProviderHedge,
): void {
  store.db
    .query('UPDATE provider_requests SET hedge_sent_at = ?, hedge_won = ? WHERE id = ?')
    .run(hedge.sentAt, hedge.won ? 1 : 0, id)
}

/** provider 的第一个实际流事件。重复调用时保留首次的值，不被后续事件覆盖。 */
export function markProviderRequestFirstEvent(store: Store, id: ProviderRequestId): void {
  store.db
    .query('UPDATE provider_requests SET first_event_at = COALESCE(first_event_at, ?) WHERE id = ?')
    .run(Date.now(), id)
}

/**
 * 一段非空思考、正文或新增工具参数到达。
 *
 * 每一段都调用，`at` 由适配器在解析该段时观测，不要在此处取当前时刻：
 * 事件传到此处已延迟若干毫秒，而 `last_content_at` 的用途正是计算当前已静默多久。
 * 首值由 `COALESCE` 保留在 `first_content_at`，末值每次覆盖 `last_content_at`，
 * 两列在一次更新中写入：分成两条语句时，中途失败会使两列不一致。
 */
export function markProviderRequestContent(
  store: Store,
  id: ProviderRequestId,
  at: number,
  kind: ProviderRequestContentKind | null = null,
  visible = false,
): void {
  store.db
    .query(
      `UPDATE provider_requests SET
       first_content_at = COALESCE(first_content_at, ?), last_content_at = ?,
       last_content_kind = ?, last_visible_at = CASE WHEN ? THEN ? ELSE last_visible_at END
       WHERE id = ?`,
    )
    .run(at, at, kind, visible ? 1 : 0, at, id)
}

/**
 * 请求终态。
 *
 * `usage` 为 null 表示 provider 未回报，四个字段保持 null，不要填 0。
 * 中转站缺失 usage 很常见，记为 0 会使上下文锚点误判为该请求未占用任何上下文。
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
           finish_reason = ?, error_message = ?, completed_at = ?
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
      Date.now(),
      id,
    )
}

/** 失败诊断与重试裁决写回同一请求行；不另建重试状态。 */
export function recordProviderRequestDiagnostic(
  store: Store,
  id: ProviderRequestId,
  diagnostic: ProviderRequestDiagnostic,
): void {
  store.db
    .query('UPDATE provider_requests SET diagnostic = ? WHERE id = ?')
    .run(writeJson(diagnostic), id)
}

/**
 * 本会话最近一次已发送的主请求。面板的分组明细取自本函数。
 *
 * 只取主请求，`latestAnchoredProviderRequest` 相同：摘要请求发送的是摘要提示词，
 * 其输入量与会话占用无关，用作依据会把面板读数变成摘要请求的大小。
 */
export function latestSentProviderRequest(
  store: Store,
  conversationId: ConversationId,
): ProviderRequest | null {
  const row = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr
       JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.purpose = 'turn' AND pr.sent_at IS NOT NULL
       ORDER BY pr.sent_at DESC, pr.id DESC
       LIMIT 1`,
    )
    .get(conversationId)
  return row ? rowToProviderRequest(row) : null
}

/**
 * 本会话最近一次**带 usage 回报**的请求。
 *
 * 与 `latestSentProviderRequest` 的区别在于判据：本函数要求 provider 实际回报了用量。锚点必须取本函数的结果：
 * 超时或缺失 usage 的请求同样属于已发送，以它为锚点等于把锚点归零。
 */
export function latestAnchoredProviderRequest(
  store: Store,
  conversationId: ConversationId,
): ProviderRequest | null {
  const row = store.db
    .query<ProviderRequestRow, [string]>(
      `SELECT pr.* FROM provider_requests pr
       JOIN runs r ON r.id = pr.run_id
       WHERE r.conversation_id = ? AND pr.purpose = 'turn' AND pr.provider_input_tokens IS NOT NULL
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
    purpose: r.purpose as ProviderRequestPurpose,
    providerName: r.provider_name,
    providerKind: r.provider_kind,
    model: r.model,
    status: r.status,
    measuredInputTokens: r.measured_input_tokens,
    occupancyTokens: r.occupancy_tokens,
    providerInputTokens: r.provider_input_tokens,
    providerOutputTokens: r.provider_output_tokens,
    providerCachedTokens: r.provider_cached_tokens,
    providerCacheWriteTokens: r.provider_cache_write_tokens,
    sentCategories: { ...emptyBreakdown(), ...readJson(r.sent_categories, {}) },
    omittedCategories: { ...emptyOmitted(), ...readJson(r.omitted_categories, {}) },
    errorCode: r.error_code,
    errorMessage: r.error_message,
    diagnostic: readJson(r.diagnostic, null),
    configuration: readJson(r.configuration, null),
    payloadHash: r.payload_hash,
    requestBytes: r.request_bytes,
    finishReason: r.finish_reason ?? '',
    cacheRouteFingerprint: r.cache_route_fingerprint,
    sentAt: r.sent_at,
    headersAt: r.headers_at,
    hedge: r.hedge_sent_at === null ? null : { sentAt: r.hedge_sent_at, won: r.hedge_won === 1 },
    firstEventAt: r.first_event_at,
    firstContentAt: r.first_content_at,
    lastContentAt: r.last_content_at,
    lastContentKind: r.last_content_kind,
    lastVisibleAt: r.last_visible_at,
    completedAt: r.completed_at,
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
 * 必须在调用执行器之前单独提交：该时间戳是崩溃恢复的歧义边界。
 * 有该时间戳表示可能已执行（不可重放）；没有表示确定未执行（可安全重放）。
 */
export function markStepExecuting(store: Store, id: StepId): void {
  store.db.query('UPDATE steps SET execution_started_at = ? WHERE id = ?').run(Date.now(), id)
}

const SETTLED_PHASES: ReadonlySet<NodePhase> = new Set(['done', 'failed', 'skipped', 'interrupted'])

/**
 * 将派发任务卡上一个节点的状态写回工具 step（`$.nodes.<nodeId>`）。
 *
 * 每次变化立即写入，不等待 `settleToolStep`：用户可能在子 agent 运行期间离开父会话，
 * 返回时从账本重建卡片，此时运行期的 `team.member` 事件已经错过。
 *
 * 不限制卡的状态：一个节点失败后卡先返回父会话，其余节点照常运行，
 * 它们的终态仍写在派发它们的卡上。
 *
 * 节点 id 由模型给出，可能含点号或方括号，因此用 `json_object` 构造键再以 `json_patch` 合并。
 * 不要改成把 id 拼入 JSON 路径字符串：这类 id 会被解释为路径分隔符。
 */
export function setStepNodeState(store: Store, id: StepId, nodeId: string, state: NodeState): void {
  store.db
    .query(
      `UPDATE steps
       SET payload = json_set(
             coalesce(payload, '{}'),
             '$.nodes',
             json_patch(
               coalesce(json_extract(payload, '$.nodes'), json('{}')),
               json_object(?, json(?))
             )
           )
       WHERE id = ? AND kind = 'tool_action'`,
    )
    .run(nodeId, JSON.stringify(state), id)
}

/** 一次调用一行，原地从 running 更新到终态；不产生第二行。 */
export function settleToolStep(
  store: Store,
  id: StepId,
  status: ToolActionStatus,
  payload: Step['payload'],
  /**
   * 本次调用的执行时长。由执行方提供，不在此处计算：它度量的是执行器的起止时刻，
   * 而此处只能取得写入时刻。
   */
  durationMs?: number,
): void {
  const current = store.db
    .query<{ payload: string | null }, [string]>('SELECT payload FROM steps WHERE id = ?')
    .get(id)
  const before = readJson<Step['payload']>(current?.payload ?? null, null)
  const nodes =
    before?.kind === 'tool_call' || before?.kind === 'tool_result' ? before.nodes : undefined
  const settled = payload?.kind === 'tool_result' && nodes ? { ...payload, nodes } : payload
  store.db
    .query('UPDATE steps SET status = ?, payload = ?, duration_ms = ? WHERE id = ?')
    .run(status, writeJson(settled), durationMs ?? null, id)
}

/**
 * 将一次尝试留下的思考 step 写为失败终态。
 *
 * 供轮内自动重发使用。思考 step 创建时即为 `done`，而 `settleRunningSteps` 只处理 `running`，
 * 因此无法覆盖这类 step。
 *
 * 不删除：这些 step 确实发生过，且已逐 delta 渲染给用户；
 * 删除会使已渲染的思考从界面上消失。标记 `failure` 供投影侧使用：
 * `stepsToUnits` 据此把失败尝试的思考排除在模型视图之外，
 * 否则它会与重发尝试的思考拼接成一条回传给 provider。
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

/** 一个模型在一段时间内的请求结束情况。分母是该时段内为它创建的全部账本行。 */
export interface ModelFinishRate {
  model: string
  total: number
  /** 流按协议正常结束的次数。 */
  received: number
  /** 连接层失败，是否送达、是否计费均无法确定。 */
  uncertain: number
  /** provider 返回状态码明确拒绝。 */
  rejected: number
  /** 该时段内出现次数最多的错误码；没有错误时为 null。 */
  topErrorCode: string | null
}

/**
 * 按模型统计请求的结束情况。
 *
 * 用途：判断某个端点在本机是否稳定。账本已逐行记录每次请求的结果，
 * 无需反复试验。
 *
 * 边界：样本随会话一并删除（`provider_requests.run_id` 是 ON DELETE CASCADE），
 * 因此统计范围是现存会话，不是全部历史。
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
    // 在 exactOptionalPropertyTypes 下，键不存在与键值为 undefined 不同，
    // 因此先判断 null，再决定是否添加该键。
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
    parentConversationId: r.parent_conversation_id,
    externalSession: r.external_session,
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
    origin: r.origin,
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
    model: r.model,
    clientRequestId: r.client_request_id,
    status: r.status,
    stopReason: r.stop_reason,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      // 直接透传 null，不要写 ?? 0，理由见 schema 注释。
      cachedTokens: r.cached_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      reasoningTokens: r.reasoning_tokens,
      cost: r.cost,
      currency: r.currency,
      turns: readJson(r.usage_turns, []),
      ...mediaOf(r.media_usage),
    },
    stepCount: r.step_count,
    errorMessage: r.error_message,
    errorCode: r.error_code,
    interruption: readJson(r.interruption_detail, null),
    dispatchStepId: r.dispatch_step_id,
    dispatchNodeId: r.dispatch_node_id,
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
