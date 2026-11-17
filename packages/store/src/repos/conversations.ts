/**
 * `conversations` 表的读写：创建、列表与计数、归档与删除，以及标题、模型、权限模式、压缩投影等会话级属性。
 */

import {
  type CompactionManifest,
  type Conversation,
  type ConversationId,
  newConversationId,
  type PermissionMode,
  type WorkspaceId,
} from '@qywork/core'
import { readJson, type Store, writeJson } from '../db.ts'
import { pruneRequestEnvelopes } from '../monitor/envelopes.ts'
import type { ConversationRow } from '../rows.ts'

export function createConversation(
  store: Store,
  input: {
    workspaceId: WorkspaceId
    /** 接口名。与 `model` 成对，创建会话时即确定，不由下游推测。 */
    provider: string
    model: string
    title?: string
    source?: Conversation['source']
    sourceRef?: string
    /** 派发任务创建子会话时必须提供：归属只能在创建时正确写入，事后无法从任何来源推导。 */
    parentConversationId?: ConversationId
    externalSession?: string
    /** 顶层会话传入配置中的默认模式；子会话省略，它按顶层会话的模式运行。 */
    mode?: PermissionMode
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
    mode: input.mode ?? 'auto',
    createdAt: now,
    updatedAt: now,
  }
  store.db
    .query(
      `INSERT INTO conversations
       (id, workspace_id, title, provider, model, compaction_manifest, cache_generation, source, source_ref, parent_conversation_id, external_session, permission_mode, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      conv.mode,
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
 * （`migrations/` 中各表的 `ON DELETE CASCADE`）。
 *
 * 附件目录不在此处删除：它位于磁盘而不在数据库中，由 `api/conversations.ts` 的 DELETE
 * 分支随后删除。该分支只删除本会话的目录，不按 `Attachment.path` 逐条删除：
 * 路径型附件指向用户自己的文件。
 *
 * 信封明细不由外键引用，在同一事务中删除不再被任何请求行引用的部分（`pruneRequestEnvelopes`）。
 *
 * 调用方必须先确认没有运行中的 run：运行中的轮次仍在向级联删除的行写入。
 */
export function deleteConversation(store: Store, id: ConversationId): boolean {
  return store.tx(() => {
    const deleted = store.db.query('DELETE FROM conversations WHERE id = ?').run(id).changes > 0
    if (deleted) pruneRequestEnvelopes(store)
    return deleted
  })
}

/**
 * 重命名。不修改 `updated_at`：改名不属于内容更新，推进该值会使列表重排，
 * 侧栏显示的时间与实际内容更新时间不一致。返回 null 表示会话不存在，或指定了 `onlyIfEmpty` 而标题非空。
 *
 * `onlyIfEmpty` 供自动生成标题使用：标题是否为空在写入的同一条语句中判断。不要改为调用方先读后写：
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
 * 切换会话的权限模式。不修改 `updated_at`，理由同 `setConversationTitle`。
 * 返回 null 表示会话不存在。
 */
export function setConversationMode(
  store: Store,
  id: ConversationId,
  mode: PermissionMode,
): Conversation | null {
  const changed = store.db
    .query('UPDATE conversations SET permission_mode = ? WHERE id = ?')
    .run(mode, id)
  if (changed.changes === 0) return null
  return getConversation(store, id)
}

/**
 * 本会话执行时适用的权限模式：顶层会话的 `mode`。
 *
 * 子会话没有开关，按顶层会话的模式运行；不要改为读取子会话自身的列，
 * 否则用户切换父会话后，已创建的子 agent 仍按创建时的模式执行。会话不存在时返回 `auto`。
 */
export function permissionModeOf(store: Store, id: ConversationId): PermissionMode {
  let conv = getConversation(store, id)
  while (conv?.parentConversationId) conv = getConversation(store, conv.parentConversationId)
  return conv?.mode ?? 'auto'
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

function rowToConversation(r: ConversationRow): Conversation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    provider: r.provider,
    model: r.model,
    compactionManifest: readJson(r.compaction_manifest, null, 'conversations.compaction_manifest'),
    cacheGeneration: r.cache_generation,
    source: r.source,
    sourceRef: r.source_ref,
    parentConversationId: r.parent_conversation_id,
    externalSession: r.external_session,
    mode: r.permission_mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}
