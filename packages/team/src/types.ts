/**
 * Agent Team：多智能体协作（需求 10）。
 *
 * 核心抽象是**后端无关的角色**：一个角色说明「它是谁、能用什么、受什么约束」，
 * 至于它跑在内置 loop 上还是外挂的 codex / claude / grok CLI 上，是配置问题。
 *
 * 这一点的对称性来自拓扑决策：`qy` 自己就是一个 CLI，所以「调度外部 CLI」和
 * 「调度自己」是同一条代码路径，多层嵌套不需要特判。
 */

export type BackendKind = 'builtin' | 'cli'

/**
 * 外部 CLI 后端。
 *
 * 不内置各家 CLI 的参数表——它们各自演进，写死必然过期。改为让用户描述
 * 「怎么调起来、怎么读输出」，把知识放在配置里而不是代码里。
 */
export interface CliBackend {
  kind: 'cli'
  /** 可执行文件或命令名。 */
  command: string
  /** 参数模板。`{prompt}` 会被替换成任务描述。 */
  args: string[]
  /** 工作目录，相对工作区。默认工作区根。 */
  cwd?: string
  env?: Record<string, string>
  /**
   * 输出解析方式。
   * - `text`：整个 stdout 就是结果（大多数 CLI 的默认行为）。
   * - `jsonl`：逐行 JSON，取 `resultField` 指定字段的最后一个非空值。
   */
  output: 'text' | 'jsonl'
  resultField?: string
  timeoutMs?: number
}

export interface BuiltinBackend {
  kind: 'builtin'
  /** 用哪个供应商档案（config.profiles 的键）。不填用当前生效的。 */
  profile?: string
  model?: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export type Backend = BuiltinBackend | CliBackend

export interface Role {
  id: string
  name: string
  /** 一句话说明这个角色擅长什么、该把什么交给它。调度者据此选人。 */
  description: string
  /** 追加到该角色系统提示词的约束。 */
  systemPrompt: string
  backend: Backend
  /**
   * 允许使用的工具名。空数组 = 不给任何工具（纯分析角色）；
   * undefined = 继承全部。**显式的空数组和不填是两回事**，不要合并。
   */
  allowedTools?: string[]
  /** 该角色单次任务的步数上限，防止一个角色跑飞拖垮整轮。 */
  maxSteps?: number
}

/** 规则约束：跨角色生效的硬性纪律。 */
export interface TeamRules {
  /** 追加到**所有**角色系统提示词的公共约束。 */
  shared?: string
  /** 同时最多几个角色在跑。默认 3——再多，用户就看不过来了。 */
  maxConcurrent?: number
  /** 整轮的总步数预算。 */
  maxTotalSteps?: number
  /**
   * 需要人工确认才能继续的节点 id。
   * 用于「设计评审必须人看过」这类硬门禁。
   */
  humanGates?: string[]
}

export interface TeamConfig {
  name: string
  rules?: TeamRules
  roles: Role[]
  /** 编排图。空 = 单角色直跑第一个 role。 */
  plan?: PlanNode[]
}

export interface PlanNode {
  id: string
  roleId: string
  /**
   * 任务描述。`{goal}` 替换成用户原始诉求；`{input}` 决定上游产出**插在哪里**。
   * 不写 `{input}` 时上游产出会追加在末尾——声明了 needs 却拿不到产出，
   * 表现是下游角色说「没有上下文」，而配置看起来完全正确。
   */
  task: string
  /** 依赖的节点 id。全部完成后本节点才开始。 */
  needs?: string[]
  /** 设为 false 则依赖只影响顺序，不传递产出。默认传递。 */
  passInput?: boolean
}

export interface NodeResult {
  nodeId: string
  roleId: string
  status: 'done' | 'failed' | 'skipped'
  output: string
  error?: string
  durationMs: number
}
