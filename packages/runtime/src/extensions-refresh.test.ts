/** 覆盖共享扩展缓存、配置写入、工具注册、Session 当轮刷新及 stdio 关闭。 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBatchBudget, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { Store } from '@qywork/store'
import { writeMcpServerTool } from '../../tools/src/mcp-config.ts'
import { acquireExtensions, type Extensions } from './extensions.ts'
import { makeMcpConfigPort } from './mcp-config-store.ts'
import { Session } from './session.ts'

let root: string
let home: string
let prior: string | undefined
const leases: Extensions[] = []
const servers: { stop(force?: boolean): unknown }[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-refresh-'))
  home = await mkdtemp(join(tmpdir(), 'mcp-refresh-home-'))
  prior = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = home
})
afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.stop()
  for (const server of servers.splice(0)) server.stop(true)
  if (prior === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prior
})
async function acquire(workspace = root, live = false): Promise<Extensions> {
  const ext = await acquireExtensions(workspace, undefined, live)
  leases.push(ext)
  return ext
}
function context(): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv',
    runId: 'rn',
    model: 'fixture',
    contextWindow: 100000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Infinity),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    mcpConfig: makeMcpConfigPort(root),
  }
}
function mcp() {
  let initialized = 0
  let closed = 0
  let authorized = false
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (request.method === 'DELETE') {
        closed++
        return new Response(null, { status: 204 })
      }
      const path = new URL(request.url).pathname
      if (path === '/unauthorized' && !authorized) return new Response('需要鉴权', { status: 401 })
      const msg = (await request.json()) as { id?: number; method: string }
      if (msg.id === undefined) return new Response(null, { status: 202 })
      const name = path === '/second' ? 'pong' : 'ping'
      let result: unknown = {}
      if (msg.method === 'initialize') {
        initialized++
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture' },
        }
      } else if (msg.method === 'tools/list') {
        result = {
          tools: [
            {
              name,
              description: '只读探针',
              inputSchema: {
                type: 'object',
                properties:
                  path === '/large'
                    ? { value: { type: 'string', description: 'schema '.repeat(1800) } }
                    : {},
              },
              annotations: { readOnlyHint: true },
            },
          ],
        }
      } else if (msg.method === 'tools/call')
        result = { content: [{ type: 'text', text: `${path}:pong` }] }
      return Response.json(
        { jsonrpc: '2.0', id: msg.id, result },
        { headers: { 'mcp-session-id': `${initialized}` } },
      )
    },
  })
  servers.push(server)
  return {
    url: server.url.href.replace(/\/$/, ''),
    initialized: () => initialized,
    closed: () => closed,
    authorize: () => {
      authorized = true
    },
  }
}

test('连接失败后重新提交相同配置会重新握手，不永久复用失败缓存', async () => {
  const service = mcp()
  await acquire(root, true)
  const port = makeMcpConfigPort(root)
  const input = {
    name: 'probe',
    scope: 'project' as const,
    configJson: JSON.stringify({ url: `${service.url}/unauthorized` }),
  }
  expect((await port.writeServer(input)).activation?.connected).toBe(false)
  service.authorize()
  expect((await port.writeServer(input)).activation?.connected).toBe(true)
  expect((await call(await acquire(), 'mcp__probe__ping')).status).toBe('success')
})

test('同一 Session 的大 schema 进入池，升级后旧已加载工具与缓存同时移除', async () => {
  const service = mcp()
  const store = new Store({ path: ':memory:' })
  const session = new Session({
    workspaceRoot: root,
    store,
    signal: new AbortController().signal,
    config: { mode: 'full', providers: {} },
  })
  const runtime = session as unknown as {
    registry: ToolRegistry
    loadExtensionTools(density: typeof DEFAULT_DENSITY): Promise<boolean>
  }
  const port = makeMcpConfigPort(root)
  try {
    await runtime.loadExtensionTools(DEFAULT_DENSITY)
    await port.writeServer({
      name: 'probe',
      scope: 'project',
      configJson: JSON.stringify({ url: `${service.url}/large` }),
    })
    await runtime.loadExtensionTools(DEFAULT_DENSITY)
    expect(runtime.registry.has('load_tool')).toBe(true)
    expect(runtime.registry.has('mcp__probe__ping')).toBe(false)
    expect(runtime.registry.get('load_tool')?.description).toContain('mcp__probe__ping')
    expect(
      (await runtime.registry.execute('load_tool', { names: ['mcp__probe__ping'] }, context()))
        .status,
    ).toBe('success')
    const initial = runtime.registry.schemas()
    await port.writeServer({
      name: 'probe',
      scope: 'project',
      configJson: JSON.stringify({ url: `${service.url}/second` }),
    })
    await runtime.loadExtensionTools(DEFAULT_DENSITY)
    expect(runtime.registry.has('mcp__probe__ping')).toBe(false)
    expect(runtime.registry.has('load_tool')).toBe(false)
    expect(runtime.registry.schemas()).not.toBe(initial)
    expect((await runtime.registry.execute('mcp__probe__pong', {}, context())).message).toContain(
      '/second:pong',
    )
  } finally {
    await session.dispose()
    store.close()
  }
})
async function call(ext: Extensions, name: string) {
  const registry = new ToolRegistry()
  for (const spec of ext.toolSpecs) registry.register(spec)
  return registry.execute(name, {}, context())
}

test('后台持有空缓存，正式写入后新工具可调用；重复 acquire 不重连', async () => {
  const service = mcp()
  const background = await acquire(root, true)
  expect(background.toolSpecs).toEqual([])
  const registry = new ToolRegistry()
  registry.register(writeMcpServerTool)
  const outcome = await registry.execute(
    'write_mcp_server',
    { name: 'probe', config_json: JSON.stringify({ url: `${service.url}/first` }) },
    context(),
  )
  expect(outcome.status).toBe('success')
  expect(outcome.message).not.toContain('重连后')
  expect(background.toolSpecs.map((s) => s.name)).toContain('mcp__probe__ping')
  const active = await acquire()
  expect((await call(active, 'mcp__probe__ping')).message).toContain('/first:pong')
  await acquire()
  expect(service.initialized()).toBe(1)
})

test('更新只替换变更服务；旧句柄继续可调用，旧 release 不关闭新连接', async () => {
  const service = mcp()
  await acquire(root, true)
  const port = makeMcpConfigPort(root)
  await port.writeServer({
    name: 'probe',
    scope: 'project',
    configJson: JSON.stringify({ url: `${service.url}/first` }),
  })
  await port.writeServer({
    name: 'stable',
    scope: 'project',
    configJson: JSON.stringify({ url: `${service.url}/stable` }),
  })
  const previous = await acquire()
  await port.writeServer({
    name: 'probe',
    scope: 'project',
    configJson: JSON.stringify({ url: `${service.url}/second` }),
  })
  const current = await acquire()
  expect(current.toolSpecs.map((s) => s.name)).not.toContain('mcp__probe__ping')
  expect((await call(previous, 'mcp__probe__ping')).status).toBe('success')
  expect(service.initialized()).toBe(3)
  expect(service.closed()).toBe(0)
  await previous.stop()
  expect(service.closed()).toBe(1)
  expect((await call(current, 'mcp__probe__pong')).status).toBe('success')
  await previous.stop()
  expect(service.closed()).toBe(1)
})

test('连接拒绝如实保留 saved；禁用后新快照不含旧工具', async () => {
  const service = mcp()
  await acquire(root, true)
  const port = makeMcpConfigPort(root)
  const bad = await port.writeServer({
    name: 'bad',
    scope: 'project',
    configJson: JSON.stringify({ url: `${service.url}/unauthorized` }),
  })
  expect(bad).toMatchObject({ ok: true, saved: true, activation: { connected: false } })
  expect(bad.activation?.failures[0]?.reason).toContain('401')
  await port.writeServer({
    name: 'probe',
    scope: 'project',
    configJson: JSON.stringify({ url: service.url }),
  })
  const held = await acquire()
  const disabled = await port.writeServer({
    name: 'probe',
    scope: 'project',
    configJson: JSON.stringify({ url: service.url, enabled: false }),
  })
  expect(disabled.activation?.inactive).toEqual(['probe'])
  expect((await acquire()).toolSpecs).toEqual([])
  expect((await call(held, 'mcp__probe__ping')).status).toBe('success')
})

test('全局变更更新多个缓存工作区，项目覆盖不重连；并发写入不丢配置', async () => {
  const service = mcp()
  const second = await mkdtemp(join(tmpdir(), 'mcp-other-'))
  const firstLease = await acquire(root, true)
  const secondLease = await acquire(second, true)
  const port = makeMcpConfigPort(root)
  await makeMcpConfigPort(second).writeServer({
    name: 'probe',
    scope: 'project',
    configJson: JSON.stringify({ url: `${service.url}/stable` }),
  })
  await port.writeServer({
    name: 'probe',
    scope: 'global',
    configJson: JSON.stringify({ url: `${service.url}/first` }),
  })
  expect((await call(firstLease, 'mcp__probe__ping')).message).toContain('/first:pong')
  expect((await call(secondLease, 'mcp__probe__ping')).message).toContain('/stable:pong')
  await port.writeServer({
    name: 'probe',
    scope: 'global',
    configJson: JSON.stringify({ url: `${service.url}/second` }),
  })
  expect(service.initialized()).toBe(3)
  expect((await call(secondLease, 'mcp__probe__ping')).message).toContain('/stable:pong')
  await Promise.all(
    ['a', 'b'].map((name) =>
      port.writeServer({
        name,
        scope: 'project',
        configJson: JSON.stringify({ url: service.url, enabled: false }),
      }),
    ),
  )
  const saved = JSON.parse(await readFile(join(root, '.agents', 'mcp.json'), 'utf8'))
  expect(Object.keys(saved.mcpServers).sort()).toEqual(['a', 'b'])
})

test('Session 同一任务安装后下一请求直接调用新工具', async () => {
  const service = mcp()
  await acquire(root, true)
  let turn = 0
  let toolsAfterInstall: string[] = []
  const relay = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const request = (await req.json()) as { tools?: { function: { name: string } }[] }
      turn++
      let delta: unknown
      if (turn === 1)
        delta = {
          tool_calls: [
            {
              index: 0,
              id: 'install',
              type: 'function',
              function: {
                name: 'write_mcp_server',
                arguments: JSON.stringify({
                  name: 'probe',
                  config_json: JSON.stringify({ url: service.url }),
                }),
              },
            },
          ],
        }
      else if (turn === 2) {
        toolsAfterInstall = request.tools?.map((t) => t.function.name) ?? []
        delta = {
          tool_calls: [
            {
              index: 0,
              id: 'probe',
              type: 'function',
              function: { name: 'mcp__probe__ping', arguments: '{}' },
            },
          ],
        }
      } else delta = { content: '已验证 pong' }
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: turn < 3 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  servers.push(relay)
  const store = new Store({ path: ':memory:' })
  const session = new Session({
    workspaceRoot: root,
    store,
    signal: new AbortController().signal,
    config: {
      mode: 'full',
      active: { provider: 'local', model: 'deepseek-v4-flash' },
      providers: {
        local: {
          kind: 'openai_chat_completions',
          apiKey: 'fixture',
          baseUrl: `${relay.url.href}v1`,
          models: { 'deepseek-v4-flash': {} },
        },
      },
    },
  })
  try {
    const events = []
    for await (const event of session.ask('安装并验证这个 MCP')) events.push(event)
    expect(toolsAfterInstall).toContain('mcp__probe__ping')
    const finished = events.filter((event) => event.type === 'tool.finished')
    expect(finished.map((e) => e.status)).toEqual(['success', 'success'])
    expect(finished[1]?.outcome.message).toContain('pong')
  } finally {
    await session.dispose()
    store.close()
  }
})

test('stdio 最后句柄释放后可立即删除其工作目录，重复释放幂等', async () => {
  const folder = join(root, 'server')
  await mkdir(folder)
  const script = join(folder, 'probe.cjs')
  await writeFile(
    script,
    `let b='';process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'ping',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'pong'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}})`,
  )
  await mkdir(join(root, '.agents'))
  await writeFile(
    join(root, '.agents', 'mcp.json'),
    JSON.stringify({
      mcpServers: { probe: { command: process.execPath, args: [script], cwd: 'server' } },
    }),
  )
  const ext = await acquire()
  expect((await call(ext, 'mcp__probe__ping')).status).toBe('success')
  await Promise.all([ext.stop(), ext.stop()])
  await rm(folder, { recursive: true })
  expect(await Bun.file(script).exists()).toBe(false)
})
