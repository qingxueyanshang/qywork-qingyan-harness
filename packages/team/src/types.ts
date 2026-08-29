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

import type { EffortLevel, WorkflowNode, WorkflowReceipt } from '@qywork/core'

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
  /** 该角色单次任务的步数上限，防止一个角色失控拖垮整轮。 */
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
   * 输出解析方式。三种，对应三种真实形状：
   * - `text`：整个 stdout 就是结果。
   * - `jsonl`：逐行 JSON，取 `resultField` 那个路径的最后一个非空值。
   * - `json`：整段 stdout 是**一个**对象（可能缩进成多行），整段解析后按路径取。
   */
  output: 'text' | 'jsonl' | 'json'
  resultField?: string
  /**
   * 会话 id 埋在哪个点分路径上。**认得出它才接得上下一句**——
   * 回执不清楚时可以接着问它，那条会话还在，它自己记得干过什么。
   * 没有这一项的那几家只能重新派一次。
   */
  sessionField?: string
  /** 接着问时用的参数模板。`{session}` 换成上一次的会话 id，`{prompt}` 同 `args`。 */
  resumeArgs?: string[]
  timeoutMs?: number
}

/** 规则约束：跨角色生效的硬性纪律。 */
export interface TeamRules {
  /** 追加到**所有**角色系统提示词的公共约束。 */
  shared?: string
  /** 一张图里同时最多几个节点在跑。默认 3——再多，用户就看不过来了。同一轮里 `subagent` 派出去的那几件不受它约束。 */
  maxConcurrent?: number
}

export interface TeamConfig {
  name: string
  rules?: TeamRules
  roles: Role[]
  /**
   * 编排图。**每次由调用方交进来**（模型这一次画的那张），不来自 `.qy/team.json`
   * ——那个字段连同它的解析、回传、显示已经删了，编排图只有一个来源。
   */
  plan: PlanNode[]
}

/** 编排图与持久化回执共用 core 的 wire 契约，避免工具、服务端、UI 各维护一份。 */
export type PlanNode = WorkflowNode
export type NodeResult = WorkflowReceipt
