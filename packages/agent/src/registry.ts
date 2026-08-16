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

import type { ToolSchema } from '@qywork/ai'
import type {
  ActionDescriptor,
  ActionKind,
  FileChange,
  IntermediateResourceRef,
  ResourceCoverage,
  TodoItem,
  ToolOutcomeWire,
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
 * 「这个会话读到那个文件时，它长什么样」。写前的新鲜度校验就靠它。
 *
 * ## 为什么必须是个 port，不能塞进 `state`
 *
 * `state` 是 **run 内的便签**（批级预算、计划快照都在里面，两者必须每轮清零），
 * 而读记录的正确寿命是**整条会话**：模型上一轮读过、这一轮直接改是完全正常的用法，
 * 挂在 run 上就意味着每轮第一次改文件必然先失败一次「未读取过」。
 * 服务端又是**每条消息新建一个 Session**，进程里没有「会话级」这个生命周期可挂——
 * 所以寿命交给装配方（runtime 拿账本按会话存），这里只约定形状。
 *
 * `null` 是合法值：没注入时工具退化成 run 内记账（老行为），不能假设它存在。
 */
export interface FileReadPort {
  /** 读到过就返回当时的内容哈希，没有就 null。 */
  seen(path: string): string | null
  /** 记下刚读到（或刚写出）的内容哈希。 */
  mark(path: string, hash: string): void
}

/**
 * 一次工具调用的结果最多占窗口的几分之一。
 *
 * **不是拍的百分比，是从已有的界推出来的。** `read_file` 的默认行数上限是 2000
 * 行（`tools/files.ts`），2000 行普通代码约 20~25k token。token 上限必须容得下
 * 这个默认读法，否则工具描述里写的「默认 2000 行」就是假的——模型照描述调用，
 * 结果被截，而它不知道为什么。
 *
 * 1/8 在 200k 窗口上恰好是 25k，正好容得下这个默认读法。
 */
export const RESULT_BUDGET_RATIO = 1 / 8

/**
 * 一个执行波次内**全部**结果之和的上限。
 *
 * 限单次没有上界：工具按波次并行，一波五个 `read_file` 各自都在 1/8 以内，
 * 加起来就是 5/8。而「压缩只留发送前检查一个入口」的前提正是
 * **两次检查之间的跳变有上界**——没有批级预算，那个前提不成立。
 */
export const BATCH_BUDGET_RATIO = 1 / 4

const BATCH_SPENT_KEY = 'ctx.batchSpent'

/** 新波次开始，批级预算清零。由 loop 在下发每一波之前调。 */
export function resetBatchBudget(state: Map<string, unknown>): void {
  state.set(BATCH_SPENT_KEY, 0)
}

/**
 * 记一笔结果占用，回答「还放得下吗」。
 *
 * **只对无副作用的读取工具用。** 写入类工具执行完再说超预算是没有意义的——
 * 副作用已经发生，拒绝只会让模型以为它没写成。
 */
export function chargeBatchBudget(
  ctx: Pick<ToolContext, 'state' | 'contextWindow'>,
  tokens: number,
): { ok: boolean; perCall: number; batchRemaining: number } {
  const perCall = Math.floor(ctx.contextWindow * RESULT_BUDGET_RATIO)
  const batchCap = Math.floor(ctx.contextWindow * BATCH_BUDGET_RATIO)
  const spent = (ctx.state.get(BATCH_SPENT_KEY) as number | undefined) ?? 0
  const ok = tokens <= perCall && spent + tokens <= batchCap
  if (ok) ctx.state.set(BATCH_SPENT_KEY, spent + tokens)
  return { ok, perCall, batchRemaining: Math.max(0, batchCap - spent) }
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
  /** 长工具的中途输出回传通道（shell stdout、下载进度）。 */
  emit(channel: 'stdout' | 'stderr' | 'progress', delta: string): void
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
   * 已知凭证，交给子进程之前要剥掉的东西。
   *
   * `values` 是 key 明文，`envNames` 是配置里 `apiKeyEnv` 点名的变量名。
   * 起子进程的工具（目前只有 `run_command`）**必须**用它过一遍环境变量与输出。
   *
   * 这里刻意写成结构类型而不是 `import type { SecretSet } from '@qywork/tools'`：
   * tools 依赖 agent，反向 import 会成环。为一个两字段的对象引一条循环依赖不划算。
   *
   * 可选是为了让现有的测试装配不必全部改；**但工具侧不能因为它缺失就跳过脱敏**，
   * 缺失时按空集合处理即可（那是「没有已知凭证」，不是「不用剥」）。
   */
  secrets?: { values: string[]; envNames: string[] }
  /** 显式放行的环境变量名。只豁免「名字像凭证」这条判据，豁免不了值命中。 */
  envAllowList?: string[]
  /**
   * 工作区之外**额外**可读写的绝对路径。来自配置的 `additionalDirectories`。
   *
   * 它主动放宽安全边界，所以有三条硬要求，缺一条就会退化成一个静默无效的选项：
   *
   * 1. **必须同时喂给三层**——路径解析、`policy.ts` 的静态规则、沙箱 bind 清单。
   *    只接一层的表现都是「配了但不管用」，而三层各自的错误信息完全不同。
   * 2. **只接受绝对路径**，且已经过 `normalizeAdditionalDirectories` 校验。
   * 3. **`full` 模式不豁免它**——它是路径边界不是裁决，与凭证剥离同级。
   *
   * 见 ROADMAP §31。
   */
  additionalDirectories?: string[]
  /**
   * 断掉 shell 命令的出网。来自配置的 `sandboxNetwork: "deny"`。
   *
   * **只有内核沙箱能兑现它**——没有沙箱的平台上这个字段传下去也没有效果，
   * 所以配置体检会在那种机器上明确说它没生效，而不是让用户以为断了。
   */
  denyNetwork?: boolean
}

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
 * 工具能力大类。**六个内置 + 一个类外的 `external`，没有「其他」。**
 *
 * 这是一条与动作轴（`ActionKind`）、权限轴（`PermissionEffect`）**正交**的第三条轴：
 * 动作说「做了什么」，权限说「有什么副作用」，这条说「属于哪个领域」。
 * 三条轴分开的直接好处是动作轴不必再兼职领域——`search` / `fetch` / `plan` /
 * `delegate` 曾经挤在动作轴上，正是因为没有这条轴。
 *
 * 分类是三层：`category`（大类）+ `facet`（类内功能方向）+ `summary`（一句话用途），
 * 注册期必填，缺一即注册失败。
 *
 * `external` 不算在内置里：MCP 与插件的工具自动归它，因为它们的类目由第三方决定，
 * 混进内置分类会让「文件与草稿」那一栏突然冒出别人家的工具。**它不是兜底桶**——
 * 内置工具漏标不会落进来，那种情况注册直接失败。
 *
 * 枚举顺序即界面呈现顺序。
 */
export type ToolCategory =
  | 'files'
  | 'code'
  | 'web'
  | 'knowledge'
  | 'planning'
  | 'session'
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
  'knowledge',
  'planning',
  'session',
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
   * 动作语义。多动作门面从**显式参数**解析，禁止按工具名或结果文案猜。
   *
   * 第二个参数是可选的 `ctx`：有些动作光看参数分不出创建还是编辑——同一份
   * `write_todos(todos)`，第一次提交是「创建待办」，之后是「编辑待办」，
   * 差别在**当前有没有一份未完成的待办清单**，那是 `ctx.state` 里的事实。
   * 拿不到 ctx 时（权限预检那条路）必须能只靠 args 给出一个不撒谎的答案。
   */
  actionKind: ActionKind | ((args: Record<string, unknown>, ctx?: ToolContext) => ActionKind)
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
  ctx?: ToolContext,
): ActionDescriptor {
  const kind = typeof spec.actionKind === 'function' ? spec.actionKind(args, ctx) : spec.actionKind
  const label = typeof spec.objectLabel === 'function' ? spec.objectLabel(args) : spec.objectLabel
  return {
    kind,
    objectLabel: label,
    target: spec.targetExtractor ? spec.targetExtractor(args) : null,
  }
}

export function resolvePermissionEffect(
  spec: ToolSpec,
  args: Record<string, unknown>,
): PermissionEffect {
  const effect =
    typeof spec.permissionEffect === 'function'
      ? spec.permissionEffect(args)
      : spec.permissionEffect
  if (effect === 'internal_control') return effect
  // delete 动作强制叠加 delete 权限，无论工具自己声明的是什么——
  // 一个声明 write 的门面工具在 delete 分支上必须走 delete 闸。
  const kind = typeof spec.actionKind === 'function' ? spec.actionKind(args) : spec.actionKind
  return kind === 'delete' ? 'delete' : effect
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
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
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
      // 工具抛异常不能把整轮 run 带崩：转成结构化失败交给模型，让它自己决定重试或换路。
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
