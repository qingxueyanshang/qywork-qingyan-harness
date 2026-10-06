import { describe, expect, test } from 'bun:test'
import { AgentLoop, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { TodoItem } from '@qywork/core'
import {
  baseCtx,
  call,
  fakeAdapter,
  noopPersistence,
} from '../../agent/src/loop/fixtures.test-helper.ts'
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
    requestPermission: async () => ({ allowed: true }),
  } as ToolContext & { emitted: TodoItem[][] }
}

const run = (todos: unknown, c = ctx()) => writeTodosTool.fn({ todos }, c).then((r) => ({ r, c }))

describe('todos 事件的生产者', () => {
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

  test('未装配 emitTodos 时不抛错，工具仍记账', async () => {
    const bare = ctx()
    delete (bare as { emitTodos?: unknown }).emitTodos
    const r = await writeTodosTool.fn({ todos: [{ content: 'x', status: 'pending' }] }, bare)
    expect(r.status).toBe('success')
  })

  test('回执中也包含整表：模型下一轮据此继续修改', async () => {
    const { r } = await run([{ content: '第一步', status: 'in_progress' }])
    expect((r.data as { todos: TodoItem[] }).todos[0]!.content).toBe('第一步')
  })

  /**
   * 口径与输入框上方的状态条一致：计数的是正在执行第几步，而不是已完成几步。
   * 两处各自计数时，同一屏上卡片显示「0/5」而状态条显示「第 1 / 5 步」。
   */
  test('message 报告正在执行第几步，与状态条的数值一致', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'in_progress' },
    ])
    expect(r.message).toBe('第 2/2 步：乙')
  })

  test('没有进行中的条目时明确说明：标记完成后未认领下一条会使清单停滞在中途', async () => {
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
  test('相同非法待办连续三轮后停止，不修改待办账本', async () => {
    const registry = new ToolRegistry()
    registry.register(writeTodosTool)
    const emitted: TodoItem[][] = []
    const loop = new AgentLoop({
      adapter: fakeAdapter(Array.from({ length: 10 }, () => [call('write_todos', { todos: [] })])),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        emitTodos: (todos) => emitted.push(todos),
      }),
    })
    let results = 0
    let stopReason: string | undefined
    for await (const event of loop.run({
      runId: 'rn_invalid_todos' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === 'tool.finished') {
        results++
        expect(event.outcome).toMatchObject({
          status: 'failure',
          executed: false,
          errorKind: 'invalid_plan',
        })
      }
      if (event.type === 'run.finished') stopReason = event.stopReason
    }
    expect(results).toBe(3)
    expect(stopReason).toBe('no_progress')
    expect(emitted).toHaveLength(0)
  })

  test('两条 in_progress 直接拒绝', async () => {
    const { r, c } = await run([
      { content: '甲', status: 'in_progress' },
      { content: '乙', status: 'in_progress' },
    ])
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('invalid_plan')
    expect(r.message).toContain('只能有一条')
    // 拒绝时不应广播：广播后前端会显示一份服务端并不认可的清单。
    expect(c.emitted).toHaveLength(0)
  })

  test('拒绝时不改动已有清单：前端保留上一份', async () => {
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

  test('空清单被拒绝：不需要清单时不应调用本工具', async () => {
    const { r } = await run([])
    expect(r.status).toBe('failure')
  })

  test('非数组被拒绝', async () => {
    const { r } = await run('不是数组')
    expect(r.status).toBe('failure')
  })

  test('缺少 content 时被拒绝并指出是第几条', async () => {
    const { r } = await run([{ content: 'ok', status: 'pending' }, { status: 'pending' }])
    expect(r.status).toBe('failure')
    expect(r.message).toContain('第 2 条')
  })

  test('非法 status 被拒绝', async () => {
    const { r } = await run([{ content: 'x', status: 'doing' }])
    expect(r.status).toBe('failure')
    expect(r.message).toContain('status')
  })

  test('超过上限被拒绝并提示拆分任务', async () => {
    const { r } = await run(
      Array.from({ length: 41 }, (_, i) => ({ content: `第 ${i}`, status: 'pending' })),
    )
    expect(r.status).toBe('failure')
    expect(r.message).toContain('拆分任务')
  })

  test('零条 in_progress 是合法的（全部已完成）', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'completed' },
    ])
    expect(r.status).toBe('success')
    expect(r.message).toBe('2 步全部完成')
  })
})

describe('权限', () => {
  test('属于内部记账，不经过权限检查：列出清单不应弹窗打断用户', () => {
    expect(writeTodosTool.permissionEffect).toBe('internal_control')
  })

  test('不可并行：两次并发提交的结果取决于调度顺序', () => {
    expect(writeTodosTool.parallelSafe).toBe(false)
  })
})

/**
 * 动作语义。不要为它新增 `plan` 动作：与对象「待办」组合后，界面上读作
 * 「规划待办」，动宾语义重复。
 *
 * 判据使用 `ctx.todos`（会话级端口，读取账本中上一条 `write_todos` step），
 * 而不是 `ctx.state`：该 Map 是 run 级的，跨轮无法查到上一份清单，
 * 结果是每轮的第一次提交都显示「创建」。硬编码为常量是方向相反的同类缺陷。
 */
describe('动作语义：首次提交是创建，修改已有清单才是编辑', () => {
  const kindWith = (prev: TodoItem[] | null) =>
    (writeTodosTool.actionKind as (a: Record<string, unknown>, c?: ToolContext) => string)({}, {
      todos: { read: () => prev },
    } as ToolContext)

  test('没有上一份清单：创建', () => {
    expect(kindWith(null)).toBe('write')
  })

  test('上一份尚未全部完成：修改', () => {
    expect(
      kindWith([
        { id: 'todo_1', content: '甲', status: 'completed' },
        { id: 'todo_2', content: '乙', status: 'in_progress' },
      ]),
    ).toBe('edit')
  })

  /** 上一份已全部完成时，再提交的是下一项任务的清单，应显示「创建」。 */
  test('上一份已全部完成：视为创建', () => {
    expect(kindWith([{ id: 'todo_1', content: '甲', status: 'completed' }])).toBe('write')
  })

  /**
   * 端口未接入（`qy exec` 这类一次性执行没有会话）时按「创建」处理。
   * 显示「修改」则是在没有清单时声称修改了一份不存在的清单。
   */
  test('端口未接入：按创建处理，不按修改', () => {
    const spec = writeTodosTool.actionKind as (
      a: Record<string, unknown>,
      c?: ToolContext,
    ) => string
    expect(spec({}, undefined)).toBe('write')
    expect(spec({}, {} as ToolContext)).toBe('write')
  })

  /** 对象是「待办」而不是「计划」：计划（方案）是另一类产物，本工具不产出它。 */
  test('对象始终为「待办」', () => {
    expect(writeTodosTool.objectLabel).toBe('待办')
  })
})
