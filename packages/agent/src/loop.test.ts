import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireToolCall } from '@qywork/ai'
import {
  classifyProviderError,
  estimateRequest,
  estimateText,
  lookupModel,
  ProviderError,
} from '@qywork/ai'
import type { AgentEvent, ContextBreakdown } from '@qywork/core'
import { CONTEXT_GROUPS } from '@qywork/core'
import { AgentLoop, type LoopPersistence, type ToolContext, type ToolContextBase } from './index.ts'
import { UNAVAILABLE_BACKOFF_MS } from './loop.ts'
import { ToolRegistry, type ToolSpec } from './registry.ts'

/** 按脚本回放的假 adapter：每次 stream() 吐出预设的一轮。 */
function fakeAdapter(turns: (WireToolCall[] | null)[], model = 'claude-opus-5'): LlmAdapter {
  let turn = 0
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec: lookupModel(
      model,
      model === 'claude-opus-5' ? 'anthropic_messages' : 'openai_chat_completions',
    ),
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      const calls = turns[turn++] ?? null
      // 三个真适配器都是 `estimateRequest(req)`，假的必须同口径：没有锚点时
      // 面板的总数就是这个值，而分组明细是同一次装配的估算，两者相等是恒等式。
      // 给一个与请求无关的常数，等于让假适配器造出真适配器造不出的状态。
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req) }
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
      yield { type: 'done', stopReason: calls ? 'tool_use' : 'end_turn', rawStopReason: '' }
    },
  }
}

function noopPersistence(): LoopPersistence {
  let seq = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: () => `st_text_${seq}`,
    openThinkingStep: () => `st_think_${seq}`,
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
function baseCtx(runId: string): ToolContextBase {
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
    requestPermission: async () => true,
  }
}

describe('工具中途输出', () => {
  /**
   * 回归：工具还在跑的时候，它吐的东西就要交出去。
   *
   * 这条测的是**活性**不是顺序：光断言「delta 排在 tool.finished 之前」在
   * 攒到整波结束再排空的写法下同样成立。所以让工具吐完就卡住，
   * 由测试看到那条 delta 之后才放行——攒批的写法在这里会直接停住，
   * 表现为超时失败。
   */
  test('工具执行期间产出的事件立刻交出去，不等这一波结束', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })

    const registry = new ToolRegistry()
    registry.register({
      name: 'noisy',
      description: '先吐一行，再等外面放行。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn(_args, ctx) {
        ctx.emit('stdout', '第一行')
        await gate
        return { status: 'success', message: 'ok' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('noisy')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    const types: string[] = []
    const it = loop
      .run({
        runId: 'rn_test' as never,
        history: [],
        signal: new AbortController().signal,
      })
      [Symbol.asyncIterator]()
    for (;;) {
      const n = await it.next()
      if (n.done) break
      types.push(n.value.type)
      // 看到中途输出才放行。收不到就永远走不到这里。
      if (n.value.type === 'tool.delta') release()
    }

    const delta = types.indexOf('tool.delta')
    const finished = types.indexOf('tool.finished')
    expect(delta).toBeGreaterThan(types.indexOf('tool.started'))
    expect(delta).toBeLessThan(finished)
  })

  /**
   * 回归：中途输出要认得出是哪张卡片的。
   *
   * 前端拿 stepId 在 transcript 里找那一条工具卡（`connection.ts` 的
   * `find(t => t.id === ev.stepId)`），空串谁也匹配不上——整条通道于是静默丢弃，
   * 而事件照发、界面照旧空白，看起来像命令没有输出。
   */
  test('中途输出带的 stepId 就是这次调用那一条', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'noisy',
      description: '吐一行就结束。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn(_args, ctx) {
        ctx.emit('stdout', '第一行')
        return { status: 'success', message: 'ok' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('noisy')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const started = events.find((e) => e.type === 'tool.started')
    const delta = events.find((e) => e.type === 'tool.delta')
    expect(started?.stepId).toBeTruthy()
    expect(delta?.stepId).toBe(started!.stepId)
  })

  /** 中止仍然要抛出去，且抛之前先把已经吐出来的排空——那些是真发生过的输出。 */
  test('中止不吞掉已经产出的中途输出', async () => {
    const abort = new AbortController()
    const registry = new ToolRegistry()
    registry.register({
      name: 'noisy',
      description: '吐一行然后永不返回。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn(_args, ctx) {
        ctx.emit('stdout', '第一行')
        await new Promise<void>(() => {})
        return { status: 'success' as const, message: '到不了' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('noisy')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    const types: string[] = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: abort.signal,
    })) {
      types.push(ev.type)
      if (ev.type === 'tool.delta') abort.abort()
    }

    expect(types).toContain('tool.delta')
    const finished = types.filter((t) => t === 'run.finished')
    expect(finished).toHaveLength(1)
  })
})

describe('流式通道的顺序', () => {
  /**
   * 回归：一次调用里「思考 → 正文 → 思考 → 正文」必须落成四条 step。
   *
   * 并成「一条思考 + 一条正文」的后果不是少两行，是 `seq` 表达不出真实顺序——
   * 实测形状：中转站分三次给推理摘要，落库出来是
   * `**Inspecting…****Running tests…**` 两段粘在一起，而它们本来分开到达。
   * 前端据 `seq` 重放，于是刷新一次顺序就和刚才看到的不一样。
   */
  test('通道来回切换就来回开新 step，正文与思考各自成段', async () => {
    const opened: string[] = []
    const written = new Map<string, string>()
    let seq = 0
    const persist: LoopPersistence = {
      ...noopPersistence(),
      nextSeq: () => ++seq,
      openTextStep: () => {
        const id = `st_text_${seq}`
        opened.push(id)
        return id
      },
      openThinkingStep: () => {
        const id = `st_think_${seq}`
        opened.push(id)
        return id
      },
      appendText: (stepId, delta) => written.set(stepId, (written.get(stepId) ?? '') + delta),
    }

    const adapter: LlmAdapter = {
      kind: 'openai_chat_completions',
      transmits: { effort: true },
      spec: lookupModel('gpt-5.6-terra', 'openai_chat_completions'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        yield { type: 'thinking_delta', delta: '想一' }
        yield { type: 'text_delta', delta: '说一' }
        yield { type: 'thinking_delta', delta: '想二' }
        yield { type: 'text_delta', delta: '说二' }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }

    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist,
      makeToolContext: (runId) => baseCtx(runId),
    })

    const deltas: { type: string; stepId: string }[] = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'text.delta' || ev.type === 'thinking.delta') {
        deltas.push({ type: ev.type, stepId: ev.stepId })
      }
    }

    // 四段内容 = 四条 step，顺序就是到达顺序。
    expect(opened).toHaveLength(4)
    expect(written.get(opened[0]!)).toBe('想一')
    expect(written.get(opened[1]!)).toBe('说一')
    expect(written.get(opened[2]!)).toBe('想二')
    expect(written.get(opened[3]!)).toBe('说二')

    // 事件带的 stepId 与落库的一一对应，客户端不需要自己造 id。
    expect(deltas.map((d) => d.stepId)).toEqual(opened)
    expect(deltas.map((d) => d.type)).toEqual([
      'thinking.delta',
      'text.delta',
      'thinking.delta',
      'text.delta',
    ])
  })

  /** 同一通道连续到达不开新 step——否则一句话会被拆成几十条。 */
  test('同一通道连续增量只开一条 step', async () => {
    const opened: string[] = []
    let seq = 0
    const persist: LoopPersistence = {
      ...noopPersistence(),
      nextSeq: () => ++seq,
      openTextStep: () => {
        const id = `st_text_${seq}`
        opened.push(id)
        return id
      },
    }
    const adapter: LlmAdapter = {
      kind: 'openai_chat_completions',
      transmits: { effort: true },
      spec: lookupModel('gpt-5.6-terra', 'openai_chat_completions'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        for (const d of ['a', 'b', 'c']) yield { type: 'text_delta', delta: d }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist,
      makeToolContext: (runId) => baseCtx(runId),
    })
    for await (const _ of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只关心开了几条 step。
    }
    expect(opened).toHaveLength(1)
  })
})

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

    let captured: ToolContextBase | null = null
    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('remember'), call('remember')], [call('remember')], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: noopPersistence(),
      makeToolContext: (runId) => {
        const ctx: ToolContextBase = {
          workspaceRoot: '/tmp',
          conversationId: 'cv',
          runId,
          model: 'test',
          contextWindow: 200_000,
          resources: new Map(),
          state: new Map(),
          sink: null,
          signal: new AbortController().signal,
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
      makeToolContext: (runId) => {
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
  test('被拒的调用不执行，理由回到模型手里，循环继续', async () => {
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

    const inner = fakeAdapter([[call('danger')], null])
    const requests: ChatRequest[] = []
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        requests.push(req)
        yield* inner.stream(req)
      },
    }

    const loop = new AgentLoop({
      adapter,
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
        requestPermission: async () => ({ allowed: false as const, reason: '权限规则拦下：夹具' }),
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

    // 拒绝是一条工具失败结果，不是 run 的终点。裁决方给的理由必须随下一轮请求
    // 发出去——`auto` 模式下那是模型唯一能拿到的信号，收不到它就只能原样重试。
    expect(requests.length).toBe(2)
    expect(JSON.stringify(requests[1]?.messages)).toContain('权限规则拦下：夹具')

    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
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
      kind: 'anthropic_messages' as const,
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      aborted: false,
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        if (opts.stallAfterFirst) {
          yield { type: 'request_prepared', measuredInputTokens: 10 }
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
    for await (const ev of loopWith(stallingAdapter({ stallAfterFirst: false })).run({
      runId: 'rn_1' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev.type)
      if (ev.type === 'run.error') code = ev.code
    }
    expect(code).toBe('stream_idle_timeout')
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

  /**
   * 回归测试：**各行加起来必须等于标题上那个数**。
   *
   * 复现的是实测形状：`tokens` 走锚定尺（provider 真值 + 一轮尾巴），`breakdown`
   * 是本地估算，两者天然不等。live 事件不对账时，差额无声地落进「剩余空间」——
   * 界面上各行加起来只有 36.9%，标题写着 64.2%，而那 271k 的去向没有任何一行指向它。
   *
   * 会话面板那侧（`runtime/context-panel.ts`）一直是对过账的，所以不对账的表现
   * 是同一个面板两条路显示两组数：打开会话看到一组，run 一跑起来换成另一组。
   */
  test('锚定尺下各分组之和恒等于读数', async () => {
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
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
        requestPermission: async () => true,
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_reconcile' as never,
      history: [{ role: 'user', content: '继续', _group: 'historyMessages', _messageId: 'ms_9' }],
      // 真值远大于这点历史的本地估算，差额必须被摊回可变桶而不是消失。
      anchor: { tokens: 33_000, throughMessageId: 'ms_8', envelopeFingerprint: null },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const ctx = events.find((e) => e.type === 'context')
    expect(ctx?.type).toBe('context')
    if (ctx?.type !== 'context') return
    expect(ctx.source).toBe('actual')
    expect(Object.values(ctx.breakdown).reduce((n, v) => n + v, 0)).toBe(ctx.tokens)
    // 摊法是吸收不是缩放：逐字可数的固定类目保实测值，不许被差额改写。
    expect(ctx.breakdown.systemPrompt).toBe(estimateText('sys'))
  })

  /**
   * 回归测试：**执行记录 / 工具结果的二分要同尺量**。
   *
   * 复现的形状取自实测：`write_file` 回一句「创建 src/car.js」、没有 result。
   * 信封按 `estimateJson`（2 字符/token）量而整条按 `estimateText`（4 字符/token）
   * 量时，信封虚高一倍，差额从正文里扣到负数、被 `Math.min` 夹成零——面板于是
   * 读作「这次调用没带回任何正文」。同一条会话 327 次调用里 167 条是这个形状，
   * 上面这句 summary 就是其中一种。
   *
   * **断言落在账本上不是事件上**：事件里的 `breakdown` 已经对过账
   * （`reconcileBreakdown`），差额会盖住二分本身。`sentCategories` 是原始估算，
   * 也正是会话面板回头投影时读的那一份。
   */
  test('带 summary 的工具结果不会被记成没有正文', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'write_file',
      description: '回一句话，用于验证工具结果的二分。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'write',
      objectLabel: '文件',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        return { status: 'success', message: '创建 src/car.js' }
      },
    })

    const recorded: ContextBreakdown[] = []
    const persist = noopPersistence()
    const loop = new AgentLoop({
      adapter: fakeAdapter([[{ id: 'call_0mt3zi7wa01', name: 'write_file', arguments: {} }], null]),
      registry,
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist: {
        ...persist,
        openRequest: (r) => {
          recorded.push(r.sentCategories)
          return persist.openRequest(r)
        },
      },
      makeToolContext: (runId) => baseCtx(runId),
    })

    for await (const _ev of loop.run({
      runId: 'rn_split' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只看账本。
    }

    // 第二次请求才带着工具结果：第一次装配时那条 tool 消息还不存在。
    const b = recorded.at(-1)
    expect(recorded).toHaveLength(2)
    expect(b).toBeDefined()
    // 信封与正文各占一部分——两个桶都不许是零。
    expect(b!.executionRecords).toBeGreaterThan(0)
    expect(b!.intermediateContent).toBeGreaterThan(0)
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

  /** 月之暗面官网按人民币标价。目录里记的是 ¥，这一轮的花费就得是 ¥。 */
  test('人民币标价的模型记 CNY', async () => {
    expect((await usageOf('kimi-k3'))?.currency).toBe('CNY')
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
      kind: 'anthropic_messages' as const,
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        // 在「两个事件之间」之外的地方中断，并像真实 SDK 那样抛出。
        controller.abort()
        throw new ProviderError({
          code: 'internal_error',
          message: '已取消',
          provider: 'anthropic_messages',
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
        requestPermission: async () => true,
      }),
    })

    const events = []
    for await (const ev of loop.run({
      runId: 'rn_anchor' as never,
      history: [{ role: 'user', content: '继续', _group: 'historyMessages', _messageId: 'ms_9' }],
      anchor: { tokens: 33_000, throughMessageId: 'ms_8', envelopeFingerprint: null },
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
      makeToolContext: (runId) => baseCtx(runId),
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
  /*
   * 退避是真的在等，`reject` 那几条会让这个文件多跑十秒。
   *
   * 只把退避那一档改成立即触发，别的定时器原样放行——全量替换会让卡死检测
   * （`STREAM_IDLE_TIMEOUT_MS`）立刻开火，成功用例会被判成断流。
   */
  const realSetTimeout = globalThis.setTimeout
  beforeAll(() => {
    globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
      realSetTimeout(fn, ms === UNAVAILABLE_BACKOFF_MS ? 0 : ms, ...rest)) as typeof setTimeout
  })
  afterAll(() => {
    globalThis.setTimeout = realSetTimeout
  })

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
  function scriptedAdapter(
    script: ('break' | 'break-after-text' | 'reject' | 'reject-relay' | 'ok')[],
  ): LlmAdapter {
    let i = 0
    return {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        const act = script[i++] ?? 'ok'
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        if (act === 'break' || act === 'break-after-text') {
          if (act === 'break-after-text') yield { type: 'text_delta', delta: '我先看看' }
          throw new ProviderError({
            code: 'network_error',
            message: '连接被断开',
            provider: 'anthropic_messages',
            cause: Object.assign(new Error('The socket connection was closed unexpectedly.'), {
              code: 'ECONNRESET',
            }),
          })
        }
        if (act === 'reject') {
          throw new ProviderError({
            code: 'provider_unavailable',
            message: '服务端暂时不可用',
            provider: 'anthropic_messages',
            status: 503,
          })
        }
        if (act === 'reject-relay') {
          // 中转站不发 5xx，把「后端暂时不可用」塞进 400。这条要走真的分类器，
          // 手写 ProviderError 就绕开了「400 归哪个码」——那正是要锁的一环。
          throw classifyProviderError(
            'anthropic_messages',
            Object.assign(new Error('{"error":{"type":"<nil>","message":"暂不可用 请稍后再试"}}'), {
              status: 400,
            }),
          )
        }
        yield { type: 'text_delta', delta: '完成' }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
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
      makeToolContext: (runId) => baseCtx(runId),
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
  })

  test('上游自报暂时不可用：等一下重发一次，第二次成功就当无事发生', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject']))

    // 不重发的代价不是省钱：用户照样要手动继续，那一次付的是同一笔长 prompt 的钱，
    // 而且 run 已经落成 failed，新消息还得让模型重新理解上一轮做到哪。
    expect(rec.opened).toEqual([0, 1])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('中转站用 400 报「暂时不可用」：照样重发，整轮不该就此终结', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject-relay']))

    expect(rec.opened).toEqual([0, 1])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('重发后还是不可用：正文不许带传输读数——上游明确答复过，请求落地了', async () => {
    const { events } = await collect(scriptedAdapter(['reject', 'reject']))

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).toContain('服务端暂时不可用')
    expect(message).toContain('已自动重发一次')
    // 「发出后 N 秒内没有收到任何数据」是传输层的读数，给它拼上等于告诉用户请求没发出去。
    expect(message).not.toMatch(/没有收到任何数据/)
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
      makeToolContext: (runId) => ({
        workspaceRoot: '/tmp',
        conversationId: 'cv',
        runId,
        model: 'test',
        contextWindow: 200_000,
        resources: new Map(),
        state: new Map(),
        sink: null,
        signal: controller.signal,
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

describe('provider 说要调工具但一条都没解析出来', () => {
  /**
   * 复现的是原始失败形状（会话 `cv_0mszld8o60000yi2u5m`）：一轮零工具调用、
   * `run` 记成正常完成、账本里查不出原因，界面上只剩模型自称做完了。
   *
   * 反向断言比正向断言重要：**旧结局必须不可再现**。只断言新分支命中的话，
   * 哪天有人把 `completed` 加回去当兜底，这个测试照样绿。
   */
  test('记成故障而不是完成，且 provider 的原话进账本', async () => {
    const settled: { status: string; finishReason: string | undefined }[] = []
    const persist = noopPersistence()
    persist.settleRequest = (_id, status, _usage, _code, finishReason) => {
      settled.push({ status, finishReason })
    }

    const loop = new AgentLoop({
      adapter: {
        kind: 'openai_chat_completions',
        transmits: { effort: false },
        spec: lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
        // provider 说 tool_calls，但整轮没有一个 tool_calls 事件——
        // 中转站把非流式响应硬转成 SSE、或名字分片丢了都是这个形状。
        async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
          yield { type: 'request_prepared', measuredInputTokens: 10 }
          yield { type: 'text_delta', delta: '我这就去执行' }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: 'tool_calls' }
        },
      },
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      tailNotes: () => [],
      persist,
      makeToolContext: (runId) => baseCtx(runId),
    })

    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_nocalls' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    const finished = events.find((e) => e.type === 'run.finished')
    // 旧结局：completed。它必须不可再现。
    expect(finished && 'stopReason' in finished && finished.stopReason).not.toBe('completed')
    expect(finished && 'stopReason' in finished && finished.stopReason).toBe('provider_error')
    // 故障对用户可见，不是只有账本知道。
    expect(events.some((e) => e.type === 'run.error')).toBe(true)
    // provider 的原话进账本：没有它就分不出「说完了」和「要调工具」。
    expect(settled.at(-1)?.finishReason).toBe('tool_calls')
  })
})

describe('锚点的信封校验', () => {
  /**
   * 复现的是账本里查不出来的那种偏差：装完一个大 MCP 之后的第一次发送，
   * 占用还按上一次真值算，于是压缩该触发而没触发。
   *
   * 判据是**工具表变了锚点就作废**，作废的表现是读数从 `actual` 掉回 `estimated`。
   */
  test('工具表变了就退回估算尺，没变则继续用真值', async () => {
    const runOnce = async (registry: ToolRegistry, fingerprint: string | null) => {
      const sources: string[] = []
      const loop = new AgentLoop({
        adapter: fakeAdapter([null]),
        registry,
        systemPrompt: 'sys',
        tailNotes: () => [],
        persist: noopPersistence(),
        makeToolContext: (runId) => baseCtx(runId),
      })
      for await (const ev of loop.run({
        runId: 'rn_env' as never,
        history: [],
        signal: new AbortController().signal,
        anchor: { tokens: 12_345, throughMessageId: null, envelopeFingerprint: fingerprint },
      })) {
        if (ev.type === 'context') sources.push(ev.source)
      }
      return sources
    }

    const empty = new ToolRegistry()
    // 指纹对不上（装过工具、换过模型都是这个形状）→ 锚点作废，退回估算尺。
    expect(await runOnce(empty, 'not-the-current-envelope')).toEqual(['estimated'])
    // 没记过指纹的存量行不作为「变了」的证据，锚点照用。
    expect(await runOnce(empty, null)).toEqual(['actual'])
  })
})
