/**
 * 远大于窗口的文件经 AgentLoop 逐段读完：投递额度、部分投递、续读位置、发送前压缩与落账重放的整条链路。
 *
 * **覆盖范围**：`agent/loop/tool-wave.ts` 的按决策开账与 `agent/loop/compact.ts` 的两个压缩检查点，
 * `tools/files.ts` 的部分投递与 `offset` 续读，`runtime/compaction.ts` 的 `RuntimeCompaction`
 * 在真实 `Store` 上折叠已发送的段落，`runtime/transcript.ts` 的 `stepsToUnits` 重放。
 *
 * 模型由脚本扮演：每轮读上一段结果里的 `nextOffset` 接着读，没有就收尾。窗口取 32K 合成规格
 * （DeepSeek V4.1 Flash 只有 1M 一档），文件约为窗口的四倍，一轮读不完、历史必须被折叠。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentLoop,
  type LoopPersistence,
  type Summarizer,
  softLimit,
  type ToolContextBase,
  ToolRegistry,
} from '@qywork/agent'
import {
  type ChatRequest,
  estimateRequest,
  type LlmAdapter,
  lookupModel,
  type ProviderEvent,
  type WireMessage,
} from '@qywork/ai'
import type { MessageId, RunId, StepId } from '@qywork/core'
import {
  appendMessage,
  appendStep,
  appendTextToStep,
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  listMessages,
  listSteps,
  markStepExecuting,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { RuntimeCompaction } from './compaction.ts'
import { RuntimeSink } from './sink.ts'
import { stepsToUnits } from './transcript.ts'

const flash = lookupModel('deepseek-flash', 'openai_chat_completions')
const spec = { ...flash, contextWindow: 32_000 }
const LINES = 6_000

const opened: { store: Store; content: ContentStore }[] = []
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.content.close()
    o.store.close()
  }
})

/** 读上一次工具结果里的 `nextOffset`：有就接着读，没有就收尾。 */
function readerAdapter(seen: ChatRequest[]): LlmAdapter {
  let call = 0
  return {
    kind: 'openai_chat_completions',
    transmits: { effort: true },
    spec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      const last = [...req.messages].reverse().find((m) => m.role === 'tool')
      const result = last
        ? (JSON.parse(String(last.content)) as { result?: { nextOffset?: number } }).result
        : undefined
      const done = last !== undefined && result?.nextOffset === undefined
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, spec.density) }
      yield { type: 'response_started', headersAt: Date.now() }
      if (done) {
        yield { type: 'text_delta', delta: '读完了', at: Date.now() }
      } else {
        const args = result?.nextOffset
          ? { path: 'big.txt', offset: result.nextOffset }
          : { path: 'big.txt' }
        yield {
          type: 'tool_calls',
          calls: [{ id: `call_${call++}`, name: 'read_file', arguments: args }],
          at: Date.now(),
        }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: estimateRequest(req, spec.density),
          outputTokens: 20,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          source: 'provider',
        },
      }
      yield { type: 'done', stopReason: done ? 'end_turn' : 'tool_use', rawStopReason: '' }
    },
  }
}

/** step 落进真库，压缩记录也落，这样重放能看到它在 step 序列里的位置。 */
function persistence(store: Store, compactions: { count: number }): LoopPersistence {
  let seq = 0
  let requests = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: (runId, s, batchId) =>
      appendStep(store, { runId, seq: s, kind: 'text', content: '', providerBatchId: batchId }).id,
    openThinkingStep: (runId, s, batchId) =>
      appendStep(store, { runId, seq: s, kind: 'thinking', content: '', providerBatchId: batchId })
        .id,
    landUserStep: (runId, s, input) =>
      appendStep(store, { runId, seq: s, kind: 'user', content: input.text }).id,
    failThinkingSteps: () => {},
    appendText: (stepId, delta) => appendTextToStep(store, stepId as StepId, delta),
    openToolStep: (runId, s, call, batchId, callIndex, waveIndex, action) =>
      appendStep(store, {
        runId,
        seq: s,
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
    recordCompaction: (runId, s, payload) => {
      if (payload.phase === 'done') compactions.count++
      appendStep(store, {
        runId,
        seq: s,
        kind: 'compaction',
        status: payload.phase === 'done' ? 'success' : 'failure',
        payload: { kind: 'compaction', ...payload },
      })
    },
    // 请求 id 就是工具记录的批次 id：每次请求必须不同，否则所有决策会合成一个单元。
    openRequest: () => `pr_${++requests}`,
    markRequestSent: () => {},
    settleRequest: () => {},
  }
}

async function readThrough() {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-read-continuity-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  opened.push({ store, content })
  const lines = Array.from({ length: LINES }, (_, i) => `line ${i} ${'x'.repeat(30)}`)
  writeFileSync(join(dir, 'big.txt'), lines.join('\n'))

  const ws = upsertWorkspace(store, dir, 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const ask = appendMessage(store, {
    conversationId: conv.id,
    role: 'user',
    content: '把 big.txt 读完',
  })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'c1',
    userMessageId: ask.id,
    messageIdUpperBound: ask.id,
    contextSnapshot: [],
  })

  const full = new ToolRegistry()
  registerBuiltinTools(full)
  const registry = new ToolRegistry()
  registry.register(full.get('read_file')!)

  const summarize: Summarizer = async () => '已读过 big.txt 的前面几段。'
  const compaction = new RuntimeCompaction({
    store,
    conversationId: conv.id,
    messageIdUpperBound: ask.id as MessageId,
    summarize,
  })
  const compactions = { count: 0 }
  const seen: ChatRequest[] = []
  const makeToolContext = (runId: string): ToolContextBase => ({
    workspaceRoot: dir,
    conversationId: conv.id,
    runId,
    model: spec.id,
    contextWindow: spec.contextWindow,
    density: spec.density,
    vision: spec.vision,
    resources: new Map(),
    state: new Map(),
    sink: new RuntimeSink(store, content, runId as RunId),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allowed: true }),
  })
  const loop = new AgentLoop({
    adapter: readerAdapter(seen),
    registry,
    systemPrompt: 'sys',
    persist: persistence(store, compactions),
    makeToolContext,
    compaction,
  })
  const history: WireMessage[] = listMessages(store, conv.id, null).map((m) => ({
    role: m.role,
    content: m.content,
    _messageId: m.id,
  }))
  let stop = ''
  for await (const ev of loop.run({
    runId: run.id,
    history,
    userMessageId: ask.id,
    signal: new AbortController().signal,
  })) {
    if (ev.type === 'run.finished') stop = ev.stopReason
  }
  return { store, run, lines, seen, compactions, stop }
}

describe('远大于窗口的文件逐段读完', () => {
  test('每段都在额度内、全部成功，沿 offset 拼回整份，过程中发生压缩', async () => {
    const { store, run, lines, seen, compactions, stop } = await readThrough()
    expect(stop).toBe('completed')

    const reads = listSteps(store, run.id).filter((s) => s.kind === 'tool_action')
    const outcomes = reads.map(
      (s) =>
        (s.payload as unknown as { outcome: { status: string; data: { content: string } } })
          .outcome,
    )
    // 没有失败回合：每一轮都投递了有效正文。
    expect(outcomes.every((o) => o.status === 'success')).toBe(true)
    expect(reads.length).toBeGreaterThan(2)

    const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join('\n')
    expect(outcomes.map((o) => o.data.content).join('\n')).toBe(numbered)

    // 窗口装不下整份：必须折叠已发送的段落，而每一次请求都在窗口之内。
    expect(compactions.count).toBeGreaterThan(0)
    for (const req of seen)
      expect(estimateRequest(req, spec.density)).toBeLessThan(spec.contextWindow)
    expect(softLimit(spec)).toBe(25_600)
  }, 60_000)

  /**
   * 结果在工具侧定稿后落库：重放出来的工具消息与发给模型的那一份逐字相同，
   * 一次决策仍是一个单元（压缩记录没有夹进同一批次的工具记录之间）。
   */
  test('重放与当轮逐字同形，每次决策一个单元', async () => {
    const { store, run, seen } = await readThrough()
    const units = stepsToUnits(listSteps(store, run.id))
    const replayed = new Map<string, unknown>()
    for (const u of units) {
      const calls = u.messages.flatMap((m) => m.toolCalls ?? [])
      expect(calls.length).toBeLessThanOrEqual(1)
      for (const m of u.messages) if (m.role === 'tool') replayed.set(m.toolCallId ?? '', m.content)
    }
    // 每次决策的结果都出现在紧接着的那一次请求里（最新单元不会被折叠）。
    let checked = 0
    for (const req of seen) {
      const last = [...req.messages].reverse().find((m) => m.role === 'tool')
      if (!last) continue
      expect(last.content).toBe(replayed.get(last.toolCallId ?? '') as string)
      checked++
    }
    expect(checked).toBe(replayed.size)
  }, 60_000)
})
