/**
 * 覆盖范围：`subagent.ts`（派发单个子 agent）与 `workflow.ts`（派发编排图），
 * 以及两者在 `index.ts` 中的注册条件。
 *
 * 两个工具只返回「是否已派发」：产出与回执由派发通道在完成后作为消息送回，
 * 该部分由 `server/delegate.test.ts` 覆盖；产出的投递额度检查由 `sink.test.ts` 覆盖。
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
type GraphResult = Awaited<ReturnType<Port['runGraph']>>

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
    requestPermission: async () => ({ allowed: true }),
    stepId: 'st_test',
    ...(delegate ? { delegate } : {}),
  }
}

function withTodos(c: ToolContext, todos: NonNullable<ToolContext['todos']>): ToolContext {
  return { ...c, todos }
}

const GRAPH_DONE: GraphResult = {
  ok: true,
  transition: { workflowId: 'st_test', dispatched: [] },
  completed: true,
}

/** 模拟的派发端口：记录派发内容，返回预设结果。 */
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
    runGraph: async () => GRAPH_DONE,
    inflight: () => [],
  }
  return { calls, port }
}

const sent = (extra: Partial<DispatchResult> = {}): DispatchResult => ({
  ok: true,
  subagentId: 'cv_1',
  name: '查资料',
  kind: 'temp',
  created: true,
  ...extra,
})

describe('派发任务工具的注册条件', () => {
  test('没有派发通道时不注册', () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r)
    expect(r.list().some((s) => s.name === 'subagent')).toBe(false)
  })

  test('有派发通道时注册', () => {
    const r = new ToolRegistry()
    registerBuiltinTools(r, { delegate: true })
    const names = r.list().map((s) => s.name)
    expect(names).toContain('subagent')
    expect(names).toContain('workflow')
  })

  test('workflow schema 使用扁平的可空判别字段，不依赖 oneOf/anyOf', () => {
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

describe('派发单个子 agent', () => {
  /** 两个及以上子 agent 使用 workflow：每次调用只派发一个，同一轮中的多次调用串行执行。 */
  test('每次只派发一个，不并行执行', () => {
    expect(subagentTool.parallelSafe).toBe(false)
  })

  /** 派发后立即返回：本次调用只返回是否已派发，产出经回执送回。 */
  test('kind 为 temp 时按名称新建，返回派发事实', async () => {
    const s = stub(sent())
    const res = await subagentTool.fn(
      { kind: 'temp', name: '查资料', task: '去查一下' },
      ctx(s.port),
    )
    expect(res.status).toBe('success')
    expect(res.message).toBe('已派出临时 查资料（subagentId cv_1），回执会作为一条消息送到本会话')
    expect(s.calls).toEqual([
      {
        target: { kind: 'temp', name: '查资料' },
        task: '去查一下',
        runId: 'rn_test',
        stepId: 'st_test',
      },
    ])
    expect(res.data).toEqual({ subagentId: 'cv_1', kind: 'temp', name: '查资料' })
    // 结果中不含产出：工具返回时子 agent 尚未执行完毕。
    expect(res.data).not.toHaveProperty('output')
  })

  test('kind 为 role 时按角色 id 创建', async () => {
    const s = stub(sent({ subagentId: 'cv_2', name: '审查员', kind: 'role' }))
    const res = await subagentTool.fn(
      { kind: 'role', role: 'reviewer', task: '看一眼' },
      ctx(s.port),
    )
    expect(res.status).toBe('success')
    expect(s.calls[0]?.target).toEqual({ kind: 'role', role: 'reviewer' })
  })

  test('填写 subagent 表示续接，此时不能再填写种类字段', async () => {
    const s = stub(sent({ subagentId: 'cv_2', name: '审查员', kind: 'role', created: false }))
    const res = await subagentTool.fn({ subagent: 'cv_2', task: '再看一遍' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(res.message).toContain('已派出角色 审查员')
    expect(s.calls[0]?.target).toEqual({ subagent: 'cv_2' })

    const both = await subagentTool.fn(
      { subagent: 'cv_2', kind: 'temp', name: 'x', task: '再看一遍' },
      ctx(s.port),
    )
    expect(both.status).toBe('failure')
    expect(both.message).toContain('不能再填写 kind')
    expect(s.calls).toHaveLength(1)
  })

  test('种类与 id 都未填写时拒绝，不推测种类', async () => {
    const s = stub(sent())
    const res = await subagentTool.fn({ task: '去查一下' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('kind')
    expect(s.calls).toHaveLength(0)
  })

  test('种类必须与对应字段一同提供', async () => {
    const s = stub(sent())
    expect((await subagentTool.fn({ kind: 'role', task: '做' }, ctx(s.port))).message).toContain(
      '必须填写 role',
    )
    expect((await subagentTool.fn({ kind: 'temp', task: '做' }, ctx(s.port))).message).toContain(
      '必须填写 name',
    )
    expect((await subagentTool.fn({ kind: 'cli', task: '做' }, ctx(s.port))).message).toContain(
      '必须填写 cli',
    )
    expect(s.calls).toHaveLength(0)
  })

  /**
   * 复现原始失败形状：模型把「不填写该可选参数」写成字符串 `"null"`，
   * 该值通过 `typeof` 检查后被当作模型名派发，派发任务以「配置中没有模型 null」失败。
   * 按设计，未指定模型时沿用当前会话的模型，因此此处不得传出任何 model。
   */
  test('model 传入字符串 null 时视为未指定，沿用当前会话的模型', async () => {
    const temp = { kind: 'temp', name: 'x', task: '去查一下' }
    const s = stub(sent())
    const res = await subagentTool.fn({ ...temp, model: 'null' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(s.calls[0]).not.toHaveProperty('model')

    const s2 = stub(sent())
    await subagentTool.fn({ ...temp, model: 'undefined' }, ctx(s2.port))
    expect(s2.calls[0]).not.toHaveProperty('model')

    // 明确指定的模型照常传出，不要改成「丢弃所有 model」。
    const s3 = stub(sent())
    await subagentTool.fn(
      { ...temp, provider: '官方/接口', model: 'anthropic/claude-opus-5' },
      ctx(s3.port),
    )
    expect(s3.calls[0]).toHaveProperty('provider', '官方/接口')
    expect(s3.calls[0]).toHaveProperty('model', 'anthropic/claude-opus-5')
  })

  test('provider 与 model 必须成对提供，不把不完整的覆盖传给执行器', async () => {
    const s = stub(sent())
    const res = await subagentTool.fn(
      { kind: 'temp', name: 'x', task: '去查一下', provider: '智谱接口' },
      ctx(s.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('同时指定 model')
    expect(s.calls).toHaveLength(0)
  })

  test('任务为空时不派发', async () => {
    const s = stub(sent())
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
    const missing = stub(sent())
    const missingResult = await subagentTool.fn(temp, withTodos(ctx(missing.port), todos))
    expect(missingResult.status).toBe('failure')
    expect(missing.calls).toHaveLength(0)

    const wrong = stub(sent())
    const wrongResult = await subagentTool.fn(
      { ...temp, parentTodo: '服务端' },
      withTodos(ctx(wrong.port), todos),
    )
    expect(wrongResult.status).toBe('failure')
    expect(wrong.calls).toHaveLength(0)

    const exact = stub(sent({ name: '审计', subagentId: 'cv_3' }))
    const exactResult = await subagentTool.fn(
      { ...temp, parentTodo: '服务端审计' },
      withTodos(ctx(exact.port), todos),
    )
    expect(exactResult.status).toBe('success')
    // 结果只报告事实：父待办仍未完成。完成方式写在工具描述中，不在每条结果中重复。
    expect(exactResult.message).toContain('父待办 服务端审计 仍未完成')
    expect(exactResult.message).not.toContain('write_todos')
    expect(exact.calls).toHaveLength(1)
  })

  test('存在同名未完成条目时拒绝绑定，不推测应完成哪一条', async () => {
    const s = stub(sent())
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

  /** 无法派发时必须带回端口给出的原因：模型据此调整做法，压缩为「执行出错」则无法调整。 */
  test('无法派发时带回原因', async () => {
    const s = stub({ ok: false, error: '本机没有识别到 claude' })
    const res = await subagentTool.fn({ kind: 'cli', cli: 'claude', task: '执行任务' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('本机没有识别到 claude')
    expect(s.calls[0]?.target).toEqual({ kind: 'cli', cli: 'claude' })
  })

  /**
   * 进度事件必须关联到对应卡片才会显示，因此 `runId` 与 `stepId` 都必须传给端口：
   * 前者是事件的必填字段，后者是前端匹配卡片的依据。
   */
  test('把本轮 id 与卡片 id 一并传给端口', async () => {
    const s = stub(sent())
    await subagentTool.fn({ kind: 'temp', name: 'x', task: '去查一下' }, ctx(s.port))
    expect(s.calls[0]?.runId).toBe('rn_test')
    expect(s.calls[0]?.stepId).toBe('st_test')
  })

  /**
   * 无法取得卡片 id 时照常执行。与 `workflow` 不同：`workflow` 缺少它就无法渲染整张图的状态，因此拒绝执行；
   * `subagent` 的卡片形状来自调用参数，终态来自该 step 自身，缺少 id 只丢失运行期状态。
   */
  test('没有卡片 id 时照常派发', async () => {
    const s = stub(sent())
    const bare = ctx(s.port)
    delete bare.stepId
    const res = await subagentTool.fn({ kind: 'temp', name: 'x', task: '去查一下' }, bare)
    expect(res.status).toBe('success')
    expect(s.calls[0]?.stepId).toBeUndefined()
  })

  /** 派发时的附加事实接在消息之后：续接失败、角色已不存在。 */
  test('派发时的附加事实随消息返回', async () => {
    const s = stub(sent({ note: '这家 CLI 上次没有给会话号' }))
    const res = await subagentTool.fn({ subagent: 'cv_1', task: '接着做' }, ctx(s.port))
    expect(res.message).toContain('这家 CLI 上次没有给会话号')
  })
})

describe('推进编排图', () => {
  const graphPort = (result: GraphResult) => {
    const seen: { goal: string; count: number; stepId: string }[] = []
    const port: Port = {
      resolveModel: (name) => ({ provider: 'fake', model: name }),
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => sent(),
      inflight: () => [],
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

  test('提交编排图时附带本次调用的 stepId', async () => {
    const g = graphPort(GRAPH_DONE)
    await workflowTool.fn(
      { ...graph([{ id: 'a', kind: 'role', role: 'dev', task: '写' }]), goal: '做完这件事' },
      ctx(g.port),
    )
    expect(g.seen).toEqual([{ goal: '做完这件事', count: 2, stepId: 'st_test' }])
  })

  test('节点 id 重复时立即拒绝，不派发', async () => {
    const g = graphPort(GRAPH_DONE)
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

  /** 返回本次开始执行的节点，以及回执将经由消息送回这一事实。 */
  test('开始执行后返回已派发的节点，而不是回执', async () => {
    const g = graphPort({
      ok: true,
      transition: { workflowId: 'st_test', dispatched: ['a', 'b'] },
      completed: false,
    })
    const res = await workflowTool.fn(
      graph([
        { id: 'a', kind: 'role', role: 'dev', task: '写' },
        { id: 'b', kind: 'temp', name: 'b', task: '也写' },
      ]),
      ctx(g.port),
    )
    expect(res.status).toBe('success')
    expect(res.message).toContain('已开始执行，运行中 2 个节点：a、b')
    expect(res.message).toContain('回执会作为消息送到本会话')
    expect(res.data).toEqual({ workflowId: 'st_test', dispatched: ['a', 'b'] })
  })

  test('全部批准且所有节点均为终态时报告已完成', async () => {
    const g = graphPort({
      ok: true,
      transition: {
        workflowId: 'wf_1',
        dispatched: [],
        review: { checkpointId: 'cp', decision: 'approve', note: '通过' },
      },
      completed: true,
    })
    const res = await workflowTool.fn(
      { workflowId: 'wf_1', checkpointId: 'cp', decision: 'approve', note: '通过' },
      ctx(g.port),
    )
    expect(res.status).toBe('success')
    expect(res.message).toContain('Workflow 已完成')
  })

  /** 批准时接受的失败节点必须逐一列出，否则结果与全部成功无法区分。 */
  test('逐条列出批准时接受的失败节点', async () => {
    const g = graphPort({
      ok: true,
      transition: {
        workflowId: 'wf_1',
        dispatched: ['b'],
        review: {
          checkpointId: 'cp',
          decision: 'approve',
          note: '先往下走',
          acceptedFailures: [{ nodeId: 'a', reason: '连不上' }],
        },
      },
      completed: false,
    })
    const res = await workflowTool.fn(
      { workflowId: 'wf_1', checkpointId: 'cp', decision: 'approve', note: '先往下走' },
      ctx(g.port),
    )
    expect(res.message).toContain('a（连不上）')
  })

  test('编排图不合法时带回推进器的原始错误信息', async () => {
    const g = graphPort({ ok: false, error: '节点 b 依赖不存在的节点 x' })
    const res = await workflowTool.fn(
      graph([{ id: 'b', kind: 'role', role: 'dev', task: '写' }]),
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('依赖不存在的节点')
  })

  test('审查动作必须指定检查点，只提供 workflowId 时立即拒绝', async () => {
    const g = graphPort(GRAPH_DONE)
    const res = await workflowTool.fn({ workflowId: 'wf_1' }, ctx(g.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('checkpointId')
  })

  test('节点的种类字段原样解析为派发目标', async () => {
    const seen: unknown[] = []
    const port: Port = {
      resolveModel: (name) => ({ provider: 'fake', model: name }),
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => sent(),
      inflight: () => [],
      runGraph: async (input) => {
        if (input.call.kind === 'start') {
          seen.push(
            ...input.call.nodes
              .filter((node) => node.kind !== 'checkpoint')
              .map((node) => ('target' in node ? node.target : null)),
          )
        }
        return GRAPH_DONE
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

/**
 * 称呼按种类确定。种类由派发端口提供：续派的参数中只有 id，
 * 工具一侧无法判定派发的是哪一种。
 */
describe('按种类称呼子 agent', () => {
  test('外部 CLI 无法派发时输出其种类与名称', async () => {
    const s = stub({
      ok: false,
      error: '本机没有识别到 claude',
      kind: 'cli',
      name: 'claude 代码审查',
    })
    const res = await subagentTool.fn({ subagent: 'cv_cli', task: '接着审' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toBe('外部 CLI claude 代码审查 无法派发：本机没有识别到 claude')
  })

  test('角色与临时子 agent 各用对应的称呼', async () => {
    const role = stub(sent({ subagentId: 'cv_r', name: '审查员', kind: 'role', created: false }))
    expect(
      (await subagentTool.fn({ subagent: 'cv_r', task: '再看一遍' }, ctx(role.port))).message,
    ).toBe('已派出角色 审查员（subagentId cv_r），回执会作为一条消息送到本会话')
    const temp = stub(sent({ subagentId: 'cv_t', name: '查资料', kind: 'temp' }))
    expect(
      (await subagentTool.fn({ kind: 'temp', name: '查资料', task: '去查一下' }, ctx(temp.port)))
        .message,
    ).toBe('已派出临时 查资料（subagentId cv_t），回执会作为一条消息送到本会话')
  })
})
