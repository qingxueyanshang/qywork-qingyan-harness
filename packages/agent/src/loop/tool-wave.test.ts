/**
 * 覆盖 `loop/tool-wave.ts`：波次规划（`planWaves`）与副作用判定（`provablyNoEffect`），
 * 以及经 `AgentLoop.run` 的工具中途输出、ToolContext 生命周期、文件失效事件、权限拒绝、
 * 注册表对调用的裁决、重复无进展判定、停止对停滞工具的中止、投递额度按决策计算，
 * 与 `loop/compact.ts` 的执行工具之前压缩检查点。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage, WireToolCall } from '@qywork/ai'
import { buildAdapter, DEFAULT_DENSITY, estimateRequest } from '@qywork/ai'
import {
  FAULT_PROTOCOLS,
  faultBaseUrl,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent } from '@qywork/core'
import { AgentLoop, batchRemaining, chargeBatchBudget, type ToolContextBase } from '../index.ts'
import { ToolRegistry, type ToolSpec } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'
import { planWaves, provablyNoEffect } from './tool-wave.ts'

describe('工具中途输出', () => {
  /**
   * 回归：工具仍在运行时，其输出必须立即发出。
   *
   * 本用例验证的是及时性而不是顺序：仅断言 delta 排在 tool.finished 之前，在
   * 累积到整批结束再统一发出的实现下同样成立。因此让工具输出后即停滞，
   * 测试收到该 delta 后才放行；累积成批的实现会在此阻塞，以超时失败。
   */
  test('工具执行期间产出的事件立即发出，不等待本批结束', async () => {
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
      // 收到中途输出后才放行；未收到时不会执行到此处。
      if (n.value.type === 'tool.delta') release()
    }

    const delta = types.indexOf('tool.delta')
    const finished = types.indexOf('tool.finished')
    expect(delta).toBeGreaterThan(types.indexOf('tool.started'))
    expect(delta).toBeLessThan(finished)
  })

  /**
   * 回归：中途输出必须能识别所属的工具卡片。
   *
   * 前端按 stepId 在 transcript 中查找工具卡片（`connection.ts` 的
   * `find(t => t.id === ev.stepId)`），空串无法匹配任何卡片，整条输出因此被静默丢弃：
   * 事件正常发出而界面保持空白，与命令没有输出无法区分。
   */
  test('中途输出携带的 stepId 与本次调用的 step 一致', async () => {
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

  /** 中止仍须抛出，抛出之前先发出已产出的输出：这些输出确实已经发生。 */
  test('中止时不丢弃已经产出的中途输出', async () => {
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
   * 回归测试：ctx.state 必须跨轮、跨波次保持为同一个对象。
   *
   * 每个执行波次重建 ToolContext 时，files 工具记录的本轮已读文件随即丢失，
   * 写入守卫把刚读过的文件判定为未读。实测后果：模型绕开写入工具改用
   * shell 直接写入文件，生成了带 BOM 与 CR 换行的错误文件。
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

    // 三次调用跨越两轮模型响应与多个波次。
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
  test('执行类工具没有逐路径明细时也广播一次空变更', async () => {
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
        // 非零退出前也可能已写入文件；只要已执行，磁盘快照即不得复用。
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
  test('被拒的调用不执行，拒绝理由返回给模型，循环继续', async () => {
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

    // 被拒的调用不得执行。
    expect(executed).toBe(0)
    expect(events.some((e) => e.type === 'file.changed')).toBe(false)

    // 拒绝是一条工具失败结果，不是 run 的终点。裁决方给出的理由必须随下一轮请求
    // 发出：`auto` 模式下这是模型唯一能取得的信号，缺少该信号时模型只能原样重试。
    expect(requests.length).toBe(2)
    expect(JSON.stringify(requests[1]?.messages)).toContain('权限规则拦下：夹具')

    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })
})

/**
 * 流空闲超时。
 *
 * `stream_idle_timeout` 必须有实际的生产者。没有生产者时，provider 侧短暂异常后 run
 * 持续停滞，既不出错也不结束，界面持续显示加载状态。
 *
 * 判定在传输层按字节进行，因此相关用例必须经过真实 HTTP：假适配器不经过 `traceFetch`，
 * 基于假适配器的断言无法验证该路径。
 */

describe('重复无进展', () => {
  test.each([
    {
      label: '只改无关字段，缺参错误未变，第三轮停止',
      args: Array.from({ length: 10 }, (_, attempt) => ({ attempt })),
      results: 3,
      executed: 0,
      stopReason: 'no_progress',
    },
    {
      label: '收到重复提示后补齐参数，可以执行并结束',
      args: [{ attempt: 1 }, { attempt: 2 }, { path: 'a', content: 'ok' }],
      results: 3,
      executed: 1,
      stopReason: 'completed',
    },
    {
      label: '逐步补齐参数使校验错误改变，可以继续修正',
      args: [{}, {}, { path: 'a' }, { path: 'a' }, { path: 'a', content: 'ok' }],
      results: 5,
      executed: 1,
      stopReason: 'completed',
    },
  ])('$label', async ({ args, results, executed: expectedExecuted, stopReason }) => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'write_check',
      description: '验证必填参数与失败重试，不写入文件。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      actionKind: 'write',
      objectLabel: '文件',
      category: 'files',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      fn: async () => {
        executed++
        return { status: 'success', message: '已处理' }
      },
    })
    const requests: ChatRequest[] = []
    const inner = fakeAdapter(args.map((a) => [call('write_check', a)]))
    const loop = new AgentLoop({
      adapter: {
        ...inner,
        async *stream(req) {
          requests.push(req)
          yield* inner.stream(req)
        },
      },
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })
    const events: AgentEvent[] = []
    for await (const event of loop.run({
      runId: 'rn_missing_args' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }
    expect(events.filter((e) => e.type === 'tool.finished')).toHaveLength(results)
    expect(executed).toBe(expectedExecuted)
    expect(events.find((e) => e.type === 'run.finished')?.stopReason).toBe(stopReason)
    // 指纹的归一化不改写真实调用：原始参数与每条失败回执仍须回传给模型。
    const replay = requests[2]!.messages
    expect(replay.filter((m) => m.toolCalls).map((m) => m.toolCalls![0]!.arguments)).toEqual(
      args.slice(0, 2),
    )
    expect(replay.filter((m) => m.role === 'tool')).toHaveLength(2)
    expect(replay.at(-1)?.content).toContain('未取得进展')
  })

  /**
   * 复现需要拦截的形状：模型用完全相同的参数反复调用同一个只读工具，取得完全相同的
   * 结果。不拦截时会无限请求 provider。此处必须按实际行为判定无进展；固定轮数会
   * 错误终止长任务，且无法说明模型阻塞于何处。
   */
  test('相同调用与相同结果连续三轮后停止，stopReason=no_progress', async () => {
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
      // 必须声明为纯 read：副作用未知的调用不参与无进展判定。
      permissionEffect: 'read',
      fn: async () => {
        executed++
        return { status: 'success' as const, message: '还是这些' }
      },
    })

    // 脚本提供十轮，判定未生效时会全部执行完毕。
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
    // 在第三轮停止，而不是第十轮。
    expect(executed).toBe(3)
  })

  /**
   * 停止之前先告知模型：第二次出现相同轮次后，下一次请求末尾附加一条事实；第三次才停止，
   * 停机依据中包含重复的工具名。
   */
  test('第二次相同时将事实附加到下一次请求，第三次停止并注明重复的工具', async () => {
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
    // 第一、二次请求末尾是工具结果；第三次请求末尾是该事实。
    expect(tails[1]?.role).toBe('tool')
    expect(tails[2]?.role).toBe('user')
    expect(String(tails[2]?.content)).toBe(
      '工具调用与结果已连续两轮重复，未取得进展；连续三轮重复时本次运行停止。',
    )
    expect(finished?.stopReason).toBe('no_progress')
    expect(finished?.stopDetail).toBe('连续三轮工具调用没有进展：stuck')
  })

  test('连续三轮收到相同 pause_turn 时按无进展停止', async () => {
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
   * 一次响应内的三次相同调用只计为一次决策周期：模型尚未看到任何结果，
   * 不构成「看过结果仍重复」。证据按 provider 决策计数，不按工具调用计数，
   * 否则单次响应即可满足三次阈值并提前暂停。
   */
  test('同一响应内三次相同调用不判定为无进展，下一次请求照常发送', async () => {
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
   * 已执行命令的失败不能证明没有副作用：外部状态可能已被修改。
   * 判定只采用确定的事实：非 read 声明且 executed:true 的调用视为副作用未知，
   * 不参与无进展计数。
   */
  test('已执行命令的相同失败不判定为无进展，执行完全部脚本', async () => {
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
   * 混合批次的证据必须按 provider 原调用顺序聚合：若未注册调用记原始下标、
   * 已注册调用记过滤后下标，两个仅顺序不同的决策会得到同一个批次指纹，
   * 被合并为同一周期。
   */
  test('混合批次调换顺序计为不同决策，逐字重复仍判定为无进展', async () => {
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

    // 调换顺序：三轮中第二轮顺序不同，不构成重复，执行完整个脚本。
    expect(await run([d1(), d2(), d1(), null])).toBe('completed')
    expect(executed).toBe(3)

    // 逐字重复的混合批次仍在第三轮停止。
    executed = 0
    expect(await run([d1(), d1(), d1(), null])).toBe('no_progress')
    expect(executed).toBe(3)
  })

  /** 内部控制工具执行后状态可能已变化（如待办账本），字段缺失不能证明没有副作用。 */
  test('内部控制工具的相同结果不判定为无进展', async () => {
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

  /** 结果每轮都在变化（轮询等待）时不应判定为无进展，应执行完毕。 */
  test('结果持续变化时不判定为无进展，执行完全部脚本', async () => {
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
    // 已注册工具的调用必然有动作：未注册调用被拦截后，下游无需任何后备处理。
    expect(started[0]?.type === 'tool.started' && started[0].action.kind).toBe('read')

    // 本轮照常结束，不因一次不存在的工具名而报错中断。
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  /**
   * 端点返回的参数是合法 JSON 但不是对象时（`null`、数组、标量），调用在进入执行链之前被拒绝，
   * 结果返回给模型，run 照常结束。经三协议真实适配器发送 HTTP 请求：工具的动作解析读取参数字段，
   * `null` 传入后会在单次执行的错误处理之外抛出，整轮以 `provider_error` 失败。
   */
  test('参数不是 JSON 对象的调用被拒绝，结果返回给模型，run 照常结束', async () => {
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

describe('停止能中止停滞的工具', () => {
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
        // 有意不检查 ctx.signal：本用例验证的正是等待方不检查信号时停止仍然生效。
        return new Promise(() => {}) as never
      },
    })
    return { registry, entered }
  }

  test('工具永不返回时，点击停止仍在毫秒级以 user_interrupt 结束', async () => {
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

    // 工具开始执行后立即停止。
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
    // 毫秒级结束，不等待该工具（它永不返回）。5 秒上限留有充足余量。
    expect(ms).toBeLessThan(5_000)
    // 中断不是错误，不应发出 run.error。
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

  test('连续的并行安全调用合并为一批，不安全的调用单独成批并分隔前后', () => {
    const calls = [
      call('peek', { path: 'a' }),
      call('peek', { path: 'b' }),
      call('write'),
      call('peek', { path: 'c' }),
    ]
    expect(shape(calls)).toEqual([[0, 1], [2], [3]])
  })

  test('同一资源键不进入同一批', () => {
    expect(shape([call('peek', { path: 'a' }), call('peek', { path: 'a' })])).toEqual([[0], [1]])
  })

  test('副作用判定只采用明确事实', () => {
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

/**
 * 投递额度按 provider 决策计算一次。
 *
 * 余量 = 软阈值 − 决策开始时的占用读数，全部波次共用一份；响应输出使占用超过软阈值时，
 * 在开启第一条工具记录之前先压缩，再计算额度。
 */
describe('投递额度按决策计算', () => {
  /** 每次调用按固定量申请额度，记录每次是否放行。串行执行，三个调用各占一个波次。 */
  function grabRegistry(tokens: number, admitted: boolean[], seen: number[] = []): ToolRegistry {
    const registry = new ToolRegistry()
    registry.register({
      name: 'grab',
      description: '申请一段固定额度。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'read',
      objectLabel: '测试',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn(_args, ctx) {
        seen.push(batchRemaining(ctx))
        const ok = chargeBatchBudget(ctx, tokens).ok
        admitted.push(ok)
        return { status: ok ? 'success' : 'failure', message: ok ? 'ok' : '装不下' }
      },
    })
    return registry
  }

  /**
   * 假 adapter，第一轮报告的输入量由 `input(本地估算)` 给出：第一轮发起调用，第二轮结束。
   * 报告值与估算值之比即 provider 真值与本地估算之比，额度按该比值折算。
   */
  function adapterWithUsage(
    calls: WireToolCall[],
    input: (estimated: number) => number,
  ): LlmAdapter {
    const base = fakeAdapter([calls, null])
    let turn = 0
    return {
      ...base,
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        const first = turn++ === 0
        for await (const ev of base.stream(req)) {
          if (first && ev.type === 'usage') {
            const estimated = estimateRequest(req, base.spec.density)
            yield { ...ev, usage: { ...ev.usage, inputTokens: input(estimated), outputTokens: 0 } }
          } else yield ev
        }
      },
    }
  }

  async function drain(loop: AgentLoop, history: WireMessage[] = []): Promise<void> {
    for await (const _ of loop.run({
      runId: 'rn_budget' as never,
      history,
      signal: new AbortController().signal,
    })) {
      // 只检查工具一侧记录的额度
    }
  }

  /** 约 30 万 token 的历史，使占用与本地估算都达到真实量级。 */
  const bulky: WireMessage[] = [{ role: 'user', content: '甲'.repeat(270_000) }]

  /**
   * 同一决策的三个调用分三个波次执行。若每个波次重新计算额度，三次都会放行，
   * 总量超过决策开始时的余量。
   */
  test('三个波次共用一份额度，不逐波次清零', async () => {
    const admitted: boolean[] = []
    // 窗口 1M，软阈值 800K；占用为数十 token，余量在 80 万–94 万之间（本次响应的消息使真值与估算之比略大于 1）。
    // 每次 35 万：两次之和在余量内，三次超出余量，与余量在该区间内的具体取值无关。
    const loop = new AgentLoop({
      adapter: adapterWithUsage([call('grab'), call('grab'), call('grab')], (e) => e),
      registry: grabRegistry(350_000, admitted),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })
    await drain(loop)
    expect(admitted).toEqual([true, true, false])
  })

  test('额度是软阈值以下的余量，不是固定常数', async () => {
    const seen: number[] = []
    let estimated = 0
    const loop = new AgentLoop({
      adapter: adapterWithUsage([call('grab')], (e) => {
        estimated = e
        return e
      }),
      registry: grabRegistry(31_000, [], seen),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })
    await drain(loop, bulky)
    expect(estimated).toBeGreaterThan(250_000)
    // 真值与估算一致时，额度等于软阈值减占用；剩余差值是本次 assistant 消息的估算。
    expect(seen[0]!).toBeGreaterThan(800_000 - estimated - 100)
    expect(seen[0]!).toBeLessThanOrEqual(800_000 - estimated + 100)
  })

  /**
   * 余量按整份请求上真值与估算之比折算为估算值，只缩小不放大：整份请求的比值是平均值，
   * 单段结果的比值可能低得多（生僻字正文为 0.65），按平均值放大会使一次投递的真值超出窗口。
   */
  test('估算高于 provider 真值时额度不放大，等于真实余量', async () => {
    const seen: number[] = []
    let estimated = 0
    const loop = new AgentLoop({
      adapter: adapterWithUsage([call('grab')], (e) => {
        estimated = e
        return Math.round(e / 2)
      }),
      registry: grabRegistry(1, [], seen),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })
    await drain(loop, bulky)
    const real = 800_000 - Math.round(estimated / 2)
    expect(seen[0]!).toBeGreaterThan(real - 100)
    expect(seen[0]!).toBeLessThanOrEqual(real + 100)
  })

  test('估算低于 provider 真值时额度按比值缩小', async () => {
    const seen: number[] = []
    let estimated = 0
    const loop = new AgentLoop({
      adapter: adapterWithUsage([call('grab')], (e) => {
        estimated = e
        return e * 2
      }),
      registry: grabRegistry(1, [], seen),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })
    await drain(loop, bulky)
    const real = 800_000 - estimated * 2
    expect(seen[0]!).toBeGreaterThan(real * 0.45)
    expect(seen[0]!).toBeLessThan(real * 0.55)
  })

  /**
   * 响应的输出使占用超过软阈值：不压缩时本次决策的额度为 0，读取全部失败。
   * 压缩记录必须位于第一条工具记录之前，否则同一决策会被拆分为两个单元。
   */
  test('决策开始时占用超过软阈值：先压缩，压缩记录在工具记录之前，再按压缩后的占用计算额度', async () => {
    const order: string[] = []
    const persist = noopPersistence()
    const admitted: boolean[] = []
    const seen: number[] = []
    let runs = 0
    const loop = new AgentLoop({
      adapter: adapterWithUsage([call('grab')], () => 850_000),
      registry: grabRegistry(300_000, admitted, seen),
      systemPrompt: 'sys',
      persist: {
        ...persist,
        recordCompaction: (...a) => {
          order.push('compaction')
          persist.recordCompaction(...a)
        },
        openToolStep: (...a) => {
          order.push('tool')
          return persist.openToolStep(...a)
        },
      },
      makeToolContext: (runId) => baseCtx(runId),
      compaction: {
        project: (messages) => messages,
        run: async () => {
          runs++
          return {
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
        },
      },
    })
    await drain(loop)
    expect(runs).toBe(1)
    expect(order).toEqual(['compaction', 'tool'])
    expect(admitted).toEqual([true])
    expect(seen[0]).toBeGreaterThan(700_000)
  })

  /**
   * 软阈值以下时压缩端口只收纳或跳过，不调用模型：跳过时没有任何改动，不发出开始事件，也不写入记录。
   * 超过软阈值时，跳过仍发出事件并写入记录：上下文仍在软阈值以上。
   */
  test('软阈值以下的跳过不发出事件、不写入记录；超过软阈值时照常发出并记录', async () => {
    const cases: [number, { events: string[]; recorded: boolean }][] = [
      [790_000, { events: [], recorded: false }],
      [850_000, { events: ['started', 'skipped'], recorded: true }],
    ]
    for (const [reported, expected] of cases) {
      const persist = noopPersistence()
      let records = 0
      let runs = 0
      const loop = new AgentLoop({
        adapter: adapterWithUsage([call('grab')], () => reported),
        registry: grabRegistry(1, []),
        systemPrompt: 'sys',
        persist: {
          ...persist,
          recordCompaction: (...a) => {
            records++
            persist.recordCompaction(...a)
          },
        },
        makeToolContext: (runId) => baseCtx(runId),
        compaction: {
          project: (messages) => messages,
          run: async () => {
            runs++
            return { status: 'skipped', reasonCode: 'nothing_to_fold' }
          },
        },
      })
      const events: string[] = []
      for await (const ev of loop.run({
        runId: 'rn_budget' as never,
        history: [],
        signal: new AbortController().signal,
      })) {
        if (ev.type === 'compaction') events.push(ev.phase)
      }
      expect(runs).toBeGreaterThan(0)
      expect({ events: events.slice(0, 2), recorded: records > 0 }).toEqual(expected)
    }
  })
})
