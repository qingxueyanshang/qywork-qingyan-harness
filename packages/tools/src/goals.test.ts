/**
 * 两个目标工具的行为回归。**覆盖范围**：`goals.ts`。
 *
 * 这一层只验**工具与端口之间**那一段：参数怎么归一化、端口缺席时怎么降级、
 * 拒绝理由有没有原样带给模型。生命周期规则本身在 `store/goals.test.ts`，
 * 续起循环与「用户立目标」那条路在 `server/goal-loop.test.ts`——
 * 三处各管一段，不互相重复。
 */

import { describe, expect, test } from 'bun:test'
import type { GoalPort, ToolContext } from '@qywork/agent'
import type { Goal, GoalWriteResult } from '@qywork/core'
import { readGoalTool, updateGoalTool } from './goals.ts'

const SAMPLE: Goal = {
  id: 'gl_1' as Goal['id'],
  conversationId: 'cv_1' as Goal['conversationId'],
  objective: '把测试跑绿',
  status: 'active',
  revision: 7,
  blockedCode: null,
  blockedReason: null,
  createdAt: 0,
  updatedAt: 0,
}

interface Spy {
  updated: Parameters<GoalPort['update']>[0][]
}

function ctx(opts?: { goal?: Goal | null; result?: GoalWriteResult }): ToolContext & { spy: Spy } {
  const spy: Spy = { updated: [] }
  const port: GoalPort = {
    read: () => opts?.goal ?? null,
    update: (input) => {
      spy.updated.push(input)
      return opts?.result ?? { ok: true, goal: SAMPLE }
    },
  }
  return {
    spy,
    workspaceRoot: '/tmp',
    conversationId: 'cv_1',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    goals: port,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  } as unknown as ToolContext & { spy: Spy }
}

/** 端口没接上的上下文（`qy exec` 那种）。 */
function bare(): ToolContext {
  const c = ctx()
  delete (c as { goals?: unknown }).goals
  return c
}

describe('降级：没有目标账本时两个工具都要说得出为什么', () => {
  test('read_goal 明确失败，不假装读到了', async () => {
    const r = await readGoalTool.fn({}, bare())
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('no_goal_store')
    expect(r.message).toContain('目标账本')
  })

  test('update_goal 明确失败，不假装记下了', async () => {
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 1, action: 'complete' }, bare())
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('no_goal_store')
    expect(r.message).toContain('目标账本')
  })
})

describe('read_goal', () => {
  test('有目标时把 id 与 revision 说出来 —— 模型收尾要用', async () => {
    const r = await readGoalTool.fn({}, ctx({ goal: SAMPLE }))
    expect(r.status).toBe('success')
    expect(r.message).toContain('gl_1')
    expect(r.message).toContain('revision 7')
    expect(r.message).toContain('把测试跑绿')
  })

  test('没目标不是失败', async () => {
    const r = await readGoalTool.fn({}, ctx({ goal: null }))
    expect(r.status).toBe('success')
    expect((r.data as { goal: Goal | null }).goal).toBeNull()
  })
})

/**
 * **立目标不在模型手里。** 它得在第二步就判「这活要不要跨轮」，而那个信息
 * 它当时没有——账本里留下过一次实证：模型开局立了个 8 轮目标，同一个 run 里
 * 自己 complete 掉，自动续起一轮没起，用户全程只看见「第 0 / 8 轮」。
 */
describe('模型立不了目标，也改不了、停不了', () => {
  test('工具表里没有 create_goal', async () => {
    const mod = (await import('./goals.ts')) as Record<string, unknown>
    expect(Object.keys(mod).some((k) => k.toLowerCase().includes('create'))).toBe(false)
  })

  test.each(['edit', 'pause', 'resume'] as const)('%s 被当场拒，不落到端口上', async (action) => {
    const c = ctx()
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 7, action }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_action')
    expect(c.spy.updated).toHaveLength(0)
  })

  /** 参数也要跟着收：留着一个永远用不上的 objective，模型会照着填一轮。 */
  test('schema 里没有 objective 这个参数', () => {
    const props = (updateGoalTool.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).not.toContain('objective')
  })
})

describe('update_goal', () => {
  test('两个动作共用一个门面，参数原样转给端口', async () => {
    const c = ctx()
    await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: 7, action: 'blocked', blocked_reason: '缺依赖' },
      c,
    )
    expect(c.spy.updated).toEqual([
      { goalId: 'gl_1', revision: 7, action: 'blocked', blockedReason: '缺依赖' },
    ])
  })

  test('认不出的 action 当场拒，不落到端口上', async () => {
    const c = ctx()
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 1, action: 'abandon' }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_action')
    expect(c.spy.updated).toHaveLength(0)
  })

  test('revision 不是整数当场拒', async () => {
    const c = ctx()
    const r = await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: '第七版', action: 'complete' },
      c,
    )
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_revision')
    expect(c.spy.updated).toHaveLength(0)
  })

  /** 拒绝理由必须原样到模型手里：它得知道是哪一种才能换个做法。 */
  test('端口拒绝时原样带回理由与 code', async () => {
    const c = ctx({ result: { ok: false, code: 'stale_revision', message: 'revision 已经是 9' } })
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 7, action: 'complete' }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('stale_revision')
    expect(r.message).toBe('revision 已经是 9')
  })

  /**
   * 两个动作都进终态，所以回执**永远**得说清「循环到此为止」。
   * 说成「这一轮做完会自动继续」的话，模型会把该说给用户的话留到一个
   * 不会发生的轮次里。
   */
  test('回执说清循环停了', async () => {
    const done: Goal = { ...SAMPLE, status: 'completed', revision: 8 }
    const r = await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: 7, action: 'complete' },
      ctx({ result: { ok: true, goal: done } }),
    )
    expect(r.message).toContain('不会再自动续起')

    const stuck: Goal = { ...SAMPLE, status: 'blocked', revision: 8, blockedReason: '缺依赖' }
    const r2 = await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: 7, action: 'blocked', blocked_reason: '缺依赖' },
      ctx({ result: { ok: true, goal: stuck } }),
    )
    expect(r2.message).toContain('自动续起已停止')
  })
})

describe('条件必填写进了 description —— 不能只靠运行期拦', () => {
  /**
   * 只在运行期拦的代价是实打实的：模型得先废一整轮往返才知道该给哪个参数。
   * 锁的是「这个参数名连同它所属的动作出现在描述里」，不锁具体措辞。
   */
  test('blocked 要 blocked_reason', () => {
    expect(updateGoalTool.description).toContain('blocked_reason')
  })

  /**
   * 循环没有自动刹车，这条**必须**写在两个工具的描述里：不写的话模型会以为
   * 有个轮数或预算在兜底，于是「还没做完就先不管了」——而那样它会一直跑下去。
   */
  test('两个工具都写明了「循环不会自己停」', () => {
    for (const tool of [readGoalTool, updateGoalTool]) {
      expect(tool.description).toContain('没有轮数上限')
      expect(tool.description).toContain('自动续起')
    }
  })
})
