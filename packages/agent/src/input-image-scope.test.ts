/**
 * 工具图片带进哪一次请求，以及这一次有没有真的带上。
 *
 * 覆盖范围：`loop.ts` 的 `buildRequest` 图片裁剪（最近待续批次、已消费批次、更早批次）
 * 与 `openStream` 里的输入引用确认（`LoopPersistence.markRequestInputImages` /
 * `inputImagesConsumed`），以及它们与 `materialize` 能力过滤、`compaction.ts` 收纳的
 * 先后关系。
 *
 * 断言落在**适配器实际收到的那份请求**上：裁剪、投影、能力过滤三道都在它之前，
 * 只看装配中间结果会把「模型不收图、图被换成文字注记」这一支放过去。
 * 三协议序列化不丢图由 `runtime/input-image-recovery.test.ts` 用真实 HTTP 锁。
 */

import { expect, test } from 'bun:test'
import type { ChatRequest, ContentBlock, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateRequest, lookupModel } from '@qywork/ai'
import { condenseMessage } from './compaction.ts'
import type { LoopPersistence } from './loop.ts'
import { AgentLoop } from './loop.ts'
import type { ToolContextBase } from './registry.ts'
import { ToolRegistry } from './registry.ts'

interface Ledger {
  persist: LoopPersistence
  /** 请求 id → 本次输入完整携带的图片批次。 */
  references: Map<string, string>
  /** 请求 id → 终态。 */
  settled: Map<string, string>
  /** 预置一行「已接收且携过这批图」的请求，模拟更早的成功往返。 */
  seed(batchId: string): void
}

function ledger(): Ledger {
  let requests = 0
  const references = new Map<string, string>()
  const settled = new Map<string, string>()
  const consumed = (batchId: string): boolean =>
    [...references].some(([id, b]) => b === batchId && settled.get(id) === 'received')
  let seq = 0
  const persist: LoopPersistence = {
    nextSeq: () => ++seq,
    landUserStep: () => `st_user_${seq}`,
    openTextStep: () => `st_text_${seq}`,
    openThinkingStep: () => `st_think_${seq}`,
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: () => `st_tool_${seq}`,
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: () => `pr_${++requests}`,
    markRequestSent: () => {},
    markRequestInputImages: (requestId, batchId) => {
      references.set(requestId, batchId)
    },
    inputImagesConsumed: consumed,
    settleRequest: (requestId, status) => {
      settled.set(requestId, status)
    },
  }
  return {
    persist,
    references,
    settled,
    seed: (batchId) => {
      const id = `pr_seed_${batchId}`
      references.set(id, batchId)
      settled.set(id, 'received')
    },
  }
}

/** 一轮就结束的假适配器，把它收到的那份请求原样留下。 */
function capturingAdapter(opts: { vision: boolean | null } = { vision: true }): LlmAdapter & {
  seen: ChatRequest[]
} {
  const base = lookupModel('claude-opus-5', 'anthropic_messages')
  const seen: ChatRequest[] = []
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: { ...base, vision: opts.vision },
    seen,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, base.density) }
      yield { type: 'text_delta', delta: '完成', at: Date.now() }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
  }
}

function baseCtx(runId: string): ToolContextBase {
  return {
    workspaceRoot: '/tmp',
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

function envelopeOf(callId: string): string {
  return JSON.stringify({
    call_id: callId,
    tool: 'screenshot',
    status: 'success',
    executed: true,
    summary: '截图完成',
  })
}

/** 一条带图的工具结果，形状与活侧 `toolResultContent` 的产物相同。 */
function shot(callId: string, batchId: string | null, bytes: string): WireMessage {
  const content: ContentBlock[] = [
    { type: 'text', text: envelopeOf(callId) },
    { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: bytes } },
  ]
  return {
    role: 'tool',
    toolCallId: callId,
    content,
    _group: 'executionRecords',
    ...(batchId === null ? {} : { _batch: batchId }),
  }
}

function callsMessage(batchId: string | null, callIds: string[]): WireMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: callIds.map((id) => ({ id, name: 'screenshot', arguments: {} })),
    _group: 'executionRecords',
    ...(batchId === null ? {} : { _batch: batchId }),
  }
}

/** 一批双图的工具波次。 */
function wave(batchId: string, prefix: string): WireMessage[] {
  return [
    callsMessage(batchId, [`${prefix}_1`, `${prefix}_2`]),
    shot(`${prefix}_1`, batchId, `${prefix.toUpperCase()}A`),
    shot(`${prefix}_2`, batchId, `${prefix.toUpperCase()}B`),
  ]
}

async function askOnce(
  adapter: LlmAdapter,
  persist: LoopPersistence,
  history: WireMessage[],
  runId: string,
  compaction?: { project: (m: WireMessage[]) => WireMessage[] },
): Promise<void> {
  const loop = new AgentLoop({
    adapter,
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    makeToolContext: baseCtx,
    persist,
    ...(compaction
      ? {
          compaction: {
            project: compaction.project,
            run: async () => ({ status: 'skipped' as const, reasonCode: 'nothing_to_fold' }),
          },
        }
      : {}),
  })
  for await (const _ of loop.run({
    runId: runId as never,
    history,
    signal: new AbortController().signal,
  })) {
    // 断言落在适配器收到的请求上。
  }
}

function imagesIn(req: ChatRequest | undefined): string[] {
  const out: string[] = []
  for (const m of req?.messages ?? []) {
    if (typeof m.content === 'string') continue
    for (const b of m.content) {
      if (b.type === 'image' && b.source.kind === 'base64') out.push(b.source.data)
    }
  }
  return out
}

const USER: WireMessage = { role: 'user', content: '看一下', _group: 'historyMessages' }

test('最近一批尚未送达的工具图片整批进请求，引用记在这一行上', async () => {
  const l = ledger()
  const adapter = capturingAdapter()
  await askOnce(adapter, l.persist, [USER, ...wave('pr_gen', 'shot')], 'rn_keep')

  expect(imagesIn(adapter.seen[0])).toEqual(['SHOTA', 'SHOTB'])
  expect(l.references.get('pr_1')).toBe('pr_gen')
  expect(l.settled.get('pr_1')).toBe('received')
})

test('这批图被一次已接收的请求带过之后，下一次换成 images_omitted 信封', async () => {
  const l = ledger()
  l.seed('pr_gen')
  const adapter = capturingAdapter()
  await askOnce(adapter, l.persist, [USER, ...wave('pr_gen', 'shot')], 'rn_consumed')

  expect(imagesIn(adapter.seen[0])).toEqual([])
  const tools = (adapter.seen[0]?.messages ?? []).filter((m) => m.role === 'tool')
  expect(tools).toHaveLength(2)
  for (const t of tools) {
    expect(JSON.parse(String(t.content))).toMatchObject({ images_omitted: true })
  }
  // 没带图就不写引用：这一行答的是「本次输入携带了什么」。
  expect(l.references.has('pr_1')).toBe(false)
})

test('更早的批次一律省略，只留最近待续的那一批', async () => {
  const l = ledger()
  const adapter = capturingAdapter()
  await askOnce(
    adapter,
    l.persist,
    [USER, ...wave('pr_old', 'first'), ...wave('pr_new', 'second')],
    'rn_scope',
  )

  expect(imagesIn(adapter.seen[0])).toEqual(['SECONDA', 'SECONDB'])
  expect(l.references.get('pr_1')).toBe('pr_new')
})

/**
 * 能力过滤把图换成文字注记时请求仍会成功。据此认定模型见过图，等于替它声明
 * 一件没发生的事——切回可接图的模型之后那一批就再也带不上了。
 */
test('模型不收图时请求成功也不写引用，换回可接图模型仍带原图', async () => {
  const l = ledger()
  const history = [USER, ...wave('pr_gen', 'shot')]

  const blind = capturingAdapter({ vision: false })
  await askOnce(blind, l.persist, history, 'rn_blind')
  expect(imagesIn(blind.seen[0])).toEqual([])
  expect(l.references.has('pr_1')).toBe(false)
  expect(l.settled.get('pr_1')).toBe('received')

  const seeing = capturingAdapter()
  await askOnce(seeing, l.persist, history, 'rn_seeing')
  expect(imagesIn(seeing.seen[0])).toEqual(['SHOTA', 'SHOTB'])
  expect(l.references.get('pr_2')).toBe('pr_gen')
})

/** 收纳去图留文字：请求成功，但模型看到的是信封，不能记成已送达。 */
test('压缩把最近一批收纳掉时不写引用', async () => {
  const l = ledger()
  const adapter = capturingAdapter()
  await askOnce(adapter, l.persist, [USER, ...wave('pr_gen', 'shot')], 'rn_condensed', {
    project: (messages) => messages.map(condenseMessage),
  })

  expect(imagesIn(adapter.seen[0])).toEqual([])
  expect(l.references.has('pr_1')).toBe(false)
})

test('旧批次查不到引用记录时保守保留，批次归属缺失时只保留不记引用', async () => {
  const legacy = ledger()
  const withLegacy = capturingAdapter()
  await askOnce(withLegacy, legacy.persist, [USER, ...wave('bt_legacy', 'shot')], 'rn_legacy')
  expect(imagesIn(withLegacy.seen[0])).toEqual(['SHOTA', 'SHOTB'])
  expect(legacy.references.get('pr_1')).toBe('bt_legacy')

  const anonymous = ledger()
  const noBatch = capturingAdapter()
  await askOnce(
    noBatch,
    anonymous.persist,
    [USER, callsMessage(null, ['a1']), shot('a1', null, 'ONLY')],
    'rn_anonymous',
  )
  expect(imagesIn(noBatch.seen[0])).toEqual(['ONLY'])
  expect(anonymous.references.size).toBe(0)
})
