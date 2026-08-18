import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireToolCall } from '@qywork/ai'
import { lookupModel, ProviderError } from '@qywork/ai'
import type { AgentEvent } from '@qywork/core'
import { CONTEXT_GROUPS } from '@qywork/core'
import { AgentLoop, type LoopPersistence, type ToolContext } from './index.ts'
import { ToolRegistry, type ToolSpec } from './registry.ts'

/** 按脚本回放的假 adapter：每次 stream() 吐出预设的一轮。 */
function fakeAdapter(turns: (WireToolCall[] | null)[], model = 'claude-opus-5'): LlmAdapter {
  let turn = 0
  return {
    kind: 'anthropic',
    transmits: { thinking: true, effort: true },
    spec: lookupModel(model, model === 'claude-opus-5' ? 'anthropic' : 'openai_compatible'),
    measure: async () => 0,
    async *stream(_req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      const calls = turns[turn++] ?? null
      yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
      if (calls) {
        yield { type: 'tool_calls', calls }
      } else {
        yield { type: 'text_delta', delta: '完成' }
      }
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
      yield { type: 'done', stopReason: calls ? 'tool_use' : 'end_turn' }
    },
  }
}

function noopPersistence(): LoopPersistence {
  let seq = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: () => `st_text_${seq}`,
    appendText: () => {},
    openToolStep: () => `st_tool_${seq}`,
    markExecuting: () => {},
    settleTool: () => {},
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: () => 'pr_test',
    markRequestSent: () => {},
    settleRequest: () => {},
  }
}

function call(name: string, args: Record<string, unknown> = {}): WireToolCall {
  return { id: `c_${Math.random().toString(36).slice(2)}`, name, arguments: args }
}

/** 最小可用的 ToolContext。测试只关心 loop 的编排，工具本身不碰这些字段。 */
function baseCtx(runId: string, emit: (e: AgentEvent) => void): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId,
    model: 'test',
    contextWindow: 200_000,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: (channel, delta) =>
      emit({ type: 'tool.delta', runId: runId as never, stepId: 'st' as never, channel, delta }),
    requestPermission: async () => true,
  }
}

describe('ToolContext 生命周期', () => {
  /**
   * 回归测试：ctx.state 必须跨轮、跨波次保持同一个对象。
   *
   * 每个执行波次重建一次 ToolContext 的话，files 工具记录的「本轮读过哪些文件」
   * 立刻丢失，写入守卫把刚读过的文件判成没读过。实测后果：模型绕开写入工具改用
   * shell 手写文件，写出了 BOM + CR 换行的坏文件。
   */
  test('state 跨轮与跨波次共享同一对象', async () => {
    const registry = new ToolRegistry()
    const seenStates: (Map<string, unknown> | undefined)[] = []

    registry.register({
      name: 'remember',
      description: '把一个值写进 ctx.state，供后续调用读取。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '状态',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn(_args, ctx) {
        seenStates.push(ctx.state)
        const prev = (ctx.state.get('count') as number | undefined) ?? 0
        ctx.state.set('count', prev + 1)
        return { status: 'success', message: `count=${prev + 1}` }
      },
    })

    let captured: ToolContext | null = null
    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('remember'), call('remember')], [call('remember')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => {
        const ctx: ToolContext = {
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: (channel, delta) =>
            emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
          requestPermission: async () => true,
        }
        captured = ctx
        return ctx
      },
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    // 三次调用横跨两轮模型响应、多个波次。
    expect(seenStates).toHaveLength(3)
    // 关键断言：全部是同一个 Map 实例。
    expect(seenStates[1]).toBe(seenStates[0]!)
    expect(seenStates[2]).toBe(seenStates[0]!)
    expect(captured!.state.get('count')).toBe(3)

    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished).toBeDefined()
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('makeToolContext 每个 run 只调用一次', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'noop',
      description: '什么都不做，用于计数。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => ({ status: 'success' as const, message: 'ok' }),
    })

    let created = 0
    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('noop')], [call('noop')], [call('noop')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => {
        created++
        return {
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: (channel, delta) =>
            emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
          requestPermission: async () => true,
        }
      },
    })

    for await (const _ of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // drain
    }

    expect(created).toBe(1)
  })
})

describe('权限拒绝', () => {
  test('被拒后停止本 run，stopReason=permission_denied', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'danger',
      description: '有副作用的操作，用于验证权限闸。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'write',
      objectLabel: '文件',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'write',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: 'done' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('danger')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        emit: (channel, delta) =>
          emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
        requestPermission: async () => false,
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    // 被拒的调用绝不能真的执行。
    expect(executed).toBe(0)
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('permission_denied')
  })
})

/**
 * 流空闲超时。
 *
 * `stream_idle_timeout` 必须真的有人发。没有生产者的话，provider 侧抖一下 run
 * 就那么挂着，既不出错也不结束，用户看到的是一个永远转圈的界面——实测撞到过。
 */
describe('流卡死要有终态，不能无限期挂着', () => {
  /** 吐第一个事件之后就沉默，直到被 abort。 */
  function stallingAdapter(opts: { stallAfterFirst: boolean }): LlmAdapter & { aborted: boolean } {
    const self = {
      kind: 'anthropic' as const,
      transmits: { thinking: true, effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic'),
      measure: async () => 0,
      aborted: false,
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        if (opts.stallAfterFirst) {
          yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
        }
        await new Promise<void>((resolve) => {
          req.signal?.addEventListener('abort', () => {
            self.aborted = true
            resolve()
          })
        })
      },
    }
    return self
  }

  function loopWith(adapter: LlmAdapter) {
    const registry = new ToolRegistry()
    return new AgentLoop({
      adapter,
      registry,
      systemPrompt: 's',
      tailNotes: () => [],
      makeToolContext: () => ({}) as ToolContext,
      persist: noopPersistence(),
      streamIdleTimeoutMs: 150,
    })
  }

  test('首个事件就迟迟不来 —— 报 stream_idle_timeout 并收尾', async () => {
    const events: string[] = []
    let code: string | undefined
    let retryable: boolean | undefined
    for await (const ev of loopWith(stallingAdapter({ stallAfterFirst: false })).run({
      runId: 'rn_1' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev.type)
      if (ev.type === 'run.error') {
        code = ev.code
        retryable = ev.retryable
      }
    }
    expect(code).toBe('stream_idle_timeout')
    // 卡死通常是一过性的，重试有意义——前端据此给重试按钮。
    expect(retryable).toBe(true)
    // 关键：必须有终态。没有 run.finished 的话账本里躺着一条永远 running 的记录。
    expect(events).toContain('run.finished')
  }, 10_000)

  test('流到一半断供也判超时', async () => {
    let code: string | undefined
    for await (const ev of loopWith(stallingAdapter({ stallAfterFirst: true })).run({
      runId: 'rn_2' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.error') code = ev.code
    }
    expect(code).toBe('stream_idle_timeout')
  }, 10_000)

  test('超时会中止底层请求 —— 不然那条连接一直挂着', async () => {
    const adapter = stallingAdapter({ stallAfterFirst: false })
    for await (const _ of loopWith(adapter).run({
      runId: 'rn_3' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只是把流跑完
    }
    expect(adapter.aborted).toBe(true)
  }, 10_000)

  test('正常流不受影响 —— 超时计的是间隔不是总时长', async () => {
    const events: string[] = []
    for await (const ev of loopWith(fakeAdapter([null])).run({
      runId: 'rn_4' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev.type)
    }
    expect(events).not.toContain('run.error')
    expect(events).toContain('run.finished')
  })
})

describe('上下文分组占用', () => {
  /**
   * 回归测试：**压缩之后 breakdown 必须跟着变**。
   *
   * `breakdownOf` 算的是 `req.messages`，而那是 `compaction.project()` 的产物。
   * 如果哪天有人图省事改成「直接读 input.history」，这条会红——
   * 而界面上的表现是：压缩明明生效了（模型确实看不到远期历史了），
   * 占用面板却一动不动，用户会以为压缩没起作用，然后反复点压缩。
   */
  test('压缩投影之后，历史那一桶让位给摘要桶', async () => {
    const registry = new ToolRegistry()
    const long = '历史正文'.repeat(200)

    const captured: { historyMessages: number; summary: number }[] = []
    const makeLoop = (projected: boolean) =>
      new AgentLoop({
        adapter: fakeAdapter([null]),
        registry,
        systemPrompt: 'sys',
        tailNotes: () => [],
        persist: noopPersistence(),
        // project() 模拟压缩：把历史换成一条 summary。这正是 RuntimeCompaction 的形状。
        compaction: {
          project: (history) =>
            projected
              ? [{ role: 'assistant', content: '压缩摘要', _group: 'summary' as const }]
              : history,
          run: async () => ({ status: 'skipped', reasonCode: 'nothing_to_compact' }) as never,
        },
        makeToolContext: (runId, emit) => ({
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: (channel, delta) =>
            emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
          requestPermission: async () => true,
        }),
      })

    for (const projected of [false, true]) {
      const events = []
      for await (const ev of makeLoop(projected).run({
        runId: 'rn_proj' as never,
        history: [{ role: 'user', content: long, _group: 'historyMessages' }],
        signal: new AbortController().signal,
      })) {
        events.push(ev)
      }
      const ctx = events.find((e) => e.type === 'context')
      const b = ctx?.type === 'context' ? ctx.breakdown : null
      expect(b).toBeDefined()
      captured.push({ historyMessages: b!.historyMessages, summary: b!.summary })
    }

    const [before, after] = captured
    // 未压缩：历史那一桶很大、摘要为 0。
    expect(before!.historyMessages).toBeGreaterThan(100)
    expect(before!.summary).toBe(0)
    // 压缩后：摘要有了，历史那一桶塌下去。
    expect(after!.summary).toBeGreaterThan(0)
    expect(after!.historyMessages).toBeLessThan(before!.historyMessages)
  })

  /**
   * 回归测试：`context` 事件的 `breakdown` 必须是**真值**。
   *
   * 「字段在、值是假的」比没有这个字段更坏：界面照着它画出来的饼图会是空的，
   * 而没人能从界面看出那是假数据。
   *
   * 断言的是**口径**不是具体数字：系统提示词与工具 schema 各自非零、
   * 带 `_group` 的消息落进对应的桶、不带 `_group` 的落进 historyMessages。
   */
  test('breakdown 不是七个零，且按 _group 分桶', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'noop',
      description: '占位工具，只为让 tools schema 非空。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空操作',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        return { status: 'success', message: 'ok' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry,
      systemPrompt: '这是一段足够长的系统提示词，用来让 systemPrompt 那一桶明确非零。',
      // 尾区注记 → workspaceState 桶。
      tailNotes: () => [
        { content: '当前工作区状态：分支 main，无未提交改动。', group: 'workspaceState' as const },
      ],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        emit: (channel, delta) =>
          emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
        requestPermission: async () => true,
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_breakdown' as never,
      history: [
        { role: 'user', content: '历史消息一', _group: 'historyMessages' },
        { role: 'assistant', content: '这是上一轮的摘要', _group: 'summary' },
        // 不带 _group：按口径落进 historyMessages，不单开「其他」桶。
        { role: 'user', content: '没有分组标记的消息' },
      ],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type).toBe('context')
    const b = ctx?.type === 'context' ? ctx.breakdown : null
    expect(b).toBeDefined()

    expect(b!.systemPrompt).toBeGreaterThan(0)
    // 内置工具进 systemTools，不进已删的 toolSchemas；本例没有 mcp__ 工具。
    expect(b!.systemTools).toBeGreaterThan(0)
    expect(b!.mcpTools).toBe(0)
    expect(b!.summary).toBeGreaterThan(0)
    expect(b!.workspaceState).toBeGreaterThan(0)
    // 两条历史（一条带标记、一条不带）都归到 historyMessages。
    expect(b!.historyMessages).toBeGreaterThan(0)
    // 全零就是这条测试要挡的那个回归。
    expect(Object.values(b!).some((v) => v > 0)).toBe(true)
    // 桶集必须与协议恒等：多一个少一个都说明有人又另立了一套。
    expect(Object.keys(b!).sort()).toEqual([...CONTEXT_GROUPS].sort())
  })
})

describe('原地打转', () => {
  /**
   * 复现要挡的形状：模型用一模一样的参数反复调同一个只读工具，拿到一模一样的
   * 结果。之前这会一路烧到 `max_steps`——几十轮 provider 往返，最后报一个
   * 「已达步数上限」，而那个原因是错的：多给一百步也一样。
   */
  test('同样的调用同样的结果三轮之后停下，stopReason=no_progress', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'stuck',
      description: '永远返回同一个结果，用于验证空转判定。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: '还是这些' }
      },
    })

    // 脚本给足十轮，如果判定没生效它会一路跑完。
    const turns = Array.from({ length: 10 }, () => [call('stuck')])
    const loop = new AgentLoop({
      adapter: fakeAdapter(turns),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        emit: () => {},
        requestPermission: async () => true,
      }),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_stuck' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('no_progress')
    // 停在第三轮，不是第十轮——这条数字就是这个改动的全部价值。
    expect(executed).toBe(3)
  })

  /** 结果每轮都在变（轮询等待）就不该被判成打转，得让它跑完。 */
  test('结果在变的不判，跑满脚本', async () => {
    const registry = new ToolRegistry()
    let n = 0
    registry.register({
      name: 'poll',
      description: '每次返回不同结果，模拟轮询等待。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => ({ status: 'success' as const, message: `第 ${++n} 次` }),
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('poll')], [call('poll')], [call('poll')], [call('poll')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        emit: () => {},
        requestPermission: async () => true,
      }),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_poll' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
    expect(n).toBe(4)
  })
})

/**
 * 思考强度从 `RunInput` 走到 `ChatRequest`。
 *
 * 这是那条链路的最后一跳，也是最容易断的一跳——它两头都有类型，
 * 中间少传一个字段不会报任何错，表现只是「选了 max 和选了 low 一模一样」。
 */
describe('effort 传到请求上', () => {
  function capturing(): { adapter: LlmAdapter; seen: ChatRequest[] } {
    const seen: ChatRequest[] = []
    const inner = fakeAdapter([null])
    return {
      seen,
      adapter: {
        ...inner,
        async *stream(req: ChatRequest) {
          seen.push(req)
          yield* inner.stream(req)
        },
      },
    }
  }

  async function runWith(effort?: 'low' | 'max') {
    const { adapter, seen } = capturing()
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 's',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) =>
        ({
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: () => {},
          requestPermission: async () => true,
        }) as ToolContext,
    })
    for await (const _ of loop.run({
      runId: 'rn_test' as never,
      history: [],
      ...(effort ? { effort } : {}),
      signal: new AbortController().signal,
    })) {
      // 跑完即可。
    }
    return seen
  }

  test('传了就带上，且原样传', async () => {
    expect((await runWith('max'))[0]?.effort).toBe('max')
    expect((await runWith('low'))[0]?.effort).toBe('low')
  })

  /** 不传是**不带这个键**，不是带一个 undefined——省略和显式空值在协议上不等价。 */
  test('没传就不带这个键', async () => {
    const req = (await runWith())[0]!
    expect('effort' in req).toBe(false)
  })
})

/**
 * 一轮的花费带着它自己的币种。
 *
 * 币种写死美元不会让任何东西报错——`cost` 仍然是个数字、界面仍然画得出来，
 * 只是 ¥ 会显示成 $，差七倍。这类错误只能靠这种测试挡。
 */
describe('花费带币种', () => {
  async function usageOf(model: string) {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null], model),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) =>
        ({
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model,
          contextWindow: 200_000,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
          emit: () => {},
          requestPermission: async () => true,
        }) as ToolContext,
    })
    const events = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    const finished = events.find((e) => e.type === 'run.finished')
    return finished?.type === 'run.finished' ? finished.usage : null
  }

  test('美元标价的模型记 USD', async () => {
    expect((await usageOf('claude-opus-5'))?.currency).toBe('USD')
  })

  /** GLM 官网按人民币标价。目录里记的是 ¥，这一轮的花费就得是 ¥。 */
  test('人民币标价的模型记 CNY', async () => {
    expect((await usageOf('glm-5.2'))?.currency).toBe('CNY')
  })
})

describe('用户中断不是错误', () => {
  /**
   * 原始失败形状：run 挂在等 provider 事件的 await 上，此时 abort 让底层请求抛出，
   * 被归类成 ProviderError('internal_error','已取消') 走异常路径——
   * loop 里三处 `signal.aborted` 检查全在「两个事件之间」，一个都赶不上。
   * 结果是用户主动点停止，DB 记 failed、界面弹一条红色 internal_error。
   */
  function abortingAdapter(controller: AbortController): LlmAdapter {
    return {
      kind: 'anthropic' as const,
      transmits: { thinking: true, effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic'),
      measure: async () => 0,
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
        // 在「两个事件之间」之外的地方中断，并像真实 SDK 那样抛出。
        controller.abort()
        throw new ProviderError({
          code: 'internal_error',
          message: '已取消',
          retryable: false,
          provider: 'anthropic',
        })
      },
    }
  }

  test('流式等待中被中断 —— 终态是 interrupted，且不发 run.error', async () => {
    const controller = new AbortController()
    const loop = new AgentLoop({
      adapter: abortingAdapter(controller),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      tailNotes: () => [],
      makeToolContext: () => ({}) as never,
      persist: noopPersistence(),
    })

    const types: string[] = []
    let finished: { status: string; stopReason: string } | undefined
    for await (const ev of loop.run({
      runId: 'rn_abort' as never,
      history: [],
      signal: controller.signal,
    })) {
      types.push(ev.type)
      if (ev.type === 'run.finished') finished = ev
    }

    expect(finished?.status).toBe('interrupted')
    expect(finished?.stopReason).toBe('user_interrupt')
    // 报红的那条不能出现——中断不该走错误通道。
    expect(types).not.toContain('run.error')
  })
})

describe('上下文读数：一把尺', () => {
  /**
   * **跨 run 不换尺。**
   *
   * 没有锚点时，每个 run 的第一次请求只能报本地估算（系统性偏低），
   * 第二次起才切到真值——用户看到的就是每轮开头掉一次、然后弹回去。
   * 用户实测报的「一个轮会话里上下文跳了好几次」，跨轮的那一半就是它。
   */
  test('带着上一轮真值开跑，首个读数就是 actual 而不是估算', async () => {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        emit: (channel, delta) =>
          emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
        requestPermission: async () => true,
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_anchor' as never,
      history: [{ role: 'user', content: '继续', _group: 'historyMessages', _messageId: 'ms_9' }],
      anchor: { tokens: 33_000, throughMessageId: 'ms_8' },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type === 'context' && ctx.source).toBe('actual')
    // 锚点 + 锚点之后新增的那条消息，不是 fakeAdapter 报的 10。
    expect(ctx?.type === 'context' && ctx.tokens).toBeGreaterThanOrEqual(33_000)
  })

  test('没有锚点时如实标 estimated，不假装是实测', async () => {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: new AbortController().signal,
        emit: (channel, delta) =>
          emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
        requestPermission: async () => true,
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_noanchor' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }
    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type === 'context' && ctx.source).toBe('estimated')
  })
})

/**
 * 名字不在注册表里的调用**不进执行链**。
 *
 * 放它进去就会开出一条 tool step、发一条 `tool.started`，界面上多一张既没有动作、
 * 也什么都没做的卡片，而标题只能编（「读取<工具名>」或「未知工具」都是在给一个
 * 不存在的东西造词条）。注册表是工具的唯一权威：名字不在表里的不是工具，
 * 是 provider 违反了我们下发的工具表。
 *
 * 但结果必须回给模型：provider 的契约是每个 tool_call 都要有一条对应 id 的
 * tool 结果，少一条下一轮直接 400。
 */
describe('注册表是工具的唯一权威', () => {
  const realSpec = (name: string): ToolSpec => ({
    name,
    description: 'd',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    actionKind: 'read',
    objectLabel: '文件',
    category: 'files',
    facet: '测试',
    summary: '测试夹具',
    permissionEffect: 'internal_control',
    fn: async () => ({ status: 'success', message: 'ok' }),
  })

  test('胡诌的工具名不产生工具卡，也不产生 step', async () => {
    const registry = new ToolRegistry()
    registry.register(realSpec('read_thing'))

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('read_thing'), call('no_such_tool')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => baseCtx(runId, emit),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_bogus' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const started = events.filter((e) => e.type === 'tool.started')
    expect(started).toHaveLength(1)
    expect(started[0]?.type === 'tool.started' && started[0].toolName).toBe('read_thing')
    // 真工具那条必然有动作——挡掉之后下游不再需要任何兜底。
    expect(started[0]?.type === 'tool.started' && started[0].action.kind).toBe('read')

    // 这一轮照常收尾，不因为一次胡诌就报错中断。
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })
})

/**
 * 传输断了怎么收场。
 *
 * 起因是一次真实断流（`docs/plans/2026-08-17-断流的形状与无痕重发.md` §1）：
 * 第 4 次请求发出后 262 秒一个字节都没回来，run 就此终结，账本里那行到现在还是
 * `in_flight`，而系统没有替用户试第二次——他只能自己把那句话重打一遍。
 *
 * 这一组锁三件事：**账本必须落终态**、**零输出才重发**、**重发过要说出来**。
 */
describe('传输断了：落终态、无痕重发一次、说清形状', () => {
  interface Recorded {
    opened: number[]
    settled: { status: string; errorCode: string | null }[]
  }

  function recordingPersistence(rec: Recorded): LoopPersistence {
    const base = noopPersistence()
    return {
      ...base,
      openRequest: (input) => {
        rec.opened.push(input.retryIndex)
        return `pr_${input.retryIndex}`
      },
      settleRequest: (_id, status, _usage, errorCode) => {
        rec.settled.push({ status, errorCode })
      },
    }
  }

  /**
   * 按脚本决定每次 `stream()` 怎么收场。
   *
   * `'break'` 与 `'break-after-text'` 的区别就是重发的那条判据：前者 provider
   * 一个事件都没回来（重发无痕），后者已经吐了字（重发会让用户看到两段不一样的话）。
   */
  function scriptedAdapter(script: ('break' | 'break-after-text' | 'reject' | 'ok')[]): LlmAdapter {
    let i = 0
    return {
      kind: 'anthropic',
      transmits: { thinking: true, effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic'),
      measure: async () => 0,
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        const act = script[i++] ?? 'ok'
        yield { type: 'request_prepared', measuredInputTokens: 10, exact: false }
        if (act === 'break' || act === 'break-after-text') {
          if (act === 'break-after-text') yield { type: 'text_delta', delta: '我先看看' }
          throw new ProviderError({
            code: 'network_error',
            message: '连接被断开',
            retryable: true,
            provider: 'anthropic',
            cause: Object.assign(new Error('The socket connection was closed unexpectedly.'), {
              code: 'ECONNRESET',
            }),
          })
        }
        if (act === 'reject') {
          throw new ProviderError({
            code: 'provider_unavailable',
            message: '服务端暂时不可用',
            retryable: true,
            provider: 'anthropic',
            status: 503,
          })
        }
        yield { type: 'text_delta', delta: '完成' }
        yield { type: 'done', stopReason: 'end_turn' }
      },
    }
  }

  function run(adapter: LlmAdapter, rec: Recorded) {
    return new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 's',
      tailNotes: () => [],
      persist: recordingPersistence(rec),
      makeToolContext: (runId, emit) => baseCtx(runId, emit),
    }).run({ runId: 'rn_net' as never, history: [], signal: new AbortController().signal })
  }

  async function collect(adapter: LlmAdapter): Promise<{ rec: Recorded; events: AgentEvent[] }> {
    const rec: Recorded = { opened: [], settled: [] }
    const events: AgentEvent[] = []
    for await (const ev of run(adapter, rec)) events.push(ev)
    return { rec, events }
  }

  test('零输出的断流：原样重发一次，第二次成功就当无事发生', async () => {
    const { rec, events } = await collect(scriptedAdapter(['break', 'ok']))

    // 两行账，`retry_index` 0 和 1。顶掉上一行的话「真的发过两次」就不见了。
    expect(rec.opened).toEqual([0, 1])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('断流必须落终态：不知道 provider 收没收到就记 uncertain', async () => {
    const { rec } = await collect(scriptedAdapter(['break', 'ok']))

    // 第一行是断掉那次。以前这条路径压根不 settle，账本里 9 行永久 in_flight。
    expect(rec.settled[0]).toEqual({ status: 'uncertain', errorCode: 'network_error' })
    expect(rec.settled[1]?.status).toBe('received')
  })

  test('provider 明确答复过就是 rejected，不是 uncertain', async () => {
    const { rec } = await collect(scriptedAdapter(['reject']))

    // 有 HTTP 状态码 = 它回绝了，我们知道请求到了。这条与「连不上」必须分开记，
    // 两者差的是计费责任。
    expect(rec.settled[0]).toEqual({ status: 'rejected', errorCode: 'provider_unavailable' })
    // 且不重发：provider 答复过的失败不在重发窗口里。
    expect(rec.opened).toEqual([0])
  })

  test('已经吐过字就不重发——重发是重新生成，用户会看到两段不一样的话', async () => {
    const { rec, events } = await collect(scriptedAdapter(['break-after-text', 'ok']))

    expect(rec.opened).toEqual([0])
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('network_error')
  })

  test('重发过还是断：正文要带现场读数，并说出重发过', async () => {
    const { events } = await collect(scriptedAdapter(['break', 'break']))

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    // 分类短语来自 errors.ts，读数与「重发过」由 loop 补——三段都要在。
    expect(message).toContain('连接被断开')
    expect(message).toMatch(/没有收到任何数据/)
    expect(message).toContain('已自动重发一次')
  })

  test('吐过字的断流：读数报的是「多久没动静」，不是「一个字节都没有」', async () => {
    const { events } = await collect(scriptedAdapter(['break-after-text']))

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).toMatch(/最后一次收到数据在 \d+ 秒前/)
    expect(message).toContain('本次共收到 4 字')
  })
})
/**
 * 停止必须能把一轮从**卡住的工具**上拽回来。
 *
 * abort 只是置一个信号，等的人不看它就等于没停。这条锁的是：即使工具永远不返回，
 * 点停止之后这一轮也在毫秒级落终态、并且落的是 `user_interrupt` 而不是红色的
 * `internal_error`。没有这条的表现是用户点了停止毫无反应，唯一出路是重启应用。
 */
describe('停止能拽回卡住的工具', () => {
  function hangingRegistry(): { registry: ToolRegistry; entered: Promise<void> } {
    const registry = new ToolRegistry()
    let announce: () => void = () => {}
    const entered = new Promise<void>((r) => {
      announce = r
    })
    registry.register({
      name: 'hang',
      description: '永不返回',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '夹具',
      category: 'code',
      facet: '执行',
      summary: '永不返回的工具',
      targetExtractor: () => null,
      permissionEffect: 'internal_control',
      async fn() {
        announce()
        // 故意不看 ctx.signal：这条测试要验的正是「等的人不看信号时也停得掉」。
        return new Promise(() => {}) as never
      },
    })
    return { registry, entered }
  }

  test('工具永不返回时，点停止仍在毫秒级落 user_interrupt', async () => {
    const { registry, entered } = hangingRegistry()
    const controller = new AbortController()
    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('hang')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId, emit) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: controller.signal,
        emit: (channel, delta) =>
          emit({ type: 'tool.delta', runId, stepId: 'st' as never, channel, delta }),
        requestPermission: async () => true,
      }),
    })

    // 工具一进去就按停止。
    void entered.then(() => controller.abort())

    const t0 = Date.now()
    const events: string[] = []
    let finished: { status: string; stopReason: string } | null = null
    for await (const ev of loop.run({
      runId: 'rn_hang' as never,
      history: [],
      signal: controller.signal,
    })) {
      events.push(ev.type)
      if (ev.type === 'run.finished') finished = { status: ev.status, stopReason: ev.stopReason }
    }
    const ms = Date.now() - t0

    expect(finished?.status).toBe('interrupted')
    expect(finished?.stopReason).toBe('user_interrupt')
    // 「毫秒级」——不是等那个工具（它永远不返回）。给 5 秒余量足够宽。
    expect(ms).toBeLessThan(5_000)
    // 中断不是错误：不该报红。
    expect(events).not.toContain('run.error')
  }, 10_000)
})
