import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
import type { TodoItem } from '@qywork/core'
import { TODOS_STATE_KEY, writeTodosTool } from './todos.ts'

function ctx(): ToolContext & { emitted: TodoItem[][] } {
  const emitted: TodoItem[][] = []
  return {
    emitted,
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    emitTodos: (t) => emitted.push(t),
    requestPermission: async () => true,
  } as ToolContext & { emitted: TodoItem[][] }
}

const run = (todos: unknown, c = ctx()) => writeTodosTool.fn({ todos }, c).then((r) => ({ r, c }))

describe('todos 事件终于有了生产者', () => {
  test('提交待办会广播整表快照', async () => {
    const { r, c } = await run([
      { content: '读现有实现', status: 'completed' },
      { content: '改造 token.ts', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
    ])
    expect(r.status).toBe('success')
    expect(c.emitted).toHaveLength(1)
    expect(c.emitted[0]).toHaveLength(3)
    expect(c.emitted[0]![1]!.status).toBe('in_progress')
  })

  test('没有 emitTodos 装配时不炸 —— 工具照样记账', async () => {
    const bare = ctx()
    delete (bare as { emitTodos?: unknown }).emitTodos
    const r = await writeTodosTool.fn({ todos: [{ content: 'x', status: 'pending' }] }, bare)
    expect(r.status).toBe('success')
  })

  test('清单存进 ctx.state，整个 run 共用一份', async () => {
    const { c } = await run([{ content: '第一步', status: 'in_progress' }])
    expect((c.state.get(TODOS_STATE_KEY) as TodoItem[])[0]!.content).toBe('第一步')
  })

  test('message 里带进度与当前步骤 —— 模型读的是 message', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'in_progress' },
    ])
    expect(r.message).toContain('1/2')
    expect(r.message).toContain('乙')
  })
})

describe('整表替换语义', () => {
  test('第二次提交完全覆盖第一次', async () => {
    const c = ctx()
    await run([{ content: '旧计划', status: 'pending' }], c)
    await run(
      [
        { content: '新计划甲', status: 'in_progress' },
        { content: '新计划乙', status: 'pending' },
      ],
      c,
    )

    const final = c.state.get(TODOS_STATE_KEY) as TodoItem[]
    expect(final).toHaveLength(2)
    expect(final.some((t) => t.content === '旧计划')).toBe(false)
  })

  test('id 由序号生成，不受模型输入影响', async () => {
    const { c } = await run([
      { content: 'a', status: 'pending', id: '模型瞎给的 id' },
      { content: 'b', status: 'pending' },
    ])
    const todos = c.state.get(TODOS_STATE_KEY) as TodoItem[]
    expect(todos.map((t) => t.id)).toEqual(['todo_1', 'todo_2'])
  })
})

describe('硬约束：拒绝而不是静默纠正', () => {
  test('两条 in_progress 直接拒绝', async () => {
    const { r, c } = await run([
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'in_progress' },
    ])
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_plan')
    expect(r.message).toContain('只能有一条')
    // 拒绝就不该广播 —— 广播了前端会显示一份服务端并不认可的清单。
    expect(c.emitted).toHaveLength(0)
  })

  test('拒绝时不改动已有清单', async () => {
    const c = ctx()
    await run([{ content: '好计划', status: 'in_progress' }], c)
    await run(
      [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress' },
      ],
      c,
    )
    expect((c.state.get(TODOS_STATE_KEY) as TodoItem[])[0]!.content).toBe('好计划')
  })

  test('空清单被拒 —— 不需要列清单就别调这个工具', async () => {
    const { r } = await run([])
    expect(r.status).toBe('failure')
  })

  test('非数组被拒', async () => {
    const { r } = await run('不是数组')
    expect(r.status).toBe('failure')
  })

  test('缺 content 被拒且指出是第几条', async () => {
    const { r } = await run([{ content: 'ok', status: 'pending' }, { status: 'pending' }])
    expect(r.status).toBe('failure')
    expect(r.message).toContain('第 2 条')
  })

  test('非法 status 被拒', async () => {
    const { r } = await run([{ content: 'x', status: 'doing' }])
    expect(r.status).toBe('failure')
    expect(r.message).toContain('status')
  })

  test('超过上限被拒 —— 该拆任务了', async () => {
    const { r } = await run(
      Array.from({ length: 41 }, (_, i) => ({ content: `第 ${i}`, status: 'pending' })),
    )
    expect(r.status).toBe('failure')
    expect(r.message).toContain('拆任务')
  })

  test('零条 in_progress 是合法的（全做完了）', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'completed' },
    ])
    expect(r.status).toBe('success')
    expect(r.message).toContain('2/2')
  })
})

describe('权限', () => {
  test('是内部记账，不走权限闸 —— 列个清单不该弹窗打断用户', () => {
    expect(writeTodosTool.permissionEffect).toBe('internal_control')
  })

  test('不可并行 —— 两次并发提交谁赢全看调度', () => {
    expect(writeTodosTool.parallelSafe).toBe(false)
  })
})

/**
 * 动作语义。别为它专造一个 `plan` 动作：配上对象「计划」，界面上读出来是
 * 「规划计划」——动宾同义反复。
 */
describe('动作语义：首建是创建，改未完成的才是编辑', () => {
  const kindOf = (c?: ToolContext) => {
    const k = writeTodosTool.actionKind
    return typeof k === 'function' ? k({}, c) : k
  }

  test('还没有计划 → 创建', () => {
    expect(kindOf(ctx())).toBe('write')
  })

  test('有一份没做完的计划 → 编辑', async () => {
    const { c } = await run([
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'pending' },
    ])
    expect(kindOf(c)).toBe('edit')
  })

  /** 上一份全做完了，再提交一份就是新一轮的计划，不是修订。 */
  test('上一份全做完 → 又是创建', async () => {
    const { c } = await run([{ content: '甲', status: 'completed' }])
    expect(kindOf(c)).toBe('write')
  })

  /** 权限预检那条路拿不到 ctx。说「创建」最多把修订说小了，说「编辑」是声称改过一份不存在的东西。 */
  test('拿不到 ctx 时按创建，不按编辑', () => {
    expect(kindOf(undefined)).toBe('write')
  })

  /** 对象是「待办」不是「计划」：计划（方案）是另一件东西，这个工具不产出它。 */
  test('对象恒为「待办」', () => {
    expect(writeTodosTool.objectLabel).toBe('待办')
  })
})
