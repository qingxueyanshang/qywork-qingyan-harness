/**
 * 覆盖范围：`subagent.ts`（派一件）与 `workflow.ts`（派一张图），
 * 以及两者在 `index.ts` 里的注册条件。
 */

import { describe, expect, test } from 'bun:test'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
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

/** 一个假的派活端口：记下派了什么，回一个预设结果。 */
function stub(result: { ok: boolean; output: string; error?: string }) {
  const calls: { target: string; task: string }[] = []
  return {
    calls,
    port: {
      targets: async () => [
        { id: 'reviewer', kind: 'role' as const, description: '代码审查' },
        { id: 'cli:claude', kind: 'cli' as const, description: 'Anthropic · 已接入' },
      ],
      run: async (input: { target: string; task: string }) => {
        calls.push({ target: input.target, task: input.task })
        return result
      },
      runGraph: async () => ({ ok: true, nodes: [] }),
    },
  }
}

describe('派活工具的注册条件', () => {
  test('没有派活通道时压根不注册', () => {
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
  test('不带 agent 时列出能派给谁', async () => {
    const s = stub({ ok: true, output: '' })
    const res = await subagentTool.fn({}, ctx(s.port))
    expect(res.status).toBe('success')
    expect((res.data as { targets: unknown[] }).targets).toHaveLength(2)
  })

  test('目标不存在时把能派的列出来，不是干巴巴一句没找到', async () => {
    const s = stub({ ok: true, output: '' })
    const res = await subagentTool.fn({ agent: '不存在', task: '干活' }, ctx(s.port))
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
    expect(s.calls).toEqual([{ target: 'reviewer', task: '看一眼' }])
  })

  /** 失败要带着对方给的原因回来：模型据此换做法，压成一句「执行出错」就没法换。 */
  test('派失败时带回原因', async () => {
    const s = stub({ ok: false, output: '', error: '退出码 1' })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '干活' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('退出码 1')
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
