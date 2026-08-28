import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMcpConfigPort } from './mcp-config-store.ts'

async function workspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const before = process.env.QYWORK_HOME
  const home = await workspace('qywork-mcp-config-home-')
  process.env.QYWORK_HOME = home
  try {
    return await fn(home)
  } finally {
    if (before === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = before
  }
}

async function servers(file: string): Promise<Record<string, unknown>> {
  const root = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  return (root.servers ?? root.mcpServers ?? {}) as Record<string, unknown>
}

describe('MCP 配置写入与迁移', () => {
  test('明确指定 global 时只写全局 mcp.json', async () => {
    await withTempHome(async (home) => {
      const root = await workspace('qywork-mcp-config-ws-')
      const port = makeMcpConfigPort(root)
      const result = await port.writeServer({
        name: 'docs',
        configJson: JSON.stringify({ url: 'https://example.com/mcp' }),
        scope: 'global',
      })
      expect(result.ok).toBe(true)
      expect(await servers(join(home, 'mcp.json'))).toHaveProperty('docs')
      expect(await Bun.file(join(root, '.agents', 'mcp.json')).exists()).toBe(false)
    })
  })

  test('迁移成功后来源层删除，只保留目标层', async () => {
    await withTempHome(async (home) => {
      const root = await workspace('qywork-mcp-config-ws-')
      const port = makeMcpConfigPort(root)
      await port.writeServer({
        name: 'local',
        configJson: JSON.stringify({ command: 'bun', args: ['x.ts'] }),
        scope: 'project',
      })
      const moved = await port.moveServer({
        name: 'local',
        fromScope: 'project',
        toScope: 'global',
      })
      expect(moved.ok).toBe(true)
      expect(await servers(join(root, '.agents', 'mcp.json'))).not.toHaveProperty('local')
      expect(await servers(join(home, 'mcp.json'))).toHaveProperty('local')
    })
  })

  test('目标层同名时拒绝迁移，两边原配置都不改', async () => {
    await withTempHome(async (home) => {
      const root = await workspace('qywork-mcp-config-ws-')
      const port = makeMcpConfigPort(root)
      await port.writeServer({
        name: 'same',
        configJson: JSON.stringify({ command: 'project-command' }),
        scope: 'project',
      })
      await port.writeServer({
        name: 'same',
        configJson: JSON.stringify({ command: 'global-command' }),
        scope: 'global',
      })
      const moved = await port.moveServer({
        name: 'same',
        fromScope: 'project',
        toScope: 'global',
      })
      expect(moved.ok).toBe(false)
      expect(await servers(join(root, '.agents', 'mcp.json'))).toHaveProperty('same')
      expect(await servers(join(home, 'mcp.json'))).toHaveProperty('same')
    })
  })
})
