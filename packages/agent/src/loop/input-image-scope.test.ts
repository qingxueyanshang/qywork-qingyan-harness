/**
 * 工具图片与附件图片在后续请求中的保留范围。
 *
 * 覆盖范围：`loop/index.ts` 的 `buildRequest` 媒体去留（`loop/request.ts` 的 `evictedMedia`），
 * 以及它与 `materialize` 能力过滤、`compaction.ts` 收纳的先后关系。
 *
 * 断言针对适配器实际收到的请求：去留、投影、能力过滤三个步骤都在它之前，
 * 只检查装配中间结果会遗漏「模型不接受图片、图片被替换为文字注记」这一分支。
 * 三种协议的序列化不丢失图片由 `runtime/input-image-recovery.test.ts` 通过真实 HTTP 锁定。
 */

import { expect, test } from 'bun:test'
import type { ChatRequest, ContentBlock, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateRequest, lookupModel } from '@qywork/ai'
import { condenseMessage, IMAGES_OMITTED } from '../compaction.ts'
import { AgentLoop } from '../index.ts'
import type { ToolContextBase } from '../registry.ts'
import { ToolRegistry } from '../registry.ts'
import type { LoopPersistence } from './types.ts'

function persistence(): LoopPersistence {
  let seq = 0
  let requests = 0
  return {
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
    settleRequest: () => {},
  }
}

/** 一轮即结束的假适配器，原样保存它收到的请求。 */
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

/** 一条带图片的工具结果，结构与生产代码中 `toolResultContent` 的产物相同。 */
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

/** 包含两张图片的工具波次。 */
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
    // 断言针对适配器收到的请求。
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

/** 解码后约 `mb` MB 的 base64，以前缀区分图片。 */
const big = (tag: string, mb: number): string =>
  tag + 'A'.repeat(Math.ceil((mb * 1024 * 1024 * 4) / 3))
const tagOf = (data: string): string => data.replace(/A+$/, '')

/** 包含一张图片的工具波次。 */
function bigWave(batchId: string, tag: string, mb: number): WireMessage[] {
  return [callsMessage(batchId, [tag]), shot(tag, batchId, big(tag, mb))]
}

test('总量在上限内时更早批次的图片均保留在请求中', async () => {
  const adapter = capturingAdapter()
  await askOnce(
    adapter,
    persistence(),
    [USER, ...wave('pr_old', 'first'), ...wave('pr_new', 'second')],
    'rn_keep',
  )
  expect(imagesIn(adapter.seen[0])).toEqual(['FIRSTA', 'FIRSTB', 'SECONDA', 'SECONDB'])
})

/** 超过上限时从最早的一批起整批替换为信封，最后一批（尚未得到响应）始终保留。 */
test('超过上限时最早的批次替换为 images_omitted 信封，最后一批保留', async () => {
  const adapter = capturingAdapter()
  await askOnce(
    adapter,
    persistence(),
    [
      USER,
      ...bigWave('pr_1', 'one', 1.9),
      ...bigWave('pr_2', 'two', 1.9),
      ...bigWave('pr_3', 'three', 1.9),
      ...bigWave('pr_4', 'four', 1.9),
    ],
    'rn_evict',
  )
  // 第 3 张使总量达到约 5.7 MB，换出前两张后降至 1.9 MB；第 4 张之后为 3.8 MB，未再超过上限。
  expect(imagesIn(adapter.seen[0]).map(tagOf)).toEqual(['three', 'four'])
  const tools = (adapter.seen[0]?.messages ?? []).filter((m) => m.role === 'tool')
  for (const t of tools.slice(0, 2)) {
    expect(JSON.parse(String(t.content))).toMatchObject({ images_omitted: IMAGES_OMITTED })
  }
})

/** 附件图片与工具图片共用同一预算：在上限内时历史轮次的附件仍保留在请求中。 */
test('历史用户消息的附件图片在上限内时保留在请求中', async () => {
  const adapter = capturingAdapter()
  const attached: WireMessage = {
    role: 'user',
    content: [
      { type: 'image', mimeType: 'image/jpeg', source: { kind: 'base64', data: 'PHOTO' } },
      { type: 'text', text: '这是上一轮发的图' },
    ],
    _group: 'historyMessages',
  }
  await askOnce(adapter, persistence(), [attached, ...wave('pr_gen', 'shot')], 'rn_attach')
  expect(imagesIn(adapter.seen[0])).toEqual(['PHOTO', 'SHOTA', 'SHOTB'])
})

/**
 * 能力过滤只在请求副本上把图片替换为文字注记：历史不变，切换回支持图片的模型时原图仍在。
 */
test('模型不接受图片时替换为文字注记，切换回支持图片的模型时仍带原图', async () => {
  const history = [USER, ...wave('pr_gen', 'shot')]
  const blind = capturingAdapter({ vision: false })
  await askOnce(blind, persistence(), history, 'rn_blind')
  expect(imagesIn(blind.seen[0])).toEqual([])

  const seeing = capturingAdapter()
  await askOnce(seeing, persistence(), history, 'rn_seeing')
  expect(imagesIn(seeing.seen[0])).toEqual(['SHOTA', 'SHOTB'])
})

/** 收纳移除图片、保留文字，信封标记 images_omitted。 */
test('压缩收纳带图片的结果后请求中没有图片，信封带标记', async () => {
  const adapter = capturingAdapter()
  await askOnce(adapter, persistence(), [USER, ...wave('pr_gen', 'shot')], 'rn_condensed', {
    project: (messages) => messages.map(condenseMessage),
  })
  expect(imagesIn(adapter.seen[0])).toEqual([])
  const tools = (adapter.seen[0]?.messages ?? []).filter((m) => m.role === 'tool')
  for (const t of tools) {
    expect(JSON.parse(String(t.content))).toMatchObject({ images_omitted: IMAGES_OMITTED })
  }
})
