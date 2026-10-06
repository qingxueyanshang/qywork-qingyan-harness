/**
 * MCP 端到端测试：启动一个真实的 MCP server 子进程，执行完整的 JSON-RPC 握手。
 *
 * 不模拟传输层。要验证的是帧格式与握手顺序是否正确、游标是否遍历完毕；
 * 把传输替换为内存对象即替换了被验证的那一层。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBatchBudget, type SinkPort, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { McpClient } from './client.ts'
import { loadMcpServers, parseMcpConfig } from './load.ts'
import { permissionLabel, renderContent, specFor, toolName } from './register.ts'

/**
 * 一个最小但真实的 MCP server。
 *
 * `opts` 控制其行为，用于构造各种边界情况：分页、慢响应、错误帧、拒绝握手。
 */
function serverSource(
  opts: {
    paginate?: boolean
    banner?: boolean
    skipInitialized?: boolean
    toolError?: boolean
    annotations?: Record<string, unknown>
  } = {},
): string {
  return `
let buf = ''
let initialized = ${opts.skipInitialized ? 'true' : 'false'}
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
${opts.banner ? "process.stdout.write('starting up...\\n')" : ''}

const TOOLS_A = [{
  name: 'echo',
  description: '原样返回',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  annotations: ${JSON.stringify(opts.annotations ?? {})},
}]
const TOOLS_B = [{ name: 'second_page', description: '第二页的工具', inputSchema: { type: 'object' } }]

process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }

    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '9.9.9' },
      } })
      continue
    }
    if (m.method === 'notifications/initialized') { initialized = true; continue }

    if (!initialized) {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: '还没 initialized' } })
      continue
    }

    if (m.method === 'tools/list') {
      ${
        opts.paginate
          ? `const cursor = m.params?.cursor
      if (!cursor) send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS_A, nextCursor: 'p2' } })
      else send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS_B } })`
          : `send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS_A } })`
      }
      continue
    }

    if (m.method === 'tools/call' && m.params?.name === 'no_such_tool') {
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: '没有这个工具' } })
      continue
    }

    if (m.method === 'tools/call') {
      ${
        opts.toolError
          ? `send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '这个工具坏了' }], isError: true } })`
          : `send({ jsonrpc: '2.0', id: m.id, result: {
        content: [{ type: 'text', text: '收到：' + JSON.stringify(m.params.arguments) }],
      } })`
      }
      continue
    }

    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method: ' + m.method } })
  }
})
`
}

async function fixture(opts: Parameters<typeof serverSource>[0] = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-mcp-'))
  const entry = join(dir, 'server.mjs')
  await writeFile(entry, serverSource(opts), 'utf8')
  return { dir, entry }
}

function client(entry: string, dir: string, logs: string[] = []) {
  return new McpClient({
    name: 'fx',
    spec: { command: process.execPath, args: [entry] },
    cwd: dir,
    onLog: (l) => logs.push(l),
  })
}

describe('握手', () => {
  test('initialize 之后取得 serverInfo 与协议版本', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    expect(c.serverInfo.name).toBe('fixture')
    expect(c.protocolVersion).toBe('2025-06-18')
    await c.stop()
  })

  /**
   * `notifications/initialized` 不能省略。该 fixture 在收到它之前拒绝所有请求；
   * 真实 server 中这种行为很常见，省略该步骤时 tools/list 会持续报错。
   */
  test('发送 initialized 通知后，后续请求才被接受', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo'])
    await c.stop()
  })

  test('命令不存在时立即失败，不阻塞至超时', async () => {
    const c = new McpClient({
      name: 'nope',
      spec: { command: 'qywork-绝对不存在的命令', args: [] },
      cwd: process.cwd(),
    })
    const started = Date.now()
    await expect(c.start()).rejects.toThrow()
    // 超时为 30 秒；几秒内返回说明经由 error 事件而不是超时。
    expect(Date.now() - started).toBeLessThan(10_000)
    await c.stop()
  }, 20_000)

  test('stdout 上的 banner 不会破坏连接', async () => {
    const { dir, entry } = await fixture({ banner: true })
    const logs: string[] = []
    const c = client(entry, dir, logs)
    await c.start()
    expect(c.serverInfo.name).toBe('fixture')
    // 非协议行转为日志，不静默丢弃：丢弃会使 server 输出的错误信息丢失。
    expect(logs.some((l) => l.includes('starting up'))).toBe(true)
    await c.stop()
  })
})

describe('tools/list 分页', () => {
  test('遍历完游标后，两页的工具都存在', async () => {
    const { dir, entry } = await fixture({ paginate: true })
    const c = client(entry, dir)
    await c.start()
    // 只取第一页时 second_page 会丢失，且没有任何报错。
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo', 'second_page'])
    await c.stop()
  })
})

describe('tools/call', () => {
  test('参数原样送达，结果原样返回', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const r = await c.callTool('echo', { text: '你好' })
    expect(r.isError).toBe(false)
    expect(r.content[0]?.text).toContain('你好')
    await c.stop()
  })

  test('isError 表示工具失败而不是协议错误，不抛出异常', async () => {
    const { dir, entry } = await fixture({ toolError: true })
    const c = client(entry, dir)
    await c.start()
    const r = await c.callTool('echo', {})
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toBe('这个工具坏了')
    await c.stop()
  })

  test('JSON-RPC error 转为异常，并附带 server 给出的原因', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    // 只说明「调用失败」时，模型会以相同参数重试；附带原因后模型才可能修改参数。
    const err = await c.callTool('no_such_tool', {}).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(err).toContain('没有这个工具')
    expect(err).toContain('-32602')
    await c.stop()
  })

  test('进程退出时在途请求被逐个拒绝，不阻塞至超时', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const inFlight = c.callTool('echo', { text: 'x' })
    const rejected = inFlight.then(
      () => null,
      (error: unknown) => error,
    )
    await c.stop()
    expect(await rejected).toBeInstanceOf(Error)
  })
})

describe('权限：server 的 hint 只能收紧，不能放宽', () => {
  test('默认为 execute，每次调用都经过权限检查', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    expect(spec.permissionEffect).toBe('execute')
    await c.stop()
  })

  /**
   * 本测试锁定整个 MCP 权限模型的核心约束。
   *
   * `readOnlyHint` 由 server 自行填写，而 server 是第三方代码。用它决定
   * 是否弹出授权，等于由被审查方自行决定审查结果。
   */
  test('readOnlyHint: true 也不降级，被审查方不能自行决定审查结果', async () => {
    const { dir, entry } = await fixture({ annotations: { readOnlyHint: true } })
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    expect(spec.permissionEffect).toBe('execute')
    await c.stop()
  })

  test('destructiveHint: true 收紧为 delete', async () => {
    const { dir, entry } = await fixture({ annotations: { destructiveHint: true } })
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    expect(spec.permissionEffect).toBe('delete')
    // 收紧的是权限维度。动作维度与它正交，恒为 call：外部 server 的能力不属于本机执行。
    expect(spec.actionKind).toBe('call')
    await c.stop()
  })

  test('scope 目标可按前缀 autoApprove', () => {
    expect(permissionLabel('github', 'create_issue')).toBe('mcp:github/create_issue')
    expect(permissionLabel('github', 'x').startsWith('mcp:github/')).toBe(true)
  })

  /**
   * 卡片由动词、对象、目标三层组成。对象名填类别名，目标填具体工具，两处不能是同一字符串：
   * 相同时标题与目标完全一致，目标字段不提供任何信息。
   */
  test('对象名恒为「MCP」，具体工具由 target 表示', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const def = (await c.listTools())[0]!
    const spec = specFor(c, def)
    expect(spec.objectLabel).toBe('MCP')
    expect(spec.targetExtractor?.({})).toBe(permissionLabel(c.name, def.name))
    expect(spec.objectLabel).not.toBe(spec.targetExtractor?.({}))
    await c.stop()
  })

  test('不并行执行：外部进程的并发行为无法预知', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    expect(specFor(c, (await c.listTools())[0]!).parallelSafe).toBe(false)
    await c.stop()
  })
})

/** 工具调用的最小上下文：投递额度由 AgentLoop 按决策创建，此处直接创建一份。 */
function callCtx(
  signal = new AbortController().signal,
  room = Number.POSITIVE_INFINITY,
  sink: SinkPort | null = null,
): never {
  return {
    signal,
    sink,
    density: DEFAULT_DENSITY,
    contextWindow: 0,
    state: openBatchBudget(new Map(), room),
  } as never
}

describe('工具装配', () => {
  test('注册名带 server 前缀，两个 server 的同名工具不冲突', () => {
    expect(toolName('a', 'search')).toBe('mcp__a__search')
    expect(toolName('b', 'search')).toBe('mcp__b__search')
  })

  test('调用成功时结果写入 message', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const out = await spec.fn({ text: '嗨' }, callCtx())
    expect(out.status).toBe('success')
    expect(out.message).toContain('嗨')
    await c.stop()
  })

  test('isError 转为 failure 并保留正文，使模型能看到失败原因', async () => {
    const { dir, entry } = await fixture({ toolError: true })
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const out = await spec.fn({}, callCtx())
    expect(out.status).toBe('failure')
    expect(out.message).toBe('这个工具坏了')
    expect(out.errorKind).toBe('mcp_tool_error')
    await c.stop()
  })

  test('中断可立即结束等待', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const ac = new AbortController()
    ac.abort()
    const out = await spec.fn({ text: 'x' }, callCtx(ac.signal))
    expect(out.status).toBe('failure')
    expect(out.message).toContain('已取消')
    await c.stop()
  })

  /** 结果超出本轮剩余额度：正文完整存入正文库，只投递头部，尾部不丢失。 */
  test('超出剩余额度的结果存入正文库，回执附带地址与续读位置', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const landed: Uint8Array[] = []
    const sink: SinkPort = {
      land(input) {
        landed.push(input.body)
        return { resourceId: `rs_${landed.length}`, contentHash: 'sha:x' }
      },
      read: () => null,
      stat: () => null,
    }
    const text = `${'回显正文。'.repeat(20_000)}尾部标记`
    const out = await spec.fn({ text }, callCtx(undefined, 2000, sink))
    expect(out.status).toBe('success')
    expect(out.message.length).toBeLessThan(text.length)
    expect(out.message).toContain('read_resource')
    expect(new TextDecoder().decode(landed[0]!)).toContain('尾部标记')
    expect(String(out.resources?.[0]?.resourceId)).toBe('rs_1')
    await c.stop()
  })

  test('传输失败时 executed 取 true：无法判定副作用是否发生，按保守处理', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    await c.stop()
    const out = await spec.fn({ text: 'x' }, callCtx())
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(true)
  })
})

describe('内容块渲染', () => {
  const render = (content: unknown[]) =>
    renderContent({ content: content as never, isError: false })

  test('文本直接拼接', () => {
    expect(
      render([
        { type: 'text', text: '甲' },
        { type: 'text', text: '乙' },
      ]),
    ).toBe('甲\n乙')
  })

  test('图片只保留占位符：base64 进入上下文会占用数万 token', () => {
    const out = render([{ type: 'image', data: 'A'.repeat(40_000), mimeType: 'image/png' }])
    expect(out).toContain('image/png')
    expect(out.length).toBeLessThan(100)
  })

  test('未知块类型保留占位符而不是丢弃', () => {
    expect(render([{ type: '将来才有的类型' }])).toBe('[将来才有的类型]')
  })

  test('嵌入的 resource 取正文', () => {
    expect(render([{ type: 'resource', resource: { uri: 'f://a', text: '正文' } }])).toBe('正文')
  })
})

describe('配置解析', () => {
  test('同时接受 servers 与 mcpServers：用户通常从其他客户端复制配置', () => {
    const a = parseMcpConfig('{"servers":{"x":{"command":"echo"}}}')
    const b = parseMcpConfig('{"mcpServers":{"x":{"command":"echo"}}}')
    expect(Object.keys(a.servers)).toEqual(['x'])
    expect(Object.keys(b.servers)).toEqual(['x'])
  })

  test('url 使用 http 传输', () => {
    const c = parseMcpConfig('{"servers":{"remote":{"url":"https://x/mcp"}}}')
    expect(c.servers.remote).toEqual({ transport: 'http', url: 'https://x/mcp' })
    expect(c.error).toBeNull()
  })

  test('http server 的 headers 原样传递：远端通常需要鉴权', () => {
    const c = parseMcpConfig(
      '{"servers":{"r":{"url":"https://x/mcp","headers":{"authorization":"Bearer t"}}}}',
    )
    expect(c.servers.r).toMatchObject({ headers: { authorization: 'Bearer t' } })
  })

  /**
   * 同时配置 command 与 url 属于歧义，而不是二选一。
   * 静默选择时，用户修改了未被采用的字段，会面对一个没有任何变化的现象长时间排查。
   */
  test('command 与 url 同时提供时报告歧义，不代替用户选择', () => {
    const c = parseMcpConfig('{"servers":{"r":{"command":"echo","url":"https://x/mcp"}}}')
    expect(c.servers.r).toBeUndefined()
    expect(c.error).toContain('同时配置了')
  })

  test('非法 url 与非 http 协议均被拒绝并说明原因', () => {
    expect(parseMcpConfig('{"servers":{"r":{"url":"不是地址"}}}').error).toContain('合法地址')
    expect(parseMcpConfig('{"servers":{"r":{"url":"ws://x/mcp"}}}').error).toContain('http/https')
  })

  test('无效 JSON 报错，而不是视为未配置', () => {
    expect(parseMcpConfig('{ 坏的').error).toContain('解析失败')
  })

  test('enabled: false 的 server 不启动', async () => {
    const { dir, entry } = await fixture()
    const reg = await loadMcpServers(
      {
        servers: {
          on: { command: process.execPath, args: [entry] },
          off: { command: process.execPath, args: [entry], enabled: false },
        },
        error: null,
      },
      dir,
    )
    expect(reg.servers.map((s) => s.name)).toEqual(['on'])
    await reg.stopAll()
  })
})

describe('批量加载', () => {
  test('无法连接的 server 记入 failures，不影响其他 server', async () => {
    const { dir, entry } = await fixture()
    const reg = await loadMcpServers(
      {
        servers: {
          good: { command: process.execPath, args: [entry] },
          bad: { command: 'qywork-绝对不存在', args: [] },
        },
        error: null,
      },
      dir,
    )
    expect(reg.servers.map((s) => s.name)).toEqual(['good'])
    expect(reg.failures.map((f) => f.server)).toEqual(['bad'])
    expect(reg.toolSpecs.map((t) => t.name)).toEqual(['mcp__good__echo'])
    await reg.stopAll()
  }, 20_000)

  test('产出的是规格而不是注册结果：同一份扩展可为多个会话分别注册', async () => {
    const { dir, entry } = await fixture()
    const reg = await loadMcpServers(
      { servers: { fx: { command: process.execPath, args: [entry] } }, error: null },
      dir,
    )
    const r1 = new ToolRegistry()
    const r2 = new ToolRegistry()
    for (const s of reg.toolSpecs) {
      r1.register(s)
      r2.register(s)
    }
    expect(r1.has('mcp__fx__echo')).toBe(true)
    expect(r2.has('mcp__fx__echo')).toBe(true)
    await reg.stopAll()
  })
})
