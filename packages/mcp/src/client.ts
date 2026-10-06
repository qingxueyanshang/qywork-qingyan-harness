/**
 * MCP 客户端：JSON-RPC 2.0，传输可替换（stdio / streamable HTTP）。
 *
 * 与插件宿主（`@qywork/plugins`）结构相似，但有意不共用实现：
 * 插件协议由本仓库定义、可随时修改；MCP 是外部规范，帧格式、握手、
 * 错误语义都必须遵循规范。合并为通用 RPC 后，为适配本仓库协议所做的修改
 * 会破坏 MCP 的兼容性，且这类缺陷只在第三方 server 上出现，本地无法复现。
 *
 * 本文件只负责 JSON-RPC，消息的收发由 `transport.ts` 负责。两种传输在握手、游标翻页、
 * id 配对、错误语义上完全相同，差别只在失败的种类（见该文件的头注释）。
 *
 * 握手：`initialize` → 收到结果 → 发送 `notifications/initialized`。发送 initialized 这一步不能省略：
 * 部分 server 在收到 initialized 之前拒绝所有请求，表现为 `tools/list` 持续超时。
 *
 * HTTP 传输还需在握手期间从响应头中取得会话 id（`Mcp-Session-Id`）。
 * 该响应头只出现一次，错过后每条请求都会被视为新会话。
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
 * 本包版本。真源是根目录的 `VERSION`，由 `bun run scripts/sync-version.ts` 写入
 * 各包的 package.json；手写字面量不在该脚本的覆盖范围内，升级版本时不会被更新。
 */
const PKG_VERSION: string = pkg.version

export type { HttpServerSpec, McpServerSpec, StdioServerSpec } from './transport.ts'

/**
 * 客户端声明的协议版本。
 *
 * MCP 的版本是日期串。server 返回不同的版本时只警告、不断开：
 * 规范建议客户端断开，但实际生态中版本不一，因次要版本差异使用户的
 * server 完全无法使用，代价大于容忍一次潜在的字段差异。确实不兼容时会在
 * 具体请求上报错，此时的错误信息比「协议版本不匹配」更有用。
 */
export const CLIENT_PROTOCOL_VERSION = '2026-07-28'

/**
 * 已知的修订版本，按从新到旧排列。顺序有意义：握手被拒绝时按此顺序逐级回退。
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
 * 从该版本起，能力声明不在 `initialize` 的结果中，改由 `server/discover` 提供。
 *
 * 该差异不能推迟处理：qywork 是否注册 resource 工具、
 * 是否报告「已声明但未接入的能力」，都依据 `capabilities`。
 * 只读取 initialize 时，现代 server 上该字段为空，因此
 * 不会注册任何 resource 工具，也不报告任何错误，形成静默失败。
 */
const DISCOVER_SINCE = '2026-07-28'

const REQUEST_TIMEOUT_MS = 60_000
const INIT_TIMEOUT_MS = 30_000

/**
 * server 声明的能力。只列出客户端会读取的项：
 * 把整个对象完整复制为类型，会使客户端支持哪些能力无法辨认。
 */
export interface McpServerCapabilities {
  tools?: { listChanged?: boolean }
  resources?: { subscribe?: boolean; listChanged?: boolean }
  prompts?: { listChanged?: boolean }
  logging?: Record<string, unknown>
  completions?: Record<string, unknown>
  [k: string]: unknown
}

/** qywork 当前实际消费的能力。其余能力即使已声明，也只会被报告为未接入。 */
export const SUPPORTED_CAPABILITIES = ['tools', 'resources'] as const

/**
 * 判断该握手错误是否属于「版本不被接受」。
 *
 * 判据有意从严：命中即降低版本重试，而对鉴权失败或命令不存在的错误
 * 重试四次，只会把真正的原因掩盖在四行日志之下。宁可漏判：
 * 漏判的后果是照常抛出该错误，用户仍能看到它。
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
  /** 已解析的绝对工作目录。HTTP 传输不使用。 */
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
  private stopping: Promise<void> | null = null
  private transport: McpTransport | null = null
  /** 传输层断开的原因。保留该值，使「server 未运行」错误能够说明原因。 */
  private closedReason: string | null = null

  serverInfo: { name?: string; version?: string } = {}
  protocolVersion = ''
  /**
   * server 在 `initialize` 中声明的能力。
   *
   * 必须保留：不能只取 `protocolVersion` 与 `serverInfo` 而丢弃 `capabilities`。
   * 丢弃后，只提供 `resources`（不提供 `tools`）的 server 会表现为
   * 连接成功、握手成功、`tools/list` 返回空数组、注册 0 个工具，且没有任何错误。
   * 用户只看到已配置却没有任何效果，日志中也没有任何记录。
   *
   * 客户端目前消费 `tools` 与 `resources`。已声明但未接入的能力（如 `prompts`）
   * 必须在加载时明确报告：该提示是用户唯一能取得的线索。
   */
  capabilities: McpServerCapabilities = {}

  constructor(private readonly opts: McpClientOptions) {}

  get name(): string {
    return this.opts.name
  }

  /** 该 server 使用的传输种类，供日志与界面使用：两种传输的排查方向完全不同。 */
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
        // 传输断开后，必须逐个拒绝在途请求。保留它们会使调用方
        // 一直等待至超时，而超时在用户侧表现为无响应。
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
        `[mcp:${this.opts.name}] server 声明的协议版本 ${this.protocolVersion} 不在已知列表中，继续连接`,
      )
    }
    // HTTP 传输从此处开始需携带协议版本头。放在 initialized 之前：
    // 该通知本身已属于握手之后的消息。
    transport.afterInitialize?.(this.protocolVersion || CLIENT_PROTOCOL_VERSION)

    // 该步骤不能省略：部分 server 在收到该通知之前拒绝所有请求。
    await this.notify('notifications/initialized', {})

    await this.discoverCapabilities()
  }

  /**
   * 发送 `initialize`，握手因版本被拒绝时逐级回退。
   *
   * 规范要求 server 收到无法识别的版本时返回自身支持的版本，而不是报错；
   * 但实际实现未必遵循，客户端提高版本号后完全无法连接的 server，
   * 在用户看来表现为此前正常、升级后无法连接。
   *
   * 回退只针对看似版本问题的错误，且只向更旧的版本回退。其他错误
   * （命令不存在、鉴权失败）原样抛出：对它们重试只会掩盖真正的原因。
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
            // 只声明已实现的能力。声明未实现的能力时，server 会据此发来
            // 无法处理的请求，后果比不声明更严重。
            capabilities: {},
            clientInfo: { name: 'qywork', version: PKG_VERSION },
          },
          INIT_TIMEOUT_MS,
        )) as never
      } catch (err) {
        lastErr = err
        if (!looksLikeVersionRejection(err)) throw err
        this.opts.onLog?.(
          `[mcp:${this.opts.name}] server 不接受协议版本 ${version}，回退到更旧的版本重试`,
        )
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  /**
   * 自 2026-07-28 起，能力声明由 `server/discover` 提供，不再包含在 `initialize` 结果中。
   *
   * 以下三条都必须满足，缺少任何一条都会使某类 server 静默地少注册工具：
   *
   * 1. 只在协商结果 ≥ 2026-07-28 时查询。向旧 server 发送该请求只会得到
   *    `Method not found`，多一次无效的往返。
   * 2. 失败不视为错误。部分 server 声明了新版本却未实现该方法，
   *    此时 `initialize` 中的声明（若存在）仍然有效。
   * 3. 合并而不是替换。两处都给出时取并集：缺少的一方表示未声明，
   *    而不是不支持。直接覆盖会擦除一份真实的声明。
   */
  private async discoverCapabilities(): Promise<void> {
    const negotiated = this.protocolVersion || CLIENT_PROTOCOL_VERSION
    // MCP 以日期串作为版本号，按字典序比较即按时间比较。
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
      // 声明了新版本却未实现 server/discover 的 server 必然存在。
      // 记录一行日志即可：实际后果（工具未注册）由 load.ts 中
      // 「握手成功但产出为零」的 failure 处理。
      this.opts.onLog?.(
        `[mcp:${this.opts.name}] server 声明协议 ${negotiated} 但 server/discover 不可用` +
          `（${err instanceof Error ? err.message : String(err)}），沿用 initialize 中的能力声明`,
      )
    }
  }

  /** 获取全部工具。必须遍历完所有游标：只取第一页会使后续页的工具丢失。 */
  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = []
    let cursor: string | undefined
    // 上限只用于防止 server 返回指向自身的游标导致循环不结束。
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
   * 获取全部 resource。与 `listTools` 相同，必须遍历完所有游标。
   *
   * 调用方须先检查 `capabilities.resources`：未声明时调用，得到的是
   * `Method not found`，该错误对用户没有任何信息量。
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
      // MCP 把工具执行失败放在结果中而不是 JSON-RPC error 中，
      // 目的是让模型看到失败详情并自行重试。此处原样传递。
      isError: res?.isError === true,
      ...(res?.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    const transport = this.transport
    this.transport = null
    this.closedReason ??= '已停止'
    this.failAll(new Error(this.closedReason))
    this.stopping = transport?.stop() ?? Promise.resolve()
    return this.stopping
  }

  // ───────────────────────── JSON-RPC ─────────────────────────

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const dead = this.transport?.deadReason() ?? (this.transport ? null : '未启动')
    if (dead !== null) {
      // 附带失败原因。只说明「未运行」时，用户无从排查。
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

      // 发送失败时必须立即拒绝该请求，不能等待超时。
      // HTTP 下发送失败是常见情况（401、404、对端不可用），而这些错误信息
      // 最有排查价值，被 60 秒超时掩盖即等于丢失。
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
      // 通知发送失败不应导致握手失败：通知没有响应，失败后也无法确认。
      // 但需要记录：`initialized` 未送达时，后续请求会全部超时。
      this.opts.onLog?.(
        `[mcp:${this.opts.name}] 通知 ${method} 发送失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    // server 发来的请求（sampling / roots / elicitation）：客户端未声明这些能力，
    // 因此按规范返回 method not found，而不是不响应、使对方等待至超时。
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      void this.transport
        ?.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `qywork 未实现该方法：${msg.method}` },
        })
        .catch(() => {
          // 连「不支持」的响应都发送失败，说明连接已断开。该情况由 onClose 处理，
          // 此处再报告只会重复输出。
        })
      return
    }
    // 通知（无 id）：目前不处理；tools/list_changed 等通知可用于触发重新扫描。
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
