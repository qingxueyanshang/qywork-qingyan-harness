/**
 * 目标账本的行为回归。覆盖范围：`goals.ts`（生命周期、乐观锁、回放校验），
 * 以及迁移 22 创建的 `goal_events` 表。
 *
 * 此处锁定的是行为：谁能修改、修改后的状态、数据损坏时是否报错。
 * 自动继续循环一侧（何时由谁调用这些函数）的测试位于 `server/goal-loop.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import { createGoal, currentGoal, updateGoal } from './goals.ts'
import { createConversation, upsertWorkspace } from './repos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  return { store, conversationId: conv.id }
}

/** 创建一个目标并断言成功，省去每个用例中的三行解包。 */
function seed(store: Store, conversationId: ReturnType<typeof fresh>['conversationId']) {
  const r = createGoal(store, { conversationId, objective: '把测试跑绿' })
  if (!r.ok) throw new Error(r.message)
  return r.goal
}

describe('创建目标', () => {
  test('创建后即可读取，revision 从 1 开始', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    expect(goal.revision).toBe(1)
    expect(goal.status).toBe('active')
    expect(currentGoal(store, conversationId)).toEqual(goal)
    store.close()
  })

  test('没有目标时读取到 null，既不抛出异常也不返回空对象', () => {
    const { store, conversationId } = fresh()
    expect(currentGoal(store, conversationId)).toBeNull()
    store.close()
  })

  /**
   * 原始失败形状：两个目标并存时，无法确定自动继续哪一个；
   * 而自动继续不经过用户，此时没有人可以询问。
   */
  test('上一个目标未完成时不允许创建新目标，完成后才允许', () => {
    const { store, conversationId } = fresh()
    const first = seed(store, conversationId)

    const again = createGoal(store, { conversationId, objective: '另一件事' })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe('goal_exists')

    const done = updateGoal(store, {
      conversationId,
      goalId: first.id,
      revision: first.revision,
      action: 'complete',
    })
    expect(done.ok).toBe(true)

    const third = createGoal(store, { conversationId, objective: '另一件事' })
    expect(third.ok).toBe(true)
    if (third.ok) expect(third.goal.id).not.toBe(first.id)
    store.close()
  })
})

describe('修改目标', () => {
  /**
   * 原始失败形状：模型持有的 revision 是几轮之前读取的，按它提交会静默覆盖
   * 中间的暂停：用户点击了停止，循环却继续运行。
   */
  test('以旧 revision 提交时直接拒绝，账本不发生任何改动', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    const paused = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'pause',
    })
    expect(paused.ok).toBe(true)

    const stale = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('stale_revision')
    expect(currentGoal(store, conversationId)?.status).toBe('paused')
    store.close()
  })

  test('goal_id 不一致时同样拒绝', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    const r = updateGoal(store, {
      conversationId,
      goalId: 'gl_不存在',
      revision: goal.revision,
      action: 'pause',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('stale_goal')
    store.close()
  })

  test('completed 是终态：无法改回', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    const done = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return

    const back = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: done.goal.revision,
      action: 'resume',
    })
    expect(back.ok).toBe(false)
    if (!back.ok) expect(back.code).toBe('illegal_transition')
    store.close()
  })

  /** blocked 必须附带理由：否则循环停止后无人知道原因。 */
  test('blocked 未提供理由时拒绝，提供理由后才写入', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)

    const bare = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'blocked',
    })
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.code).toBe('missing_reason')
    expect(currentGoal(store, conversationId)?.status).toBe('active')

    const withReason = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'blocked',
      blockedReason: '要你去装一下 bun',
    })
    expect(withReason.ok).toBe(true)
    if (!withReason.ok) return
    expect(withReason.goal.blockedReason).toBe('要你去装一下 bun')
    expect(withReason.goal.blockedCode).toBe('needs_human')
    store.close()
  })

  test('edit 必须提供 objective；离开 blocked 时一并清除旧理由', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)

    const bare = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'edit',
    })
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.code).toBe('invalid_objective')

    const blocked = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'blocked',
      blockedReason: '缺依赖',
    })
    expect(blocked.ok).toBe(true)
    if (!blocked.ok) return

    const resumed = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: blocked.goal.revision,
      action: 'resume',
    })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.goal.status).toBe('active')
    expect(resumed.goal.blockedReason).toBeNull()
    expect(resumed.goal.blockedCode).toBeNull()
    store.close()
  })
})

describe('回放校验', () => {
  /**
   * 两种损坏形状都只能通过绕过本模块直接写表来构造。
   * 应当抛出异常：以来源不明的状态继续自动运行，比停止并报错糟糕得多。
   */
  test('revision 断号：抛出异常，不返回推测的值', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    store.db
      .query(
        `INSERT INTO goal_events (goal_id, conversation_id, revision, snapshot, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(goal.id, conversationId, 5, JSON.stringify({ ...goal, revision: 5 }), Date.now())
    expect(() => currentGoal(store, conversationId)).toThrow(/断号/)
    store.close()
  })

  test('非法转移：抛出异常', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    const done = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'complete',
    })
    expect(done.ok).toBe(true)
    store.db
      .query(
        `INSERT INTO goal_events (goal_id, conversation_id, revision, snapshot, created_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(goal.id, conversationId, 3, JSON.stringify({ ...goal, revision: 3 }), Date.now())
    expect(() => currentGoal(store, conversationId)).toThrow(/非法转移/)
    store.close()
  })

  test('同一个 revision 写入两次时被主键拒绝，不静默追加第二条', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    expect(() =>
      store.db
        .query(
          `INSERT INTO goal_events (goal_id, conversation_id, revision, snapshot, created_at)
           VALUES (?,?,?,?,?)`,
        )
        .run(goal.id, conversationId, 1, JSON.stringify(goal), Date.now()),
    ).toThrow()
    store.close()
  })
})
