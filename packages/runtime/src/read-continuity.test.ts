/**
 * 远大于窗口的文件经 AgentLoop 逐段读完：投递额度、部分投递、续读位置、发送前压缩与账本重放的完整链路。
 *
 * 覆盖范围：`agent/loop/tool-wave.ts` 按决策开立额度账目、`agent/loop/compact.ts` 的两个压缩检查点，
 * `tools/files.ts` 的部分投递与 `offset` 续读，`runtime/compaction.ts` 的 `RuntimeCompaction`
 * 在真实 `Store` 上折叠已发送的段落，`runtime/transcript.ts` 的 `stepsToUnits` 重放。
 *
 * 模型由脚本模拟：每轮读取上一段结果中的 `nextOffset` 继续读取，没有时结束。窗口取 32K 合成规格
 * （DeepSeek V4.1 Flash 只有 1M 一档），文件约为窗口的四倍，一轮无法读完，历史必须被折叠。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentLoop,
  type CompactionPort,
  type LoopPersistence,
  type Summarizer,
  softLimit,
  type ToolContextBase,
  ToolRegistry,
  tailRetain,
} from '@qywork/agent'
import {
  type ChatRequest,
  estimateMessages,
  estimateRequest,
  estimateText,
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

/** 读取上一次工具结果中的 `nextOffset`：存在时继续读取，否则结束。 */
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

/** step 与压缩记录都写入真实数据库，使重放能看到压缩记录在 step 序列中的位置。 */
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
    // 请求 id 即工具记录的批次 id：每次请求必须不同，否则所有决策会合并为一个单元。
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
  test('每段都在额度内且全部成功，沿 offset 拼接出完整内容，过程中发生压缩', async () => {
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

    // 窗口无法容纳完整文件：必须折叠已发送的段落，且每一次请求都在窗口之内。
    expect(compactions.count).toBeGreaterThan(0)
    for (const req of seen)
      expect(estimateRequest(req, spec.density)).toBeLessThan(spec.contextWindow)
    expect(softLimit(spec)).toBe(25_600)
  }, 60_000)

  /**
   * 结果在工具侧定稿后写入数据库：重放得到的工具消息与发送给模型的内容逐字相同，
   * 一次决策仍是一个单元（压缩记录未插入同一批次的工具记录之间）。
   */
  test('重放与当轮逐字一致，每次决策一个单元', async () => {
    const { store, run, seen } = await readThrough()
    const units = stepsToUnits(listSteps(store, run.id))
    const replayed = new Map<string, unknown>()
    for (const u of units) {
      const calls = u.messages.flatMap((m) => m.toolCalls ?? [])
      expect(calls.length).toBeLessThanOrEqual(1)
      for (const m of u.messages) if (m.role === 'tool') replayed.set(m.toolCallId ?? '', m.content)
    }
    // 每次决策的结果都出现在紧随其后的请求中（最新单元不会被折叠）。
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

/**
 * 按脚本读取一组文件的模型：取得 `nextOffset` 时继续读取同一文件，否则读取下一个；
 * 从第三个文件起每次响应先输出一段文字（以聊天为主的负载）。每次请求记录本地估算的体积。
 * 返回的输入量为本地估算除以 `ratio`：取 1 时两种计量一致，取 1.7 为 Flash 上读取代码时实测的比值。
 */
function scriptedAdapter(
  window: number,
  plan: string[],
  talk: string,
  sizes: number[],
  ratio = 1,
): LlmAdapter {
  const scriptSpec = { ...flash, contextWindow: window }
  let call = 0
  let next = 0
  return {
    kind: 'openai_chat_completions',
    transmits: { effort: true },
    spec: scriptSpec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      const size = estimateRequest(req, scriptSpec.density)
      sizes.push(size)
      const last = [...req.messages].reverse().find((m) => m.role === 'tool')
      const result = last
        ? (JSON.parse(String(last.content)) as { result?: { nextOffset?: number } }).result
        : undefined
      const args = result?.nextOffset
        ? { path: plan[next - 1]!, offset: result.nextOffset }
        : next < plan.length
          ? { path: plan[next++]! }
          : null
      yield { type: 'request_prepared', measuredInputTokens: size }
      yield { type: 'response_started', headersAt: Date.now() }
      if (args && next > 2) yield { type: 'text_delta', delta: talk, at: Date.now() }
      if (args) {
        yield {
          type: 'tool_calls',
          calls: [{ id: `call_${call++}`, name: 'read_file', arguments: args }],
          at: Date.now(),
        }
      } else {
        yield { type: 'text_delta', delta: '读完了', at: Date.now() }
      }
      yield {
        type: 'usage',
        usage: {
          inputTokens: Math.round(size / ratio),
          outputTokens: 20,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          source: 'provider',
        },
      }
      yield { type: 'done', stopReason: args ? 'tool_use' : 'end_turn', rawStopReason: '' }
    },
  }
}

/** 估算约 `tokens` 的文本文件。 */
function fileOf(tokens: number, tag: string): string {
  const lines: string[] = []
  while (estimateText(lines.join('\n'), flash.density) < tokens) {
    for (let i = 0; i < 200; i++) lines.push(`${tag} ${lines.length} ${'x'.repeat(40)}`)
  }
  return lines.join('\n')
}

async function readScript(window: number, files: { name: string; tokens: number }[], ratio = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-read-script-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  opened.push({ store, content })
  for (const file of files) {
    writeFileSync(
      join(dir, file.name),
      file.tokens > 0 ? fileOf(file.tokens, file.name) : file.name,
    )
  }
  const ws = upsertWorkspace(store, dir, 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const ask = appendMessage(store, {
    conversationId: conv.id,
    role: 'user',
    content: '把这些文件读完',
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
  const sizes: number[] = []
  /*
   * 每次压缩释放的空间：同一份历史在压缩前后的投影体积之差。历史取最近一次装配请求时的版本，
   * 执行工具之前的检查点压缩的正是该版本。
   */
  const port = new RuntimeCompaction({
    store,
    conversationId: conv.id,
    messageIdUpperBound: ask.id as MessageId,
    summarize: async () => '已读过前面的文件。',
  })
  let lastHistory: WireMessage[] = []
  const recoveries: { overLine: boolean; recovered: number }[] = []
  const compaction: CompactionPort = {
    project: (messages) => {
      lastHistory = messages
      return port.project(messages)
    },
    run: async (input) => {
      const before = estimateMessages(port.project(lastHistory), flash.density)
      const outcome = await port.run(input)
      if (outcome.status === 'compacted') {
        recoveries.push({
          overLine: input.occupancy > softLimit({ contextWindow: window }),
          recovered: before - estimateMessages(port.project(lastHistory), flash.density),
        })
      }
      return outcome
    },
  }
  const adapter = scriptedAdapter(
    window,
    files.map((file) => file.name),
    'analysis '.repeat(Math.round(window * 0.0075)),
    sizes,
    ratio,
  )
  const loop = new AgentLoop({
    adapter,
    registry,
    systemPrompt: 'sys',
    persist: persistence(store, { count: 0 }),
    makeToolContext: (runId: string): ToolContextBase => ({
      workspaceRoot: dir,
      conversationId: conv.id,
      runId,
      model: adapter.spec.id,
      contextWindow: window,
      density: adapter.spec.density,
      vision: adapter.spec.vision,
      resources: new Map(),
      state: new Map(),
      sink: new RuntimeSink(store, content, runId as RunId),
      signal: new AbortController().signal,
      requestPermission: async () => ({ allowed: true }),
    }),
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
  // 请求与压缩按 step 序号交错：压缩记录的 seq 位于前后两次请求的工具记录之间。
  const steps = listSteps(store, run.id)
  return { stop, steps, recoveries }
}

/**
 * 占用位于「软阈值 − 尾部保留量」与软阈值之间时，执行工具之前的检查点在每次决策时都会尝试压缩。
 * 若只要存在新的可折叠单元就收纳，每次收纳几乎不释放空间却改写投影，下一次请求仍然变大；
 * 无法收纳时又会写入一连串跳过记录。收纳必须使下一次请求变小，跳过不留记录，读取全部成功。
 */
describe('压缩阈值附近的收纳必须释放空间', () => {
  const tiny = (i: number) => ({ name: `s${i}.txt`, tokens: 0 })
  for (const [label, files] of [
    [
      '聊天为主',
      [
        { name: 'mid.txt', tokens: 40_000 },
        { name: 'big.txt', tokens: 76_000 },
        ...Array.from({ length: 40 }, (_, i) => tiny(i)),
      ],
    ],
    [
      '先读大文件再聊天',
      [
        { name: 'mid.txt', tokens: 2_000 },
        { name: 'big.txt', tokens: 100_000 },
        ...Array.from({ length: 40 }, (_, i) => tiny(i)),
      ],
    ],
  ] as const) {
    test(label, async () => {
      const { stop, steps, recoveries } = await readScript(200_000, [...files])
      expect(stop).toBe('completed')
      for (const s of steps.filter((step) => step.kind === 'tool_action')) {
        expect(s.status).toBe('success')
      }
      // 没有跳过记录：软阈值以下无法收纳时不留记录，本组不涉及越过软阈值的场景。
      for (const s of steps.filter((step) => step.kind === 'compaction')) {
        expect((s.payload as { phase?: string }).phase).toBe('done')
      }
      // 软阈值以下的每次收纳至少释放半份保留量。
      const below = recoveries.filter((r) => !r.overLine)
      expect(below.length).toBeGreaterThan(0)
      for (const r of below) expect(r.recovered).toBeGreaterThanOrEqual(tailRetain(200_000) / 2)
    }, 120_000)
  }
})

/**
 * 读取约为窗口 3 倍的文件：每段读完且模型已查看后，下一次压缩将该段整体收纳，下一段可读满余量。
 * 已查看的超大段整体留在保留尾部时，续读段会大小交替，压缩次数翻倍。
 */
describe('远大于窗口的文件每段都能读满', () => {
  test('只收纳不摘要，各段按行号首尾相接读取到末尾，除最后一段外每段至少占窗口的 40%', async () => {
    const window = 200_000
    const { stop, steps } = await readScript(window, [{ name: 'huge.txt', tokens: 3 * window }])
    expect(stop).toBe('completed')
    const reads = steps
      .filter((s) => s.kind === 'tool_action')
      .map(
        (s) =>
          (
            s.payload as unknown as {
              outcome: {
                status: string
                data: { content: string; startLine: number; endLine: number; totalLines: number }
              }
            }
          ).outcome,
      )
    expect(reads.every((o) => o.status === 'success')).toBe(true)
    for (let i = 1; i < reads.length; i++) {
      expect(reads[i]!.data.startLine).toBe(reads[i - 1]!.data.endLine + 1)
    }
    expect(reads.at(-1)!.data.endLine).toBe(reads.at(-1)!.data.totalLines)
    for (const o of reads.slice(0, -1)) {
      expect(estimateText(o.data.content, flash.density)).toBeGreaterThan(window * 0.4)
    }
    for (const s of steps.filter((step) => step.kind === 'compaction')) {
      expect(s.payload as { phase?: string; summarized?: boolean }).toMatchObject({
        phase: 'done',
        summarized: false,
      })
    }
  }, 120_000)
})

/**
 * 本地估算高于 provider 真值时（实测 Flash 上读取代码约为 1.7 倍），执行工具之前的触发阈值与投递额度必须使用同一
 * 折算比：触发阈值按放大后的比值计算、额度按未放大的比值计算时，余量只够半份保留量而触发阈值尚未达到，压缩之前
 * 多读取的两段被限制为半份保留量的小段。
 */
describe('估算偏高时续读段不受限于半份保留量', () => {
  test('除最后一段外，每段都大于半份保留量', async () => {
    const window = 200_000
    const { stop, steps } = await readScript(
      window,
      [{ name: 'huge.txt', tokens: 3 * window }],
      1.7,
    )
    expect(stop).toBe('completed')
    const reads = steps
      .filter((s) => s.kind === 'tool_action')
      .map(
        (s) =>
          (s.payload as unknown as { outcome: { status: string; data: { content: string } } })
            .outcome,
      )
    expect(reads.every((o) => o.status === 'success')).toBe(true)
    for (const o of reads.slice(0, -1)) {
      expect(estimateText(o.data.content, flash.density)).toBeGreaterThan(tailRetain(window) / 2)
    }
  }, 120_000)
})
