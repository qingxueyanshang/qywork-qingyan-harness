/**
 * 覆盖 `loop/turn-end.ts`：输出截断时丢弃工具调用、`end_turn` 与未完成待办、
 * `tool_use` 却没有可解析调用。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireToolCall } from '@qywork/ai'
import { buildAdapter, lookupModel } from '@qywork/ai'
import {
  FAULT_PROTOCOLS,
  faultBaseUrl,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent, TodoItem } from '@qywork/core'
import { AgentLoop } from '../index.ts'
import { type DelegatePort, ToolRegistry } from '../registry.ts'
import { baseCtx, call, fakeAdapter, noopPersistence } from './fixtures.test-helper.ts'

describe('输出被截断时不执行工具', () => {
  for (const protocol of FAULT_PROTOCOLS) {
    test(`${protocol.kind} 参数截断加 max_tokens：一次都不执行，终态是 output_truncated`, async () => {
      const fault = startFaultServer('truncated_tool_call')
      let executed = 0
      const toolSteps: string[] = []
      const registry = new ToolRegistry()
      registry.register({
        name: 'echo',
        description: '回显。',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number' } },
          required: [],
          additionalProperties: false,
        },
        actionKind: 'read',
        objectLabel: '内容',
        category: 'session',
        facet: '测试',
        summary: '测试夹具',
        permissionEffect: 'read',
        fn: async () => {
          executed++
          return { status: 'success', executed: true, message: 'ok' }
        },
      })
      const persist = noopPersistence()
      persist.openToolStep = () => {
        const id = `st_tool_${toolSteps.length}`
        toolSteps.push(id)
        return id
      }
      const loop = new AgentLoop({
        adapter: buildAdapter({
          kind: protocol.kind,
          model: protocol.model,
          apiKey: 'sk-fault',
          baseUrl: faultBaseUrl(fault, protocol.kind),
        }),
        registry,
        systemPrompt: 's',
        makeToolContext: baseCtx,
        persist,
        streamIdleTimeoutMs: 5_000,
      })
      const types: string[] = []
      let stopReason = ''
      try {
        for await (const ev of loop.run({
          runId: `rn_trunc_${protocol.kind}` as never,
          history: [],
          signal: new AbortController().signal,
        })) {
          types.push(ev.type)
          if (ev.type === 'run.finished') stopReason = ev.stopReason
        }
      } finally {
        fault.stop()
      }

      // 注册表里有 `echo`，参数校验也放得过（没有必填项）。挡住它的只有终态本身。
      expect(executed).toBe(0)
      expect(toolSteps).toEqual([])
      expect(types).not.toContain('tool.started')
      expect(stopReason).toBe('output_truncated')
      expect(types).not.toContain('run.error')
      // 只发过一次：截断不是可重发的失败。
      expect(fault.receipts.length).toBe(1)
    }, 20_000)
  }
})

describe('正常响应结束不冒充任务完成', () => {
  const unfinished: TodoItem[] = [
    { id: 'todo_1', content: '完成第 7 步', status: 'in_progress' },
    { id: 'todo_2', content: '完成第 8 步', status: 'pending' },
  ]

  async function runToEnd(
    loop: AgentLoop,
    input: { runId: string } = { runId: 'rn_todos' },
  ): Promise<AgentEvent> {
    let finished: AgentEvent | null = null
    for await (const ev of loop.run({
      runId: input.runId as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') finished = ev
    }
    expect(finished).toBeDefined()
    return finished!
  }

  /**
   * 原始失败的正向回归：第一轮正文说完但清单仍未完成，不得落 completed。
   * 第二轮通过工具把同一账本改完，第三轮正常 end_turn 才能结束。
   */
  test('未完成待办让同一循环续跑，清单完成后才结束', async () => {
    let todos = structuredClone(unfinished)
    const registry = new ToolRegistry()
    registry.register({
      name: 'finish_todos',
      description: '把测试清单标成完成。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'write',
      objectLabel: '待办',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        todos = todos.map((todo) => ({ ...todo, status: 'completed' }))
        return { status: 'success', message: '清单已完成' }
      },
    })

    const inner = fakeAdapter([null, [call('finish_todos')], null])
    const requests: ChatRequest[] = []
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
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
        ...baseCtx(runId),
        todos: { read: () => structuredClone(todos) },
      }),
    })

    const finished = await runToEnd(loop)

    expect(finished.type === 'run.finished' && finished.stopReason).toBe('completed')
    expect(requests).toHaveLength(3)
    // 第一轮正文已经进同一份 transcript，续跑不是另起一条隐藏路径。
    expect(
      requests[1]!.messages.some(
        (message) => message.role === 'assistant' && message.content === '完成',
      ),
    ).toBe(true)
    expect(todos.every((todo) => todo.status === 'completed')).toBe(true)
  })

  test('子任务成功只代表返回，父验收前不推进待办', async () => {
    let todos: TodoItem[] = [
      { id: 'todo_1', content: '交给子 agent', status: 'in_progress' },
      { id: 'todo_2', content: '主会话收尾', status: 'pending' },
    ]
    const registry = new ToolRegistry()
    registry.register({
      name: 'subagent',
      description: '测试子任务。',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      actionKind: 'run',
      objectLabel: '子 agent',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        return { status: 'success', message: '做完了' }
      },
    })
    const persist = noopPersistence()
    let beforeAcceptance: TodoItem[] = []
    const loop = new AgentLoop({
      adapter: fakeAdapter([
        [call('subagent', { task: '执行', parentTodo: '交给子 agent' })],
        [call('finish_todos')],
        null,
      ]),
      registry,
      systemPrompt: 'sys',
      persist,
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        todos: { read: () => structuredClone(todos) },
      }),
    })
    registry.register({
      name: 'finish_todos',
      description: '完成收尾。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'write',
      objectLabel: '待办',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        beforeAcceptance = structuredClone(todos)
        todos = todos.map((todo) => ({ ...todo, status: 'completed' }))
        return { status: 'success', message: '收尾完成' }
      },
    })

    const events: AgentEvent[] = []
    for await (const event of loop.run({
      runId: 'rn_subagent_todo' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      events.push(event)
    }

    expect(beforeAcceptance.map((todo) => todo.status)).toEqual(['in_progress', 'pending'])
    expect(events.some((event) => event.type === 'todos')).toBe(false)
  })

  /** 续起那一次请求的末尾要带着「清单还有几项未完成」这条事实，而不是静默续起。 */
  test('待办未完成时续起，下一次请求带着未完成的清单', async () => {
    const inner = fakeAdapter([null, null, null])
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
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        todos: { read: () => structuredClone(unfinished) },
      }),
    })
    const finished = await runToEnd(loop, { runId: 'rn_todos_notice' })
    expect(finished.type === 'run.finished' && finished.stopDetail).toBe(
      '待办未完成时连续三次只回话不动手',
    )
    expect(tails[1]?.role).toBe('user')
    expect(String(tails[1]?.content)).toContain('待办清单尚有 2 项未完成：完成第 7 步；完成第 8 步')
    expect(String(tails[1]?.content)).toContain('本轮未结束')
  })

  test('相同未完成清单下连续三次只结束响应，停为 no_progress', async () => {
    const inner = fakeAdapter(Array.from({ length: 10 }, () => null))
    let requests = 0
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        requests++
        yield* inner.stream(req)
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        todos: { read: () => structuredClone(unfinished) },
      }),
    })

    const finished = await runToEnd(loop, { runId: 'rn_todos_stuck' })

    expect(finished.type === 'run.finished' && finished.stopReason).toBe('no_progress')
    expect(requests).toBe(3)
  })

  /**
   * 派出即返回：子 agent 的生命期跟着会话，不跟着这一轮。循环因此不认识「还有几个在跑」，
   * 模型说完就是说完——扣住这一轮等它们，正是 10 分钟一次往返那条路的起点。
   */
  test('派出过子 agent 之后 end_turn 照常结束', async () => {
    const delegate: DelegatePort = {
      resolveModel: (name) => ({ provider: 'p', model: name }),
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => ({ ok: true, subagentId: 'cv_child', name: '赛车-glm', kind: 'temp' }),
      runGraph: async () => ({ ok: true }),
      inflight: () => [],
    }
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({ ...baseCtx(runId), delegate }),
    })
    const finished = await runToEnd(loop, { runId: 'rn_subagent_end_turn' })
    expect(finished.type === 'run.finished' && finished.stopReason).toBe('completed')
  })
  /**
   * 清单没完成而活在子 agent 手里时，这一轮结束是对的：回执到了会再起一轮。
   * 扣住不放的后果实测过：模型没事找事（读磁盘、读会话历史），连续两条回复中间
   * 没有 user 消息，deepseek 思考模式当场 400。
   */
  test('清单未完成但有子 agent 在跑：end_turn 照常结束，不塞续起提示', async () => {
    const inner = fakeAdapter(Array.from({ length: 5 }, () => null))
    let requests = 0
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        requests++
        yield* inner.stream(req)
      },
    }
    const delegate: DelegatePort = {
      resolveModel: (name) => ({ provider: 'p', model: name }),
      targets: async () => ({ roles: [], clis: [] }),
      subagents: async () => [],
      dispatch: async () => ({ ok: true, subagentId: 'cv_child', name: '审查员', kind: 'temp' }),
      runGraph: async () => ({ ok: true }),
      inflight: () => [{ name: '审查员' }],
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        delegate,
        todos: { read: () => structuredClone(unfinished) },
      }),
    })
    const finished = await runToEnd(loop, { runId: 'rn_todos_delegated' })
    expect(finished.type === 'run.finished' && finished.stopReason).toBe('completed')
    expect(requests).toBe(1)
  })

  /**
   * 续起提示只进请求不落 transcript，模型接下来那条与上一条 assistant 之间没有 user 消息。
   * deepseek 思考模式要求同一轮里每条 assistant 都带回推理正文，只挂工具轮的话下一次请求 400。
   */
  test('守卫续起时，刚结束的那条回复带上它的推理正文', async () => {
    const inner = fakeAdapter([null, null, null])
    const seen: (string | undefined)[][] = []
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        seen.push(req.messages.filter((m) => m.role === 'assistant').map((m) => m.reasoningContent))
        yield { type: 'request_prepared', measuredInputTokens: 1 }
        yield { type: 'response_started', headersAt: Date.now() }
        yield { type: 'thinking_delta', delta: '想一想', at: Date.now() }
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        todos: { read: () => structuredClone(unfinished) },
      }),
    })
    await runToEnd(loop, { runId: 'rn_todos_reasoning' })
    // 第二次请求里，第一条 assistant（被续起的那条）已经带着推理正文。
    expect(seen[1]).toEqual(['想一想'])
    expect(seen[2]).toEqual(['想一想', '想一想'])
  })

  test('没有清单或清单全部完成，保留一次正常 completed', async () => {
    const cases: Array<{ runId: string; todos?: TodoItem[] }> = [
      { runId: 'rn_no_todos' },
      {
        runId: 'rn_done_todos',
        todos: [{ id: 'todo_done', content: '已经完成', status: 'completed' }],
      },
    ]

    for (const item of cases) {
      let requests = 0
      const inner = fakeAdapter([null])
      const adapter: LlmAdapter = {
        ...inner,
        async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
          requests++
          yield* inner.stream(req)
        },
      }
      const loop = new AgentLoop({
        adapter,
        registry: new ToolRegistry(),
        systemPrompt: 'sys',
        persist: noopPersistence(),
        makeToolContext: (runId) => ({
          ...baseCtx(runId),
          ...(item.todos ? { todos: { read: () => structuredClone(item.todos!) } } : {}),
        }),
      })

      const finished = await runToEnd(loop, { runId: item.runId })
      expect(finished.type === 'run.finished' && finished.stopReason).toBe('completed')
      expect(requests).toBe(1)
    }
  })

  test('超过旧默认 120 轮仍继续执行，直到任务自然完成', async () => {
    const registry = new ToolRegistry()
    let executed = 0
    registry.register({
      name: 'advance',
      description: '每轮推进一次长任务。',
      parameters: {
        type: 'object',
        properties: { index: { type: 'number' } },
        required: ['index'],
        additionalProperties: false,
      },
      actionKind: 'write',
      objectLabel: '长任务',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        executed++
        return { status: 'success', message: `推进到 ${executed}` }
      },
    })
    const turns: (WireToolCall[] | null)[] = [
      ...Array.from({ length: 121 }, (_, index) => [call('advance', { index })]),
      null,
    ]
    const loop = new AgentLoop({
      adapter: fakeAdapter(turns),
      registry,
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => baseCtx(runId),
    })

    const finished = await runToEnd(loop, { runId: 'rn_beyond_old_limit' })
    expect(finished.type === 'run.finished' && finished.stopReason).toBe('completed')
    expect(executed).toBe(121)
  })
})

/**
 * 思考强度从 `RunInput` 走到 `ChatRequest`。
 *
 * 这是那条链路的最后一跳，也是最容易断的一跳——它两头都有类型，
 * 中间少传一个字段不会报任何错，表现只是「选了 max 和选了 low 一模一样」。
 */

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
          yield { type: 'text_delta', delta: '我这就去执行', at: Date.now() }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: 'tool_calls' }
        },
      },
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
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
