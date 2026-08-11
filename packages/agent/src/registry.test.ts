/**
 * 工具名的 provider 约束。
 *
 * 这条是实测撞出来的，而且只在**真实产物 + 真实 provider**下才会出现：
 * 装一个 id 叫 `demo.lines` 的插件（反向域名风格，清单文档自己推荐的写法），
 * 工具名成了 `demo.lines__count`，然后每一轮 run 都被
 * `Invalid 'tools[0].function.name'` 400 打死——而错误信息不说是哪个插件。
 *
 * 单测、typecheck、本地跑 agent 全都是绿的：内置工具名里没有点。
 */

import { describe, expect, test } from 'bun:test'
import { sanitizeToolName, TOOL_NAME_PATTERN, ToolRegistry, type ToolSpec } from './registry.ts'

const spec = (name: string): ToolSpec => ({
  name,
  description: 'd',
  parameters: { type: 'object' },
  actionKind: 'read',
  objectLabel: 'x',
  permissionEffect: 'read',
  fn: async () => ({ status: 'success', message: 'ok' }),
})

describe('注册期就挡住 provider 不收的名字', () => {
  test('点被拒 —— 反向域名风格的插件 id 就会产生它', () => {
    expect(() => new ToolRegistry().register(spec('demo.lines__count'))).toThrow('provider')
  })

  for (const bad of ['a:b', 'a/b', 'a b', 'a.b', '工具', 'a+b']) {
    test(`拒绝 ${JSON.stringify(bad)}`, () => {
      expect(() => new ToolRegistry().register(spec(bad))).toThrow()
    })
  }

  test('超过 64 字符被拒', () => {
    expect(() => new ToolRegistry().register(spec('a'.repeat(65)))).toThrow()
  })

  test('合法的照常注册', () => {
    const r = new ToolRegistry()
    r.register(spec('read_file'))
    r.register(spec('mcp__github__create-issue'))
    expect(r.list()).toHaveLength(2)
  })

  test('内置工具名全部合法 —— 这条防的是将来手滑加一个带点的', async () => {
    const { registerBuiltinTools } = await import('@qywork/tools')
    const r = new ToolRegistry()
    registerBuiltinTools(r)
    for (const t of r.list()) expect(TOOL_NAME_PATTERN.test(t.name)).toBe(true)
  })
})

describe('消毒', () => {
  test('非法字符统一换成下划线', () => {
    expect(sanitizeToolName('demo.lines__count')).toBe('demo_lines__count')
    expect(sanitizeToolName('mcp__my.server__do:it')).toBe('mcp__my_server__do_it')
  })

  test('消毒结果一定能通过校验', () => {
    for (const raw of ['a.b', '中文工具', 'x/y z', '@scope/pkg__tool']) {
      expect(TOOL_NAME_PATTERN.test(sanitizeToolName(raw))).toBe(true)
    }
  })

  test('截到 64 —— provider 的上限也是硬的', () => {
    expect(sanitizeToolName('x'.repeat(100))).toHaveLength(64)
  })

  /**
   * 消毒**会**制造碰撞。这里钉住这个事实：产出方必须自己查重，
   * 不能假设消毒后还是唯一的。
   */
  test('a.b 与 a_b 消毒后同名 —— 调用方必须自己查重', () => {
    expect(sanitizeToolName('a.b')).toBe(sanitizeToolName('a_b'))
  })
})
