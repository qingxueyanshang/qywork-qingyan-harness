/**
 * 客户端 → 服务端的指令协议，以及连接握手。
 *
 * 桌面 WebView 与手机浏览器发的是**同一批指令**，服务端不区分来源做业务分支；
 * 只有 `origin` 字段用于审计和「谁批准了权限」这类跨端提示。
 */

import type { ConversationId, RunId } from '../domain/ids.ts'
import type { Attachment, PermissionMode } from '../domain/model.ts'

// ─────────────────────────────── 握手 ───────────────────────────────

/**
 * 握手。
 *
 * **这里没有协议版本，而且是有意的。**
 *
 * 不要加一个手写的 `PROTOCOL_VERSION` 在握手时比对。它想挡「客户端和 sidecar 不是
 * 同一批出的」，而它挡不住：那个数只在有人**记得**手动 +1 时才生效，没有任何检查
 * 强制。真实发生过的漂移（旧 sidecar 少一条 HTTP 路由）没动线上格式，
 * 那个数一动不动、照样连上，症状伪装成前端的 `undefined.id`。
 * 一个只在有人记得时才生效的检查，比没有检查更坏——它看起来像保护。
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
   * 断线重连时报上客户端停在哪一条，服务端补发缺口；补不上就回 `resync`，
   * 客户端改走全量拉取。
   *
   * **位置和流身份必须一起给，这是一个字段而不是两个。** seq 是服务端进程里的
   * 一个计数器，重启就从头开始——只给一个数字，服务端没有任何办法判断它是不是
   * 自己这条流上的坐标。只给 `lastSeq` 的代价是：sidecar 一重启
   * （开发态热重载、崩溃拉起、桌面端重装），重连的客户端带着上一代的
   * `lastSeq=800` 撞上新服务的 `seq=0`，`800 >= 0` 被判成「已经是最新的」，
   * 因此补发零条、resync 为假。界面就此停在断线那一刻：那一轮**永远显示执行中**，
   * 而账本里它早在启动回收时就被判成中断了。
   */
  resume?: ResumePosition
  /** 只订阅这些会话的事件。省手机流量；不传=订阅全部。 */
  subscribe?: ConversationId[]
}

/** 客户端在某条事件流上停到的位置。`streamId` 来自 `HelloOkFrame`。 */
export interface ResumePosition {
  streamId: string
  lastSeq: number
}

export type ClientOrigin = 'desktop' | 'mobile' | 'cli' | 'external'

export interface HelloOkFrame {
  type: 'hello.ok'
  serverVersion: string
  sessionId: string
  /**
   * 这条事件流的身份，**一个服务进程一个**（`sessionId` 是一条连接一个，两回事）。
   * 客户端存下来，重连时随 `resume` 原样带回；换了值就说明服务端重启过，
   * 手上那个 seq 在新流里不再是有效坐标。
   */
  streamId: string
  /** 服务端当前 seq。客户端据此判断自己落后多少。 */
  currentSeq: number
  /** true = 缺口太大已放弃补发，客户端必须重新拉全量。 */
  resync: boolean
  /**
   * 此刻正在跑的会话。**进程级快照**，之后由 `conversation.busy` 事件维持。
   *
   * 必须在握手里给，而不是挂在某个 REST 列表上：缺口补不上（`resync`）时，
   * 客户端手里那份是断线前的——那一轮早跑完了，左栏那一行却会永远转下去。
   * 快照与增量走同一条连接，才不存在「谁先谁后」的窗口。
   */
  busyConversations: ConversationId[]
  capabilities: ServerCapabilities
}

export interface ServerCapabilities {
  // 别往这里加没人读的布尔（`pty` / `git` / `fileWatch` 那三个就是这么删掉的），
  // 理由各不相同但结论一样：**声明一个没有消费者的能力位等于没声明**。
  //
  // - `pty` 恒 false，而彼时没有终端功能，声明一个不存在能力的「不存在」
  //   等于什么都没说；
  // - `git` 恒 true，而 git 面板实际上是靠 `/api/git/status` 的返回判断的；
  // - `fileWatch` 恒 true，**而它是假的**——全仓一个文件监视器都没有。
  //
  // 终端功能已经做了，但**仍然不该回到这里**：PTY 在桌面外壳的 Rust 侧
  // （`apps/desktop/src-tauri/src/terminal.rs`），服务端不参与，
  // 前端按 `isDesktopShell()` 判有没有。握手是服务端对客户端的声明，
  // 拿它去报一件服务端不知情的事，报出来的必然是猜的。
  // 插件 / 外部 CLI / MCP 三份清单也不在这里，理由是**它们不是进程级的**：
  // 编排与 MCP 配在项目目录下（`.qy/team.json`、`.agents/mcp.json`），而一条连接
  // 横跨用户同时开着的所有项目。报在握手里等于「A 项目的编排显示在 B 项目上」，
  // 而且只有重连时才更新。各自的设置页按项目现取，不经这里。
  /**
   * shell 命令有没有内核级边界。
   *
   * **报后端名而不是布尔值。** 合并成 `sandboxed: true/false` 在插件侧出过同一个
   * 问题（ARCHITECTURE §24.1）：界面显示「开」，而不同后端、不同平台保住的
   * 边界不一样。`'none'` 时 `reason` 说得出为什么、下一步怎么办。
   *
   * 这条必须进握手：桌面端和手机端上，用户唯一能知道「命令跑在什么边界里」
   * 的地方就是界面——而 `qy config` 他们看不到。
   */
  sandbox: { backend: string; active: boolean; reason: string }
  /**
   * 这台机器上装没装齐 qywork 要用的外部程序。**每一条都对应一处真实的
   * `Bun.spawn`**，不是一张「环境检查」的装饰清单：
   * bash → `run_command`，git → 版本面板，rg → 搜索加速，node → 插件运行时。
   *
   * 报路径而不是布尔，与 `sandbox` 报后端名同一个理由：「有」不足以让用户知道
   * 用的是哪一个（Git Bash、Homebrew 的 bash、自己指的 MSYS），
   * 而那正是排查「同一条命令在终端能跑、在这里不行」时唯一有用的信息。
   *
   * 这一格和它的消费者（设置页「运行环境」那一节）是同一次加进来的——
   * 上面那三个被删掉的布尔就是死在「有生产者没有消费者」上。
   */
  environment: EnvDependency[]
  /**
   * 权限模式。**只有两种**：`auto` 由硬边界 + 静态规则 + 分类器裁决，
   * `full` 全放行（`full` 仍保留三条硬边界，见设置页那句说明）。
   *
   * 和 `sandbox` 放在一起、走同一条路进握手：它们回答的是同一个问题——
   * **这一轮跑在什么边界里**。这个答案的真源在服务端的 config.json，
   * 客户端只显示与请求修改，不自己存一份。
   */
  mode: PermissionMode
  // 思考强度**不在这里**。它是「接口 × 模型」那一格的属性，而握手是连接级、
  // 只报一次——报上来的那个值在用户切一次模型之后就不再成立。
  // 它随模型目录一起下发（`/api/models` 每行的 `effort`），与该模型的
  // `effortLevels` 同源，前端一处读。
}

/**
 * 一个外部程序依赖。
 *
 * **入表门槛：代码里真的有一处 `Bun.spawn` 调它。** 「装了更好」「同类工具都列了」
 * 不算——那种清单只会让用户面对一片与他无关的红点，而真正坏掉的那一条淹在里面。
 */
export interface EnvDependency {
  /** 稳定 id，安装路由按它查常量表。 */
  id: string
  /** 界面上的名字。 */
  label: string
  /** 找到的可执行文件路径；`null` = 没装。 */
  path: string | null
  /**
   * 缺了它会怎样。**必填**——一行「未安装」不告诉用户要不要管它。
   */
  impact: string
  /**
   * `true` = 缺了就有功能不能用（bash、git）；
   * `false` = 缺了只是降级或只在特定场景要（rg 有内置遍历顶上，node 只有装插件才用）。
   *
   * 分这一档是为了**不制造假警报**：把可选项也标成「需要安装」，用户第一次点开
   * 设置页看到的就是一片红，而其中大半不影响他用。
   */
  required: boolean
  /** 没装时的下一步（怎么装、或者环境变量怎么指）。装了时是空串。 */
  hint: string
  /**
   * 能不能一键装（Windows + 有 winget + 本仓收录了它的包 id）。
   *
   * `false` 时界面**不显示那个按钮**，而不是显示一个点了回 409 的按钮（B5）。
   * 判据与 `POST /api/host/install` 是同一张表，分开算必然漂移。
   */
  canInstall: boolean
}

export interface HelloErrFrame {
  type: 'hello.err'
  /**
   * 只有一种。**终态**——重连一万次带的还是同一个令牌。
   *
   * 不要加没有生产者的枚举值（`protocol_mismatch` 就是这么删掉的，见 HelloFrame）：
   * 客户端那边会为它长出一条永远不会命中的分支。
   */
  reason: 'bad_token'
  message: string
}

// ─────────────────────────────── 指令 ───────────────────────────────

export type ClientCommand =
  | SendMessageCommand
  | InterruptRunCommand
  | RetryRunCommand
  | SubscribeCommand
  | SetModelCommand
  | CompactCommand
  | GoalResumeCommand
  | GoalSetCommand

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

export interface SubscribeCommand {
  type: 'subscribe'
  conversationIds: ConversationId[]
}

export interface SetModelCommand {
  type: 'conversation.setModel'
  conversationId: ConversationId
  /** 接口名。切模型实质是「切接口 + 切模型」，两个一起发，不许只发一半。 */
  provider: string
  model: string
}

/** 用户显式触发上下文压缩。 */
export interface CompactCommand {
  type: 'conversation.compact'
  conversationId: ConversationId
}

/**
 * 用户在界面上点「继续」——把停下来的目标重新跑起来。
 *
 * **它必须自己发起一轮**，不能只把状态改回 `active` 等下一次别的 run 收尾时
 * 才动：那时候用户已经等了不知道多久，而界面上什么都没发生。
 * 服务端因此走的是与自动续起完全同一个排队入口（`run-control.ts`）。
 *
 * **没有对应的「暂停」指令。** 循环跑起来之后停它的动作就是中断这一轮
 * （`run.interrupt`），run 收尾时会把目标置回 `paused` 并解除续起标记——
 * 再开一条指令等于给同一件事开第二个入口。
 */
export interface GoalResumeCommand {
  type: 'goal.resume'
  conversationId: ConversationId
}

/**
 * 用户用 `/goal` 立一个目标，或改写现在这个。**这是立目标的唯一入口。**
 *
 * 模型手里没有 `create_goal`：它得在第二步就判「这活要不要跨轮」，而那个信息
 * 它在那一步拿不到。账本里留下过一次实证——模型开局立了个目标，同一个 run 里
 * 自己 complete 掉，自动续起一轮没起，用户全程只看见一条没动过的目标条。
 *
 * **立完当场起一轮**，和「继续」走同一个排队入口。
 *
 * 只有 `objective` 一个参数：这个循环没有轮数上限（见 `Goal` 的注释），
 * 出口是模型自检与用户点停止，所以没有第二个数要用户去填。
 */
export interface GoalSetCommand {
  type: 'goal.set'
  conversationId: ConversationId
  /** 要做到什么。空字符串由服务端拒绝，不静默忽略。 */
  objective: string
}

// ───────────────────────── 指令回执 ─────────────────────────

/**
 * 指令被拒绝的回执。**只发给发出该指令的那个客户端**，不进事件总线——
 * 别的客户端没发过这条指令，收到回执只会造成困惑。
 *
 * 为什么必须有：`handleCommand` 的 `default` 分支直接 `return` 的话，未知或未实现的
 * 指令会被静默吞掉。客户端发完永远等不到任何反馈，表现是「点了没反应」
 * ——而这和「服务端正在处理」在 UI 上无法区分。
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
   * 连接还没就绪，这条指令没发出去。
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
