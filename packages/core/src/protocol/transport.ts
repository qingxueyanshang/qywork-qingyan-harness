/**
 * 客户端 → 服务端的指令协议，以及连接握手。
 *
 * 桌面 WebView 与手机浏览器发的是**同一批指令**，服务端不区分来源做业务分支；
 * 只有 `origin` 字段用于审计和「谁批准了权限」这类跨端提示。
 */

import type { ConversationId, RunId } from '../domain/ids.ts'
import type { Attachment, EffortLevel, PermissionMode } from '../domain/model.ts'

// ─────────────────────────────── 握手 ───────────────────────────────

/**
 * 握手。
 *
 * **这里没有协议版本，而且是有意的。**
 *
 * 曾经有一个手写的 `PROTOCOL_VERSION`，握手时两端比对、不匹配拒连。它想挡的是
 * 「客户端和 sidecar 不是同一批出的」——而它挡不住：那个数只在有人**记得**手动 +1
 * 时才生效，没有任何东西强制。真实发生过的漂移（旧 sidecar 少一条 HTTP 路由）
 * 根本没动线上格式，那个数一动不动，照样连上，症状伪装成前端的
 * `undefined.id`。一个只在有人记得时才生效的检查，比没有检查更坏——它看起来像保护。
 *
 * 漂移改成从源头消灭，不靠对数字：
 * - 开发：`bun run dev` 两端都从**同一棵源码树**跑，sidecar 走 `bun --watch`
 *   自动重载，前端走 vite HMR（`scripts/dev.ts`）；
 * - 打包：`tauri:build` 先 `build:agent` 再打包，前端产物与 sidecar 出自同一次构建；
 * - 手机：页面由那个 sidecar 自己托管，本来就是同一份。
 *
 * 要重新引入版本号，前提是出现一个**能独立升级、不跟着 sidecar 走的客户端**。
 * 那时候该比的也不是手写的数，是构建产出的标识——手写的那个已经证明不可靠。
 * （注意别和 MCP 的 `protocolVersion` 混淆：那个面对第三方进程，必须协商，留着。）
 */
export interface HelloFrame {
  type: 'hello'
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
  serverVersion: string
  sessionId: string
  /** 服务端当前 seq。客户端据此判断自己落后多少。 */
  currentSeq: number
  /** true = 缺口太大已放弃补发，客户端必须重新拉全量。 */
  resync: boolean
  capabilities: ServerCapabilities
}

export interface ServerCapabilities {
  // 这里曾经还有 `pty` / `git` / `fileWatch` 三个布尔。全部删掉，理由各不相同
  // 但结论一样：**没有任何客户端读它们**。
  //
  // - `pty` 恒 false，而全项目就没有终端功能，声明一个不存在能力的「不存在」
  //   等于什么都没说；
  // - `git` 恒 true，而 git 面板实际上是靠 `/api/git/status` 的返回判断的；
  // - `fileWatch` 恒 true，**而它是假的**——全仓一个文件监视器都没有。
  //
  // 以后真做了终端，连同它的消费者一起加回来。
  // 插件 / 编排后端 / MCP 三份清单也不在这里了，理由是**它们不是进程级的**：
  // 三者都配在项目目录下（`.qy/plugins`、`.qy/team.json`、`.qy/mcp.json`），
  // 而一条连接横跨用户同时开着的所有项目。报在握手里等于「A 项目的插件显示在
  // B 项目上」，而且只有重连时才更新。改由 `/api/capabilities?ws=` 回答。
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
  /**
   * 权限模式。**只有两种**：`auto` 由硬边界 + 静态规则 + 分类器裁决，
   * `full` 全放行（`full` 仍保留三条硬边界，见设置页那句说明）。
   *
   * 和 `sandbox` 放在一起、走同一条路进握手：它们回答的是同一个问题——
   * **这一轮跑在什么边界里**。这个答案的真源在服务端的 config.json，
   * 客户端只显示与请求修改，不自己存一份。
   */
  mode: PermissionMode
}

export interface HelloErrFrame {
  type: 'hello.err'
  /**
   * 只有一种。**终态**——重连一万次带的还是同一个令牌。
   *
   * 曾经还有一个 `protocol_mismatch`，随手写的协议版本号一起删了（见 HelloFrame）。
   * 留一个没有生产者的枚举值，会让客户端那边长出一条永远不会命中的分支。
   */
  reason: 'bad_token'
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
  | SetEffortCommand
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

/**
 * 切换会话思考强度。
 *
 * 和 `setModel` 分开，因为这是两个独立动作：换模型时不该顺手改思考强度，
 * 反过来也一样。合成一条指令会逼调用方每次都把另一个值也带上，
 * 而它带的那个值来自它自己的本地状态——那正是覆盖别人刚改的值的经典形状。
 */
export interface SetEffortCommand {
  type: 'conversation.setEffort'
  conversationId: ConversationId
  /** null = 回到跟随配置默认。 */
  effort: EffortLevel | null
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
  /**
   * 连接还没就绪，这条指令根本没发出去。
   *
   * **只由客户端自己产生**，服务端不会发——它是「连接不可用时静默丢弃指令」的替代品。
   * 那个 no-op 的表现是用户点了模型、界面一动不动，和「服务端还没回」无法区分。
   */
  | 'not_ready'

// ─────────────────────────────── 配对 ───────────────────────────────

/**
 * 二维码里编码的内容。手机扫码后直接跳这个 URL，token 在 fragment 里
 * （fragment 不进服务端日志、不进 Referer）。
 */
export interface PairingPayload {
  /** 形如 http://192.168.1.20:7717 */
  url: string
  token: string
  /** 桌面端主机名，手机上显示「已连接到 <name>」。 */
  deviceName: string
}

export function encodePairingUrl(p: PairingPayload): string {
  const frag = new URLSearchParams({
    t: p.token,
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
  if (!token) return null
  return {
    url: u.origin,
    token,
    deviceName: frag.get('n') ?? '',
  }
}
