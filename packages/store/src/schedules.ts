/**
 * 定时任务仓储：到期判定、认领、投影。
 *
 * **认领是一个写事务，不是三段。** 重新读任务、判到期、查上一轮忙不忙、建会话、推进触发
 * 游标全部在同一个 `Store.tx()`（IMMEDIATE）里；只有提交成功的那一方才去 `startRun`。
 * 拆成「先改内存快照 → 建会话 → 起轮 → 最后整表回写」的话，中间每个 await 都是另一个
 * 服务实例可以对同一条到期任务再起一轮的时间窗。
 *
 * **忙态查的是 runs 表，不是进程内的 RunManager**：跨进程的竞争只有落盘的状态答得了。
 *
 * **这里不存执行结果。** 上一次跑成什么样按 `conversation_id` 关联的 Run 读
 * （`scheduleView`）。任务表里再存一份 status/error 就是第二本账。
 */

import type {
  Conversation,
  ConversationId,
  Schedule,
  ScheduleDraft,
  ScheduleLastRun,
  ScheduleView,
  WorkspaceId,
} from '@qywork/core'
import { isDue, nextRunAt } from '@qywork/core'
import type { Store } from './db.ts'
import { createConversation, normalizeWorkspaceRoot } from './repos.ts'
import type { ScheduleRow } from './schema.ts'

/** 认领成功的一次触发。调用方在事务提交之后把 prompt 发进 `conversationId`。 */
export interface ScheduleClaim {
  schedule: Schedule
  workspaceId: WorkspaceId
  workspaceRoot: string
  /** 这次触发发进哪条会话。 */
  conversationId: ConversationId
  /** 这次认领新建的会话；复用绑定会话时为 null。调用方据此决定要不要广播。 */
  created: Conversation | null
}

/**
 * 单条认领的结果。
 *
 * `workspace_missing` 与 `busy` 都不推进游标：任务仍然到期，下一个 tick 再判一次。
 */
export type ScheduleClaimResult =
  | { ok: true; claim: ScheduleClaim }
  | { ok: false; reason: 'not_found' | 'busy' | 'workspace_missing' }

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    workspaceRoot: r.workspace_root,
    title: r.title,
    prompt: r.prompt,
    kind: r.kind,
    ...(r.every_minutes === null ? {} : { everyMinutes: r.every_minutes }),
    ...(r.at_hour === null ? {} : { atHour: r.at_hour }),
    ...(r.at_minute === null ? {} : { atMinute: r.at_minute }),
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    ...(r.last_run_at === null ? {} : { lastRunAt: r.last_run_at }),
    ...(r.conversation_id === null ? {} : { conversationId: r.conversation_id }),
    newConversation: r.new_conversation === 1,
  }
}

function readOne(store: Store, id: string): Schedule | null {
  const row = store.db.query<ScheduleRow, [string]>('SELECT * FROM schedules WHERE id = ?').get(id)
  return row ? rowToSchedule(row) : null
}

/**
 * 绑定会话里最近一条 run 的终态。
 *
 * 会话被删除时列已被 `ON DELETE SET NULL` 置空，因此这里读到的一定是仍然存在的会话；
 * 查不到 run 就如实回 `runId: null`。边界见 `ScheduleLastRun`。
 */
function lastRunOf(store: Store, s: Schedule): ScheduleLastRun | null {
  const cid = s.conversationId
  if (cid === undefined) return null
  const row = store.db
    .query<
      { id: string; status: ScheduleLastRun['status']; error_message: string | null },
      [string]
    >(
      `SELECT id, status, error_message FROM runs
       WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(cid)
  return row === null
    ? { conversationId: cid, runId: null, status: null, errorMessage: null }
    : {
        conversationId: cid,
        runId: row.id,
        status: row.status,
        errorMessage: row.error_message,
      }
}

/** 任务 + 派生读数。HTTP 面与模型工具共用这一份，两处各拼一遍会给出两种终态。 */
function scheduleView(store: Store, s: Schedule, now: number): ScheduleView {
  return { ...s, nextRunAt: nextRunAt(s, now), due: isDue(s, now), lastRun: lastRunOf(store, s) }
}

/** 某个工作区的全部任务，按建立先后。 */
export function listSchedules(store: Store, workspaceRoot: string, now: number): ScheduleView[] {
  return store.db
    .query<ScheduleRow, [string]>(
      'SELECT * FROM schedules WHERE workspace_root = ? ORDER BY created_at ASC, id ASC',
    )
    .all(normalizeWorkspaceRoot(workspaceRoot))
    .map((r) => scheduleView(store, rowToSchedule(r), now))
}

const INSERT_SQL = `INSERT INTO schedules
  (id, workspace_root, title, prompt, kind, every_minutes, at_hour, at_minute,
   enabled, created_at, last_run_at, conversation_id, new_conversation)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`

function insert(store: Store, s: Schedule): void {
  store.db
    .query(INSERT_SQL)
    .run(
      s.id,
      s.workspaceRoot,
      s.title,
      s.prompt,
      s.kind,
      s.everyMinutes ?? null,
      s.atHour ?? null,
      s.atMinute ?? null,
      s.enabled ? 1 : 0,
      s.createdAt,
      s.lastRunAt ?? null,
      s.conversationId ?? null,
      s.newConversation ? 1 : 0,
    )
}

/**
 * 建一条任务。id 与 createdAt 在这里生成——两个入口各拼一遍 id 前缀，
 * 设置页和调度器会各认得一半。
 *
 * `conversationId` 是建任务的那条会话，触发时消息发进它。**归属只在建的时候写得对**，
 * 所以它必填；`draft.newConversation` 为真的任务每次触发另建会话，不绑定它。
 */
export function createSchedule(
  store: Store,
  workspaceRoot: string,
  draft: ScheduleDraft,
  conversationId: ConversationId,
): Schedule {
  const separate = draft.newConversation === true
  const s: Schedule = {
    ...draft,
    id: `sch_${crypto.randomUUID().slice(0, 12)}`,
    workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
    enabled: true,
    createdAt: Date.now(),
    newConversation: separate,
    ...(separate ? {} : { conversationId }),
  }
  insert(store, s)
  return s
}

/**
 * 改一条任务的可编辑字段。
 *
 * 触发游标、归属工作区、createdAt、`newConversation` 不接受外部改写：让调用方能写
 * `lastRunAt` 等于把「下次什么时候触发」交给它决定，而改 `newConversation` 会让同一条
 * 任务的历史一半在绑定会话里、一半散在别处。
 */
export function updateSchedule(
  store: Store,
  id: string,
  workspaceRoot: string,
  next: Pick<Schedule, 'title' | 'prompt' | 'kind' | 'enabled'> &
    Partial<Pick<Schedule, 'everyMinutes' | 'atHour' | 'atMinute'>>,
): Schedule | null {
  const changed = store.db
    .query(
      `UPDATE schedules SET title = ?, prompt = ?, kind = ?, every_minutes = ?, at_hour = ?,
       at_minute = ?, enabled = ? WHERE id = ? AND workspace_root = ?`,
    )
    .run(
      next.title,
      next.prompt,
      next.kind,
      next.everyMinutes ?? null,
      next.atHour ?? null,
      next.atMinute ?? null,
      next.enabled ? 1 : 0,
      id,
      normalizeWorkspaceRoot(workspaceRoot),
    ).changes
  return changed === 0 ? null : readOne(store, id)
}

/** 删一条任务；不存在或不属于这个工作区时返回 null。 */
export function deleteSchedule(store: Store, id: string, workspaceRoot: string): Schedule | null {
  const found = readOne(store, id)
  if (found === null || found.workspaceRoot !== normalizeWorkspaceRoot(workspaceRoot)) return null
  store.db.query('DELETE FROM schedules WHERE id = ?').run(id)
  return found
}

/**
 * 整表插入已有 id 的任务，用于一次性导入旧数据。
 *
 * **调用方必须把它包进 `store.tx()`**：半张表比不导入坏得多，而导入方还要在同一个事务里
 * 完成旧文件的收尾。原 id、createdAt、触发游标与关联会话原样保留；重复 id 由主键约束当场
 * 报错，整个事务随之回滚。
 */
export function insertSchedules(store: Store, list: Schedule[]): void {
  for (const s of list) {
    insert(store, { ...s, workspaceRoot: normalizeWorkspaceRoot(s.workspaceRoot) })
  }
}

/** 工作区必须仍然登记且未移除，否则这条任务不触发。 */
function workspaceIdForRoot(store: Store, root: string): WorkspaceId | null {
  const row = store.db
    .query<{ id: string }, [string]>(
      'SELECT id FROM workspaces WHERE root_path = ? AND removed_at IS NULL',
    )
    .get(normalizeWorkspaceRoot(root))
  return row === null ? null : (row.id as WorkspaceId)
}

/**
 * 最近一次触发进的那条会话（含它派出的子会话）还有没有未落终态的 run。
 *
 * 查落盘状态而不是进程内的登记表：另一个进程正在跑的那一轮，这个进程的 RunManager 里
 * 没有记录。启动时的 `recoverStaleRuns` 负责回收无人持有的残留行。
 */
function hasLiveRun(store: Store, conversationId: string | undefined): boolean {
  if (conversationId === undefined) return false
  const row = store.db
    .query<{ one: number }, [string, string]>(
      `SELECT 1 AS one FROM runs r
       JOIN conversations c ON c.id = r.conversation_id
       WHERE (c.id = ? OR c.parent_conversation_id = ?)
         AND r.status IN ('queued','running') LIMIT 1`,
    )
    .get(conversationId, conversationId)
  return row !== null
}

interface ClaimInput {
  now: number
  provider: string
  model: string
}

/** 事务内的单条认领。调用方负责把它包进 `store.tx()`。 */
function claimInTx(
  store: Store,
  s: Schedule,
  input: ClaimInput,
  advanceCursor: boolean,
): ScheduleClaimResult {
  const workspaceId = workspaceIdForRoot(store, s.workspaceRoot)
  if (workspaceId === null) return { ok: false, reason: 'workspace_missing' }
  if (hasLiveRun(store, s.conversationId)) return { ok: false, reason: 'busy' }

  /*
   * 复用绑定会话，`conversation_id` 为空才新建。空只有两种来路：会话被删
   * （`ON DELETE SET NULL`）与旧数据从未绑定。不在这里另查会话存不存在——外键已经
   * 把「指着一条不存在的会话」排除了。
   *
   * `newConversation` 的任务每次都新建，本次进的那条照样写回该列：忙态判定与终态
   * 投影读的是同一格，分叉的话两种任务要各写一套判定。
   */
  const created =
    s.newConversation || s.conversationId === undefined
      ? createConversation(store, {
          workspaceId,
          provider: input.provider,
          model: input.model,
          title: s.title,
        })
      : null
  const conversationId = created?.id ?? (s.conversationId as ConversationId)
  if (advanceCursor) {
    store.db
      .query('UPDATE schedules SET last_run_at = ?, conversation_id = ? WHERE id = ?')
      .run(input.now, conversationId, s.id)
  } else {
    store.db
      .query('UPDATE schedules SET conversation_id = ? WHERE id = ?')
      .run(conversationId, s.id)
  }
  return {
    ok: true,
    claim: {
      schedule: s,
      workspaceId,
      workspaceRoot: s.workspaceRoot,
      conversationId,
      created,
    },
  }
}

/**
 * 认领这一刻所有到期的任务。
 *
 * 扫的是全部已启用任务，不按启动时的工作区过滤：一个进程服务多个项目，按启动目录筛选
 * 会让别的项目的任务永远不触发。归属由每条任务自己的 `workspaceRoot` 决定。
 */
export function claimDueSchedules(store: Store, input: ClaimInput): ScheduleClaim[] {
  return store.tx(() => {
    const claims: ScheduleClaim[] = []
    const rows = store.db
      .query<ScheduleRow, []>(
        'SELECT * FROM schedules WHERE enabled = 1 ORDER BY created_at ASC, id ASC',
      )
      .all()
    for (const row of rows) {
      const s = rowToSchedule(row)
      if (!isDue(s, input.now)) continue
      const result = claimInTx(store, s, input, true)
      if (result.ok) claims.push(result.claim)
    }
    return claims
  })
}

/**
 * 「立刻跑一次」：同一个认领事务，但**不推进自动触发游标**。
 *
 * 推进的话「每天 9 点」会因为下午点过一次试跑而当天不再自动触发。本次进的那条会话仍然
 * 写回，试跑的结果因此和自动触发一样能在面板上看到。
 */
export function claimScheduleNow(
  store: Store,
  id: string,
  workspaceRoot: string,
  input: ClaimInput,
): ScheduleClaimResult {
  return store.tx(() => {
    const s = readOne(store, id)
    if (s === null || s.workspaceRoot !== normalizeWorkspaceRoot(workspaceRoot)) {
      return { ok: false, reason: 'not_found' }
    }
    return claimInTx(store, s, input, false)
  })
}
