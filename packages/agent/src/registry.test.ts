/**
 * 工具名的 provider 约束、必填参数与唯一执行入口。
 *
 * 该问题由实测发现，且只在真实产物与真实 provider 下出现：
 * 安装 id 为 `demo.lines` 的插件（反向域名风格，清单文档推荐的写法）后，
 * 工具名为 `demo.lines__count`，此后每一轮 run 都被
 * `Invalid 'tools[0].function.name'` 400 拒绝，且错误信息不指明是哪个插件。
 *
 * 单元测试、typecheck、本地运行 agent 均能通过：内置工具名中没有点。
 */

import { describe, expect, test } from 'bun:test'
import {
  resolveAction,
  sanitizeToolName,
  TOOL_NAME_PATTERN,
  type ToolContext,
  ToolRegistry,
  type ToolSpec,
} from './registry.ts'

const spec = (name: string): ToolSpec => ({
  name,
  description: 'd',
  parameters: { type: 'object' },
  actionKind: 'read',
  objectLabel: 'x',
  category: 'session',
  facet: '测试',
  summary: '测试夹具',
  permissionEffect: 'read',
  fn: async () => ({ status: 'success', message: 'ok' }),
})

describe('注册期拒绝 provider 不接受的名称', () => {
  test('拒绝含点的名称：反向域名风格的插件 id 会产生点', () => {
    expect(() => new ToolRegistry().register(spec('demo.lines__count'))).toThrow('provider')
  })

  for (const bad of ['a:b', 'a/b', 'a b', 'a.b', '工具', 'a+b']) {
    test(`拒绝 ${JSON.stringify(bad)}`, () => {
      expect(() => new ToolRegistry().register(spec(bad))).toThrow()
    })
  }

  test('超过 64 字符时拒绝', () => {
    expect(() => new ToolRegistry().register(spec('a'.repeat(65)))).toThrow()
  })

  test('合法名称照常注册', () => {
    const r = new ToolRegistry()
    r.register(spec('read_file'))
    r.register(spec('mcp__github__create-issue'))
    expect(r.list()).toHaveLength(2)
  })
})

describe('执行入口 fail-closed', () => {
  test('缺少必填参数不会进入权限解析或工具函数，回执明确说明缺参', async () => {
    const r = new ToolRegistry()
    r.register({
      ...spec('read_file'),
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      actionKind: () => {
        throw new Error('缺参不应进入动作解析')
      },
      fn: async () => {
        throw new Error('缺参不应执行工具')
      },
    })
    const out = await r.execute('read_file', {}, {} as ToolContext)
    expect(out).toEqual({
      status: 'failure',
      executed: false,
      message: '工具 read_file 缺少必填参数：path。请按工具定义传入 JSON 参数。',
      errorKind: 'invalid_tool_arguments',
    })
  })

  test('只校验注册 schema 的必填键，可选字段和合法无参工具照常执行', async () => {
    const r = new ToolRegistry()
    r.register({
      ...spec('read_file'),
      permissionEffect: 'internal_control',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'integer' } },
        required: ['path'],
      },
      fn: async (args) => ({ status: 'success', message: 'ok', data: args }),
    })
    r.register({ ...spec('status'), permissionEffect: 'internal_control' })
    expect(
      await r.execute('read_file', { path: 'pelican-bike/index.html' }, {} as ToolContext),
    ).toMatchObject({
      status: 'success',
      executed: true,
      data: { path: 'pelican-bike/index.html' },
    })
    expect(await r.execute('status', {}, {} as ToolContext)).toMatchObject({
      status: 'success',
      executed: true,
    })
  })

  test('注册表未命中返回未执行的结构化失败', async () => {
    const out = await new ToolRegistry().execute('missing_tool', {}, {} as unknown as ToolContext)
    expect(out).toEqual({
      status: 'failure',
      executed: false,
      message: '未注册调用：missing_tool',
      errorKind: 'unregistered_tool_call',
    })
  })
})

describe('规范化', () => {
  test('非法字符统一替换为下划线', () => {
    expect(sanitizeToolName('demo.lines__count')).toBe('demo_lines__count')
    expect(sanitizeToolName('mcp__my.server__do:it')).toBe('mcp__my_server__do_it')
  })

  test('规范化结果必定能通过校验', () => {
    for (const raw of ['a.b', '中文工具', 'x/y z', '@scope/pkg__tool']) {
      expect(TOOL_NAME_PATTERN.test(sanitizeToolName(raw))).toBe(true)
    }
  })

  test('截断至 64 字符：provider 的上限同样是硬性限制', () => {
    expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64)
  })

  /**
   * 规范化会产生重名。本用例锁定这一事实：生成名称的一方必须自行查重，
   * 不能假设规范化后的名称仍然唯一。
   */
  test('a.b 与 a_b 规范化后同名：调用方必须自行查重', () => {
    expect(sanitizeToolName('a.b')).toBe(sanitizeToolName('a_b'))
  })
})

/**
 * 动作语义的解析。
 *
 * 不要为注册表中未找到的工具返回默认值
 * `{ kind: 'read', objectLabel: 工具名 }`：这会使一个可能执行写入、删除或命令的未知
 * 工具在卡片上显示「读取 xxx」，即编造一个具体且错误的动词。
 */
describe('动作语义按参数解析，不按工具名推测', () => {
  test('常量 kind 原样返回', () => {
    expect(resolveAction(spec('read_thing'), {}).kind).toBe('read')
  })

  test('函数 kind 能取得 args', () => {
    const s: ToolSpec = {
      ...spec('facade'),
      actionKind: (a) => (a.mode === 'rm' ? 'delete' : 'read'),
    }
    expect(resolveAction(s, { mode: 'rm' }).kind).toBe('delete')
    expect(resolveAction(s, { mode: 'cat' }).kind).toBe('read')
  })

  /** 部分动作仅凭参数无法区分创建与编辑，区别在于 ctx.state 中的既有状态。 */
  test('函数 kind 能取得 ctx', () => {
    const s: ToolSpec = {
      ...spec('stateful'),
      actionKind: (_a, c) => (c?.state.get('has') ? 'edit' : 'write'),
    }
    const c = { state: new Map([['has', true]]) } as unknown as ToolContext
    expect(resolveAction(s, {}).kind).toBe('write')
    expect(resolveAction(s, {}, c).kind).toBe('edit')
  })
})
