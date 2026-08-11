/**
 * MCP 的两种传输：本地子进程（stdio）与远端 HTTP（streamable HTTP）。
 *
 * ## 为什么要抽这一层
 *
 * JSON-RPC 那一层（握手、游标翻页、id 配对、错误语义）两种传输**完全一样**，
 * 不一样的只有「消息怎么进出」。不抽的话就是把整个 `McpClient` 复制一份，
 * 然后等着某一次改动只落在其中一份上——那种偏差只会在别人的 server 上暴露。
 *
 * ## 两者的根本差别：失败的种类不同
 *
 * stdio 的对面是我们自己起的进程，它挂了我们立刻知道，而且知道退出码和 stderr。
 * HTTP 的对面**不在本机掌控内**：它可能没部署、可能在重启、可能鉴权过期、
 * 也可能只是网断了一下。所以 HTTP 传输的主要工作不是「发消息」，
 * 是**把失败分清楚**——「你配错了」和「对面挂了」要给出完全不同的引导，
 * 混成一句「连接失败」等于让用户去猜。
 */

import { type ChildProcess, spawn } from 'node:child_process'

export interface StdioServerSpec {
  transport?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 工作目录，相对工作区。默认工作区根。 */
  cwd?: string
}

export interface HttpServerSpec {
  transport: 'http'
  url: string
  /** 鉴权头之类。远端 server 基本都需要。 */
  headers?: Record<string, string>
}

export type McpServerSpec = StdioServerSpec | HttpServerSpec

export function isHttpSpec(spec: McpServerSpec): spec is HttpServerSpec {
  return (spec as HttpServerSpec).transport === 'http'
}

export interface TransportHandlers {
  onMessage(msg: Record<string, unknown>): void
  /** 传输层永久性断开。带上人能读的原因——「未运行」本身没有任何排查价值。 */
  onClose(reason: string): void
  onLog?(line: string): void
}

export interface McpTransport {
  start(handlers: TransportHandlers): Promise<void>
  /** 发一条消息。HTTP 下这是一次真实请求，可能 reject。 */
  send(payload: Record<string, unknown>): Promise<void>
  stop(): void
  /** 已经断开时返回原因；还活着返回 null。 */
  deadReason(): string | null
  /** 握手完成后通知传输层。HTTP 之后每一条请求都要带上协议版本头。 */
  afterInitialize?(protocolVersion: string): void
}

// ───────────────────────── stdio ─────────────────────────

export class StdioTransport implements McpTransport {
  private proc: ChildProcess | null = null
  private buffer = ''
  private dead: string | null = null
  private handlers: TransportHandlers | null = null
  /**
   * 最近几行 stderr。
   *
   * Windows 上我们用 `shell: true` 起 server（npx / uvx 都是 .cmd），
   * 于是「命令不存在」**不会触发 error 事件**——cmd 自己起来了、打一行
   * 「不是内部或外部命令」到 stderr、退出码 1。只报 `code=1` 的话，
   * 用户看到的是一条完全无从下手的错误，而真正的原因就在那一行里。
   */
  private readonly stderrTail: string[] = []

  constructor(
    private readonly name: string,
    private readonly spec: StdioServerSpec,
    private readonly cwd: string,
  ) {}

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers
    const proc = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // **不透传宿主环境变量**，理由与插件进程完全相同：`process.env` 里有
      // 用户的 API Key。MCP server 需要自己的凭证时由用户在 mcp.json 里显式给，
      // 那样「这个 server 拿得到什么」是写在配置里、看得见的。
      env: {
        PATH: process.env.PATH ?? '',
        ...(process.platform === 'win32'
          ? {
              SYSTEMROOT: process.env.SYSTEMROOT ?? '',
              TEMP: process.env.TEMP ?? '',
              APPDATA: process.env.APPDATA ?? '',
            }
          : { HOME: process.env.HOME ?? '/nonexistent' }),
        ...(this.spec.env ?? {}),
      },
      // Windows 上 npx / uvx 这类是 .cmd，不走 shell 起不来。
      shell: process.platform === 'win32',
    })
    this.proc = proc

    // stdin 上必须挂 error 监听。进程刚起来就死掉时（命令不存在、启动即崩），
    // 我们那条 `initialize` 很可能已经写出去了，写向一个已经关掉的管道
    // 会抛 EPIPE——而没有监听者的 stream error 事件会**直接掀掉整个宿主进程**。
    // 一个装错的 MCP server 不该有能力做到这件事。
    // 真正的死因由 exit 处理器给出（带 stderr 尾巴），这里只需要不让它炸。
    proc.stdin?.on('error', (err: Error) => {
      handlers.onLog?.(`[mcp:${this.name}] 写入失败：${err.message}`)
    })

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.onStdout(String(chunk)))
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue
        handlers.onLog?.(`[mcp:${this.name}] ${line}`)
        this.stderrTail.push(line.trim())
        if (this.stderrTail.length > 5) this.stderrTail.shift()
      }
    })
    proc.on('error', (err) => {
      // 命令不存在时 spawn 走这里而不是 exit（仅非 shell 路径；Windows 上
      // 我们走 shell，那条路要靠 stderr，见 stderrTail 的注释）。
      this.dead = `启动失败：${err.message}`
      handlers.onClose(this.dead)
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      // 拒绝推迟一个宏任务再发：`exit` 有可能先于最后一批 stderr 送达，
      // 立刻拒绝的话拿到的是「code=1」这条毫无信息量的原因，而真正的
      // 「命令不存在」就在那批还没到的 stderr 里。一个 tick 换一条能用的错误信息。
      setTimeout(() => {
        const detail = this.stderrTail.length ? `：${this.stderrTail.join(' / ')}` : ''
        this.dead = `退出 code=${code} signal=${signal}${detail}`
        handlers.onClose(`MCP server ${this.dead}`)
        // 不 unref：这个定时器负责把在飞的请求拒掉，被 unref 掉的话
        // 进程正好在此时空闲就可能直接退出，留下永远不 settle 的 promise。
      }, 0)
    })
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    const stdin = this.proc?.stdin
    if (!stdin || stdin.destroyed) throw new Error(this.dead ?? 'MCP server 的 stdin 已关闭')
    // JSON.stringify 不缩进 = 单行，正好满足「消息体内不得有裸换行」。
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  stop(): void {
    const proc = this.proc
    if (!proc) return
    this.proc = null
    proc.kill()
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000)
    timer.unref?.()
  }

  deadReason(): string | null {
    return this.proc ? null : (this.dead ?? '进程未启动')
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) break
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      const msg = tryParse(line)
      if (msg) this.handlers?.onMessage(msg)
      // 有的 server 启动时往 stdout 打 banner。当协议错误处理会让整个连接白白失败。
      else this.handlers?.onLog?.(`[mcp:${this.name}] ${line}`)
    }
  }
}

// ───────────────────────── streamable HTTP ─────────────────────────

/**
 * 单次 HTTP 请求的超时。
 *
 * 比 stdio 短：本地进程慢是它在干活，远端不响应多半是它没了。
 * 不过 SSE 流一旦开始出数据就不再受这个限制——那是**建立连接**的超时，
 * 不是「整个调用」的超时，否则一个正常的长工具调用会被拦腰掐断。
 */
const HTTP_CONNECT_TIMEOUT_MS = 30_000

export class HttpTransport implements McpTransport {
  private sessionId: string | null = null
  private protocolVersion = ''
  private dead: string | null = null
  private handlers: TransportHandlers | null = null
  private stopped = false
  /** 在飞的 SSE 读取。stop() 时要一起掐掉，否则进程退不出去。 */
  private readonly inflight = new Set<AbortController>()

  constructor(
    private readonly name: string,
    private readonly spec: HttpServerSpec,
  ) {}

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers
    // **不在这里预先建连**。streamable HTTP 没有「连上」这个状态——
    // 第一次 POST（也就是 initialize）本身就是连通性测试。
    // 造一个假的连接步骤只会让失败提前到一个更难解释的地方。
  }

  afterInitialize(protocolVersion: string): void {
    this.protocolVersion = protocolVersion
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    if (this.stopped) throw new Error(this.dead ?? '传输已关闭')
    const isRequest = payload.id !== undefined && payload.id !== null

    const abort = new AbortController()
    this.inflight.add(abort)
    const timer = setTimeout(() => abort.abort(), HTTP_CONNECT_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(this.spec.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 两种都收：server 可以回单条 JSON，也可以回一条 SSE 流。
          // 只声明一种的话，另一种形态的 server 会直接 406。
          accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
          ...(this.spec.headers ?? {}),
        },
        body: JSON.stringify(payload),
        signal: abort.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      this.inflight.delete(abort)
      throw new Error(this.describeTransportFailure(err))
    }
    clearTimeout(timer)

    if (!res.ok) {
      this.inflight.delete(abort)
      throw new Error(this.describeHttpStatus(res.status, await safeText(res)))
    }

    // initialize 的响应头里带会话 id。这一步要在读 body 之前做——
    // 读 SSE 会一直读到流结束，那时候再去拿头就晚了（对调用方而言）。
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    const type = res.headers.get('content-type') ?? ''

    // 通知没有响应体，规范里是 202 Accepted。这里不区分 202 与空体，
    // 只要没内容就当发完了——有的实现回 200 + 空体。
    if (!isRequest || res.status === 202) {
      this.inflight.delete(abort)
      await res.body?.cancel().catch(() => {})
      return
    }

    if (type.includes('text/event-stream')) {
      // **不 await**：SSE 流会一直开着直到 server 关掉它，而这次 `send` 的语义
      // 是「消息发出去了」。await 的话，一个长流会把调用方钉在这儿，
      // 而调用方等的其实是那条 id 对应的响应——它会从 onMessage 送达。
      void this.pumpSse(res, abort, payload.id as string | number)
      return
    }

    this.inflight.delete(abort)
    const text = await safeText(res)
    const msg = tryParse(text)
    if (msg) {
      this.handlers?.onMessage(msg)
      return
    }
    // 200 但内容不是 JSON-RPC——多半撞上了登录页或反代的错误页。
    // 静默丢掉的话，调用方会一直等到超时。合成一条错误比让它挂着强。
    this.handlers?.onMessage({
      jsonrpc: '2.0',
      id: payload.id,
      error: {
        code: -32000,
        message: `响应不是 JSON-RPC（${this.spec.url}）：${text.slice(0, 200) || '空响应'}`,
      },
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.dead = '已停止'
    for (const a of this.inflight) a.abort()
    this.inflight.clear()

    // 显式结束会话。**不等它完成也不报错**：我们正在关，对面记不记得住
    // 已经不影响本地任何东西；为了一个清理动作把关闭流程搞成可能失败的，
    // 换来的是「退出时卡住」这种最让人恼火的行为。
    if (this.sessionId) {
      void fetch(this.spec.url, {
        method: 'DELETE',
        headers: {
          'mcp-session-id': this.sessionId,
          ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
          ...(this.spec.headers ?? {}),
        },
      }).catch(() => {})
    }
  }

  deadReason(): string | null {
    return this.stopped ? (this.dead ?? '已停止') : null
  }

  /**
   * 读一条 SSE 流，把里面的每个 JSON-RPC 消息交出去。
   *
   * ## 流「悄悄结束」必须当成失败
   *
   * 这条流是为 `requestId` 那次请求开的，正常情况下它至少要送回一条带那个 id
   * 的响应。可它也可能**什么都不送就结束**——server 崩了、反代掐了连接、
   * chunked 编码被截断。实测（fixture 里 `controller.error()`）表明这种情况下
   * `for await` **不一定抛异常**，它就是正常结束了。
   *
   * 于是「流结束了」和「流成功了」在传输层长得一模一样，而调用方还在等那条 id。
   * 后果是整整一个请求超时（握手时是 30 秒）的静默卡顿——
   * 这是最难排查的一种失败，因为它看起来像还在干活。
   *
   * 所以流结束时必须**回查那条 id 收到答复没有**，没有就自己合成一条错误响应
   * 交上去。合成的错误也比一个永不返回的 promise 强得多。
   */
  private async pumpSse(
    res: Response,
    abort: AbortController,
    requestId: string | number,
  ): Promise<void> {
    const body = res.body
    if (!body) {
      this.inflight.delete(abort)
      return
    }
    const decoder = new TextDecoder()
    let buffer = ''
    let answered = false
    let failure: string | null = null

    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true })
        for (;;) {
          const idx = buffer.indexOf('\n')
          if (idx < 0) break
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const msg = tryParse(line.slice(5).trim())
          if (!msg) continue
          if (msg.id !== undefined && msg.id !== null && String(msg.id) === String(requestId)) {
            answered = true
          }
          this.handlers?.onMessage(msg)
        }
      }
    } catch (err) {
      failure = this.describeTransportFailure(err)
    } finally {
      this.inflight.delete(abort)
    }

    if (answered || this.stopped) return
    this.handlers?.onMessage({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32000,
        message: failure
          ? `响应流中断：${failure}`
          : `响应流在给出结果前就结束了（${this.spec.url}）`,
      },
    })
  }

  /**
   * 把状态码翻译成「你该做什么」。
   *
   * 远端 server 不在本机掌控内，所以**分清「配错了」和「对面挂了」**
   * 是这个传输最重要的工作。一句「连接失败」会让用户先去查网络，
   * 而真正的原因可能是 token 过期。
   */
  private describeHttpStatus(status: number, body: string): string {
    // 带上 server 名：一份配置里常有好几个远端 server，
    // 一条不说是谁的错误信息，用户还得自己一个个试过去。
    const tail = `${body.trim() ? `：${body.slice(0, 200)}` : ''}（server「${this.name}」）`
    if (status === 401 || status === 403) {
      return `MCP server 拒绝鉴权（HTTP ${status}）：检查 mcp.json 里这个 server 的 headers${tail}`
    }
    if (status === 404) {
      // 带着会话 id 收到 404 = 会话被服务端丢了（重启、过期、换了实例），
      // 不是地址错。两者的下一步动作完全不同：一个是重连，一个是改配置。
      return this.sessionId
        ? `MCP 会话已失效（HTTP 404）：server 可能重启过，重新连接即可${tail}`
        : `MCP 端点不存在（HTTP 404）：检查 mcp.json 里的 url${tail}`
    }
    if (status === 406) {
      return `MCP server 不接受我们声明的响应类型（HTTP 406）${tail}`
    }
    if (status >= 500) {
      return `MCP server 内部错误（HTTP ${status}）：这是对面的问题，不是配置问题${tail}`
    }
    return `MCP server 返回 HTTP ${status}${tail}`
  }

  /** fetch 抛出来的东西没有状态码，只能从 code / 文案认。 */
  private describeTransportFailure(err: unknown): string {
    if (err instanceof Error && err.name === 'AbortError') {
      return this.stopped ? '已停止' : `连接超时（${HTTP_CONNECT_TIMEOUT_MS}ms）：${this.spec.url}`
    }
    const code = String((err as { code?: unknown })?.code ?? '')
    const message = err instanceof Error ? err.message : String(err)
    if (/ENOTFOUND|EAI_AGAIN/i.test(`${code} ${message}`)) {
      return `域名解析失败：${this.spec.url}`
    }
    if (/ECONNREFUSED/i.test(`${code} ${message}`)) {
      return `连接被拒绝，server 可能没在跑：${this.spec.url}`
    }
    if (/CERT|SSL|TLS/i.test(`${code} ${message}`)) {
      return `TLS 握手失败：${this.spec.url}（自签名证书需要另行信任）`
    }
    return `${message}（${this.spec.url}）`
  }
}

// ───────────────────────── 共用 ─────────────────────────

function tryParse(line: string): Record<string, unknown> | null {
  if (!line) return null
  try {
    const v = JSON.parse(line)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
