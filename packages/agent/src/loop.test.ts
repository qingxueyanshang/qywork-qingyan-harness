import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireToolCall } from '@qywork/ai'
import { lookupModel } from '@qywork/ai'
import { AgentLoop, type LoopPersistence, type ToolContext } from './index.ts'
import { ToolRegistry } from './registry.ts'

/** 按脚本回放的假 adapter：每次 stream() 吐出预设的一轮。 */
function fakeAdapter(turns: (WireToolCall[] | null)[]): LlmAdapter {
  let turn = 0
  return {
    kind: 'anthropic',
    transmits: { thinking: true, effort: true },
    spec: lookupModel('claude-opus-5', 'anthropic'),
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
    saveContext: () => {},
  }
}

function call(name: string, args: Record<string, unknown> = {}): WireToolCall {
  return { id: `c_${Math.random().toString(36).slice(2)}`, name, arguments: args }
}

describe('ToolContext 生命周期', () => {
  /**
   * 回归测试：ctx.state 必须跨轮、跨波次保持同一个对象。
   *
   * 曾经的实现每个执行波次重建一次 ToolContext，导致 files 工具记录的
   * 「本轮读过哪些文件」立刻丢失，写入守卫把刚读过的文件判成没读过。
   * 实测后果：模型绕开写入工具改用 shell 手写文件，写出了 BOM + CR 换行的坏文件。
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
 * 这条路径此前**完全没有生产者**：`stream_idle_timeout` 在 ErrorCode 里躺着，
 * 全项目没人发它。实测撞到过后果——provider 侧抖一下，run 就那么挂着，
 * 既不出错也不结束，用户看到的是一个永远转圈的界面。
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
