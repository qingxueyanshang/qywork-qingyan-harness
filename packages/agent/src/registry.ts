/**
 * 工具注册表：唯一的工具执行出口。
 *
 * 三条不变量：
 *
 * 1. **确定性序列化。** schema 按名字排序输出——工具渲染在 prompt 最前面，
 *    任何顺序抖动都会让整个前缀缓存失效。
 * 2. **fail-closed。** 未注册的工具名返回结构化失败（executed=false），
 *    绝不伪装成功，也绝不静默跳过。
 * 3. **重名即装配错误。** 同名注册直接抛，不静默覆盖——覆盖会无声吞掉一整个插件的工具。
 */

import { estimateJson, type TokenDensity, type ToolSchema } from '@qywork/ai'
import type {
  ActionDescriptor,
  ActionKind,
  FileChange,
  Goal,
  GoalAction,
  GoalWriteResult,
  IntermediateResourceRef,
  ResourceCoverage,
  TodoItem,
  ToolOutcomeWire,
  WorkflowCall,
  WorkflowTransition,
} from '@qywork/core'

// ─────────────────────────────── 执行上下文 ───────────────────────────────

/**
 * 中间资源落盘端口。
 *
 * 接口定义在这里而不是 tools 包：`ToolContext` 在 agent 包，
 * 而 tools 依赖 agent，反向引用会成环。实现由 runtime 装配注入
 * （只有它同时握着内容库和账本）。
 *
 * `null` 是合法值——`qy exec` 这类一次性执行不一定要正文库。
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

  /** 按 resource id 读回正文区间，供 `read_resource` 分页。 */
  read(resourceId: string, start: number, length: number): Uint8Array | null

  stat(resourceId: string): { sizeBytes: number; mimeType: string | null } | null
}

/**
 * 派活端口 —— 把一段任务交给一个子 agent（角色）或本机装着的外部 agent CLI。
 *
 * **为什么是端口。** 同 `SinkPort`：跑一个子会话要 `Session` 与账本，那两样都在依赖图上**高于**
 * tools，工具直接引就是反向边。所以接口在这里、实现由装配方注入。
 *
 * **不注入就没有这个工具。** 与 `sink` 那种「没有就降级」不同：派不出去的派活工具没有任何降级形态，
 * 所以装配方不注入时**不注册这个工具**（B5：没有数据源就不做入口），
 * 而不是注册一个必然回失败的。
 *
 * **子 agent 不得再派活。** 装配方只给顶层会话注入它。成员会话拿不到这个端口，也就不可能递归下去
 * —— 递归派活没有终止条件，一次失控会把整台机器的进程数拖垮。
 */
export interface DelegatePort {
  /** 现在能派给谁。角色与外部 CLI 混在一张表里，`id` 直接可用于 `run`。 */
  targets(): Promise<{ id: string; kind: 'role' | 'cli'; description: string }[]>
  /** 派出去并等它做完。失败是返回值不是异常——模型要按原因换做法。 */
  run(input: {
    target: string
    task: string
    /** 用户点名了模型时才有；不给就跟当前会话同一个。 */
    model?: string
    /**
     * 接着某条外部 CLI 会话继续问（上一次回执里那个 `session`）。
     * 它记得上一轮干了什么，所以回执不清楚时追问比重新派一遍便宜。
     */
    resume?: string
    /**
     * 进度事件挂在哪一轮、哪张卡上。**两个都要**：`runId` 是 `team.member` 的必填字段，
     * `stepId` 是前端认领卡片的依据。
     *
     * `stepId` 允许缺席，那时实现方整条不发——形状来自调用参数、终态来自这条 step 自己，
     * 两样都不依赖这条通道，丢的只有运行期状态与外部 CLI 的中途输出。
     * 这一点与 `runGraph` 不同：那边没有 stepId 整张图画不出状态，所以工具直接拒绝执行。
     */
    runId: string
    stepId?: string
    signal: AbortSignal
  }): Promise<{
    ok: boolean
    output: string
    error?: string
    conversationId?: string
    /**
     * 外部 CLI 那条会话的 id，**下一次要接着问就靠它**。
     * 内置角色没有（那边是子会话，见 `conversationId`）；
     * 认不出 id 的那几家 CLI 也没有，那种只能重新派一次。
     */
    session?: string
  }>
  /**
   * 跑一整张图：一次交清楚拆成哪几件事、谁做、谁等谁。
   *
   * **调度不在这里，在实现方**：依赖就绪才启动、并发上限都由那边的编排器
   * 按图执行。工具只负责把图交出去、把结果拿回来——把调度搬进工具就等于每次跑的
   * 形状都由模型当场决定，出问题无法复现也无法归因。
   *
   * `stepId` 是这次工具调用的卡片 id，实现方按它广播进度，前端据此认领那张图卡。
   * 逐节点的终态要原样回来（含子会话 id）：进度事件不落库，刷新之后能重画这张图的
   * 只有这次调用的返回值。
   */
  runGraph(input: {
    call: WorkflowCall
    runId: string
    stepId: string
    signal: AbortSignal
  }): Promise<{
    ok: boolean
    error?: string
    transition?: WorkflowTransition
  }>
}

/**
 * 装插件端口 —— 把工作区里写好的一个插件目录装进本机的插件目录。
 *
 * **为什么是端口。** 清单校验在插件包里，而它与 tools **同层**（依赖图里都是 3），同层不许互依。
 * 所以工具只声明形状，装配方在更高层实现。
 *
 * **不问用户。** 这个产品只有两种权限模式（`auto` / `full`），没有「逐次询问」这一档。
 * 装插件与别的工具一样，跑到就是同意——把关放在**清单校验**上：形状不对当场拒，
 * 不落盘。
 *
 * **为什么分两步。** `inspect` 只回摘要，给模型判断「这个目录是不是它要装的那个」，
 * 装之前实现方会**再读一次**——中间隔着模型的几步，那个目录可能已经变了。
 */
export interface PluginPort {
  /** 只看不装：目录里的清单长什么样。不合法回 `error`，不抛。 */
  inspect(dir: string): Promise<{
    ok: boolean
    error?: string
    id?: string
    name?: string
    version?: string
    tools?: string[]
    permissions?: string[]
    /** 本机已经装过同 id 的了——这次是覆盖。 */
    replacing?: boolean
  }>
  /** 装。`replace` 为假且已存在同 id 时直接拒绝，不静默覆盖。 */
  install(dir: string, opts: { replace: boolean }): Promise<{ ok: boolean; error?: string }>
}

/**
 * MCP 配置写入端口。
 *
 * 配置解析器在 mcp 包，作用域路径在 tools 包，两者同层不能互相依赖。工具只声明动作，runtime 同时拿到
 * 两边后实现这个端口。没有端口时不注册对应工具，避免出现一个必然失败的入口。
 */
export interface McpConfigPort {
  writeServer(input: { name: string; configJson: string; scope: 'project' | 'global' }): Promise<{
    ok: boolean
    error?: string
    path?: string
    replaced?: boolean
    restartRequired?: boolean
  }>
  moveServer(input: {
    name: string
    fromScope: 'project' | 'global'
    toScope: 'project' | 'global'
  }): Promise<{
    ok: boolean
    error?: string
    fromPath?: string
    toPath?: string
    restartRequired?: boolean
  }>
}

/**
 * 「这个会话读到那个文件时，它长什么样」。写前的新鲜度校验就靠它。
 *
 * **为什么必须是个 port，不能塞进 `state`。** `state` 是 **run 内的便签**（批级预算、计划快照都在里
 * 面，两者必须每轮清零），而读记录的正确寿命是**整条会话**：模型上一轮读过、这一轮直接改是完全正常
 * 的用法，挂在 run 上就意味着每轮第一次改文件必然先失败一次「未读取过」。服务端又是**每条消息新建
 * 一个 Session**，进程里没有「会话级」这个生命周期可挂——所以寿命交给装配方（runtime 拿账本按会话
 * 存），这里只约定形状。
 *
 * `null` 是合法值：没注入时工具退化成 run 内记账（老行为），不能假设它存在。
 */
export interface FileReadPort {
  /** 读到过就返回那一刻的内容哈希，没有就 null。 */
  seen(path: string): string | null
  /** 记下刚读到（或刚写出）的内容哈希。 */
  mark(path: string, hash: string): void
}

/**
 * 目标端口 —— 「立一个目标，一轮接一轮做下去」的那个目标。
 *
 * **为什么是端口。** 与 `SinkPort` 同一条理由：目标落**账本**（`@qywork/store`），而 tools 在依赖图
 * 上 **低于** store，工具直接引它就是一条反向边。所以接口定义在这里（agent），实现由 runtime 注入
 * ——它同时握着账本和事件通道。
 *
 * **不要改用 `ctx.resources`。** 那个 Map 的唯一产地是 `runtime/session.ts` 里的
 * `new Map()`，全仓没有任何键被注入过；走它等于让这条链路一出生就是死的。
 *
 * **写入结果是返回值，不是异常。** 三种拒绝（revision 过期、状态不允许、缺理由）都要**原样交给模型
 * **——它得知道是哪一种才能换个做法。异常会被注册表压成一句「工具执行出错」。
 *
 * **变更事件由实现方发。** 写成功之后 `goal` 事件由端口实现负责广播，不由工具再调一次 `emitXxx`：
 * 「目标变了」和「把它写下去」是同一件事，拆成两步就会有人只做一半。
 * （待办那条通道是另一回事——待办不落账本，工具是它唯一的真源。）
 *
 * `undefined` 是合法值：`qy exec` 这类一次性执行没有会话，也就没有目标。
 * 工具必须能降级——明确报「这里没有目标账本」，不能假装记下了。
 */
/**
 * 待办端口 —— **只读**，因为待办没有第二个写入方。
 *
 * 写入就是 `write_todos` 那次调用本身：loop 把它的 `args` 连同 step 落进账本，
 * 整表语义下最后一次成功提交即全部事实。再开一个 `write()` 就是同一份清单
 * 两处存，两本账迟早对不上。
 *
 * 存在的理由只有一个：**「这是第一份清单，还是在改已有的」是会话级事实**，
 * 而 `ctx.state` 是 run 级的（一条消息一个 run，Map 新建），在里面永远查不到
 * 上一轮的清单，动作词因此只能恒为「创建」或恒为「修改」。
 *
 * 可选：`qy exec` 这类一次性执行没有会话，也就读不回上一份。工具必须能降级，
 * 见 `write_todos` 的 `actionKind`——读不到时说「创建」，那是把一次修订说小了；
 * 反过来说「修改」会在没有清单时声称改过一份不存在的清单。
 */
export interface TodoPort {
  /** 这条会话最近一次成功提交的清单；没提交过就是 null。 */
  read(): TodoItem[] | null
}

export interface GoalPort {
  /** 当前会话的目标；没立过就是 null。 */
  read(): Goal | null
  /**
   * **没有 `create`。** 立目标是用户的动作（`/goal`），不经过工具这条路。
   *
   * `action` 也只到得了 `complete` / `blocked` 两个出口——账本层还认
   * `edit` / `pause` / `resume`，但那三个的生产者在服务端与用户那一侧。
   */
  update(input: {
    goalId: string
    revision: number
    action: GoalAction
    blockedReason?: string
  }): GoalWriteResult
}

/**
 * 一次工具调用能投递多少 token。
 *
 * **依据是工具接口的承诺，不是窗口。** `read_file` 的默认行数上限是 2000 行
 * （`tools/files.ts`），预算必须容得下这个默认读法，否则工具描述里写的
 * 「默认 2000 行」就是假的——模型照描述调用，结果被截，而它不知道为什么。
 * 承诺随产品定，**跟着窗口线性放大是错的**：1M 窗口按比例会给到 125K，
 * 等于一次读取就占掉八分之一上下文。
 *
 * **按最费的那一档标定。** 扣账走 `deliveredTokens`（JSON 档），而各家密度不同：
 * 2000 行普通代码（去掉中文注释、带行号前缀）在已标定的 DeepSeek 档是 23,862，
 * 在未标定模型走的上界档是 29,828。取 30,000 才能让承诺在两档都成立——
 * 按已标定那一档定就会让未标定的端点上 `read_file` 的默认读法被拒。
 *
 * 中文注释密的源码超出这条线是对的，不是标定失误：本仓 2000 行原样实测 25,514
 * token，装进工具结果之后更多，它本来就装不下。
 */
export const READ_DELIVERY_CAP = 30_000

/**
 * 小窗口下单次投递不得超过的窗口份额。
 *
 * 只在 W < 240K 时生效：240K 档它与 `READ_DELIVERY_CAP` 恰好相等（30K），
 * 更大的窗口一律由那条承诺封顶。
 */
export const RESULT_BUDGET_RATIO = 1 / 8

/**
 * 一个执行波次的上限是单次的几倍。
 *
 * 限单次没有上界：工具按波次并行，一波五个 `read_file` 各自都在单次预算以内，
 * 加起来就是五份。批级预算同时是压缩的保留预算（「刚进来的那一波必然完整保留」），
 * 所以它不能被拆成两个数。
 *
 * 取 2 的判据是 200K 档行为逐点不变（对照口径：窗口的 1/4 对 1/8）。不推导：
 * 并行度由模型给出，没有上界。
 */
export const BATCH_TO_CALL_RATIO = 2

/**
 * 这一轮的投递预算。**单次与整波两个上界的唯一算处。**
 *
 * 它不再参与压缩阈值——阈值只有窗口比例一项（`loop.ts` 的 `softLimit`）。
 * 批预算只管投递上界与可折单元的体积上界。
 */
export function deliveryBudget(contextWindow: number): { perCall: number; batchCap: number } {
  const perCall = Math.min(Math.floor(contextWindow * RESULT_BUDGET_RATIO), READ_DELIVERY_CAP)
  return { perCall, batchCap: perCall * BATCH_TO_CALL_RATIO }
}

/**
 * 一段将要作为工具结果投递的正文有多大。**闸门与请求共用这一把尺。**
 *
 * 按 JSON 档量而不是散文档：它最终躺在 `{call_id, tool, status, executed,
 * summary, result}` 里发出去，而 `estimateMessage` 对 tool 角色整条走 JSON 档
 * （`ai/tokens.ts`）。这里换一把尺的话，扣的账和真正装进窗口的是两个数，
 * 差约两成，而两边都不会报错。
 *
 * 边界：这里量的是**未转义**的正文，落进 JSON 时换行等字符会再多占一点，
 * 量级在百分之一二。
 */
export function deliveredTokens(text: string, density: TokenDensity): number {
  return estimateJson(text, density)
}

const BATCH_SPENT_KEY = 'ctx.batchSpent'

/** 新波次开始，批级预算清零。由 loop 在下发每一波之前调。 */
export function resetBatchBudget(state: Map<string, unknown>): void {
  state.set(BATCH_SPENT_KEY, 0)
}

/**
 * 记一笔结果占用，回答「还放得下吗」。
 *
 * **只对无副作用的读取工具用。** 写入类工具执行完再说超预算是没有意义的——
 * 副作用已经发生，拒绝等于告诉模型没写成。
 */
export function chargeBatchBudget(
  ctx: Pick<ToolContext, 'state' | 'contextWindow'>,
  tokens: number,
): { ok: boolean; perCall: number; batchRemaining: number } {
  const { perCall, batchCap } = deliveryBudget(ctx.contextWindow)
  const spent = (ctx.state.get(BATCH_SPENT_KEY) as number | undefined) ?? 0
  const ok = tokens <= perCall && spent + tokens <= batchCap
  if (ok) ctx.state.set(BATCH_SPENT_KEY, spent + tokens)
  return { ok, perCall, batchRemaining: Math.max(0, batchCap - spent) }
}

/**
 * 被折叠掉的会话历史的回读通道。
 *
 * **为什么必须有它。** 压缩是投影不是删除——manifest 只描述「发请求时怎么折」，`messages` /
 * `steps` 一个字节不动。但折叠之后模型手里只剩摘要，**没有任何工具能顺着摘要里的 `[message:…]` /
 * `[action:…]` 标记回到原文**，因此数据在库里躺着而没有消费者。有了它，压缩的语义才是「把内容从常
 * 驻上下文挪到按需读取」，而不是「丢掉」。
 *
 * 与 `SinkPort` 的分工：那条读**工具产出的正文**（落盘的 `rs_xxx`），
 * 这条读**会话历史本身**（消息与执行记录）。两者不重叠，也不互相兜底。
 *
 * `undefined` 是合法值。工具在册但端口没接时如实报「读不了历史」，**不要退化成
 * 「找不到」**——后者会让模型把它当成 id 写错，然后拿几轮去猜一个取不到的 id。
 */
export interface HistoryPort {
  /**
   * 按消息 id 取回原文。不存在返回 null。
   *
   * **两种 id 都要认**：`messages` 表的行 id，以及 run 内注入的那句用户消息的
   * `<runId>:<stepId>`——后者不在 `messages` 表里（它是一条 `kind='user'` 的 step）。
   * 摘要里两者都印成 `[message:…]`，模型分不出也不需要分。
   */
  message(id: string): { role: 'user' | 'assistant'; content: string } | null
  /**
   * 按执行记录 id 取回原文。
   *
   * id 用摘要里那种 `<runId>:<stepId>` 复合形式——单独一个 step id 在跨 run 的
   * 会话里不唯一，而摘要正文引用的是跨 run 的远期记录。
   */
  step(id: string): { tool: string; status: string; args: string; outcome: string } | null
  /**
   * 按工具调用 id 取回那次调用的执行记录。
   *
   * 收纳段把工具结果的正文换成信封，信封里留着 `call_id`——**它就是地址**。
   * 落盘的那些走 `resources` + `read_resource`，没落盘的中小结果只能靠这条：
   * 没有它，收纳等于把它们删了。
   *
   * 不往信封里加新键正是为此：信封每多一个字段，所有历史请求的字节都变，
   * 前缀缓存全失配。
   */
  byCallId(callId: string): { tool: string; status: string; args: string; outcome: string } | null
  /**
   * 在本会话的全部历史里搜子串，返回命中项与它的定位符。
   *
   * 存在的理由与 `read_resource` 的 `query` 一样：知道要找什么时，
   * 搜比让模型去猜 id 快得多，也省得多。
   */
  search(query: string, limit: number): { id: string; kind: 'message' | 'step'; line: string }[]
}

export interface ToolContext {
  workspaceRoot: string
  conversationId: string
  runId: string
  model: string
  /**
   * 这一轮那个模型的上下文窗口。
   *
   * 投递预算按它算，**在执行时应用**——工具跑的那一刻就知道当前模型，
   * 按窗口算出预算、截到位、把结果写进 step。投影只读已落库的 payload、
   * 永不重算界，所以换模型只影响之后的读取，历史一个字节不改。
   *
   * 反过来（投影时按当前模型重算界）会让同一条 step 的字节随模型变，
   * 换一次模型整段历史失配、缓存全丢，投影也不再是纯函数。
   */
  contextWindow: number
  /**
   * 这一轮那个模型的 token 密度。投递预算的扣账用它，与请求那侧同一把尺。
   *
   * 与 `contextWindow` 同因同理：上界按执行时的模型算、结果按算出来的界截好落库，
   * 投影只读已落库的 payload。两侧尺不同的话，同一份结果在闸门这里和在请求里
   * 是两个数，而扣账扣的是前者、装进窗口的是后者。
   */
  density: TokenDensity
  /**
   * 这一轮那个模型收不收图片。三态，约定见 `ai` 的 `ModelSpec.vision`：
   * `null` = 没有出处，按放行算；只有 `false` 才拦。
   *
   * 与 `contextWindow` / `density` 同因同理：在**执行时**按当前模型判。
   * 工具据它决定要不要把图片字节读出来——不判的话，一张图会走完缩放、
   * 扣完投递预算，再在装配请求那一步被换成一句话，白跑一趟。
   */
  vision: boolean | null
  /** 环境注入的只读资源；插件按名取自己需要的，核心不为业务字段扩张。 */
  resources: Map<string, unknown>
  /** 插件的 run 内可变状态。 */
  state: Map<string, unknown>
  signal: AbortSignal
  /** 中间资源落盘。null = 本次执行没有正文库，工具须降级为纯截断。 */
  sink: SinkPort | null
  /**
   * 会话级的「读过哪些文件」。见 `FileReadPort`。
   *
   * 可选而不是必填可空（`sink` 是那种）：没接上时工具退化成 run 内记账，
   * 那是**更严**的一侧（每轮要求重读一次），漏接不会放宽任何边界。
   */
  reads?: FileReadPort
  /**
   * 会话级的目标与自动续起。见 `GoalPort`。
   *
   * 可选而不是必填可空：没接上时目标工具明确报「本次执行没有目标账本」，
   * 那是**更严**的一侧（循环起不来），漏接不会让任何循环自己跑起来。
   */
  goals?: GoalPort
  /**
   * 会话级的「上一份待办清单」。见 `TodoPort`。
   *
   * 只读：`write_todos` 用它判动作词，Agent Loop 用它判断一次正常 end_turn 后
   * 是否仍有未完成项。没接上时工具一律报「创建」，循环沿用普通问答的结束语义；
   * 两边都不会凭空编一份清单。
   */
  todos?: TodoPort
  /**
   * 被折叠历史的回读通道。见 `HistoryPort`。
   *
   * 装配方握着账本时总该接上；没接时工具如实报，不伪装成「找不到」。
   */
  history?: HistoryPort
  /**
   * 派活通道。见 `DelegatePort`。
   *
   * 没接上时 `subagent` 工具不注册，所以工具体里可以断言它在。
   */
  delegate?: DelegatePort
  /**
   * 装插件通道。见 `PluginPort`。
   *
   * 没接上时 `install_plugin` 不注册——同 `delegate` 那条：
   * 装不了插件的装插件工具没有任何降级形态。
   */
  plugins?: PluginPort
  /** MCP 配置通道；没接时 `write_mcp_server` / `move_mcp_server` 不注册。 */
  mcpConfig?: McpConfigPort
  /**
   * 长工具的中途输出回传通道（shell stdout、下载进度）。
   *
   * **只能由 loop 按 step 绑定**：这条通道产出的 `tool.delta` 要带 stepId 才认得出
   * 是哪张卡片的输出，而 stepId 是 loop 在开 step 时才拿到的。装配方（runtime）
   * 造不出这个字段，也不许自己造一个空值顶上——前端按 stepId 找卡片，
   * 找不到就是整条通道静默丢弃。所以装配方交出的是 `ToolContextBase`，
   * emit 由 loop 在每次调用前补上。
   */
  emit(channel: 'stdout' | 'stderr' | 'progress', delta: string): void
  /**
   * 这一次工具调用的 step id。**与 `emit` 同一条理由由 loop 补上**：它是开 step 时
   * 才产生的，装配方造不出来。
   *
   * 用途是让工具把「进度事件挂在哪张卡上」交给服务端——`workflow` 的图卡就靠它认领
   * `team.member`。不要拿它当「这次调用的身份」到处传：卡片之外没有第二个消费者。
   *
   * 可选而不是必填：直接构造 `ToolContext` 的地方（测试夹具）不该被迫编一个假 id。
   * 用它的工具必须自己判空并**如实报错**——挂不上卡的进度事件到了前端也是静默丢弃，
   * 假装派出去了比直接说「拿不到卡片 id」坏得多。
   */
  stepId?: string
  /**
   * 待办变更广播。可选：装配方没接就没有待办面板，工具仍能正常记账。
   *
   * 单独一条通道而不是复用 emit：emit 是**增量文本**语义（stdout 一段一段来），
   * 待办是**整表快照**语义，混在一条通道里前端没法区分该追加还是该替换。
   */
  emitTodos?(todos: TodoItem[]): void
  /**
   * 请求授权。被拒时工具必须原样放弃，不得绕行。
   *
   * **返回值可以带理由**，这是两模式设计的关键：`auto` 模式下没有人可问，
   * 拒绝只能作为工具失败结果回到模型手里——它得知道**为什么**才能换个做法。
   * 只回 `false` 的话模型看到的是「已拒绝：execute:xxx」，除了重试一遍没别的选择。
   *
   * 兼容 `boolean`：老的装配和大量测试夹具都写着 `async () => true`，
   * 为了一个可选的理由字段去改几十处夹具不划算。`true`/`false` 由
   * `normalizeVerdict` 归一，没给理由时补一句中性的。
   *
   * `meta` 让裁决方知道这是**哪个工具**在请求。只看 scope 分不出
   * `run_command` 和某个插件工具——两者的 scope 都是 `execute:<目标>`，
   * 而它们该走的裁决路径完全不同。
   */
  requestPermission(
    scope: string,
    preview: string,
    meta?: { toolName: string; args: Record<string, unknown> },
  ): Promise<boolean | PermissionVerdict>
  /**
   * 已知凭证，交给子进程之前要剥掉的那几个值。
   *
   * `values` 是 key 明文。起子进程的工具（目前只有 `run_command`）**必须**
   * 用它过一遍环境变量与输出。
   *
   * 这里刻意写成结构类型而不是 `import type { SecretSet } from '@qywork/tools'`：
   * tools 依赖 agent，反向 import 会成环。为一个单字段的对象引一条循环依赖不划算。
   *
   * 可选是为了让现有的测试装配不必全部改；**但工具侧不能因为它缺失就跳过脱敏**，
   * 缺失时按空集合处理即可（那是「没有已知凭证」，不是「不用剥」）。
   */
  secrets?: { values: string[] }
  /** 显式放行的环境变量名。只豁免「名字像凭证」这条判据，豁免不了值命中。 */
  envAllowList?: string[]
  /**
   * 工作区之外**额外**可读写的绝对路径。来自配置的 `additionalDirectories`。
   *
   * 它主动放宽安全边界，所以有三条硬要求，缺一条就会退化成一个静默无效的选项：
   *
   * 1. **必须同时传给三层**——路径解析、`policy.ts` 的静态规则、沙箱 bind 清单。
   *    只接一层的表现都是「配了但不管用」，而三层各自的错误信息完全不同。
   * 2. **只接受绝对路径**，且已经过 `normalizeAdditionalDirectories` 校验。
   * 3. **`full` 模式不豁免它**——它是路径边界不是裁决，与凭证剥离同级。
   */
  additionalDirectories?: string[]
  /**
   * 「完全访问」模式：路径边界整个不设。
   *
   * **它不是 `additionalDirectories` 的替代品**——那份是「在受限模式下额外开几个
   * 目录」，这个是「这一档不设边界」。两者同时存在时后者赢，因为
   * `full` 的定义就是不裁决。
   *
   * 与权限闸是同一个模式的两面：`session.ts` 的 `decide` 在 `full` 下一进来就
   * 返回 allowed，所以 `run_command` 早就全放行了。路径层不跟着放开的结果不是
   * 「更安全」，是模型 `read_file` 被拒、转头 `run_command` 读到——账本里
   * 账本里有一次实证（会话 `cv_0msw3jst9`）。
   */
  unrestrictedPaths?: boolean
  /**
   * 断掉 shell 命令的出网。来自配置的 `sandboxNetwork: "deny"`。
   *
   * **只有内核沙箱能兑现它**——没有沙箱的平台上这个字段传下去也没有效果，
   * 所以配置体检会在那种机器上明确说它没生效，而不是显示成已断网。
   */
  denyNetwork?: boolean
}

/**
 * 装配方能交出的那一半：除 `emit` 与 `stepId` 之外的全部。
 *
 * 分成两半是因为这两样的事实来源与其余字段不同——其余的在 run 开始时就定了，
 * 而 stepId 每次工具调用才产生（`emit` 要带它，`workflow` 也要拿它挂图卡）。
 * 装配方拿不到，所以它们不出现在这个类型里，由 loop 在调用前补齐。
 */
export type ToolContextBase = Omit<ToolContext, 'emit' | 'stepId'>

/**
 * 授权裁决。
 *
 * 拒绝**必须**带理由。这是两模式设计的直接后果：`auto` 下没有弹窗，
 * 被拒的唯一去处是模型的工具结果，而模型只有拿到理由才能换个做法
 * （「写不了工作区外的路径」→ 它会改成写工作区内）。
 */
export type PermissionVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * 把 `boolean` 归一成裁决。
 *
 * 老装配与测试夹具大量写着 `async () => true`，为一个可选字段改几十处不划算。
 * `false` 补一句中性理由——**不能留空**，空理由传到模型那里就退化成
 * 「失败了，不知道为什么」，那是最没用的一种反馈。
 */
function normalizeVerdict(v: boolean | PermissionVerdict, scope: string): PermissionVerdict {
  if (v === true) return { allowed: true }
  if (v === false) return { allowed: false, reason: `已拒绝：${scope}` }
  return v.allowed ? v : { allowed: false, reason: v.reason || `已拒绝：${scope}` }
}

export type ToolFn = (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>

/** 工具执行结果。这是规范事实，必须原样抵达账本、事件流和 provider transcript。 */
export interface ToolOutcome {
  status: 'success' | 'failure'
  /** 是否真的执行了。权限拒绝 / 未知工具 = false。 */
  executed?: boolean
  message: string
  data?: Record<string, unknown>
  fileChanges?: FileChange[]
  /** 本次调用落盘的中间资源。必须原样进账本——压缩层要靠它判断正文还在不在。 */
  resources?: IntermediateResourceRef[]
  errorKind?: string
}

// ─────────────────────────────── 工具声明 ───────────────────────────────

/**
 * 工具能力大类。**九个内置 + 一个类外的 `external`，没有「其他」。**
 *
 * 这是一条与动作轴（`ActionKind`）、权限轴（`PermissionEffect`）**正交**的第三条轴：
 * 动作说「做了什么」，权限说「有什么副作用」，这条说「属于哪个领域」。
 * 三条轴分开的直接好处是动作轴不必兼职领域：没有这条轴，`search` / `fetch` /
 * `plan` / `delegate` 这类词就会挤到动作轴上去。
 *
 * 分类是三层：`category`（大类）+ `facet`（类内功能方向）+ `summary`（一句话用途），
 * 注册期必填，缺一即注册失败。
 *
 * `external` 不算在内置里：MCP 与插件的工具自动归它，因为它们的类目由第三方决定，
 * 混进内置分类会让「文件与草稿」那一栏突然冒出外部来源的工具。**它不是兜底桶**——
 * 内置工具漏标不会落进来，那种情况注册直接失败。
 *
 * 枚举顺序即界面呈现顺序。
 */
export type ToolCategory =
  | 'files'
  | 'code'
  | 'web'
  | 'memory'
  | 'skills'
  | 'planning'
  | 'goal'
  | 'session'
  | 'schedule'
  | 'external'

/**
 * 全部类目，**顺序即界面顺序**。
 *
 * 派生不了——TypeScript 的联合类型在运行时不存在，注册期校验需要一份真值。
 * 两处必须一起改，所以放在紧邻的位置：类型定义的下一行。
 */
export const TOOL_CATEGORIES: ToolCategory[] = [
  'files',
  'code',
  'web',
  'memory',
  'skills',
  'planning',
  'goal',
  'session',
  'schedule',
  'external',
]

/** 权限副作用轴。注册时必填——没有默认值，忘了填就注册失败。 */
export type PermissionEffect =
  | 'read'
  | 'write'
  | 'delete'
  | 'execute'
  | 'network'
  /** 纯内部控制（如 todo 记账），不受权限闸约束。 */
  | 'internal_control'

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  /**
   * `parameters` 是不是本仓自己写的。默认是——**第三方 schema 必须显式填 `false`**。
   *
   * 适配器据此决定要不要把它重排成协议要求的 strict 形状（`ToolSchema.strict`）。
   * 判据是「谁写的」而不是「长什么样」：一份第三方 schema 就算形状恰好合格，
   * 也不该被改写后发出去。
   */
  strict?: boolean
  /**
   * 动作语义。多动作门面从**显式参数**解析，禁止按工具名或结果文案猜。
   *
   * 第二个参数是可选的 `ctx`，但**别拿 `ctx.state` 当判据**：它是 run 级的
   * （一条消息一个 run，Map 新建），跨轮的事实在里面查不到，而权限预检那条路
   * 根本拿不到 ctx。只靠 args 给不出答案的，说明这个动作该是个常量。
   */
  actionKind: ActionKind | ((args: Record<string, unknown>, ctx?: ToolContextBase) => ActionKind)
  objectLabel: string | ((args: Record<string, unknown>) => string)
  /** 从参数提取稳定目标（通常是文件路径），供进度判定与并行冲突检测使用。 */
  targetExtractor?: (args: Record<string, unknown>) => string | null
  permissionEffect: PermissionEffect | ((args: Record<string, unknown>) => PermissionEffect)
  /**
   * 并行默认关闭。只有工具显式 opt-in **且**本次具体参数通过 parallelSafe，
   * 才可能与同批次的其他调用放进同一执行波次。
   */
  parallelSafe?: boolean | ((args: Record<string, unknown>) => boolean)
  /** 本次调用会触碰的资源键，用于同波次冲突检测（同一文件不能并行写）。 */
  resourceKeys?: (args: Record<string, unknown>) => string[]
  /**
   * 能力大类。注册时必填——漏标即注册失败，不给默认值。
   *
   * 给默认值（比如默认 `session`）的代价是实打实的：新加的工具会静默落进一个
   * 与它无关的类目，而分类表看起来是完整的。闸放在注册期，不放在取数时。
   */
  category: ToolCategory
  /**
   * 类内的功能方向（第二层）。受控短语，同一类里复用同一批词——
   * 「文件与草稿」下就是「读写」「检索」「管理」这几个，不是一句自由描述。
   */
  facet: string
  /** 一句话用途，给人看（工具清单那一栏）。不是给模型看的——那是 `description`。 */
  summary: string
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
 * 权限效果**只取工具自己声明的那个值，不从动作轴推导**。
 *
 * 两条轴正交（见 `ToolCategory` 上那段）：动作说「做了什么」，权限说「有什么副作用」。
 * 拿 `kind === 'delete'` 反推权限就是把一条轴接到另一条上——同一个工具的权限会随
 * 参数在两条规则之间跳，而声明的那个值反倒不作数。要走 delete 闸的工具，
 * `permissionEffect` 里直接写 `delete`（门面工具就写成按参数返回的函数）。
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
   * 产出发给模型的 schema 数组，按名排序。缓存直到工具集变化——
   * 每轮重排重建不只是浪费，还会让下游按对象身份做的 token 缓存失效。
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

  /** 唯一执行入口。任何路径都不得绕过这里直接调 spec.fn。 */
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
        message: `未知工具: ${name}`,
        errorKind: 'unknown_tool',
      }
    }

    const effect = resolvePermissionEffect(spec, args)
    if (effect !== 'internal_control') {
      const action = resolveAction(spec, args, ctx)
      const scope = `${effect}:${action.target ?? action.objectLabel}`
      const verdict = normalizeVerdict(
        await ctx.requestPermission(scope, describeCall(spec, args), { toolName: name, args }),
        scope,
      )
      if (!verdict.allowed) {
        // executed=false 是关键：被拒的调用没有产生任何副作用，
        // 后续的崩溃恢复和重试逻辑依赖这个事实。
        //
        // 理由要原样带给模型。`auto` 模式下这是它唯一能拿到的信号——
        // 只说「已拒绝」的话它除了原样重试没有别的选择，而重试必然又被拒。
        return {
          status: 'failure',
          executed: false,
          message: verdict.reason,
          errorKind: 'permission_denied',
        }
      }
    }

    try {
      const out = await spec.fn(args, ctx)
      return {
        status: out.status,
        executed: out.executed ?? true,
        message: out.message,
        ...(out.data ? { data: out.data } : {}),
        ...(out.fileChanges ? { fileChanges: out.fileChanges } : {}),
        ...(out.resources?.length ? { resources: out.resources } : {}),
        ...(out.errorKind ? { errorKind: out.errorKind } : {}),
      }
    } catch (err) {
      /*
       * **自带 `errorKind` 的异常是判定，不是崩溃。**
       *
       * 路径越界这类边界拒绝走的也是 throw（每个文件工具各写一遍 try/catch 就是
       * B4 那种特判堆叠），但套上「执行出错」的壳之后，模型读到的是一次偶发故障
       * ——它会重试，或者去找绕路。账本里就有一次：越界被拒之后模型改用
       * `run_command` 绕过去，还没告诉用户。所以这类原样端出去：
       * 消息就是那条判定本身，`executed: false`（什么都没发生过）。
       */
      if (err instanceof Error) {
        const declared = (err as Error & { errorKind?: unknown }).errorKind
        if (typeof declared === 'string' && declared) {
          return { status: 'failure', executed: false, message: err.message, errorKind: declared }
        }
      }
      // 真异常不能把整轮 run 带崩：转成结构化失败交给模型，让它自己决定重试或换路。
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
 * provider 对工具名的硬约束。
 *
 * OpenAI 兼容协议的原话：`Invalid 'tools[0].function.name': string does not match
 * pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'`。
 * Anthropic 的限制相同。
 *
 * 这条必须在**注册期**拦住，不能留到发请求时。实测的失败形态是：装了一个 id
 * 叫 `demo.lines` 的插件（反向域名风格，清单文档自己推荐的写法），
 * 工具名成了 `demo.lines__count`，然后**每一轮 run 都被 400 打死**，
 * 错误信息只说「tools[0].function.name 无效」——不说是哪个插件，
 * 而这时候整个会话已经完全不能用了。
 *
 * 在注册期抛，装配的人当场就能看见是谁的问题。
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * 把任意标识符改成 provider 收得下的工具名。
 *
 * 给插件与 MCP 这类**名字来自第三方**的产出方用。转换是确定性的，
 * 但不保证无碰撞（`a.b` 和 `a_b` 会撞），所以调用方必须自己查重并报出来——
 * 静默覆盖会无声吞掉一整个插件的工具。
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
    // 描述是模型判断「何时调用」的唯一依据，空描述等于这个工具不会被正确使用。
    throw new Error(`[qywork] 工具 ${spec.name} 缺少 description`)
  }
  if (!spec.permissionEffect) {
    throw new Error(`[qywork] 工具 ${spec.name} 未声明 permissionEffect`)
  }
  // 三条轴一样对待：漏标就是装配错误，当场抛。给默认值的话新工具会静默落进
  // 一个与它无关的类目，而分类表看起来完整——那种错没人会发现。
  if (!TOOL_CATEGORIES.includes(spec.category)) {
    throw new Error(
      `[qywork] 工具 ${spec.name} 的 category 无法识别：${String(spec.category)}` +
        `（可用：${TOOL_CATEGORIES.join('、')}）`,
    )
  }
  if (!spec.facet?.trim()) throw new Error(`[qywork] 工具 ${spec.name} 未声明 facet`)
  if (!spec.summary?.trim()) throw new Error(`[qywork] 工具 ${spec.name} 未声明 summary`)
}

/** 给用户看的授权预览。要具体到能判断该不该批，不能只说「要写文件」。 */
function describeCall(spec: ToolSpec, args: Record<string, unknown>): string {
  const target = spec.targetExtractor?.(args)
  const parts = [spec.name]
  if (target) parts.push(target)
  const extra = Object.entries(args)
    .filter(([k]) => k !== 'path' && k !== 'file_path')
    .map(([k, v]) => `${k}=${truncate(String(v), 120)}`)
  return [parts.join(' '), ...extra].join('\n')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`
}
