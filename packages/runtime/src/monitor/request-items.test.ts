/**
 * 任一主请求的消息条目重建。
 *
 * 覆盖范围：`monitor/request-items.ts` 的 `requestItems`，`RuntimeCompaction.collectUnits`，store 的 `requestWithPrevious`、
 * `requestBreakdown`、`compactionRecords`，core 的 `alignGroupItems`，以及 server 之外的完整写入链路：`AgentLoop` 经脚本适配器执行两轮，
 * 步骤、请求行（`requestPersistence`）与压缩记录写入真实 `Store`，自动压缩由真实 `RuntimeCompaction` 执行。
 * 每次请求的实际消息由脚本适配器原样记录，与重建结果逐条比较（T7）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentLoop,
  breakdownOf,
  condenseMessage,
  type LoopPersistence,
  type ToolContextBase,
  ToolRegistry,
  unitKey,
} from '@qywork/agent'
import {
  type ChatRequest,
  estimateRequest,
  estimateText,
  type LlmAdapter,
  lookupModel,
  type ProviderEvent,
  type WireMessage,
} from '@qywork/ai'
import {
  type ContextGroup,
  type ConversationId,
  emptyBreakdown,
  emptyOmitted,
  type ProviderRequest,
  type RunId,
  type StepId,
} from '@qywork/core'
import {
  appendMessage,
  appendStep,
  appendTextToStep,
  ContentStore,
  createConversation,
  createRun,
  listProviderRequests,
  listRuns,
  markStepExecuting,
  openProviderRequest,
  recordCompactionStep,
  requestWithPrevious,
  Store,
  settleProviderRequest,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { RuntimeCompaction } from '../compaction.ts'
import type { QyConfig } from '../config.ts'
import { requestPersistence } from '../request-persistence.ts'
import { RuntimeSink } from '../sink.ts'
import { buildHistory } from '../transcript.ts'
import { requestItems } from './request-items.ts'

const flash = lookupModel('deepseek-flash', 'openai_chat_completions')
const spec = { ...flash, contextWindow: 32_000 }
const ENVELOPE: readonly ContextGroup[] = ['systemPrompt', 'systemTools', 'mcpTools']

const config: QyConfig = {
  active: { provider: 'relay', model: 'deepseek-flash' },
  providers: {
    relay: {
      kind: 'openai_chat_completions',
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:9/v1',
      models: { 'deepseek-flash': {} },
    },
  },
}

const opened: { store: Store; content: ContentStore }[] = []
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.content.close()
    o.store.close()
  }
})

/** 估算约 `tokens` 的文本。 */
function textOf(tokens: number, tag: string): string {
  const lines: string[] = []
  while (estimateText(lines.join('\n'), flash.density) < tokens) {
    for (let i = 0; i < 20; i++) lines.push(`${tag} ${lines.length} ${'y'.repeat(40)}`)
  }
  return lines.join('\n')
}

/**
 * 每轮先读取 `reads` 中的文件（每次响应附一段 `talk` 正文），读完后以一段正文结束。
 * 用量的输入量取本地估算，命中与写入未回报。
 */
function scriptedAdapter(
  seen: ChatRequest[],
  plans: { reads: string[]; talk: string }[],
): LlmAdapter {
  let call = 0
  let run = -1
  let next = 0
  return {
    kind: 'openai_chat_completions',
    transmits: { effort: true },
    spec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      const last = req.messages.at(-1)
      // 本轮的第一次请求以用户消息结尾。
      if (last?.role === 'user' && last._step === undefined) {
        run++
        next = 0
      }
      const plan = plans[run]!
      const path = plan.reads[next++]
      const size = estimateRequest(req, spec.density)
      yield { type: 'request_prepared', measuredInputTokens: size }
      yield { type: 'response_started', headersAt: Date.now() }
      yield { type: 'text_delta', delta: path ? plan.talk : `第 ${run + 1} 轮完成`, at: Date.now() }
      if (path) {
        yield {
          type: 'tool_calls',
          calls: [{ id: `call_${call++}`, name: 'read_file', arguments: { path } }],
          at: Date.now(),
        }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: size,
          outputTokens: 30,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          source: 'provider',
        },
      }
      yield { type: 'done', stopReason: path ? 'tool_use' : 'end_turn', rawStopReason: '' }
    },
  }
}

/** 步骤与压缩记录写入真实数据库，请求行经产品的 `requestPersistence` 写入。 */
function persistence(store: Store): LoopPersistence {
  const seqs = new Map<string, number>()
  return {
    ...requestPersistence(store, config),
    nextSeq: (runId) => {
      const seq = (seqs.get(runId) ?? 0) + 1
      seqs.set(runId, seq)
      return seq
    },
    markImagesUndelivered: () => [],
    openTextStep: (runId, s, batchId) =>
      appendStep(store, { runId, seq: s, kind: 'text', content: '', providerBatchId: batchId }).id,
    openThinkingStep: (runId, s, batchId) =>
      appendStep(store, { runId, seq: s, kind: 'thinking', content: '', providerBatchId: batchId })
        .id,
    landUserStep: (runId, s, input) =>
      appendStep(store, {
        runId,
        seq: s,
        kind: 'user',
        content: input.text,
        payload: { kind: 'user', ...(input.notice ? { notice: true as const } : {}) },
      }).id,
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
      ).outcome,
    recordCompaction: (runId, s, payload) =>
      recordCompactionStep(store, runId, s, { kind: 'compaction', ...payload }),
  }
}

/**
 * 两轮的会话：第一轮读取四个约 3,000 token 的文件，正文较短，压缩时收纳工具正文即足够；
 * 第二轮读取十个短文件，每次附约 3,000 token 的正文，再次越过触发线时没有可收纳的正文，只能摘要。
 */
async function conversation() {
  const dir = mkdtempSync(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'request-items-'))
  const store = new Store({ path: join(dir, 'a.sqlite3') })
  const content = new ContentStore(':memory:')
  opened.push({ store, content })
  const big = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
  const small = Array.from({ length: 10 }, (_, i) => `s${i}.txt`)
  for (const name of big) writeFileSync(join(dir, name), textOf(3_000, name))
  for (const name of small) writeFileSync(join(dir, name), `${name} 的内容`)

  const ws = upsertWorkspace(store, dir, 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'relay',
    model: 'deepseek-flash',
  })
  const full = new ToolRegistry()
  registerBuiltinTools(full)
  const registry = new ToolRegistry()
  registry.register(full.get('read_file')!)
  const seen: ChatRequest[] = []
  const adapter = scriptedAdapter(seen, [
    { reads: big, talk: '继续读取下一个文件。' },
    { reads: small, talk: textOf(3_000, '分析') },
  ])

  for (const prompt of ['读取四个大文件', '再读取十个小文件并逐一分析']) {
    const user = appendMessage(store, { conversationId: conv.id, role: 'user', content: prompt })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'deepseek-flash',
      clientRequestId: prompt,
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    })
    const loop = new AgentLoop({
      adapter,
      providerName: 'relay',
      registry,
      systemPrompt: 'sys',
      persist: persistence(store),
      makeToolContext: (runId: string): ToolContextBase => ({
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
      }),
      compaction: new RuntimeCompaction({
        store,
        conversationId: conv.id,
        workspaceRoot: dir,
        messageIdUpperBound: user.id,
        summarize: async () => '已读取并分析前面的文件。',
        preserveAssistantReasoning: true,
      }),
    })
    const history = await buildHistory(store, conv.id, user.id, async (text) => text, {
      preserveAssistantReasoning: true,
    })
    for await (const ev of loop.run({
      compactPercent: 80,
      runId: run.id,
      history,
      userMessageId: user.id,
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') expect(ev.stopReason).toBe('completed')
    }
  }
  const requests = listRuns(store, conv.id)
    .flatMap((run) => listProviderRequests(store, run.id))
    .filter((r) => r.purpose === 'turn')
  expect(requests).toHaveLength(seen.length)
  return { store, dir, conversationId: conv.id, seen, requests }
}

/** 实际请求中带会话位置的消息：单元键、单元内序号、角色与模型可见的字段。 */
function located(messages: readonly WireMessage[]) {
  const counts = new Map<string, number>()
  return messages.flatMap((m) => {
    const key = unitKey(m)
    if (key === null) return []
    const index = counts.get(key) ?? 0
    counts.set(key, index + 1)
    return [{ id: `${key}#${index}`, message: m }]
  })
}

/** 只比较模型可见的字段：缓存断点、分组与批次标记不发送。 */
function visible(m: WireMessage) {
  return {
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls ?? null,
    toolCallId: m.toolCallId ?? null,
  }
}

function itemsOf(store: Store, dir: string, request: ProviderRequest) {
  const target = requestWithPrevious(store, request.id)!
  return requestItems(store, config, dir, target)
}

/** 条目按消息合并：工具结果的两个条目属于同一条消息。 */
function messageIds(items: readonly { id: string; messageId: string | null }[]): string[] {
  return [
    ...new Set(
      items.filter((i) => i.messageId !== null).map((i) => i.id.slice(0, i.id.lastIndexOf(':'))),
    ),
  ]
}

describe('T7：重建结果与实际请求逐条一致', () => {
  test('条目的标识、状态与实际请求逐条一致，对齐之前的合计与请求行分组占用之差在 10% 以内', async () => {
    const { store, dir, conversationId, seen, requests } = await conversation()
    /*
     * 重建所估算的消息即 `collectUnits` 的单元消息（未收纳）或其收纳形式。逐条与实际请求比较，
     * 对齐之前的合计按同一估算函数从这些消息求得。
     */
    const lastRun = listRuns(store, conversationId).at(-1)!
    const raw = new Map<string, WireMessage>(
      new RuntimeCompaction({
        store,
        conversationId,
        workspaceRoot: dir,
        messageIdUpperBound: lastRun.messageIdUpperBound,
        summarize: async () => '',
        preserveAssistantReasoning: flash.chatReasoningProtocol !== 'standard',
      })
        .collectUnits(flash.density)
        .flatMap((unit) => unit.messages.map((m, i) => [`${unit.key}#${i}`, m] as const)),
    )

    let condensed = 0
    let summarized = 0
    for (const [i, request] of requests.entries()) {
      const result = itemsOf(store, dir, request)
      expect(result.boundaryKnown).toBe(true)
      const actual = located(seen[i]!.messages)
      const rebuilt = messageIds(result.items)
      expect(rebuilt).toEqual(actual.map((a) => a.id))

      const states = new Map(
        result.items
          .filter((it) => it.messageId !== null)
          .map((it) => [it.id.slice(0, it.id.lastIndexOf(':')), it.state]),
      )
      let estimate = 0
      for (const { id, message } of actual) {
        const original = raw.get(id)!
        const state = states.get(id)!
        const expected = state === 'condensed' ? condenseMessage(original) : original
        expect(visible(message)).toEqual(visible(expected))
        if (state === 'condensed' && visible(expected).content !== visible(original).content)
          condensed++
        const groups = breakdownOf(
          {
            model: '',
            system: [],
            tools: [],
            messages: [expected],
            maxOutputTokens: null,
            idleTimeoutMs: 0,
          },
          spec.density,
        )
        estimate += Object.values(groups).reduce((n, v) => n + v, 0)
      }
      if (seen[i]!.messages.some((m) => m._group === 'summary')) summarized++

      const recorded = Object.entries(request.sentCategories)
        .filter(([g]) => !ENVELOPE.includes(g as ContextGroup) && g !== 'summary')
        .reduce((n, [, v]) => n + v, 0)
      expect(Math.abs(estimate - recorded)).toBeLessThanOrEqual(recorded * 0.1)

      // 对齐之后：有条目的分组，条目之和等于对账后的分组值。
      for (const group of new Set(result.items.map((it) => it.group))) {
        const sum = result.items
          .filter((it) => it.group === group)
          .reduce((n, it) => n + it.tokens, 0)
        expect(sum).toBe(result.breakdown[group])
      }
    }
    // 会话中两种压缩都发生过：有收纳之后的请求，也有摘要之后的请求。
    expect(condensed).toBeGreaterThan(0)
    expect(summarized).toBeGreaterThan(0)
  }, 60_000)

  test('与上一次请求的条目差等于两次实际请求的消息差；三行取本轮用户消息、新进入内容的名称与本次回复', async () => {
    const { store, dir, seen, requests } = await conversation()
    for (const [i, request] of requests.entries()) {
      const result = itemsOf(store, dir, request)
      if (i === 0) {
        expect(result.diff).toBeNull()
        continue
      }
      const now = located(seen[i]!.messages).map((a) => a.id)
      const before = located(seen[i - 1]!.messages).map((a) => a.id)
      expect(messageIds(result.diff!.added)).toEqual(now.filter((id) => !before.includes(id)))
      expect(messageIds(result.diff!.removed)).toEqual(before.filter((id) => !now.includes(id)))
      // 信封未变化，不出现在条目差中。
      expect(result.diff!.added.every((it) => it.messageId !== null)).toBe(true)
    }

    const last = requests.at(-1)!
    const result = itemsOf(store, dir, last)
    expect(result.userMessage).toBe('再读取十个小文件并逐一分析')
    expect(result.reply).toBe('第 2 轮完成')
    // 最后一次请求之前新进入的是上一次的回复（正文与 read_file 调用）及其工具结果。
    expect(result.entered).toContain('read_file')
    // 第一轮第二次请求之前新进入的是第一次请求的回复与 read_file 的结果。
    const second = itemsOf(store, dir, requests[1]!)
    expect(second.userMessage).toBe('读取四个大文件')
    expect(second.reply).toBe('继续读取下一个文件。')
    expect(second.entered).toBe('继续读取下一个文件。、read_file')
    expect(second.items.filter((it) => it.messageId === null).map((it) => it.label)).toEqual([
      null,
      'read_file',
    ])
  }, 60_000)
})

describe('边界未知与摘要请求', () => {
  function fixture() {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'relay',
      model: 'deepseek-flash',
    })
    const user = appendMessage(store, { conversationId: conv.id, role: 'user', content: '你好' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'deepseek-flash',
      clientRequestId: 'c',
      userMessageId: user.id,
      messageIdUpperBound: user.id,
      contextSnapshot: [],
    })
    let turn = 0
    const open = (purpose: 'turn' | 'summary' = 'turn') => {
      const r = openProviderRequest(store, {
        runId: run.id,
        turnIndex: turn++,
        retryIndex: 0,
        purpose,
        providerName: 'relay',
        providerKind: 'openai_chat_completions',
        model: 'deepseek-flash',
        measuredInputTokens: 50,
        occupancyTokens: 60,
        sentCategories: { ...emptyBreakdown(), historyMessages: 50 },
        omittedCategories: emptyOmitted(),
        payloadHash: 'h',
      })
      settleProviderRequest(store, r.id, 'received', {
        inputTokens: 80,
        outputTokens: 5,
        cachedTokens: null,
        cacheWriteTokens: null,
      })
      return r
    }
    return { store, conversationId: conv.id as ConversationId, runId: run.id, open }
  }

  test('覆盖该请求的压缩记录早于边界字段时 boundaryKnown 为 false，只给分组合计，条目差为 null', () => {
    const { store, runId, open } = fixture()
    try {
      const first = open()
      // 早于边界字段的旧记录：改写了 manifest，但没有 summaryCut 与 condenseCut。
      recordCompactionStep(store, runId, 99, {
        kind: 'compaction',
        phase: 'done',
        manifestRevision: 1,
        compactedMessages: 0,
        summarized: false,
      })
      store.db
        .query("UPDATE steps SET created_at = ? WHERE kind = 'compaction'")
        .run(first.createdAt + 1)
      const second = open()
      store.db
        .query('UPDATE provider_requests SET created_at = ? WHERE id = ?')
        .run(first.createdAt + 2, second.id)

      const before = requestItems(store, config, 'C:/ws', requestWithPrevious(store, first.id)!)
      expect(before.boundaryKnown).toBe(true)
      expect(before.items.map((it) => [it.role, it.state, it.label])).toEqual([
        ['user', 'raw', '你好'],
      ])
      expect(before.items[0]!.tokens).toBe(80)
      expect(before.estimated).toBe(false)

      const after = requestItems(store, config, 'C:/ws', requestWithPrevious(store, second.id)!)
      expect(after.boundaryKnown).toBe(false)
      expect(after.items).toEqual([])
      expect(after.diff).toBeNull()
      expect(after.breakdown.historyMessages).toBe(80)
    } finally {
      store.close()
    }
  })

  test('摘要请求没有上一次主请求；按 id 读取不到时为 null', () => {
    const { store, open } = fixture()
    try {
      open()
      const summary = open('summary')
      const target = requestWithPrevious(store, summary.id)!
      expect(target.request.purpose).toBe('summary')
      expect(target.previous).toBeNull()
      expect(requestWithPrevious(store, 'pr_missing' as never)).toBeNull()
    } finally {
      store.close()
    }
  })
})
