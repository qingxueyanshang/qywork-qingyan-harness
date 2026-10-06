/**
 * 插件端到端测试：启动真实子进程，由其经 RPC 调用宿主能力。
 *
 * mock 无法验证该链路：被验证的是插件进程中没有 fs、只有 RPC，
 * 而 mock 进程会替换被验证的那一层。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBatchBudget, type SinkPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  acquireExtensions,
  globalPluginsDir,
  loadExtensions,
  MCP_CONFIG,
  releaseExtensions,
} from './extensions.ts'

/**
 * 插件安装在全局目录中，因此本组测试使用临时的 `QYWORK_HOME`。
 *
 * 加载完成后立即恢复：`globalScopeRoot()` 每次调用都读取环境变量，不恢复会使
 * 同一进程中后续测试的配置目录也指向该临时目录。
 */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), 'qywork-home-'))
  const before = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = home
  try {
    return await fn(home)
  } finally {
    if (before === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = before
  }
}

/**
 * 插件本体。
 *
 * 它导出 `probe` 工具，工具函数中通过 `host.*` 调用宿主能力，并原样返回结果。
 * 一次 `registry.get('...__probe').fn()` 即经过
 * 工具注册 → 跨进程调用 → 宿主能力 → 结果回传四个环节。
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

function host(parentCallId, method, params) {
  const id = 'h' + Math.random().toString(36).slice(2)
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    send({ type: 'host', id, parentCallId, method, params })
  })
}

async function handle(msg) {
  try {
    const r = await host(msg.id, msg.params.method, msg.params.params ?? {})
    send({ id: msg.id, ok: true, result: { status: 'success', message: 'ok', data: { r } } })
  } catch (err) {
    send({ id: msg.id, ok: true, result: { status: 'failure', message: String(err.message) } })
  }
}

// 证明隔离是真的：插件进程里没有这些模块可用的路径。
// 有的话下面这行会成功，测试会看到 leaked=true。
let leaked = false
try { require('node:fs').readFileSync('/etc/passwd'); leaked = true } catch {}
if (leaked) send({ type: 'leaked' })

send({ type: 'ready' })
`

/**
 * `permissions` 是除 workspace:read 之外需要额外声明的权限。
 *
 * probe 工具的 permissionEffect 是 read，清单解析阶段会强制要求
 * workspace:read：工具声明的动作与插件声明的权限必须一致，
 * 否则用户在安装提示中看到的权限清单与插件的实际能力不一致。
 */
async function workspaceWith(extra: string[]) {
  const permissions = ['workspace:read', ...extra.filter((p) => p !== 'workspace:read')]
  const root = await mkdtemp(join(tmpdir(), 'qywork-ext-'))
  return withTempHome(async () => {
    const dir = join(globalPluginsDir(), 'probe')
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
              name: 'run',
              description: '调一次宿主能力',
              parameters: { type: 'object', properties: {}, additionalProperties: true },
              permissionEffect: 'read',
            },
          ],
        },
      }),
      'utf8',
    )
    await writeFile(join(root, 'hello.txt'), '你好', 'utf8')

    const ext = await loadExtensions(root)
    // 注册名经过规范化：插件 id 是 `test.probe`（反向域名风格），
    // 而 provider 只接受 `^[a-zA-Z0-9_-]+$`，点被替换为下划线。
    const tool = ext.toolSpecs.find((t) => t.name === 'test_probe__run')
    // 工具上下文中只包含插件路径用到的字段。身份由宿主按 callId 保管，
    // 插件侧只能取得一个 parentCallId。
    // 投递额度由 AgentLoop 按决策建立，此处直接建立不设上限的额度。
    const ctx = {
      workspaceRoot: root,
      conversationId: 'cv_test',
      runId: 'run_test',
      signal: new AbortController().signal,
      density: DEFAULT_DENSITY,
      contextWindow: 0,
      sink: null,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    } as unknown as ToolContext
    const probe = async (method: string, params: Record<string, unknown> = {}) =>
      tool!.fn({ method, params }, ctx)
    return { root, ext, ctx, probe, stop: () => ext.stop() }
  })
}

describe('插件端到端', () => {
  test('插件加载成功且工具被注册', async () => {
    const { ext, stop } = await workspaceWith(['workspace:read'])
    expect(ext.plugins.failures).toEqual([])
    expect(ext.toolSpecs.map((t) => t.name)).toContain('test_probe__run')
    stop()
  })

  /** 动作由宿主判定：清单中没有也不应有该字段，插件工具一律记为「调用」。 */
  test('插件工具的动作恒为 call', async () => {
    const { ext, stop } = await workspaceWith(['workspace:read'])
    expect(ext.toolSpecs.find((t) => t.name === 'test_probe__run')?.actionKind).toBe('call')
    stop()
  })

  /**
   * 卡片由动词、对象、目标三层组成。对象名填类名、目标填具体名称，两者不能相同：
   * 相同时标题与目标完全一致，目标字段不提供任何信息。
   * 目标同时承载权限 scope，因此带 `plugin:` 前缀且使用未规范化的 id。
   */
  test('对象名恒为「插件」，具体工具记入 target', async () => {
    const { ext, stop } = await workspaceWith(['workspace:read'])
    const spec = ext.toolSpecs.find((t) => t.name === 'test_probe__run')
    expect(spec?.objectLabel).toBe('插件')
    expect(spec?.targetExtractor?.({})).toBe('plugin:test.probe/run')
    stop()
  })

  test('声明 workspace:read 后可以读取工作区文件', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    const r = await probe('fs.read', { path: 'hello.txt' })
    expect(r.status).toBe('success')
    expect((r.data as { r: { content: string } }).r.content).toBe('你好')
    stop()
  })

  /** 插件结果没有上限：超出本轮剩余额度时 data 整份存入正文库，回执合法且有界。 */
  test('超出剩余额度的插件结果整份存入正文库，回执保留地址', async () => {
    const { root, ctx, probe, stop } = await workspaceWith(['workspace:read'])
    await writeFile(join(root, 'big.txt'), `${'插件正文。'.repeat(40_000)}尾部标记`, 'utf8')
    const landed: Uint8Array[] = []
    const sink: SinkPort = {
      land(input) {
        landed.push(input.body)
        return { resourceId: `rs_${landed.length}`, contentHash: 'sha:x' }
      },
      read: () => null,
      stat: () => null,
    }
    ;(ctx as { sink: SinkPort | null }).sink = sink
    openBatchBudget(ctx.state, 2000)
    const r = await probe('fs.read', { path: 'big.txt' })
    expect(r.status).toBe('success')
    expect(r.data).toBeUndefined()
    expect(String(r.resources?.[0]?.resourceId)).toBe('rs_1')
    expect(new TextDecoder().decode(landed[0]!)).toContain('尾部标记')
    expect(r.message).toContain('rs_1')
    stop()
  })

  test('未声明 workspace:write 时无法写入：权限在宿主侧强制执行', async () => {
    const { root, probe, stop } = await workspaceWith(['workspace:read'])
    const r = await probe('fs.write', { path: 'x.txt', content: '偷偷写' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('workspace:write')
    expect(await Bun.file(join(root, 'x.txt')).exists()).toBe(false)
    stop()
  })

  test('声明 workspace:write 后可以写入', async () => {
    const { root, probe, stop } = await workspaceWith(['workspace:read', 'workspace:write'])
    expect((await probe('fs.write', { path: 'x.txt', content: '写了' })).status).toBe('success')
    expect(await readFile(join(root, 'x.txt'), 'utf8')).toBe('写了')
    stop()
  })

  test('声明 workspace:read 后仍受工作区边界限制', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    expect((await probe('fs.read', { path: '../../../etc/passwd' })).status).toBe('failure')
    stop()
  })

  test('私有存储可用且按插件隔离', async () => {
    const { root, probe, stop } = await workspaceWith(['storage'])
    expect((await probe('storage.set', { key: 'k', value: 42 })).status).toBe('success')
    const got = await probe('storage.get', { key: 'k' })
    expect((got.data as { r: { value: number } }).r.value).toBe(42)
    // 保存为用户可见的普通文件，插件行为异常时可直接查看。
    expect(await Bun.file(join(root, '.qy/plugin-data/test.probe.json')).exists()).toBe(true)
    stop()
  })

  test('未声明 network 时无法访问网络', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    const r = await probe('net.fetch', { url: 'https://example.com' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('network')
    stop()
  })

  test('未声明 process:exec 时无法执行命令', async () => {
    const { probe, stop } = await workspaceWith(['workspace:read'])
    expect((await probe('exec.run', { command: 'echo x' })).message).toContain('process:exec')
    stop()
  })

  test('声明 process:exec 后可以执行，且无法取得宿主的密钥', async () => {
    process.env.QYWORK_EXT_SECRET = 'leaked-secret'
    try {
      const { probe, stop } = await workspaceWith(['process:exec'])
      const r = await probe('exec.run', { command: 'echo "[$QYWORK_EXT_SECRET]"' })
      expect(r.status).toBe('success')
      expect((r.data as { r: { stdout: string } }).r.stdout).not.toContain('leaked-secret')
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

  test('损坏的插件不影响整体加载：记入 failures 而不是抛出异常', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-ext-bad-'))
    const ext = await withTempHome(async () => {
      const dir = join(globalPluginsDir(), 'broken')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'qywork.plugin.json'), '{ 坏的', 'utf8')
      return loadExtensions(root)
    })
    expect(ext.plugins.failures).toHaveLength(1)
    expect(ext.plugins.plugins).toHaveLength(0)
  })

  /*
   * 插件只从全局目录加载，工作区中的 `.agents/plugins` 不是插件目录。
   *
   * 不能只用「全局目录中的插件已安装」反证：两个目录都扫描时，全局目录中的插件同样能安装，
   * 结果完全相同。因此只在工作区中放置一个插件，断言没有任何插件被安装，也不报告 failure：
   * 它不在扫描范围内，报告 failure 是错误的。
   */
  test('工作区 .agents/plugins 中的插件不被加载', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-ext-ws-plugin-'))
    const dir = join(root, '.agents', 'plugins', 'probe')
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
        permissions: ['workspace:read'],
        contributes: {
          tools: [
            {
              name: 'run',
              description: '调一次宿主能力',
              parameters: { type: 'object', properties: {}, additionalProperties: true },
              permissionEffect: 'read',
            },
          ],
        },
      }),
      'utf8',
    )

    const ext = await withTempHome(() => loadExtensions(root))
    expect(ext.plugins.plugins).toHaveLength(0)
    expect(ext.plugins.failures).toHaveLength(0)
    expect(ext.toolSpecs.map((t) => t.name)).not.toContain('test_probe__run')
    await ext.stop()
  })
})

describe('MCP 接入', () => {
  const SERVER = [
    "let buf = ''",
    // 换行使用 fromCharCode 而不是字面转义：该字符串经过 TS 源码、
    // 写入 .mjs、再被 JS 解析，反斜杠层数错误时 server 启动即退出。
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

  /*
   * 加载时会合并全局层的 `mcp.json`，因此本组测试都在临时 `QYWORK_HOME` 下运行。
   * 不隔离时会连接本机真实配置中的 server。
   */
  const prevHome = process.env.QYWORK_HOME
  beforeEach(async () => {
    process.env.QYWORK_HOME = await mkdtemp(join(tmpdir(), 'qywork-mcphome-'))
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = prevHome
  })

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

  test('mcp.json 中的 server 被连接，工具进入 toolSpecs', async () => {
    const { ext } = await withMcp()
    expect(ext.mcp.failures).toEqual([])
    expect(ext.mcp.servers.map((s) => s.name)).toEqual(['demo'])
    expect(ext.toolSpecs.map((t) => t.name)).toContain('mcp__demo__ping')
    await ext.stop()
  })

  test('注册到 registry 后可以成功调用', async () => {
    const { ext } = await withMcp()
    const registry = new ToolRegistry()
    for (const s of ext.toolSpecs) registry.register(s)
    const out = await registry.get('mcp__demo__ping')!.fn({}, {
      signal: new AbortController().signal,
      density: DEFAULT_DENSITY,
      contextWindow: 0,
      sink: null,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    } as never)
    expect(out.status).toBe('success')
    expect(out.message).toBe('pong')
    await ext.stop()
  })

  test('无法连接的 server 只记入 failure，不影响可连接的 server', async () => {
    const { ext } = await withMcp({ broken: { command: 'qywork-绝对不存在', args: [] } })
    expect(ext.mcp.servers.map((s) => s.name)).toEqual(['demo'])
    expect(ext.mcp.failures.map((f) => f.server)).toEqual(['broken'])
    await ext.stop()
  }, 20_000)

  test('没有 mcp.json 时是空注册表，不是错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-nomcp-'))
    const ext = await loadExtensions(root)
    expect(ext.mcp.servers).toEqual([])
    expect(ext.mcp.failures).toEqual([])
    await ext.stop()
  })
})

describe('扩展按工作区共享', () => {
  test('两次 acquire 只加载一份，release 计数归零时才停止', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qywork-share-'))
    const a = await acquireExtensions(root)
    const b = await acquireExtensions(root)
    // 同一对象说明只加载了一次：server 每条消息新建一个 Session，
    // 每次都重新加载时插件与 MCP 子进程会持续累积。
    expect(a.mcp).toBe(b.mcp)
    await releaseExtensions(a)
    const c = await acquireExtensions(root)
    expect(c.mcp).toBe(a.mcp)
    await releaseExtensions(b)
    await releaseExtensions(c)
    // 归零后再次取得的是新实例。
    const d = await acquireExtensions(root)
    expect(d.mcp).not.toBe(a.mcp)
    await releaseExtensions(d)
  })
})
