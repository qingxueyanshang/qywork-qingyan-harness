/**
 * 覆盖 `todos.ts` 的 `write_todos`：整表替换、状态与受阻、失败原因的校验、回执，
 * 以及提交的清单经执行循环（`agent/loop/turn-end.ts`）决定继续还是停下等待用户。
 */

import { describe, expect, test } from 'bun:test'
import { AgentLoop, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { AgentEvent, TodoItem } from '@qywork/core'
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

describe('受阻：唯一的停下等待用户的方式', () => {
  test('blocked 带类别与所需条件时接受，回执写明其余步骤受阻', async () => {
    const { r, c } = await run([
      { content: '生成样张', status: 'completed' },
      { content: '生成其余页面', status: 'blocked', blocker: 'review', need: ' 用户查看样张 ' },
    ])
    expect(r.status).toBe('success')
    expect(r.message).toBe('已完成 1/2 步，其余 1 步受阻')
    expect(c.emitted[0]![1]).toEqual({
      id: 'todo_2',
      content: '生成其余页面',
      status: 'blocked',
      blocker: 'review',
      need: '用户查看样张',
    })
  })

  /** strict 模式把未填写的可选参数写成 null：非受阻条目带 null 不是填写了受阻原因。 */
  test('非受阻条目的 blocker 与 need 为 null 或空字符串时按未填写处理', async () => {
    const { r, c } = await run([
      { content: '甲', status: 'in_progress', blocker: null, need: null },
      { content: '乙', status: 'pending', blocker: null, need: '' },
    ])
    expect(r.status).toBe('success')
    expect(c.emitted[0]).toEqual([
      { id: 'todo_1', content: '甲', status: 'in_progress' },
      { id: 'todo_2', content: '乙', status: 'pending' },
    ])
  })

  test('blocked 缺少类别或所需条件时拒绝，指出是第几条与可选类别', async () => {
    for (const row of [
      { content: '乙', status: 'blocked' },
      { content: '乙', status: 'blocked', blocker: 'spend' },
      { content: '乙', status: 'blocked', need: '用户决定方案' },
      { content: '乙', status: 'blocked', blocker: null, need: null },
    ]) {
      const { r, c } = await run([{ content: '甲', status: 'completed' }, row])
      expect(r.status).toBe('failure')
      expect(r.errorKind).toBe('invalid_plan')
      expect(r.message).toContain('第 2 条标为 blocked')
      expect(r.message).toContain('spend、user_only、review、irreversible 之一')
      expect(c.emitted).toHaveLength(0)
    }
  })

  /**
   * 闭集之外的类别不是受阻：「需要用户选择方案」与外部服务故障都不在等待用户之列，
   * 拒绝后模型只能继续执行，或在重试之后标为 failed。
   */
  test('类别不在闭集内时拒绝，外部服务故障不能标为受阻', async () => {
    for (const blocker of ['decision', 'service']) {
      const { r } = await run([
        { content: '甲', status: 'blocked', blocker, need: '用户在两种方案中选择' },
      ])
      expect(r.status).toBe('failure')
      expect(r.message).toContain('不是受阻')
      expect(r.message).toContain('标为 failed')
    }
  })

  test('其余状态填写受阻或失败原因时拒绝，并指出多出的字段', async () => {
    const pending = await run([
      { content: '甲', status: 'pending', blocker: 'spend', need: '用户确认费用' },
    ])
    expect(pending.r.status).toBe('failure')
    expect(pending.r.message).toContain('第 1 条的 status 为 pending，不填写 blocker、need')
    const blocked = await run([
      { content: '甲', status: 'blocked', blocker: 'spend', need: '用户确认费用', cause: '额度' },
    ])
    expect(blocked.r.message).toContain('第 1 条的 status 为 blocked，不填写 cause')
  })

  test('受阻条目不计入 in_progress 上限', async () => {
    const { r } = await run([
      { content: '甲', status: 'blocked', blocker: 'user_only', need: '用户扫码登录' },
      { content: '乙', status: 'in_progress' },
    ])
    expect(r.status).toBe('success')
    expect(r.message).toBe('第 2/2 步：乙')
  })
})

/**
 * 清单经由本工具提交后，执行循环按其中的状态决定本轮是否结束。
 * 两个形状都取自账本：模型标记完成后未认领下一条即结束回复（应继续执行），
 * 以及未完成项全部标为受阻（应停下等待用户，停止依据写明受阻条件）。
 */
describe('提交的清单与本轮结束', () => {
  async function runLoop(turns: Parameters<typeof fakeAdapter>[0]) {
    const registry = new ToolRegistry()
    registry.register(writeTodosTool)
    let ledger: TodoItem[] | null = null
    const tails: string[] = []
    const inner = fakeAdapter(turns)
    const loop = new AgentLoop({
      adapter: {
        ...inner,
        async *stream(req) {
          tails.push(String(req.messages[req.messages.length - 1]?.content))
          yield* inner.stream(req)
        },
      },
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        todos: { read: () => ledger },
        emitTodos: (todos) => {
          ledger = todos
        },
      }),
    })
    let finished: AgentEvent | null = null
    for await (const event of loop.run({
      runId: 'rn_todos_loop' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === 'run.finished') finished = event
    }
    return { finished: finished!, tails }
  }

  const checked = { content: '核对画布', status: 'completed' }
  const switched = { content: '切换视频卡模型', status: 'completed' }

  test('标记完成后未认领下一条即结束回复：继续执行，清单完成后才结束', async () => {
    const { finished, tails } = await runLoop([
      [
        call('write_todos', {
          todos: [checked, switched, { content: '并行生成视频', status: 'pending' }],
        }),
      ],
      null,
      [
        call('write_todos', {
          todos: [checked, switched, { content: '并行生成视频', status: 'completed' }],
        }),
      ],
      null,
    ])
    expect(finished).toMatchObject({ status: 'done', stopReason: 'completed' })
    expect(tails).toHaveLength(4)
    expect(tails[2]).toContain('本轮待办尚有未完成的项：并行生成视频。')
  })

  test('其余项完成、一项失败：本轮完成，停止依据写明失败原因', async () => {
    const { finished } = await runLoop([
      [
        call('write_todos', {
          todos: [
            checked,
            switched,
            {
              content: '并行生成视频',
              status: 'failed',
              cause: '余额不足',
              attempts: '额度用尽不重试',
            },
          ],
        }),
      ],
      null,
    ])
    expect(finished).toMatchObject({ status: 'done', stopReason: 'completed' })
    expect(finished.type === 'run.finished' && finished.stopDetail).toBe(
      '失败：余额不足，已尝试：额度用尽不重试',
    )
  })

  test('未完成项全部标为受阻：停下等待用户，停止依据写明受阻条件', async () => {
    const { finished, tails } = await runLoop([
      [
        call('write_todos', {
          todos: [
            checked,
            switched,
            {
              content: '并行生成视频',
              status: 'blocked',
              blocker: 'spend',
              need: '用户同意重新生成 37 张资产图的费用',
            },
          ],
        }),
      ],
      null,
    ])
    expect(finished).toMatchObject({ status: 'done', stopReason: 'awaiting_user' })
    expect(finished.type === 'run.finished' && finished.stopDetail).toBe(
      '花费待确认：用户同意重新生成 37 张资产图的费用',
    )
    expect(tails).toHaveLength(2)
  })
})

describe('失败：重试之后仍无法完成的终态', () => {
  test('failed 带原因与尝试时接受，回执写明其余步骤失败', async () => {
    const { r, c } = await run([
      { content: '生成样张', status: 'completed' },
      {
        content: '生成第 4 页',
        status: 'failed',
        cause: 'HTTP 429 限流',
        attempts: '系统在 30 秒、2 分钟、5 分钟后各重试一次',
        blocker: null,
        need: null,
      },
    ])
    expect(r.status).toBe('success')
    expect(r.message).toBe('已完成 1/2 步，其余 1 步失败')
    expect(c.emitted[0]![1]).toEqual({
      id: 'todo_2',
      content: '生成第 4 页',
      status: 'failed',
      cause: 'HTTP 429 限流',
      attempts: '系统在 30 秒、2 分钟、5 分钟后各重试一次',
    })
  })

  test('failed 缺少原因或尝试时拒绝', async () => {
    for (const row of [
      { content: '乙', status: 'failed' },
      { content: '乙', status: 'failed', cause: 'HTTP 403' },
      { content: '乙', status: 'failed', attempts: '未重试' },
    ]) {
      const { r, c } = await run([row])
      expect(r.status).toBe('failure')
      expect(r.message).toContain('第 1 条标为 failed，必须填写 cause')
      expect(c.emitted).toHaveLength(0)
    }
  })

  test('受阻与失败并存时回执分别计数', async () => {
    const { r } = await run([
      { content: '甲', status: 'completed' },
      { content: '乙', status: 'blocked', blocker: 'review', need: '用户查看样张' },
      { content: '丙', status: 'failed', cause: 'HTTP 403', attempts: '不重试' },
    ])
    expect(r.message).toBe('已完成 1/3 步，其余 1 步受阻、1 步失败')
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
