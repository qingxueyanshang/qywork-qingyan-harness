/**
 * 外部工具的待加载池与 `load_tool`。
 *
 * 覆盖范围：`tool-pool.ts` 全部。
 *
 * 锁定的行为是池中的工具确实不进入请求：该行为一旦失效，结果是费用不变而不是报错，
 * 按需加载失去作用且无人察觉。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolContext, ToolSpec } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  EXTERNAL_SCHEMA_BUDGET_TOKENS,
  externalSchemaTokens,
  makeLoadToolTool,
  PendingToolPool,
} from './tool-pool.ts'

function fakeExternal(name: string, description = '一个外部工具'): ToolSpec {
  return {
    name,
    description,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    actionKind: 'call',
    objectLabel: 'MCP',
    category: 'mcp',
    facet: 'MCP demo',
    summary: description,
    permissionEffect: 'execute',
    fn: async () => ({ status: 'success', message: 'ok' }),
  }
}

function ctx(): ToolContext {
  return {
    workspaceRoot: 'C:/ws',
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
  }
}

function pooled(names: string[]) {
  const registry = new ToolRegistry()
  const recorded: string[] = []
  const pool = new PendingToolPool({
    registry,
    onLoaded: (loaded) => recorded.push(...loaded),
  })
  for (const n of names) pool.add(fakeExternal(n))
  const spec = makeLoadToolTool(pool)
  registry.register(spec)
  return { registry, pool, spec, recorded }
}

describe('待加载池', () => {
  test('池中的工具不进入 schemas：节省的正是这部分', () => {
    const { registry } = pooled(['mcp__demo__a', 'mcp__demo__b'])
    expect(registry.schemas().map((s) => s.name)).toEqual(['load_tool'])
  })

  test('加载后它出现在 schemas 中，且从清单中移除', async () => {
    const { registry, pool, spec } = pooled(['mcp__demo__a', 'mcp__demo__b'])
    const out = await spec.fn({ names: ['mcp__demo__a'] }, ctx())

    expect(out.status).toBe('success')
    expect(registry.schemas().map((s) => s.name)).toEqual(['load_tool', 'mcp__demo__a'])
    // 已加载的工具不再列入上下文末尾的清单：再次列出等于提示模型再加载一次。
    expect(pool.index().map((t) => t.name)).toEqual(['mcp__demo__b'])
  })

  test('一次可以加载多个', async () => {
    const { registry, spec } = pooled(['mcp__demo__a', 'mcp__demo__b'])
    await spec.fn({ names: ['mcp__demo__a', 'mcp__demo__b'] }, ctx())
    expect(registry.schemas().length).toBe(3)
  })

  /** 会话级的事实必须写入会话级的存储：Session 每条消息新建一个，进程内集合的生命周期不超过它。 */
  test('加载成功才写入账本，加载失败不写入', async () => {
    const { spec, recorded } = pooled(['mcp__demo__a'])
    await spec.fn({ names: ['mcp__demo__nope'] }, ctx())
    expect(recorded).toEqual([])

    await spec.fn({ names: ['mcp__demo__a'] }, ctx())
    expect(recorded).toEqual(['mcp__demo__a'])
  })

  /**
   * 同名注册会抛错，那是装配错误的信号（`registry.ts` 的第三条不变量），
   * 不应由模型重复输入名称触发。因此 `load_tool` 先自行检查。
   */
  test('已加载的工具再次加载时不抛错，如实说明它已存在', async () => {
    const { spec } = pooled(['mcp__demo__a'])
    await spec.fn({ names: ['mcp__demo__a'] }, ctx())
    const again = await spec.fn({ names: ['mcp__demo__a'] }, ctx())
    expect(again.status).toBe('success')
    expect(again.message).toContain('已在工具表中')
  })

  /** 只返回「未找到」时模型只能推测；给出候选后，它在下一轮即可自行修正（与 `read_skill` 相同）。 */
  test('名称写错时列出可加载的名称', async () => {
    const { spec } = pooled(['mcp__demo__search'])
    const out = await spec.fn({ names: ['mcp__demo__serach'] }, ctx())
    expect(out.status).toBe('failure')
    expect(out.message).toContain('加载目标未命中：mcp__demo__serach')
    expect(out.message).toContain('mcp__demo__search')
    expect(out.data?.notFound).toEqual(['mcp__demo__serach'])
  })

  test('部分名称正确时加载正确的部分，并指出错误的名称', async () => {
    const { registry, spec } = pooled(['mcp__demo__a'])
    const out = await spec.fn({ names: ['mcp__demo__a', 'mcp__demo__x'] }, ctx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('mcp__demo__x')
    expect(registry.has('mcp__demo__a')).toBe(true)
  })

  test('names 为空是参数错误，不是「加载了零个」', async () => {
    const { spec } = pooled(['mcp__demo__a'])
    const out = await spec.fn({ names: [] }, ctx())
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('invalid_args')
  })
})

describe('按量决策', () => {
  /**
   * 阈值判定的是总量而不是个数：实测中 sequential-thinking 一个工具即为 2016 token，
   * 按个数定档会把它判为小配置。
   */
  test('一个大工具即可超出预算', () => {
    const fat = fakeExternal('mcp__x__fat', 'x'.repeat(EXTERNAL_SCHEMA_BUDGET_TOKENS * 2 + 100))
    expect(externalSchemaTokens([fat], DEFAULT_DENSITY)).toBeGreaterThan(
      EXTERNAL_SCHEMA_BUDGET_TOKENS,
    )
  })

  test('几个小工具仍在预算内', () => {
    const small = ['a', 'b', 'c'].map((n) => fakeExternal(`mcp__demo__${n}`))
    expect(externalSchemaTokens(small, DEFAULT_DENSITY)).toBeLessThan(EXTERNAL_SCHEMA_BUDGET_TOKENS)
  })

  test('空集合计为 0，不估算为非零值', () => {
    expect(externalSchemaTokens([], DEFAULT_DENSITY)).toBe(0)
  })
})
