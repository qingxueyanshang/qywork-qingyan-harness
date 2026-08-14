/**
 * 插件端到端：真的起一个子进程，让它走 RPC 调宿主能力。
 *
 * 用 mock 验不出这条链路——要验的恰恰是「插件进程里没有 fs，只有 RPC」，
 * 而 mock 掉进程就把被验的东西替换掉了。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@qywork/agent'
import { COMMAND_SHELL } from '@qywork/tools'
import {
  acquireExtensions,
  loadExtensions,
  MCP_CONFIG,
  PLUGINS_DIR,
  releaseExtensions,
} from './extensions.ts'

/**
 * 插件本体。
 *
 * 它导出一个 `probe` 工具，工具体里通过 `host.*` 调宿主能力，把结果原样返回。
 * 这样一次 `registry.get('...__probe').fn()` 就走完了
 * 工具注册 → 跨进程调用 → 宿主能力 → 结果回传 四段。
 */
const PLUGIN_SOURCE = `
let buf = ''
const waiting = new Map()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'host.result') {
      const w = waiting.get(msg.id); waiting.delete(msg.id)
      if (w) msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error?.message ?? '失败'))
      continue
    }
    if (msg.type === 'call') void handle(msg)
  }
})
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')

function host(method, params) {
  const id = 'h' + Math.random().toString(36).slice(2)
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    send({ type: 'host', id, method, params })
  })
}

async function handle(msg) {
  try {
    const r = await host(msg.params.method, msg.params.params ?? {})
    send({ id: msg.id, ok: true, result: { status: 'success', message: 'ok', data: { r } } })
  } catch (err) {
    send({ id: msg.id, ok: true, result: { status: 'failure', message: String(err.message) } })
  }
}

// 证明隔离是真的：插件进程里根本没有这些模块可用的路径。
// 有的话下面这行会成功，测试会看到 leaked=true。
let leaked = false
try { require('node:fs').readFileSync('/etc/passwd'); leaked = true } catch {}
if (leaked) send({ type: 'leaked' })

send({ type: 'ready' })
`

/**
 * `permissions` 是**除 workspace:read 之外**要额外声明的。
 *
 * probe 工具的 permissionEffect 是 read，清单解析期会强制要求
 * workspace:read——这是设计如此：工具声明的动作和插件声明的权限必须自洽，
 * 否则用户在安装提示里看到的权限清单和插件实际能做的事对不上。
 */
async function workspaceWith(extra: string[]) {
  const permissions = ['workspace:read', ...extra.filter((p) => p !== 'workspace:read')]
  const root = await mkdtemp(join(tmpdir(), 'qywork-ext-'))
  const dir = join(root, PLUGINS_DIR, 'probe')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.mjs'), PLUGIN_SOURCE, 'utf8')
  await writeFile(
    join(dir, 'qywork.plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'test.probe',
      name: '探针',
      version: '1.0.0',
      description: '端到端测试用',
      main: 'index.mjs',
      permissions,
      contributes: {
        tools: [
          {
            name: 'probe',
            description: '调一次宿主能力',
            parameters: { type: 'object', properties: {}, additionalProperties: true },
            actionKind: 'read',
            objectLabel: '宿主能力',
            permissionEffect: 'read',
          },
        ],
      },
    }),
    'utf8',
  )
  await writeFile(join(root, 'hello.txt'), '你好', 'utf8')

  const ext = await loadExtensions(root)
  // 注册名是消毒过的：插件 id 是 `test.probe`（反向域名风格），
  // 而 provider 只接受 `^[a-zA-Z0-9_-]+$`——点会被换成下划线。
  const tool = ext.toolSpecs.find((t) => t.name === 'test_probe__probe')
  const probe = async (method: string, params: Record<string, unknown> = {}) =>
    tool!.fn({ method, params }, {} as never)
  return { root, ext, probe, stop: () => ext.stop() }
}

describe('插件端到端', () => {
  test('插件加载成功且工具被注册', async () => {
    const { ext, stop } = await workspaceWith(['workspace:read'])
    expect(ext.plugins.failures).toEqual([])
    expect(ext.toolSpecs.map((t) => t.name)).toContain('test_probe__probe')
    stop()
  })

  test('声明了 workspace:read 就能读工作区文件', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    const r = await probe('fs.read', { path: 'hello.txt' })
    expect(r.status).toBe('success')
    expect((r.data as any).r.content).toBe('你好')
    stop()
  })

  test('没声明 workspace:write 就写不了 —— 权限在宿主侧强制', async () => {
    const { root, probe, stop } = await workspaceWith(['workspace:read'])
    const r = await probe('fs.write', { path: 'x.txt', content: '偷偷写' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('workspace:write')
    expect(await Bun.file(join(root, 'x.txt')).exists()).toBe(false)
    stop()
  })

  test('声明了就能写', async () => {
    const { root, probe, stop } = await workspaceWith(['workspace:read', 'workspace:write'])
    expect((await probe('fs.write', { path: 'x.txt', content: '写了' })).status).toBe('success')
    expect(await readFile(join(root, 'x.txt'), 'utf8')).toBe('写了')
    stop()
  })

  test('工作区边界在权限之内再守一层', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    expect((await probe('fs.read', { path: '../../../etc/passwd' })).status).toBe('failure')
    stop()
  })

  test('私有存储可用且按插件隔离', async () => {
    const { root, probe, stop } = await workspaceWith(['storage'])
    expect((await probe('storage.set', { key: 'k', value: 42 })).status).toBe('success')
    const got = await probe('storage.get', { key: 'k' })
    expect((got.data as any).r.value).toBe(42)
    // 落成用户看得见的普通文件，插件行为异常时能直接翻。
    expect(await Bun.file(join(root, '.qy/plugin-data/test.probe.json')).exists()).toBe(true)
    stop()
  })

  test('没声明 network 就出不了网', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    const r = await probe('net.fetch', { url: 'https://example.com' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('network')
    stop()
  })

  test('没声明 process:exec 就跑不了命令', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    expect((await probe('exec.run', { command: 'echo x' })).message).toContain('process:exec')
    stop()
  })

  test('声明了 process:exec 能跑，且拿不到宿主的密钥', async () => {
    process.env.QYWORK_EXT_SECRET = 'leaked-secret'
    try {
      const { probe, stop } = await workspaceWith(['process:exec'])
      // 方言按真正在跑的 shell 取，不按 platform——见 capabilities.test.ts 同名助手。
      const cmd = String(COMMAND_SHELL.argv[0]).includes('powershell')
        ? 'Write-Output "[$env:QYWORK_EXT_SECRET]"'
        : 'echo "[$QYWORK_EXT_SECRET]"'
      const r = await probe('exec.run', { command: cmd })
      expect(r.status).toBe('success')
      expect((r.data as any).r.stdout).not.toContain('leaked-secret')
      stop()
    } finally {
      delete process.env.QYWORK_EXT_SECRET
    }
  })

  test('未登记的方法被拒（fail-closed）', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read', 'workspace:write'])
    expect((await probe('fs.chmod', { path: 'hello.txt' })).message).toContain('未登记')
    stop()
  })

  test('坏插件不影响整体加载 —— 记进 failures 而不是抛', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-ext-bad-'))
    await mkdir(join(root, PLUGINS_DIR, 'broken'), { recursive: true })
    await writeFile(join(root, PLUGINS_DIR, 'broken', 'qywork.plugin.json'), '{ 坏的', 'utf8')
    const ext = await loadExtensions(root)
    expect(ext.plugins.failures).toHaveLength(1)
    expect(ext.plugins.plugins).toHaveLength(0)
  })
})

describe('MCP 接线', () => {
  const SERVER = [
    "let buf = ''",
    // 换行用 fromCharCode 而不是字面转义：这段字符串要穿过 TS 源码、
    // 写进 .mjs、再被 JS 解析，数反斜杠数错一层的表现是「server 启动即退出」。
    'const NL = String.fromCharCode(10)',
    'const send = (o) => process.stdout.write(JSON.stringify(o) + NL)',
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', (c) => {",
    '  buf += c',
    '  let i',
    '  while ((i = buf.indexOf(NL)) >= 0) {',
    '    const line = buf.slice(0, i); buf = buf.slice(i + 1)',
    '    if (!line.trim()) continue',
    '    let m; try { m = JSON.parse(line) } catch { continue }',
    "    if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo' } } }); continue }",
    "    if (m.method === 'notifications/initialized') continue",
    "    if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: '返回 pong', inputSchema: { type: 'object' } }] } }); continue }",
    "    if (m.method === 'tools/call') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong' }] } }); continue }",
    "    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } })",
    '  }',
    '})',
  ].join('\n')

  async function withMcp(extra: Record<string, unknown> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'qywork-mcpext-'))
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'server.mjs'), SERVER, 'utf8')
    await writeFile(
      join(root, MCP_CONFIG),
      JSON.stringify({
        mcpServers: {
          demo: { command: process.execPath, args: [join(root, '.agents', 'server.mjs')] },
          ...extra,
        },
      }),
      'utf8',
    )
    return { root, ext: await loadExtensions(root) }
  }

  test('mcp.json 里的 server 被连上，工具进 toolSpecs', async () => {
    const { ext } = await withMcp()
    expect(ext.mcp.failures).toEqual([])
    expect(ext.mcp.servers.map((s) => s.name)).toEqual(['demo'])
    expect(ext.toolSpecs.map((t) => t.name)).toContain('mcp__demo__ping')
    ext.stop()
  })

  test('注册进 registry 后能真的调通', async () => {
    const { ext } = await withMcp()
    const registry = new ToolRegistry()
    for (const s of ext.toolSpecs) registry.register(s)
    const out = await registry
      .get('mcp__demo__ping')!
      .fn({}, { signal: new AbortController().signal } as never)
    expect(out.status).toBe('success')
    expect(out.message).toBe('pong')
    ext.stop()
  })

  test('连不上的 server 只记 failure，不影响能连上的', async () => {
    const { ext } = await withMcp({ broken: { command: 'qywork-绝对不存在', args: [] } })
    expect(ext.mcp.servers.map((s) => s.name)).toEqual(['demo'])
    expect(ext.mcp.failures.map((f) => f.server)).toEqual(['broken'])
    ext.stop()
  }, 20_000)

  test('没有 mcp.json 时是空注册表，不是错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-nomcp-'))
    const ext = await loadExtensions(root)
    expect(ext.mcp.servers).toEqual([])
    expect(ext.mcp.failures).toEqual([])
    ext.stop()
  })
})

describe('扩展按工作区共享', () => {
  test('两次 acquire 只加载一份，release 到零才停', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-share-'))
    const a = await acquireExtensions(root)
    const b = await acquireExtensions(root)
    // 同一个对象说明只加载了一次——server 每条消息新建一个 Session，
    // 每次都重新加载的话插件和 MCP 子进程会一直往上堆。
    expect(a).toBe(b)
    releaseExtensions(root)
    const c = await acquireExtensions(root)
    expect(c).toBe(a)
    releaseExtensions(root)
    releaseExtensions(root)
    // 归零之后再取是一份新的。
    const d = await acquireExtensions(root)
    expect(d).not.toBe(a)
    releaseExtensions(root)
  })
})
