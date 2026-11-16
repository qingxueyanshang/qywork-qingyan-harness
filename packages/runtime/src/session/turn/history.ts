/** 历史阶段：对话循环的输入历史、上下文读数的基准与接口拒绝媒体的记录。 */

import type { CompactionRunInput } from '@qywork/agent'
import { assembleMessages, mediaCapabilitiesOf, runDensity } from '@qywork/agent'
import type { LlmAdapter, WireMessage } from '@qywork/ai'
import { estimateMessages, reasoningReplay } from '@qywork/ai'
import type { Attachment, ConversationId, MessageId } from '@qywork/core'
import { envelopeHeadTokens } from '@qywork/core'
import {
  conversationRejectsImages,
  conversationRejectsVideos,
  getRun,
  latestSentProviderRequest,
  type Store,
} from '@qywork/store'
import { contextBasis } from '../../context-panel.ts'
import { buildHistory } from '../../transcript.ts'
import { withAttachments } from '../attachments.ts'
import type { SessionState } from '../types.ts'
import type { AskState, RunHistory } from './state.ts'

/**
 * 对话循环的输入历史与接口拒绝媒体的记录。轮次启动（`buildRunHistory`）与两轮之间的读数（`nextRequestMeasure`）
 * 共用本函数：两处取法不同时，压缩后的读数与下一次请求的估算不一致。
 *
 * 历史 = 消息 + 由 steps 投影出的 assistant/tool 回合。只映射 `listMessages` 不够：该表只有 user 行
 * （全项目唯一的 `appendMessage` 位于建行阶段（`open-run.ts`），写入的是 `role:'user'`），因此从第二轮起模型取得的
 * 输入中只有用户消息、没有任何助手回复，跨轮次的上下文在结构上丢失。
 *
 * 接口拒绝图片与视频的记录按「接口名 × 模型」匹配：换用其他接口或模型后照常发送。
 */
async function requestHistory(
  store: Store,
  workspaceRoot: string,
  conversationId: ConversationId,
  upperBound: MessageId | null,
  adapter: LlmAdapter,
  provider: string,
): Promise<{
  preserveAssistantReasoning: boolean
  history: WireMessage[]
  imagesRejected: boolean
  videosRejected: boolean
}> {
  const preserveAssistantReasoning = adapter.spec.chatReasoningProtocol !== 'standard'
  const history = await buildHistory(
    store,
    conversationId,
    upperBound,
    (content, list) => withAttachments(workspaceRoot, content, list as Attachment[]),
    { preserveAssistantReasoning },
  )
  return {
    preserveAssistantReasoning,
    history,
    imagesRejected: conversationRejectsImages(store, conversationId, provider, adapter.spec.id),
    videosRejected: conversationRejectsVideos(store, conversationId, provider, adapter.spec.id),
  }
}

/**
 * 两轮之间（手动压缩）的 `CompactionRunInput.measure`：按下一轮请求的同一装配（`assembleMessages`）估算消息部分。
 *
 * 历史、媒体发送能力与本轮密度的取法与轮次启动相同（`requestHistory`、`RunState`）。信封指纹取最近一次已发送请求的值：
 * 下一轮的系统提示词与工具表在轮次启动时才装配，信封不变时两者相同。
 */
export async function nextRequestMeasure(
  store: Store,
  workspaceRoot: string,
  conversationId: ConversationId,
  adapter: LlmAdapter,
  provider: string,
): Promise<CompactionRunInput['measure']> {
  const { history, imagesRejected, videosRejected } = await requestHistory(
    store,
    workspaceRoot,
    conversationId,
    null,
    adapter,
    provider,
  )
  const density = runDensity(adapter, videosRejected)
  const rules = {
    caps: mediaCapabilitiesOf(adapter, { density, imagesRejected, videosRejected }),
    replay: reasoningReplay(adapter.spec),
    envelope: latestSentProviderRequest(store, conversationId)?.cacheRouteFingerprint ?? '',
  }
  return (project) => estimateMessages(assembleMessages(history, project, rules).messages, density)
}

export async function buildRunHistory(session: SessionState, ask: AskState): Promise<RunHistory> {
  const { store } = session.opts
  const { adapter, conversationId, resolvedTarget, run } = ask
  const { preserveAssistantReasoning, history, imagesRejected, videosRejected } =
    await requestHistory(
      store,
      session.opts.workspaceRoot,
      conversationId,
      run.messageIdUpperBound,
      adapter,
      resolvedTarget?.provider ?? '',
    )

  /*
   * 与面板共用账本基准：当前投影的真值回执，或压缩后的派生估算。
   *
   * 覆盖边界取该回执所属 run 的消息高水位：其后的历史消息未计入锚点。
   * 压缩会使此前的真值失效；首个有效新回执到达前按 manifest 的估算推进。
   * 没有可用基准时，loop 回退到本地估算并标记 `estimated`。
   *
   * 真值锚点属于「接口 × 协议 × 模型」这一路线，不只属于模型名。
   * 同一 model id 配置在两个第三方接口上时，usage 统计口径与实际 tokenizer 都可能不同；
   * 只有完整路线匹配的数据才可复用。迁移前缺少接口或协议的旧行仍保留用于诊断，
   * 但不能参与当前上下文的裁决。
   */
  const { anchored, compacted } = contextBasis(store, conversationId, {
    id: adapter.spec.id,
    providerName: resolvedTarget?.provider ?? '',
    providerKind: adapter.kind,
  })
  const anchorRun = anchored ? getRun(store, anchored.runId) : null
  const anchor = anchored
    ? {
        tokens:
          (anchored.providerInputTokens ?? 0) +
          (anchored.providerCachedTokens ?? 0) +
          (anchored.providerCacheWriteTokens ?? 0) +
          (anchored.providerOutputTokens ?? 0),
        throughMessageId: anchorRun?.messageIdUpperBound ?? null,
        model: anchored.model,
        headTokens: envelopeHeadTokens(anchored.sentCategories),
        // 指纹不匹配时由 loop 替换头部（切换模型时才失效）：只有装配完成后才能确定本轮的信封。
        envelopeFingerprint: anchored.cacheRouteFingerprint,
      }
    : null
  return {
    preserveAssistantReasoning,
    history,
    compacted,
    anchor,
    imagesRejected,
    videosRejected,
  }
}
