/**
 * MCP 的两种传输：本地子进程（stdio）与远端 HTTP（streamable HTTP）。
 *
 * 传输层单独抽象：JSON-RPC 层（握手、游标翻页、id 配对、错误语义）在两种传输下完全相同，
 * 差异只在消息的收发方式。不抽象时需要复制整个 `McpClient`，此后的改动可能只进入
 * 其中一份，这种偏差只会在第三方 server 上暴露。
 *
 * 两种传输的根本差别在于失败类型。stdio 的对端是本进程启动的子进程，它退出时本地立即得知，
 * 且能取得退出码与 stderr。HTTP 的对端不受本机控制：可能未部署、正在重启、鉴权过期，
 * 或网络短暂中断。因此 HTTP 传输的主要职责是区分失败类型：「配置错误」与「对端不可用」
 * 需要给出不同的处理提示，合并为「连接失败」会使用户无法判断原因。
 */

import { type ChildProcess, spawn } from 'node:child_process'

export interface StdioServerSpec {
  transport?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 工作目录，相对于工作区。默认为工作区根目录。 */
  cwd?: string
}

export interface HttpServerSpec {
  transport: 'http'
  url: string
  /** 请求头，例如鉴权头。远端 server 通常需要。 */
  headers?: Record<string, string>
}

export type McpServerSpec = StdioServerSpec | HttpServerSpec

export function isHttpSpec(spec: McpServerSpec): spec is HttpServerSpec {
  return (spec as HttpServerSpec).transport === 'http'
}

export interface TransportHandlers {
  onMessage(msg: Record<string, unknown>): void
  /** 传输层永久断开。须附带可读的原因：仅有「未运行」无法用于排查。 */
  onClose(reason: string): void
  onLog?(line: string): void
}

export interface McpTransport {
  start(handlers: TransportHandlers): Promise<void>
  /** 发送一条消息。HTTP 传输下每次发送都是一次实际请求，可能 reject。 */
  send(payload: Record<string, unknown>): Promise<void>
  stop(): Promise<void>
  /** 已经断开时返回原因；连接正常时返回 null。 */
  deadReason(): string | null
  /** 握手完成后通知传输层。HTTP 传输此后的每个请求都须携带协议版本头。 */
  afterInitialize?(protocolVersion: string): void
}

// ───────────────────────── stdio ─────────────────────────

export class StdioTransport implements McpTransport {
  private proc: ChildProcess | null = null
  private stopping: Promise<void> | null = null
  private closed: Promise<void> = Promise.resolve()
  private buffer = ''
  private dead: string | null = null
  private handlers: TransportHandlers | null = null
  /**
   * 最近几行 stderr。
   *
   * Windows 上以 `shell: true` 启动 server（npx / uvx 均为 .cmd），
   * 因此「命令不存在」不会触发 error 事件：cmd 本身启动成功，向 stderr 输出一行
   * 「不是内部或外部命令」，以退出码 1 退出。只报告 `code=1` 时错误无法排查，
   * 实际原因在这一行 stderr 中。
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
      // 不透传宿主环境变量，理由与插件进程相同：`process.env` 中有
      // 用户的 API Key。MCP server 需要自身的凭证时由用户在 mcp.json 中显式配置，
      // 使该 server 能取得的凭证均列在配置中，可供查看。
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
      // Windows 上 npx / uvx 等命令是 .cmd 文件，不经 shell 无法启动。
      shell: process.platform === 'win32',
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    this.proc = proc
    this.closed = new Promise((done) => proc.once('close', () => done()))

    // stdin 必须注册 error 监听。进程启动后立即退出时（命令不存在、启动即崩溃），
    // `initialize` 通常已经写出，向已关闭的管道写入会抛出 EPIPE，
    // 而没有监听者的 stream error 事件会直接终止宿主进程。
    // 配置错误的 MCP server 不得导致宿主退出。
    // 实际的失败原因由 exit 处理器给出（附带 stderr 末尾几行），此处只需避免宿主崩溃。
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
      // 命令不存在时 spawn 触发 error 而不是 exit（仅限不经 shell 启动时；Windows 上
      // 经 shell 启动，需依据 stderr 判断，见 `stderrTail` 的注释）。
      this.dead = `启动失败：${err.message}`
      handlers.onClose(this.dead)
    })
    proc.on('exit', (code, signal) => {
      this.proc = null
      // 推迟一个宏任务再发出关闭通知：`exit` 可能先于最后一批 stderr 送达，
      // 立即通知时原因只有「code=1」，而「命令不存在」位于尚未送达的
      // stderr 中。延迟一个 tick 以取得可用的错误信息。
      setTimeout(() => {
        const detail = this.stderrTail.length ? `：${this.stderrTail.join(' / ')}` : ''
        this.dead = `退出 code=${code} signal=${signal}${detail}`
        handlers.onClose(`MCP server ${this.dead}`)
        // 不要 unref：该定时器负责拒绝进行中的请求；unref 后若进程恰好空闲，
        // 进程可能直接退出，留下永远不 settle 的 promise。
      }, 0)
    })
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    const stdin = this.proc?.stdin
    if (!stdin || stdin.destroyed) throw new Error(this.dead ?? 'MCP server 的 stdin 已关闭')
    // JSON.stringify 不缩进时输出单行，满足「消息体内不得含裸换行」的要求。
    stdin.write(`${JSON.stringify(payload)}\n`)
  }

  /** 等待受管进程树退出及管道关闭；重复关闭共享同一个完成结果。 */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const proc = this.proc
    this.dead = '已停止'
    this.stopping = (async () => {
      if (proc?.pid !== undefined) {
        if (process.platform === 'win32') {
          await new Promise<void>((done, fail) => {
            const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
              stdio: 'ignore',
              windowsHide: true,
              timeout: 5000,
            })
            killer.once('error', fail)
            killer.once('exit', (code) => {
              if (code !== 0 && proc.exitCode === null && proc.signalCode === null)
                fail(new Error(`MCP 进程树关闭失败：${this.name}，taskkill=${code}`))
              else done()
            })
          })
        } else {
          try {
            process.kill(-proc.pid, 'SIGTERM')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let force: ReturnType<typeof setTimeout> | undefined
      try {
        if (proc?.pid && process.platform !== 'win32') {
          const pid = proc.pid
          force = setTimeout(() => {
            try {
              process.kill(-pid, 'SIGKILL')
            } catch {}
          }, 2000)
        }
        await Promise.race([
          this.closed,
          new Promise<never>((_, fail) => {
            timer = setTimeout(
              () => fail(new Error(`MCP 关闭超时：${this.name}，进程资源可能仍被占用`)),
              5000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
        clearTimeout(force)
      }
      this.proc = null
    })()
    return this.stopping
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
      // 部分 server 启动时向 stdout 输出 banner。按协议错误处理会使整个连接失败。
      else this.handlers?.onLog?.(`[mcp:${this.name}] ${line}`)
    }
  }
}

// ───────────────────────── streamable HTTP ─────────────────────────

/**
 * 单次 HTTP 请求的超时。
 *
 * 比 stdio 短：本地进程响应慢通常是仍在执行，远端不响应通常是已不可用。
 * SSE 流开始返回数据后不再受此限制：这是建立连接的超时，
 * 不是整个调用的超时，否则正常的长时间工具调用会被中途切断。
 */
const HTTP_CONNECT_TIMEOUT_MS = 30_000

export class HttpTransport implements McpTransport {
  private sessionId: string | null = null
  private protocolVersion = ''
  private dead: string | null = null
  private handlers: TransportHandlers | null = null
  private stopped = false
  private closing: Promise<void> | null = null
  /** 进行中的 SSE 读取。stop() 时须一并中止，否则进程无法退出。 */
  private readonly inflight = new Map<AbortController, { settled: Promise<void>; finish(): void }>()

  constructor(
    private readonly name: string,
    private readonly spec: HttpServerSpec,
  ) {}

  async start(handlers: TransportHandlers): Promise<void> {
    this.handlers = handlers
    // 此处不预先建立连接。streamable HTTP 没有「已连接」状态，
    // 第一次 POST（即 initialize）本身就是连通性测试。
    // 额外的连接步骤只会使失败出现在更难解释的位置。
  }

  afterInitialize(protocolVersion: string): void {
    this.protocolVersion = protocolVersion
  }

  async send(payload: Record<string, unknown>): Promise<void> {
    if (this.stopped) throw new Error(this.dead ?? '传输已关闭')
    const isRequest = payload.id !== undefined && payload.id !== null

    const abort = new AbortController()
    let finish!: () => void
    const settled = new Promise<void>((done) => {
      finish = done
    })
    this.inflight.set(abort, { settled, finish })
    const timer = setTimeout(() => abort.abort(), HTTP_CONNECT_TIMEOUT_MS)

    let res: Response
    try {
      res = await fetch(this.spec.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 两种类型都接受：server 可以返回单条 JSON，也可以返回 SSE 流。
          // 只声明一种时，使用另一种形态的 server 直接返回 406。
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
      this.finishRequest(abort)
      throw new Error(this.describeTransportFailure(err))
    }
    clearTimeout(timer)

    if (!res.ok) {
      const text = await safeText(res)
      this.finishRequest(abort)
      throw new Error(this.describeHttpStatus(res.status, text))
    }

    // initialize 的响应头中携带会话 id，必须在读取 body 之前取出：
    // 读取 SSE 会持续到流结束，届时再读取响应头已晚于调用方的后续请求。
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid

    const type = res.headers.get('content-type') ?? ''

    // 通知没有响应体，规范规定返回 202 Accepted。此处不区分 202 与空响应体，
    // 没有内容即视为发送完成：部分实现返回 200 与空响应体。
    if (!isRequest || res.status === 202) {
      await res.body?.cancel().catch(() => {})
      this.finishRequest(abort)
      return
    }

    if (type.includes('text/event-stream')) {
      // 不要 await：SSE 流会保持打开直到 server 关闭它，而 `send` 的语义
      // 是「消息已发出」。await 时长时间的流会阻塞调用方，
      // 而调用方等待的是该 id 对应的响应，该响应经由 onMessage 送达。
      void this.pumpSse(res, abort, payload.id as string | number)
      return
    }

    const text = await safeText(res)
    this.finishRequest(abort)
    const msg = tryParse(text)
    if (msg) {
      this.handlers?.onMessage(msg)
      return
    }
    // 状态码为 200 但内容不是 JSON-RPC：通常是请求被转到登录页或反向代理的错误页。
    // 静默丢弃时调用方会一直等待到超时，因此合成一条错误响应返回。
    this.handlers?.onMessage({
      jsonrpc: '2.0',
      id: payload.id,
      error: {
        code: -32000,
        message: `响应不是 JSON-RPC（${this.spec.url}）：${text.slice(0, 200) || '空响应'}`,
      },
    })
  }

  stop(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    this.dead = '已停止'
    this.handlers?.onClose(this.dead)
    const pending = [...this.inflight.values()].map((request) => request.settled)
    for (const abort of this.inflight.keys()) abort.abort()
    this.closing = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          Promise.all(pending),
          new Promise<never>((_, fail) => {
            timer = setTimeout(
              () => fail(new Error(`MCP 等待进行中的请求结束超时：${this.name}`)),
              3000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      if (this.sessionId) {
        const response = await fetch(this.spec.url, {
          method: 'DELETE',
          headers: {
            'mcp-session-id': this.sessionId,
            ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
            ...(this.spec.headers ?? {}),
          },
          signal: AbortSignal.timeout(3000),
        })
        await response.body?.cancel()
        if (!response.ok && response.status !== 404 && response.status !== 405)
          throw new Error(`MCP 会话关闭失败：HTTP ${response.status}（${this.name}）`)
      }
    })()
    return this.closing
  }

  private finishRequest(abort: AbortController): void {
    this.inflight.get(abort)?.finish()
    this.inflight.delete(abort)
  }

  deadReason(): string | null {
    return this.stopped ? (this.dead ?? '已停止') : null
  }

  /**
   * 读取一条 SSE 流，将其中每条 JSON-RPC 消息交给 onMessage。
   *
   * 流未返回结果即结束时必须视为失败。该流为 `requestId` 对应的请求打开，正常情况下至少
   * 返回一条携带该 id 的响应。但它也可能不返回任何内容就结束：server 崩溃、反向代理断开
   * 连接、chunked 编码被截断。实测（fixture 中的 `controller.error()`）表明此时 `for await`
   * 不一定抛出异常，而是正常结束。
   *
   * 因此「流已结束」与「流已成功」在传输层无法区分，而调用方仍在等待该 id。
   * 结果是一个完整的请求超时周期（握手时为 30 秒）内没有任何提示，
   * 且看似仍在执行，是最难排查的一类失败。
   *
   * 因此流结束时必须检查该 id 是否已收到响应，未收到时合成一条错误响应
   * 交给 onMessage。
   */
  private async pumpSse(
    res: Response,
    abort: AbortController,
    requestId: string | number,
  ): Promise<void> {
    const body = res.body
    if (!body) {
      this.finishRequest(abort)
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
      this.finishRequest(abort)
    }

    if (answered || this.stopped) return
    this.handlers?.onMessage({
      jsonrpc: '2.0',
      id: requestId,
      error: {
        code: -32000,
        message: failure ? `响应流中断：${failure}` : `响应流在返回结果前结束（${this.spec.url}）`,
      },
    })
  }

  /**
   * 将状态码转换为对应的处理提示。
   *
   * 远端 server 不受本机控制，因此区分「配置错误」与「对端不可用」
   * 是该传输最主要的职责。笼统的「连接失败」会引导用户先排查网络，
   * 而实际原因可能是 token 过期。
   */
  private describeHttpStatus(status: number, body: string): string {
    // 附带 server 名称：一份配置中常有多个远端 server，
    // 不指明 server 的错误信息需要用户逐个排查。
    const tail = `${body.trim() ? `：${body.slice(0, 200)}` : ''}（server「${this.name}」）`
    if (status === 401 || status === 403) {
      return `MCP server 拒绝鉴权（HTTP ${status}）：检查 mcp.json 中该 server 的 headers${tail}`
    }
    if (status === 404) {
      // 携带会话 id 时收到 404 表示服务端已丢弃该会话（重启、过期或切换实例），
      // 不是地址错误。两者的处理方式不同：前者重新连接，后者修改配置。
      return this.sessionId
        ? `MCP 会话已失效（HTTP 404）：server 可能已重启，重新连接即可${tail}`
        : `MCP 端点不存在（HTTP 404）：检查 mcp.json 中的 url${tail}`
    }
    if (status === 406) {
      return `MCP server 不接受客户端声明的响应类型（HTTP 406）${tail}`
    }
    if (status >= 500) {
      return `MCP server 内部错误（HTTP ${status}）：故障位于 server 端，与配置无关${tail}`
    }
    return `MCP server 返回 HTTP ${status}${tail}`
  }

  /** fetch 抛出的错误没有状态码，只能依据 code 与错误信息识别。 */
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
      return `连接被拒绝，server 可能未运行：${this.spec.url}`
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
