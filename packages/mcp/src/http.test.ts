/**
 * streamable HTTP 传输的端到端测试。
 *
 * 使用真实的 HTTP server 而不是模拟 fetch：该传输的出错点都在协议层面。
 * 响应可能是 `application/json`，也可能是 `text/event-stream`；
 * 会话 id 位于响应头中且只出现一次；通知返回 202 且没有 body；
 * 失败有五六种含义完全不同的状态码。模拟 fetch 等于把这些全部替换为
 * 自行拟定的结构：夹具与实际不符时，实现与测试同时出错，测试却全部通过。
 *
 * 因此此处用 `Bun.serve` 启动一个按规范应答的 server，使客户端实际发送 HTTP 请求。
 *
 * 本测试验证的是客户端，不验证任何第三方 MCP server 的实现是否合规。真实 server 的兼容性
 * 只能通过实际接入来验证，该验证尚未进行。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { McpClient } from './client.ts'
import { loadMcpServers } from './load.ts'

const TOOLS = [
  {
    name: 'echo',
    description: '回显',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

type Mode = 'json' | 'sse'

interface ServerState {
  mode: Mode
  /** 强制下一次响应返回该状态码。 */
  forceStatus: number | null
  /** 收到的会话 id，按请求记录，用于断言客户端确实回传。 */
  seenSessionIds: (string | null)[]
  seenProtocolVersions: (string | null)[]
  /** 是否收到过 DELETE。 */
  deleted: boolean
  /** initialize 时是否下发会话 id。 */
  issueSession: boolean
  /** SSE 流写到一半即断开。 */
  truncateSse: boolean
  notifications: string[]
}

const state: ServerState = {
  mode: 'json',
  forceStatus: null,
  seenSessionIds: [],
  seenProtocolVersions: [],
  deleted: false,
  issueSession: true,
  truncateSse: false,
  notifications: [],
}

function reset(over: Partial<ServerState> = {}): void {
  Object.assign(state, {
    mode: 'json',
    forceStatus: null,
    seenSessionIds: [],
    seenProtocolVersions: [],
    deleted: false,
    issueSession: true,
    truncateSse: false,
    notifications: [],
    ...over,
  })
}

/** 夹具收到的 JSON-RPC 报文。只声明夹具实际读取的字段。 */
interface RpcMessage {
  id?: number | string | null
  method?: string
  params?: { arguments?: { text?: string } }
}

function resultFor(msg: RpcMessage): unknown {
  if (msg.method === 'initialize') {
    return {
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'fixture-http', version: '1.0' },
      capabilities: { tools: {} },
    }
  }
  if (msg.method === 'tools/list') return { tools: TOOLS }
  if (msg.method === 'tools/call') {
    return { content: [{ type: 'text', text: `回显：${msg.params?.arguments?.text ?? ''}` }] }
  }
  return {}
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method === 'DELETE') {
      state.deleted = true
      return new Response(null, { status: 204 })
    }

    state.seenSessionIds.push(req.headers.get('mcp-session-id'))
    state.seenProtocolVersions.push(req.headers.get('mcp-protocol-version'))

    if (state.forceStatus) {
      return new Response(JSON.stringify({ error: '强制失败' }), { status: state.forceStatus })
    }

    const msg = (await req.json()) as RpcMessage

    // 通知没有 id，按规范返回 202 且无 body。
    if (msg.id === undefined || msg.id === null) {
      state.notifications.push(String(msg.method))
      return new Response(null, { status: 202 })
    }

    const payload = { jsonrpc: '2.0', id: msg.id, result: resultFor(msg) }
    const headers: Record<string, string> = {}
    // 会话 id 只在 initialize 的响应头中出现一次。
    if (msg.method === 'initialize' && state.issueSession) {
      headers['mcp-session-id'] = 'sess-fixture-1'
    }

    if (state.mode === 'json') {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { ...headers, 'content-type': 'application/json' },
      })
    }

    // 截断的流：输出半条事件后正常关闭。
    // 这比 `controller.error()` 更接近实际情况：反向代理中断连接、server 崩溃时，
    // 客户端看到的往往只是流结束，`for await` 不抛出任何异常。
    // 这正是传输层无法区分静默结束与成功结束的情形。
    const body = state.truncateSse
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('event: message\ndata: {"jsonrpc"'))
            controller.close()
          },
        })
      : `event: message\ndata: ${JSON.stringify(payload)}\n\n`

    return new Response(body, {
      status: 200,
      headers: { ...headers, 'content-type': 'text/event-stream' },
    })
  },
})

const URL_ = `http://127.0.0.1:${server.port}/mcp`

afterAll(() => server.stop(true))

function client(over: Record<string, unknown> = {}) {
  return new McpClient({
    name: 'fx',
    spec: { transport: 'http', url: URL_, ...over } as never,
  })
}

describe('两种响应格式都能正确接收', () => {
  /**
   * 规范允许 server 对同一个 POST 返回单条 JSON 或一条 SSE 流。
   * 只实现一种时，更换 server 后所有请求都会超时，且错误信息
   * 是「请求超时」，完全无法指向真正的原因。
   */
  test('application/json：单条响应', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    expect(c.serverInfo.name).toBe('fixture-http')
    expect(await c.listTools()).toHaveLength(1)
    await c.stop()
  })

  test('text/event-stream：SSE 中的消息同样能正确配对', async () => {
    reset({ mode: 'sse' })
    const c = client()
    await c.start()
    expect(c.serverInfo.name).toBe('fixture-http')
    const r = await c.callTool('echo', { text: '喂' })
    expect(r.content[0]?.text).toBe('回显：喂')
    await c.stop()
  })
})

describe('会话 id', () => {
  /**
   * 会话 id 只在 initialize 的响应头中出现一次。丢失后每一条请求
   * 都会被视为新会话：部分 server 直接返回 400，部分静默返回一个空会话，
   * 后者更难发现：看似正常工作，实际每次都从头开始。
   */
  test('initialize 取得的 session id 随之后的每条请求发送', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    await c.listTools()
    await c.stop()
    // 第一条（initialize）不应携带，之后每一条都要携带。
    expect(state.seenSessionIds[0]).toBeNull()
    expect(state.seenSessionIds.slice(1).every((s) => s === 'sess-fixture-1')).toBe(true)
    expect(state.seenSessionIds.length).toBeGreaterThan(2)
  })

  test('server 不下发 session id 时仍可使用：该字段是可选的', async () => {
    reset({ mode: 'json', issueSession: false })
    const c = client()
    await c.start()
    expect(await c.listTools()).toHaveLength(1)
    await c.stop()
    expect(state.seenSessionIds.every((s) => s === null)).toBe(true)
  })

  test('握手之后携带协议版本头', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    await c.listTools()
    await c.stop()
    expect(state.seenProtocolVersions.at(-1)).toBe('2025-06-18')
  })

  /** 关闭时显式结束会话，不在对端遗留无人认领的会话。 */
  test('stop 发送 DELETE 结束会话', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    await c.stop()
    await Bun.sleep(60)
    expect(state.deleted).toBe(true)
  })
})

describe('通知', () => {
  /** `notifications/initialized` 不能省略：部分 server 在收到它之前拒绝所有请求。 */
  test('initialized 确实已发出，且 202 无 body 不视为错误', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    await c.stop()
    expect(state.notifications).toContain('notifications/initialized')
  })
})

describe('失败须区分「配置错误」与「服务端不可用」', () => {
  /**
   * 远端 server 不受本机控制，因此这一组是该传输最重要的测试。
   * 笼统的「连接失败」会让用户先排查网络，而真正的原因可能是 token 过期。
   */
  test('401 指向 headers 配置，不指向网络', async () => {
    reset({ forceStatus: 401 })
    await expect(client().start()).rejects.toThrow(/鉴权|headers/)
  })

  test('没有会话时的 404 表示地址配置错误', async () => {
    reset({ forceStatus: 404 })
    await expect(client().start()).rejects.toThrow(/url/)
  })

  /**
   * 携带会话 id 时收到 404 表示服务端丢失了会话（重启 / 过期 / 更换实例），
   * 而不是地址错误。两者的后续操作完全不同：前者重连，后者修改配置。
   */
  test('有会话时的 404 表示会话失效，提示重连而不是修改配置', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    state.forceStatus = 404
    await expect(c.listTools()).rejects.toThrow(/会话已失效|重新连接/)
    await c.stop()
  })

  test('5xx 明确指出是服务端的问题', async () => {
    reset({ forceStatus: 503 })
    await expect(client().start()).rejects.toThrow(/内部错误/)
  })

  test('地址无法连接时明确报告连接失败，而不是超时', async () => {
    const c = new McpClient({
      name: 'dead',
      spec: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } as never,
    })
    await expect(c.start()).rejects.toThrow(/连接被拒绝|域名解析|127\.0\.0\.1:1/)
  })

  /**
   * SSE 流中途断开时，在途请求必须立即被拒绝。
   * 否则调用方会一直等待至 60 秒超时，用户看到的是无响应：
   * 这是最难排查的一种失败，因为它看起来仍在执行。
   */
  test('SSE 流中途断开时立即拒绝在途请求，不等待超时', async () => {
    reset({ mode: 'sse', truncateSse: true })
    const c = client()
    const t0 = Date.now()
    await expect(c.start()).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
    await c.stop()
  })
})

describe('批量加载中的 http server', () => {
  test('http 与 stdio 混合配置时，http 的工具正常出现', async () => {
    reset({ mode: 'json' })
    const reg = await loadMcpServers(
      {
        servers: {
          remote: { transport: 'http', url: URL_ },
          nope: { command: 'qywork-绝对不存在', args: [] },
        },
        error: null,
      },
      process.cwd(),
    )
    expect(reg.toolSpecs.map((t) => t.name)).toEqual(['mcp__remote__echo'])
    expect(reg.failures.map((f) => f.server)).toEqual(['nope'])
    await reg.stopAll()
  }, 20_000)
})
