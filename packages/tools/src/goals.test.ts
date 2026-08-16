/**
 * 三个目标工具的行为回归。**覆盖范围**：`goals.ts`。
 *
 * 这一层只验**工具与端口之间**那一段：参数怎么归一化、端口缺席时怎么降级、
 * 拒绝理由有没有原样带给模型。生命周期规则本身在 `store/goals.test.ts`，
 * 续起循环在 `server/goal-loop.test.ts`——三处各管一段，不互相重复。
 */

import { describe, expect, test } from 'bun:test'
import type { GoalPort, ToolContext } from '@qywork/agent'
import type { Goal, GoalWriteResult } from '@qywork/core'
import { createGoalTool, readGoalTool, updateGoalTool } from './goals.ts'

const SAMPLE: Goal = {
  id: 'gl_1' as Goal['id'],
  conversationId: 'cv_1' as Goal['conversationId'],
  objective: '把测试跑绿',
  status: 'active',
  round: 2,
  maxRounds: 5,
  revision: 7,
  blockedCode: null,
  blockedReason: null,
  createdAt: 0,
  updatedAt: 0,
}

interface Spy {
  created: { objective: string; maxRounds?: number }[]
  updated: Parameters<GoalPort['update']>[0][]
}

function ctx(opts?: { goal?: Goal | null; result?: GoalWriteResult }): ToolContext & { spy: Spy } {
  const spy: Spy = { created: [], updated: [] }
  const port: GoalPort = {
    read: () => opts?.goal ?? null,
    create: (input) => {
      spy.created.push(input)
      return opts?.result ?? { ok: true, goal: SAMPLE }
    },
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

describe('降级：没有目标账本时三个工具都要说得出为什么', () => {
  test.each([
    ['read_goal', readGoalTool, {}],
    ['create_goal', createGoalTool, { objective: 'x' }],
    ['update_goal', updateGoalTool, { goal_id: 'gl_1', revision: 1, action: 'pause' }],
  ] as const)('%s 明确失败，不假装记下了', async (_name, tool, args) => {
    const r = await tool.fn(args as Record<string, unknown>, bare())
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('no_goal_store')
    expect(r.message).toContain('目标账本')
  })
})

describe('read_goal', () => {
  test('有目标时把轮次与 revision 一并说出来 —— 模型改它要用', async () => {
    const r = await readGoalTool.fn({}, ctx({ goal: SAMPLE }))
    expect(r.status).toBe('success')
    expect(r.message).toContain('gl_1')
    expect(r.message).toContain('第 2/5 轮')
    expect(r.message).toContain('revision 7')
    expect(r.message).toContain('把测试跑绿')
  })

  test('没目标不是失败', async () => {
    const r = await readGoalTool.fn({}, ctx({ goal: null }))
    expect(r.status).toBe('success')
    expect((r.data as { goal: Goal | null }).goal).toBeNull()
  })
})

describe('create_goal', () => {
  test('不给 max_rounds 就不往端口塞一个自己编的值', async () => {
    const c = ctx()
    await createGoalTool.fn({ objective: '把测试跑绿' }, c)
    expect(c.spy.created).toEqual([{ objective: '把测试跑绿' }])
  })

  test('max_rounds 是字符串也认 —— 模型两种都发得出来', async () => {
    const c = ctx()
    await createGoalTool.fn({ objective: 'x', max_rounds: '4' }, c)
    expect(c.spy.created[0]?.maxRounds).toBe(4)
  })

  /** 拒绝理由必须原样到模型手里：它得知道是哪一种才能换个做法。 */
  test('端口拒绝时原样带回理由与 code', async () => {
    const c = ctx({ result: { ok: false, code: 'goal_exists', message: '已经有一个目标了' } })
    const r = await createGoalTool.fn({ objective: 'x' }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('goal_exists')
    expect(r.message).toBe('已经有一个目标了')
  })
})

describe('update_goal', () => {
  test('五个动作共用一个门面，参数原样转给端口', async () => {
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
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: '第七版', action: 'pause' }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_revision')
    expect(c.spy.updated).toHaveLength(0)
  })

  /**
   * 进了终态还说「这一轮做完会自动继续」的话，模型会把该说给用户的话
   * 留到一个不会发生的轮次里。
   */
  test('回执要说清循环还在不在', async () => {
    const done: Goal = { ...SAMPLE, status: 'completed', revision: 8 }
    const c = ctx({ result: { ok: true, goal: done } })
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 7, action: 'complete' }, c)
    expect(r.message).toContain('不会再自动续起')

    const alive = ctx()
    const r2 = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 7, action: 'resume' }, alive)
    expect(r2.message).toContain('自动继续')
  })
})

describe('条件必填写进了 description —— 不能只靠运行期拦', () => {
  /**
   * 只在运行期拦的代价是实打实的：模型得先废一整轮往返才知道该给哪个参数。
   * 锁的是「这两个参数名连同它所属的动作出现在描述里」，不锁具体措辞。
   */
  test('edit 要 objective、blocked 要 blocked_reason', () => {
    expect(updateGoalTool.description).toContain('objective')
    expect(updateGoalTool.description).toContain('blocked_reason')
  })

  test('三个工具都写明了「只有轮数上限，不是资源预算」', () => {
    for (const tool of [readGoalTool, createGoalTool]) {
      expect(tool.description).toContain('max_rounds')
      expect(tool.description).toContain('不计 token')
    }
  })
})
