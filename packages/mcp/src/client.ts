/**
 * MCP 客户端：JSON-RPC 2.0，传输可换（stdio / streamable HTTP）。
 *
 * 与插件宿主（`@qywork/plugins`）看起来很像，但**刻意不共用一份实现**：
 * 插件协议是我们自己定的、可以随时改；MCP 是外部规范，帧格式、握手、
 * 错误语义都得照它来。合并成一个「通用 RPC」的结果必然是
 * 某一次改动为了迁就自家协议而破坏了 MCP 的兼容性——那种 bug 只会在
 * 别人的 server 上出现，本地永远复现不了。
 *
 * ## 这个文件只管 JSON-RPC
 *
 * 消息怎么进出交给 `transport.ts`。两种传输在**握手、游标翻页、id 配对、
 * 错误语义**上一模一样，差别只在失败的种类（见那个文件的头注释）。
 *
 * ## 握手
 *
 * `initialize` → 收到结果 → 发 `notifications/initialized`。**中间那一步不能省**：
 * 有的 server 在收到 initialized 之前拒绝一切请求，表现是 `tools/list` 一直超时。
 *
 * HTTP 传输还要在这一步之间把**会话 id** 从响应头里取走（`Mcp-Session-Id`）。
 * 那个头只出现一次，错过了之后每条请求都会被当成新会话。
 */

import pkg from '../package.json' with { type: 'json' }
import type { McpResourceContents, McpResourceDef } from './resources.ts'
import {
  HttpTransport,
  isHttpSpec,
  type McpServerSpec,
  type McpTransport,
  StdioTransport,
} from './transport.ts'

/**
 * 本包版本。**真源是根 `VERSION`**，由 `bun run scripts/sync-version.ts` 灌进
 * 各包的 package.json；手写字面量不在那个脚本的覆盖范围里，升版本时会原地不动。
 */
const PKG_VERSION: string = pkg.version

export type { HttpServerSpec, McpServerSpec, StdioServerSpec } from './transport.ts'

/**
 * 我们声明的协议版本。
 *
 * MCP 的版本是日期串。server 回一个不同的版本时**只警告不断开**：
 * 规范建议客户端断开，但实际生态里版本参差，为一个次要版本差异让用户的
 * server 完全用不了，比容忍一次潜在的字段差异代价更大。真的不兼容会在
 * 具体某个请求上报错，那时的错误信息比「协议版本不匹配」有用得多。
 */
export const CLIENT_PROTOCOL_VERSION = '2026-07-28'

/**
 * 已知的修订，**新到旧**。顺序有用：握手被拒时按这个顺序逐档回退。
 */
export const KNOWN_VERSION_LIST = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const

const KNOWN_VERSIONS = new Set<string>(KNOWN_VERSION_LIST)

/**
 * 从这一版起，能力声明**不在 `initialize` 的结果里**，改由 `server/discover` 给。
 *
 * 这不是一条可以「以后再说」的版本差异：qywork 是否注册 resource 工具、
 * 是否报「声明了我们没接的能力」，全都读 `capabilities`。
 * 只读 initialize 的话，一个现代 server 上那个字段是空的，于是
 * **resource 工具一个都不注册、也不报任何错**——正是刚修掉的那个静默失败，
 * 换个版本原样复发。
 */
const DISCOVER_SINCE = '2026-07-28'

const REQUEST_TIMEOUT_MS = 60_000
const INIT_TIMEOUT_MS = 30_000

/**
 * server 声明的能力。**只列我们会去看的那几个**——
 * 把整个对象照抄成类型只会让「我们支持什么」变得看不出来。
 */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
  prompts?: { listChanged?: boolean }
  logging?: Record<string, unknown>
  completions?: Record<string, unknown>
  [k: string]: unknown
}

/** qywork 目前真正消费的能力。其余的声明了也只会被报成「未接」。 */
export const SUPPORTED_CAPABILITIES = ['tools', 'resources'] as const

/**
 * 这条握手错误是不是「版本不被接受」。
 *
 * 判据故意窄：命中就会**降版本重试**，而对一个鉴权失败或命令不存在的错误
 * 重试四次，只会把真正的原因埋在四行日志底下。宁可漏判——
 * 漏判的后果是照常抛出那条错误，用户仍然看得见它。
 */
function looksLikeVersionRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /protocol|version|unsupported|不支持|版本/i.test(msg)
}

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: McpToolAnnotations
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  [k: string]: unknown
}

export interface McpCallResult {
  content: McpContentBlock[]
  isError: boolean
  structuredContent?: unknown
}

export interface McpClientOptions {
  name: string
  spec: McpServerSpec
  /** 解析好的绝对工作目录。HTTP 传输用不到。 */
  cwd?: string
  onLog?: (line: string) => void
  /** 仅供测试注入假传输。 */
  transport?: McpTransport
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class McpClient {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private transport: McpTransport | null = null
  /** 传输层断开的原因。留着是为了让「server 未运行」这条错误说得出**为什么**。 */
  private closedReason: string | null = null

  serverInfo: { name?: string; version?: string } = {}
  protocolVersion = ''
  /**
   * server 在 `initialize` 里声明的能力。
   *
   * ## 为什么必须留着
   *
   * **不能只取 `protocolVersion` 和 `serverInfo`、把 `capabilities` 丢掉。**
   * 丢掉的后果是：一个只提供 `resources`（不提供 `tools`）的 server 表现为
   * 连接成功、握手成功、`tools/list` 返回空数组、注册 0 个工具、**没有任何错误**。
   * 用户看到的是「配了但什么都没发生」，而日志里干干净净。
   *
   * 我们目前只消费 `tools`。声明了而我们没接的能力（`resources` / `prompts`）
   * 必须在加载时**说出来**——那句话是用户唯一能拿到的线索。
   */
  capabilities: McpServerCapabilities = {}

  constructor(private readonly opts: McpClientOptions) {}

  get name(): string {
    return this.opts.name
  }

  /** 这个 server 走哪种传输。给日志和 UI 用——两种传输的排查方向完全不同。 */
  get transportKind(): 'stdio' | 'http' {
    return isHttpSpec(this.opts.spec) ? 'http' : 'stdio'
  }

  async start(): Promise<void> {
    if (this.transport) return

    const transport: McpTransport =
      this.opts.transport ??
      (isHttpSpec(this.opts.spec)
        ? new HttpTransport(this.opts.name, this.opts.spec)
        : new StdioTransport(this.opts.name, this.opts.spec, this.opts.cwd ?? process.cwd()))
    this.transport = transport

    await transport.start({
      onMessage: (msg) => this.dispatch(msg),
      onClose: (reason) => {
        this.closedReason = reason
        // 传输断了，在飞的请求**必须逐个拒掉**。留着它们会让调用方
        // 一直等到超时，而超时对用户表现为「卡住」。
        this.failAll(new Error(reason))
      },
      ...(this.opts.onLog ? { onLog: this.opts.onLog } : {}),
    })

    const result = await this.handshake()

    this.protocolVersion = result?.protocolVersion ?? ''
    this.serverInfo = result?.serverInfo ?? {}
    this.capabilities = result?.capabilities ?? {}
    if (this.protocolVersion && !KNOWN_VERSIONS.has(this.protocolVersion)) {
      this.opts.onLog?.(
        `[mcp:${this.opts.name}] server 声明的协议版本 ${this.protocolVersion} 不在已知列表里，继续尝试`,
      )
    }
    // HTTP 传输从这里开始要带协议版本头。放在 initialized 之前——
    // 那条通知本身就已经属于「握手之后」了。
    transport.afterInitialize?.(this.protocolVersion || CLIENT_PROTOCOL_VERSION)

    // 这一步不能省：有的 server 在收到它之前拒绝一切请求。
    await this.notify('notifications/initialized', {})

    await this.discoverCapabilities()
  }

  /**
   * `initialize`，握手被版本拒绝时**逐档回退**。
   *
   * 规范说 server 收到不认识的版本时应当回自己支持的那一版，而不是报错——
   * 但「应当」和「实际」是两回事，而一个因为我们抬高了版本号就完全连不上的
   * server，对用户表现为「昨天还好好的今天用不了了」。
   *
   * 回退只对**看起来像版本问题**的错误做，且只往旧了走。任何其他错误
   * （命令不存在、鉴权失败）原样抛——对它们重试只会把真正的原因埋掉。
   */
  private async handshake(): Promise<{
    protocolVersion?: string
    serverInfo?: { name?: string; version?: string }
    capabilities?: McpServerCapabilities
  }> {
    let lastErr: unknown = null
    for (const version of KNOWN_VERSION_LIST) {
      try {
        return (await this.request(
          'initialize',
          {
            protocolVersion: version,
            // 只声明我们真的实现了的。声明了没实现的能力，server 会据此发我们
            // 处理不了的请求——那比不声明糟得多。
            capabilities: {},
            clientInfo: { name: 'qywork', version: PKG_VERSION },
          },
          INIT_TIMEOUT_MS,
        )) as never
      } catch (err) {
        lastErr = err
        if (!looksLikeVersionRejection(err)) throw err
        this.opts.onLog?.(
          `[mcp:${this.opts.name}] server 不接受协议版本 ${version}，回退到更旧的一档重试`,
        )
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /**
   * 2026-07-28 起：能力声明由 `server/discover` 给，不再在 `initialize` 结果里。
   *
   * 三条都要照顾到，缺一条就会有一类 server 静默地少注册工具：
   *
   * 1. **只在协商结果 ≥ 2026-07-28 时才问。** 对旧 server 发这条只会拿到
   *    `Method not found`，白花一次往返。
   * 2. **失败不算错。** 有的 server 声明了新版本却没实现这个方法。
   *    这时 `initialize` 里那份（如果有）仍然算数。
   * 3. **是合并不是替换。** 两处都给了就取并集——少的那一方是「没说」，
   *    不是「没有」。直接覆盖会把一份真实的声明擦掉。
   */
  private async discoverCapabilities(): Promise<void> {
    const negotiated = this.protocolVersion || CLIENT_PROTOCOL_VERSION
    // 日期串按字典序比较即是按时间比较，这是 MCP 用日期做版本号的直接好处。
    if (negotiated < DISCOVER_SINCE) return

    try {
      const res = (await this.request('server/discover', {})) as {
        capabilities?: McpServerCapabilities
      }
      const found = res?.capabilities
      if (found && typeof found === 'object') {
        this.capabilities = { ...this.capabilities, ...found }
      }
    } catch (err) {
      // 声明了新版本却没实现 server/discover 是现实里一定会遇到的。
      // 记一行就够——真正的后果（工具没注册出来）由 load.ts 那条
      // 「握手成功但产出为零」的 failure 兜住。
      this.opts.onLog?.(
        `[mcp:${this.opts.name}] server 声明协议 ${negotiated} 但 server/discover 不可用` +
          `（${err instanceof Error ? err.message : String(err)}），沿用 initialize 里的能力声明`,
      )
    }
  }

  /** 拉全部工具。**必须跟完游标**——只取第一页会让后面的工具凭空消失。 */
  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = []
    let cursor: string | undefined
    // 上限只是防止 server 返回一个自指的游标把我们钉死在这儿。
    for (let page = 0; page < 100; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpToolDef[]
        nextCursor?: string
      }
      for (const t of res?.tools ?? []) {
        if (typeof t?.name === 'string' && t.name) out.push(t)
      }
      cursor = res?.nextCursor
      if (!cursor) break
    }
    return out
  }

  /**
   * 拉全部 resource。与 `listTools` 一样**必须跟完游标**。
   *
   * 调用方要先看 `capabilities.resources`：没声明就调，拿到的是
   * `Method not found`，而那条错误对用户没有任何信息量。
   */
  async listResources(): Promise<McpResourceDef[]> {
    const out: McpResourceDef[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const res = (await this.request('resources/list', cursor ? { cursor } : {})) as {
        resources?: McpResourceDef[]
        nextCursor?: string
      }
      for (const r of res?.resources ?? []) {
        if (typeof r?.uri === 'string' && r.uri) out.push(r)
      }
      cursor = res?.nextCursor
      if (!cursor) break
    }
    return out
  }

  async readResource(uri: string): Promise<McpResourceContents[]> {
    const res = (await this.request('resources/read', { uri })) as {
      contents?: McpResourceContents[]
    }
    return Array.isArray(res?.contents) ? res.contents : []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args })) as {
      content?: McpContentBlock[]
      isError?: boolean
      structuredContent?: unknown
    }
    return {
      content: Array.isArray(res?.content) ? res.content : [],
      // MCP 把「工具执行失败」放在结果里而不是 JSON-RPC error 里，
      // 就是为了让模型看得见失败详情并自己重试。原样传下去。
      isError: res?.isError === true,
      ...(res?.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
    }
  }

  stop(): void {
    const t = this.transport
    if (!t) return
    this.transport = null
    this.closedReason = this.closedReason ?? '已停止'
    t.stop()
  }

  // ───────────────────────── JSON-RPC ─────────────────────────

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const dead = this.transport?.deadReason() ?? (this.transport ? null : '未启动')
    if (dead !== null) {
      // 带上死因。只说「未运行」的话，用户看到的是一条无从下手的错误。
      const why = this.closedReason ?? dead
      return Promise.reject(new Error(`MCP server 未运行：${this.opts.name}（${why}）`))
    }

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时（${timeoutMs}ms）：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })

      // 发送失败要**立刻**拒掉这一条，不能等超时。
      // HTTP 下「发不出去」是常态（401、404、对面挂了），而那些错误信息
      // 恰恰是最有排查价值的——让它烂在一个 60 秒超时里等于把它扔了。
      void Promise.resolve(this.transport?.send({ jsonrpc: '2.0', id, method, params })).catch(
        (err: unknown) => {
          const p = this.pending.get(id)
          if (!p) return
          this.pending.delete(id)
          clearTimeout(p.timer)
          p.reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }

  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.transport?.send({ jsonrpc: '2.0', method, params })
    } catch (err) {
      // 通知发不出去不该让握手失败——它没有响应，失败了也无从确认。
      // 但要说出来：`initialized` 没送到的表现是后续请求全部超时。
      this.opts.onLog?.(
        `[mcp:${this.opts.name}] 通知 ${method} 发送失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    // server 发来的请求（sampling / roots / elicitation）——我们没声明这些能力，
    // 所以照规范回 method not found，而不是不吭声让对方等到超时。
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      void this.transport
        ?.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `qywork 未实现该方法：${msg.method}` },
        })
        .catch(() => {
          // 回一条「不支持」都失败了，说明连接已经没了。那件事会由 onClose 处理，
          // 这里再报一次只会刷屏。
        })
      return
    }
    // 通知（无 id）：目前只记日志。tools/list_changed 之类将来可以触发重扫。
    if (typeof msg.method === 'string') return

    const id = typeof msg.id === 'number' ? msg.id : Number(msg.id)
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    clearTimeout(p.timer)

    if (msg.error) {
      const e = msg.error as { code?: number; message?: string; data?: unknown }
      p.reject(new Error(`${e.message ?? 'MCP 错误'}（code ${e.code ?? '?'}）`))
      return
    }
    p.resolve(msg.result)
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
