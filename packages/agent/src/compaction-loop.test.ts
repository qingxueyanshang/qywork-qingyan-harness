/**
 * 压缩与主循环的接线测试。
 *
 * `compaction.test.ts` 验的是压缩算法本身；这里验的是**发送前检查 → 压缩 →
 * 重新装配**这条控制流真的走通了。两者分开是因为前者纯函数、后者要造占用压力，
 * 混在一起会让「算法对不对」和「接线对不对」在失败时分不出来。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent } from '@qywork/ai'
import { classifyProviderError, lookupModel } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import type { CompactionOutcome } from './compaction.ts'
import type { CompactionPort, LoopPersistence, ToolContext } from './index.ts'
import { AgentLoop } from './loop.ts'
import { ToolRegistry } from './registry.ts'

function noopPersistence(): LoopPersistence {
  let seq = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: () => `st_${seq}`,
    appendText: () => {},
    openToolStep: () => `st_${seq}`,
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: () => {},
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
  return classifyProviderError('anthropic', err)
}

function paramError(): unknown {
  const err = new Error('max_tokens must be less than or equal to 8192') as Error & {
    status: number
  }
  err.status = 400
  return classifyProviderError('anthropic', err)
}

/** 前 N 次以给定错误失败，之后正常。用来验证「压缩后重发」真的发生。 */
function rejectingAdapter(rejectTimes: number, makeError = capacityError) {
  const state = { attempts: 0 }
  const adapter: LlmAdapter = {
    kind: 'anthropic',
    transmits: { thinking: true, effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic'),
    measure: async () => 0,
    async *stream(_req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      state.attempts++
      if (state.attempts <= rejectTimes) throw makeError()
      yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
      yield { type: 'text_delta', delta: '压缩后完成' }
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
  return { adapter, state }
}

/** 一路正常的 adapter。 */
function okAdapter(): LlmAdapter {
  return {
    kind: 'anthropic',
    transmits: { thinking: true, effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic'),
    measure: async () => 0,
    async *stream(_req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
      yield { type: 'text_delta', delta: '完成' }
      yield { type: 'done', stopReason: 'end_turn' }
    },
  }
}

const okOutcome: CompactionOutcome = {
  status: 'compacted',
  usedModel: false,
  manifest: {
    revision: 1,
    compactedThroughMessageId: null,
    compactedMessageCount: 0,
    summary: '摘要',
    facts: { filesTouched: [], openItems: [], userConstraints: [] },
    createdAt: 0,
  },
}

function fakeCompaction(outcome: CompactionOutcome) {
  const state = { runs: 0, projects: 0 }
  const port: CompactionPort = {
    project: (h) => {
      state.projects++
      return h
    },
    run: async () => {
      state.runs++
      return outcome
    },
  }
  return { port, state }
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
   * 这是「不在根本不需要的时候损失信息」那条原则的落点——原来靠「等 provider
   * 亲口说超了」实现，现在靠阈值本身足够高（窗口 − 输出预留 − 一个批级预算）。
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
      // 1M 窗口、128k 输出预留、1/4 批级余量 → 软阈值 622,000。
      anchor: { tokens: 700_000, throughMessageId: null },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    expect(comp.state.runs).toBeGreaterThan(0)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'started')).toBe(true)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'done')).toBe(true)
    expect(events.find((e) => e.type === 'run.finished')?.type).toBe('run.finished')
  })

  /** 压不动不是致命错：照常发出去，让 provider 来判。 */
  test('压不动时照常发送，不把 run 掐死', async () => {
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'too_few_messages' })
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
      anchor: { tokens: 700_000, throughMessageId: null },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'failed')).toBe(true)
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.status).toBe('done')
  })

  /**
   * **容量拒绝不再触发压缩，只如实报错。**
   *
   * 两个触发就是两个执行入口。保留拒绝那条路做保底看着更稳，实际是把
   * A2 第五问的「否」变成「不是明确的否」，而它换来的只是一次注定失败的
   * 长请求外加一套重试状态。
   */
  test('容量拒绝直接上报，不再触发压缩重发', async () => {
    const comp = fakeCompaction(okOutcome)
    const { adapter, state } = rejectingAdapter(1)
    const events = await collect(build(adapter, comp.port), 'rn_reject')

    expect(comp.state.runs).toBe(0)
    // 只发了一次——没有「压完再来一次」。
    expect(state.attempts).toBe(1)
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  test('没有压缩端口时容量拒绝照样上报，不静默卡住', async () => {
    const { adapter } = rejectingAdapter(1)
    const events = await collect(build(adapter), 'rn_nocomp')
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  test('非容量错误照常上报', async () => {
    const comp = fakeCompaction(okOutcome)
    const { adapter } = rejectingAdapter(1, paramError)
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
      kind: 'anthropic',
      transmits: { thinking: true, effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic'),
      measure: async () => 0,
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
        if (turn++ === 0) {
          yield { type: 'tool_calls', calls: [{ id: 'c1', name: 'noop', arguments: {} }] }
          yield { type: 'done', stopReason: 'tool_use' }
        } else {
          yield { type: 'text_delta', delta: '完成' }
          yield { type: 'done', stopReason: 'end_turn' }
        }
      },
    }

    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port, registry), 'rn_6')

    // 两轮请求 = 两次投影。缓存一次投影结果重复用，压缩生效后第一轮仍会发全量历史。
    expect(comp.state.projects).toBe(2)
  })
})
