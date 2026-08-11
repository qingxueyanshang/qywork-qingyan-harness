/**
 * Session 的装配面：工具集与角色约束。
 *
 * 不测「跑一轮」——那需要真实 provider，归 scripts/smoke-serve.ts。
 * 这里测的是**装配结果**，因为 Agent Team 的角色隔离完全建立在它上面：
 * 一个「只读」角色如果 allowedTools 没生效，它照样能改文件，而配置看着是对的。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { Session } from './session.ts'

const config: QyConfig = {
  active: 'p',
  profiles: { p: { kind: 'openai_compatible', model: 'deepseek-v4-flash', apiKey: 'sk-x' } },
}

async function session(over: Partial<ConstructorParameters<typeof Session>[0]> = {}) {
  const store = new Store({ path: ':memory:' })
  const s = new Session({
    store,
    config,
    workspaceRoot: await mkdtemp(join(tmpdir(), 'qywork-sess-')),
    signal: new AbortController().signal,
    ...over,
  })
  // 工具表是私有的，从公开的 schema 出口读——测的是模型实际看到什么。
  const names = () =>
    (s as unknown as { registry: { schemas(): { name: string }[] } }).registry
      .schemas()
      .map((t) => t.name)
  return { s, store, names }
}

describe('工具集', () => {
  test('不传 allowedTools 时是全部内置工具', async () => {
    const { names, store } = await session()
    expect(names()).toContain('read_file')
    expect(names()).toContain('run_command')
    expect(names().length).toBeGreaterThan(10)
    store.close()
  })

  test('传了就只注册这些', async () => {
    const { names, store } = await session({ allowedTools: ['read_file', 'grep'] })
    expect(names().sort()).toEqual(['grep', 'read_file'])
    store.close()
  })

  /**
   * 空数组与不传是两回事。合并它们会让「只让它分析、不给任何工具」
   * 这类角色配置静默变成「什么都能干」——而且看不出来。
   */
  test('空数组 = 一个工具都不给，不是「回落到全部」', async () => {
    const { names, store } = await session({ allowedTools: [] })
    expect(names()).toEqual([])
    store.close()
  })

  test('未知工具名被忽略，其余照常注册', async () => {
    const { names, store } = await session({ allowedTools: ['read_file', 'read_files'] })
    expect(names()).toEqual(['read_file'])
    store.close()
  })
})

describe('角色约束', () => {
  test('extraSystem 进冻结前缀', async () => {
    const { s, store } = await session({ extraSystem: '你只做代码审查，不改任何文件' })
    const loop = (
      s as unknown as { makeLoop(m: string): { deps: { systemPrompt: string } } }
    ).makeLoop('deepseek-v4-flash')
    expect((loop as unknown as { deps: { systemPrompt: string } }).deps.systemPrompt).toContain(
      '你只做代码审查',
    )
    store.close()
  })

  test('不传时前缀与默认完全一致 —— 免得平白多一段把缓存冲掉', async () => {
    const { s, store } = await session()
    const prompt = (
      (s as unknown as { makeLoop(m: string): unknown }).makeLoop('deepseek-v4-flash') as {
        deps: { systemPrompt: string }
      }
    ).deps.systemPrompt
    expect(prompt).not.toContain('## 角色')
    store.close()
  })
})

/**
 * allowedTools 必须同时管得住扩展工具，也必须**认得出**它们。
 *
 * 只过滤内置工具的话，一个「只读」角色照样能调插件里的写工具；
 * 而判定「这个名字是不是写错了」如果在扩展加载之前做，一个合法的
 * `mcp__demo__ping` 会被报成未知——让人去查一个不存在的问题。
 */
describe('allowedTools 与扩展工具', () => {
  async function workspaceWithMcp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'qywork-sess-mcp-'))
    await mkdir(join(root, '.qy'), { recursive: true })
    const NL = String.fromCharCode(10)
    await writeFile(
      join(root, '.qy', 'server.mjs'),
      [
        "let buf = ''",
        'const NL = String.fromCharCode(10)',
        'const send = (o) => process.stdout.write(JSON.stringify(o) + NL)',
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (c) => { buf += c; for(;;){ const i = buf.indexOf(NL); if (i < 0) break; const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line) } catch { continue }; handle(m) } })",
        'function handle(m) {',
        "  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo' } } })",
        "  if (m.method === 'notifications/initialized') return",
        "  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }, { name: 'pong', description: 'q', inputSchema: { type: 'object' } }] } })",
        "  send({ jsonrpc: '2.0', id: m.id, result: { content: [] } })",
        '}',
      ].join(NL),
      'utf8',
    )
    await writeFile(
      join(root, '.qy', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          demo: { command: process.execPath, args: [join(root, '.qy', 'server.mjs')] },
        },
      }),
      'utf8',
    )
    return root
  }

  test('allowedTools 里可以点名 MCP 工具，且只放行点到的那个', async () => {
    const store = new Store({ path: ':memory:' })
    const root = await workspaceWithMcp()
    const s = new Session({
      store,
      config,
      workspaceRoot: root,
      signal: new AbortController().signal,
      allowedTools: ['read_file', 'mcp__demo__ping'],
    })
    await (s as unknown as { loadExtensionTools(): Promise<void> }).loadExtensionTools()
    const names = (s as unknown as { registry: { schemas(): { name: string }[] } }).registry
      .schemas()
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(['mcp__demo__ping', 'read_file'])
    // 同一个 server 的另一个工具没被点名，就不该出现。
    expect(names).not.toContain('mcp__demo__pong')
    s.dispose()
    store.close()
  }, 20_000)
})
