/** 自动与手动压缩共用的摘要请求记账。 */
import { type ChatRequest, estimateRequest, type LlmAdapter, type ProviderUsage } from '@qywork/ai'
import {
  emptyBreakdown,
  emptyOmitted,
  type ProviderRequestContentKind,
  type ProviderRequestDiagnostic,
  type RunId,
  type RunUsage,
} from '@qywork/core'
import type { SummaryTrace } from '../compaction.ts'
import { envelopeHashOf, mergeUsage, payloadSnapshotOf, requestConfiguration } from './request.ts'
import type { LoopPersistence } from './types.ts'

type SummaryPersistence = Pick<
  LoopPersistence,
  | 'openRequest'
  | 'markRequestSent'
  | 'markRequestHeaders'
  | 'markRequestFirstEvent'
  | 'markRequestContent'
  | 'recordRequestDiagnostic'
  | 'settleRequest'
  | 'saveUsage'
>

export function createSummaryTrace(
  persist: SummaryPersistence,
  runId: RunId,
  turnIndex: number,
  adapter: LlmAdapter,
  usage: RunUsage,
  providerName?: string,
): SummaryTrace & { opened: boolean; merged: boolean } {
  let requestAdapter = adapter
  const trace = {
    opened: false,
    merged: false,
    open: (req: ChatRequest, actualAdapter = adapter): string => {
      requestAdapter = actualAdapter
      const density = actualAdapter.spec.density
      trace.opened = true
      const payload = payloadSnapshotOf(req)
      return persist.openRequest({
        runId,
        turnIndex,
        retryIndex: 0,
        purpose: 'summary',
        ...(providerName ? { providerName } : {}),
        providerKind: actualAdapter.kind,
        model: req.model,
        configuration: requestConfiguration(req, actualAdapter),
        measuredInputTokens: estimateRequest(req, density),
        sentCategories: emptyBreakdown(),
        omittedCategories: emptyOmitted(),
        payloadHash: payload.hash,
        requestBytes: payload.bytes,
        cacheRouteFingerprint: envelopeHashOf(req),
      })
    },
    sent: (requestId: string): void => persist.markRequestSent(requestId),
    headers: (requestId: string, at: number): void => persist.markRequestHeaders?.(requestId, at),
    firstEvent: (requestId: string): void => persist.markRequestFirstEvent?.(requestId),
    content: (requestId: string, at: number, kind?: ProviderRequestContentKind): void =>
      persist.markRequestContent?.(requestId, at, kind, false),
    diagnostic: (requestId: string, diagnostic: ProviderRequestDiagnostic): void =>
      persist.recordRequestDiagnostic?.(requestId, diagnostic),
    settle: (
      requestId: string,
      status: 'received' | 'uncertain' | 'rejected',
      u: ProviderUsage | null,
      errorCode: string | null,
      finishReason?: string,
      errorMessage?: string | null,
    ): void => {
      if (u) {
        mergeUsage(usage, u, requestAdapter, turnIndex)
        persist.saveUsage(runId, usage)
        trace.merged = true
      }
      persist.settleRequest(requestId, status, u, errorCode, finishReason, errorMessage)
    },
  }
  return trace
}
