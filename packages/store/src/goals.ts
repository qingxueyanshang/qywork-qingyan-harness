/**
 * 目标账本：多轮连续执行的唯一权威。
 *
 * 规则放在此处而非工具中。写入方有三个：用户（`/goal` 创建或改写、点击继续）、服务端（中断时转为
 * paused、异常时转为 blocked）、模型（只有 `complete` / `blocked` 两个出口，经由端口传入）。生命周期
 * 转移与 revision 递增是账本的一致性规则，分散到三个调用方各自维护会形成三份逐渐不一致的判断；
 * 这一点与本包其余部分的原则相同（见 `repos.ts` 顶部）。
 *
 * 事件溯源，回放时校验。每次变更追加一行完整快照，`revision` 从 1 开始逐一递增。读取时不是直接
 * 取最后一行，而是从头回放：revision 断号、状态非法转移一律抛出异常。这两种损坏都不会自行表现为
 * 错误：断号意味着有一次变更未写入磁盘（而调用方收到的是成功），非法转移意味着有写入绕过了本模块。
 * 宁可抛出异常，也不让循环带着来源不明的状态继续运行。
 *
 * 同时只有一个目标。「当前目标」是该会话中 id 最大的目标（`gl_` 之后是单调递增的 id）。
 * 上一个目标到达 `completed` 之前不允许创建新目标：两个目标并存时，无法确定应自动继续哪一个。
 */

import type { ConversationId, Goal, GoalAction, GoalStatus, GoalWriteResult } from '@qywork/core'
import { newGoalId } from '@qywork/core'
import type { Store } from './db.ts'

/**
 * 合法的生命周期转移。`completed` 是终态，没有任何出边：
 * 已完成的目标如需继续，应新建一个目标；允许改回会使「完成」失去意义。
 */
const ALLOWED: Record<GoalStatus, GoalStatus[]> = {
  active: ['active', 'paused', 'completed', 'blocked'],
  paused: ['paused', 'active', 'completed', 'blocked'],
  blocked: ['blocked', 'active', 'completed'],
  completed: [],
}

/** 当前目标；该会话从未创建目标时为 null。 */
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
 * 创建一个目标。
 *
 * 没有轮数参数。循环的出口是模型自检（`complete` / `blocked`）与用户点击停止，
 * 不是配额；理由见 `core` 中 `Goal` 的注释。
 */
export function createGoal(
  store: Store,
  input: { conversationId: ConversationId; objective: string },
): GoalWriteResult {
  const objective = input.objective.trim()
  if (!objective) {
    return { ok: false, code: 'invalid_objective', message: 'objective 不能为空' }
  }

  // 查询是否存在未完成的目标与追加必须在同一个写事务中：分开执行时，两个进程同时创建目标，
  // 两边都查到没有，会同时出现两个进行中的目标（goal_id 不同，主键无法拦截）。
  return store.tx(() => {
    const existing = currentGoal(store, input.conversationId)
    if (existing && existing.status !== 'completed') {
      return {
        ok: false,
        code: 'goal_exists',
        message:
          `该会话已有一个目标（${existing.id}，状态 ${existing.status}）：${existing.objective}。` +
          '同时只能有一个目标：先用 update_goal 将其 complete，或用 resume 继续执行该目标。',
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
  })
}

/**
 * 修改一个目标。
 *
 * `revision` 是必填的乐观锁：以旧版本号提交时直接拒绝，不静默覆盖中间的变更。
 * 模型持有的目标可能是若干轮之前读取的。
 *
 * 校验 revision 与追加在同一个写事务中：分开执行时，两个进程持同一个 revision 同时修改，
 * 后到者因主键冲突抛出异常，而不是收到 `stale_revision`。
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
  return store.tx(() => {
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
        return { ok: false, code: 'invalid_objective', message: 'action="edit" 必须提供 objective' }
      }
      patch.objective = objective
    }

    if (input.action === 'blocked') {
      const reason = (input.blockedReason ?? '').trim()
      // 没有理由的 blocked 是最差的停止方式：循环已停止，却无人知道原因，
      // 界面上只显示「受阻」二字。
      if (!reason) {
        return {
          ok: false,
          code: 'missing_reason',
          message: 'action="blocked" 必须提供 blocked_reason，说明阻塞位置以及继续执行所需的条件',
        }
      }
      patch.blockedCode = input.blockedCode ?? 'needs_human'
      patch.blockedReason = reason
    } else {
      // 离开 blocked 时一并清除理由。保留时，下一次因其他原因停止，
      // 界面上会显示几轮之前的旧理由。
      patch.blockedCode = null
      patch.blockedReason = null
    }

    return commit(store, goal, patch)
  })
}

// ─────────────────────────────── 内部 ───────────────────────────────

function checkTransition(
  from: GoalStatus,
  to: GoalStatus,
  action: GoalAction,
): { ok: false; code: string; message: string } | null {
  if (from === to && action !== 'edit') {
    return { ok: false, code: 'no_op', message: `目标已处于 ${from} 状态` }
  }
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      code: 'illegal_transition',
      message: `目标当前为 ${from}，不能转为 ${to}`,
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
    return { ok: false, code: 'no_goal', message: '本会话尚无目标' }
  }
  if (goal.id !== goalId) {
    return {
      ok: false,
      code: 'stale_goal',
      message: `goal_id 不一致：当前目标是 ${goal.id}，你传入的是 ${goalId}。先调用 read_goal 查看当前目标。`,
    }
  }
  if (goal.revision !== revision) {
    return {
      ok: false,
      code: 'stale_revision',
      message:
        `revision 已经是 ${goal.revision}，你提供的是 ${revision}：目标在你读取之后已被修改。` +
        '先调用 read_goal 重新读取，再决定是否修改。',
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
 * 从头回放一个目标。断号与非法转移时抛出异常，不返回推测的值。
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
        `[qywork] 目标 ${goalId} 的 revision 断号：期望 ${i + 1}，实际为 ${row.revision}`,
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
