/**
 * 覆盖范围：`subagent.ts`（派活工具），以及它在 `index.ts` 里的注册条件。
 */

import { describe, expect, test } from 'bun:test'
import { type ToolContext, ToolRegistry } from '@qywork/agent'
import { registerBuiltinTools } from './index.ts'
import { subagentTool } from './subagent.ts'

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
    expect(r.list().some((s) => s.name === 'subagent')).toBe(true)
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
