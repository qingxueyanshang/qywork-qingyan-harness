/**
 * 生成边界：一次请求产出的正文、思考与工具调用共用一个 `provider_batch_id`，
 * 投影在归属变化处把消息切开。
 *
 * 覆盖范围：`agent/loop/` 的批次 id 取值（`openTextStep` / `openThinkingStep` /
 * `openToolStep` 都写本次 `openRequest` 的返回值）与 `runtime/transcript.ts` 的
 * `stepsToUnits` 切分；经 `@qywork/ai` 的三协议故障端点跑真实 HTTP，step 与请求账
 * 落真实 `Store`。
 *
 * 判据是**活侧与投影送上线的字节一致**：先让一次终态前 EOF 产生 `[A]`、`[B+工具]`
 * 两条消息，再把投影当作下一个 run 的 history 发一次，比较两次请求体里的消息数组。
 * 只数单元条数会放过「切对了但正文错位」这一类。
 */

import { expect, test } from 'bun:test'
import { AgentLoop, type LoopPersistence, type ToolContextBase, ToolRegistry } from '@qywork/agent'
import type { WireMessage } from '@qywork/ai'
import { buildAdapter, DEFAULT_DENSITY } from '@qywork/ai'
import { FAULT_PROTOCOLS, faultBaseUrl, withFault } from '@qywork/ai/fault-server.test-helper'
import type { ConversationId, RunId, StepId, WorkspaceId } from '@qywork/core'
import {
  appendStep,
  appendTextToStep,
  createConversation,
  createRun,
  failThinkingSteps,
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

interface Harness {
  store: Store
  workspaceId: WorkspaceId
  conversationId: ConversationId
  persist: LoopPersistence
}

function harness(): Harness {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws-boundary', 'ws-boundary')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fault',
    model: 'm',
  })
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
    openThinkingStep: (runId, seq, batchId, reasoning) =>
      appendStep(store, {
        runId,
        seq,
        kind: 'thinking',
        content: '',
        providerBatchId: batchId,
        ...(reasoning ? { payload: { kind: 'response_reasoning', reasoning } as const } : {}),
      }).id,
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

function baseCtx(runId: string): ToolContextBase {
  return {
    workspaceRoot: 'C:/ws-boundary',
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

function echoRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'echo',
    description: '回声。',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    },
    actionKind: 'read',
    objectLabel: '回声',
    category: 'files',
    facet: '测试',
    summary: '测试夹具',
    permissionEffect: 'read',
    fn: async () => ({ status: 'success' as const, executed: true, message: '回声完成' }),
  })
  return registry
}

/** 三条协议的请求体各自把消息放在 `messages` 或 `input` 下。 */
function wireMessagesOf(body: string): unknown[] {
  const parsed = JSON.parse(body) as { messages?: unknown[]; input?: unknown[] }
  return parsed.messages ?? parsed.input ?? []
}

async function drainRun(
  h: Harness,
  runId: RunId,
  baseUrl: string,
  profile: { kind: (typeof FAULT_PROTOCOLS)[number]['kind']; model: string },
  history: WireMessage[],
): Promise<void> {
  const loop = new AgentLoop({
    adapter: buildAdapter({ ...profile, apiKey: 'sk-fault', baseUrl }),
    registry: echoRegistry(),
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist: h.persist,
    streamIdleTimeoutMs: 5_000,
    // 退避在这里只会拖长测试：本组问的是消息边界，不是等待时长。
    sleep: async () => {},
  })
  for await (const _ of loop.run({ runId, history, signal: new AbortController().signal })) {
    // 事件在别处断言；这里只要跑完。
  }
}

for (const { kind, model } of FAULT_PROTOCOLS) {
  /**
   * T13 生成边界：正文 A 之后终态前 EOF，带上下文续发拿到 B + 工具调用。
   * 活侧是 `[A]`、`[B+工具]` 两条，投影必须切在同一处。
   */
  test(`${kind} 断流续发后投影与活侧的消息边界一致`, async () => {
    const h = harness()
    try {
      await withFault('eof_before_terminal_then_tool', async (fault) => {
        const baseUrl = faultBaseUrl(fault, kind)
        const first = newRun(h, 'boundary-first')
        await drainRun(h, first, baseUrl, { kind, model }, [])

        const units = stepsToUnits(listSteps(h.store, first))
        // A 自成一条：正文不带工具调用，工具批次另起一条。
        expect(units).toHaveLength(3)
        expect(units[0]!.messages).toHaveLength(1)
        expect(units[0]!.messages[0]!.content).toBe('完成')
        expect(units[0]!.messages[0]!.toolCalls).toBeUndefined()
        expect(units[1]!.messages[0]!.content).toBe('')
        expect(units[1]!.messages[0]!.toolCalls?.map((c) => c.name)).toEqual(['echo'])
        expect(units[1]!.messages[1]!.role).toBe('tool')
        expect(units[1]!.messages[1]!.toolCallId).toBe(units[1]!.messages[0]!.toolCalls![0]!.id)

        // 第三次请求的请求体就是活侧的 `[A][B+工具][结果]`。
        expect(fault.bodies).toHaveLength(3)
        const live = wireMessagesOf(fault.bodies[2]!)

        const replayed = newRun(h, 'boundary-replayed')
        await drainRun(
          h,
          replayed,
          baseUrl,
          { kind, model },
          units.slice(0, 2).flatMap((u) => u.messages),
        )
        expect(fault.bodies).toHaveLength(4)
        expect(wireMessagesOf(fault.bodies[3]!)).toEqual(live)
      })
    } finally {
      h.store.close()
    }
  }, 30_000)
}
