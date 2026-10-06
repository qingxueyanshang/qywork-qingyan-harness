/**
 * 客户端到服务端的指令协议，以及连接握手。
 *
 * 桌面 WebView 与手机浏览器发送同一组指令，服务端不按来源分支业务逻辑；
 * 只有 `origin` 字段用于审计以及「由哪一端批准了权限」等跨端提示。
 */

import type { ConversationId } from '../domain/ids.ts'
import type { Attachment, PermissionMode } from '../domain/model.ts'
import type { BrowserPresentation, BrowserUnavailableReason } from './native-browser.ts'
import type { DesktopGrant } from './native-desktop.ts'

// ─────────────────────────────── 握手 ───────────────────────────────

/**
 * 握手。
 *
 * 握手中不设协议版本。
 *
 * 不要添加手写的 `PROTOCOL_VERSION` 在握手时比对。它的目的是拒绝不属于同一次构建的
 * 客户端与 sidecar，但无法实现：该值只在有人记得手动加 1 时才生效，没有任何检查
 * 强制执行。缺少一条 HTTP 路由这类版本偏差不改变线上格式，该值保持不变、连接仍会建立，
 * 前端出现 `undefined.id`。只在有人记得时才生效的检查看似提供保护，危害大于没有检查。
 *
 * 版本偏差从源头消除，不依赖比对数字：
 * - 开发：`bun run dev` 两端都从同一棵源码树运行，且共用一个空闲时切换代际的门控；
 *   活动 run 执行完毕后才重启 sidecar，再以新的 `streamId` 触发前端整页刷新
 *   （`scripts/dev.ts`），不会出现新前端连接旧后端；
 * - 打包：`tauri:build` 先执行 `build:agent` 再打包，前端产物与 sidecar 出自同一次构建；
 * - 手机：页面由该 sidecar 自身托管，二者属于同一次构建。
 *
 * 重新引入版本号的前提是出现能独立升级、不随 sidecar 更新的客户端。
 * 届时比对的应是构建产出的标识，而不是手写的数字。
 * （不要与 MCP 的 `protocolVersion` 混淆：后者面向第三方进程，必须协商，应保留。）
 */
export interface HelloFrame {
  type: 'hello'
  /** 配对令牌。桌面端从 Tauri 环境取得；手机端从二维码取得。 */
  token: string
  origin: ClientOrigin
  /**
   * 断线重连时报告客户端停留的位置，服务端补发缺口；无法补发时返回 `resync`，
   * 客户端改为全量获取。
   *
   * 位置与流身份必须一同给出，作为一个字段而不是两个。seq 是服务端进程中的
   * 计数器，重启后从头开始：只给一个数字时，服务端无法判断它是否是本条流上的位置。
   * 只给 `lastSeq` 的后果是：sidecar 重启后（开发环境热重载、崩溃后重新启动、桌面端重装），
   * 重连的客户端携带上一代的 `lastSeq=800` 遇到新服务的 `seq=0`，`800 >= 0` 被判定为
   * 已是最新，因此补发零条、resync 为假。界面停留在断线时的状态：该轮始终显示执行中，
   * 而账本中它早已在启动回收时被判定为中断。
   */
  resume?: ResumePosition
  /** 只订阅这些会话的事件，以节省手机流量；不传时订阅全部。 */
  subscribe?: ConversationId[]
}

/** 客户端在某条事件流上停留的位置。`streamId` 来自 `HelloOkFrame`。 */
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
   * 事件流的身份，每个服务进程一个（`sessionId` 是每个连接一个，二者不同）。
   * 客户端保存该值，重连时随 `resume` 原样带回；值变化说明服务端已重启，
   * 客户端持有的 seq 在新流中不再是有效位置。
   */
  streamId: string
  /** 服务端当前 seq。客户端据此判断自身落后多少。 */
  currentSeq: number
  /** true 表示缺口过大、已放弃补发，客户端必须重新获取全量数据。 */
  resync: boolean
  /**
   * 当前正在运行的会话。进程级快照，之后由 `conversation.busy` 事件维护。
   *
   * 必须在握手中给出，而不是放在某个 REST 列表上：缺口无法补发（`resync`）时，
   * 客户端持有的是断线前的数据，该轮早已执行完毕，左栏中该会话却会一直显示运行中。
   * 快照与增量经由同一个连接，才不存在先后顺序不确定的窗口。
   */
  busyConversations: ConversationId[]
  capabilities: ServerCapabilities
}

export interface ServerCapabilities {
  // 不要在此添加无人读取的布尔值：声明一个没有消费者的能力位等于没有声明。
  // `git` 与 `fileWatch` 均不应加入：git 面板依据 `/api/git/status` 的返回判断，
  // 全仓也没有文件监视器。
  //
  // 终端能力（`pty`）同样不在此声明：PTY 在桌面外壳的 Rust 侧
  // （`apps/desktop/src-tauri/src/terminal.rs`），服务端不参与，
  // 前端通过 `isDesktopShell()` 判定是否为桌面外壳。握手是服务端对客户端的声明，
  // 用它报告服务端不知情的事项，报告内容必然出自推测。
  // 插件 / 外部 CLI / MCP 三份清单也不在此处，因为它们不是进程级的：
  // 编排与 MCP 配置在项目目录下（`.qy/team.json`、`.agents/mcp.json`），而一个连接
  // 横跨用户同时打开的所有项目。在握手中报告会使 A 项目的编排显示在 B 项目上，
  // 且只在重连时更新。各自的设置页按项目实时读取，不经由此处。
  /**
   * shell 命令是否具备内核级边界。
   *
   * 报告后端名而不是布尔值。合并为 `sandboxed: true/false` 会出现与插件侧相同的问题
   * （ARCHITECTURE §24.1）：界面显示「开」，而不同后端、不同平台提供的边界不同。
   * `'none'` 时 `reason` 说明原因与下一步操作。
   *
   * 该字段必须进入握手：在桌面端与手机端上，界面是用户了解命令运行边界的唯一途径，
   * 用户无法查看 `qy config`。
   */
  sandbox: { backend: string; active: boolean; reason: string }
  /**
   * 本机是否已安装 qywork 所需的外部程序。每一条都对应一处实际的 `Bun.spawn`，
   * 而不是装饰性的环境检查清单：
   * bash → `run_command`，git → 版本面板，rg → 搜索加速，node → 插件运行时。
   *
   * 报告路径而不是布尔值，理由与 `sandbox` 报告后端名相同：「已安装」不足以让用户知道
   * 使用的是哪一个（Git Bash、Homebrew 的 bash、用户指定的 MSYS），
   * 而这正是排查「同一条命令在终端中能运行、在此处不能运行」时唯一有用的信息。
   *
   * 该字段与其消费者（设置页「运行环境」一节）必须同时存在，只有生产者没有消费者的字段不应加入。
   */
  environment: EnvDependency[]
  /**
   * 权限模式，只有两种：`auto` 由路径边界与 `run_command` 的拒绝规则裁决，
   * `full` 全部放行，路径边界一并放开，只保留凭证剥离（`scrubEnv`）。
   *
   * 与 `sandbox` 放在一起、经由同一路径进入握手：二者回答的是同一个问题，
   * 即本轮在什么边界内运行。该答案的真源是服务端的 config.json，
   * 客户端只显示与请求修改，不自行保存一份。
   */
  mode: PermissionMode
  /**
   * 内置浏览器。两项状态分开报告，不合并为一个布尔值。
   *
   * 合并后，「运行时版本不达标」会被理解为「浏览器不可用」，而此时手动浏览仍然可用。
   *
   * 与 PTY 不同，服务端知道该状态：原生宿主连接到服务端，版本由宿主上报。
   * 宿主连接变化时由 `browser.state` 事件更新同一份投影。
   */
  browser: BrowserCapability
  /**
   * 电脑控制。三项状态分开报告，不合并为一个布尔值。
   *
   * 三者是依次成立的阶段，合并后界面只能显示「不可用」，无法说明阻塞于哪一步，
   * 而三步的后续操作完全不同：安装应用、等待组件启动、授权。授权状态由 worker 报告，
   * 因此组件未启动时没有该项。
   *
   * 与浏览器相同，服务端知道该状态：原生宿主连接到服务端，worker 与授权状态由宿主上报。
   * 宿主连接变化时由 `desktop.state` 事件更新同一份投影。
   */
  desktop: DesktopCapability
  // 思考强度不在此处。它是「接口 × 模型」组合的属性，而握手是连接级的，
  // 只报告一次：用户切换模型后，报告的值即不再成立。
  // 它随模型目录一并下发（`/api/models` 每行的 `effort`），与该模型的
  // `effortLevels` 同源，前端只从一处读取。
}

/**
 * 内置浏览器当前的可用程度。
 *
 * `connected` 单独成立即可手动浏览；AI 控制要求两项同时成立。
 */
export interface BrowserCapability {
  /** 原生浏览器宿主已连接服务端且有可用的浏览器。这是手动浏览的唯一判据。 */
  connected: boolean
  /** 宿主上报的浏览器运行时版本达到 AI 控制的下限。`connected` 为假时为 `false`。 */
  runtimeSupported: boolean
  /** 宿主已连接但没有可用浏览器的原因；此时 `connected` 为假。宿主未连接或浏览器可用时缺席。 */
  unavailable?: BrowserUnavailableReason
  /** 宿主报告的页面显示位置，仅 `connected` 为真时存在。界面据此决定面板中显示嵌入的页面还是窗口入口。 */
  presentation?: BrowserPresentation
}

/**
 * 电脑控制当前的可用程度。三项依次成立，注册工具要求三项同时为真。
 *
 * 用户在设置中的启用开关不在此处：它属于配置（`config.json` 的 `desktopEnabled`），
 * 由设置页按项读写；握手报告的是本机当前的客观状态。两者合并为一个值后，
 * 界面无法区分「已关闭」与「组件未启动」。
 */
export interface DesktopCapability {
  /** 桌面宿主已连接服务端。 */
  connected: boolean
  /** 宿主上报 worker 进程已握手就绪。宿主未连接时为 `false`。 */
  workerReady: boolean
  /** 操作系统已授予读取与动作所需的权限。worker 未就绪时为 `false`：此时不存在该项状态。 */
  authorized: boolean
  /** 操作系统未满足的前提，界面据此指明需要开启的位置。worker 未就绪时为空。 */
  missing: DesktopGrant[]
}

/**
 * 一个外部程序依赖。
 *
 * 加入该表的条件：代码中确有一处 `Bun.spawn` 调用它。「安装后更好」「同类工具都列出了」
 * 不构成理由：这类清单会让用户面对大量与其无关的红色标记，真正出错的条目被掩盖。
 */
export interface EnvDependency {
  /** 稳定 id，安装路由据此查询常量表。 */
  id: string
  /** 界面上显示的名称。 */
  label: string
  /** 找到的可执行文件路径；`null` 表示未安装。 */
  path: string | null
  /**
   * `true` 表示缺少时有功能无法使用（bash、git）；
   * `false` 表示缺少时只是降级或只在特定场景需要（rg 有内置遍历作为后备，node 只在安装插件时使用）。
   *
   * 区分这两档是为了避免误报：若可选项也标为「需要安装」，用户首次打开
   * 设置页时会看到大量红色标记，而其中多数不影响使用。
   */
  required: boolean
  /**
   * 未安装时缺少该程序的影响，按本机当前状态写成一句。未安装时必填：仅显示「未安装」无法告诉用户是否需要处理。
   * 已安装时为空串。
   */
  hint: string
  /**
   * 能否一键安装（Windows、已有 winget、且本仓库收录了它的包 id）。
   *
   * `false` 时界面不显示安装按钮，而不是显示一个点击后返回 409 的按钮（B5）。
   * 判据与 `POST /api/host/install` 使用同一张表，分开计算必然漂移。
   */
  canInstall: boolean
}

export interface HelloErrFrame {
  type: 'hello.err'
  /**
   * 只有一种取值，且为终态：重连多少次携带的仍是同一个令牌。
   *
   * 不要添加没有生产者的枚举值（如 `protocol_mismatch`，理由见 HelloFrame）：
   * 客户端会为它增加一条永远不会命中的分支。
   */
  reason: 'bad_token'
  message: string
}

// ─────────────────────────────── 指令 ───────────────────────────────

export type ClientCommand =
  | SendMessageCommand
  | InterruptConversationCommand
  | SubscribeCommand
  | SetModelCommand
  | CompactCommand
  | GoalResumeCommand
  | GoalSetCommand
  | FollowUpSteerCommand
  | FollowUpDropCommand

export interface SendMessageCommand {
  type: 'message.send'
  /** 幂等键。同一 (conversationId, clientRequestId) 重复发送不会启动两个 run。 */
  clientRequestId: string
  conversationId: ConversationId
  content: string
  attachments?: Attachment[]
  /** 不传时使用会话当前模型。 */
  model?: string
  /**
   * 会话正忙时，该消息注入当前轮次（true），还是排队等待当前轮次执行完毕（false）。
   *
   * 意图随每条指令显式携带，服务端不保存该偏好。默认选项是客户端的输入习惯
   * （界面上的两个选项是「加入队列」与「调整方向」），保存在客户端本地；服务端保存一份
   * 将构成独立的第二份状态，且可能与用户当前的按键不一致。
   *
   * 会话空闲时该字段无意义：两种取值都立即开始一轮。
   */
  steer?: boolean
}

/**
 * 停止会话中正在进行的任务。
 *
 * 按会话寻址，而不是按 run。会话中正在运行的不只有 run：派发的子 agent
 * 比派发它的轮次存活更久，按 runId 停止只能停止其中一项，而界面上只有一个停止按钮。
 * 客户端因此也无需先判定哪个 runId 尚未收尾。
 */
export interface InterruptConversationCommand {
  type: 'conversation.interrupt'
  conversationId: ConversationId
}

export interface SubscribeCommand {
  type: 'subscribe'
  conversationIds: ConversationId[]
}

export interface SetModelCommand {
  type: 'conversation.setModel'
  conversationId: ConversationId
  /** 接口名。切换模型实质是同时切换接口与模型，两者必须一同发送，不得只发送其一。 */
  provider: string
  model: string
}

/**
 * 修改一条排队中的跟进消息的去向，或在会话已空闲时将其直接发出。
 *
 * 一条指令有两种效果，裁决在服务端的同一个同步块中完成。若拆分为「切换去向」与「立即发送」
 * 两条指令，客户端需先判断会话是否忙碌才能决定发送哪一条，而它依据的是上一次
 * `conversation.busy` 留下的值，用户点击时该值可能已不成立。
 *
 * - 会话运行中：将该条目的 `steer` 设为给定值，仍保留在队列中。
 * - 会话空闲：已没有可注入的轮次，因此取出该条目并立即开始一轮。
 *   界面上该按钮的文字随之从选项名称变为「发送」。
 */
export interface FollowUpSteerCommand {
  type: 'followup.steer'
  conversationId: ConversationId
  /** 队列条目 id，即对应 `message.send` 的 `clientRequestId`。 */
  id: string
  steer: boolean
}

/** 删除一条排队中的跟进消息。删除后既不注入当前轮次，也不单独发起。 */
export interface FollowUpDropCommand {
  type: 'followup.drop'
  conversationId: ConversationId
  id: string
}

/** 用户显式触发上下文压缩。 */
export interface CompactCommand {
  type: 'conversation.compact'
  conversationId: ConversationId
}

/**
 * 用户在界面上点击「继续」，使已停止的目标重新开始执行。
 *
 * 该指令必须自行发起一轮，不能只把状态改回 `active` 后等待其他 run 收尾时
 * 才执行：此时用户可能已等待很久，而界面上没有任何变化。
 * 因此服务端使用与自动继续完全相同的排队入口（`run-control.ts`）。
 *
 * 不设对应的「暂停」指令。循环开始运行后，停止它的操作就是中断该会话
 * （`conversation.interrupt`），run 收尾时会将目标置回 `paused` 并清除自动继续标记；
 * 再增加一条指令等于为同一件事提供第二个入口。
 */
export interface GoalResumeCommand {
  type: 'goal.resume'
  conversationId: ConversationId
}

/**
 * 用户使用 `/goal` 设立目标或改写当前目标。这是设立目标的唯一入口。
 *
 * 模型没有 `create_goal`：设立目标需要在第二步就判断该任务是否需要跨轮执行，而模型在该步骤
 * 无法取得这一信息。由模型设立的目标可能在同一个 run 中即被标记为完成，自动继续不会触发，
 * 用户只看到一条未变化的目标条。
 *
 * 设立后立即开始一轮，与「继续」使用同一个排队入口。
 *
 * 只有 `objective` 一个参数：该循环没有轮数上限（见 `Goal` 的注释），
 * 退出条件是模型自检与用户点击停止，因此无需用户填写第二个数值。
 */
export interface GoalSetCommand {
  type: 'goal.set'
  conversationId: ConversationId
  /** 目标内容。空字符串由服务端拒绝，不静默忽略。 */
  objective: string
}

// ───────────────────────── 指令回执 ─────────────────────────

/**
 * 指令被拒绝的回执。只发给发出该指令的客户端，不进入事件总线：
 * 其他客户端没有发出该指令，收到回执只会造成混淆。
 *
 * 必须提供该回执：若 `handleCommand` 的 `default` 分支直接 `return`，未知或未实现的
 * 指令会被静默丢弃。客户端发出后收不到任何反馈，界面上点击无响应，
 * 与服务端正在处理无法区分。
 * 这违反本项目的 fail-closed 原则：不确定时明确失败，不返回成功。
 */
export interface CommandRejectedFrame {
  type: 'command.rejected'
  /** 被拒绝的指令 type，原样返回。 */
  command: string
  reason: CommandRejectReason
  message: string
  /** 指令自带幂等键时返回该键，客户端据此确定对应的操作。 */
  clientRequestId?: string
}

export type CommandRejectReason =
  /** 协议中没有该 type。客户端版本比服务端新，或是伪造流量。 */
  | 'unknown_command'
  /** 协议中有该 type，但当前版本尚未实现。客户端应禁用对应入口。 */
  | 'not_implemented'
  /** 参数不合法。 */
  | 'invalid_payload'
  /** 当前状态下不允许（如会话正忙）。 */
  | 'conflict'
  /**
   * 连接尚未就绪，该指令未发出。
   *
   * 仅由客户端自身产生，服务端不会发送；它替代「连接不可用时静默丢弃指令」的处理。
   * 静默丢弃时，用户点击模型后界面无任何变化，与服务端尚未响应无法区分。
   */
  | 'not_ready'
  /**
   * 服务端处理该指令时抛出异常，指令未生效。
   *
   * 不归入前面几类：`conflict` 表示当前状态不允许（重试有意义），
   * `invalid_payload` 把原因指向客户端。异常的原因在服务端，两者都会产生误导。
   */
  | 'internal_error'

// ─────────────────────────────── 配对 ───────────────────────────────

/**
 * 二维码中编码的内容。手机扫码后直接打开该 URL，token 放在 fragment 中
 * （fragment 不进入服务端日志，也不进入 Referer）。
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

/**
 * 创建角色的斜杠命令。客户端把命令原文作为用户消息发出，提示词按同一个前缀向模型说明。
 * 两端都使用该常量，不各自书写字面量。
 */
export const ROLE_COMMAND = '/role'

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
