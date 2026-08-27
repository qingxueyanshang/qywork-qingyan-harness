/**
 * streamable HTTP 传输，端到端。
 *
 * **为什么起一个真的 HTTP server 而不是 mock fetch。** 这条传输里真正会出错的点全在**协议表面**上：
 * 响应可能是 `application/json` 也可能是 `text/event-stream`，
 * 会话 id 藏在响应头里而且只出现一次，通知回 202 且没有 body，
 * 失败有五六种含义完全不同的状态码。mock 掉 fetch 等于把这些全部替换成
 * 一份自拟的形状——Responses 适配器上出过同一个问题：fixture 与实际不符，
 * 实现和测试一起错，全绿。
 *
 * 所以这里 `Bun.serve` 一个按规范应答的 server，让客户端真的发 HTTP。
 *
 * **它验的是客户端。** 不验任何第三方 MCP server 的实现是否合规。真实 server 的兼容性
 * 只能靠实际接一个来验，那件事还没做。
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
  /** 强制下一次响应返回这个状态码。 */
  forceStatus: number | null
  /** 收到的会话 id，按请求记下来，用于断言客户端确实回传了。 */
  seenSessionIds: (string | null)[]
  seenProtocolVersions: (string | null)[]
  /** 是否收到过 DELETE。 */
  deleted: boolean
  /** initialize 时是否下发会话 id。 */
  issueSession: boolean
  /** SSE 流写到一半就断。 */
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

/** 夹具收到的 JSON-RPC 报文。只声明夹具真的看的那几格。 */
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

    // 通知没有 id，规范里回 202 且无 body。
    if (msg.id === undefined || msg.id === null) {
      state.notifications.push(String(msg.method))
      return new Response(null, { status: 202 })
    }

    const payload = { jsonrpc: '2.0', id: msg.id, result: resultFor(msg) }
    const headers: Record<string, string> = {}
    // 会话 id **只在 initialize 的响应头里出现一次**。
    if (msg.method === 'initialize' && state.issueSession) {
      headers['mcp-session-id'] = 'sess-fixture-1'
    }

    if (state.mode === 'json') {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { ...headers, 'content-type': 'application/json' },
      })
    }

    // 截断的流：吐半条事件然后**正常关闭**。
    // 这比 `controller.error()` 更贴近真实——反代掐连接、server 崩掉，
    // 客户端那边看到的往往就是「流结束了」，`for await` 一个异常都不抛。
    // 那正是「静默结束」与「成功结束」在传输层分不出来的那种情况。
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

describe('两种响应形态都要收得下', () => {
  /**
   * 规范允许 server 对同一个 POST 回单条 JSON **或**一条 SSE 流。
   * 只实现一种的后果是「换个 server 就全线超时」，而且错误信息
   * 会是「请求超时」——完全指不到真正的原因。
   */
  test('application/json：单条响应', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    expect(c.serverInfo.name).toBe('fixture-http')
    expect(await c.listTools()).toHaveLength(1)
    c.stop()
  })

  test('text/event-stream：SSE 里的消息同样配对得上', async () => {
    reset({ mode: 'sse' })
    const c = client()
    await c.start()
    expect(c.serverInfo.name).toBe('fixture-http')
    const r = await c.callTool('echo', { text: '喂' })
    expect(r.content[0]?.text).toBe('回显：喂')
    c.stop()
  })
})

describe('会话 id', () => {
  /**
   * 会话 id 只在 initialize 的响应头里出现一次。丢了它之后每一条请求
   * 都会被当成新会话——有的 server 直接 400，有的静默返回一个空会话，
   * 后者更糟：看起来在工作，实际每次都从头开始。
   */
  test('initialize 拿到的 session id，之后每条请求都带上', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    await c.listTools()
    c.stop()

    // 第一条（initialize）不该带，之后每一条都要带。
    expect(state.seenSessionIds[0]).toBeNull()
    expect(state.seenSessionIds.slice(1).every((s) => s === 'sess-fixture-1')).toBe(true)
    expect(state.seenSessionIds.length).toBeGreaterThan(2)
  })

  test('server 不下发 session id 时照样能用 —— 那是可选的', async () => {
    reset({ mode: 'json', issueSession: false })
    const c = client()
    await c.start()
    expect(await c.listTools()).toHaveLength(1)
    c.stop()
    expect(state.seenSessionIds.every((s) => s === null)).toBe(true)
  })

  test('握手之后带上协议版本头', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    await c.listTools()
    c.stop()
    expect(state.seenProtocolVersions.at(-1)).toBe('2025-06-18')
  })

  /** 关闭时显式结束会话，别在对端留下无人认领的会话。 */
  test('stop 发 DELETE 结束会话', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    c.stop()
    await Bun.sleep(60)
    expect(state.deleted).toBe(true)
  })
})

describe('通知', () => {
  /** `notifications/initialized` 不能省：有的 server 在它之前拒绝一切请求。 */
  test('initialized 真的发出去了，且 202 无 body 不当成错误', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    c.stop()
    expect(state.notifications).toContain('notifications/initialized')
  })
})

describe('失败要能区分「配错了」和「对面挂了」', () => {
  /**
   * 远端 server 不在本机掌控内，所以这一组是这条传输最重要的部分。
   * 一句笼统的「连接失败」会让用户先去查网络，而真正的原因可能是 token 过期。
   */
  test('401 指向 headers 配置，不指向网络', async () => {
    reset({ forceStatus: 401 })
    await expect(client().start()).rejects.toThrow(/鉴权|headers/)
  })

  test('没有会话时的 404 = 地址配错了', async () => {
    reset({ forceStatus: 404 })
    await expect(client().start()).rejects.toThrow(/url/)
  })

  /**
   * 带着会话 id 收到 404 = 服务端把会话丢了（重启 / 过期 / 换实例），
   * **不是**地址错。两者的下一步动作完全相反：一个重连，一个改配置。
   */
  test('有会话时的 404 = 会话失效，提示重连而不是改配置', async () => {
    reset({ mode: 'json' })
    const c = client()
    await c.start()
    state.forceStatus = 404
    await expect(c.listTools()).rejects.toThrow(/会话已失效|重新连接/)
    c.stop()
  })

  test('5xx 明说是对面的问题', async () => {
    reset({ forceStatus: 503 })
    await expect(client().start()).rejects.toThrow(/对面的问题|内部错误/)
  })

  test('地址根本连不上时说清是连不上，不是超时', async () => {
    const c = new McpClient({
      name: 'dead',
      spec: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } as never,
    })
    await expect(c.start()).rejects.toThrow(/连接被拒绝|域名解析|127\.0\.0\.1:1/)
  })

  /**
   * SSE 流中途断掉，在飞的请求**必须立刻被拒**。
   * 不拒的话调用方会一直等到 60 秒超时，而用户看到的是「卡住」——
   * 那是最难排查的一种失败，因为它看起来像仍在执行。
   */
  test('SSE 流中途断开时立刻拒绝在飞的请求，不等超时', async () => {
    reset({ mode: 'sse', truncateSse: true })
    const c = client()
    const t0 = Date.now()
    await expect(c.start()).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
    c.stop()
  })
})

describe('批量加载里的 http server', () => {
  test('http 与 stdio 混配时，http 的工具照常出现', async () => {
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
    reg.stopAll()
  }, 20_000)
})
