/**
 * 覆盖范围：`subagent.ts`（派一件）与 `workflow.ts`（派一张图），
 * 以及两者在 `index.ts` 里的注册条件。
 */

import { describe, expect, test } from 'bun:test'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { subagentTool } from './subagent.ts'
import { workflowTool } from './workflow.ts'

function ctx(delegate?: ToolContext['delegate']): ToolContext {
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

interface Ran {
  ok: boolean
  output: string
  error?: string
  session?: string
  conversationId?: string
}

/** 一个假的派活端口：记下派了什么，回一个预设结果。 */
function stub(result: Ran) {
  const calls: {
    target: string
    task: string
    model?: string
    resume?: string
    runId: string
    stepId?: string
  }[] = []
  return {
    calls,
    port: {
      targets: async () => [
        { id: 'reviewer', kind: 'role' as const, description: '代码审查' },
        { id: 'cli:claude', kind: 'cli' as const, description: 'Anthropic · 已接入' },
      ],
      run: async (input: {
        target: string
        task: string
        model?: string
        resume?: string
        runId: string
        stepId?: string
      }) => {
        calls.push({
          target: input.target,
          task: input.task,
          ...(input.model ? { model: input.model } : {}),
          ...(input.resume ? { resume: input.resume } : {}),
          runId: input.runId,
          ...(input.stepId ? { stepId: input.stepId } : {}),
        })
        return result
      },
      runGraph: async () => ({
        ok: true,
        transition: { workflowId: 'unused', phase: 'completed' as const, receipts: [] },
      }),
    },
  }
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
    expect(node.kind?.enum).toEqual(['agent', 'checkpoint', null])
  })
})

describe('派活', () => {
  /**
   * **原始失败形状**：用户要求两个子 agent 并行，模型在同一条消息里发了两次
   * `subagent`，界面上却是第一格跑完 10 秒之后第二格才开始。
   * 根因是这个声明——不开的话 `planWaves` 把每次调用单独成一波串着跑，
   * 而工具描述与提示词承诺的都是「互不依赖的可以一次派几个」。
   */
  test('派几件是一起跑的，不是一件跑完再跑下一件', () => {
    expect(subagentTool.parallelSafe).toBe(true)
  })

  /**
   * 不指定 agent = 临时起一个子 agent，**不是**列清单。
   * 为了铺开做几件小事而先定义几个角色，没人会这么用。
   */
  test('不带 agent 时临时起一个，直接派出去', async () => {
    const s = stub({ ok: true, output: '查完了' })
    const res = await subagentTool.fn({ task: '去查一下' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(res.message).toContain('临时子 agent')
    expect(s.calls).toEqual([{ target: '', task: '去查一下', runId: 'rn_test', stepId: 'st_test' }])
  })

  /**
   * 复现的是原始失败形状：模型把「不填这个可选参数」写成字符串 `"null"`，
   * 它穿过 `typeof` 守卫被当成模型名派下去，派活以「配置里没有模型 null」失败。
   * 设计是没点名就跟当前会话同一个模型，所以这里必须一个 model 都不带出去。
   */
  test('model 传字符串 null 视为没点名，跟当前会话的模型走', async () => {
    const s = stub({ ok: true, output: '查完了' })
    const res = await subagentTool.fn({ task: '去查一下', model: 'null' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(s.calls[0]).not.toHaveProperty('model')

    const s2 = stub({ ok: true, output: '查完了' })
    await subagentTool.fn({ task: '去查一下', model: 'undefined' }, ctx(s2.port))
    expect(s2.calls[0]).not.toHaveProperty('model')

    // 真的点名了照常带出去，别把这条修成「所有 model 都吞掉」。
    const s3 = stub({ ok: true, output: '查完了' })
    await subagentTool.fn({ task: '去查一下', model: 'anthropic/claude-opus-5' }, ctx(s3.port))
    expect(s3.calls[0]).toHaveProperty('model', 'anthropic/claude-opus-5')
  })

  test('指名道姓派给不存在的目标时才拒，并提示可以临时起一个', async () => {
    const s = stub({ ok: true, output: '' })
    const res = await subagentTool.fn({ agent: '查无此人', task: '执行任务' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('reviewer')
  })

  test('目标不存在时把能派的列出来，不是干巴巴一句没找到', async () => {
    const s = stub({ ok: true, output: '' })
    const res = await subagentTool.fn({ agent: '不存在', task: '执行任务' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('reviewer')
    expect(res.message).toContain('cli:claude')
  })

  test('任务为空时不派出去', async () => {
    const s = stub({ ok: true, output: '产出' })
    const res = await subagentTool.fn({ agent: 'reviewer', task: '  ' }, ctx(s.port))
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
    const missing = stub({ ok: true, output: '产出' })
    const missingResult = await subagentTool.fn(
      { task: '审计服务端' },
      withTodos(ctx(missing.port), todos),
    )
    expect(missingResult.status).toBe('failure')
    expect(missing.calls).toHaveLength(0)

    const wrong = stub({ ok: true, output: '产出' })
    const wrongResult = await subagentTool.fn(
      { task: '审计服务端', parentTodo: '服务端' },
      withTodos(ctx(wrong.port), todos),
    )
    expect(wrongResult.status).toBe('failure')
    expect(wrong.calls).toHaveLength(0)

    const exact = stub({ ok: true, output: '产出' })
    const exactResult = await subagentTool.fn(
      { task: '审计服务端', parentTodo: '服务端审计' },
      withTodos(ctx(exact.port), todos),
    )
    expect(exactResult.status).toBe('success')
    expect(exactResult.message).toContain('父待办已推进：服务端审计')
    expect(exact.calls).toHaveLength(1)
  })

  test('同名未完成条目拒绝绑定，不猜完成哪一条', async () => {
    const s = stub({ ok: true, output: '产出' })
    const result = await subagentTool.fn(
      { task: '执行', parentTodo: '重复项' },
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

  test('派成功时把产出带回来', async () => {
    const s = stub({ ok: true, output: '审查结论' })
    const res = await subagentTool.fn({ agent: 'reviewer', task: '看一眼' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect((res.data as { output: string }).output).toBe('审查结论')
    expect(s.calls).toEqual([
      { target: 'reviewer', task: '看一眼', runId: 'rn_test', stepId: 'st_test' },
    ])
  })

  /** 失败要带着对方给的原因回来：模型据此换做法，压成一句「执行出错」就没法换。 */
  test('派失败时带回原因', async () => {
    const s = stub({ ok: false, output: '', error: '退出码 1' })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '执行任务' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('退出码 1')
  })

  /**
   * 进度事件要挂到这张卡上才看得见，`runId` 与 `stepId` 两个都得传下去——
   * 前者是事件的必填字段，后者是前端认领卡片的依据。
   */
  test('把这一轮与这张卡的 id 一起传给端口', async () => {
    const s = stub({ ok: true, output: '好了' })
    await subagentTool.fn({ task: '去查一下' }, ctx(s.port))
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
    const res = await subagentTool.fn({ task: '去查一下' }, bare)
    expect(res.status).toBe('success')
    expect(s.calls[0]?.stepId).toBeUndefined()
  })

  /** 没做成的那条子会话正是要翻开看的那一条，所以失败那次也得把它交出去。 */
  test('失败那次也带回子会话 id', async () => {
    const s = stub({ ok: false, output: '', error: '步数用尽', conversationId: 'cv_9' })
    const res = await subagentTool.fn({ agent: 'reviewer', task: '看一眼' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect((res.data as { conversationId?: string }).conversationId).toBe('cv_9')
  })
})

/** 回执说不清楚时接着问它——那条会话还在，它记得上一轮干了什么。 */
describe('接着问', () => {
  test('resume 原样传给端口，会话 id 随结果回来', async () => {
    const s = stub({ ok: true, output: '我改了 a.ts', session: 'sess-9' })
    const first = await subagentTool.fn({ agent: 'cli:claude', task: '改一下' }, ctx(s.port))
    expect((first.data as { session?: string }).session).toBe('sess-9')

    const again = await subagentTool.fn(
      { agent: 'cli:claude', task: '你刚才改了哪些文件', resume: 'sess-9' },
      ctx(s.port),
    )
    expect(again.status).toBe('success')
    expect(s.calls.at(-1)?.resume).toBe('sess-9')
  })

  /** 失败时更要接着问「卡在哪」，所以失败那次也得把会话 id 交出去。 */
  test('失败那次也带回会话 id', async () => {
    const s = stub({ ok: false, output: '', error: '退出码 1', session: 'sess-3' })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '改' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect((res.data as { session?: string }).session).toBe('sess-3')
  })
})

describe('编排', () => {
  const graphPort = (result: {
    ok: boolean
    error?: string
    transition?: {
      workflowId: string
      phase: 'waiting_review' | 'completed' | 'failed'
      checkpointId?: string
      receipts: Array<{
        nodeId: string
        agent: string
        label: string
        status: 'done' | 'failed' | 'skipped'
        output: string
        durationMs: number
        conversationId?: string
        session?: string
      }>
    }
  }) => {
    const seen: { goal: string; count: number; stepId: string }[] = []
    return {
      seen,
      port: {
        targets: async () => [],
        run: async () => ({ ok: true, output: '' }),
        runGraph: async (
          input: Parameters<NonNullable<ToolContext['delegate']>['runGraph']>[0],
        ) => {
          if (input.call.kind === 'start') {
            seen.push({
              goal: input.call.goal,
              count: input.call.nodes.length,
              stepId: input.stepId,
            })
          }
          return result
        },
      },
    }
  }

  /** 图跑完之后同样要追问，所以节点的会话 id 必须随结果出来。 */
  test('图节点的会话 id 随结果回来', async () => {
    const g = graphPort({
      ok: true,
      transition: {
        workflowId: 'st_test',
        phase: 'completed',
        receipts: [
          {
            nodeId: 'a',
            agent: 'cli:codex',
            label: 'Codex',
            status: 'done',
            output: '改完了',
            durationMs: 1,
            session: 'thread-5',
          },
        ],
      },
    })
    const res = await workflowTool.fn(
      { goal: '改一下', nodes: [{ id: 'a', agent: 'cli:codex', task: '改' }] },
      ctx(g.port),
    )
    const receipts = (res.data as { receipts: { session?: string }[] }).receipts
    expect(receipts[0]?.session).toBe('thread-5')
  })

  test('图交出去时带上这次调用的 stepId', async () => {
    const g = graphPort({
      ok: true,
      transition: { workflowId: 'st_test', phase: 'completed', receipts: [] },
    })
    await workflowTool.fn(
      { goal: '做完这件事', nodes: [{ id: 'a', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(g.seen).toEqual([{ goal: '做完这件事', count: 1, stepId: 'st_test' }])
  })

  test('节点 id 重复当场拒绝，不派出去', async () => {
    const g = graphPort({
      ok: true,
      transition: { workflowId: 'st_test', phase: 'completed', receipts: [] },
    })
    const res = await workflowTool.fn(
      {
        goal: '目标',
        nodes: [
          { id: 'a', agent: 'dev', task: '一' },
          { id: 'a', agent: 'dev', task: '二' },
        ],
      },
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(g.seen).toHaveLength(0)
  })

  /**
   * 复现的失败形状：图卡刷新之后要能重画，而进度事件不落库——
   * 逐节点的终态与子会话 id 只能靠这次调用的返回值带回来。
   */
  test('逐节点终态与子会话 id 原样回在 data 里', async () => {
    const g = graphPort({
      ok: true,
      transition: {
        workflowId: 'st_test',
        phase: 'completed',
        receipts: [
          {
            nodeId: 'a',
            agent: 'dev',
            label: '开发',
            status: 'done',
            output: '写完了',
            durationMs: 12,
            conversationId: 'cv_child',
          },
        ],
      },
    })
    const res = await workflowTool.fn(
      { goal: '目标', nodes: [{ id: 'a', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(res.status).toBe('success')
    expect(
      (res.data as { receipts: { conversationId?: string }[] }).receipts[0]?.conversationId,
    ).toBe('cv_child')
  })

  test('有节点没做成时整次调用算失败', async () => {
    const g = graphPort({
      ok: false,
      transition: {
        workflowId: 'st_test',
        phase: 'failed',
        receipts: [
          {
            nodeId: 'a',
            agent: 'dev',
            label: '开发',
            status: 'failed',
            output: '',
            durationMs: 3,
          },
        ],
      },
    })
    const res = await workflowTool.fn(
      { goal: '目标', nodes: [{ id: 'a', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('执行失败')
  })

  test('图不合法时把编排器的原话带回来', async () => {
    const g = graphPort({ ok: false, error: '节点 b 依赖不存在的节点 x' })
    const res = await workflowTool.fn(
      { goal: '目标', nodes: [{ id: 'b', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('依赖不存在的节点')
  })
})

describe('临时子 agent 在图里', () => {
  /** 一张全是临时子 agent 的图是最常见的形状：铺开几件小事，不为它们定义角色。 */
  test('节点不写 agent 时兜底成内置的那条，不是当场拒', async () => {
    const seen: { agent: string }[] = []
    const port = {
      targets: async () => [],
      run: async () => ({ ok: true, output: '' }),
      runGraph: async (input: Parameters<NonNullable<ToolContext['delegate']>['runGraph']>[0]) => {
        if (input.call.kind === 'start') {
          seen.push(
            ...input.call.nodes
              .filter((node) => node.kind !== 'checkpoint')
              .map((node) => ({ agent: node.agent })),
          )
        }
        return {
          ok: true,
          transition: { workflowId: 'st_test', phase: 'completed' as const, receipts: [] },
        }
      },
    }
    const res = await workflowTool.fn(
      {
        goal: '两件小事',
        nodes: [
          { id: 'a', task: '查这个' },
          { id: 'b', task: '查那个' },
        ],
      },
      ctx(port),
    )
    expect(res.status).toBe('success')
    expect(seen).toEqual([{ agent: 'ad-hoc' }, { agent: 'ad-hoc' }])
  })
})
