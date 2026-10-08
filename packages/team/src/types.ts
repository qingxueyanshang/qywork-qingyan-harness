/**
 * Agent Team：子 agent 与外部 CLI 的编排。
 *
 * 此处定义的是两类独立对象，不是同一对象的两种形态。
 *
 * - **角色（子 agent）**：运行在本进程的 agent 循环上，配置的是身份、可用工具
 *   与约束。它没有运行位置字段：它只在本进程中运行。
 * - **外部 CLI**：本机已安装的其他厂商 agent 程序，支持的厂商见 `cli-detect.ts` 的 `KNOWN`。
 *   它由识别得到，不由用户填写命令与参数；向它派发任务即启动一个独立进程。
 *
 * 两者都可作为图上节点的目标（按 kind：role / cli），但配置互不相关：
 * 将外部 CLI 作为角色的一种运行位置写入角色，代价是创建角色前必须先理解
 * 后端的概念，且删除一个 CLI 会使引用它的角色整体失效。
 */

import type { EffortLevel, WorkflowNode } from '@qywork/core'

/**
 * 一个角色对应一个子 agent。
 *
 * 模型与强度不填写时跟随当前会话：绝大多数角色关注的是提示词与可用工具，
 * 而不是运行在哪个模型上；固定写入会使切换接口变为逐个修改角色。
 */
export interface Role {
  id: string
  name: string
  /** 一句话说明该角色擅长的领域及适合交给它的任务。调度者据此选择角色。 */
  description: string
  /** 追加到该角色系统提示词的约束。 */
  systemPrompt: string
  /** 使用的接口（config.providers 的键）。不填写时使用当前生效的接口。 */
  provider?: string
  model?: string
  effort?: EffortLevel
  /**
   * 允许使用的工具名。空数组表示不提供任何工具（纯分析角色）；
   * undefined 表示继承全部。显式的空数组与不填写含义不同，不要合并。
   */
  allowedTools?: string[]
}

/**
 * 一个识别到的外部 agent CLI。
 *
 * 不写入用户配置。它完全来自内置的厂商表与本机探测：是否安装、安装位置、是否接入。
 * 用户只能决定是否向它派发任务，不能决定调用方式；调用方式由厂商表决定。
 */
export interface CliAgent {
  /** 厂商表中的键，即节点参数 `cli` 的取值。 */
  id: string
  /** 厂商名，界面上显示在名称旁边。 */
  vendor: string
  /** 可执行文件名或已解析出的绝对路径。 */
  command: string
  /** 参数模板。`{prompt}` 会被替换为任务描述。 */
  args: string[]
  /**
   * 输出解析方式，共三种，对应三种实际输出格式：
   * - `text`：整个 stdout 即结果。
   * - `jsonl`：逐行 JSON，取 `resultField` 路径的最后一个非空值。
   * - `json`：整段 stdout 是一个对象（可能缩进为多行），整段解析后按路径提取。
   */
  output: 'text' | 'jsonl' | 'json'
  /** 结构化输出的终态协议。正文、退出码与厂商终态共同决定是否完成。 */
  protocol?: 'codex' | 'claude' | 'grok'
  resultField?: string
  /**
   * 会话 id 所在的点分路径。识别出会话 id 才能续问：
   * 回执不清楚时可以续问，该会话仍保留，CLI 保有已执行操作的上下文。
   * 没有该项的 CLI 只能重新派发。
   */
  sessionField?: string
  /** 续问时使用的参数模板。`{session}` 替换为上一次的会话 id，`{prompt}` 同 `args`。 */
  resumeArgs?: string[]
  /**
   * 流中正文与工具名所在的路径。路径语法与 `resultField` 的点分路径相同，
   * 段尾 `[]` 表示遍历该数组。
   *
   * 只有 `jsonl` 格式的 CLI 能提供：`text` 没有结构可提取，`json` 须在输出结束后整段解析。
   * 未声明时实时页不转发正文，这不是错误。
   */
  narrate?: { text: string; tool?: string }
}

/** 规则约束：对所有角色生效的强制规则。 */
export interface TeamRules {
  /** 追加到所有角色系统提示词的公共约束。 */
  shared?: string
}

/** 编排图与持久化回执共用 core 的 wire 契约，避免工具、服务端、UI 各维护一份。 */
export type PlanNode = WorkflowNode
