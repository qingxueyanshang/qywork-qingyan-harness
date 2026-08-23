/**
 * Agent Team：子 agent 与外部 CLI 的编排（需求 10）。
 *
 * **这里是两件事，不是一件事的两种形态。**
 *
 * - **角色（子 agent）**：跑在本进程的 agent 循环上，配置的是「它是谁、能用什么、
 *   受什么约束」。它没有「跑在哪」这个字段——它只跑在这里。
 * - **外部 CLI**：本机装着的别家 agent 程序，认哪几家看 `cli-detect.ts` 的 `KNOWN`。
 *   它由识别得到，不由用户填命令与参数；派活给它就是起一个独立进程。
 *
 * 两者都能当编排节点的目标（`PlanNode.agent`），但它们的配置面毫不相干：
 * 把外部 CLI 当成「角色的一种运行位置」写进角色里，代价是建一条角色必须先懂
 * 后端这个概念，而且删掉一个 CLI 会让引用它的角色整条消失。
 */

import type { EffortLevel } from '@qywork/core'

/** 目标是外部 CLI 时，`PlanNode.agent` 用这个前缀。角色 id 不带前缀。 */
export const CLI_PREFIX = 'cli:'

/**
 * 一个角色 = 一个子 agent。
 *
 * 模型与强度**不填就跟着当前会话**：绝大多数角色关心的是提示词与工具面，
 * 不是跑在哪个模型上；写死会让「换个接口试试」变成逐个角色改。
 */
export interface Role {
  id: string
  name: string
  /** 一句话说明这个角色擅长什么、该把什么交给它。调度者据此选人。 */
  description: string
  /** 追加到该角色系统提示词的约束。 */
  systemPrompt: string
  /** 用哪个接口（config.providers 的键）。不填用当前生效的。 */
  provider?: string
  model?: string
  effort?: EffortLevel
  /**
   * 允许使用的工具名。空数组 = 不给任何工具（纯分析角色）；
   * undefined = 继承全部。**显式的空数组和不填是两回事**，不要合并。
   */
  allowedTools?: string[]
  /** 该角色单次任务的步数上限，防止一个角色跑飞拖垮整轮。 */
  maxSteps?: number
}

/**
 * 一个识别到的外部 agent CLI。
 *
 * **不落用户配置。** 它整条来自内置的厂商表 + 本机探测：装没装、在哪、有没有接入。
 * 用户能做的只有「派不派活给它」，没有「怎么调它」——那是表的事。
 */
export interface CliAgent {
  /** 表里的键，也是 `PlanNode.agent` 里 `cli:` 后面那一段。 */
  id: string
  /** 厂商名，界面上贴在名字旁边。 */
  vendor: string
  /** 可执行文件名或已解析出的绝对路径。 */
  command: string
  /** 参数模板。`{prompt}` 会被替换成任务描述。 */
  args: string[]
  /**
   * 输出解析方式。
   * - `text`：整个 stdout 就是结果。
   * - `jsonl`：逐行 JSON，取 `resultField` 指定字段的最后一个非空值。
   */
  output: 'text' | 'jsonl'
  resultField?: string
  timeoutMs?: number
}

/** 规则约束：跨角色生效的硬性纪律。 */
export interface TeamRules {
  /** 追加到**所有**角色系统提示词的公共约束。 */
  shared?: string
  /** 同时最多几个角色在跑。默认 3——再多，用户就看不过来了。 */
  maxConcurrent?: number
  /**
   * 派给这几个**目标**的节点，执行前必须人工确认（角色 id，或 `cli:<id>`）。
   *
   * **键是目标不是节点 id。** 图现在由模型现画，节点 id 是它当场拟的，
   * 用节点 id 当键只有两种结局：引用不到当场炸，或者不校验、那条「必须人看过」
   * 静默失效——而一个开着但不生效的安全开关比没有这个开关更坏。
   * 按目标写「派给 deployer 的节点都要我点头」，模型画的图与人画的图都命中。
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
  /** 派给谁：角色 id，或 `cli:<id>` 指一个识别到的外部 CLI。 */
  agent: string
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
  /** 同 `PlanNode.agent`：角色 id 或 `cli:<id>`。 */
  agent: string
  status: 'done' | 'failed' | 'skipped'
  output: string
  error?: string
  durationMs: number
  /**
   * 这个节点跑出来的子会话。**必须带出来**：图卡刷新之后重画时，
   * 「点开看它读了什么、跑了哪些命令」的入口只有这一个 id，
   * 而进度事件不落库（见 `docs/plans/2026-08-23-workflow-图化编排.md` 取证 11）。
   * 外部 CLI 没有子会话，那边这个字段自然缺席。
   */
  conversationId?: string
}
