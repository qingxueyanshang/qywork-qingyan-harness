/**
 * 覆盖 `loop/turn-end.ts`：输出截断时丢弃工具调用并续写、`end_turn` 与未完成待办、
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
    test(`${protocol.kind} 参数截断且 max_tokens：不执行任何调用，连续三次截断后终态为 output_truncated`, async () => {
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

      // 注册表中有 `echo`，参数校验也能通过（没有必填项）。阻止执行的只有终止原因本身。
      expect(executed).toBe(0)
      expect(toolSteps).toEqual([])
      expect(types).not.toContain('tool.started')
      expect(stopReason).toBe('output_truncated')
      expect(types).not.toContain('run.error')
      // 每次截断后续写一次，夹具每次都截断，第三次由无进展判据停止。
      expect(fault.receipts.length).toBe(3)
    }, 20_000)
  }
})

describe('输出截断后续写', () => {
  /** 实测形状：Opus 5.5 xhigh 单次请求的思考达到 128K 上限，未发出任何调用。 */
  test('只有签名思考时被截断：下一次请求原样携带思考与续写提示，随后正常完成', async () => {
    const seen: ChatRequest['messages'][] = []
    const reasoning = { items: [{ type: 'thinking', thinking: '想', signature: 's' }], tokens: 9 }
    const inner = fakeAdapter([])
    const adapter: LlmAdapter = {
      ...inner,
      spec: lookupModel('claude-opus-5-5', 'anthropic_messages'),
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        seen.push(structuredClone(req.messages))
        yield { type: 'request_prepared', measuredInputTokens: 1 }
        yield { type: 'thinking_delta', delta: '想', at: Date.now() }
        if (seen.length === 1) {
          yield { type: 'response_reasoning', reasoning, at: Date.now() }
          yield { type: 'done', stopReason: 'max_tokens', rawStopReason: 'max_tokens' }
        } else {
          yield { type: 'text_delta', delta: '完成', at: Date.now() }
          yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'end_turn' }
        }
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: baseCtx,
    })
    let stopReason = ''
    for await (const ev of loop.run({
      runId: 'rn_truncated_thinking' as never,
      history: [{ role: 'user', content: '做个游戏' }],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'run.finished') stopReason = ev.stopReason
    }

    expect(stopReason).toBe('completed')
    expect(seen.length).toBe(2)
    const [, assistant, notice] = seen[1]!
    expect(assistant!.role).toBe('assistant')
    expect(assistant!.responseReasoning?.items).toEqual(reasoning.items)
    expect(notice!.role).toBe('user')
    expect(notice!.content).toContain('达到单次上限')
  })
})

describe('正常响应结束不等于任务完成', () => {
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
   * 原始失败的正向回归：第一轮正文结束但清单仍未完成，不得记为 completed。
   * 第二轮通过工具完成同一账本，第三轮正常 end_turn 后才能结束。
   */
  test('未完成待办使同一循环继续执行，清单完成后才结束', async () => {
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
    // 第一轮正文已经进入同一份 transcript，继续执行不是另起一条隐藏路径。
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

  /** 自动继续的那次请求末尾必须带有清单未完成项的事实，而不是不加说明地继续。 */
  test('待办未完成时自动继续，下一次请求带有未完成的清单', async () => {
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
      '待办未完成时连续三次仅回复而未执行操作',
    )
    expect(tails[1]?.role).toBe('user')
    expect(String(tails[1]?.content)).toContain('本轮待办仍在进行中：完成第 7 步；完成第 8 步')
    expect(String(tails[1]?.content)).toContain('单个工具调用失败不是受阻')
  })

  test('相同未完成清单下连续三次只结束响应，停止原因为 no_progress', async () => {
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

  test('本轮受阻清单只剩 pending，保留未完成项且一次响应后停止，记为等待用户回复而不是出错', async () => {
    const todos = unfinished.map((todo) => ({ ...todo, status: 'pending' as const }))
    const inner = fakeAdapter([null])
    let requests = 0
    const loop = new AgentLoop({
      adapter: {
        ...inner,
        async *stream(req) {
          requests++
          for await (const event of inner.stream(req)) {
            yield event.type === 'text_delta'
              ? { ...event, delta: '当前页面缺少必要信息，无法继续。' }
              : event
          }
        },
      },
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({ ...baseCtx(runId), todos: { read: () => todos } }),
    })
    const finished = await runToEnd(loop)
    expect(finished).toMatchObject({ status: 'done', stopReason: 'awaiting_user' })
    expect(finished.type === 'run.finished' && finished.stopDetail).toBeUndefined()
    expect(requests).toBe(1)
    expect(todos.every((todo) => todo.status === 'pending')).toBe(true)
  })

  test('新一轮只解释问题，旧清单不强迫恢复执行', async () => {
    const inner = fakeAdapter([null])
    let requests = 0
    const reads: unknown[] = []
    const loop = new AgentLoop({
      adapter: {
        ...inner,
        async *stream(req) {
          requests++
          yield* inner.stream(req)
        },
      },
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist: noopPersistence(),
      makeToolContext: (runId) => ({
        ...baseCtx(runId),
        todos: {
          read: (owner) => {
            reads.push(owner)
            return owner === undefined ? unfinished : null
          },
        },
      }),
    })
    const finished = await runToEnd(loop, { runId: 'rn_question' })
    expect(finished.type === 'run.finished' && finished.stopReason).toBe('completed')
    expect(requests).toBe(1)
    expect(reads).toEqual(['rn_question'])
  })

  /**
   * 派发后立即返回：子 agent 的生命周期跟随会话，不跟随本轮。循环因此不跟踪运行中的子 agent 数量，
   * 模型回答完毕即结束：保持本轮等待子 agent 是每次往返耗时 10 分钟的原因。
   */
  test('派发子 agent 之后 end_turn 照常结束', async () => {
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
   * 清单未完成而剩余工作由子 agent 执行时，本轮结束是正确的：回执到达后会开始新的一轮。
   * 保持本轮的后果已实测：模型执行无关操作（读取磁盘、读取会话历史），连续两条回复之间
   * 没有 user 消息，deepseek 思考模式随即返回 400。
   */
  test('清单未完成但有子 agent 运行中：end_turn 照常结束，不插入自动继续提示', async () => {
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
   * 自动继续提示写入 transcript，此后每次请求都在原位置携带它：若只附加一次，再下一次请求的
   * 前缀与产生该轮响应时不同，该轮之后的思考块会被 provider 作废。
   * DeepSeek 的推理正文照常随每条 assistant 消息回传。
   */
  test('待办检查的自动继续提示保留在历史原位，推理正文照常回传', async () => {
    const inner = fakeAdapter([null, null, null], 'deepseek-flash')
    const seen: (string | undefined)[][] = []
    const shapes: string[][] = []
    const adapter: LlmAdapter = {
      ...inner,
      async *stream(req): AsyncGenerator<ProviderEvent, void, unknown> {
        shapes.push(req.messages.map((m) => m.role))
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
    expect(seen[1]).toEqual(['想一想'])
    expect(seen[2]).toEqual(['想一想', '想一想'])
    // 第一次自动继续的提示在第三次请求中仍在原位；第二次自动继续时无进展判据先发出重复告警，
    // 待办提示位于其后，各占一条。
    expect(shapes[1]).toEqual(['assistant', 'user'])
    expect(shapes[2]).toEqual(['assistant', 'user', 'assistant', 'user', 'user'])
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

  test('执行超过 120 轮仍不终止，直到任务完成', async () => {
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
 * 思考强度从 `RunInput` 传递到 `ChatRequest`。
 *
 * 这是该链路的最后一步，也最容易遗漏：两端都有类型，
 * 中间遗漏一个字段不会产生任何报错，只会使选择 max 与选择 low 的效果相同。
 */

describe('provider 声明调用工具但未解析出任何调用', () => {
  /**
   * 复现的是原始失败形状（会话 `cv_0mszld8o60000yi2u5m`）：一轮零工具调用、
   * `run` 记为正常完成、账本中无法查到原因，界面上只有模型声称已完成。
   *
   * 反向断言比正向断言更重要：原有的错误结果必须无法再现。只断言新分支被命中时，
   * 若 `completed` 被重新加回作为后备结果，本测试仍然通过。
   */
  test('记为故障而不是完成，且 provider 的原始终止原因写入账本', async () => {
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
        // provider 返回 tool_calls，但整轮没有任何 tool_calls 事件：
        // 中转站将非流式响应强制转为 SSE、或名称分片丢失时都是这种形状。
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
    // 原有的错误结果是 completed，必须无法再现。
    expect(finished && 'stopReason' in finished && finished.stopReason).not.toBe('completed')
    expect(finished && 'stopReason' in finished && finished.stopReason).toBe('provider_error')
    // 故障对用户可见，不只记录在账本中。
    expect(events.some((e) => e.type === 'run.error')).toBe(true)
    // provider 的原始终止原因写入账本：缺少它时无法区分回答完毕与要求调用工具。
    expect(settled.at(-1)?.finishReason).toBe('tool_calls')
  })
})
