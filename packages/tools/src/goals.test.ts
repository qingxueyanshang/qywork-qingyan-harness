/**
 * 两个目标工具的行为回归。**覆盖范围**：`goals.ts`。
 *
 * 本文件只验证工具与端口之间的部分：参数如何规范化、端口缺失时如何降级、
 * 拒绝理由是否原样交给模型。生命周期规则由 `store/goals.test.ts` 覆盖，
 * 自动继续循环与用户设定目标的路径由 `server/goal-loop.test.ts` 覆盖，
 * 三处各自负责一部分，互不重复。
 */

import { describe, expect, test } from 'bun:test'
import type { GoalPort, ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
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
    density: DEFAULT_DENSITY,
    resources: new Map(),
    state: new Map(),
    sink: null,
    goals: port,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  } as unknown as ToolContext & { spy: Spy }
}

/** 未接入端口的上下文（如 `qy exec`）。 */
function bare(): ToolContext {
  const c = ctx()
  delete (c as { goals?: unknown }).goals
  return c
}

describe('降级：没有目标账本时两个工具都说明原因', () => {
  test('read_goal 明确返回失败，不伪装为读取成功', async () => {
    const r = await readGoalTool.fn({}, bare())
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('no_goal_store')
    expect(r.message).toContain('目标账本')
  })

  test('update_goal 明确返回失败，不伪装为已记录', async () => {
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 1, action: 'complete' }, bare())
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('no_goal_store')
    expect(r.message).toContain('目标账本')
  })
})

describe('read_goal', () => {
  test('有目标时返回 id 与 revision，供模型结束目标时使用', async () => {
    const r = await readGoalTool.fn({}, ctx({ goal: SAMPLE }))
    expect(r.status).toBe('success')
    expect(r.message).toContain('gl_1')
    expect(r.message).toContain('revision 7')
    expect(r.message).toContain('把测试跑绿')
  })

  test('没有目标不视为失败', async () => {
    const r = await readGoalTool.fn({}, ctx({ goal: null }))
    expect(r.status).toBe('success')
    expect((r.data as { goal: Goal | null }).goal).toBeNull()
  })
})

/**
 * 设定目标不是模型的操作：模型须在第二步就判断该任务是否需要跨轮，而该信息
 * 在那一步无法取得。账本中有一次实例：模型在开始时设定了 8 轮目标，在同一个 run 中
 * 自行 complete，自动继续未发生，用户始终只看到「第 0 / 8 轮」。
 */
describe('模型无法设定、修改或暂停目标', () => {
  test('工具表中没有 create_goal', async () => {
    const mod = (await import('./goals.ts')) as Record<string, unknown>
    expect(Object.keys(mod).some((k) => k.toLowerCase().includes('create'))).toBe(false)
  })

  test.each(['edit', 'pause', 'resume'] as const)('%s 被立即拒绝，不交给端口', async (action) => {
    const c = ctx()
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 7, action }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_action')
    expect(c.spy.updated).toHaveLength(0)
  })

  /** 参数同步删除：保留无用的 objective 参数时，模型会按它填写一轮。 */
  test('schema 中没有 objective 参数', () => {
    const props = (updateGoalTool.parameters as { properties: Record<string, unknown> }).properties
    expect(Object.keys(props)).not.toContain('objective')
  })
})

describe('update_goal', () => {
  test('两个动作共用一个门面，参数原样转交端口', async () => {
    const c = ctx()
    await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: 7, action: 'blocked', blocked_reason: '缺依赖' },
      c,
    )
    expect(c.spy.updated).toEqual([
      { goalId: 'gl_1', revision: 7, action: 'blocked', blockedReason: '缺依赖' },
    ])
  })

  test('无法识别的 action 被立即拒绝，不交给端口', async () => {
    const c = ctx()
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 1, action: 'abandon' }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_action')
    expect(c.spy.updated).toHaveLength(0)
  })

  test('revision 不是整数时立即拒绝', async () => {
    const c = ctx()
    const r = await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: '第七版', action: 'complete' },
      c,
    )
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_revision')
    expect(c.spy.updated).toHaveLength(0)
  })

  /** 拒绝理由必须原样交给模型：模型需要知道拒绝类型才能调整做法。 */
  test('端口拒绝时原样返回理由与 code', async () => {
    const c = ctx({ result: { ok: false, code: 'stale_revision', message: 'revision 已经是 9' } })
    const r = await updateGoalTool.fn({ goal_id: 'gl_1', revision: 7, action: 'complete' }, c)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('stale_revision')
    expect(r.message).toBe('revision 已经是 9')
  })

  /**
   * 两个动作都使目标进入终态，因此回执必须说明循环已结束。
   * 回执表述为本轮完成后自动继续时，模型会把应告知用户的内容留到一个
   * 不会发生的轮次中。
   */
  test('回执说明循环已停止', async () => {
    const done: Goal = { ...SAMPLE, status: 'completed', revision: 8 }
    const r = await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: 7, action: 'complete' },
      ctx({ result: { ok: true, goal: done } }),
    )
    expect(r.message).toContain('不再自动继续')

    const stuck: Goal = { ...SAMPLE, status: 'blocked', revision: 8, blockedReason: '缺依赖' }
    const r2 = await updateGoalTool.fn(
      { goal_id: 'gl_1', revision: 7, action: 'blocked', blocked_reason: '缺依赖' },
      ctx({ result: { ok: true, goal: stuck } }),
    )
    expect(r2.message).toContain('自动继续已停止')
  })
})

describe('条件必填写入 description，不只依赖运行期拦截', () => {
  /**
   * 只在运行期拦截时，模型须多消耗一轮往返才能得知应提供哪个参数。
   * 断言参数名与其所属动作出现在描述中，不断言具体措辞。
   */
  test('blocked 需要 blocked_reason', () => {
    expect(updateGoalTool.description).toContain('blocked_reason')
  })

  /**
   * 循环没有自动停止条件，这一点必须写在两个工具的描述中：不写时模型会假定存在
   * 轮数或预算上限，未完成即交回，而循环实际会持续运行。
   */
  test('两个工具都写明循环不会自动停止', () => {
    for (const tool of [readGoalTool, updateGoalTool]) {
      expect(tool.description).toContain('没有轮数上限')
      expect(tool.description).toContain('一直自动继续')
    }
  })
})
