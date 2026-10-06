/**
 * 覆盖 MCP `resources/*`，以及「握手成功但未注册任何工具」这类静默失败。
 *
 * 与 `mcp.test.ts` 相同，启动真实的 server 子进程：验证的是握手声明与后续请求
 * 之间的配合，把传输替换为内存对象会替换掉被验证的那一层。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBatchBudget } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { CLIENT_PROTOCOL_VERSION, KNOWN_VERSION_LIST } from './client.ts'
import { loadMcpServers, parseMcpConfig, unsupportedCapabilities } from './load.ts'

interface ServerShape {
  /** 握手时声明的能力。`undefined` 表示不发送 capabilities 字段。 */
  capabilities?: Record<string, unknown>
  /** 返回的协议版本。默认 2025-06-18（不触发 server/discover）。 */
  version?: string
  /** `server/discover` 返回的能力。`undefined` 表示不实现该方法。 */
  discover?: Record<string, unknown>
  /** 只接受该版本协议，其余一律返回「不支持的协议版本」，用于验证降版重试。 */
  onlyAcceptVersion?: string
  /** 提供 tools/list。与是否声明能力相互独立：实际中两者可能不一致。 */
  serveTools?: boolean
  serveResources?: boolean
  /** resources/list 分页。 */
  paginate?: boolean
  /** resources/read 返回二进制而不是文本。 */
  blob?: boolean
}

function serverSource(s: ServerShape): string {
  const caps =
    s.capabilities === undefined ? '' : `capabilities: ${JSON.stringify(s.capabilities)},`
  return `
let buf = ''
const ONLY = ${JSON.stringify(s.onlyAcceptVersion ?? null)}
const VERSION = ${JSON.stringify(s.version ?? '2025-06-18')}
const DISCOVER = ${JSON.stringify(s.discover ?? null)}
globalThis.__seenVersions = []
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const R1 = [{ uri: 'file:///a.md', name: 'a', title: 'A 文档', mimeType: 'text/markdown', description: '第一篇' }]
const R2 = [{ uri: 'file:///b.md', name: 'b', mimeType: 'text/markdown' }]

process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }

    if (m.method === 'initialize') {
      if (ONLY !== null && m.params?.protocolVersion !== ONLY) {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unsupported protocol version: ' + m.params?.protocolVersion } })
        continue
      }
      send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: VERSION,
        ${caps}
        serverInfo: { name: 'fx', version: '1.0.0' },
      } })
      continue
    }
    if (m.method === 'notifications/initialized') continue
    if (m.method === 'server/discover') {
      if (DISCOVER === null) {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } })
      } else {
        send({ jsonrpc: '2.0', id: m.id, result: { capabilities: DISCOVER } })
      }
      continue
    }

    ${
      s.serveTools
        ? `if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'p', inputSchema: { type: 'object' } }] } }); continue }`
        : ''
    }
    ${
      s.serveResources
        ? `if (m.method === 'resources/list') {
      ${
        s.paginate
          ? `if (!m.params?.cursor) send({ jsonrpc: '2.0', id: m.id, result: { resources: R1, nextCursor: 'p2' } })
      else send({ jsonrpc: '2.0', id: m.id, result: { resources: R2 } })`
          : `send({ jsonrpc: '2.0', id: m.id, result: { resources: R1 } })`
      }
      continue
    }
    if (m.method === 'resources/read') {
      ${
        s.blob
          ? `send({ jsonrpc: '2.0', id: m.id, result: { contents: [{ uri: m.params.uri, mimeType: 'image/png', blob: 'AAAA'.repeat(1024) }] } })`
          : `send({ jsonrpc: '2.0', id: m.id, result: { contents: [{ uri: m.params.uri, mimeType: 'text/markdown', text: '# 正文' }] } })`
      }
      continue
    }`
        : ''
    }

    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method: ' + m.method } })
  }
})
`
}

async function load(s: ServerShape) {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-mcp-res-'))
  const entry = join(dir, 'server.mjs')
  await writeFile(entry, serverSource(s), 'utf8')
  const logs: string[] = []
  const cfg = parseMcpConfig(
    JSON.stringify({ servers: { demo: { command: process.execPath, args: [entry] } } }),
  )
  const reg = await loadMcpServers(cfg, dir, { onLog: (l) => logs.push(l) })
  return { reg, logs }
}

describe('capabilities 不被丢弃', () => {
  test('握手声明的能力保留在 LoadedServer 上', async () => {
    const { reg } = await load({ capabilities: { tools: {}, resources: {} }, serveTools: true })
    expect(reg.servers[0]?.capabilities).toEqual({ tools: {}, resources: {} })
    await reg.stopAll()
  })

  test('已声明但未接入的能力必须报告', async () => {
    // 不报告时，只提供 prompts 的 server 会连接成功、握手成功、
    // 注册 0 个工具且没有任何错误，用户只看到配置后没有任何效果。
    const { reg, logs } = await load({ capabilities: { prompts: {} } })
    expect(reg.servers[0]?.unsupported).toEqual(['prompts'])
    expect(logs.join('\n')).toContain('prompts')
    await reg.stopAll()
  })

  test('产出为零时记入 failures，原因中包含 server 声明的能力', async () => {
    const { reg } = await load({ capabilities: { prompts: {} } })
    const f = reg.failures.find((x) => x.server === 'demo')
    expect(f).toBeDefined()
    expect(f?.reason).toContain('prompts')
    // 「未注册任何工具」与「无法连接」是不同的情况，原因必须能区分两者。
    expect(f?.reason).toContain('握手成功')
    await reg.stopAll()
  })

  test('未声明任何能力且不响应 tools/list 时，原因中写明这两点', async () => {
    const { reg } = await load({})
    expect(reg.failures[0]?.reason).toContain('没有声明任何能力')
    await reg.stopAll()
  })

  test('未声明 capabilities 但正常提供 tools 的 server 正常工作', async () => {
    // 本测试锁定：不能按能力声明进行限制。本仓库的两个测试夹具即属于这种情况，
    // 按声明限制时它们的工具会被静默全部丢弃，只是把一种静默失败替换为另一种。
    const { reg } = await load({ serveTools: true })
    expect(reg.toolSpecs.map((s) => s.name)).toContain('mcp__demo__ping')
    expect(reg.failures).toEqual([])
    await reg.stopAll()
  })

  test('声明了 tools 却无法列出时属于真实故障，记入 failures', async () => {
    const { reg } = await load({ capabilities: { tools: {} }, serveTools: false })
    expect(reg.failures.length).toBeGreaterThan(0)
    await reg.stopAll()
  })
})

describe('resource 工具', () => {
  test('声明 resources 时才注册这两个工具', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    const names = reg.toolSpecs.map((s) => s.name).sort()
    expect(names).toEqual(['mcp__demo__fetch_resource', 'mcp__demo__list_resources'])
    await reg.stopAll()
  })

  test('未声明 resources 时不注册', async () => {
    // 若注册，模型会调用并得到 Method not found，然后重试：
    // 模型无法从该错误判断出 server 不具备该能力。
    const { reg } = await load({ capabilities: { tools: {} }, serveTools: true })
    expect(reg.toolSpecs.map((s) => s.name)).not.toContain('mcp__demo__list_resources')
    await reg.stopAll()
  })

  test('工具名不使用 read_resource（该名称已被内置工具占用，且语义相反）', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    expect(reg.toolSpecs.map((s) => s.name)).not.toContain('read_resource')
    await reg.stopAll()
  })

  test('工具名带 mcp__ 前缀（sink 的落盘判据依赖该前缀）', async () => {
    // 缺少前缀时，超出预算的 resource 正文会被直接截断丢弃，
    // 且不保留 resource id，模型无从得知还有未读取的部分。
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    for (const s of reg.toolSpecs) expect(s.name.startsWith('mcp__')).toBe(true)
    await reg.stopAll()
  })

  test('权限声明是 read，scope 指向 mcp:<server>/resource', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    for (const s of reg.toolSpecs) {
      expect(s.permissionEffect).toBe('read')
      // 动作维度与权限维度正交：正文来自外部 server，动作是 call，副作用仍然只是读取。
      expect(s.actionKind).toBe('call')
      expect(s.targetExtractor?.({})).toBe('mcp:demo/resource')
    }
    await reg.stopAll()
  })

  test('列出清单时遍历全部游标，且只含元数据不含正文', async () => {
    const { reg } = await load({
      capabilities: { resources: {} },
      serveResources: true,
      paginate: true,
    })
    const list = reg.toolSpecs.find((s) => s.name.endsWith('list_resources'))!
    const out = await list.fn({}, ctx())
    expect(out.message).toContain('file:///a.md')
    // 丢失第二页时，其后的 resource 不会出现在清单中。
    expect(out.message).toContain('file:///b.md')
    // 清单中不能包含正文：该设计的前提是 resource 正文不进入上下文。
    expect(out.message).not.toContain('# 正文')
    await reg.stopAll()
  })

  test('按 uri 读取正文', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    const fetch = reg.toolSpecs.find((s) => s.name.endsWith('fetch_resource'))!
    const out = await fetch.fn({ uri: 'file:///a.md' }, ctx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('# 正文')
    await reg.stopAll()
  })

  test('二进制内容只保留一行占位，不内联 base64', async () => {
    // 内联会立即占用数万 token，而模型通常不需要这些内容。
    const { reg } = await load({
      capabilities: { resources: {} },
      serveResources: true,
      blob: true,
    })
    const fetch = reg.toolSpecs.find((s) => s.name.endsWith('fetch_resource'))!
    const out = await fetch.fn({ uri: 'file:///x.png' }, ctx())
    expect(out.message).toContain('二进制 resource')
    expect(out.message).not.toContain('AAAAAAAA')
    await reg.stopAll()
  })

  test('空 uri 直接失败，不发送请求', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    const fetch = reg.toolSpecs.find((s) => s.name.endsWith('fetch_resource'))!
    expect((await fetch.fn({ uri: '  ' }, ctx())).status).toBe('failure')
    await reg.stopAll()
  })
})

describe('unsupportedCapabilities', () => {
  test('按支持清单计算，不另写 if 判断', () => {
    // 另写判断时，接入 prompts 后若未同步修改此处，
    // 用户会持续看到「尚未接入 prompts」的错误警告。
    expect(unsupportedCapabilities({ tools: {}, resources: {}, prompts: {}, logging: {} })).toEqual(
      ['logging', 'prompts'],
    )
    expect(unsupportedCapabilities({})).toEqual([])
  })
})

function ctx() {
  return {
    workspaceRoot: '/ws',
    conversationId: 'cv',
    runId: 'rn',
    model: 'm',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true as const }),
  }
}

/**
 * 协议版本协商。
 *
 * 2026-07-28 修订把能力声明从 `initialize` 移到了 `server/discover`。
 * 这一版本差异必须处理：qywork 是否注册 resource 工具、
 * 是否报告「已声明但未接入的能力」，都读取 `capabilities`。只读取 initialize 时，
 * 新版 server 上该字段为空，因此不注册任何工具，也不报错，
 * 即上一组测试覆盖的静默失败在新版本上再次出现。
 */
describe('协议版本协商', () => {
  test('声明的是最新修订', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe('2026-07-28')
    expect(KNOWN_VERSION_LIST[0]).toBe(CLIENT_PROTOCOL_VERSION)
  })

  test('已知修订按从新到旧排列，降版重试依赖该顺序', () => {
    const sorted = [...KNOWN_VERSION_LIST].sort().reverse()
    expect([...KNOWN_VERSION_LIST]).toEqual(sorted)
  })

  test('新版 server：能力取自 server/discover，resource 工具正常注册', async () => {
    const { reg } = await load({
      version: '2026-07-28',
      // initialize 中不提供任何能力，这正是新修订的格式。
      discover: { resources: {} },
      serveResources: true,
    })
    expect(reg.servers[0]?.capabilities).toEqual({ resources: {} })
    expect(reg.toolSpecs.map((s) => s.name).sort()).toEqual([
      'mcp__demo__fetch_resource',
      'mcp__demo__list_resources',
    ])
    await reg.stopAll()
  })

  test('旧 server：不发送 server/discover，沿用 initialize 的能力', async () => {
    // 向旧 server 发送该请求只会得到 Method not found，多一次无效的往返。
    const { reg, logs } = await load({
      version: '2025-06-18',
      capabilities: { resources: {} },
      serveResources: true,
    })
    expect(logs.join('\n')).not.toContain('server/discover')
    expect(reg.toolSpecs).toHaveLength(2)
    await reg.stopAll()
  })

  test('声明新版本却未实现 server/discover：记录一行日志，沿用 initialize 中的能力', async () => {
    // 实际中必然会出现这种情况。此时 initialize 中的能力声明（若有）仍然有效。
    const { reg, logs } = await load({
      version: '2026-07-28',
      capabilities: { resources: {} },
      serveResources: true,
    })
    expect(logs.join('\n')).toContain('server/discover')
    expect(reg.toolSpecs).toHaveLength(2)
    await reg.stopAll()
  })

  test('两处都提供能力时取并集，而不是替换', async () => {
    // 能力较少的一方表示未声明，而不是不具备。直接覆盖会丢失一份真实的声明。
    const { reg } = await load({
      version: '2026-07-28',
      capabilities: { tools: {} },
      discover: { resources: {} },
      serveTools: true,
      serveResources: true,
    })
    expect(Object.keys(reg.servers[0]?.capabilities ?? {}).sort()).toEqual(['resources', 'tools'])
    await reg.stopAll()
  })

  test('server 只接受旧版本时逐档回退，最终连接成功', async () => {
    // 提高版本号后，此前可用的 server 若完全无法连接，
    // 对用户而言是最差的升级结果。
    const { reg, logs } = await load({
      onlyAcceptVersion: '2025-06-18',
      version: '2025-06-18',
      capabilities: { tools: {} },
      serveTools: true,
    })
    expect(reg.failures).toEqual([])
    expect(reg.toolSpecs.map((s) => s.name)).toContain('mcp__demo__ping')
    expect(logs.join('\n')).toContain('回退')
    await reg.stopAll()
  })
})
