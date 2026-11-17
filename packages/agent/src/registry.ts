/**
 * 工具注册表：唯一的工具执行入口。
 *
 * 三条不变量：
 *
 * 1. **确定性序列化。** schema 按名称排序输出：工具定义位于 prompt 最前部，
 *    任何顺序变化都会使整个前缀缓存失效。
 * 2. **fail-closed。** 未注册的工具名返回结构化失败（executed=false），
 *    不报告为成功，也不静默跳过。
 * 3. **重名即装配错误。** 同名注册直接抛出异常，不静默覆盖：覆盖会丢弃整个插件的工具。
 */

import type { TokenDensity, ToolSchema } from '@qywork/ai'
import type {
  ActionDescriptor,
  ActionKind,
  FileChange,
  IntermediateResourceRef,
  ResourceCoverage,
  ToolOutcomeWire,
} from '@qywork/core'
import type { PortKey } from './ports/key.ts'

// ─────────────────────────────── 执行上下文 ───────────────────────────────

/**
 * 中间资源落盘端口。
 *
 * 接口定义在此处而不是 tools 包：`ToolContext` 位于 agent 包，
 * 而 tools 依赖 agent，反向引用会形成环。实现由 runtime 装配时注入
 * （只有它同时持有内容库与账本）。
 *
 * `null` 是合法值：`qy exec` 等一次性执行不一定需要正文库。
 * 工具必须能在没有 sink 的情况下降级工作，不能假设它存在。
 */
export interface SinkPort {
  land(input: {
    toolName: string
    sourceType: string
    body: Uint8Array
    mimeType?: string | null
    coverage?: ResourceCoverage
  }): { resourceId: string; contentHash: string }

  /** 按 resource id 读取正文区间，供 `read_resource` 分页。 */
  read(resourceId: string, start: number, length: number): Uint8Array | null

  stat(resourceId: string): { sizeBytes: number; mimeType: string | null } | null
}

const COMPACTION_EPOCH_KEY = 'ctx.compactionEpoch'

/**
 * 本 run 中已生效的压缩次数。
 *
 * 压缩将上下文末尾保留区之前的工具正文替换为信封。工具先前投递、之后仍要引用的结果，仅当其记录的
 * 次数与当前次数相等时，才仍逐字保留在模型的上下文中。
 */
export function compactionEpoch(state: Map<string, unknown>): number {
  return (state.get(COMPACTION_EPOCH_KEY) as number | undefined) ?? 0
}

/** 记录一次已生效的压缩。由 loop 在压缩生效之后调用。 */
export function markCompacted(state: Map<string, unknown>): void {
  state.set(COMPACTION_EPOCH_KEY, compactionEpoch(state) + 1)
}

export interface ToolContext {
  workspaceRoot: string
  conversationId: string
  runId: string
  model: string
  /**
   * 本轮所用模型的上下文窗口。观察视图的单份尺寸据此计算。
   *
   * 所有上限都**在执行时应用**：投递额度（`delivery.ts`，loop 在每次决策时重新建立）与视图尺寸在工具执行
   * 时确定，结果截断后写入 step。投影只读取已落库的 payload，不重新计算上限，
   * 因此更换模型只影响之后的读取，历史不改动任何字节。
   *
   * 若在投影时按当前模型重新计算上限，同一条 step 的字节会随模型变化，
   * 每更换一次模型整段历史都会失配、缓存全部失效，投影也不再是纯函数。
   */
  contextWindow: number
  /**
   * 本轮的估算密度（`loop/request.ts` 的 `runDensity`）。投递预算的扣减使用它，与请求一侧采用同一计量标准；
   * 其中的 `video` 是本轮原生视频的规则与发送范围，null 表示不原生发送，`read_file` 据此决定返回视频还是抽帧。
   *
   * 理由同 `contextWindow`：上限按执行时的模型计算，结果按算出的上限截断后落库，
   * 投影只读取已落库的 payload。两侧计量标准不同时，同一份结果在投递检查处与在请求中
   * 是两个不同的数值，而预算扣减的是前者，进入窗口的是后者。
   */
  density: TokenDensity
  /**
   * 本轮所用模型是否接受图片。三态，约定见 `ai` 的 `ModelSpec.vision`：
   * `null` = 没有出处，按放行处理；只有 `false` 时拦截。
   *
   * 理由同 `contextWindow` / `density`：在**执行时**按当前模型判定。
   * 工具据此决定是否读取图片字节；不判定时，一张图片会完成缩放、
   * 扣减投递预算，再在装配请求时被替换为一句提示，本次执行因此无效。
   */
  vision: boolean | null
  /**
   * 接口拒绝过本会话中包含图片的请求（`RunState.imagesRejected`）。为 true 时工具不读取图片字节，直接返回失败：
   * 图片发出前会被替换为说明。由 loop 按调用注入，装配方不设置。
   */
  imagesRejected?: true
  /**
   * 接口拒绝过本会话中包含视频的请求（`RunState.videosRejected`）。为 true 时 `density.video` 为 null，
   * `read_file` 读取视频时抽帧并写明原因。由 loop 按调用注入，装配方不设置。
   */
  videosRejected?: true
  /**
   * 适配器将本地视频上传为地址的字节阈值（`transmits.mediaUploadAbove`），省略表示一律内联。
   * `read_file` 与 `videoDelivery` 据此判断一段原生发送的视频内联还是上传，与发送时使用同一判据。
   */
  videoUploadAbove?: number
  /** 插件的 run 内可变状态。 */
  state: Map<string, unknown>
  signal: AbortSignal
  /** 中间资源落盘。null = 本次执行没有正文库，工具须降级为纯截断。 */
  sink: SinkPort | null
  /**
   * 取用一个端口（`ports/key.ts`）：由装配方注入、只被少数工具使用的能力。
   *
   * 返回 null 表示本次执行没有该能力，工具须降级或如实报告；`ToolSpec.requires` 中的端口
   * 在注册时已确认存在。不要为某一类工具的能力在本类型上增加字段：端口随使用它的工具声明，
   * 本类型只保留与具体工具域无关的字段。
   */
  port<T>(key: PortKey<T>): T | null
  /**
   * 长时间运行工具的中间输出回传通道（shell stdout、下载进度）。
   *
   * **只能由 loop 按 step 绑定**：该通道产出的 `tool.delta` 须携带 stepId 才能识别
   * 所属卡片，而 stepId 在 loop 创建 step 时才产生。装配方（runtime）
   * 无法构造该字段，也不得自行构造空值替代：前端按 stepId 查找卡片，
   * 未找到时整条通道被静默丢弃。因此装配方提供的是 `ToolContextBase`，
   * emit 由 loop 在每次调用前补充。
   */
  emit(channel: 'stdout' | 'stderr' | 'progress', delta: string): void
  /**
   * 本次工具调用的 step id。**理由同 `emit`，由 loop 补充**：它在创建 step 时
   * 才产生，装配方无法构造。
   *
   * 用途有两个：工具向服务端告知进度事件所属的卡片（`workflow` 的图卡依靠它认领 `team.member`）；
   * `run_command` 转入后台时把它传给 `CommandPort.adopt`，命令结束时的文件改动追加到这条 step。
   * 不要将它作为本次调用的身份传给其他消费者。
   *
   * 可选而不是必填：直接构造 `ToolContext` 的位置（测试夹具）不应被迫编造 id。
   * 使用它的工具必须自行判空并**如实报错**：无法关联卡片的进度事件到达前端后同样会被静默丢弃，
   * 声称已派发远比直接报告「无法获取卡片 id」有害。
   */
  stepId?: string
  /**
   * 请求授权。被拒绝时工具必须直接放弃，不得绕行。
   *
   * 入参是工具名与参数：裁决按工具区分（`run_command` 与插件工具的执行目标形状相同，
   * 裁决路径完全不同）。拒绝必须带理由，见 `PermissionVerdict`。
   */
  requestPermission(call: {
    toolName: string
    args: Record<string, unknown>
    /** 本次调用将执行的命令行（`ToolSpec.commandLine`）。不执行命令的调用没有该字段。 */
    command?: string
  }): Promise<PermissionVerdict>
  /**
   * 已知凭证：传给子进程之前须剥离的值。
   *
   * `values` 是 key 明文。启动子进程的工具（目前只有 `run_command`）**必须**
   * 用它过滤环境变量与输出。
   *
   * 此处有意写为结构类型而不是 `import type { SecretSet } from '@qywork/tools'`：
   * tools 依赖 agent，反向 import 会形成环。不值得为一个单字段对象引入循环依赖。
   *
   * 可选是为了使现有测试装配无需全部修改；**但工具侧不能因其缺失而跳过脱敏**，
   * 缺失时按空集合处理（含义是「没有已知凭证」，而不是「无需剥离」）。
   */
  secrets?: { values: string[] }
  /** 显式放行的环境变量名。只豁免「名称形似凭证」这一判据，不豁免值命中。 */
  envAllowList?: string[]
  /**
   * 工作区之外**额外**可读写的绝对路径。来自配置的 `additionalDirectories`。
   *
   * 它主动放宽安全边界，因此有三条硬性要求，缺少任何一条都会使其退化为静默无效的选项：
   *
   * 1. **必须同时传给三层**：路径解析、`policy.ts` 的拒绝清单、沙箱 bind 清单。
   *    只接入一层时配置不生效，且三层各自的错误信息完全不同。
   * 2. **只接受绝对路径**，且已经过 `normalizeAdditionalDirectories` 校验。
   * 3. **它是 `auto` 的机制。** `full` 下完全不设路径边界，是否配置此清单结果相同，
   *    不要写为「`full` 不豁免它」：那与 `unrestrictedPaths` 的语义相反。
   */
  additionalDirectories?: string[]
  /**
   * 只读根目录：已安装技能各自的目录与本会话附件（绝对路径），由装配方按本轮扫描结果提供。
   *
   * `auto` 下模型工具的读取本已包含根目录之外（凭证文件除外）。本字段的作用是在内核沙箱生效的平台上，
   * 使这些目录不受沙箱屏蔽的凭证目录限制：全局技能与粘贴的附件位于 `~/.qywork` 中。写入范围不因这些目录扩大。
   */
  readOnlyRoots?: string[]
  /**
   * 「完全访问」模式：完全不设路径边界。
   *
   * **它不是 `additionalDirectories` 的替代**：后者在受限模式下额外开放若干
   * 目录，前者表示该模式不设边界。两者同时存在时以前者为准，因为
   * `full` 的定义就是不裁决。
   *
   * 它与权限检查是同一模式的两个方面：`runtime/session/permission.ts` 的 `decide` 在 `full` 下直接
   * 返回 allowed，`run_command` 已全部放行。路径层若不随之放开，结果不是更安全，
   * 而是 `read_file` 被拒、`run_command` 却能读取同一文件。
   *
   * 只由 `execute` 按本次调用的裁决填入（`PermissionVerdict`），装配方不得提供：
   * 每轮固定一次时，运行中切换模式后路径层仍按旧模式判定，而命令裁决已按新模式。
   *
   * 电脑控制的工具同样读取它，据此决定动作能否作用于本应用自身的窗口（`tools/desktop/shared/run.ts` 的
   * `actScope`）：为真时动作请求带上 `allowSelfWindow`，否则作用于本应用窗口的动作在派发之前被拒绝。
   *
   * **它不影响内核沙箱层。** `shell.ts` 组装 `SandboxPolicy` 时不读取此字段，
   * 因此在具备 bubblewrap / seatbelt 的平台上，`full` 下 shell 子进程仍受写入边界约束。
   */
  unrestrictedPaths?: boolean
  /**
   * 禁止 shell 命令访问网络。来自配置的 `sandboxNetwork: "deny"`。
   *
   * **只有内核沙箱能实现此限制**：没有沙箱的平台上传入此字段也不生效，
   * 因此配置体检会在此类机器上明确报告其未生效，而不是显示为已断网。
   */
  denyNetwork?: boolean
}

/**
 * 装配方能够提供的部分：除 `emit` 与 `stepId` 之外的全部字段。
 *
 * 拆分的原因是这两个字段的来源与其余字段不同：其余字段在 run 开始时即已确定，
 * 而 stepId 在每次工具调用时才产生（`emit` 须携带它，`workflow` 也用它关联图卡）。
 * 装配方无法取得这两个字段，因此它们不出现在此类型中，由 loop 在调用前补齐。
 */
export type ToolContextBase = Omit<ToolContext, 'emit' | 'stepId' | 'unrestrictedPaths'>

/**
 * 授权裁决。
 *
 * 拒绝**必须**带理由。这是两种模式设计的直接结果：`auto` 下没有弹窗，
 * 拒绝信息只能经由工具结果提供给模型，而模型只有取得理由才能改用其他做法
 * （「无法写入工作区外的路径」→ 改为写入工作区内）。
 *
 * 放行时带上本次调用的路径范围：模式与路径边界取自同一次读取。
 */
export type PermissionVerdict =
  | { allowed: true; unrestrictedPaths?: true }
  | { allowed: false; reason: string }

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>

/** 工具执行结果。这是规范事实，必须原样抵达账本、事件流和 provider transcript。 */
export interface ToolOutcome {
  status: 'success' | 'failure'
  /** 是否实际执行。权限拒绝 / 注册表未命中 = false。 */
  executed?: boolean
  message: string
  data?: Record<string, unknown>
  /** 明确的用户界面展示意图；缺省结果只进入模型上下文与账本。 */
  presentation?: { images?: 'inline' }
  fileChanges?: FileChange[]
  /**
   * 执行器确认本次调用没有产生任何效果，例如浏览器动作之后未跳转、未发出请求、DOM 未变化且元素表不变。
   * 只能由掌握这些事实的执行器设置；缺省表示不确定，不表示有效果。连续无进展判定据此计数（`provablyNoEffect`）。
   */
  noEffect?: true
  /** 本次调用落盘的中间资源。必须原样写入账本：压缩层据此判断正文是否仍然存在。 */
  resources?: IntermediateResourceRef[]
  errorKind?: string
}

// ─────────────────────────────── 工具声明 ───────────────────────────────

/**
 * 工具能力大类。**没有「其他」。**
 *
 * 这是与动作轴（`ActionKind`）、权限轴（`PermissionEffect`）**正交**的第三条轴：
 * 动作轴描述「做了什么」，权限轴描述「有什么副作用」，本轴描述「属于哪个领域」。
 * 三轴分离使动作轴无需承担领域划分：没有本轴时，`search` / `fetch` /
 * `plan` / `delegate` 等词会进入动作轴。
 *
 * 分类共三层：`category`（大类）+ `facet`（类内功能方向）+ `summary`（一句话用途），
 * 注册期必填，缺少任何一项即注册失败。
 *
 * `mcp` 与 `plugins` 各自是一个领域：MCP server 提供的工具一律归入 `mcp`，插件提供的工具
 * 一律归入 `plugins`，因为它们的类目由第三方决定；内置工具中只有管理 MCP 配置的归入 `mcp`、
 * 安装插件的归入 `plugins`。两者不是后备类目：内置工具未标注类目时注册直接失败，不会归入其中。
 *
 * 枚举顺序即界面呈现顺序。
 */
export type ToolCategory =
  | 'files'
  | 'code'
  | 'web'
  | 'browser'
  | 'desktop'
  | 'office'
  | 'media'
  | 'memory'
  | 'skills'
  | 'planning'
  | 'goal'
  | 'session'
  | 'schedule'
  | 'mcp'
  | 'plugins'

/**
 * 全部类目，**顺序即界面顺序**。
 *
 * 无法从类型派生：TypeScript 的联合类型在运行时不存在，注册期校验需要一份运行时取值。
 * 两处必须同步修改，因此紧邻放置在类型定义之后。
 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  'files',
  'code',
  'web',
  'browser',
  'desktop',
  'office',
  'media',
  'memory',
  'skills',
  'planning',
  'goal',
  'session',
  'schedule',
  'mcp',
  'plugins',
]

/** 权限副作用轴。注册时必填：没有默认值，未填写即注册失败。 */
export type PermissionEffect =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network'
  /**
   * 操作内置浏览器中已受控的页面。
   *
   * 单独列出而不并入 `network`：这些页面带有用户的登录态，副作用发生在网站上，
   * 与无登录态的网络请求不属于同一类操作。
   */
  | 'browser'
  /**
   * 操作本机上其他应用的窗口与控件。
   *
   * 单独列出而不并入 `execute`：`execute` 表示启动新进程，本项改变的是已运行
   * 应用的状态，边界由宿主的目标身份与系统授权裁决，不经过命令行规则。
   */
  | 'desktop'
  /** 纯内部控制（如 todo 记录），不受权限检查约束。 */
  | 'internal_control'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * `parameters` 是否由本仓库编写。默认为是：**第三方 schema 必须显式填写 `false`**。
   *
   * 适配器据此决定是否将其重排为协议要求的 strict 形状（`ToolSchema.strict`）。
   * 判据是编写来源而不是形状：第三方 schema 即使形状恰好合格，
   * 也不应改写后发送。
   */
  strict?: boolean
  /**
   * 动作语义。多动作门面从**显式参数**解析，禁止按工具名或结果文案推测。
   *
   * 第二个参数是可选的 `ctx`，但**不要以 `ctx.state` 作为判据**：它是 run 级的
   * （一条消息对应一个 run，Map 每次新建），无法查到跨轮的事实，而权限预检路径
   * 无法取得 ctx。仅凭 args 无法得出结果时，说明该动作应为常量。
   */
  actionKind: ActionKind | ((args: Record<string, unknown>, ctx?: ToolContextBase) => ActionKind)
  objectLabel: string | ((args: Record<string, unknown>) => string)
  /** 从参数提取稳定目标（通常是文件路径），供进度判定与并行冲突检测使用。 */
  targetExtractor?: (args: Record<string, unknown>) => string | null
  /**
   * 每组参数至少给出一个，如 `[['ops_json', 'ops_path']]`。schema 的 `required` 无法表达二选一，
   * 与 `required` 一样在权限解析之前核对：缺少参数的调用不询问权限。
   */
  requireOneOf?: readonly (readonly string[])[]
  permissionEffect: PermissionEffect | ((args: Record<string, unknown>) => PermissionEffect)
  /**
   * 本次调用将执行的命令行。会启动进程的工具声明它，权限裁决对它运行与 `run_command` 相同的命令判定；
   * 本次调用不执行命令时返回 null。
   *
   * 由工具声明，不由裁决方按工具名判断：按名称判断时，新增一个会启动进程的工具，就多出一条
   * 不经命令判定的路径，且不会报错。
   */
  commandLine?: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => string | null | Promise<string | null>
  /**
   * 并行默认关闭。只有工具显式 opt-in **且**本次具体参数通过 parallelSafe，
   * 才可能与同批次的其他调用放入同一执行波次。
   */
  parallelSafe?: boolean | ((args: Record<string, unknown>) => boolean)
  /** 本次调用涉及的资源键，用于同一波次内的冲突检测（同一文件不能并行写入）。 */
  resourceKeys?: (args: Record<string, unknown>) => string[]
  /**
   * 能力大类。注册时必填：缺少即注册失败，不提供默认值。
   *
   * 提供默认值（例如默认 `session`）会使新增工具静默归入
   * 无关的类目，而分类表看起来仍然完整。校验放在注册期，不放在读取时。
   */
  category: ToolCategory
  /**
   * 类内的功能方向（第二层）。使用受控短语，同一类中复用同一组词，
   * 例如「文件与草稿」下为「读写」「检索」「管理」，不使用自由描述。
   */
  facet: string
  /** 一句话用途，面向用户（工具清单中的用途列）。不面向模型：面向模型的是 `description`。 */
  summary: string
  /**
   * 工具必需的端口。任一未提供时内置工具不注册：没有该能力时工具没有降级形态。
   * 缺失时仍能降级工作的端口不写在此处，工具经 `ctx.port` 取用并自行判空。
   */
  requires?: readonly PortKey<unknown>[]
  fn: ToolFn
}

export function resolveAction(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx?: ToolContextBase,
): ActionDescriptor {
  const kind = typeof spec.actionKind === 'function' ? spec.actionKind(args, ctx) : spec.actionKind
  const label = typeof spec.objectLabel === 'function' ? spec.objectLabel(args) : spec.objectLabel
  return {
    kind,
    objectLabel: label,
    target: spec.targetExtractor ? spec.targetExtractor(args) : null,
  }
}

/**
 * 权限效果**只取工具自身声明的值，不从动作轴推导**。
 *
 * 两条轴正交（见 `ToolCategory` 的注释）：动作轴描述「做了什么」，权限轴描述「有什么副作用」。
 * 以 `kind === 'delete'` 反推权限会把一条轴耦合到另一条轴上：同一个工具的权限会随
 * 参数在两条规则之间切换，而声明值反而不起作用。需要经过 delete 权限检查的工具，
 * 在 `permissionEffect` 中直接写 `delete`（门面工具写为按参数返回的函数）。
 */
export function resolvePermissionEffect(
  spec: ToolSpec,
  args: Record<string, unknown>,
): PermissionEffect {
  return typeof spec.permissionEffect === 'function'
    ? spec.permissionEffect(args)
    : spec.permissionEffect
}

export function isParallelSafe(spec: ToolSpec, args: Record<string, unknown>): boolean {
  if (spec.parallelSafe === undefined) return false
  return typeof spec.parallelSafe === 'function' ? spec.parallelSafe(args) : spec.parallelSafe
}

// ─────────────────────────────── 注册表 ───────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ToolSpec>()
  private schemaCache: ToolSchema[] | null = null

  register(spec: ToolSpec): void {
    if (this.tools.has(spec.name)) {
      throw new Error(`[qywork] 工具重复注册，拒绝静默覆盖：${spec.name}`)
    }
    validate(spec)
    this.tools.set(spec.name, spec)
    this.schemaCache = null
  }

  /** 校验整批替换内容后一次性提交，不得覆盖不属于本批的工具。 */
  replaceOwned(owned: ReadonlySet<string>, specs: readonly ToolSpec[]): void {
    const next = new Map(this.tools)
    for (const name of owned) next.delete(name)
    for (const spec of specs) {
      if (next.has(spec.name)) throw new Error(`工具名冲突：${spec.name}`)
      validate(spec)
      next.set(spec.name, spec)
    }
    this.tools.clear()
    for (const [name, spec] of next) this.tools.set(name, spec)
    this.schemaCache = null
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name)
  }

  list(): ToolSpec[] {
    return [...this.tools.values()]
  }

  /**
   * 生成发给模型的 schema 数组，按名称排序。结果缓存至工具集变化：
   * 每轮重新排序与构建不仅浪费，还会使下游按对象身份建立的 token 缓存失效。
   */
  schemas(): ToolSchema[] {
    if (this.schemaCache) return this.schemaCache
    this.schemaCache = [...this.tools.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: t.strict !== false,
      }))
    return this.schemaCache
  }

  /** 唯一执行入口。任何路径都不得绕过此处直接调用 spec.fn。 */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolOutcomeWire> {
    const spec = this.tools.get(name)
    if (!spec) {
      return {
        status: 'failure',
        executed: false,
        message: `未注册调用：${name}`,
        errorKind: 'unregistered_tool_call',
      }
    }

    // required 与发给模型的 schema 同源，缺少参数时不进入权限解析或工具执行。
    const required = spec.parameters.required
    const missing = Array.isArray(required)
      ? required.filter((key): key is string => typeof key === 'string' && args[key] === undefined)
      : []
    for (const group of spec.requireOneOf ?? []) {
      if (!group.some((key) => args[key] !== undefined)) missing.push(group.join(' 或 '))
    }
    if (missing.length) {
      return {
        status: 'failure',
        executed: false,
        message: `工具 ${name} 缺少必填参数：${missing.join('、')}。请按工具定义传入 JSON 参数。`,
        errorKind: 'invalid_tool_arguments',
      }
    }

    const effect = resolvePermissionEffect(spec, args)
    let callCtx = ctx
    if (effect !== 'internal_control') {
      let verdict: Awaited<ReturnType<typeof ctx.requestPermission>>
      /*
       * 裁决本身抛出（读取会话的权限模式时账本损坏）时工具尚未执行：以 `executed: false` 的失败返回。
       * 不要让异常越过本函数：调用方会以整轮失败结束，已登记「即将执行」的该调用随后被记为执行状态不明。
       */
      try {
        const command = (await spec.commandLine?.(args, ctx)) ?? null
        verdict = await ctx.requestPermission({
          toolName: name,
          args,
          ...(command !== null ? { command } : {}),
        })
      } catch (err) {
        return {
          status: 'failure',
          executed: false,
          message: `工具 ${name} 的权限裁决出错，未执行：${err instanceof Error ? err.message : String(err)}`,
          errorKind: 'permission_check_failed',
        }
      }
      if (!verdict.allowed) {
        // executed=false 是必需的：被拒的调用没有产生任何副作用，
        // 后续的崩溃恢复与重试逻辑依赖这一事实。
        //
        // 理由须原样返回给模型。`auto` 模式下这是模型能取得的唯一信号：
        // 只返回「已拒绝」时模型只能原样重试，而重试必然再次被拒。
        return {
          status: 'failure',
          executed: false,
          message: verdict.reason,
          errorKind: 'permission_denied',
        }
      }
      if (verdict.unrestrictedPaths) callCtx = { ...ctx, unrestrictedPaths: true }
    }

    try {
      const out = await spec.fn(args, callCtx)
      return {
        status: out.status,
        executed: out.executed ?? true,
        message: out.message,
        ...(out.data ? { data: out.data } : {}),
        ...(out.presentation ? { presentation: out.presentation } : {}),
        ...(out.fileChanges ? { fileChanges: out.fileChanges } : {}),
        ...(out.noEffect ? { noEffect: out.noEffect } : {}),
        ...(out.resources?.length ? { resources: out.resources } : {}),
        ...(out.errorKind ? { errorKind: out.errorKind } : {}),
      }
    } catch (err) {
      /*
       * **自带 `errorKind` 的异常是判定，不是崩溃。**
       *
       * 路径越界等边界拒绝同样以 throw 表达（每个文件工具各写一遍 try/catch 即
       * B4 所述的特判堆叠），但包装为「执行出错」后，模型会将其视为偶发故障，
       * 进而重试或寻找绕行路径，例如越界被拒后改用 `run_command` 读取且不告知用户。
       * 因此这类异常原样返回：消息即判定本身，`executed: false`（未执行任何操作）。
       */
      if (err instanceof Error) {
        const declared = (err as Error & { errorKind?: unknown }).errorKind
        if (typeof declared === 'string' && declared) {
          return { status: 'failure', executed: false, message: err.message, errorKind: declared }
        }
      }
      // 真实异常不得导致整轮 run 失败：转为结构化失败返回给模型，由模型决定重试或改用其他做法。
      return {
        status: 'failure',
        executed: true,
        message: `工具 ${name} 执行出错: ${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'tool_exception',
      }
    }
  }
}

/**
 * provider 对工具名的硬性约束。
 *
 * OpenAI 兼容协议的错误原文：`Invalid 'tools[0].function.name': string does not match
 * pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'`。
 * Anthropic 的限制相同。
 *
 * 必须在**注册期**拦截，不能延迟到发送请求时：id 为 `demo.lines` 的插件
 * （反向域名风格，清单文档推荐的写法）会生成工具名 `demo.lines__count`，
 * 此后**每一轮 run 都被 400 拒绝**，错误信息只指出「tools[0].function.name 无效」
 * 而不指明插件，整个会话因此无法使用。
 *
 * 在注册期抛出异常，装配方可以立即定位出问题的插件。
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * 将任意标识符转换为 provider 可接受的工具名。
 *
 * 供插件与 MCP 等**名称来自第三方**的提供方使用。转换是确定性的，
 * 但不保证无冲突（`a.b` 与 `a_b` 会冲突），因此调用方必须自行查重并报告：
 * 静默覆盖会丢弃整个插件的工具。
 */
export function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

function validate(spec: ToolSpec): void {
  if (!spec.name.trim()) throw new Error('[qywork] 工具缺少 name')
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `[qywork] 工具名 ${spec.name} 含 provider 不接受的字符（只允许字母、数字、下划线、短横线，最长 64）`,
    )
  }
  if (!spec.description.trim()) {
    // 描述是模型判断何时调用的唯一依据，描述为空时该工具无法被正确使用。
    throw new Error(`[qywork] 工具 ${spec.name} 缺少 description`)
  }
  if (!spec.permissionEffect) {
    throw new Error(`[qywork] 工具 ${spec.name} 未声明 permissionEffect`)
  }
  // 三条轴同等处理：缺少即装配错误，立即抛出。提供默认值时新工具会静默归入
  // 无关的类目，而分类表看起来仍然完整，此类错误无法被发现。
  if (!TOOL_CATEGORIES.includes(spec.category)) {
    throw new Error(
      `[qywork] 工具 ${spec.name} 的 category 无法识别：${String(spec.category)}` +
        `（可用：${TOOL_CATEGORIES.join('、')}）`,
    )
  }
  if (!spec.facet?.trim()) throw new Error(`[qywork] 工具 ${spec.name} 未声明 facet`)
  if (!spec.summary?.trim()) throw new Error(`[qywork] 工具 ${spec.name} 未声明 summary`)
}
