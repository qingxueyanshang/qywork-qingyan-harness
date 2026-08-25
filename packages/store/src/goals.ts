/**
 * 目标账本 —— 「一轮接一轮做下去」的唯一权威。
 *
 * **为什么规则在这里，不在工具里。** 三个写入方：用户（`/goal` 立或改写、点继续）、服务端（中断转
 * paused、异常转 blocked）、模型（只有 `complete` / `blocked` 两个出口，经端口下来）。**生命周期转
 * 移和 revision 递增是账本的一致性规则**，散到三个调用方去守就是三份会漂移的判断——这一条与本包其
 * 余部分同一口径（见 `repos.ts` 顶部）。
 *
 * **事件溯源，回放时校验。** 每次变更追加一行完整快照，`revision` 从 1 开始逐一递增。读的时候不是直
 * 接取最后一行了事，而是**从头回放一遍**：revision 断号、状态非法转移一律抛。这两种破损都不会自己
 * 表现成错误——断号意味着有一次变更没落盘（而调用方收到的是成功），非法转移意味着有人绕过了这里写
 * 表。让它响，比让循环带着一个说不清来历的状态继续跑要好。
 *
 * **同时只有一个目标。** 「当前目标」= 这条会话里 id 最大的那个目标（`gl_` 后面是单调 id）。
 * 上一个没走到 `completed` 之前不许立新的——两个目标并存时，「续起哪一个」
 * 就成了一个没有答案的问题。
 */

import type { ConversationId, Goal, GoalAction, GoalStatus, GoalWriteResult } from '@qywork/core'
import { newGoalId } from '@qywork/core'
import type { Store } from './db.ts'

/**
 * 合法的生命周期转移。**`completed` 是终态**，从它出发一条边都没有——
 * 做完的目标要接着做就立新的，改回来会让「完成」这件事变得没有意义。
 */
const ALLOWED: Record<GoalStatus, GoalStatus[]> = {
  active: ['active', 'paused', 'completed', 'blocked'],
  paused: ['paused', 'active', 'completed', 'blocked'],
  blocked: ['blocked', 'active', 'completed'],
  completed: [],
}

/** 当前目标；这条会话还没立过就是 null。 */
export function currentGoal(store: Store, conversationId: ConversationId): Goal | null {
  const head = store.db
    .query<{ goal_id: string }, [string]>(
      'SELECT goal_id FROM goal_events WHERE conversation_id = ? ORDER BY goal_id DESC LIMIT 1',
    )
    .get(conversationId)
  if (!head) return null
  return replay(store, head.goal_id)
}

/**
 * 立一个目标。
 *
 * **没有轮数参数。** 循环的出口是模型自检（`complete` / `blocked`）与用户点停止，
 * 不是配额——理由见 `core` 里 `Goal` 的注释。
 */
export function createGoal(
  store: Store,
  input: { conversationId: ConversationId; objective: string },
): GoalWriteResult {
  const objective = input.objective.trim()
  if (!objective) {
    return { ok: false, code: 'invalid_objective', message: 'objective 不能为空' }
  }

  const existing = currentGoal(store, input.conversationId)
  if (existing && existing.status !== 'completed') {
    return {
      ok: false,
      code: 'goal_exists',
      message:
        `这条会话已经有一个目标（${existing.id}，状态 ${existing.status}）：${existing.objective}。` +
        '同时只能有一个目标——先用 update_goal 把它 complete 掉，或者 resume 接着做它。',
    }
  }

  const now = Date.now()
  const goal: Goal = {
    id: newGoalId(),
    conversationId: input.conversationId,
    objective,
    status: 'active',
    revision: 1,
    blockedCode: null,
    blockedReason: null,
    createdAt: now,
    updatedAt: now,
  }
  append(store, goal)
  return { ok: true, goal }
}

/**
 * 改一个目标。
 *
 * `revision` 是必填的乐观锁：拿旧版本号提交直接拒，不静默覆盖中间那次变更。
 * 模型手里的目标可能是若干轮之前读到的。
 */
export function updateGoal(
  store: Store,
  input: {
    conversationId: ConversationId
    goalId: string
    revision: number
    action: GoalAction
    objective?: string
    blockedCode?: string
    blockedReason?: string
  },
): GoalWriteResult {
  const found = load(store, input.conversationId, input.goalId, input.revision)
  if (!found.ok) return found
  const goal = found.goal

  const next: GoalStatus =
    input.action === 'pause'
      ? 'paused'
      : input.action === 'resume'
        ? 'active'
        : input.action === 'complete'
          ? 'completed'
          : input.action === 'blocked'
            ? 'blocked'
            : goal.status

  const denied = checkTransition(goal.status, next, input.action)
  if (denied) return denied

  const patch: Partial<Goal> = { status: next }

  if (input.action === 'edit') {
    const objective = (input.objective ?? '').trim()
    if (!objective) {
      return { ok: false, code: 'invalid_objective', message: 'action="edit" 必须带 objective' }
    }
    patch.objective = objective
  }

  if (input.action === 'blocked') {
    const reason = (input.blockedReason ?? '').trim()
    // 没有理由的 blocked 是最坏的一种停：循环停了，而没有人知道为什么，
    // 界面上只剩一个「受阻」两个字。
    if (!reason) {
      return {
        ok: false,
        code: 'missing_reason',
        message: 'action="blocked" 必须带 blocked_reason，说清卡在哪、需要什么才能继续',
      }
    }
    patch.blockedCode = input.blockedCode ?? 'needs_human'
    patch.blockedReason = reason
  } else {
    // 离开 blocked 时把理由一并清掉。留着的话，下一次因为别的原因停下时，
    // 界面上会显示一条几轮之前的旧理由。
    patch.blockedCode = null
    patch.blockedReason = null
  }

  return commit(store, goal, patch)
}

// ─────────────────────────────── 内部 ───────────────────────────────

function checkTransition(
  from: GoalStatus,
  to: GoalStatus,
  action: GoalAction,
): { ok: false; code: string; message: string } | null {
  if (from === to && action !== 'edit') {
    return { ok: false, code: 'no_op', message: `目标已经是 ${from} 了` }
  }
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      code: 'illegal_transition',
      message: `目标当前是 ${from}，不能转成 ${to}`,
    }
  }
  return null
}

function load(
  store: Store,
  conversationId: ConversationId,
  goalId: string,
  revision: number,
): { ok: true; goal: Goal } | { ok: false; code: string; message: string } {
  const goal = currentGoal(store, conversationId)
  if (!goal) {
    return { ok: false, code: 'no_goal', message: '这条会话还没有目标' }
  }
  if (goal.id !== goalId) {
    return {
      ok: false,
      code: 'stale_goal',
      message: `goal_id 对不上：当前目标是 ${goal.id}，你给的是 ${goalId}。先调 read_goal 看一眼。`,
    }
  }
  if (goal.revision !== revision) {
    return {
      ok: false,
      code: 'stale_revision',
      message:
        `revision 已经是 ${goal.revision}，你给的是 ${revision}——目标在你读到之后被改过了。` +
        '先调 read_goal 重读，再决定要不要改。',
    }
  }
  return { ok: true, goal }
}

function commit(store: Store, goal: Goal, patch: Partial<Goal>): GoalWriteResult {
  const next: Goal = { ...goal, ...patch, revision: goal.revision + 1, updatedAt: Date.now() }
  append(store, next)
  return { ok: true, goal: next }
}

function append(store: Store, goal: Goal): void {
  store.db
    .query(
      `INSERT INTO goal_events (goal_id, conversation_id, revision, snapshot, created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(goal.id, goal.conversationId, goal.revision, JSON.stringify(goal), goal.updatedAt)
}

/**
 * 从头回放一个目标。断号与非法转移**抛**，不返回一个「大概是这样」的值。
 */
function replay(store: Store, goalId: string): Goal {
  const rows = store.db
    .query<{ revision: number; snapshot: string }, [string]>(
      'SELECT revision, snapshot FROM goal_events WHERE goal_id = ? ORDER BY revision',
    )
    .all(goalId)

  let goal: Goal | null = null
  for (const [i, row] of rows.entries()) {
    if (row.revision !== i + 1) {
      throw new Error(
        `[qywork] 目标 ${goalId} 的 revision 断号：期望 ${i + 1}，读到 ${row.revision}`,
      )
    }
    const snapshot = JSON.parse(row.snapshot) as Goal
    if (goal && !ALLOWED[goal.status].includes(snapshot.status)) {
      throw new Error(
        `[qywork] 目标 ${goalId} 出现非法转移：${goal.status} → ${snapshot.status}（revision ${row.revision}）`,
      )
    }
    goal = snapshot
  }
  if (!goal) throw new Error(`[qywork] 目标 ${goalId} 没有任何事件`)
  return goal
}
