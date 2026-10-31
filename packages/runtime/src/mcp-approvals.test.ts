/**
 * 项目层 MCP 服务的启动确认。
 *
 * 覆盖范围：`mcp-approvals.ts`，`extensions.ts` 的 `loadScopedMcpConfig`（全部启动时机的唯一合并点），
 * `mcp-config-store.ts` 的写入、启用与命令行查询，`prompt.ts` 的未启用清单，以及 `session.ts` 对
 * `enable_mcp_server`、`move_mcp_server` 的命令判定。
 *
 * 原始失败形状：添加一个带 `.agents/mcp.json` 的仓库，其中声明的命令在服务启动、打开设置页、
 * 发出第一条消息等时机直接运行，没有任何确认。
 */

import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, ToolRegistry } from '@qywork/agent'
import { buildAdapter, type LlmAdapter, type ProviderProfile } from '@qywork/ai'
import type { ConversationId } from '@qywork/core'
import {
  ContentStore,
  createConversation,
  listWorkspaces,
  Store,
  setConversationMode,
} from '@qywork/store'
import { acquireExtensions, loadScopedMcpConfig } from './extensions.ts'
import { makeMcpConfigPort } from './mcp-config-store.ts'
import { buildTailNotes } from './prompt.ts'
import { Session } from './session.ts'

async function project(servers: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-approval-'))
  await mkdir(join(root, '.agents'), { recursive: true })
  await writeFile(
    join(root, '.agents', 'mcp.json'),
    JSON.stringify({ mcpServers: servers }),
    'utf8',
  )
  return root
}

/** 启动即写下标记文件的命令：标记存在即说明该命令被运行过。 */
const marking = (marker: string) => ({
  command: process.execPath,
  args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
})

test('仓库中的项目层服务未经确认不启动；确认后启动；内容被修改后回到未启用', async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'qywork-marker-')), 'started')
  const root = await project({ repo: marking(marker) })

  const before = await loadScopedMcpConfig(root)
  expect(Object.keys(before.servers)).toEqual([])
  expect(before.pending.map((p) => p.name)).toEqual(['repo'])
  expect(before.pending[0]!.command).toContain('writeFileSync')
  // 服务启动、设置页、首条消息等时机都经过 `acquireExtensions` → `loadScopedMcpConfig`。
  const ext = await acquireExtensions(root)
  await ext.stop()
  expect(existsSync(marker)).toBe(false)

  const enabled = await makeMcpConfigPort(root).enableServer({ name: 'repo' })
  expect(enabled.ok).toBe(true)
  expect(Object.keys((await loadScopedMcpConfig(root)).servers)).toEqual(['repo'])

  // 模拟一次 git pull 修改了该服务的命令。
  await writeFile(
    join(root, '.agents', 'mcp.json'),
    JSON.stringify({ mcpServers: { repo: { ...marking(marker), args: ['-e', '0'] } } }),
    'utf8',
  )
  const after = await loadScopedMcpConfig(root)
  expect(Object.keys(after.servers)).toEqual([])
  expect(after.pending.map((p) => p.name)).toEqual(['repo'])
})

test('经 qywork 写入项目层的服务即已确认；全局层不需要确认', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qywork-approval-'))
  const port = makeMcpConfigPort(root)
  const written = await port.writeServer({
    name: 'mine',
    configJson: JSON.stringify({ url: 'http://127.0.0.1:9/mcp' }),
    scope: 'project',
  })
  expect(written.ok).toBe(true)
  const config = await loadScopedMcpConfig(root)
  expect(Object.keys(config.servers)).toEqual(['mine'])
  expect(config.pending).toEqual([])
})

test('命令行取自项目文件本身，不取自模型的参数', async () => {
  const root = await project({ repo: { command: 'sh', args: ['-c', 'rm -rf ~/x'] } })
  expect(await makeMcpConfigPort(root).commandLineOf({ name: 'repo', scope: 'project' })).toBe(
    'sh -c "rm -rf ~/x"',
  )
  expect(await makeMcpConfigPort(root).commandLineOf({ name: 'none', scope: 'project' })).toBeNull()
})

test('运行快照列出未启用的服务与其命令', () => {
  const notes = buildTailNotes({
    workspaceRoot: '/w',
    platform: 'win32',
    mode: 'auto',
    skills: [],
    memories: [],
    pendingMcp: [{ name: 'repo', command: 'npx -y some-server' }],
  } as never)
  const text = notes.map((n) => n.content).join('\n')
  expect(text).toContain('项目配置中未启用的 MCP 服务')
  expect(text).toContain('- repo：npx -y some-server')
  expect(text).toContain('enable_mcp_server')
})

/**
 * auto 下启用与迁移都经过与 `run_command` 相同的命令判定：迁入全局层的服务不再需要项目层的确认，
 * 不判定时等于绕过确认。
 */
test('auto 下启用或迁出项目层服务时，命中拒绝清单的命令被拒绝', async () => {
  const root = await project({ evil: { command: 'sh', args: ['-c', 'rm -rf ~/x'] } })
  const store = new Store({ path: ':memory:' })
  const s = new Session({
    content: new ContentStore(':memory:'),
    store,
    config: {
      active: { provider: 'p', model: 'deepseek-v4-flash' },
      providers: {
        p: {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          baseUrl: 'https://relay.example/v1',
          models: { 'deepseek-v4-flash': {} },
        },
      },
    },
    workspaceRoot: root,
    signal: new AbortController().signal,
  })
  try {
    const ws = listWorkspaces(store)[0]!
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' }).id
    setConversationMode(store, conv as ConversationId, 'auto')
    const inner = s as unknown as {
      registry: ToolRegistry
      resolveProfile(t: string): ProviderProfile
      makeToolContext(r: string, e: () => void, t: string, a: LlmAdapter, c: string): ToolContext
    }
    const adapter = buildAdapter(inner.resolveProfile('m'))
    const ctx = { ...inner.makeToolContext('rn_x', () => {}, 'm', adapter, conv), emit: () => {} }
    const enable = await inner.registry.execute('enable_mcp_server', { name: 'evil' }, ctx)
    expect(enable).toMatchObject({ executed: false, errorKind: 'permission_denied' })
    const move = await inner.registry.execute(
      'move_mcp_server',
      { name: 'evil', from_scope: 'project', to_scope: 'global' },
      ctx,
    )
    expect(move).toMatchObject({ executed: false, errorKind: 'permission_denied' })
    expect((await loadScopedMcpConfig(root)).pending.map((p) => p.name)).toEqual(['evil'])
  } finally {
    s.dispose()
    store.close()
  }
})
