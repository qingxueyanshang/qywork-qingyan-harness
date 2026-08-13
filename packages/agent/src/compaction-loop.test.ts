/**
 * 压缩与主循环的接线测试。
 *
 * `compaction.test.ts` 验的是压缩算法本身；这里验的是**拒绝 → 压缩 → 重发**
 * 这条控制流真的走通了。两者分开是因为前者纯函数、后者要造 provider 拒绝，
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
    saveContext: () => {},
  }
}

function makeCtx(): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn' as never,
    model: 'test',
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

describe('拒绝驱动的压缩', () => {
  test('容量拒绝触发压缩并重发，run 正常收尾', async () => {
    const { adapter, state } = rejectingAdapter(1)
    const comp = fakeCompaction(okOutcome)
    const events = await collect(build(adapter, comp.port), 'rn_1')

    expect(comp.state.runs).toBe(1)
    // 第一次被拒、第二次成功 —— 证明重发真的发生了，而不是把错误吞掉了事。
    expect(state.attempts).toBe(2)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'started')).toBe(true)
    expect(events.some((e) => e.type === 'compaction' && e.phase === 'done')).toBe(true)

    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('压缩次数有上限 —— 压不动时不无限烧钱', async () => {
    const { adapter, state } = rejectingAdapter(99)
    const comp = fakeCompaction(okOutcome)
    const events = await collect(build(adapter, comp.port), 'rn_2')

    // 上限 2 次压缩 → 最多 3 次请求。没有上限的话这里会一直转下去，
    // 每转一圈烧一次摘要调用。
    expect(state.attempts).toBeLessThanOrEqual(3)
    expect(comp.state.runs).toBeLessThanOrEqual(2)
    expect(events.some((e) => e.type === 'run.error' && e.code === 'context_overflow')).toBe(true)
  })

  test('压不动时上报原始的容量错误，不吞成「压缩失败」', async () => {
    const { adapter } = rejectingAdapter(99)
    const comp = fakeCompaction({ status: 'skipped', reasonCode: 'too_few_messages' })
    const events = await collect(build(adapter, comp.port), 'rn_3')

    expect(
      events.some(
        (e) =>
          e.type === 'compaction' && e.phase === 'failed' && e.reasonCode === 'too_few_messages',
      ),
    ).toBe(true)
    // 用户要知道的是「上下文超了」；压缩失败只是没能自动解决而已，
    // 报成压缩失败会让人去查压缩配置，而真正该做的是精简会话。
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('context_overflow')
  })

  test('没有压缩端口时容量拒绝直接上报，不静默卡住', async () => {
    const { adapter, state } = rejectingAdapter(1)
    const events = await collect(build(adapter), 'rn_4')

    expect(state.attempts).toBe(1)
    expect(events.some((e) => e.type === 'run.error' && e.code === 'context_overflow')).toBe(true)
  })

  test('非容量错误不触发压缩 —— 压缩解决不了参数错误', async () => {
    const { adapter } = rejectingAdapter(99, paramError)
    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port), 'rn_5')

    // 一次都不该压。判宽了会变成「压缩 → 重发 → 同样的参数错误」的烧钱死循环。
    expect(comp.state.runs).toBe(0)
  })
})

/**
 * 否掉明显不成立的容量信号。
 *
 * 起因是实测撞到过一次：1963 token 的输入，模型窗口 100 万，却收到容量拒绝，
 * 白烧了一次摘要调用。差了 500 倍的信号不该被当真。
 *
 * **这不违背「拒绝驱动」**：本地数字没有资格让压缩**发生**，
 * 只有资格在差了一个量级以上时**否掉**一个信号。方向相反，不是同一件事。
 */
describe('容量信号的兜底否决', () => {
  /** 文案强匹配、但 provider 一个数字都没自报 —— 最脆弱的那条判定路径。 */
  function numberlessCapacityError(): unknown {
    const err = new Error('prompt is too long') as Error & { status: number }
    err.status = 400
    return classifyProviderError('anthropic', err)
  }

  /** measure 可控的 adapter：本地测得多少 token 由这里说了算。 */
  function measuringAdapter(measured: number, makeError: () => unknown, rejectTimes = 99) {
    const state = { attempts: 0 }
    const adapter: LlmAdapter = {
      kind: 'anthropic',
      transmits: { thinking: true, effort: true },
      // claude-opus-5 的窗口是 100 万，正好对上实测那次的量级差。
      spec: lookupModel('claude-opus-5', 'anthropic'),
      measure: async () => measured,
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        state.attempts++
        if (state.attempts <= rejectTimes) throw makeError()
        yield { type: 'done', stopReason: 'end_turn' }
      },
    }
    return { adapter, state }
  }

  test('1963 token 对 100 万窗口 —— 跳过压缩，原始错误照样上报', async () => {
    const { adapter, state } = measuringAdapter(1963, numberlessCapacityError)
    const comp = fakeCompaction(okOutcome)
    const events = await collect(build(adapter, comp.port), 'rn_c1')

    // 一次摘要调用都不该花。
    expect(comp.state.runs).toBe(0)
    // 也不该重发 —— 跳过压缩不等于重试。
    expect(state.attempts).toBe(1)
    // **不吞错误**：「这条拒绝可疑」和「这次请求成功了」是两回事。
    expect(events.some((e) => e.type === 'run.error' && e.code === 'context_overflow')).toBe(true)
  })

  /**
   * provider 自报了数字就是一次带证据的拒绝，本地估算没资格推翻它。
   * `capacityError()` 的文案是「213000 tokens > 200000 maximum」。
   */
  test('provider 自报了数字时不否决，照常压缩', async () => {
    const { adapter } = measuringAdapter(1963, capacityError)
    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port), 'rn_c2')

    expect(comp.state.runs).toBeGreaterThan(0)
  })

  /**
   * 原生容量码是端点自己说的，没什么可怀疑的。只有文案匹配才可能认错。
   */
  test('判据是 provider 原生容量码时不否决', async () => {
    const withCode = (): unknown => {
      const err = Object.assign(new Error('too long'), {
        status: 400,
        body: { error: { code: 'context_length_exceeded' } },
      })
      return classifyProviderError('anthropic', err)
    }
    const { adapter } = measuringAdapter(1963, withCode)
    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port), 'rn_c3')

    expect(comp.state.runs).toBeGreaterThan(0)
  })

  /**
   * 量级差不够就不否决。本地估算对中文会低估，倍率必须留足余量——
   * 判错的代价是「该压的没压」，那比「白压一次」严重得多。
   */
  test('输入只比窗口小几倍时不否决 —— 估算不准，留足余量', async () => {
    const { adapter } = measuringAdapter(500_000, numberlessCapacityError)
    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port), 'rn_c4')

    expect(comp.state.runs).toBeGreaterThan(0)
  })

  /** measure 炸了不能连累主路径：测不出来就按「不知道」处理，照常压缩。 */
  test('measure 失败时不否决', async () => {
    const state = { attempts: 0 }
    const adapter: LlmAdapter = {
      kind: 'anthropic',
      transmits: { thinking: true, effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic'),
      measure: async () => {
        throw new Error('探测失败')
      },
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        state.attempts++
        if (state.attempts <= 99) throw numberlessCapacityError()
        yield { type: 'done', stopReason: 'end_turn' }
      },
    }
    const comp = fakeCompaction(okOutcome)
    await collect(build(adapter, comp.port), 'rn_c5')

    expect(comp.state.runs).toBeGreaterThan(0)
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
