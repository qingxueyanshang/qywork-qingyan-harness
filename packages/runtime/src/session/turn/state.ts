/**
 * 一轮 `ask` 的状态。
 *
 * `Session.ask` 的各阶段（准备、建行、历史、驱动、收尾）读写同一份状态。不要在阶段函数中另存副本：
 * 收尾依据 `finished` 与 `failure` 写入终态，副本与此处不一致时 run 行的终态随之出错。
 */

import type { AgentLoop } from '@qywork/agent'
import type { LlmAdapter, ProviderProfile, WireMessage } from '@qywork/ai'
import type { Conversation, ConversationId, EffortLevel, Run } from '@qywork/core'
import type { ModelRef, resolveModel } from '../../config.ts'
import type { contextBasis } from '../../context-panel.ts'
import type { buildTailNotes } from '../../prompt.ts'
import type { AskOptions } from '../types.ts'
import type { KnownContext } from './known-context.ts'

/** 准备阶段的产物：写入 run 行之前解析与冻结的取值。 */
export interface TurnPlan {
  readonly startedAt: number
  readonly model: string
  readonly conversationId: ConversationId
  readonly conversation: Conversation | null
  readonly target: string | ModelRef
  readonly resolvedTarget: ReturnType<typeof resolveModel>
  readonly effort: EffortLevel | undefined
  readonly profile: ProviderProfile
  readonly adapter: LlmAdapter
  readonly compactPercent: number
  readonly known: KnownContext
  readonly contextSnapshot: ReturnType<typeof buildTailNotes>
}

/** 写入 run 行之后的状态：本轮的输入、run 行、心跳与终态标记。 */
export interface AskState extends TurnPlan {
  readonly prompt: string
  readonly options: AskOptions | undefined
  readonly run: Run
  readonly userMessageId: Run['userMessageId']
  readonly heartbeat: ReturnType<typeof setInterval>
  /** 本轮的 run 行是否已写入终态。 */
  finished: boolean
  /*
   * 报错正文必须写入数据库。`runs.error_message` / `error_code` 两列是 `RunRecord`
   * 中报错正文的唯一来源；不写入时，`stop_reason` 为
   * `provider_error` 的 run 在账本中的报错正文是 `null`，界面刷新之后
   * 只显示「模型服务出错」，无法区分连接失败与 key 错误。
   *
   * `run.error` 恒在 `run.finished` 之前（`agent/loop/index.ts` 连续 yield 两条），
   * 因此由驱动阶段在收到 `run.error` 时记入本字段即可，无需另开一条持久化路径。
   */
  failure: { message: string; code: string } | null
}

/** 历史阶段的产物：对话循环的输入历史与上下文读数的基准。 */
export interface RunHistory {
  readonly preserveAssistantReasoning: boolean
  readonly history: WireMessage[]
  readonly compacted: ReturnType<typeof contextBasis>['compacted']
  readonly anchor: NonNullable<Parameters<AgentLoop['run']>[0]['anchor']> | null
  readonly imagesRejected: boolean
  readonly videosRejected: boolean
}
