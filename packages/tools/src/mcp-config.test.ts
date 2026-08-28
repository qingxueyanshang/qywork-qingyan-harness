import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
import { ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from './index.ts'
import { moveMcpServerTool, writeMcpServerTool } from './mcp-config.ts'

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot: 'C:/workspace',
    conversationId: 'cv',
    runId: 'rn',
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
    ...overrides,
  }
}

describe('模型侧 MCP 配置工具', () => {
  test('只有装配了 MCP 配置通道才注册', () => {
    const bare = new ToolRegistry()
    registerBuiltinTools(bare)
    expect(bare.get('write_mcp_server')).toBeUndefined()

    const ready = new ToolRegistry()
    registerBuiltinTools(ready, { mcpConfig: true })
    expect(ready.get('write_mcp_server')).toBeDefined()
    expect(ready.get('move_mcp_server')).toBeDefined()
  })

  test('明确的 global 原样传到真正写入端口', async () => {
    let received: unknown
    const result = await writeMcpServerTool.fn(
      { name: 'docs', config_json: '{"url":"https://example.com/mcp"}', scope: 'global' },
      ctx({
        mcpConfig: {
          writeServer: async (input) => {
            received = input
            return { ok: true, path: 'C:/home/.qywork/mcp.json', replaced: false }
          },
          moveServer: async () => ({ ok: false }),
        },
      }),
    )
    expect(result.status).toBe('success')
    expect(received).toMatchObject({ name: 'docs', scope: 'global' })
  })

  test('迁移是一个端口动作，不由模型拼成写后删除两步', async () => {
    let calls = 0
    const result = await moveMcpServerTool.fn(
      { name: 'docs', from_scope: 'project', to_scope: 'global' },
      ctx({
        mcpConfig: {
          writeServer: async () => ({ ok: false }),
          moveServer: async (input) => {
            calls += 1
            expect(input).toEqual({ name: 'docs', fromScope: 'project', toScope: 'global' })
            return { ok: true, fromPath: 'project', toPath: 'global' }
          },
        },
      }),
    )
    expect(result.status).toBe('success')
    expect(calls).toBe(1)
  })
})
