/**
 * 压缩与主循环的接线测试。
 *
 * `compaction.test.ts` 验的是压缩算法本身；这里验的是**发送前检查 → 压缩 →
 * 重新装配**这条控制流真的走通了。两者分开是因为前者纯函数、后者要造占用压力，
 * 混在一起会让「算法对不对」和「接线对不对」在失败时分不出来。
 *
 * 覆盖范围：`loop.ts` 的压缩触发与容量恢复。其中「压缩重发另开一行账」那条接真
 * `Store`，连带覆盖 `store/repos.ts` 的 `openProviderRequest` 在同一轮多次发送下
 * 与 `uq_provider_run_turn` 的关系——别的用例都把这个端口打桩成常量。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import { classifyProviderError, DEFAULT_DENSITY, lookupModel } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import {
  createConversation,
  createRun,
  listProviderRequests,
  markProviderRequestSent,
  openProviderRequest,
  Store,
  settleProviderRequest,
  upsertWorkspace,
} from '@qywork/store'
import type { CompactionOutcome } from './compaction.ts'
import { stepStamp } from './compaction.ts'
import type { CompactionPort, CompactionRunInput, LoopPersistence, ToolContext } from './index.ts'
import { AgentLoop, MAX_RESENDS, softLimit, UNAVAILABLE_BACKOFF_MS } from './loop.ts'
import { ToolRegistry } from './registry.ts'

/*
 * 退避是真的在等。只把退避那一档改成立即触发，别的定时器原样放行——
 * 全量替换会让卡死检测（`STREAM_IDLE_TIMEOUT_MS`）立刻开火，成功用例会被判成断流。
 */
const realSetTimeout = globalThis.setTimeout
beforeAll(() => {
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
    realSetTimeout(fn, ms === UNAVAILABLE_BACKOFF_MS ? 0 : ms, ...rest)) as typeof setTimeout
})
afterAll(() => {
  globalThis.setTimeout = realSetTimeout
})

/** 落库的压缩 step，供「中断不记账」「payload 与事件同源」两组断言读。 */
type RecordedCompaction = Parameters<LoopPersistence['recordCompaction']>[2]

function noopPersistence(recorded: RecordedCompaction[] = []): LoopPersistence {
  let seq = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: () => `st_${seq}`,
    openThinkingStep: () => `st_think_${seq}`,
    landUserStep: () => `st_user_${seq}`,
    failThinkingSteps: () => {},
    appendText: () => {},
    openToolStep: () => `st_${seq}`,
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: (_runId, _seq, payload) => {
      recorded.push(payload)
    },
    openRequest: () => 'pr_test',
    markRequestSent: () => {},
    settleRequest: () => {},
  }
}

function makeCtx(): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn' as never,
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

function capacityError(): unknown {
  const err = new Error('prompt is too long: 213000 tokens > 200000 maximum') as Error & {
    status: number
  }
  err.status = 400
  return classifyProviderError('anthropic_messages', err)
}

function paramError(): unknown {
  const err = new Error('max_tokens must be less than or equal to 8192') as Error & {
    status: number
  }
  err.status = 400
  return classifyProviderError('anthropic_messages', err)
}

/** 前 N 次以给定错误失败，之后正常。用来验证「压缩后重发」真的发生。 */
function rejectingAdapter(rejectTimes: number, makeError = capacityError) {
  const state = { attempts: 0 }
  const adapter: LlmAdapter = {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic_messages'),
    async *stream(_req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      state.attempts++
      if (state.attempts <= rejectTimes) throw makeError()
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      yield { type: 'text_delta', delta: '压缩后完成' }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
  }
  return { adapter, state }
}

/** 全程正常返回的 adapter。 */
function okAdapter(): LlmAdapter {
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic_messages'),
    async *stream(_req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      yield { type: 'text_delta', delta: '完成' }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
  }
}

const okOutcome: CompactionOutcome = {
  status: 'compacted',
  summarized: false,
  manifest: {
    revision: 1,
    compactedThroughMessageId: null,
    compactedMessageCount: 0,
    summary: '摘要',
    facts: { filesTouched: [], openItems: [], userConstraints: [] },
    createdAt: 0,
  },
}

/**
 * 真的会让请求变小的假压缩。
 *
 * `fakeCompaction` 的投影是原样返回，用它测不出溢出恢复——恢复的判据正是
 * 「压完请求有没有变小」，不变小就不重发。
 */
function shrinkingCompaction(outcome: CompactionOutcome = okOutcome) {
  const state = { runs: 0, folded: false }
  const port: CompactionPort = {
    project: (messages) =>
      state.folded ? messages.map((m) => ({ ...m, content: '折' })) : messages,
    run: async () => {
      state.runs++
      state.folded = true
      return outcome
    },
  }
  return { port, state }
}

function fakeCompaction(outcome: CompactionOutcome) {
  const state = { runs: 0, projects: 0, seen: [] as CompactionRunInput[] }
  const port: CompactionPort = {
    project: (h) => {
      state.projects++
      return h
    },
    run: async (runInput: CompactionRunInput) => {
      state.runs++
      state.seen.push(runInput)
      return outcome
    },
  }
  return { port, state }
}

/** 一段够大的历史：投影把它砍掉之后请求才真的变小，恢复判据才有意义。 */
function bulkyHistory() {
  return Array.from({ length: 20 }, (_, i) => ({
    role: 'user' as const,
    content: `第 ${i} 段历史`.repeat(200),
  }))
}

async function collectWith(
  loop: AgentLoop,
  runId: string,
  history: { role: 'user'; content: string }[],
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: runId as never,
    history,
    signal: new AbortController().signal,
  })) {
    out.push(ev)
  }
  return out
}

async function collect(loop: AgentLoop, runId: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: runId as never,
    history: [],
    signal: new AbortController().signal,
  })) {
    out.push(ev)
  }
  return out
}

function build(
  adapter: LlmAdapter,
  compaction?: CompactionPort,
  registry = new ToolRegistry(),
): AgentLoop {
  return new AgentLoop({
    adapter,
    registry,
    systemPrompt: 'sys',
    tailNotes: () => [],
    persist: noopPersistence(),
    makeToolContext: makeCtx,
    ...(compaction ? { compaction } : {}),
  })
}

describe('发送前检查：唯一的压缩触发', () => {
  /**
   * 占用没到软阈值就**一次也不压**。
   *
   * 这是「不在不需要的时候损失信息」那条原则的落点：靠阈值本身足够高
   * （窗口的 80%）。
   */
  test('占用远低于阈值时不压缩', async () => {
    const comp = fakeCompaction(okOutcome)
    const events = await collect(build(okAdapter(), comp.port), 'rn_low')
    expect(comp.state.runs).toBe(0)
    expect(events.some((e) => e.type === 'compaction')).toBe(false)
    expect(events.find((e) => e.type === 'run.finished')?.type).toBe('run.finished')
  })

  /**
   * 占用越过软阈值 → 发出去**之前**压一次，然后重新装配。
   *
   * 「重新装配」不能省：压缩改的是投影，拿压缩前那份请求发出去，
   * 这次压缩就白花了。
   */
  test('越过软阈值：发送前压一次并重新装配', async () => {
    const comp = fakeCompaction(okOutcome)
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_high' as never,
      history: [],
      // 锚点直接把占用顶到阈值之上——不用真造一段几十万字的历史。
      // 1M 窗口 × 0.8 → 软阈值 800,000。
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    expect(comp.state.runs).toBeGreaterThan(0)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'started')).toBe(true)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'done')).toBe(true)
    expect(events.find((e) => e.type === 'run.finished')?.type).toBe('run.finished')
  })

  /**
   * 信封换一份不再白压一次。
   *
   * 用户报过的形状：升一次构建后信封指纹必变，锚点整条作废，占用改由裸估算尺报，
   * 而未收录档那把尺实测高 1.4 倍——真实占用远在阈值之下的会话被判成越线，
   * 压一次、丢一段上下文，全程静默。
   *
   * 对照组只换模型：那一种锚点确实修正不回来，压缩照旧触发。两组用同一份历史，
   * 因此这段历史的裸估算确实越线，不是测了个空请求。
   */
  test('信封变了不白压一次，换模型仍按估算尺判', async () => {
    // 1M 窗口 × 0.8 → 软阈值 800,000。裸估算按 2.5 字符/token 计，这段正文约 96 万。
    const bulk = 'x'.repeat(2_400_000)
    const runOnce = async (model: string) => {
      const comp = fakeCompaction(okOutcome)
      const loop = new AgentLoop({
        adapter: okAdapter(),
        registry: new ToolRegistry(),
        systemPrompt: 'sys',
        tailNotes: () => [],
        persist: noopPersistence(),
        makeToolContext: makeCtx,
        compaction: comp.port,
      })
      const events: AgentEvent[] = []
      for await (const ev of loop.run({
        runId: 'rn_envelope' as never,
        history: [{ role: 'user', content: bulk, _group: 'historyMessages', _messageId: 'ms_1' }],
        // 真值 700,000 在阈值之下；`throughMessageId` 盖住这条历史，锚点已经算过它。
        anchor: {
          tokens: 700_000,
          throughMessageId: 'ms_1',
          model,
          headTokens: 0,
          envelopeFingerprint: 'stale-envelope',
        },
        signal: new AbortController().signal,
      })) {
        events.push(ev)
      }
      return { runs: comp.state.runs, events }
    }

    const kept = await runOnce('claude-opus-5')
    expect(kept.runs).toBe(0)
    expect(kept.events.some((e) => e.type === 'compaction')).toBe(false)
    expect((await runOnce('other-model')).runs).toBeGreaterThan(0)
  })

  /**
   * 压不动不是致命错：照常发出去，让 provider 来判。
   *
   * 「没什么可压」走 `skipped` 而不是 `failed`——显示成失败会让用户去查一个
   * 并不存在的故障。
   */
  test('压不动时照常发送，不把 run 掐死', async () => {
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_skip' as never,
      history: [],
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'skipped')).toBe(true)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'failed')).toBe(false)
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.status).toBe('done')
  })

  /**
   * **容量拒绝先压一次再重发。**
   *
   * 原始失败形状：占用读数对附件按固定值估，一份大附件低估两个数量级 →
   * 发送前检查恒放行 → provider 恒拒绝 → 重试拿到同一个估算 → 会话永久卡死，
   * 手动压缩也救不回（附件在保留区里）。这条锁的就是那个形状有终态。
   */
  test('容量拒绝：压一次让请求变小之后重发成功', async () => {
    const comp = shrinkingCompaction()
    const { adapter, state } = rejectingAdapter(1)
    const events = await collectWith(build(adapter, comp.port), 'rn_overflow', bulkyHistory())

    expect(comp.state.runs).toBe(1)
    // 发了两次：撞窗那次 + 压完重发那次。
    expect(state.attempts).toBe(2)
    expect(events.some((e) => e.type === 'run.error')).toBe(false)
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.status).toBe('done')
  })

  /**
   * **压缩重发是账本上的第二行，不是同一行。**
   *
   * 这条接真 `Store`：别的用例把 `openRequest` 打桩成常量，唯一索引不参与，
   * 两次发送共用一组键也不会有任何反应。实测形状是撞窗那次与压完重发那次同为
   * `(run_id, 0, 0)`，第二次插入撞 `uq_provider_run_turn`，异常上抛，整轮死在
   * 一句 SQLite 约束报错上——压缩白压，模型一次都没答上话。
   */
  test('压缩重发另开一行账，不撞唯一索引', async () => {
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, 'C:/ws', 'ws')
    const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: 'req-overflow',
      userMessageId: null,
      messageIdUpperBound: null,
    })

    const comp = shrinkingCompaction()
    const { adapter, state } = rejectingAdapter(1)
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: {
        ...noopPersistence(),
        openRequest: (input) => openProviderRequest(store, input).id,
        markRequestSent: (id) => markProviderRequestSent(store, id as never),
        settleRequest: (id, status, usage, errorCode, finishReason) =>
          settleProviderRequest(store, id as never, status, usage, errorCode, finishReason),
      },
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events = await collectWith(loop, run.id, bulkyHistory())

    expect(events.some((e) => e.type === 'run.error')).toBe(false)
    expect(state.attempts).toBe(2)
    // 同一轮、两个发送序号；第一行是撞窗那次，第二行是压完重发那次。
    const rows = listProviderRequests(store, run.id)
    expect(rows.map((r) => [r.turnIndex, r.retryIndex])).toEqual([
      [0, 0],
      [0, 1],
    ])
    expect(rows.map((r) => r.status)).toEqual(['rejected', 'received'])
    store.close()
  })

  /**
   * **压不小就不重发。**
   *
   * 同一份字节再发一次只会拿到同一个拒绝，而那一次要付全额的长 prompt 费用。
   * 判据是「请求有没有变小」，不是「压缩返回成功」——收纳段可能落了库却一个
   * token 没省。
   */
  test('压缩没让请求变小时不重发，如实上报容量拒绝', async () => {
    // `fakeCompaction` 的投影原样返回：压缩「成功」但请求一个字节没少。
    const comp = fakeCompaction(okOutcome)
    const { adapter, state } = rejectingAdapter(1)
    const events = await collect(build(adapter, comp.port), 'rn_noshrink')

    expect(comp.state.runs).toBe(1)
    expect(state.attempts).toBe(1)
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  /**
   * **一个 run 内只恢复一次。**
   *
   * 用状态机而不是重试计数：没有「几次算够」这个问题——压完还撞说明压缩已经
   * 压不动了，再压一次的输入与上一次逐字相同。
   */
  test('连续撞窗只恢复一次，不进死循环', async () => {
    const comp = shrinkingCompaction()
    // 两次都拒绝：第一次触发恢复，重发那次仍被拒 → 直接上报，不再压第三次。
    const { adapter, state } = rejectingAdapter(2)
    const events = await collectWith(build(adapter, comp.port), 'rn_twice', bulkyHistory())

    expect(comp.state.runs).toBe(1)
    expect(state.attempts).toBe(2)
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  /**
   * 端口缺省时由构造函数补一个透传实现，语义与「没有压缩」逐字相同：
   * 投影原样返回、压缩报「没什么可折」，因此容量拒绝照旧上报。
   */
  test('没有压缩端口时容量拒绝照样上报，不静默卡住', async () => {
    const { adapter } = rejectingAdapter(1)
    const events = await collect(build(adapter), 'rn_nocomp')
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  /**
   * **静默截断：provider 不报错，直接丢弃超出的部分。**
   *
   * 实测 deepseek-v4-flash：发出约 200 万 token，自报收到 1,000,086，
   * 窗口正好 1,000,000，全程无错误。错误分类在这种 provider 上拿不到凭证，
   * 判据只能从两个真值反推——自报输入顶到了模型自带的窗口。
   */
  test('自报输入顶到窗口时放开压缩闸，下一步重折', async () => {
    const comp = shrinkingCompaction()
    const spec = lookupModel('claude-opus-5', 'anthropic_messages')
    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec,
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        if (turn++ === 0) {
          // 第一轮：provider 自报输入顶到窗口——它把超出的丢了，却没报错。
          yield {
            type: 'usage',
            usage: {
              inputTokens: spec.contextWindow,
              outputTokens: 5,
              cachedTokens: 0,
              cacheWriteTokens: null,
              reasoningTokens: 0,
              source: 'provider',
            },
          }
          yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: {} }] }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'text_delta', delta: '完成' }
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
        }
      },
    }
    const registry = new ToolRegistry()
    registry.register({
      name: 'noop',
      description: '什么都不做',
      parameters: { type: 'object', properties: {} },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => ({ status: 'success', message: 'ok' }),
    })
    await collectWith(build(adapter, comp.port, registry), 'rn_silent', bulkyHistory())
    // 静默截断被认出来了：压缩闸放开，第二步真的折了一次。
    expect(comp.state.runs).toBeGreaterThan(0)
  })

  test('非容量错误照常上报', async () => {
    const comp = fakeCompaction(okOutcome)
    // 把重发额度拒满再多拒一次：参数错误与「上游暂时不可用」同归
    // `provider_unavailable`，会被自动重发（代价写在 `loop.ts` 的 `RESENDABLE` 上）。
    // 拒的次数不够的话某一次就成功了，断言的是重发路径而不是上报路径。
    const { adapter } = rejectingAdapter(MAX_RESENDS + 1, paramError)
    const events = await collect(build(adapter, comp.port), 'rn_param')
    expect(comp.state.runs).toBe(0)
    expect(events.some((e) => e.type === 'run.error')).toBe(true)
  })
})

describe('投影时机', () => {
  test('每次构造请求都重新投影 —— 拿旧投影等于那次压缩白花了', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'noop',
      description: '什么都不做',
      parameters: { type: 'object', properties: {} },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => ({ status: 'success', message: 'ok' }),
    })

    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        if (turn++ === 0) {
          yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: {} }] }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'text_delta', delta: '完成' }
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
        }
      },
    }

    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port, registry), 'rn_6')

    // 两轮请求 = 两次投影。缓存一次投影结果重复用，压缩生效后第一轮仍会发全量历史。
    expect(comp.state.projects).toBe(2)
  })
})

function noopRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'noop',
    description: '什么都不做',
    parameters: { type: 'object', properties: {} },
    actionKind: 'read',
    objectLabel: '空',
    category: 'session',
    facet: '测试',
    summary: '测试夹具',
    permissionEffect: 'internal_control',
    fn: async () => ({ status: 'success', message: 'ok' }),
  })
  return registry
}

/** 第一轮调一次工具，第二轮收尾。两轮之间 transcript 会长出一个新单元。 */
function twoTurnAdapter(): LlmAdapter {
  let turn = 0
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic_messages'),
    async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      if (turn++ === 0) {
        yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: {} }] }
        yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
      } else {
        yield { type: 'text_delta', delta: '完成' }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      }
    },
  }
}

async function runHigh(loop: AgentLoop, runId: string): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: runId as never,
    history: [],
    // 1M 窗口 × 0.8 → 软阈值 800,000，锚点直接顶到线上。
    anchor: {
      tokens: 900_000,
      throughMessageId: null,
      model: 'claude-opus-5',
      headTokens: 0,
      envelopeFingerprint: null,
    },
    signal: new AbortController().signal,
  })) {
    out.push(ev)
  }
  return out
}

/**
 * 进展判据。
 *
 * 取代的是「一个 run 只压一次」那条闸：它的前提（run 内没有新的可折内容）随
 * transcript 进投影一起消失了——run 内涨起来的正是工具结果，压不到它就等于
 * 压了个寂寞。判据换成「transcript 有没有长出新单元」，两个方向各锁一条：
 * 压太多（每步一次）和永远不再压都是回归。
 */
describe('有新可折单元才再压', () => {
  test('压不动但长出了新单元：下一步再试一次', async () => {
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    await runHigh(build(twoTurnAdapter(), comp.port, noopRegistry()), 'rn_again')
    expect(comp.state.projects).toBe(2)
    expect(comp.state.runs).toBe(2)
  })

  test('折叠成功之后不连环触发 —— 锚点跟着作废，读数真的降了', async () => {
    const comp = fakeCompaction(okOutcome)
    const events = await runHigh(build(twoTurnAdapter(), comp.port, noopRegistry()), 'rn_chain')
    expect(comp.state.runs).toBe(1)
    expect(events.filter((e) => e.type === 'compaction' && e.phase === 'started').length).toBe(1)
  })

  test('transcript 没变长就不重试', async () => {
    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 服务端把这一轮切开了：没有正文也没有调用，transcript 一个字没长。
        yield {
          type: 'done',
          stopReason: turn++ === 0 ? 'pause_turn' : 'end_turn',
          rawStopReason: '',
        }
      },
    }
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    await runHigh(build(adapter, comp.port), 'rn_nogrowth')
    expect(comp.state.projects).toBe(2)
    expect(comp.state.runs).toBe(1)
  })

  test('压缩端口拿到的占用与窗口就是触发判定用的那两个数', async () => {
    const comp = fakeCompaction(okOutcome)
    await runHigh(build(okAdapter(), comp.port), 'rn_args')
    expect(comp.state.seen[0]!.occupancy).toBe(900_000)
    expect(comp.state.seen[0]!.contextWindow).toBe(1_000_000)
  })
})

/**
 * 缺陷 E：run 内的执行记录必须真的能被折掉。
 *
 * 改造前 `project()` 只作用于 `input.history`，transcript 在投影**之后**才拼上去，
 * 因此 run 内涨起来的那几十波工具结果压缩一条也碰不到——而涨的正是那部分。
 */
describe('run 内 transcript 参与投影', () => {
  test('投影丢掉带戳的消息时，请求里就真的没有它们', async () => {
    const registry = noopRegistry()
    const { adapter, seen } = capturingAdapter(lookupModel('claude-opus-5', 'anthropic_messages'))
    let turn = 0
    const twoTurn: LlmAdapter = {
      ...adapter,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        for await (const ev of adapter.stream(req)) {
          if (ev.type !== 'request_prepared') continue
          yield ev
        }
        if (turn++ === 0) {
          yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: {} }] }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
        }
      },
    }
    // 把「折掉本 run 的执行记录」这件事做到底：带戳的一律不发。
    const port: CompactionPort = {
      project: (messages) => messages.filter((m) => !m._step),
      run: async () => okOutcome,
    }
    const loop = new AgentLoop({
      adapter: twoTurn,
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: makeCtx,
      compaction: port,
    })
    for await (const _ of loop.run({
      runId: 'rn_fold_transcript' as never,
      history: [],
      userMessageId: 'ms_001',
      signal: new AbortController().signal,
    })) {
      // 只看装配结果
    }

    expect(seen).toHaveLength(2)
    expect(seen[1]!.messages.some((m) => m.role === 'tool')).toBe(false)
  })
})

/**
 * 单元戳。
 *
 * 活的 transcript 与「跨 run 从 steps 投影回历史」必须盖出同一个戳，否则同一个
 * 单元在两个时刻定位不同，压缩会按两条线切同一段内容。这一侧钉的是规则本身：
 * 一个波次共用一个戳，取值是波次末 step 的 seq；另一侧在
 * `runtime/transcript.test.ts` 的「可折单元的戳」。
 */
describe('transcript 的可折单元', () => {
  test('assistant 与它的 tool 结果共用一个戳，取波次末 step 的 seq', async () => {
    const registry = noopRegistry()
    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        if (turn++ === 0) {
          yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: {} }] }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'text_delta', delta: '完成' }
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
        }
      },
    }

    const seen: WireMessage[][] = []
    const port: CompactionPort = {
      project: (messages) => {
        seen.push(messages)
        return messages
      },
      run: async () => okOutcome,
    }
    const loop = new AgentLoop({
      adapter,
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: makeCtx,
      compaction: port,
    })
    for await (const _ of loop.run({
      runId: 'rn_stamp' as never,
      history: [],
      userMessageId: 'ms_001',
      signal: new AbortController().signal,
    })) {
      // 只看装配出来的那份
    }

    // 第二次装配时，第一轮的执行波次已经在 transcript 里。
    const second = seen[1]!
    const assistant = second.find((m) => m.role === 'assistant' && m.toolCalls?.length)!
    const result = second.find((m) => m.role === 'tool')!
    // 工具 step 拿的是本 run 第一个 seq（这一轮没有文本 step）。
    expect(assistant._step).toBe(stepStamp('rn_stamp', 1))
    expect(result._step).toBe(assistant._step)
    expect(assistant._messageId).toBe('ms_001')
    expect(result._messageId).toBe('ms_001')
  })
})

/**
 * 触发线。
 *
 * 复现的原始失败形状是 §0.1 那条：1M 窗口的 deepseek 档，软阈值只有 366,000
 * （36.6%）——阈值把模型的输出**规格上限**整块减掉了，因此同为 1M 窗口的两个
 * 模型会得到两条完全不同的线。
 */
describe('软阈值只由窗口决定', () => {
  test('1M / 384K 档：触发线是 800,000，不是 366,000', () => {
    expect(softLimit(lookupModel('deepseek-v4-flash', 'openai_chat_completions'))).toBe(800_000)
  })

  test('每一档都是窗口的 80%', () => {
    expect(softLimit(lookupModel('claude-opus-5', 'anthropic_messages'))).toBe(800_000)
    expect(softLimit(lookupModel('claude-haiku-4-5', 'anthropic_messages'))).toBe(160_000)
    expect(softLimit({ contextWindow: 128_000 })).toBe(102_400)
    expect(softLimit({ contextWindow: 32_000 })).toBe(25_600)
  })

  /** 触发线不许随模型的输出上限漂移——那正是 366,000 与 622,000 并存的成因。 */
  test('同一窗口下换输出上限，线不动', () => {
    const a = lookupModel('deepseek-v4-flash', 'openai_chat_completions')
    const b = lookupModel('claude-opus-5', 'anthropic_messages')
    expect(a.maxOutputTokens).not.toBe(b.maxOutputTokens)
    expect(softLimit(a)).toBe(softLimit(b))
  })
})

/** 装配时捕获实际发出的请求，用来验申报值。 */
function capturingAdapter(spec: LlmAdapter['spec']) {
  const seen: ChatRequest[] = []
  const adapter: LlmAdapter = {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      yield { type: 'text_delta', delta: '完成' }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
  }
  return { adapter, seen }
}

/**
 * 缓存断点的位置随「整串一次投影」一起变了：断点二不再是「history 数组的末尾」，
 * 而是**尾区注记之前那条**——整串消息里只有尾区注记是 system 角色。
 * 位置错了不会有任何报错，只会每一轮全价重付。
 */
describe('缓存断点', () => {
  test('注记排在末尾；断点落在 history 末尾与注记之前', async () => {
    const { adapter, seen } = capturingAdapter(lookupModel('claude-opus-5', 'anthropic_messages'))
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [{ content: '今天是周三', group: 'workspaceState' }],
      persist: noopPersistence(),
      makeToolContext: makeCtx,
    })
    for await (const _ of loop.run({
      runId: 'rn_brk' as never,
      history: [
        { role: 'user', content: '第一句', _messageId: 'ms_001' },
        { role: 'assistant', content: '好的', _messageId: 'ms_001' },
      ],
      signal: new AbortController().signal,
    })) {
      // 只看装配结果
    }

    const messages = seen[0]!.messages
    // 注记是最后一段：它之后不许再有任何内容，否则前缀里就夹着易变的一块。
    const noteAt = messages.findIndex((m) => m.role === 'system')
    expect(noteAt).toBe(messages.length - 1)
    // 断点之二：history 末尾（跨 run 稳定点）。
    expect(messages[1]!.cacheBreakpoint).toBe(true)
    // 断点之三：注记之前（run 内稳定点）。首轮 transcript 为空，两者重合。
    expect(messages[noteAt - 1]!.cacheBreakpoint).toBe(true)
  })

  /**
   * 复现的是原始失败形状：会话 `cv_0mszld8o60000yi2u5m` 的 rn_0mszqkz8d 产出约
   * 1.4 万 token 的 grep 结果，下一轮 rn_0mszqmhqh 只命中 192。
   *
   * 成因是装配顺序：注记夹在 history 与 transcript 之间时，跨 run 的公共前缀
   * 在上一轮 history 末尾就断了——上一轮跑出来的全部工具结果必然全价重付。
   *
   * 所以断言的是**字节**：下一轮首请求与上一轮末请求的最长公共前缀，
   * 必须长过上一轮那些工具结果。旧布局下这个断言必然失败。
   */
  test('跨 run 的公共前缀覆盖上一轮的全部工具结果', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'grep',
      description: '假 grep，回一大坨结果。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'query',
      objectLabel: '内容',
      category: 'code',
      facet: '搜索',
      summary: '测试夹具',
      permissionEffect: 'read',
      fn: async () => ({ status: 'success', message: 'hit', data: { lines: 'x'.repeat(4000) } }),
    })

    const seen: ChatRequest[] = []
    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'openai_chat_completions',
      transmits: { effort: false },
      spec: lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        seen.push(req)
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 第一轮：调一次 grep，产出一大段工具结果；之后只说话。
        if (turn++ === 0) {
          yield {
            type: 'tool_calls',
            calls: [{ id: 'c1', name: 'grep', arguments: {} }],
          }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: 'tool_calls' }
          return
        }
        yield { type: 'text_delta', delta: '完成' }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'stop' }
      },
    }

    const build = () =>
      new AgentLoop({
        adapter,
        registry,
        systemPrompt: 'sys',
        tailNotes: () => [{ content: '工作区：/tmp/ws', group: 'workspaceState' }],
        persist: noopPersistence(),
        makeToolContext: makeCtx,
      })

    const history: WireMessage[] = [{ role: 'user', content: '找 bug', _messageId: 'ms_001' }]
    for await (const _ of build().run({
      runId: 'rn_a' as never,
      history,
      signal: new AbortController().signal,
    })) {
      // 跑完第一轮
    }

    // 第一轮的产出折进历史，第二轮开一个新 run——这正是账本里那两轮的关系。
    const carried: WireMessage[] = [
      ...history,
      ...seen[seen.length - 1]!.messages.filter((m) => m._group === 'executionRecords'),
      { role: 'user', content: '全部都做一下', _messageId: 'ms_002' },
    ]
    const before = seen.length
    for await (const _ of build().run({
      runId: 'rn_b' as never,
      history: carried,
      signal: new AbortController().signal,
    })) {
      // 跑完第二轮
    }

    /*
     * 比的是**上线字节**，所以内部标记要剥掉：`cacheBreakpoint` 在兼容协议上
     * 一个字节都不上线（`openai-compat.ts` 从不读它），`_group` / `_messageId` /
     * `_step` 同理。不剥的话断言测的是内部结构而不是缓存看到的字节——
     * 而 history 末尾那个断点本来就该随历史增长往后走。
     */
    const wire = (req: ChatRequest) =>
      JSON.stringify(
        req.messages.map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          ...(m.reasoningContent ? { reasoningContent: m.reasoningContent } : {}),
        })),
      )
    const lastOfA = wire(seen[before - 1]!)
    const firstOfB = wire(seen[before]!)
    let common = 0
    while (
      common < lastOfA.length &&
      common < firstOfB.length &&
      lastOfA[common] === firstOfB[common]
    ) {
      common++
    }
    // 那一大坨工具结果必须落在公共前缀之内。旧布局下公共前缀止于 history 末尾。
    const toolResult = seen[before - 1]!.messages.find((m) => m.role === 'tool')
    expect(toolResult).toBeDefined()
    expect(common).toBeGreaterThan(JSON.stringify(toolResult).length)
  })
})

describe('申报按占用钳位', () => {
  const spec = lookupModel('claude-opus-5', 'anthropic_messages')

  test('低占用时申报规格上限', async () => {
    const { adapter, seen } = capturingAdapter(spec)
    await collect(build(adapter), 'rn_declare_low')
    expect(seen[0]!.maxOutputTokens).toBe(spec.maxOutputTokens)
  })

  /**
   * 高占用下静态申报规格上限就是 `输入 + max_tokens > 窗口`，provider 直接拒。
   * 申报回答的是「这一轮还装得下多少输出」。
   *
   * **还要再留一份余量。** 占用是估算出来的，估算低估多少申报就超出多少，
   * 而那个 400 若被容量分类认成撞窗，会白花一次有损压缩去救一个申报错误。
   * 断言写成区间而不是等式：余量比例调整时这条不该整片红，
   * 它锁的是「申报之后仍装得下，且没把剩余空间全占满」。
   */
  test('高占用时申报随剩余空间收缩，并留出估算误差的余量', async () => {
    const { adapter, seen } = capturingAdapter(spec)
    const occupancy = 950_000
    const events: AgentEvent[] = []
    for await (const ev of build(adapter).run({
      runId: 'rn_declare_high' as never,
      history: [],
      anchor: {
        tokens: occupancy,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    const declared = seen[0]!.maxOutputTokens!
    const room = spec.contextWindow - occupancy
    expect(declared).toBeGreaterThan(0)
    // 装得下：申报加上占用不越窗，且离窗口还有余量。
    expect(occupancy + declared).toBeLessThan(spec.contextWindow)
    // 没把剩余空间全占满——余量确实留了。
    expect(declared).toBeLessThan(room)
  })
})

describe('压缩被中断', () => {
  /**
   * 中断的压缩什么都没落库，所以事件流与账本上都不该留下终态。
   * 停止时刻多一张红卡是噪音，而记一条 step 会让「什么都没发生」看起来像发生过。
   */
  test('不发终态事件、不记 step，run 以中断收尾', async () => {
    const comp = fakeCompaction({ status: 'aborted' })
    const recorded: RecordedCompaction[] = []
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(recorded),
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_abort' as never,
      history: [],
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'compaction' && e.phase === 'started')).toBe(true)
    expect(events.filter((e) => e.type === 'compaction' && e.phase !== 'started')).toHaveLength(0)
    expect(recorded).toHaveLength(0)
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.status).toBe('interrupted')
  })
})

describe('结果形态对用户可见', () => {
  test('done 带 summarized，step payload 与事件同源', async () => {
    const comp = fakeCompaction({ ...okOutcome, summarized: true })
    const recorded: RecordedCompaction[] = []
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(recorded),
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_summarized' as never,
      history: [],
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const done = events.find((e) => e.type === 'compaction' && e.phase === 'done')
    expect(done?.type === 'compaction' && done.summarized).toBe(true)
    expect(recorded).toEqual([
      { phase: 'done', manifestRevision: 1, compactedMessages: 0, summarized: true },
    ])
  })

  /** 只收纳没摘要也要说出来：不说的话用户看到的和一次完整压缩一模一样。 */
  test('只收纳时 summarized 为 false', async () => {
    const comp = fakeCompaction({ ...okOutcome, summarized: false })
    const recorded: RecordedCompaction[] = []
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(recorded),
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    for await (const _ of loop.run({
      runId: 'rn_local' as never,
      history: [],
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      // 只看落库结果
    }
    expect(recorded[0]?.summarized).toBe(false)
  })

  test('skipped 落库时带 skipped，不伪装成失败', async () => {
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    const recorded: RecordedCompaction[] = []
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(recorded),
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    for await (const _ of loop.run({
      runId: 'rn_skip_step' as never,
      history: [],
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      // 只看落库结果
    }
    expect(recorded[0]?.phase).toBe('skipped')
    expect(recorded[0]?.reasonCode).toBe('nothing_to_fold')
  })
})
