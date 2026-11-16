/** 对话循环的持久化端口（`LoopPersistence`）：step 的写入与结算、压缩记录与请求记录。 */

import type { LoopPersistence } from '@qywork/agent'
import type { WireToolCall } from '@qywork/ai'
import {
  appendStep,
  appendTextToStep,
  failThinkingSteps,
  markImagesUndelivered,
  markStepExecuting,
  recordCompactionStep,
  settleToolStep,
} from '@qywork/store'
import { redactSecrets } from '@qywork/tools'
import { collectSecrets } from '../config.ts'
import { requestPersistence } from '../request-persistence.ts'
import type { SessionState } from './types.ts'

function nextSeq(session: Pick<SessionState, 'seqCounter'>, runId: string): number {
  const next = (session.seqCounter.get(runId) ?? 0) + 1
  session.seqCounter.set(runId, next)
  return next
}

export function makePersistence(
  session: Pick<SessionState, 'opts' | 'seqCounter'>,
): LoopPersistence {
  const { store, content } = session.opts
  return {
    nextSeq: (runId) => nextSeq(session, runId),
    openTextStep: (runId, seq, batchId) =>
      appendStep(store, {
        runId,
        seq,
        kind: 'text',
        content: '',
        providerBatchId: batchId,
      }).id,
    openThinkingStep: (runId, seq, batchId, reasoning) =>
      appendStep(store, {
        runId,
        seq,
        kind: 'thinking',
        content: '',
        providerBatchId: batchId,
        ...(reasoning ? { payload: { kind: 'response_reasoning', reasoning } as const } : {}),
      }).id,
    // 创建即为终态：注入的消息没有中间状态，`status` 使用默认的 `done`。
    landUserStep: (runId, seq, input) =>
      appendStep(store, {
        runId,
        seq,
        kind: 'user',
        content: input.text,
        payload: {
          kind: 'user',
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.origin ? { origin: input.origin } : {}),
          ...(input.notice ? { notice: true as const } : {}),
          ...(input.imagesRejected ? { imagesRejected: input.imagesRejected } : {}),
          ...(input.videosRejected ? { videosRejected: input.videosRejected } : {}),
        },
      }).id,
    markImagesUndelivered: (runId, toolCallIds) => markImagesUndelivered(store, runId, toolCallIds),
    failThinkingSteps: (stepIds) => failThinkingSteps(store, stepIds as never),
    appendText: (stepId, delta) => appendTextToStep(store, stepId as never, delta),
    openToolStep: (runId, seq, call: WireToolCall, batchId, callIndex, waveIndex, action) =>
      appendStep(store, {
        runId,
        seq,
        kind: 'tool_action',
        toolName: call.name,
        toolCallId: call.id,
        providerBatchId: batchId,
        callIndex,
        executionWaveIndex: waveIndex,
        status: 'running',
        // action 必须写入数据库：它由 ToolSpec 按参数解析，前端无法反向推导。
        payload: { kind: 'tool_call', args: call.arguments, action },
      }).id,
    markExecuting: (stepId) => markStepExecuting(store, stepId as never),
    settleTool: (stepId, status, outcome, args, action, durationMs) =>
      settleToolStep(
        store,
        stepId as never,
        status,
        { kind: 'tool_result', args, outcome, action },
        durationMs,
        content,
      ).outcome,
    recordCompaction: (runId, seq, payload) => {
      recordCompactionStep(store, runId, seq, {
        kind: 'compaction',
        ...payload,
        ...(payload.message
          ? { message: redactSecrets(payload.message, collectSecrets(session.opts.config)) }
          : {}),
      })
    },
    ...requestPersistence(store, session.opts.config),
  }
}
