/**
 * 主请求与摘要请求共用的账本边界，错误文本在此处脱敏。
 * 主请求的信封明细与请求行在同一事务中写入，任一写入失败时两者一并回滚并上抛。
 */
import type { LoopPersistence } from '@qywork/agent'
import {
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestHedge,
  markProviderRequestSent,
  openProviderRequest,
  recordProviderRequestDiagnostic,
  type Store,
  saveRequestEnvelope,
  settleProviderRequest,
  updateRunUsage,
} from '@qywork/store'
import { redactSecrets } from '@qywork/tools'
import { collectSecrets, type QyConfig } from './config.ts'

export function requestPersistence(store: Store, config: QyConfig) {
  const clean = (value: string) => redactSecrets(value, collectSecrets(config))
  return {
    openRequest: ({ envelopeItems, ...input }) =>
      store.tx(() => {
        const id = openProviderRequest(store, input).id
        if (envelopeItems) saveRequestEnvelope(store, input.cacheRouteFingerprint, envelopeItems)
        return id
      }),
    saveUsage: (runId, usage) => updateRunUsage(store, runId, usage),
    markRequestSent: (id) => markProviderRequestSent(store, id as never),
    markRequestHeaders: (id, at, cloudRequestId) =>
      markProviderRequestHeaders(store, id as never, at, cloudRequestId),
    markRequestHedge: (id, hedge) => markProviderRequestHedge(store, id as never, hedge),
    markRequestFirstEvent: (id) => markProviderRequestFirstEvent(store, id as never),
    markRequestContent: (id, at, kind, visible) =>
      markProviderRequestContent(store, id as never, at, kind, visible),
    settleRequest: (id, status, usage, errorCode, finishReason, errorMessage, anchored) =>
      settleProviderRequest(
        store,
        id as never,
        status,
        usage,
        errorCode,
        finishReason,
        errorMessage == null ? null : clean(errorMessage),
        anchored,
      ),
    recordRequestDiagnostic: (id, diagnostic) =>
      recordProviderRequestDiagnostic(store, id as never, {
        ...diagnostic,
        ...(diagnostic.provider
          ? {
              provider: {
                status: diagnostic.provider.status,
                code: diagnostic.provider.code === null ? null : clean(diagnostic.provider.code),
                type: diagnostic.provider.type === null ? null : clean(diagnostic.provider.type),
                param: diagnostic.provider.param === null ? null : clean(diagnostic.provider.param),
              },
            }
          : {}),
        causes: diagnostic.causes.map((cause) => ({
          name: clean(cause.name),
          code: cause.code === null ? null : clean(cause.code),
          message: clean(cause.message),
        })),
      }),
  } satisfies Pick<
    LoopPersistence,
    | 'openRequest'
    | 'saveUsage'
    | 'markRequestSent'
    | 'markRequestHeaders'
    | 'markRequestHedge'
    | 'markRequestFirstEvent'
    | 'markRequestContent'
    | 'settleRequest'
    | 'recordRequestDiagnostic'
  >
}
