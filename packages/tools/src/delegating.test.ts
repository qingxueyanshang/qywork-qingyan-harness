/**
 * 覆盖范围：`subagent.ts`（派一个子 agent）与 `workflow.ts`（派一张图），
 * 以及两者在 `index.ts` 里的注册条件。
 */

import { describe, expect, test } from 'bun:test'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { subagentTool } from './subagent.ts'
import { workflowTool } from './workflow.ts'

type Port = NonNullable<ToolContext['delegate']>
type DispatchInput = Parameters<Port['dispatch']>[0]
type DispatchResult = Awaited<ReturnType<Port['dispatch']>>

function ctx(delegate?: Port): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
    stepId: 'st_test',
    ...(delegate ? { delegate } : {}),
  }
}

function withTodos(c: ToolContext, todos: NonNullable<ToolContext['todos']>): ToolContext {
  return { ...c, todos }
}

/** 一个假的派活端口：记下派了什么，回一个预设结果。 */
function stub(result: DispatchResult) {
  const calls: DispatchInput[] = []
  const port: Port = {
    resolveModel: (name, provider) => ({ provider: provider ?? 'fake', model: name }),
    targets: async () => ({
      roles: [{ id: 'reviewer', name: '审查员', description: '代码审查' }],
      clis: [{ id: 'claude', vendor: 'Anthropic', connected: true }],
    }),
    subagents: async () => [],
    dispatch: async (input) => {
      calls.push(input)
      return result
    },
    runGraph: async () => ({
      ok: true,
      transition: { workflowId: 'unused', phase: 'completed' as const, receipts: [] },
    }),
  }
  return { calls, port }
}

describe('派活工具的注册条件', () => {
  test('没有派活通道时不注册', () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r)
    expect(r.list().some((s) => s.name === 'subagent')).toBe(false)
  })

  test('有通道才注册', () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r, { delegate: true })
    const names = r.list().map((s) => s.name)
    expect(names).toContain('subagent')
    expect(names).toContain('workflow')
  })

  test('workflow schema 用扁平可空判别，不依赖 oneOf/anyOf', () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r, { delegate: true })
    const schema = r.schemas().find((entry) => entry.name === 'workflow')
    expect(schema?.strict).toBe(true)
    const encoded = JSON.stringify(schema?.parameters)
    expect(encoded).not.toContain('oneOf')
    expect(encoded).not.toContain('anyOf')
    const properties = schema?.parameters.properties as Record<string, Record<string, unknown>>
    expect(properties.kind).toBeUndefined()
    expect(properties.decision?.type).toEqual(['string', 'null'])
    expect(properties.decision?.enum).toEqual(['approve', 'revise', null])
    const node = (properties.nodes?.items as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >
    expect(node.kind?.type).toEqual(['string', 'null'])
    // 种类是显式字段：角色 / 临时 / 外部 CLI / 检查点，没有「默认 agent」。
    expect(node.kind?.enum).toEqual(['role', 'temp', 'cli', 'checkpoint', null])
    expect(node.subagent).toBeDefined()
    expect(node.agent).toBeUndefined()
  })
})

describe('派一个子 agent', () => {
  /** 两个及以上子 agent 用 workflow：一次只派一个，同一轮里多次调用串行跑。 */
  test('一次只派一个，不并行', () => {
    expect(subagentTool.parallelSafe).toBe(false)
  })

  test('kind 是 temp 时按名字新建，目标原样交给端口', async () => {
    const s = stub({
      ok: true,
      output: '查完了',
      subagentId: 'cv_1',
      name: '查资料',
      created: true,
    })
    const res = await subagentTool.fn(
      { kind: 'temp', name: '查资料', task: '去查一下' },
      ctx(s.port),
    )
    expect(res.status).toBe('success')
    expect(res.message).toContain('已创建子 agent 查资料')
    expect(res.message).toContain('cv_1')
    expect(s.calls).toEqual([
      {
        target: { kind: 'temp', name: '查资料' },
        task: '去查一下',
        runId: 'rn_test',
        stepId: 'st_test',
        signal: expect.anything(),
      },
    ])
    expect((res.data as { subagentId: string }).subagentId).toBe('cv_1')
  })

  test('kind 是 role 时按角色 id 建', async () => {
    const s = stub({
      ok: true,
      output: '审查结论',
      subagentId: 'cv_2',
      name: '审查员',
      created: true,
    })
    const res = await subagentTool.fn(
      { kind: 'role', role: 'reviewer', task: '看一眼' },
      ctx(s.port),
    )
    expect(res.status).toBe('success')
    expect(s.calls[0]?.target).toEqual({ kind: 'role', role: 'reviewer' })
    expect((res.data as { output: string }).output).toBe('审查结论')
  })

  test('填了 subagent 就是续接，种类字段不能再填', async () => {
    const s = stub({
      ok: true,
      output: '接着做完了',
      subagentId: 'cv_2',
      name: '审查员',
      created: false,
    })
    const res = await subagentTool.fn({ subagent: 'cv_2', task: '再看一遍' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(res.message).toContain('子 agent 审查员 已返回')
    expect(s.calls[0]?.target).toEqual({ subagent: 'cv_2' })

    const both = await subagentTool.fn(
      { subagent: 'cv_2', kind: 'temp', name: 'x', task: '再看一遍' },
      ctx(s.port),
    )
    expect(both.status).toBe('failure')
    expect(both.message).toContain('不再填 kind')
    expect(s.calls).toHaveLength(1)
  })

  test('种类与 id 都没填时拒绝，不猜一种', async () => {
    const s = stub({ ok: true, output: '' })
    const res = await subagentTool.fn({ task: '去查一下' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('kind')
    expect(s.calls).toHaveLength(0)
  })

  test('种类与它的字段要配套', async () => {
    const s = stub({ ok: true, output: '' })
    expect((await subagentTool.fn({ kind: 'role', task: '做' }, ctx(s.port))).message).toContain(
      '必须填 role',
    )
    expect((await subagentTool.fn({ kind: 'temp', task: '做' }, ctx(s.port))).message).toContain(
      '必须填 name',
    )
    expect((await subagentTool.fn({ kind: 'cli', task: '做' }, ctx(s.port))).message).toContain(
      '必须填 cli',
    )
    expect(s.calls).toHaveLength(0)
  })

  /**
   * 复现的是原始失败形状：模型把「不填这个可选参数」写成字符串 `"null"`，
   * 它穿过 `typeof` 守卫被当成模型名派下去，派活以「配置里没有模型 null」失败。
   * 设计是没点名就跟当前会话同一个模型，所以这里必须一个 model 都不带出去。
   */
  test('model 传字符串 null 视为没点名，跟当前会话的模型走', async () => {
    const temp = { kind: 'temp', name: 'x', task: '去查一下' }
    const s = stub({ ok: true, output: '查完了' })
    const res = await subagentTool.fn({ ...temp, model: 'null' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(s.calls[0]).not.toHaveProperty('model')

    const s2 = stub({ ok: true, output: '查完了' })
    await subagentTool.fn({ ...temp, model: 'undefined' }, ctx(s2.port))
    expect(s2.calls[0]).not.toHaveProperty('model')

    // 真的点名了照常带出去，别把这条修成「所有 model 都吞掉」。
    const s3 = stub({ ok: true, output: '查完了' })
    await subagentTool.fn(
      { ...temp, provider: '官方/接口', model: 'anthropic/claude-opus-5' },
      ctx(s3.port),
    )
    expect(s3.calls[0]).toHaveProperty('provider', '官方/接口')
    expect(s3.calls[0]).toHaveProperty('model', 'anthropic/claude-opus-5')
  })

  test('provider 与 model 必须成对，不能把半套覆盖传给执行器', async () => {
    const s = stub({ ok: true, output: '不应执行' })
    const res = await subagentTool.fn(
      { kind: 'temp', name: 'x', task: '去查一下', provider: '智谱接口' },
      ctx(s.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('同时指定 model')
    expect(s.calls).toHaveLength(0)
  })

  test('任务为空时不派出去', async () => {
    const s = stub({ ok: true, output: '产出' })
    const res = await subagentTool.fn({ kind: 'role', role: 'reviewer', task: '  ' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(s.calls).toHaveLength(0)
  })

  test('有未完成清单时必须逐字绑定唯一父待办', async () => {
    const todos = {
      read: () => [
        { id: 'todo_1', content: '服务端审计', status: 'in_progress' as const },
        { id: 'todo_2', content: '网页端审计', status: 'pending' as const },
      ],
    }
    const temp = { kind: 'temp', name: '审计', task: '审计服务端' }
    const missing = stub({ ok: true, output: '产出' })
    const missingResult = await subagentTool.fn(temp, withTodos(ctx(missing.port), todos))
    expect(missingResult.status).toBe('failure')
    expect(missing.calls).toHaveLength(0)

    const wrong = stub({ ok: true, output: '产出' })
    const wrongResult = await subagentTool.fn(
      { ...temp, parentTodo: '服务端' },
      withTodos(ctx(wrong.port), todos),
    )
    expect(wrongResult.status).toBe('failure')
    expect(wrong.calls).toHaveLength(0)

    const exact = stub({ ok: true, output: '产出', name: '审计', subagentId: 'cv_3' })
    const exactResult = await subagentTool.fn(
      { ...temp, parentTodo: '服务端审计' },
      withTodos(ctx(exact.port), todos),
    )
    expect(exactResult.status).toBe('success')
    // 结果只报事实：父待办仍未完成。怎么完成它写在工具描述里，不在每条结果里重复。
    expect(exactResult.message).toContain('父待办 服务端审计 仍未完成')
    expect(exactResult.message).not.toContain('write_todos')
    expect(exact.calls).toHaveLength(1)
  })

  test('同名未完成条目拒绝绑定，不猜完成哪一条', async () => {
    const s = stub({ ok: true, output: '产出' })
    const result = await subagentTool.fn(
      { kind: 'temp', name: 'x', task: '执行', parentTodo: '重复项' },
      withTodos(ctx(s.port), {
        read: () => [
          { id: 'todo_1', content: '重复项', status: 'in_progress' },
          { id: 'todo_2', content: '重复项', status: 'pending' },
        ],
      }),
    )
    expect(result.status).toBe('failure')
    expect(result.message).toContain('多条同名待办')
    expect(s.calls).toHaveLength(0)
  })

  /** 失败要带着对方给的原因回来：模型据此换做法，压成一句「执行出错」就没法换。 */
  test('派失败时带回原因', async () => {
    const s = stub({ ok: false, output: '', error: '退出码 1', name: 'Anthropic claude' })
    const res = await subagentTool.fn({ kind: 'cli', cli: 'claude', task: '执行任务' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('退出码 1')
    expect(s.calls[0]?.target).toEqual({ kind: 'cli', cli: 'claude' })
  })

  /**
   * 进度事件要挂到这张卡上才看得见，`runId` 与 `stepId` 两个都得传下去——
   * 前者是事件的必填字段，后者是前端认领卡片的依据。
   */
  test('把这一轮与这张卡的 id 一起传给端口', async () => {
    const s = stub({ ok: true, output: '好了' })
    await subagentTool.fn({ kind: 'temp', name: 'x', task: '去查一下' }, ctx(s.port))
    expect(s.calls[0]?.runId).toBe('rn_test')
    expect(s.calls[0]?.stepId).toBe('st_test')
  })

  /**
   * 拿不到卡片 id 时照跑。与 `workflow` 不同：那边没有它整张图画不出状态，所以拒绝执行；
   * 这边图的形状来自调用参数、终态来自这条 step 自己，丢的只有运行期状态。
   */
  test('没有卡片 id 也照样派出去', async () => {
    const s = stub({ ok: true, output: '好了' })
    const bare = ctx(s.port)
    delete bare.stepId
    const res = await subagentTool.fn({ kind: 'temp', name: 'x', task: '去查一下' }, bare)
    expect(res.status).toBe('success')
    expect(s.calls[0]?.stepId).toBeUndefined()
  })

  /** 没做成的那个子 agent 正是要翻开看、要接着派的那一个，所以失败那次也得把 id 交出去。 */
  test('失败那次也带回子 agent id', async () => {
    const s = stub({ ok: false, output: '', error: '原地打转', subagentId: 'cv_9', name: '审查员' })
    const res = await subagentTool.fn(
      { kind: 'role', role: 'reviewer', task: '看一眼' },
      ctx(s.port),
    )
    expect(res.status).toBe('failure')
    expect((res.data as { subagentId?: string }).subagentId).toBe('cv_9')
  })
})

describe('编排', () => {
  const graphPort = (result: Awaited<ReturnType<Port['runGraph']>>) => {
    const seen: { goal: string; count: number; stepId: string }[] = []
    const port: Port = {
      resolveModel: (name) => ({ provider: 'fake', model: name }),
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => ({ ok: true, output: '' }),
      runGraph: async (input) => {
        if (input.call.kind === 'start') {
          seen.push({
            goal: input.call.goal,
            count: input.call.nodes.length,
            stepId: input.stepId,
          })
        }
        return result
      },
    }
    return { seen, port }
  }

  const graph = (nodes: Record<string, unknown>[]) => ({
    goal: '目标',
    nodes: [
      ...nodes,
      { id: 'cp', kind: 'checkpoint', label: '审查', needs: nodes.map((n) => n.id) },
    ],
  })

  test('图交出去时带上这次调用的 stepId', async () => {
    const g = graphPort({
      ok: true,
      transition: { workflowId: 'st_test', phase: 'completed', receipts: [] },
    })
    await workflowTool.fn(
      { ...graph([{ id: 'a', kind: 'role', role: 'dev', task: '写' }]), goal: '做完这件事' },
      ctx(g.port),
    )
    expect(g.seen).toEqual([{ goal: '做完这件事', count: 2, stepId: 'st_test' }])
  })

  test('节点 id 重复当场拒绝，不派出去', async () => {
    const g = graphPort({
      ok: true,
      transition: { workflowId: 'st_test', phase: 'completed', receipts: [] },
    })
    const res = await workflowTool.fn(
      graph([
        { id: 'a', kind: 'temp', name: 'a', task: '一' },
        { id: 'a', kind: 'temp', name: 'a', task: '二' },
      ]),
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(g.seen).toHaveLength(0)
  })

  /** 图卡刷新之后要能重画：逐节点的终态与子 agent id 随这次调用的返回值带回来。 */
  test('逐节点终态与子 agent id 原样回在 data 里', async () => {
    const g = graphPort({
      ok: true,
      transition: {
        workflowId: 'st_test',
        phase: 'completed',
        receipts: [
          {
            nodeId: 'a',
            subagentId: 'cv_child',
            label: '开发',
            status: 'done',
            output: '写完了',
            durationMs: 12,
          },
        ],
      },
    })
    const res = await workflowTool.fn(
      graph([{ id: 'a', kind: 'role', role: 'dev', task: '写' }]),
      ctx(g.port),
    )
    expect(res.status).toBe('success')
    expect((res.data as { receipts: { subagentId?: string }[] }).receipts[0]?.subagentId).toBe(
      'cv_child',
    )
  })

  test('有节点没做成时整次调用算失败', async () => {
    const g = graphPort({
      ok: false,
      transition: {
        workflowId: 'st_test',
        phase: 'failed',
        receipts: [{ nodeId: 'a', label: '开发', status: 'failed', output: '', durationMs: 3 }],
      },
    })
    const res = await workflowTool.fn(
      graph([{ id: 'a', kind: 'role', role: 'dev', task: '写' }]),
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('执行失败')
  })

  test('图不合法时把编排器的原话带回来', async () => {
    const g = graphPort({ ok: false, error: '节点 b 依赖不存在的节点 x' })
    const res = await workflowTool.fn(
      graph([{ id: 'b', kind: 'role', role: 'dev', task: '写' }]),
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('依赖不存在的节点')
  })

  test('节点的种类字段原样解析成派发目标', async () => {
    const seen: unknown[] = []
    const port: Port = {
      resolveModel: (name) => ({ provider: 'fake', model: name }),
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => ({ ok: true, output: '' }),
      runGraph: async (input) => {
        if (input.call.kind === 'start') {
          seen.push(
            ...input.call.nodes
              .filter((node) => node.kind !== 'checkpoint')
              .map((node) => ('target' in node ? node.target : null)),
          )
        }
        return {
          ok: true,
          transition: { workflowId: 'st_test', phase: 'completed' as const, receipts: [] },
        }
      },
    }
    const res = await workflowTool.fn(
      graph([
        { id: 'a', kind: 'temp', name: '查这个', task: '查这个' },
        { id: 'b', kind: 'role', role: 'dev', task: '查那个' },
        { id: 'c', kind: 'cli', cli: 'codex', task: '改' },
        { id: 'd', subagent: 'cv_old', task: '再来' },
      ]),
      ctx(port),
    )
    expect(res.status).toBe('success')
    expect(seen).toEqual([
      { kind: 'temp', name: '查这个' },
      { kind: 'role', role: 'dev' },
      { kind: 'cli', cli: 'codex' },
      { subagent: 'cv_old' },
    ])
  })
})
