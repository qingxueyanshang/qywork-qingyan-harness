/**
 * 覆盖范围：`subagent.ts`（派一件）与 `workflow.ts`（派一张图），
 * 以及两者在 `index.ts` 里的注册条件。
 */

import { describe, expect, test } from 'bun:test'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
import type { FileChange } from '@qywork/core'
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

interface Ran {
  ok: boolean
  output: string
  error?: string
  changes?: { files: FileChange[]; total: number }
  changesUnmeasured?: string
}

/** 一个假的派活端口：记下派了什么，回一个预设结果。 */
function stub(result: Ran) {
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
  /**
   * 不指定 agent = 临时起一个子 agent，**不是**列清单。
   * 为了铺开做几件小事而先定义几个角色，没人会这么用。
   */
  test('不带 agent 时临时起一个，直接派出去', async () => {
    const s = stub({ ok: true, output: '查完了' })
    const res = await subagentTool.fn({ task: '去查一下' }, ctx(s.port))
    expect(res.status).toBe('success')
    expect(res.message).toContain('临时子 agent')
    expect(s.calls).toEqual([{ target: '', task: '去查一下' }])
  })

  test('指名道姓派给不存在的目标时才拒，并提示可以临时起一个', async () => {
    const s = stub({ ok: true, output: '' })
    const res = await subagentTool.fn({ agent: '查无此人', task: '干活' }, ctx(s.port))
    expect(res.status).toBe('failure')
    expect(res.message).toContain('reviewer')
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

/**
 * 「改了多少」跟在标题那一行上。**它进信封的 summary**，是模型不展开 data
 * 就能读到的第一行——「说做完了却一个文件没动」这种矛盾要在这里撞见。
 */
describe('回执的量级', () => {
  const one = (path: string, additions: number, deletions: number): FileChange => ({
    path,
    changeType: 'modified',
    additions,
    deletions,
  })

  test('改了几个文件就说几个，带增删合计', async () => {
    const s = stub({
      ok: true,
      output: '好了',
      changes: { files: [one('a.ts', 4, 1), one('b.ts', 1, 0)], total: 2 },
    })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '改' }, ctx(s.port))
    expect(res.message).toContain('改 2 个文件 +5 −1')
  })

  test('一个都没改就明说，不是不吭声', async () => {
    const s = stub({ ok: true, output: '看完了', changes: { files: [], total: 0 } })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '看看' }, ctx(s.port))
    expect(res.message).toContain('没有改动')
  })

  /** 清单被截断时合计必然不全，给出去就是一个会撒谎的数。 */
  test('清单被截断时只给文件数，不给行数', async () => {
    const s = stub({
      ok: true,
      output: '好了',
      changes: { files: [one('a.ts', 4, 1)], total: 30 },
    })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '改' }, ctx(s.port))
    expect(res.message).toContain('改 30 个文件')
    expect(res.message).not.toContain('+4')
  })

  test('量不到时说量不到——不能长得跟「没有改动」一样', async () => {
    const s = stub({ ok: true, output: '好了', changesUnmeasured: '这台机器上跑不了 git' })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '改' }, ctx(s.port))
    expect(res.message).toContain('没量到')
    expect(res.message).not.toContain('没有改动')
  })

  /** 失败那次也要报量级：它可能已经动过工作区了。 */
  test('失败也报量级', async () => {
    const s = stub({
      ok: false,
      output: '',
      error: '退出码 1',
      changes: { files: [one('a.ts', 2, 0)], total: 1 },
    })
    const res = await subagentTool.fn({ agent: 'cli:claude', task: '改' }, ctx(s.port))
    expect(res.message).toContain('退出码 1')
    expect(res.message).toContain('改 1 个文件')
  })

  /** 内置角色没有这一格：它们的每一次写由自己的写工具逐条上报。 */
  test('内置角色不多这一句', async () => {
    const s = stub({ ok: true, output: '审完了' })
    const res = await subagentTool.fn({ agent: 'reviewer', task: '看' }, ctx(s.port))
    expect(res.message).toBe('reviewer 做完了')
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
