/**
 * 目标账本的行为回归。**覆盖范围**：`goals.ts`（生命周期、乐观锁、回放校验），
 * 以及迁移 22 建的 `goal_events` 表。
 *
 * 这里锁的是**行为**：谁能改、改完是什么、破损时会不会响。
 * 续起循环那一侧（谁在什么时候调这些函数）在 `server/goal-loop.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import { Store } from './db.ts'
import { advanceGoalRound, createGoal, currentGoal, MAX_MAX_ROUNDS, updateGoal } from './goals.ts'
import { createConversation, upsertWorkspace } from './repos.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, model: 'm', title: 't' })
  return { store, conversationId: conv.id }
}

/** 立一个目标并断言成功，省掉每个用例里的三行解包。 */
function seed(store: Store, conversationId: ReturnType<typeof fresh>['conversationId']) {
  const r = createGoal(store, { conversationId, objective: '把测试跑绿', maxRounds: 3 })
  if (!r.ok) throw new Error(r.message)
  return r.goal
}

describe('立目标', () => {
  test('立完就能读回来，revision 从 1 起、轮次从 0 起', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    expect(goal.revision).toBe(1)
    expect(goal.round).toBe(0)
    expect(goal.status).toBe('active')
    expect(currentGoal(store, conversationId)).toEqual(goal)
    store.close()
  })

  test('没有目标时读回 null，不是抛也不是空对象', () => {
    const { store, conversationId } = fresh()
    expect(currentGoal(store, conversationId)).toBeNull()
    store.close()
  })

  /**
   * 原始失败形状：两个目标并存时，「续起哪一个」没有答案——
   * 而续起是自动发生的，没人会在那一刻被问。
   */
  test('上一个没做完就不许立新的，做完了才放行', () => {
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

  test('max_rounds 越界直接拒，不静默夹到边界值', () => {
    const { store, conversationId } = fresh()
    const r = createGoal(store, { conversationId, objective: 'x', maxRounds: MAX_MAX_ROUNDS + 1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('invalid_max_rounds')
    expect(currentGoal(store, conversationId)).toBeNull()
    store.close()
  })
})

describe('改目标', () => {
  /**
   * 原始失败形状：模型手里的 revision 是几轮之前读到的，照它提交会把中间
   * 那次暂停悄悄覆盖掉——用户按了停，循环却接着跑。
   */
  test('拿旧 revision 提交直接拒，账本一个字节不动', () => {
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

  test('goal_id 对不上也拒', () => {
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

  test('completed 是终态：改不回来', () => {
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

  /** 说明必须带理由——否则循环停了而没人知道为什么。 */
  test('blocked 不给理由就拒，给了才落盘', () => {
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

  test('edit 必须带 objective；离开 blocked 时旧理由一并清掉', () => {
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

describe('轮次', () => {
  test('每续起一轮 +1，版本跟着走；跑满就拒', () => {
    const { store, conversationId } = fresh()
    let goal = seed(store, conversationId) // maxRounds = 3

    for (let i = 1; i <= 3; i++) {
      const r = advanceGoalRound(store, {
        conversationId,
        goalId: goal.id,
        revision: goal.revision,
      })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.goal.round).toBe(i)
      expect(r.goal.revision).toBe(goal.revision + 1)
      goal = r.goal
    }

    const over = advanceGoalRound(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
    })
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.code).toBe('max_rounds')
    store.close()
  })

  test('暂停中的目标不许续起', () => {
    const { store, conversationId } = fresh()
    const goal = seed(store, conversationId)
    const paused = updateGoal(store, {
      conversationId,
      goalId: goal.id,
      revision: goal.revision,
      action: 'pause',
    })
    expect(paused.ok).toBe(true)
    if (!paused.ok) return

    const r = advanceGoalRound(store, {
      conversationId,
      goalId: goal.id,
      revision: paused.goal.revision,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('not_active')
    store.close()
  })
})

describe('回放校验', () => {
  /**
   * 破损的两种形状都直接绕过本模块写表才造得出来。
   * **让它响**：带着一个来历不明的状态继续自动跑，比停下来报错坏得多。
   */
  test('revision 断号：抛，不返回一个「大概是这样」的值', () => {
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

  test('非法转移：抛', () => {
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

  test('同一个 revision 写两次被主键挡住 —— 不静默追加第二条', () => {
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
