/** 历史阶段：对话循环的输入历史、上下文读数的基准与接口拒绝媒体的记录。 */

import type { Attachment } from '@qywork/core'
import { envelopeHeadTokens } from '@qywork/core'
import { conversationRejectsImages, conversationRejectsVideos, getRun } from '@qywork/store'
import { contextBasis } from '../../context-panel.ts'
import { buildHistory } from '../../transcript.ts'
import { withAttachments } from '../attachments.ts'
import type { SessionState } from '../types.ts'
import type { AskState, RunHistory } from './state.ts'

export async function buildRunHistory(session: SessionState, ask: AskState): Promise<RunHistory> {
  const { store } = session.opts
  const { adapter, conversationId, resolvedTarget, run } = ask
  /*
   * 历史 = 消息 + 由 steps 投影出的 assistant/tool 回合。
   *
   * 只映射 `listMessages` 不够：该表只有 user 行（全项目唯一的
   * `appendMessage` 位于建行阶段（`open-run.ts`），写入的是 `role:'user'`），因此从第二轮起模型取得的
   * 输入中只有用户消息、没有任何助手回复，跨轮次的上下文在结构上丢失。
   */
  const preserveAssistantReasoning = adapter.spec.chatReasoningProtocol !== 'standard'
  const history = await buildHistory(
    store,
    conversationId,
    run.messageIdUpperBound,
    (content, list) => withAttachments(session.opts.workspaceRoot, content, list as Attachment[]),
    { preserveAssistantReasoning },
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
  // 接口拒绝图片与视频的记录按「接口名 × 模型」匹配：换用其他接口或模型后照常发送。
  const imagesRejected = conversationRejectsImages(
    store,
    conversationId,
    resolvedTarget?.provider ?? '',
    adapter.spec.id,
  )
  const videosRejected = conversationRejectsVideos(
    store,
    conversationId,
    resolvedTarget?.provider ?? '',
    adapter.spec.id,
  )
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
