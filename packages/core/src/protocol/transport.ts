/**
 * 客户端 → 服务端的指令协议，以及连接握手。
 *
 * 桌面 WebView 与手机浏览器发的是**同一批指令**，服务端不区分来源做业务分支；
 * 只有 `origin` 字段用于审计和「谁批准了权限」这类跨端提示。
 */

import type { ConversationId, RunId } from '../domain/ids.ts'
import type { Attachment } from '../domain/model.ts'

// ─────────────────────────────── 握手 ───────────────────────────────

export interface HelloFrame {
  type: 'hello'
  /** 协议版本。服务端为真源，客户端只声明支持上限，不匹配直接拒连。 */
  protocolVersion: number
  /** 配对令牌。桌面端从 Tauri 环境拿；手机端从二维码带来。 */
  token: string
  origin: ClientOrigin
  /**
   * 断线重连时带上最后收到的 seq，服务端补发缺口。
   * 缺口超出服务端保留窗口时回 `resync`，客户端改走全量拉取。
   */
  lastSeq?: number
  /** 只订阅这些会话的事件。省手机流量；不传=订阅全部。 */
  subscribe?: ConversationId[]
}

export type ClientOrigin = 'desktop' | 'mobile' | 'cli' | 'external'

export interface HelloOkFrame {
  type: 'hello.ok'
  protocolVersion: number
  serverVersion: string
  sessionId: string
  /** 服务端当前 seq。客户端据此判断自己落后多少。 */
  currentSeq: number
  /** true = 缺口太大已放弃补发，客户端必须重新拉全量。 */
  resync: boolean
  capabilities: ServerCapabilities
}

export interface ServerCapabilities {
  /** 交互式终端。手机端连接时为 false —— PTY 在 Tauri 侧，网络那头够不着。 */
  pty: boolean
  git: boolean
  fileWatch: boolean
  /** 已装载的插件 id。 */
  plugins: string[]
  /** 可用的 agent team 后端。 */
  teamBackends: string[]
  /** 已连上的 MCP server 名。连不上的不在这里——报了等于骗客户端。 */
  mcpServers: string[]
  /**
   * shell 命令有没有内核级边界。
   *
   * **报后端名而不是布尔值。** 合并成 `sandboxed: true/false` 是插件那边踩过的坑
   * （ARCHITECTURE §24.1）：用户看到「开」就以为全都保住了，而不同后端、
   * 不同平台保住的东西不一样。`'none'` 时 `reason` 说得出为什么、下一步怎么办。
   *
   * 这条必须进握手：桌面端和手机端上，用户唯一能知道「我这条命令跑在什么边界里」
   * 的地方就是界面——而 `qy config` 他们看不到。
   */
  sandbox: { backend: string; active: boolean; reason: string }
}

export interface HelloErrFrame {
  type: 'hello.err'
  reason: 'bad_token' | 'protocol_mismatch' | 'too_many_clients' | 'not_paired'
  message: string
}

// ─────────────────────────────── 指令 ───────────────────────────────

export type ClientCommand =
  | SendMessageCommand
  | TeamRunCommand
  | InterruptRunCommand
  | RetryRunCommand
  | ResolvePermissionCommand
  | SubscribeCommand
  | SetModelCommand
  | CompactCommand

export interface SendMessageCommand {
  type: 'message.send'
  /** 幂等键。同一 (conversationId, clientRequestId) 重复发送不会起两个 run。 */
  clientRequestId: string
  conversationId: ConversationId
  content: string
  attachments?: Attachment[]
  /** 不传则用会话当前模型。 */
  model?: string
}

export interface InterruptRunCommand {
  type: 'run.interrupt'
  runId: RunId
}

export interface RetryRunCommand {
  type: 'run.retry'
  runId: RunId
  clientRequestId: string
}

export interface ResolvePermissionCommand {
  type: 'permission.resolve'
  requestId: string
  granted: boolean
  /** granted=true 时必填。 */
  scopeId?: string
}

export interface SubscribeCommand {
  type: 'subscribe'
  conversationIds: ConversationId[]
}

export interface SetModelCommand {
  type: 'conversation.setModel'
  conversationId: ConversationId
  model: string
}

/** 用户显式触发上下文压缩。 */
export interface CompactCommand {
  type: 'conversation.compact'
  conversationId: ConversationId
}

/**
 * 启动一轮 Agent Team 编排。
 *
 * 角色与编排图来自工作区的 `.qy/team.json`，指令只带目标——
 * 把整份配置塞进指令会让「界面上看到的编排」和「实际跑的编排」出现两个来源。
 */
export interface TeamRunCommand {
  type: 'team.run'
  conversationId: ConversationId
  /** 用户的原始诉求，替换编排图里的 `{goal}`。 */
  goal: string
  clientRequestId: string
}

// ───────────────────────── 指令回执 ─────────────────────────

/**
 * 指令被拒绝的回执。**只发给发出该指令的那个客户端**，不进事件总线——
 * 别的客户端没发过这条指令，收到回执只会造成困惑。
 *
 * 为什么必须有：曾经 `handleCommand` 的 `default` 分支直接 `return`，
 * 未知或未实现的指令被静默吞掉。客户端发完永远等不到任何反馈，
 * 表现是「点了没反应」——而这和「服务端正在处理」在 UI 上无法区分。
 * 这违反了本项目自己定的 fail-closed 原则：不确定就明确失败，不装作成功。
 */
export interface CommandRejectedFrame {
  type: 'command.rejected'
  /** 被拒的指令 type，原样回传。 */
  command: string
  reason: CommandRejectReason
  message: string
  /** 指令自带幂等键时回传，客户端据此定位是哪一次操作。 */
  clientRequestId?: string
}

export type CommandRejectReason =
  /** 协议里没有这个 type。客户端比服务端新，或是伪造流量。 */
  | 'unknown_command'
  /** 协议里有，但这个版本还没实现。客户端应当灰掉对应入口。 */
  | 'not_implemented'
  /** 参数不合法。 */
  | 'invalid_payload'
  /** 当前状态下不允许（如会话正忙）。 */
  | 'conflict'

// ─────────────────────────────── 配对 ───────────────────────────────

/**
 * 二维码里编码的内容。手机扫码后直接跳这个 URL，token 在 fragment 里
 * （fragment 不进服务端日志、不进 Referer）。
 */
export interface PairingPayload {
  /** 形如 http://192.168.1.20:7717 */
  url: string
  token: string
  /** 令牌有效期（epoch ms）。过期后必须重新扫码。 */
  expiresAt: number
  /** 桌面端主机名，手机上显示「已连接到 <name>」。 */
  deviceName: string
}

export function encodePairingUrl(p: PairingPayload): string {
  const frag = new URLSearchParams({
    t: p.token,
    e: String(p.expiresAt),
    n: p.deviceName,
  })
  return `${p.url}/m#${frag.toString()}`
}

export function decodePairingUrl(raw: string): PairingPayload | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
  const token = frag.get('t')
  const expiresAt = Number(frag.get('e'))
  if (!token || !Number.isFinite(expiresAt)) return null
  return {
    url: u.origin,
    token,
    expiresAt,
    deviceName: frag.get('n') ?? '',
  }
}

/** 当前协议版本。改动不向后兼容的字段时 +1。 */
export const PROTOCOL_VERSION = 1
