/**
 * 压缩与主循环的接线测试。
 *
 * `compaction.test.ts` 验证压缩算法本身；本文件验证**发送前检查 → 压缩 →
 * 重新装配**这条控制流确实能够执行。两者分开是因为前者是纯函数，后者需要构造占用压力，
 * 合在一起时，失败无法区分是算法错误还是接线错误。
 *
 * 覆盖范围：`loop/compact.ts` 的压缩触发与容量恢复。其中「压缩后重发在账本中另记一行」用例接入真实
 * `Store`，同时覆盖 `store/repos.ts` 的 `openProviderRequest` 在同一轮多次发送时
 * 与 `uq_provider_run_turn` 的关系；其他用例都把该端口打桩为常量。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage } from '@qywork/ai'
import {
  classifyProviderError,
  DEFAULT_DENSITY,
  lookupModel,
  STREAM_IDLE_TIMEOUT_MS,
} from '@qywork/ai'
import type { AgentEvent, RunUsage } from '@qywork/core'
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
import type { CompactionOutcome } from '../compaction.ts'
import { stepStamp } from '../compaction.ts'
import type { CompactionPort, CompactionRunInput, LoopPersistence, ToolContext } from '../index.ts'
import { AgentLoop } from '../index.ts'
import { compactionEpoch, ToolRegistry } from '../registry.ts'
import { MAX_RESENDS } from './attempt.ts'
import { softLimit } from './request.ts'

/** 落库的压缩 step，供「中断不记账」「payload 与事件同源」两组断言读取。 */
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
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
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

/** 前 N 次以给定错误失败，之后正常返回。用于验证「压缩后重发」确实发生。 */
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
      yield { type: 'text_delta', delta: '压缩后完成', at: Date.now() }
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
      yield { type: 'text_delta', delta: '完成', at: Date.now() }
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
 * 确实会使请求变小的模拟压缩。
 *
 * `fakeCompaction` 的投影原样返回，无法用于测试溢出恢复：恢复的判据正是
 * 「压缩后请求是否变小」，未变小时不重发。
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

/** 一段足够大的历史：投影将其删除之后请求才实际变小，恢复判据才有意义。 */
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
    persist: noopPersistence(),
    makeToolContext: makeCtx,
    // 若实际等待退避，「非容量错误照常上报」用例需要等满五次指数退避。
    sleep: async () => {},
    ...(compaction ? { compaction } : {}),
  })
}

describe('发送前检查：唯一的压缩触发', () => {
  /**
   * 占用未达到软阈值时**一次也不压缩**。
   *
   * 这是「不在不必要时损失信息」原则的实现方式：依靠阈值本身足够高
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
   * 占用越过软阈值 → 发送**之前**压缩一次，然后重新装配。
   *
   * 「重新装配」不能省略：压缩修改的是投影，发送压缩前装配的请求时，
   * 本次压缩没有任何效果。
   */
  test('越过软阈值：发送前压缩一次并重新装配', async () => {
    const comp = fakeCompaction(okOutcome)
    let ctx: ToolContext | undefined
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: () => {
        ctx = makeCtx()
        return ctx
      },
      compaction: comp.port,
    })
    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_high' as never,
      history: [],
      // 锚点直接把占用设到阈值之上，无需构造几十万字的历史。
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
    // 工具据此次数判断先前投递的结果是否仍逐字可见（电脑控制的差异基底）。
    expect(ctx ? compactionEpoch(ctx.state) : -1).toBe(1)
  })

  /**
   * 信封变化时不做无效压缩。
   *
   * 用户报告的失败形状：每次升级构建后信封指纹必然变化，锚点整体作废，占用改由裸估算报告，
   * 而未收录模型的估算实测偏高 1.4 倍：真实占用远低于阈值的会话被判定为越线，
   * 压缩一次并丢失一段上下文，全程没有提示。
   *
   * 对照组只更换模型：这种情况下锚点确实无法修正，压缩照常触发。两组使用同一份历史，
   * 因此这段历史的裸估算确实越线，测试的不是空请求。
   */
  test('信封变化时不做无效压缩，更换模型时仍按估算判定', async () => {
    // 1M 窗口 × 0.8 → 软阈值 800,000。裸估算按 2.5 字符/token 计，这段正文约 96 万。
    const bulk = 'x'.repeat(2_400_000)
    const runOnce = async (model: string) => {
      const comp = fakeCompaction(okOutcome)
      const loop = new AgentLoop({
        adapter: okAdapter(),
        registry: new ToolRegistry(),
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: makeCtx,
        compaction: comp.port,
      })
      const events: AgentEvent[] = []
      for await (const ev of loop.run({
        runId: 'rn_envelope' as never,
        history: [{ role: 'user', content: bulk, _group: 'historyMessages', _messageId: 'ms_1' }],
        // 真值 700,000 低于阈值；`throughMessageId` 覆盖这条历史，锚点已计入它。
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
   * 无法压缩不是致命错误：照常发送，由 provider 判定。
   *
   * 「没有可压缩的内容」报告为 `skipped` 而不是 `failed`：显示为失败会使用户排查一个
   * 并不存在的故障。
   */
  test('无法压缩时照常发送，不终止 run', async () => {
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
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
   * **容量拒绝后先压缩一次再重发。**
   *
   * 原始失败形状：占用读数对附件按固定值估算，一份大附件被低估两个数量级 →
   * 发送前检查始终放行 → provider 始终拒绝 → 重试得到同一个估算 → 会话永久停滞，
   * 手动压缩也无法恢复（附件在保留区中）。本用例锁定该失败形状有终态。
   */
  test('容量拒绝：压缩一次使请求变小后重发成功', async () => {
    const comp = shrinkingCompaction()
    const { adapter, state } = rejectingAdapter(1)
    const events = await collectWith(build(adapter, comp.port), 'rn_overflow', bulkyHistory())

    expect(comp.state.runs).toBe(1)
    // 发送了两次：超出窗口的那次 + 压缩后重发的那次。
    expect(state.attempts).toBe(2)
    expect(events.some((e) => e.type === 'run.error')).toBe(false)
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.status).toBe('done')
  })

  /**
   * **压缩后重发是账本中的第二行，不是同一行。**
   *
   * 本用例接入真实 `Store`：其他用例把 `openRequest` 打桩为常量，唯一索引不参与，
   * 两次发送共用一组键也不会报错。实测形状是超出窗口的那次与压缩后重发的那次同为
   * `(run_id, 0, 0)`，第二次插入违反 `uq_provider_run_turn`，异常上抛，整轮因
   * 一条 SQLite 约束报错而失败：压缩无效，模型一次都未作答。
   */
  test('压缩后重发在账本中另记一行，不违反唯一索引', async () => {
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
      contextSnapshot: [],
    })

    const comp = shrinkingCompaction()
    const { adapter, state } = rejectingAdapter(1)
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
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
    // 同一轮、两个发送序号；第一行是超出窗口的那次，第二行是压缩后重发的那次。
    const rows = listProviderRequests(store, run.id)
    expect(rows.map((r) => [r.turnIndex, r.retryIndex])).toEqual([
      [0, 0],
      [0, 1],
    ])
    expect(rows.map((r) => r.status)).toEqual(['rejected', 'received'])
    store.close()
  })

  /**
   * **压缩未使请求变小时不重发。**
   *
   * 同一份字节再发一次只会得到同一个拒绝，而那一次需要支付全额的长 prompt 费用。
   * 判据是「请求是否变小」，不是「压缩返回成功」：收纳段可能已经落库，却未减少任何
   * token。
   */
  test('压缩未使请求变小时不重发，如实上报容量拒绝', async () => {
    // `fakeCompaction` 的投影原样返回：压缩「成功」但请求未减少任何字节。
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
   * 用状态机而不是重试计数：不存在「几次足够」的问题。压缩后仍超出窗口，说明压缩已
   * 无法继续缩减，再压缩一次的输入与上一次逐字相同。
   */
  test('连续超出窗口只恢复一次，不进入死循环', async () => {
    const comp = shrinkingCompaction()
    // 两次都拒绝：第一次触发恢复，重发仍被拒绝 → 直接上报，不再压缩并发送第三次。
    const { adapter, state } = rejectingAdapter(2)
    const events = await collectWith(build(adapter, comp.port), 'rn_twice', bulkyHistory())

    expect(comp.state.runs).toBe(1)
    expect(state.attempts).toBe(2)
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  /**
   * 端口缺省时由构造函数补充一个透传实现，语义与「没有压缩」完全相同：
   * 投影原样返回、压缩报告「没有可折叠的内容」，因此容量拒绝照常上报。
   */
  test('没有压缩端口时容量拒绝照常上报，不静默停滞', async () => {
    const { adapter } = rejectingAdapter(1)
    const events = await collect(build(adapter), 'rn_nocomp')
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  /**
   * **静默截断：provider 不报错，直接丢弃超出的部分。**
   *
   * 实测 deepseek-v4-flash：发出约 200 万 token，自报收到 1,000,086，
   * 窗口正好 1,000,000，全程无错误。错误分类在这类 provider 上无法取得依据，
   * 判据只能由两个真值反推：自报输入达到了模型自身的窗口。
   */
  test('自报输入达到窗口时解除压缩限制，下一步重新折叠', async () => {
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
          // 第一轮：provider 自报输入达到窗口，它丢弃了超出的部分，但没有报错。
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
          yield {
            type: 'tool_calls',
            calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            at: Date.now(),
          }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'text_delta', delta: '完成', at: Date.now() }
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
    // 静默截断已被识别：压缩限制解除，第二步确实折叠了一次。
    expect(comp.state.runs).toBeGreaterThan(0)
  })

  test('非容量错误照常上报', async () => {
    const comp = fakeCompaction(okOutcome)
    // 拒绝次数比重发额度多一次：参数错误与「上游暂时不可用」同归入
    // `provider_unavailable`，会被自动重发（代价说明见 `loop/attempt.ts` 的 `RESENDABLE_CODES`）。
    // 拒绝次数不足时某一次会成功，断言的就是重发路径而不是上报路径。
    const { adapter } = rejectingAdapter(MAX_RESENDS + 1, paramError)
    const events = await collect(build(adapter, comp.port), 'rn_param')
    expect(comp.state.runs).toBe(0)
    expect(events.some((e) => e.type === 'run.error')).toBe(true)
  })
})

describe('投影时机', () => {
  test('每次构造请求都重新投影：使用旧投影会使该次压缩无效', async () => {
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
          yield {
            type: 'tool_calls',
            calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            at: Date.now(),
          }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'text_delta', delta: '完成', at: Date.now() }
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
        }
      },
    }

    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port, registry), 'rn_6')

    // 两轮请求对应两次投影。缓存投影结果重复使用时，压缩生效后的第一轮仍会发送全量历史。
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

/** 第一轮调用一次工具，第二轮结束。两轮之间 transcript 会新增一个单元。 */
function twoTurnAdapter(): LlmAdapter {
  let turn = 0
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic_messages'),
    async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      if (turn++ === 0) {
        yield {
          type: 'tool_calls',
          calls: [{ id: 'c1', name: 'noop', arguments: {} }],
          at: Date.now(),
        }
        yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
      } else {
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
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
    // 1M 窗口 × 0.8 → 软阈值 800,000，锚点直接设在阈值之上。
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
 * 判据是「transcript 是否新增单元」，不是「一个 run 只压缩一次」：后者的前提（run 内没有新的可折叠内容）
 * 在 transcript 参与投影后不再成立，run 内增长的正是工具结果，无法压缩这部分
 * 等于压缩无效。两个方向各锁定一条：
 * 压缩过多（每步一次）与永不再压缩都是回归。
 */
describe('有新的可折叠单元时才再次压缩', () => {
  test('无法压缩但新增了单元：下一步再尝试一次', async () => {
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'nothing_to_fold' })
    await runHigh(build(twoTurnAdapter(), comp.port, noopRegistry()), 'rn_again')
    expect(comp.state.projects).toBe(2)
    expect(comp.state.runs).toBe(2)
  })

  test('折叠成功之后不连续触发：锚点随之作废，读数确实下降', async () => {
    const comp = fakeCompaction(okOutcome)
    const events = await runHigh(build(twoTurnAdapter(), comp.port, noopRegistry()), 'rn_chain')
    expect(comp.state.runs).toBe(1)
    expect(events.filter((e) => e.type === 'compaction' && e.phase === 'started').length).toBe(1)
  })

  test('transcript 未增长时不重试', async () => {
    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 服务端将这一轮拆分返回：没有正文也没有调用，transcript 没有增长。
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

  test('压缩端口取得的占用与窗口即触发判定所用的两个数值', async () => {
    const comp = fakeCompaction(okOutcome)
    await runHigh(build(okAdapter(), comp.port), 'rn_args')
    expect(comp.state.seen[0]!.occupancy).toBe(900_000)
    expect(comp.state.seen[0]!.contextWindow).toBe(1_000_000)
  })
})

/**
 * run 内的执行记录必须能够被折叠。
 *
 * `project()` 必须覆盖 transcript：只作用于 `input.history` 时，transcript 在投影**之后**才拼接，
 * run 内增长的几十批工具结果一条也无法被压缩，而占用增长的正是这部分。
 */
describe('run 内 transcript 参与投影', () => {
  test('投影丢弃带戳的消息时，请求中确实不包含它们', async () => {
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
          yield {
            type: 'tool_calls',
            calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            at: Date.now(),
          }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
        }
      },
    }
    // 将「折叠本 run 的执行记录」执行到底：带戳的消息一律不发送。
    const port: CompactionPort = {
      project: (messages) => messages.filter((m) => !m._step),
      run: async () => okOutcome,
    }
    const loop = new AgentLoop({
      adapter: twoTurn,
      registry,
      systemPrompt: 'sys',
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
      // 只检查装配结果
    }

    expect(seen).toHaveLength(2)
    expect(seen[1]!.messages.some((m) => m.role === 'tool')).toBe(false)
  })
})

/**
 * 单元戳。
 *
 * 运行中的 transcript 与「跨 run 从 steps 投影回历史」必须生成同一个戳，否则同一
 * 单元在两个时刻定位不同，压缩会按两个不同的切分点切分同一段内容。本侧锁定规则本身：
 * 一个波次共用一个戳，取值为波次末 step 的 seq；另一侧见
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
          yield {
            type: 'tool_calls',
            calls: [{ id: 'c1', name: 'noop', arguments: {} }],
            at: Date.now(),
          }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
        } else {
          yield { type: 'text_delta', delta: '完成', at: Date.now() }
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
      // 只检查装配结果
    }

    // 第二次装配时，第一轮的执行波次已在 transcript 中。
    const second = seen[1]!
    const assistant = second.find((m) => m.role === 'assistant' && m.toolCalls?.length)!
    const result = second.find((m) => m.role === 'tool')!
    // 工具 step 取得本 run 的第一个 seq（这一轮没有文本 step）。
    expect(assistant._step).toBe(stepStamp('rn_stamp', 1))
    expect(result._step).toBe(assistant._step)
    expect(assistant._messageId).toBe('ms_001')
    expect(result._messageId).toBe('ms_001')
  })
})

/**
 * 触发线。
 *
 * 复现的原始失败形状：1M 窗口的 deepseek 档位，软阈值只有 366,000
 * （36.6%）：阈值减去了模型的全部输出**规格上限**，因此同为 1M 窗口的两个
 * 模型会得到两个完全不同的阈值。
 */
describe('软阈值只由窗口决定', () => {
  test('1M / 384K 档：触发线是 800,000，不是 366,000', () => {
    expect(softLimit(lookupModel('deepseek-flash', 'openai_chat_completions'))).toBe(800_000)
  })

  test('每一档都是窗口的 80%', () => {
    expect(softLimit(lookupModel('claude-opus-5', 'anthropic_messages'))).toBe(800_000)
    expect(softLimit(lookupModel('claude-haiku-4-5', 'anthropic_messages'))).toBe(160_000)
    expect(softLimit({ contextWindow: 128_000 })).toBe(102_400)
    expect(softLimit({ contextWindow: 32_000 })).toBe(25_600)
  })

  /** 触发线不得随模型的输出上限变化：这正是 366,000 与 622,000 并存的成因。 */
  test('同一窗口下更换输出上限，触发线不变', () => {
    const a = lookupModel('deepseek-flash', 'openai_chat_completions')
    const b = lookupModel('claude-opus-5', 'anthropic_messages')
    expect(a.maxOutputTokens).not.toBe(b.maxOutputTokens)
    expect(softLimit(a)).toBe(softLimit(b))
  })
})

/** 装配时捕获实际发出的请求，用于验证申报值。 */
function capturingAdapter(spec: LlmAdapter['spec']) {
  const seen: ChatRequest[] = []
  const adapter: LlmAdapter = {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      yield { type: 'text_delta', delta: '完成', at: Date.now() }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
  }
  return { adapter, seen }
}

describe('缓存断点', () => {
  test('上下文跟随所属用户；断点落在当前已接受消息末尾', async () => {
    const { adapter, seen } = capturingAdapter(lookupModel('claude-opus-5', 'anthropic_messages'))
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: makeCtx,
    })
    for await (const _ of loop.run({
      runId: 'rn_brk' as never,
      history: [
        {
          role: 'context',
          content: '今天是周三',
          _group: 'workspaceState',
          _messageId: 'ms_001',
        },
        { role: 'user', content: '第一句', _messageId: 'ms_001' },
        { role: 'assistant', content: '好的', _messageId: 'ms_001' },
      ],
      signal: new AbortController().signal,
    })) {
      // 只检查装配结果
    }

    const messages = seen[0]!.messages
    expect(messages.map((message) => message.role)).toEqual(['context', 'user', 'assistant'])
    expect(messages[2]!.cacheBreakpoint).toBe(true)
  })

  /**
   * 复现的是原始失败形状：会话 `cv_0mszld8o60000yi2u5m` 的 rn_0mszqkz8d 产出约
   * 1.4 万 token 的 grep 结果，下一轮 rn_0mszqmhqh 只命中 192。
   *
   * 成因是装配顺序：注记位于 history 与 transcript 之间时，跨 run 的公共前缀
   * 止于上一轮 history 末尾，上一轮执行产生的全部工具结果必然按全价重新计费。
   *
   * 因此断言针对**字节**：下一轮首个请求与上一轮最后一个请求的最长公共前缀，
   * 必须长于上一轮的工具结果。注记位于 history 与 transcript 之间时，该断言必然失败。
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
      spec: lookupModel('deepseek-flash', 'openai_chat_completions'),
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        seen.push(req)
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 第一轮：调用一次 grep，产生一大段工具结果；之后只输出正文。
        if (turn++ === 0) {
          yield {
            type: 'tool_calls',
            calls: [{ id: 'c1', name: 'grep', arguments: {} }],
            at: Date.now(),
          }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: 'tool_calls' }
          return
        }
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'stop' }
      },
    }

    const build = () =>
      new AgentLoop({
        adapter,
        registry,
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: makeCtx,
      })

    const history: WireMessage[] = [
      {
        role: 'context',
        content: '工作区：/tmp/ws',
        _group: 'workspaceState',
        _messageId: 'ms_001',
      },
      { role: 'user', content: '找 bug', _messageId: 'ms_001' },
    ]
    for await (const _ of build().run({
      runId: 'rn_a' as never,
      history,
      signal: new AbortController().signal,
    })) {
      // 执行完第一轮
    }

    // 第一轮的产出并入历史，第二轮新开一个 run：这正是账本中那两轮的关系。
    const carried: WireMessage[] = [
      ...history,
      ...seen[seen.length - 1]!.messages.filter((m) => m._group === 'executionRecords'),
      {
        role: 'context',
        content: '工作区：/tmp/ws',
        _group: 'workspaceState',
        _messageId: 'ms_002',
      },
      { role: 'user', content: '全部都做一下', _messageId: 'ms_002' },
    ]
    const before = seen.length
    for await (const _ of build().run({
      runId: 'rn_b' as never,
      history: carried,
      signal: new AbortController().signal,
    })) {
      // 执行完第二轮
    }

    /*
     * 比较的是**实际发送的字节**，因此必须剥离内部标记：`cacheBreakpoint` 在兼容协议上
     * 不发送任何字节（`openai-compat.ts` 从不读取它），`_group` / `_messageId` /
     * `_step` 同理。不剥离时断言测试的是内部结构，而不是缓存看到的字节；
     * 而 history 末尾的断点本应随历史增长后移。
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
    // 这段大体量的工具结果必须位于公共前缀之内。注记位于 history 与 transcript 之间时，公共前缀止于 history 末尾。
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
   * 高占用时静态申报规格上限会导致 `输入 + max_tokens > 窗口`，provider 直接拒绝。
   * 申报值表示「本轮还能容纳多少输出」。
   *
   * **还需预留一份余量。** 占用是估算值，估算低估多少，申报就超出多少；
   * 该 400 若被容量分类判定为超出窗口，会多执行一次无效的有损压缩来补救一个申报错误。
   * 断言写成区间而不是等式：余量比例调整时本用例不应整体失败，
   * 它锁定的是「申报之后仍能容纳，且未占满剩余空间」。
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
    // 可以容纳：申报值加占用不超过窗口，且距窗口仍有余量。
    expect(occupancy + declared).toBeLessThan(spec.contextWindow)
    // 未占满剩余空间：确实预留了余量。
    expect(declared).toBeLessThan(room)
  })
})

describe('压缩被中断', () => {
  /**
   * 中断的压缩没有落库任何内容，因此事件流与账本中都不应留下终态。
   * 停止时多显示一张错误卡片是噪音，而记录一条 step 会使「没有发生任何操作」看似发生过操作。
   */
  test('不发送终态事件、不记录 step，run 以中断结束', async () => {
    const comp = fakeCompaction({ status: 'aborted' })
    const recorded: RecordedCompaction[] = []
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
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
      expect.objectContaining({
        phase: 'done',
        manifestRevision: 1,
        compactedMessages: 0,
        summarized: true,
        trigger: 'automatic',
        occupancy: 900_000,
      }),
    ])
  })

  /** 只收纳而未摘要时也必须标明：否则用户看到的与一次完整压缩完全相同。 */
  test('只收纳时 summarized 为 false', async () => {
    const comp = fakeCompaction({ ...okOutcome, summarized: false })
    const recorded: RecordedCompaction[] = []
    const loop = new AgentLoop({
      adapter: okAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
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
      // 只检查落库结果
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
      // 只检查落库结果
    }
    expect(recorded[0]?.phase).toBe('skipped')
    expect(recorded[0]?.reasonCode).toBe('nothing_to_fold')
  })
})

/**
 * 调用摘要器的压缩端口：通过 `trace` 把摘要请求记录为本轮的普通请求。
 * 投影在压缩之后变小，重发才有意义。
 */
function summarizingCompaction(outcome: CompactionOutcome) {
  const state = { runs: 0, folded: false }
  const port: CompactionPort = {
    project: (messages) =>
      state.folded ? messages.map((m) => ({ ...m, content: '折' })) : messages,
    run: async (runInput: CompactionRunInput) => {
      state.runs++
      state.folded = true
      const trace = runInput.trace
      if (trace) {
        const id = trace.open({
          model: 'claude-opus-5',
          system: [{ text: '你是会话摘要器。' }],
          messages: [{ role: 'user', content: '摘要提示词' }],
          tools: [],
          maxOutputTokens: null,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        })
        trace.sent(id)
        trace.firstEvent(id)
        trace.settle(
          id,
          'received',
          {
            inputTokens: 7,
            outputTokens: 3,
            cachedTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: 0,
            source: 'provider',
          },
          null,
          'end_turn',
        )
      }
      return outcome
    },
  }
  return { port, state }
}

/** 与 `okAdapter` 结构相同，只多报告一次 usage：此处需要检查 usage 中是否有两笔。 */
function usageAdapter(): LlmAdapter {
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic_messages'),
    async *stream(_req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      yield { type: 'request_prepared', measuredInputTokens: 10 }
      yield { type: 'text_delta', delta: '完成', at: Date.now() }
      yield {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: null,
          cacheWriteTokens: null,
          reasoningTokens: 0,
          source: 'provider',
        },
      }
      yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
    },
  }
}

function storedRun() {
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, 'C:/ws', 'ws')
  const conv = createConversation(store, { workspaceId: ws.id, provider: 'p', model: 'm' })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: 'req-summary',
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const persist: LoopPersistence = {
    ...noopPersistence(),
    openRequest: (input) => openProviderRequest(store, input).id,
    markRequestSent: (id) => markProviderRequestSent(store, id as never),
    settleRequest: (id, status, usage, errorCode, finishReason) =>
      settleProviderRequest(store, id as never, status, usage, errorCode, finishReason),
  }
  return { store, run, persist }
}

/**
 * 压缩时的摘要请求是本轮的普通请求：发出前写入 provider_requests（purpose = summary），
 * 占用一个 turn 编号，报告的 usage 计入本轮。锁定的失败形状：摘要请求只记录在账本中时，
 * 逐请求表不显示它，运行面板另起一行按时间排序。
 */
describe('摘要请求按普通请求记账', () => {
  test('发送前压缩：摘要请求占 turn 0，主请求顺延到 turn 1，usage 含两笔', async () => {
    const { store, run, persist } = storedRun()
    const comp = summarizingCompaction(okOutcome)
    const saved: RunUsage[] = []
    const loop = new AgentLoop({
      adapter: usageAdapter(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: { ...persist, saveUsage: (_id, usage) => saved.push(structuredClone(usage)) },
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: run.id,
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
    expect(comp.state.runs).toBe(1)
    const rows = listProviderRequests(store, run.id)
    expect(rows.map((r) => [r.turnIndex, r.retryIndex, r.purpose, r.status])).toEqual([
      [0, 0, 'summary', 'received'],
      [1, 0, 'turn', 'received'],
    ])
    expect(rows[0]?.providerOutputTokens).toBe(3)
    // 压缩结束时立即产生一条 usage 事件，此时只包含摘要请求的用量。
    const first = events.find((e) => e.type === 'usage')
    expect(first?.type === 'usage' && first.usage.inputTokens).toBe(7)
    const last = saved.at(-1)
    expect(last?.turns.map((t) => [t.turnIndex, t.input])).toEqual([
      [0, 7],
      [1, 10],
    ])
    expect(last?.inputTokens).toBe(17)
    store.close()
  })

  test('容量拒绝后压缩：被拒、摘要、重发各占一个 turn，按发生顺序排列', async () => {
    const { store, run, persist } = storedRun()
    const comp = summarizingCompaction(okOutcome)
    const { adapter, state } = rejectingAdapter(1)
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist,
      makeToolContext: makeCtx,
      compaction: comp.port,
    })
    const events = await collectWith(loop, run.id, bulkyHistory())
    expect(events.some((e) => e.type === 'run.error')).toBe(false)
    expect(state.attempts).toBe(2)
    const rows = listProviderRequests(store, run.id)
    expect(rows.map((r) => [r.turnIndex, r.retryIndex, r.purpose, r.status])).toEqual([
      [0, 0, 'turn', 'rejected'],
      [1, 0, 'summary', 'received'],
      [2, 0, 'turn', 'received'],
    ])
    store.close()
  })
})
