/**
 * 外部工具的待加载池与 `load_tool`。
 *
 * 覆盖范围：`tool-pool.ts` 全部。
 *
 * 锁的是**池子里的东西真的没进请求**：这一条一旦反过来，表现是账单照旧
 * 而不是报错——按需加载做了等于没做，谁都不会发现。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolContext, ToolSpec } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
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
    category: 'external',
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
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
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
  test('池子里的工具不进 schemas —— 这就是省下来的那部分', () => {
    const { registry } = pooled(['mcp__demo__a', 'mcp__demo__b'])
    expect(registry.schemas().map((s) => s.name)).toEqual(['load_tool'])
  })

  test('装入之后它出现在 schemas 里，且从清单里消失', async () => {
    const { registry, pool, spec } = pooled(['mcp__demo__a', 'mcp__demo__b'])
    const out = await spec.fn({ names: ['mcp__demo__a'] }, ctx())

    expect(out.status).toBe('success')
    expect(registry.schemas().map((s) => s.name)).toEqual(['load_tool', 'mcp__demo__a'])
    // 装过的不再列进尾区清单——再列一遍会让模型以为还得装一次。
    expect(pool.index().map((t) => t.name)).toEqual(['mcp__demo__b'])
  })

  test('一次可以装多个', async () => {
    const { registry, spec } = pooled(['mcp__demo__a', 'mcp__demo__b'])
    await spec.fn({ names: ['mcp__demo__a', 'mcp__demo__b'] }, ctx())
    expect(registry.schemas().length).toBe(3)
  })

  /** 会话级的事实要落会话级的存储——Session 每条消息新建一个，进程内的集合活不过它。 */
  test('装成功才落账本，装失败不落', async () => {
    const { spec, recorded } = pooled(['mcp__demo__a'])
    await spec.fn({ names: ['mcp__demo__nope'] }, ctx())
    expect(recorded).toEqual([])

    await spec.fn({ names: ['mcp__demo__a'] }, ctx())
    expect(recorded).toEqual(['mcp__demo__a'])
  })

  /**
   * 同名注册会抛，那是装配错误的信号（`registry.ts` 的第三条不变量），
   * 不该由模型多打一次名字触发。所以 `load_tool` 自己先查。
   */
  test('已经装过的再装一次不抛，如实说它本来就在', async () => {
    const { spec } = pooled(['mcp__demo__a'])
    await spec.fn({ names: ['mcp__demo__a'] }, ctx())
    const again = await spec.fn({ names: ['mcp__demo__a'] }, ctx())
    expect(again.status).toBe('success')
    expect(again.message).toContain('本来就在工具表里')
  })

  /** 只说「找不到」的话模型只能瞎猜；给候选它下一轮就能自己修正（同 `read_skill`）。 */
  test('名字写错时列出可加载的名字', async () => {
    const { spec } = pooled(['mcp__demo__search'])
    const out = await spec.fn({ names: ['mcp__demo__serach'] }, ctx())
    expect(out.status).toBe('failure')
    expect(out.message).toContain('mcp__demo__search')
  })

  test('一半对一半错时装对的那些，并把错的说出来', async () => {
    const { registry, spec } = pooled(['mcp__demo__a'])
    const out = await spec.fn({ names: ['mcp__demo__a', 'mcp__demo__x'] }, ctx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('mcp__demo__x')
    expect(registry.has('mcp__demo__a')).toBe(true)
  })

  test('names 为空是参数错误，不是「装了零个」', async () => {
    const { spec } = pooled(['mcp__demo__a'])
    const out = await spec.fn({ names: [] }, ctx())
    expect(out.status).toBe('failure')
    expect(out.errorKind).toBe('invalid_args')
  })
})

describe('按量决策', () => {
  /**
   * 阈值判的是**总量**不是个数：实测里 sequential-thinking 一个工具就 2016 token，
   * 按个数定档会把它判成小配置。
   */
  test('一个大工具就能超预算', () => {
    const fat = fakeExternal('mcp__x__fat', 'x'.repeat(EXTERNAL_SCHEMA_BUDGET_TOKENS * 2 + 100))
    expect(externalSchemaTokens([fat])).toBeGreaterThan(EXTERNAL_SCHEMA_BUDGET_TOKENS)
  })

  test('几个小工具还在预算内', () => {
    const small = ['a', 'b', 'c'].map((n) => fakeExternal(`mcp__demo__${n}`))
    expect(externalSchemaTokens(small)).toBeLessThan(EXTERNAL_SCHEMA_BUDGET_TOKENS)
  })

  test('空集合是 0，不是「有一点」', () => {
    expect(externalSchemaTokens([])).toBe(0)
  })
})
