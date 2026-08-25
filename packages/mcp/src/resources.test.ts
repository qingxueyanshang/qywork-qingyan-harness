/**
 * MCP `resources/*` 与「握手成功但什么都没注册」这类静默失败。
 *
 * 与 `mcp.test.ts` 一样起**真的** server 子进程：要验的是握手声明与后续请求
 * 之间的配合，把传输换成内存对象就把被验的那一层替换掉了。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLIENT_PROTOCOL_VERSION, KNOWN_VERSION_LIST } from './client.ts'
import { loadMcpServers, parseMcpConfig, unsupportedCapabilities } from './load.ts'

interface ServerShape {
  /** 握手时声明的能力。`undefined` = 整个 capabilities 字段都不发。 */
  capabilities?: Record<string, unknown>
  /** 回报的协议版本。默认 2025-06-18（不触发 server/discover）。 */
  version?: string
  /** `server/discover` 返回的能力。`undefined` = 不实现这个方法。 */
  discover?: Record<string, unknown>
  /** 只接受这一版协议，其余一律回「不支持的协议版本」——用来验降版重试。 */
  onlyAcceptVersion?: string
  /** 提供 tools/list。与是否声明能力互相独立——现实里两者会不一致。 */
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

describe('capabilities 不再被丢掉', () => {
  test('握手声明的能力留在 LoadedServer 上', async () => {
    const { reg } = await load({ capabilities: { tools: {}, resources: {} }, serveTools: true })
    expect(reg.servers[0]?.capabilities).toEqual({ tools: {}, resources: {} })
    reg.stopAll()
  })

  test('声明了但未接入的能力要说出来', async () => {
    // 不说出来的话，一个只提供 prompts 的 server 表现是：连上、握手成功、
    // 注册 0 个工具、**没有任何错误**。用户看到「配了但什么都没发生」。
    const { reg, logs } = await load({ capabilities: { prompts: {} } })
    expect(reg.servers[0]?.unsupported).toEqual(['prompts'])
    expect(logs.join('\n')).toContain('prompts')
    reg.stopAll()
  })

  test('产出为零时进 failures，理由里带上 server 声明了什么', async () => {
    const { reg } = await load({ capabilities: { prompts: {} } })
    const f = reg.failures.find((x) => x.server === 'demo')
    expect(f).toBeDefined()
    expect(f?.reason).toContain('prompts')
    // 「没注册任何工具」和「连不上」是两件事，理由必须让人分得开。
    expect(f?.reason).toContain('握手成功')
    reg.stopAll()
  })

  test('一个能力都不声明、也不响应 tools/list → 说清是这两件事', async () => {
    const { reg } = await load({})
    expect(reg.failures[0]?.reason).toContain('没有声明任何能力')
    reg.stopAll()
  })

  test('不声明 capabilities 但正常提供 tools 的 server 照常工作', async () => {
    // 这条锁的是**不能按声明去卡**。本仓库自己的两个测试夹具就是这样，
    // 按声明卡的话它们的工具会被静默丢光——那是把一个静默失败换成另一个。
    const { reg } = await load({ serveTools: true })
    expect(reg.toolSpecs.map((s) => s.name)).toContain('mcp__demo__ping')
    expect(reg.failures).toEqual([])
    reg.stopAll()
  })

  test('声明了 tools 却列不出来 → 是真故障，进 failures', async () => {
    const { reg } = await load({ capabilities: { tools: {} }, serveTools: false })
    expect(reg.failures.length).toBeGreaterThan(0)
    reg.stopAll()
  })
})

describe('resource 工具', () => {
  test('声明了 resources 才注册这两个工具', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    const names = reg.toolSpecs.map((s) => s.name).sort()
    expect(names).toEqual(['mcp__demo__fetch_resource', 'mcp__demo__list_resources'])
    reg.stopAll()
  })

  test('没声明 resources 就不注册', async () => {
    // 注册了的话，模型会调、拿到 Method not found、然后重试——
    // 因为它没法从那条错误看出「这个 server 没这个能力」。
    const { reg } = await load({ capabilities: { tools: {} }, serveTools: true })
    expect(reg.toolSpecs.map((s) => s.name)).not.toContain('mcp__demo__list_resources')
    reg.stopAll()
  })

  test('工具名不叫 read_resource（那个名字被内置工具占了，而且语义相反）', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    expect(reg.toolSpecs.map((s) => s.name)).not.toContain('read_resource')
    reg.stopAll()
  })

  test('工具名带 mcp__ 前缀（sink 的落盘判据靠它）', async () => {
    // 少了前缀，一份超预算的 resource 正文会被直接截断丢掉，
    // 而且不留 resource id——模型连「还有没看到的部分」都不知道。
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    for (const s of reg.toolSpecs) expect(s.name.startsWith('mcp__')).toBe(true)
    reg.stopAll()
  })

  test('权限声明是 read，scope 指向 mcp:<server>/resource', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    for (const s of reg.toolSpecs) {
      expect(s.permissionEffect).toBe('read')
      // 动作轴与权限轴正交：正文来自外部 server，动作是 call，副作用仍然只是读。
      expect(s.actionKind).toBe('call')
      expect(s.targetExtractor?.({})).toBe('mcp:demo/resource')
    }
    reg.stopAll()
  })

  test('列清单跟完游标，且只有元数据不含正文', async () => {
    const { reg } = await load({
      capabilities: { resources: {} },
      serveResources: true,
      paginate: true,
    })
    const list = reg.toolSpecs.find((s) => s.name.endsWith('list_resources'))!
    const out = await list.fn({}, ctx())
    expect(out.message).toContain('file:///a.md')
    // 第二页丢了的话，后面那些 resource 就凭空消失了。
    expect(out.message).toContain('file:///b.md')
    // 清单里**不能**有正文——整个方案 D 的前提就是「一个字节不进上下文」。
    expect(out.message).not.toContain('# 正文')
    reg.stopAll()
  })

  test('按 uri 读正文', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    const fetch = reg.toolSpecs.find((s) => s.name.endsWith('fetch_resource'))!
    const out = await fetch.fn({ uri: 'file:///a.md' }, ctx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('# 正文')
    reg.stopAll()
  })

  test('二进制只留一行占位，不内联 base64', async () => {
    // 内联会瞬间占掉几万 token，而模型通常用不上。
    const { reg } = await load({
      capabilities: { resources: {} },
      serveResources: true,
      blob: true,
    })
    const fetch = reg.toolSpecs.find((s) => s.name.endsWith('fetch_resource'))!
    const out = await fetch.fn({ uri: 'file:///x.png' }, ctx())
    expect(out.message).toContain('二进制 resource')
    expect(out.message).not.toContain('AAAAAAAA')
    reg.stopAll()
  })

  test('空 uri 直接失败，不发请求', async () => {
    const { reg } = await load({ capabilities: { resources: {} }, serveResources: true })
    const fetch = reg.toolSpecs.find((s) => s.name.endsWith('fetch_resource'))!
    expect((await fetch.fn({ uri: '  ' }, ctx())).status).toBe('failure')
    reg.stopAll()
  })
})

describe('unsupportedCapabilities', () => {
  test('按支持清单算，不另写一遍 if', () => {
    // 另写一遍的话，将来接了 prompts 却忘了改这里，
    // 用户会一直看到一句「尚未接 prompts」的假警告。
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
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

/**
 * 协议版本协商。
 *
 * 2026-07-28 把**能力声明从 `initialize` 挪到了 `server/discover`**。
 * 这不是一条可以「以后再说」的版本差异：qywork 是否注册 resource 工具、
 * 是否报「声明了没接的能力」，全都读 `capabilities`。只读 initialize 的话，
 * 一个现代 server 上那个字段是空的——因此**一个工具都不注册、也不报错**，
 * 正是上一组刚修掉的那个静默失败，换个版本原样复发。
 */
describe('协议版本协商', () => {
  test('声明的是最新修订', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe('2026-07-28')
    expect(KNOWN_VERSION_LIST[0]).toBe(CLIENT_PROTOCOL_VERSION)
  })

  test('已知修订按新到旧排列——降版重试依赖这个顺序', () => {
    const sorted = [...KNOWN_VERSION_LIST].sort().reverse()
    expect([...KNOWN_VERSION_LIST]).toEqual(sorted)
  })

  test('现代 server：能力从 server/discover 拿，resource 工具照常注册', async () => {
    const { reg } = await load({
      version: '2026-07-28',
      // initialize 里**什么都不给**，这正是新修订的形状。
      discover: { resources: {} },
      serveResources: true,
    })
    expect(reg.servers[0]?.capabilities).toEqual({ resources: {} })
    expect(reg.toolSpecs.map((s) => s.name).sort()).toEqual([
      'mcp__demo__fetch_resource',
      'mcp__demo__list_resources',
    ])
    reg.stopAll()
  })

  test('旧 server：不发 server/discover，沿用 initialize 的能力', async () => {
    // 对旧 server 发这条只会拿到 Method not found，白花一次往返。
    const { reg, logs } = await load({
      version: '2025-06-18',
      capabilities: { resources: {} },
      serveResources: true,
    })
    expect(logs.join('\n')).not.toContain('server/discover')
    expect(reg.toolSpecs).toHaveLength(2)
    reg.stopAll()
  })

  test('声明新版本却没实现 server/discover：记一行，沿用 initialize 那份', async () => {
    // 现实里一定会遇到。这时 initialize 里那份（如果有）仍然算数。
    const { reg, logs } = await load({
      version: '2026-07-28',
      capabilities: { resources: {} },
      serveResources: true,
    })
    expect(logs.join('\n')).toContain('server/discover')
    expect(reg.toolSpecs).toHaveLength(2)
    reg.stopAll()
  })

  test('两处都给了取并集，不是替换', async () => {
    // 少的那一方是「没说」，不是「没有」。直接覆盖会把一份真实的声明擦掉。
    const { reg } = await load({
      version: '2026-07-28',
      capabilities: { tools: {} },
      discover: { resources: {} },
      serveTools: true,
      serveResources: true,
    })
    expect(Object.keys(reg.servers[0]?.capabilities ?? {}).sort()).toEqual(['resources', 'tools'])
    reg.stopAll()
  })

  test('server 只认旧版本时逐档回退，最终连得上', async () => {
    // 抬高版本号导致一个昨天还能用的 server 今天完全连不上，
    // 对用户来说是最坏的一种「升级」。
    const { reg, logs } = await load({
      onlyAcceptVersion: '2025-06-18',
      version: '2025-06-18',
      capabilities: { tools: {} },
      serveTools: true,
    })
    expect(reg.failures).toEqual([])
    expect(reg.toolSpecs.map((s) => s.name)).toContain('mcp__demo__ping')
    expect(logs.join('\n')).toContain('回退')
    reg.stopAll()
  })
})
