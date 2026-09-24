/**
 * 工具图片在「下一次请求被回绝」之后还能不能回到模型面前。
 *
 * 覆盖范围：`agent/loop.ts` 的图片裁剪与 `openStream` 的输入引用确认、
 * `store/repos.ts` 的 `markProviderRequestInputImages` /
 * `hasReceivedRequestWithImages`、`runtime/transcript.ts` 把执行记录投影回 history，
 * 经 `@qywork/ai` 的三协议故障端点跑真实 HTTP、真实 `Store`。
 *
 * 原始失败形状：工具成功之后那次请求 503 耗尽预算，换一个 run 带着 history 续跑时
 * 图片按「旧轮次」被省略，模型在没有观察结果的情况下接着做。
 * 裁剪判据与请求体逐一对照——只断言「有没有写引用」会放过「引用写了但图没发出去」。
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
  hasReceivedRequestWithImages,
  listProviderRequests,
  listSteps,
  markProviderRequestInputImages,
  markProviderRequestSent,
  markStepExecuting,
  openProviderRequest,
  Store,
  settleProviderRequest,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { stepsToUnits } from './transcript.ts'

/** 工具回传的图片字节。请求体里直接按它找，不逐协议解析结构。 */
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
    markRequestInputImages: (id, batchId) =>
      markProviderRequestInputImages(store, id as never, batchId),
    inputImagesConsumed: (batchId) => hasReceivedRequestWithImages(store, conv.id, batchId),
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

/** 夹具那一头的工具调用恒名 `echo`；这里让它回一张图。 */
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
    // 退避在这里只会拖长测试：本组问的是请求体里有没有图，不是等了多久。
    sleep: async () => {},
  })
  for await (const _ of loop.run({
    runId: opts.runId,
    history: opts.history,
    signal: new AbortController().signal,
  })) {
    // 断言落在夹具收到的请求体与请求账上。
  }
}

const USER: WireMessage = { role: 'user', content: '截个图', _group: 'historyMessages' }

function turnRows(h: Harness, runId: RunId): ProviderRequest[] {
  return listProviderRequests(h.store, runId).filter((r) => r.purpose === 'turn')
}

for (const { kind, model } of FAULT_PROTOCOLS) {
  /**
   * T13 最新图片恢复：工具成功 → 下一次请求 503 耗尽预算 → 换一个 run 带 history 续跑。
   */
  test(`${kind} 工具成功后请求被拒，跨 run 续跑仍带原图且工具只跑一次`, async () => {
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

        // 工具跑了一次；其后每一次请求都带着那张图，直到预算耗尽。
        expect(counter.runs).toBe(1)
        const failedRows = turnRows(h, failed)
        expect(failedRows[0]!.inputImageBatchId).toBeNull()
        const batch = failedRows[1]!.inputImageBatchId
        expect(batch).toBe(failedRows[0]!.id)
        expect(failedRows.slice(1).every((r) => r.status === 'rejected')).toBe(true)
        expect(failedRows.slice(1).every((r) => r.inputImageBatchId === batch)).toBe(true)

        // 跨 run 续跑：history 由执行记录投影而来，那张图从来没被对端接收过。
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
        expect(resumedRows[0]!.inputImageBatchId).toBe(batch)

        // 这一次真的被接收了，再往后的请求按信封省略。
        const after = newRun(h, 'images-after')
        await drainRun({ h, runId: after, baseUrl, profile: { kind, model }, history, registry })
        const afterRows = turnRows(h, after)
        expect(afterRows).toHaveLength(1)
        expect(afterRows[0]!.inputImageBatchId).toBeNull()

        // 引用与线上那份字节逐一对应：写了引用的必须带图，没写的必须不带。
        const rows = [...failedRows, ...resumedRows, ...afterRows]
        expect(fault.bodies).toHaveLength(rows.length)
        expect(rows.map((r) => r.inputImageBatchId !== null)).toEqual(
          fault.bodies.map((b) => b.includes(BYTES)),
        )
      })
    } finally {
      h.store.close()
    }
  }, 30_000)
}
