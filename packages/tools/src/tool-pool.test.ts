/**
 * 按需工具的桩定义、`load_tool` 与执行前的参数核对。
 *
 * 覆盖范围：`tool-pool.ts` 全部，以及 `agent/registry.ts` 中按需工具的 `schemas()` 与 `execute()` 分支。
 *
 * 锁定的行为是两条：完整定义不进入请求（失效时费用不变而不报错）；读取定义不改变工具表（失效时缓存整段不命中而不报错）。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolContext, ToolSpec } from '@qywork/agent'
import { Ports, provide, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { MediaOutput } from '@qywork/core'
import { MediaPort } from './generate/port.ts'
import { generateImageTool } from './generate.ts'
import { MEDIA_TOOLS, registerToolCatalog } from './index.ts'
import {
  deferExternal,
  EXTERNAL_SCHEMA_BUDGET_TOKENS,
  externalSchemaTokens,
  makeLoadToolTool,
} from './tool-pool.ts'

function fakeTool(name: string, description = '一个外部工具'): ToolSpec {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' }, n: { type: 'integer' } },
      required: ['q'],
      additionalProperties: false,
    },
    actionKind: 'call',
    objectLabel: 'MCP',
    category: 'mcp',
    facet: 'MCP demo',
    summary: description,
    permissionEffect: 'execute',
    fn: async (args) => ({ status: 'success', message: `ok ${JSON.stringify(args)}` }),
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
    state: new Map(),
    sink: null,
    port: () => null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

/** 一个常驻工具与两个按需工具，加上 `load_tool`。 */
function setup() {
  const registry = new ToolRegistry()
  registry.register(fakeTool('mcp__demo__resident', '常驻的工具'))
  registry.register(deferExternal(fakeTool('mcp__demo__a', '查询甲\n第二行说明')))
  registry.register(deferExternal(fakeTool('mcp__demo__b', '查询乙')))
  const load = makeLoadToolTool(registry)
  registry.register(load)
  return { registry, load }
}

describe('桩定义', () => {
  test('按需工具在请求中只有名称、一句用途与任意对象参数，不以 strict 发送', () => {
    const { registry } = setup()
    const stub = registry.schemas().find((s) => s.name === 'mcp__demo__a')
    expect(stub?.description).toStartWith('查询甲。')
    expect(stub?.description).toContain('load_tool')
    expect(stub?.description).not.toContain('第二行说明')
    expect(stub?.parameters).toEqual({ type: 'object', properties: {}, additionalProperties: true })
    expect(stub?.strict).toBe(false)
    // 常驻工具照常携带完整定义。
    const resident = registry.schemas().find((s) => s.name === 'mcp__demo__resident')
    expect(resident?.parameters).toEqual(fakeTool('x').parameters)
  })
})

describe('load_tool', () => {
  /** 原始失败形状：加载即修改工具表，工具表位于请求最前部，该次请求整段不命中缓存。 */
  test('返回完整定义，工具表逐字节不变', async () => {
    const { registry, load } = setup()
    const before = JSON.stringify(registry.schemas())
    const out = await load.fn({ names: ['mcp__demo__a', 'mcp__demo__b'] }, ctx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('## mcp__demo__a\n查询甲\n第二行说明')
    expect(out.message).toContain('"required":["q"]')
    expect(out.message).toContain('## mcp__demo__b')
    expect(JSON.stringify(registry.schemas())).toBe(before)
    expect(out.data?.loaded).toEqual(['mcp__demo__a', 'mcp__demo__b'])
  })

  /** 生成工具的参数表依配置变化，随定义按读取时的配置返回，不写入每一轮的快照。 */
  test('读取生成工具时一并返回该类别当前配置的参数表', async () => {
    const registry = new ToolRegistry()
    registry.register(generateImageTool)
    const load = makeLoadToolTool(registry)
    const asked: string[] = []
    const media: MediaPort = {
      displayName: () => undefined,
      parameterTable: (output) => {
        asked.push(output)
        return '## 当前可用的图像模型与参数\n- 名称「图像甲」'
      },
      generate: async () => ({ ok: false, message: '不调用' }),
    }
    const out = await load.fn(
      { names: ['generate_image'] },
      { ...ctx(), port: new Ports([provide(MediaPort, media)]).get },
    )
    expect(out.message).toContain('## generate_image')
    expect(out.message).toContain('名称「图像甲」')
    expect(asked).toEqual(['image'])
  })

  test('常驻工具如实说明完整定义已在工具表中', async () => {
    const { load } = setup()
    const out = await load.fn({ names: ['mcp__demo__resident'] }, ctx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('mcp__demo__resident 的完整定义已在工具表中')
  })

  /** 只返回「未找到」时模型只能推测；给出候选后，它在下一轮即可自行修正（与 `read_skill` 相同）。 */
  test('名称写错时列出按需工具的名称', async () => {
    const { load } = setup()
    const out = await load.fn({ names: ['mcp__demo__x'] }, ctx())
    expect(out.status).toBe('failure')
    expect(out.message).toContain('工具表中没有：mcp__demo__x')
    expect(out.message).toContain('按需工具：mcp__demo__a、mcp__demo__b')
  })

  test('names 为空是参数错误', async () => {
    const { load } = setup()
    const out = await load.fn({ names: [] }, ctx())
    expect(out).toMatchObject({ status: 'failure', errorKind: 'invalid_args' })
  })
})

describe('执行前按完整定义核对参数', () => {
  test('参数符合定义时照常执行', async () => {
    const { registry } = setup()
    const out = await registry.execute('mcp__demo__a', { q: '关键词', n: 2 }, ctx())
    expect(out).toMatchObject({ status: 'success', message: 'ok {"q":"关键词","n":2}' })
  })

  /** 原始失败形状：桩定义不约束参数，模型未读取定义时按推测的参数名调用，工具忽略未声明的参数后按缺省执行。 */
  test('未声明的参数、类型不符时不执行，报错附完整定义', async () => {
    const { registry } = setup()
    const out = await registry.execute('mcp__demo__a', { q: '关键词', query: 'x', n: '2' }, ctx())
    expect(out).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'invalid_tool_arguments',
    })
    expect(out.message).toContain('参数 不接受 query')
    expect(out.message).toContain('参数.n 应为整数，收到字符串')
    expect(out.message).toContain('## mcp__demo__a')
  })

  /** 两种写法在常驻工具上由 strict 约束或适配器还原，按需工具在执行前按完整定义还原（`normalizeArgs`）。 */
  test('可选参数写为 null、字符串参数写为对象时按定义还原后执行', async () => {
    const registry = new ToolRegistry()
    const received: Record<string, unknown>[] = []
    registry.register(
      deferExternal({
        ...fakeTool('mcp__demo__json'),
        parameters: {
          type: 'object',
          properties: { json: { type: 'string' }, id: { type: 'string' } },
          required: ['json'],
          additionalProperties: false,
        },
        fn: async (args) => {
          received.push(args)
          return { status: 'success', message: 'ok' }
        },
      }),
    )
    const out = await registry.execute('mcp__demo__json', { json: { a: 1 }, id: null }, ctx())
    expect(out.status).toBe('success')
    expect(received).toEqual([{ json: '{"a":1}' }])
  })

  test('缺少必填参数时报错同样附完整定义', async () => {
    const { registry } = setup()
    const out = await registry.execute('mcp__demo__a', {}, ctx())
    expect(out).toMatchObject({ status: 'failure', executed: false })
    expect(out.message).toContain('缺少必填参数：q')
    expect(out.message).toContain('## mcp__demo__a')
  })
})

describe('外部工具的一句用途', () => {
  const briefOf = (description: string) =>
    deferExternal(fakeTool('mcp__x__t', description)).deferred?.brief

  /** 复现原始失败形状：第三方说明以空行或 `## Overview` 开头时，工具表中该工具只剩名称，模型无法判断是否需要它。 */
  test('跳过空行与标题行，取第一行有内容的文本', () => {
    expect(briefOf('\n\nSearch repositories.')).toBe('Search repositories.')
    expect(briefOf('## Overview\n\nSearch repositories.')).toBe('Search repositories.')
  })

  /** 第三方说明可能包含多段，不截断时一句用途本身就会增长到数百字。 */
  test('只取首行并截断', () => {
    expect(briefOf(`第一行\n第二行`)).toBe('第一行')
    expect(briefOf('长'.repeat(500))?.length).toBeLessThanOrEqual(101)
  })
})

describe('内置工具分档', () => {
  /**
   * 分档依据账本 60 天 2,686 次 run 的使用率：低于 1% 的工具按需。目标的两个工具与 stop_subagent 低于 1% 仍常驻：
   * 进行中的目标靠 update_goal 推进，子 agent 运行时主会话须能直接停止它。浏览器与电脑控制参数复杂、一次会话连续调用，常驻。
   */
  test('按需的内置工具恰为这 22 个（19 个低使用率工具与 3 个生成工具），目标、停止子 agent、浏览器与电脑控制常驻', () => {
    const registry = new ToolRegistry()
    registerToolCatalog(registry, Object.keys(MEDIA_TOOLS) as MediaOutput[])
    const deferred = registry
      .list()
      .filter((s) => s.deferred)
      .map((s) => s.name)
      .sort()
    expect(deferred).toEqual(
      [
        'cancel_canvas',
        'capture_canvas_frame',
        'create_schedule',
        'define_role',
        'delete_memory',
        'delete_schedule',
        'enable_mcp_server',
        'export_timeline',
        'generate_audio',
        'generate_image',
        'generate_video',
        'import_skill',
        'install_plugin',
        'list_schedules',
        'move_mcp_server',
        'move_memory',
        'move_skill',
        'personalize',
        'pet',
        'retrieve_canvas',
        'write_mcp_server',
        'write_skill',
      ].sort(),
    )
    for (const name of [
      'read_goal',
      'update_goal',
      'stop_subagent',
      'subagent',
      'browser_act',
      'desktop_act',
      'run_command',
      'edit_canvas',
      'load_tool',
    ]) {
      expect(registry.get(name)?.deferred).toBeUndefined()
    }
  })

  test('画布与生成关闭时，按需的画布工具与常驻的画布工具一样不注册', () => {
    const registry = new ToolRegistry()
    registerToolCatalog(registry, null)
    for (const name of [
      'retrieve_canvas',
      'cancel_canvas',
      'export_timeline',
      'capture_canvas_frame',
    ]) {
      expect(registry.has(name)).toBe(false)
    }
  })

  /** 是否列出可分配给子 agent 的模型按 `registry.has('define_role' | 'subagent' | 'workflow')` 判断：按需工具仍在工具表中。 */
  test('按需工具仍在工具表中，按名称判断是否注册的调用方不受影响', () => {
    const registry = new ToolRegistry()
    registerToolCatalog(registry, [])
    expect(registry.has('define_role')).toBe(true)
    expect(registry.schemas().some((s) => s.name === 'define_role')).toBe(true)
  })

  /** MCP 配置的权限判定与界面上的工具卡都按工具名识别：按需工具调用时使用真实名称。 */
  test('按需工具的权限判定收到真实工具名', async () => {
    const registry = new ToolRegistry()
    registry.register(deferExternal({ ...fakeTool('mcp__demo__a'), permissionEffect: 'execute' }))
    const asked: string[] = []
    const out = await registry.execute(
      'mcp__demo__a',
      { q: 'x' },
      {
        ...ctx(),
        requestPermission: async (call) => {
          asked.push(call.toolName)
          return { allowed: true }
        },
      },
    )
    expect(out.status).toBe('success')
    expect(asked).toEqual(['mcp__demo__a'])
  })
})

describe('按量决策', () => {
  /**
   * 阈值判定的是总量而不是个数：实测中 sequential-thinking 一个工具即为 2016 token，
   * 按个数定档会把它判为小配置。
   */
  test('一个大工具即可超出预算', () => {
    const fat = fakeTool('mcp__x__fat', '参数说明'.repeat(EXTERNAL_SCHEMA_BUDGET_TOKENS))
    expect(externalSchemaTokens([fat], DEFAULT_DENSITY)).toBeGreaterThan(
      EXTERNAL_SCHEMA_BUDGET_TOKENS,
    )
  })

  test('几个小工具仍在预算内', () => {
    const small = ['a', 'b', 'c'].map((n) => fakeTool(`mcp__demo__${n}`))
    expect(externalSchemaTokens(small, DEFAULT_DENSITY)).toBeLessThan(EXTERNAL_SCHEMA_BUDGET_TOKENS)
  })

  test('空集合计为 0，不估算为非零值', () => {
    expect(externalSchemaTokens([], DEFAULT_DENSITY)).toBe(0)
  })
})
