import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { TodoItem } from '@qywork/core'
import { writeTodosTool } from './todos.ts'

function ctx(): ToolContext & { emitted: TodoItem[][] } {
  const emitted: TodoItem[][] = []
  return {
    emitted,
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
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

  test('回执里也带整表 —— 模型下一轮据此接着改', async () => {
    const { r } = await run([{ content: '第一步', status: 'in_progress' }])
    expect((r.data as { todos: TodoItem[] }).todos[0]!.content).toBe('第一步')
  })

  /**
   * 口径与输入框上那条状态条一致：数的是「正在做第几步」，不是「做完了几步」。
   * 两处各数各的话，同一屏上卡片写「0/5」而状态条写「第 1 / 5 步」。
   */
  test('message 报的是正在做第几步 —— 与状态条同一个数', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'in_progress' },
    ])
    expect(r.message).toBe('第 2/2 步：乙')
  })

  test('没有进行中的那条时说出来 —— 打完勾不认领下一条正是停在半路的样子', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'pending' },
    ])
    expect(r.message).toBe('已完成 1/2 步，未认领下一条')
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

    const final = c.emitted[1]!
    expect(final).toHaveLength(2)
    expect(final.some((t) => t.content === '旧计划')).toBe(false)
  })

  test('id 由序号生成，不受模型输入影响', async () => {
    const { c } = await run([
      { content: 'a', status: 'pending', id: '模型自造的 id' },
      { content: 'b', status: 'pending' },
    ])
    expect(c.emitted[0]!.map((t) => t.id)).toEqual(['todo_1', 'todo_2'])
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

  test('拒绝时不改动已有清单 —— 前端手上还是上一份', async () => {
    const c = ctx()
    await run([{ content: '好计划', status: 'in_progress' }], c)
    await run(
      [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress' },
      ],
      c,
    )
    expect(c.emitted).toHaveLength(1)
    expect(c.emitted[0]![0]!.content).toBe('好计划')
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

  test('超过上限被拒 —— 提示拆分任务', async () => {
    const { r } = await run(
      Array.from({ length: 41 }, (_, i) => ({ content: `第 ${i}`, status: 'pending' })),
    )
    expect(r.status).toBe('failure')
    expect(r.message).toContain('拆分任务')
  })

  test('零条 in_progress 是合法的（全做完了）', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'completed' },
    ])
    expect(r.status).toBe('success')
    expect(r.message).toBe('2 步全部完成')
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
 * 动作语义。别为它专造一个 `plan` 动作：配上对象「待办」，界面上读出来是
 * 「规划待办」——动宾同义反复。
 *
 * 判据走 `ctx.todos`（会话级端口，读的是账本里上一条 `write_todos` step），
 * **不是** `ctx.state`：那个 Map 是 run 级的，跨轮查不到上一份清单，
 * 表现是每轮的第一次提交都说「创建」。拍成常量是反过来的同一个毛病。
 */
describe('动作语义：首建是创建，改已有的才是编辑', () => {
  const kindWith = (prev: TodoItem[] | null) =>
    (writeTodosTool.actionKind as (a: Record<string, unknown>, c?: ToolContext) => string)({}, {
      todos: { read: () => prev },
    } as ToolContext)

  test('没有上一份清单 —— 创建', () => {
    expect(kindWith(null)).toBe('write')
  })

  test('上一份还没做完 —— 修改', () => {
    expect(
      kindWith([
        { id: 'todo_1', content: '甲', status: 'completed' },
        { id: 'todo_2', content: '乙', status: 'in_progress' },
      ]),
    ).toBe('edit')
  })

  /** 上一份全做完了，再提交一份是**下一件事**的清单，说「创建」才对。 */
  test('上一份全做完 —— 又是创建', () => {
    expect(kindWith([{ id: 'todo_1', content: '甲', status: 'completed' }])).toBe('write')
  })

  /**
   * 端口没接上（`qy exec` 这类一次性执行没有会话）时按「创建」。
   * 反过来说「修改」是在没有清单时声称改过一份不存在的清单。
   */
  test('端口没接上 —— 按创建，不按修改', () => {
    const spec = writeTodosTool.actionKind as (
      a: Record<string, unknown>,
      c?: ToolContext,
    ) => string
    expect(spec({}, undefined)).toBe('write')
    expect(spec({}, {} as ToolContext)).toBe('write')
  })

  /** 对象是「待办」不是「计划」：计划（方案）是另一类产物，这个工具不产出它。 */
  test('对象恒为「待办」', () => {
    expect(writeTodosTool.objectLabel).toBe('待办')
  })
})
