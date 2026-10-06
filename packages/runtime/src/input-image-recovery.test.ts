/**
 * 工具返回的图片在下一次请求被拒绝之后能否重新发送给模型。
 *
 * 覆盖范围：`agent/loop/index.ts` 的媒体保留与换出（`loop/request.ts` 的 `evictedMedia`：
 * 最后一条 assistant 之后的媒体不换出）、`runtime/transcript.ts` 将执行记录投影为 history；
 * 经 `@qywork/ai` 的三协议故障端点发送真实 HTTP 请求，使用真实 `Store`。
 *
 * 原始失败形状：工具成功之后的请求因 503 耗尽重试预算，在新 run 中携带 history 继续执行时，
 * 图片被视为旧图而省略，模型在没有观察结果的情况下继续操作。断言针对实际发出的请求体。
 */

import { expect, test } from 'bun:test'
import { AgentLoop, type LoopPersistence, type ToolContextBase, ToolRegistry } from '@qywork/agent'
import type { WireMessage } from '@qywork/ai'
import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import {
  FAULT_PROTOCOLS,
  type FaultServer,
  faultBaseUrl,
  withFault,
} from '@qywork/ai/fault-server.test-helper'
import type { ConversationId, ProviderRequest, RunId, StepId, WorkspaceId } from '@qywork/core'
import {
  appendStep,
  appendTextToStep,
  createConversation,
  createRun,
  failThinkingSteps,
  listProviderRequests,
  listSteps,
  markProviderRequestSent,
  markStepExecuting,
  openProviderRequest,
  Store,
  settleProviderRequest,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { stepsToUnits } from './transcript.ts'

/** 工具返回的图片字节。在请求体中直接查找该字节串，不按协议解析结构。 */
const BYTES = 'IMGONE'

interface Harness {
  store: Store
  workspaceId: WorkspaceId
  conversationId: ConversationId
  persist: LoopPersistence
}

function harness(): Harness {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws-images', 'ws-images')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'fault', model: 'm' })
  const seqByRun = new Map<string, number>()
  const persist: LoopPersistence = {
    nextSeq: (runId) => {
      const next = (seqByRun.get(runId) ?? 0) + 1
      seqByRun.set(runId, next)
      return next
    },
    landUserStep: (runId, seq, input) =>
      appendStep(store, { runId, seq, kind: 'user', content: input.text }).id,
    openTextStep: (runId, seq, batchId) =>
      appendStep(store, { runId, seq, kind: 'text', content: '', providerBatchId: batchId }).id,
    openThinkingStep: (runId, seq, batchId) =>
      appendStep(store, { runId, seq, kind: 'thinking', content: '', providerBatchId: batchId }).id,
    failThinkingSteps: (ids) => failThinkingSteps(store, ids as never),
    appendText: (stepId, delta) => appendTextToStep(store, stepId as StepId, delta),
    openToolStep: (runId, seq, call, batchId, callIndex, waveIndex, action) =>
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
        payload: { kind: 'tool_call', args: call.arguments, action },
      }).id,
    markExecuting: (stepId) => markStepExecuting(store, stepId as StepId),
    settleTool: (stepId, status, outcome, args, action, durationMs) =>
      settleToolStep(
        store,
        stepId as StepId,
        status,
        { kind: 'tool_result', args, outcome, action },
        durationMs,
      ),
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: (input) => openProviderRequest(store, input).id,
    markRequestSent: (id) => markProviderRequestSent(store, id as never),
    settleRequest: (id, status, usage, errorCode, finishReason, errorMessage) =>
      settleProviderRequest(
        store,
        id as never,
        status,
        usage,
        errorCode,
        finishReason,
        errorMessage,
      ),
  }
  return { store, workspaceId: ws.id, conversationId: conv.id, persist }
}

function baseCtx(runId: string): ToolContextBase {
  return {
    workspaceRoot: 'C:/ws-images',
    conversationId: 'cv',
    runId,
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    requestPermission: async () => ({ allowed: true }),
  }
}

/** 夹具发起的工具调用固定名为 `echo`；此处令其返回一张图片。 */
function shotRegistry(counter: { runs: number }): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'echo',
    description: '截图。',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    },
    actionKind: 'read',
    objectLabel: '截图',
    category: 'files',
    facet: '测试',
    summary: '测试夹具',
    permissionEffect: 'read',
    fn: async () => {
      counter.runs++
      return {
        status: 'success' as const,
        executed: true,
        message: '截图完成',
        data: { images: [{ data: BYTES, mime: 'image/png' }] },
      }
    },
  })
  return registry
}

function newRun(h: Harness, clientRequestId: string): RunId {
  return createRun(h.store, {
    conversationId: h.conversationId,
    workspaceId: h.workspaceId,
    model: 'm',
    clientRequestId,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

async function drainRun(opts: {
  h: Harness
  runId: RunId
  baseUrl: string
  profile: { kind: (typeof FAULT_PROTOCOLS)[number]['kind']; model: string }
  history: WireMessage[]
  registry: ToolRegistry
}): Promise<void> {
  const loop = new AgentLoop({
    adapter: buildAdapter({ ...opts.profile, apiKey: 'sk-fault', baseUrl: opts.baseUrl }),
    registry: opts.registry,
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: opts.h.persist,
    streamIdleTimeoutMs: 5_000,
    // 退避只会延长测试耗时：本组验证请求体是否包含图片，与等待时长无关。
    sleep: async () => {},
  })
  for await (const _ of loop.run({
    runId: opts.runId,
    history: opts.history,
    signal: new AbortController().signal,
  })) {
    // 断言针对夹具收到的请求体与请求记录。
  }
}

const USER: WireMessage = { role: 'user', content: '截个图', _group: 'historyMessages' }

function turnRows(h: Harness, runId: RunId): ProviderRequest[] {
  return listProviderRequests(h.store, runId).filter((r) => r.purpose === 'turn')
}

for (const { kind, model } of FAULT_PROTOCOLS) {
  /**
   * 最新图片恢复：工具成功 → 下一次请求因 503 耗尽重试预算 → 在新 run 中携带 history 继续执行。
   */
  test(`${kind} 工具成功后请求被拒，跨 run 继续执行时仍带原图且工具只执行一次`, async () => {
    const h = harness()
    const counter = { runs: 0 }
    try {
      await withFault('tool_then_unavailable', async (fault: FaultServer) => {
        const baseUrl = faultBaseUrl(fault, kind)
        const registry = shotRegistry(counter)

        const failed = newRun(h, 'images-failed')
        await drainRun({
          h,
          runId: failed,
          baseUrl,
          profile: { kind, model },
          history: [USER],
          registry,
        })

        // 工具执行一次；其后每一次请求都携带该图片，直到重试预算耗尽。
        expect(counter.runs).toBe(1)
        const failedRows = turnRows(h, failed)
        expect(failedRows.slice(1).every((r) => r.status === 'rejected')).toBe(true)

        // 跨 run 继续执行：history 由执行记录投影得到，该图片从未被对端接收。
        const history = [
          USER,
          ...stepsToUnits(listSteps(h.store, failed)).flatMap((u) => u.messages),
        ]
        fault.mode = 'complete'
        const resumed = newRun(h, 'images-resumed')
        await drainRun({ h, runId: resumed, baseUrl, profile: { kind, model }, history, registry })

        expect(counter.runs).toBe(1)
        const resumedRows = turnRows(h, resumed)
        expect(resumedRows).toHaveLength(1)
        expect(resumedRows[0]!.status).toBe('received')

        // 图片在保留上限以内：之后的 run 仍携带该图片，前缀不变。
        const after = newRun(h, 'images-after')
        await drainRun({ h, runId: after, baseUrl, profile: { kind, model }, history, registry })
        const afterRows = turnRows(h, after)
        expect(afterRows).toHaveLength(1)

        // 实际发出的请求体：调用工具之前的请求不含图片，此后每一次请求都包含该图片。
        const rows = [...failedRows, ...resumedRows, ...afterRows]
        expect(fault.bodies).toHaveLength(rows.length)
        expect(fault.bodies.map((b) => b.includes(BYTES))).toEqual(rows.map((_, i) => i > 0))
      })
    } finally {
      h.store.close()
    }
  }, 30_000)
}
