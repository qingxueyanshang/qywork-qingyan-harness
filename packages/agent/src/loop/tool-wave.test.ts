/**
 * 覆盖 `loop/tool-wave.ts`：波次规划（`planWaves`）与副作用判定（`provablyNoEffect`），
 * 以及经 `AgentLoop.run` 的工具中途输出、ToolContext 生命周期、文件失效事件、权限拒绝、
 * 注册表对调用的裁决、原地打转判定、停止对卡住工具的回收。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireToolCall } from '@qywork/ai'
import { buildAdapter, DEFAULT_DENSITY, estimateRequest } from '@qywork/ai'
import {
  FAULT_PROTOCOLS,
  faultBaseUrl,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent } from '@qywork/core'
import { AgentLoop, type ToolContextBase } from '../index.ts'
import { ToolRegistry, type ToolSpec } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { planWaves, provablyNoEffect } from './tool-wave.ts'

describe('工具中途输出', () => {
  /**
   * 回归：工具还在跑的时候，它的输出就要交出去。
   *
   * 这条测的是**活性**不是顺序：光断言「delta 排在 tool.finished 之前」在
   * 攒到整波结束再排空的写法下同样成立。所以让工具输出完就卡住，
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
   * `find(t => t.id === ev.stepId)`），空串谁也匹配不上——整条通道因此静默丢弃，
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

  /** 中止仍然要抛出去，且抛之前先把已经产出的排空——那些是真发生过的输出。 */
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
      persist: noopPersistence(),
      makeToolContext: (runId) => {
        const ctx: ToolContextBase = {
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
      persist: noopPersistence(),
      makeToolContext: (runId) => {
        created++
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

describe('工作区文件失效', () => {
  test('执行类工具没有逐路径明细也广播一次空变更', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'generator',
      description: '模拟会生成文件但无法枚举路径的命令。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'code',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'execute',
      async fn() {
        // 非零退出前也可能已经写过文件；只要确实执行过，磁盘快照就不能继续复用。
        return { status: 'failure', message: 'exit 1' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('generator')], null]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    const invalidations: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_file_invalidation' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'file.changed') invalidations.push(ev)
    }

    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]?.type === 'file.changed' && invalidations[0].changes).toEqual([])
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
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
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
    expect(events.some((e) => e.type === 'file.changed')).toBe(false)

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
 * 就那么挂着，既不出错也不结束，界面持续转圈。
 *
 * 判定在传输层按字节走，所以这一组必须过真实 HTTP：假适配器不经过 `traceFetch`，
 * 断言留在它上面一条也验不到。
 */

describe('原地打转', () => {
  /**
   * 复现要挡的形状：模型用一模一样的参数反复调同一个只读工具，拿到一模一样的
   * 结果。不挡的话它会无限请求 provider。这里必须按实际行为判空转；固定轮数只会
   * 把长任务误杀，而且无法说明模型卡在了哪里。
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
      // 必须声明为纯 read：副作用未知的调用不参与空转判定。
      permissionEffect: 'read',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: '还是这些' }
      },
    })

    // 脚本给足十轮，如果判定没生效它会全部跑完。
    const turns = Array.from({ length: 10 }, () => [call('stuck')])
    const loop = new AgentLoop({
      adapter: fakeAdapter(turns),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
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
        emit: () => {},
        requestPermission: async () => ({ allowed: true }),
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

  /**
   * 停之前先让模型知道：第二次相同的轮次之后，下一次请求末尾附一条事实；第三次才停，
   * 停机依据带上重复的工具名。
   */
  test('第二次相同先把事实交给下一次请求，第三次停并说清重复的是什么', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'stuck',
      description: '永远返回同一个结果。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'read',
      fn: async () => ({ status: 'success' as const, message: '还是这些' }),
    })
    const inner = fakeAdapter(Array.from({ length: 10 }, () => [call('stuck')]))
    const tails: { role: string; content: unknown }[] = []
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        tails.push(req.messages[req.messages.length - 1]!)
        yield* inner.stream(req)
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })
    let finished: Extract<AgentEvent, { type: 'run.finished' }> | null = null
    for await (const ev of loop.run({
      runId: 'rn_stall_notice' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') finished = ev
    }
    expect(tails).toHaveLength(3)
    // 第一、二次请求末尾是工具结果；第三次请求末尾是那条事实。
    expect(tails[1]?.role).toBe('tool')
    expect(tails[2]?.role).toBe('user')
    expect(String(tails[2]?.content)).toBe(
      '工具调用、参数与结果已连续两轮相同；连续三轮相同时本次运行停止。',
    )
    expect(finished?.stopReason).toBe('no_progress')
    expect(finished?.stopDetail).toBe('连续三轮相同的调用与结果：stuck')
  })

  test('连续三轮收到相同 pause_turn 时按真实空转停下', async () => {
    let requests = 0
    const base = fakeAdapter([])
    const adapter: LlmAdapter = {
      ...base,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        requests++
        yield {
          type: 'request_prepared',
          measuredInputTokens: estimateRequest(req, base.spec.density),
        }
        yield { type: 'response_started', headersAt: Date.now() }
        yield { type: 'text_delta', delta: '仍停在同一个位置', at: Date.now() }
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
        yield { type: 'done', stopReason: 'pause_turn', rawStopReason: 'pause_turn' }
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const event of loop.run({
      runId: 'rn_pause_stuck' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === 'run.finished') stopReason = event.stopReason
    }

    expect(stopReason).toBe('no_progress')
    expect(requests).toBe(3)
  })

  /**
   * 一次响应内的三次相同调用只算一次决策周期：模型尚未看到任何结果，
   * 不构成「看过结果仍重复」。证据按 provider 决策计数，不按工具调用计数，
   * 否则单次响应即可满足三次阈值并提前暂停。
   */
  test('同一响应内三次相同调用不判打转，下一次请求照发', async () => {
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
      permissionEffect: 'read',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: '还是这些' }
      },
    })

    const inner = fakeAdapter([[call('stuck'), call('stuck'), call('stuck')], null])
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
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_same_batch' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(executed).toBe(3)
    expect(requests).toHaveLength(2)
    expect(stopReason).toBe('completed')
  })

  /**
   * 已执行命令的失败不能证明无副作用——外部状态可能已被修改。
   * 判定只取确凿事实：非 read 声明且 executed:true 的调用视为副作用未知，
   * 不参与空转计数。
   */
  test('已执行命令的相同失败不判打转，跑满脚本', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'ran_cmd',
      description: '固定返回非零退出码，模拟已执行命令。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'code',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'execute',
      fn: async () => {
        executed++
        return { status: 'failure' as const, message: '命令退出码 1', data: { exitCode: 1 } }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('ran_cmd')],
        [call('ran_cmd')],
        [call('ran_cmd')],
        [call('ran_cmd')],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_ran_cmd' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
    expect(executed).toBe(4)
  })

  /**
   * 混合批的证据必须按 provider 原调用顺序聚合：未知调用记原始下标、
   * 注册调用记过滤后下标的话，两个只是换了顺序的决策会得到同一个批指纹，
   * 被并成同一周期。
   */
  test('混合批换序算不同决策，逐字重复仍判打转', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'peek',
      description: '永远返回同一个结果，用于验证空转判定。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '空',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'read',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: '还是这些' }
      },
    })
    const run = async (turns: (WireToolCall[] | null)[]) => {
      const loop = new AgentLoop({
        adapter: fakeAdapter(turns),
        registry,
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: (runId) => baseCtx(runId),
      })
      let stopReason: string | null = null
      for await (const ev of loop.run({
        runId: 'rn_mixed_order' as never,
        history: [],
        signal: new AbortController().signal,
      })) {
        if (ev.type === 'run.finished') stopReason = ev.stopReason
      }
      return stopReason
    }

    const d1 = () => [call('ghost_a'), call('ghost_b'), call('peek')]
    const d2 = () => [call('ghost_a'), call('peek'), call('ghost_b')]

    // 换序：三轮里第二轮顺序不同，不构成重复，跑满脚本。
    expect(await run([d1(), d2(), d1(), null])).toBe('completed')
    expect(executed).toBe(3)

    // 逐字重复的混合批仍在第三轮停下。
    executed = 0
    expect(await run([d1(), d1(), d1(), null])).toBe('no_progress')
    expect(executed).toBe(3)
  })

  /** 内部控制工具执行后状态可能已变（如待办账本），字段缺席不算确凿无副作用。 */
  test('内部控制工具的相同结果不判打转', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'note_state',
      description: '固定返回同一确认文本，模拟内部记账。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'write',
      objectLabel: '状态',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: '已记录' }
      },
    })

    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('note_state')],
        [call('note_state')],
        [call('note_state')],
        [call('note_state')],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_note_state' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
    expect(executed).toBe(4)
  })

  test('失败正文逐字进入下一轮请求，第三次相同失败后才暂停', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'bad_args',
      description: '固定返回参数错误。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => ({
        status: 'failure' as const,
        executed: false,
        message: 'probe_url 不是合法 URL：null',
        errorKind: 'bad_request',
      }),
    })

    const inner = fakeAdapter(Array.from({ length: 10 }, () => [call('bad_args')]))
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
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    for await (const _ of loop.run({
      runId: 'rn_bad_args' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只检查模型收到的请求。
    }

    expect(requests).toHaveLength(3)
    for (const req of requests.slice(1)) {
      const result = req.messages.findLast((m) => m.role === 'tool')
      expect(result).toBeDefined()
      const body = JSON.parse(String(result!.content))
      expect(body).toMatchObject({
        tool: 'bad_args',
        status: 'failure',
        executed: false,
        summary: 'probe_url 不是合法 URL：null',
      })
    }
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
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
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
        emit: () => {},
        requestPermission: async () => ({ allowed: true }),
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

  test('模型可见的 executed 变化会打断周期', async () => {
    const registry = new ToolRegistry()
    const states = [false, false, true]
    let n = 0
    registry.register({
      name: 'read_state',
      description: '返回执行状态。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '状态',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'read',
      fn: async () => ({
        status: 'failure',
        executed: states[n++]!,
        message: '读取失败',
      }),
    })
    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('read_state')],
        [call('read_state')],
        [call('read_state')],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_executed_changes' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
  })
})

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

  test('未注册调用不产生工具卡，也不产生 step', async () => {
    const registry = new ToolRegistry()
    registry.register(realSpec('read_thing'))

    const loop = new AgentLoop({
      adapter: fakeAdapter([[call('read_thing'), call('no_such_tool')], null]),
      registry,
      systemPrompt: 'sys',
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

    // 这一轮照常收尾，不因为一次编造的名字就报错中断。
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  /**
   * 端点把参数交成合法 JSON 但不是对象时（`null`、数组、标量），调用在执行链之前被拒，
   * 结果回给模型，run 照常结束。经三协议真实适配器走 HTTP：工具的动作解析读取参数字段，
   * `null` 交下去会在单次执行的错误处理之外抛出，整轮以 `provider_error` 失败。
   */
  test('参数不是 JSON 对象的调用被拒，结果回给模型，run 照常结束', async () => {
    for (const literal of ['null', '[]', '"x"', '42']) {
      for (const { kind, model } of FAULT_PROTOCOLS) {
        const fault = startFaultServer('tool_then_complete')
        fault.toolArguments = literal
        try {
          const registry = new ToolRegistry()
          registry.register({
            ...realSpec('echo'),
            targetExtractor: (args) => String((args as { path?: unknown }).path ?? ''),
          })
          const loop = new AgentLoop({
            adapter: buildAdapter({
              kind,
              model,
              apiKey: 'sk-fault',
              baseUrl: faultBaseUrl(fault, kind),
            }),
            registry,
            systemPrompt: 'sys',
            persist: noopPersistence(),
            makeToolContext: (runId) => baseCtx(runId),
          })
          const events: AgentEvent[] = []
          for await (const ev of loop.run({
            runId: 'rn_args' as never,
            history: [],
            signal: new AbortController().signal,
          })) {
            events.push(ev)
          }
          const finished = events.find((e) => e.type === 'run.finished')
          expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
          expect(events.some((e) => e.type === 'tool.started')).toBe(false)
          expect(fault.bodies).toHaveLength(2)
          expect(fault.bodies[1]).toContain('参数不是 JSON 对象，未执行')
        } finally {
          fault.stop()
        }
      }
    }
  }, 30_000)

  test('连续三轮相同的未注册调用会进入无进展终态', async () => {
    const registry = new ToolRegistry()
    registry.register(realSpec('read_thing'))
    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('no_such_tool', { path: 'a' })],
        [call('no_such_tool', { path: 'a' })],
        [call('no_such_tool', { path: 'a' })],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    const started: AgentEvent[] = []
    for await (const ev of loop.run({
      runId: 'rn_bogus_repeat' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'tool.started') started.push(ev)
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('no_progress')
    expect(started).toHaveLength(0)
  })

  test('未注册调用的参数变化会打断周期', async () => {
    const registry = new ToolRegistry()
    registry.register(realSpec('read_thing'))
    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('no_such_tool', { path: 'a' })],
        [call('no_such_tool', { path: 'a' })],
        [call('no_such_tool', { path: 'b' })],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_bogus_changes' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
  })

  test('真实读取与未注册调用混合时按完整结果判断周期', async () => {
    const registry = new ToolRegistry()
    registry.register({
      ...realSpec('read_thing'),
      permissionEffect: 'read',
    })
    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('read_thing'), call('no_such_tool', { path: 'a' })],
        [call('read_thing'), call('no_such_tool', { path: 'a' })],
        [call('read_thing'), call('no_such_tool', { path: 'b' })],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    let stopReason: string | null = null
    for await (const ev of loop.run({
      runId: 'rn_mixed_bogus_changes' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
  })
})

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
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
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
        signal: controller.signal,
        requestPermission: async () => ({ allowed: true }),
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

describe('波次规划', () => {
  const registry = new ToolRegistry()
  const spec = (name: string, over: Partial<ToolSpec> = {}): ToolSpec => ({
    name,
    description: 'd',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    actionKind: 'read',
    objectLabel: '文件',
    category: 'files',
    facet: '测试',
    summary: '测试夹具',
    permissionEffect: 'read',
    fn: async () => ({ status: 'success', message: 'ok' }),
    ...over,
  })
  registry.register(
    spec('peek', {
      parallelSafe: true,
      resourceKeys: (a) => [String((a as { path?: unknown }).path)],
    }),
  )
  registry.register(spec('write', { permissionEffect: 'write' }))
  const shape = (calls: WireToolCall[]) =>
    planWaves(calls, registry).map((w) => w.map((c) => c.callIndex))

  test('连续的并行安全调用合并成一波，不安全的调用单独成波并切断前后', () => {
    const calls = [
      call('peek', { path: 'a' }),
      call('peek', { path: 'b' }),
      call('write'),
      call('peek', { path: 'c' }),
    ]
    expect(shape(calls)).toEqual([[0, 1], [2], [3]])
  })

  test('同一资源键不进同一波', () => {
    expect(shape([call('peek', { path: 'a' }), call('peek', { path: 'a' })])).toEqual([[0], [1]])
  })

  test('副作用判定只认明确事实', () => {
    expect(provablyNoEffect('read', { status: 'success', message: 'ok' })).toBe(true)
    expect(provablyNoEffect('execute', { status: 'failure', message: 'x' })).toBe(false)
    expect(provablyNoEffect('write', { status: 'failure', executed: false, message: 'x' })).toBe(
      true,
    )
    expect(
      provablyNoEffect('read', {
        status: 'success',
        message: 'ok',
        fileChanges: [{ path: 'a', kind: 'modified' } as never],
      }),
    ).toBe(false)
  })
})
