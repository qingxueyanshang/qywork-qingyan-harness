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
      runGraph: async () => ({ ok: true, nodes: [] }),
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
})

describe('派活', () => {
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
    nodes: {
      nodeId: string
      agent: string
      status: 'done' | 'failed' | 'skipped'
      output: string
      durationMs: number
      conversationId?: string
      session?: string
    }[]
  }) => {
    const seen: { goal: string; count: number; stepId: string }[] = []
    return {
      seen,
      port: {
        targets: async () => [],
        run: async () => ({ ok: true, output: '' }),
        runGraph: async (input: { goal: string; nodes: unknown[]; stepId: string }) => {
          seen.push({ goal: input.goal, count: input.nodes.length, stepId: input.stepId })
          return result
        },
      },
    }
  }

  /** 图跑完之后同样要追问，所以节点的会话 id 必须随结果出来。 */
  test('图节点的会话 id 随结果回来', async () => {
    const g = graphPort({
      ok: true,
      nodes: [
        {
          nodeId: 'a',
          agent: 'cli:codex',
          status: 'done',
          output: '改完了',
          durationMs: 1,
          session: 'thread-5',
        },
      ],
    })
    const res = await workflowTool.fn(
      { goal: '改一下', nodes: [{ id: 'a', agent: 'cli:codex', task: '改' }] },
      ctx(g.port),
    )
    const nodes = (res.data as { nodes: { session?: string }[] }).nodes
    expect(nodes[0]?.session).toBe('thread-5')
  })

  test('图交出去时带上这次调用的 stepId', async () => {
    const g = graphPort({ ok: true, nodes: [] })
    await workflowTool.fn(
      { goal: '做完这件事', nodes: [{ id: 'a', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(g.seen).toEqual([{ goal: '做完这件事', count: 1, stepId: 'st_test' }])
  })

  test('节点 id 重复当场拒绝，不派出去', async () => {
    const g = graphPort({ ok: true, nodes: [] })
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
      nodes: [
        {
          nodeId: 'a',
          agent: 'dev',
          status: 'done',
          output: '写完了',
          durationMs: 12,
          conversationId: 'cv_child',
        },
      ],
    })
    const res = await workflowTool.fn(
      { goal: '目标', nodes: [{ id: 'a', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(res.status).toBe('success')
    expect((res.data as { nodes: { conversationId?: string }[] }).nodes[0]?.conversationId).toBe(
      'cv_child',
    )
  })

  test('有节点没做成时整次调用算失败', async () => {
    const g = graphPort({
      ok: false,
      nodes: [{ nodeId: 'a', agent: 'dev', status: 'failed', output: '', durationMs: 3 }],
    })
    const res = await workflowTool.fn(
      { goal: '目标', nodes: [{ id: 'a', agent: 'dev', task: '写' }] },
      ctx(g.port),
    )
    expect(res.status).toBe('failure')
    expect(res.message).toContain('1 个失败')
  })

  test('图不合法时把编排器的原话带回来', async () => {
    const g = graphPort({ ok: false, error: '节点 b 依赖不存在的节点 x', nodes: [] })
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
      runGraph: async (input: { nodes: { agent: string }[] }) => {
        seen.push(...input.nodes.map((n) => ({ agent: n.agent })))
        return { ok: true, nodes: [] }
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
