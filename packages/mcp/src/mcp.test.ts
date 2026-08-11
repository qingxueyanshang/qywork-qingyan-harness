/**
 * MCP 端到端：起一个**真的** MCP server 子进程，走完整的 JSON-RPC 握手。
 *
 * 不 mock 传输层。要验的恰恰是「帧格式对不对、握手顺序对不对、游标跟没跟完」，
 * 把传输换成内存对象就把被验的东西替换掉了。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@qywork/agent'
import { McpClient } from './client.ts'
import { loadMcpServers, parseMcpConfig } from './load.ts'
import { permissionLabel, renderContent, specFor, toolName } from './register.ts'

/**
 * 一个最小但真实的 MCP server。
 *
 * `opts` 控制它的行为，用来构造各种边界：分页、慢响应、坏帧、拒绝握手。
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
  test('initialize 之后拿到 serverInfo 与协议版本', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    expect(c.serverInfo.name).toBe('fixture')
    expect(c.protocolVersion).toBe('2025-06-18')
    c.stop()
  })

  /**
   * `notifications/initialized` 不能省。这个 fixture 在收到它之前拒绝一切请求——
   * 真实 server 里这种行为很常见，省掉那一步的表现是 tools/list 一直报错。
   */
  test('发了 initialized 通知，后续请求才被接受', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo'])
    c.stop()
  })

  test('命令不存在时立刻失败，不干等到超时', async () => {
    const c = new McpClient({
      name: 'nope',
      spec: { command: 'qywork-绝对不存在的命令', args: [] },
      cwd: process.cwd(),
    })
    const started = Date.now()
    await expect(c.start()).rejects.toThrow()
    // 超时是 30 秒；能在几秒内返回就说明走的是 error 事件而不是超时。
    expect(Date.now() - started).toBeLessThan(10_000)
    c.stop()
  }, 20_000)

  test('stdout 上的 banner 不会把连接搞崩', async () => {
    const { dir, entry } = await fixture({ banner: true })
    const logs: string[] = []
    const c = client(entry, dir, logs)
    await c.start()
    expect(c.serverInfo.name).toBe('fixture')
    // 非协议行转成日志，不静默丢掉——丢掉的话 server 打的错误信息就没了。
    expect(logs.some((l) => l.includes('starting up'))).toBe(true)
    c.stop()
  })
})

describe('tools/list 分页', () => {
  test('跟完游标，两页的工具都在', async () => {
    const { dir, entry } = await fixture({ paginate: true })
    const c = client(entry, dir)
    await c.start()
    // 只取第一页的话 second_page 会凭空消失，而且没有任何报错。
    expect((await c.listTools()).map((t) => t.name)).toEqual(['echo', 'second_page'])
    c.stop()
  })
})

describe('tools/call', () => {
  test('参数原样送达，结果原样回来', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const r = await c.callTool('echo', { text: '你好' })
    expect(r.isError).toBe(false)
    expect(r.content[0]?.text).toContain('你好')
    c.stop()
  })

  test('isError 是工具失败，不是协议错误 —— 不能抛', async () => {
    const { dir, entry } = await fixture({ toolError: true })
    const c = client(entry, dir)
    await c.start()
    const r = await c.callTool('echo', {})
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toBe('这个工具坏了')
    c.stop()
  })

  test('JSON-RPC error 转成异常，且带上 server 给的原因', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    // 只说「调用失败」的话模型会原地重试同样的参数；带上原因它才可能改。
    const err = await c.callTool('no_such_tool', {}).then(
      () => null,
      (e: Error) => e.message,
    )
    expect(err).toContain('没有这个工具')
    expect(err).toContain('-32602')
    c.stop()
  })

  test('进程死掉时在飞的请求被逐个拒绝，不挂到超时', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const inFlight = c.callTool('echo', { text: 'x' })
    c.stop()
    await expect(inFlight).rejects.toThrow()
  })
})

describe('权限：server 的 hint 只能收紧，不能放宽', () => {
  test('默认 execute —— 每次调用都过闸', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    expect(spec.permissionEffect).toBe('execute')
    c.stop()
  })

  /**
   * 这条是整个 MCP 权限模型的核心。
   *
   * `readOnlyHint` 是 server 自己填的，而 server 是第三方代码。拿它决定
   * 「要不要弹授权」，等于让被审查者自己签发通行证。
   */
  test('readOnlyHint: true 也不降级 —— 被审查者不能自己签通行证', async () => {
    const { dir, entry } = await fixture({ annotations: { readOnlyHint: true } })
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    expect(spec.permissionEffect).toBe('execute')
    expect(spec.actionKind).not.toBe('read')
    c.stop()
  })

  test('destructiveHint: true 会收紧到 delete', async () => {
    const { dir, entry } = await fixture({ annotations: { destructiveHint: true } })
    const c = client(entry, dir)
    await c.start()
    expect(specFor(c, (await c.listTools())[0]!).actionKind).toBe('delete')
    c.stop()
  })

  test('scope 目标可按前缀 autoApprove', () => {
    expect(permissionLabel('github', 'create_issue')).toBe('mcp:github/create_issue')
    expect(permissionLabel('github', 'x').startsWith('mcp:github/')).toBe(true)
  })

  test('不并行 —— 外部进程的并发行为我们一无所知', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    expect(specFor(c, (await c.listTools())[0]!).parallelSafe).toBe(false)
    c.stop()
  })
})

describe('工具装配', () => {
  test('注册名带 server 前缀，两个 server 的同名工具不打架', () => {
    expect(toolName('a', 'search')).toBe('mcp__a__search')
    expect(toolName('b', 'search')).toBe('mcp__b__search')
  })

  test('调用成功时结果进 message', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const out = await spec.fn({ text: '嗨' }, { signal: new AbortController().signal } as never)
    expect(out.status).toBe('success')
    expect(out.message).toContain('嗨')
    c.stop()
  })

  test('isError 转成 failure 且保留正文 —— 模型要看得见为什么失败', async () => {
    const { dir, entry } = await fixture({ toolError: true })
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const out = await spec.fn({}, { signal: new AbortController().signal } as never)
    expect(out.status).toBe('failure')
    expect(out.message).toBe('这个工具坏了')
    expect(out.errorKind).toBe('mcp_tool_error')
    c.stop()
  })

  test('中断能立刻打断等待', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    const ac = new AbortController()
    ac.abort()
    const out = await spec.fn({ text: 'x' }, { signal: ac.signal } as never)
    expect(out.status).toBe('failure')
    expect(out.message).toContain('已取消')
    c.stop()
  })

  test('传输失败时 executed 取 true —— 副作用是否发生无法判定，只能保守', async () => {
    const { dir, entry } = await fixture()
    const c = client(entry, dir)
    await c.start()
    const spec = specFor(c, (await c.listTools())[0]!)
    c.stop()
    const out = await spec.fn({ text: 'x' }, { signal: new AbortController().signal } as never)
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

  test('图片只留占位 —— base64 进上下文能吃掉几万 token', () => {
    const out = render([{ type: 'image', data: 'A'.repeat(40_000), mimeType: 'image/png' }])
    expect(out).toContain('image/png')
    expect(out.length).toBeLessThan(100)
  })

  test('未知块类型留占位而不是丢掉', () => {
    expect(render([{ type: '将来才有的类型' }])).toBe('[将来才有的类型]')
  })

  test('嵌入的 resource 取正文', () => {
    expect(render([{ type: 'resource', resource: { uri: 'f://a', text: '正文' } }])).toBe('正文')
  })
})

describe('配置解析', () => {
  test('认 servers 也认 mcpServers —— 用户多半是从别处复制过来的', () => {
    const a = parseMcpConfig('{"servers":{"x":{"command":"echo"}}}')
    const b = parseMcpConfig('{"mcpServers":{"x":{"command":"echo"}}}')
    expect(Object.keys(a.servers)).toEqual(['x'])
    expect(Object.keys(b.servers)).toEqual(['x'])
  })

  test('url 走 http 传输', () => {
    const c = parseMcpConfig('{"servers":{"remote":{"url":"https://x/mcp"}}}')
    expect(c.servers.remote).toEqual({ transport: 'http', url: 'https://x/mcp' })
    expect(c.error).toBeNull()
  })

  test('http server 的 headers 带过去 —— 远端基本都要鉴权', () => {
    const c = parseMcpConfig(
      '{"servers":{"r":{"url":"https://x/mcp","headers":{"authorization":"Bearer t"}}}}',
    )
    expect(c.servers.r).toMatchObject({ headers: { authorization: 'Bearer t' } })
  })

  /**
   * 同时配 command 与 url 是**歧义**，不是「二选一」。
   * 静默挑一个的话，用户改了没被采用的那个字段，然后对着一个毫无变化的现象查半天。
   */
  test('command 与 url 同时给 → 报歧义，不替用户挑', () => {
    const c = parseMcpConfig('{"servers":{"r":{"command":"echo","url":"https://x/mcp"}}}')
    expect(c.servers.r).toBeUndefined()
    expect(c.error).toContain('同时配了')
  })

  test('非法 url 与非 http 协议都被挡下并说明原因', () => {
    expect(parseMcpConfig('{"servers":{"r":{"url":"不是地址"}}}').error).toContain('合法地址')
    expect(parseMcpConfig('{"servers":{"r":{"url":"ws://x/mcp"}}}').error).toContain('http/https')
  })

  test('坏 JSON 报错而不是当作没配', () => {
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
    reg.stopAll()
  })
})

describe('批量加载', () => {
  test('连不上的 server 记进 failures，不影响其他的', async () => {
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
    reg.stopAll()
  }, 20_000)

  test('产出的是规格不是注册 —— 同一份扩展能给多个会话各注册一遍', async () => {
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
    reg.stopAll()
  })
})
