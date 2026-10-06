/**
 * 覆盖 `loop/attempt.ts`：一轮请求的发送与事件消费（通道顺序、思考密文、参数进度）、
 * 流停滞与停止、断流后的落账与重发形状，以及逐请求传输证据。
 */

import { describe, expect, test } from 'bun:test'
import type { ChatRequest, LlmAdapter, ProviderEvent } from '@qywork/ai'
import { buildAdapter, classifyProviderError, lookupModel, ProviderError } from '@qywork/ai'
import {
  FAULT_PROTOCOLS,
  type FaultMode,
  type FaultServer,
  faultBaseUrl,
  startFaultServer,
} from '@qywork/ai/fault-server.test-helper'
import type { AgentEvent, ProviderRequestDiagnostic } from '@qywork/core'
import { AgentLoop, type LoopPersistence } from '../index.ts'
import { ToolRegistry } from '../registry.ts'
import { MAX_RESENDS } from './attempt.ts'
import {
  baseCtx,
  call,
  expectBackoff,
  fakeAdapter,
  noopPersistence,
} from './fixtures.test-helper.ts'

test('Responses 密文随现有思考步骤落盘，下一轮工具结果仍携带原样历史', async () => {
  const reasoning = {
    tokens: 0,
    items: [
      {
        type: 'reasoning',
        id: 'rs1',
        encrypted_content: 'opaque',
        summary: [],
      },
    ],
  }
  const seen: ChatRequest[] = []
  const persisted: unknown[] = []
  const adapter: LlmAdapter = {
    ...fakeAdapter([]),
    kind: 'openai_responses',
    spec: lookupModel('grok-4.7', 'openai_responses'),
    async *stream(req) {
      const { signal: _signal, ...request } = req
      seen.push(structuredClone(request))
      if (seen.length === 1) {
        yield { type: 'response_reasoning', reasoning, at: Date.now() }
        yield { type: 'tool_calls', calls: [call('read_file', { path: 'a.ts' })], at: Date.now() }
        yield { type: 'done', stopReason: 'tool_use', rawStopReason: 'completed' }
      } else {
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: 'completed' }
      }
    },
  }
  const persist = noopPersistence()
  const original = persist.openThinkingStep
  persist.openThinkingStep = (runId, seq, batchId, data) => {
    persisted.push(data)
    return original(runId, seq, batchId)
  }
  const loop = new AgentLoop({
    adapter,
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    persist,
    makeToolContext: baseCtx,
  })
  const events: AgentEvent[] = []
  for await (const ev of loop.run({
    runId: 'rn_cipher' as never,
    history: [],
    signal: new AbortController().signal,
  }))
    events.push(ev)
  const stamped = { ...reasoning, prefix: expect.any(String) }
  expect(persisted).toEqual([stamped])
  expect(seen[1]!.messages.find((m) => m.role === 'assistant')?.responseReasoning).toEqual(stamped)
  expect(events.some((e) => e.type === 'thinking.delta')).toBe(false)
})

describe('流式通道的顺序', () => {
  /**
   * 回归：一次调用中「思考 → 正文 → 思考 → 正文」必须记录为四条 step。
   *
   * 合并为「一条思考 + 一条正文」的问题不在于少两行，而在于 `seq` 无法表达真实顺序。
   * 实测形状：中转站分三次发送推理摘要，落库结果是
   * `**Inspecting…****Running tests…**` 两段连在一起，而它们原本分开到达。
   * 前端按 `seq` 重放，因此刷新后的顺序与实时显示的顺序不同。
   */
  test('通道每切换一次就新开一条 step，正文与思考各自成段', async () => {
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
        yield { type: 'thinking_delta', delta: '想一', at: Date.now() }
        yield { type: 'text_delta', delta: '说一', at: Date.now() }
        yield { type: 'thinking_delta', delta: '想二', at: Date.now() }
        yield { type: 'text_delta', delta: '说二', at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }

    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
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

    // 四段内容对应四条 step，顺序即到达顺序。
    expect(opened).toHaveLength(4)
    expect(written.get(opened[0]!)).toBe('想一')
    expect(written.get(opened[1]!)).toBe('说一')
    expect(written.get(opened[2]!)).toBe('想二')
    expect(written.get(opened[3]!)).toBe('说二')

    // 事件携带的 stepId 与落库记录一一对应，客户端无需自行生成 id。
    expect(deltas.map((d) => d.stepId)).toEqual(opened)
    expect(deltas.map((d) => d.type)).toEqual([
      'thinking.delta',
      'text.delta',
      'thinking.delta',
      'text.delta',
    ])
  })

  /** 同一通道连续到达时不新开 step：否则一句话会被拆成几十条。 */
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
        for (const d of ['a', 'b', 'c']) yield { type: 'text_delta', delta: d, at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      persist,
      makeToolContext: (runId) => baseCtx(runId),
    })
    for await (const _ of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 只检查新开的 step 数量。
    }
    expect(opened).toHaveLength(1)
  })

  /**
   * 回归：账本中一轮的 39 条 step 里有 12 条正文只含一两个空格，均位于每条模型消息开头、
   * 思考或工具调用之前。每条都是零高度的正文条目，在会话列中占用 8px 间隙，
   * 并把本应合并的工具组分隔开。
   */
  test('只含空白的前导正文不开 step，随首个可见字符一并写入', async () => {
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
    const registry = new ToolRegistry()
    registry.register({
      name: 'probe',
      description: '测试夹具',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      actionKind: 'run',
      objectLabel: '命令',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'internal_control',
      async fn() {
        return { status: 'success', message: 'ok' }
      },
    })
    let turn = 0
    const adapter: LlmAdapter = {
      kind: 'openai_chat_completions',
      transmits: { effort: true },
      spec: lookupModel('gpt-5.6-terra', 'openai_chat_completions'),
      async *stream(): AsyncGenerator<ProviderEvent, void, unknown> {
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        if (turn++ === 0) {
          yield { type: 'text_delta', delta: ' ', at: Date.now() }
          yield { type: 'thinking_delta', delta: '想', at: Date.now() }
          yield { type: 'tool_calls', calls: [call('probe')], at: Date.now() }
          yield { type: 'done', stopReason: 'tool_use', rawStopReason: '' }
          return
        }
        yield { type: 'text_delta', delta: '  ', at: Date.now() }
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }
    const loop = new AgentLoop({
      adapter,
      registry,
      systemPrompt: 'sys',
      persist,
      makeToolContext: (runId) => baseCtx(runId),
    })
    const textDeltas: string[] = []
    for await (const ev of loop.run({
      runId: 'rn_test' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      if (ev.type === 'text.delta') textDeltas.push(ev.delta)
    }
    // 第一轮的空格未新开 step；第二轮的正文对应一条 step 与一条事件，前导空白一并写入。
    expect(opened.filter((id) => id.startsWith('st_text_'))).toHaveLength(1)
    expect(opened.filter((id) => id.startsWith('st_think_'))).toHaveLength(1)
    expect([...written.values()]).toEqual(['想', '  完成'])
    expect(textDeltas).toEqual(['  完成'])
  })
})

describe('流停滞时必须有终态，不能无限期挂起', () => {
  function loopAgainst(fault: FaultServer): AgentLoop {
    return new AgentLoop({
      adapter: buildAdapter({
        kind: 'openai_responses',
        model: 'deepseek-flash',
        apiKey: 'sk-fault',
        baseUrl: fault.openaiBaseUrl,
      }),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      makeToolContext: baseCtx,
      persist: noopPersistence(),
      streamIdleTimeoutMs: 150,
      // 本组检查超时判据与接收次数，退避时长由 `resend-policy.test.ts` 锁定。
      sleep: async () => {},
    })
  }

  async function runAgainst(
    mode: FaultMode,
    runId: string,
  ): Promise<{ types: string[]; receipts: number; code: string; message: string }> {
    const fault = startFaultServer(mode)
    const types: string[] = []
    let code = ''
    let message = ''
    try {
      for await (const ev of loopAgainst(fault).run({
        runId: runId as never,
        history: [],
        signal: new AbortController().signal,
      })) {
        types.push(ev.type)
        if (ev.type === 'run.error') {
          code = ev.code
          message = ev.message
        }
      }
      return { types, receipts: fault.receipts.length, code, message }
    } finally {
      fault.stop()
    }
  }

  test('响应头之后的静默判定为超时，读数为「未收到后续数据」', async () => {
    const result = await runAgainst('headers_then_silence', 'rn_1')
    expect(result.code).toBe('stream_idle_timeout')
    // 响应头已到达，因此读数为「未收到后续数据」，而不是「未收到响应」。
    expect(result.message).toMatch(/未收到后续数据/)
    expect(result.message).not.toMatch(/未收到响应/)
    // 必须有终态。没有 run.finished 时，账本中会留下一条始终为 running 的记录。
    expect(result.types).toContain('run.finished')
  }, 20_000)

  test('正文之前的静默原样重发，额度用尽后才进入终态', async () => {
    const result = await runAgainst('headers_then_silence', 'rn_2')
    expect(result.code).toBe('stream_idle_timeout')
    expect(result.types.filter((t) => t === 'run.retrying')).toHaveLength(MAX_RESENDS)
    expect(result.message).toMatch(
      new RegExp(`^模型响应中断，\\d+ 秒未收到后续数据，已重发 ${MAX_RESENDS} 次$`),
    )
    // 每次尝试都已实际发出：服务端的接收次数等于首发次数加重发次数。
    expect(result.receipts).toBe(MAX_RESENDS + 1)
  }, 20_000)

  test('保活行维持的流不受影响：超时按字节间隔计算，不按总时长', async () => {
    const result = await runAgainst('keepalive_then_ok', 'rn_4')
    expect(result.types).not.toContain('run.error')
    expect(result.types).toContain('run.finished')
    expect(result.receipts).toBe(1)
  }, 20_000)
})

/**
 * 传输层接管响应体期间点击停止。
 *
 * 超时中断与用户停止在适配器中都表现为流出错，只有 run 的中止信号能区分两者；
 * 归类错误时，用户点击停止后界面会显示自动重连。
 */

describe('监督期间点击停止，不报告断流，也不再发送请求', () => {
  async function stopDuring(
    mode: FaultMode,
    runId: string,
    protocol: (typeof FAULT_PROTOCOLS)[number],
    abortAfterMs = 300,
  ): Promise<{ types: string[]; stopReason: string; receipts: number }> {
    const fault = startFaultServer(mode)
    const controller = new AbortController()
    const loop = new AgentLoop({
      adapter: buildAdapter({
        kind: protocol.kind,
        model: protocol.model,
        apiKey: 'sk-fault',
        baseUrl: faultBaseUrl(fault, protocol.kind),
      }),
      registry: new ToolRegistry(),
      systemPrompt: 's',
      makeToolContext: baseCtx,
      persist: noopPersistence(),
      // 空闲上限设为远大于停止时刻：停止必须由用户触发，而不是由监督触发。
      streamIdleTimeoutMs: 5_000,
    })
    const types: string[] = []
    let stopReason = ''
    const timer = setTimeout(() => controller.abort(), abortAfterMs)
    try {
      for await (const ev of loop.run({
        runId: runId as never,
        history: [],
        signal: controller.signal,
      })) {
        types.push(ev.type)
        if (ev.type === 'run.finished') stopReason = ev.stopReason
      }
      return { types, stopReason, receipts: fault.receipts.length }
    } finally {
      clearTimeout(timer)
      fault.stop()
    }
  }

  // 三种协议都必须通过：超时中断与用户停止的归类在每个适配器中各实现一次，只验证一种协议会遗漏另外两种。
  for (const protocol of FAULT_PROTOCOLS) {
    for (const mode of ['hung_error_body', 'headers_then_silence'] as const) {
      test(`${protocol.kind} 在 ${mode} 期间停止：run 以 user_interrupt 结束，不再发送请求`, async () => {
        const result = await stopDuring(mode, `rn_stop_${protocol.kind}_${mode}`, protocol)
        expect(result.stopReason).toBe('user_interrupt')
        expect(result.types).not.toContain('run.error')
        expect(result.types).not.toContain('run.retrying')
        expect(result.receipts).toBe(1)
      }, 20_000)
    }

    // 保活期间服务端持续发送字节，停止经由另一条路径：流没有出错，而是读取方退出。
    test(`${protocol.kind} 在保活期间停止：run 以 user_interrupt 结束，不再发送请求`, async () => {
      const result = await stopDuring(
        'keepalive_then_ok',
        `rn_stop_${protocol.kind}_keepalive`,
        protocol,
        150,
      )
      expect(result.stopReason).toBe('user_interrupt')
      expect(result.types).not.toContain('run.error')
      expect(result.types).not.toContain('run.retrying')
      expect(result.receipts).toBe(1)
    }, 20_000)
  }
})

/**
 * 输出上限截断时的工具调用。
 *
 * `max_tokens` 表示模型输出未完成，最后一条工具调用的参数可能止于半个 JSON；
 * 截断处恰好是合法 JSON 时也不会产生 `argumentsError`。按其执行即以残缺参数执行操作。
 */

describe('工具参数流贯穿适配器、空闲计时和界面事件', () => {
  const kinds = ['openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const
  type Kind = (typeof kinds)[number]
  const encode = new TextEncoder()
  /** 首个真实参数片段之前的保活轮数。总时长必须长于被测的空闲上限。 */
  const HEARTBEATS = 8
  const sse = (event: Record<string, unknown>) =>
    `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`

  function wire(kind: Kind, tool: boolean) {
    if (kind === 'openai_responses') {
      return {
        start: tool
          ? sse({
              type: 'response.output_item.added',
              output_index: 0,
              item: { type: 'function_call', call_id: 'call_probe', name: 'probe' },
            })
          : '',
        delta: (delta: string) =>
          sse(
            tool
              ? { type: 'response.function_call_arguments.delta', output_index: 0, delta }
              : { type: 'response.output_text.delta', delta },
          ),
        end: sse({ type: 'response.completed', response: { status: 'completed' } }),
      }
    }
    if (kind === 'openai_chat_completions') {
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        sse({ choices: [{ delta, finish_reason }] })
      return {
        start: tool
          ? chunk({
              tool_calls: [
                { index: 0, id: 'call_probe', function: { name: 'probe', arguments: '' } },
              ],
            })
          : '',
        delta: (delta: string) =>
          chunk(
            tool
              ? { tool_calls: [{ index: 0, function: { arguments: delta } }] }
              : { content: delta },
          ),
        end: `${chunk({}, tool ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
      }
    }
    return {
      start:
        sse({
          type: 'message_start',
          message: {
            id: 'msg_probe',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }) +
        sse({
          type: 'content_block_start',
          index: 0,
          content_block: tool
            ? { type: 'tool_use', id: 'call_probe', name: 'probe', input: {} }
            : { type: 'text', text: '' },
        }),
      delta: (delta: string) =>
        sse({
          type: 'content_block_delta',
          index: 0,
          delta: tool
            ? { type: 'input_json_delta', partial_json: delta }
            : { type: 'text_delta', text: delta },
        }),
      end:
        sse({ type: 'content_block_stop', index: 0 }) +
        sse({
          type: 'message_delta',
          delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        }) +
        sse({ type: 'message_stop' }),
    }
  }

  async function exercise(kind: Kind, mode: 'continuous' | 'stall' | 'heartbeat' | 'cancel') {
    let requests = 0
    let executions = 0
    let parametersComplete = false
    let earlyExecution = false
    let firstContent = false
    let contentBeforeCompletion = false
    const events: AgentEvent[] = []
    const controller = new AbortController()
    const parts = ['{"content":"', ...Array<string>(6).fill('x'), '"}']
    const endpoint = Bun.serve({
      port: 0,
      fetch() {
        requests++
        const broken = requests === 1 && (mode === 'stall' || mode === 'heartbeat')
        const tool = requests === 1 || (mode === 'stall' && requests === 2)
        const frames = wire(kind, tool)
        if (!tool)
          return new Response(frames.start + frames.delta('完成') + frames.end, {
            headers: { 'content-type': 'text/event-stream' },
          })
        let opened = false
        let sent = 0
        let pings = 0
        let canceled = false
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(sink) {
              if (opened) await Bun.sleep(60)
              if (canceled) return
              if (!opened) {
                opened = true
                sink.enqueue(encode.encode(frames.start))
                return
              }
              // 空闲判定在传输层按字节进行，因此「停滞」只能模拟为不再发送任何字节：
              // 保活行与空参数片段都是字节，发送后即不算静默。
              if (broken && mode === 'stall') return
              if (broken && mode === 'heartbeat' && pings < HEARTBEATS) {
                pings++
                // 保活与空参数维持连接，但都不是生成进展：界面不得据此报告进度。
                sink.enqueue(encode.encode(`: keep-alive\n\n${frames.delta('')}`))
                return
              }
              if (sent < parts.length) {
                sink.enqueue(encode.encode(frames.delta(parts[sent]!)))
                sent++
                return
              }
              parametersComplete = true
              sink.enqueue(encode.encode(frames.end))
              sink.close()
            },
            cancel() {
              canceled = true
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const registry = new ToolRegistry()
    registry.register({
      name: 'probe',
      description: '接收完整内容。',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
        additionalProperties: false,
      },
      actionKind: 'read',
      objectLabel: '内容',
      category: 'session',
      facet: '测试',
      summary: '测试夹具',
      permissionEffect: 'read',
      async fn(args) {
        executions++
        earlyExecution ||= !parametersComplete
        expect(args.content).toBe('xxxxxx')
        return { status: 'success', executed: true, message: 'ok' }
      },
    })
    const persist = noopPersistence()
    persist.markRequestContent = () => {
      firstContent = true
      contentBeforeCompletion ||= !parametersComplete
    }
    const model = kind === 'anthropic_messages' ? 'claude-opus-5' : 'gpt-6-astra'
    const loop = new AgentLoop({
      adapter: buildAdapter({
        kind,
        model,
        apiKey: 'sk-test',
        baseUrl: `http://127.0.0.1:${endpoint.port}/v1`,
      }),
      registry,
      systemPrompt: 's',
      persist,
      makeToolContext: baseCtx,
      streamIdleTimeoutMs: 300,
      // `stall` 会重发一次，退避时长不在本组的检查范围内。
      sleep: async () => {},
    })
    try {
      for await (const event of loop.run({
        runId: 'rn_progress' as never,
        history: [],
        signal: controller.signal,
      })) {
        events.push(event)
        if (event.type === 'tool.generating' && mode === 'cancel') controller.abort()
      }
    } finally {
      controller.abort()
      endpoint.stop(true)
    }
    return { requests, executions, earlyExecution, firstContent, contentBeforeCompletion, events }
  }

  for (const kind of kinds) {
    test(`${kind} 参数持续到达超过空闲窗口，实时报告生成且只执行完整调用一次`, async () => {
      const result = await exercise(kind, 'continuous')
      expect(result.requests).toBe(2)
      expect(result.executions).toBe(1)
      expect(result.earlyExecution).toBe(false)
      expect(result.firstContent && result.contentBeforeCompletion).toBe(true)
      expect(result.events.filter((ev) => ev.type === 'tool.generating')).toHaveLength(8)
      expect(
        result.events.some((ev) => ev.type === 'run.retrying' || ev.type === 'run.error'),
      ).toBe(false)
      expect(result.events.findIndex((ev) => ev.type === 'tool.generating')).toBeLessThan(
        result.events.findIndex((ev) => ev.type === 'tool.started'),
      )
    })

    test(`${kind} 参数停止后只有心跳和空片段，仍重连且不执行残缺调用`, async () => {
      const result = await exercise(kind, 'stall')
      expect(result.requests).toBe(3)
      expect(result.executions).toBe(1)
      expect(result.earlyExecution).toBe(false)
      expect(result.events.filter((ev) => ev.type === 'run.retrying')).toHaveLength(1)
      expect(result.events.some((ev) => ev.type === 'run.error')).toBe(false)
    })
  }

  test('首个内容之前只有保活，不伪造生成进度，也不被误判为断流', async () => {
    const result = await exercise('openai_responses', 'heartbeat')
    // 保活与空参数片段维持了连接，因此本次请求不应被判定为断流。
    expect(result.events.some((ev) => ev.type === 'run.retrying')).toBe(false)
    expect(result.events.some((ev) => ev.type === 'run.error')).toBe(false)
    // 进度事件数等于真实参数片段数：保活与空片段均不计入。
    expect(result.events.filter((ev) => ev.type === 'tool.generating')).toHaveLength(8)
    expect(result.executions).toBe(1)
    expect(result.earlyExecution).toBe(false)
  })

  test('参数生成中停止，不执行工具也不触发自动重连', async () => {
    const result = await exercise('openai_responses', 'cancel')
    expect(result.requests).toBe(1)
    expect(result.executions).toBe(0)
    expect(result.events.some((ev) => ev.type === 'run.retrying')).toBe(false)
    expect(result.events.at(-1)).toMatchObject({
      type: 'run.finished',
      stopReason: 'user_interrupt',
    })
  })
})

describe('逐请求传输证据不改变请求内容', () => {
  test('记录接口、协议、字节数以及首事件与每一段内容', async () => {
    const base = noopPersistence()
    let opened: Parameters<LoopPersistence['openRequest']>[0] | null = null
    let firstEvents = 0
    let contentMarks = 0
    const marks: string[] = []
    const loop = new AgentLoop({
      adapter: fakeAdapter([null]),
      providerName: 'relay-a',
      registry: new ToolRegistry(),
      systemPrompt: 'stable-system',
      persist: {
        ...base,
        openRequest: (input) => {
          opened = input
          return 'pr_metrics'
        },
        markRequestFirstEvent: () => {
          firstEvents++
          marks.push('event')
        },
        markRequestContent: () => {
          contentMarks++
          marks.push('content')
        },
      },
      makeToolContext: (runId) => baseCtx(runId),
    })
    for await (const _ of loop.run({
      runId: 'rn_metrics' as never,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 消费整条流，证据由 persistence 捕获。
    }

    expect(opened).toMatchObject({
      providerName: 'relay-a',
      providerKind: 'anthropic_messages',
      model: 'claude-opus-5',
    })
    expect(opened!.requestBytes).toBeGreaterThan(0)
    expect(firstEvents).toBe(1)
    expect(contentMarks).toBe(1)
    expect(marks).toEqual(['event', 'content'])
  })
})

describe('传输中断：进入终态、无痕重发、报告失败形状', () => {
  /**
   * 注入的退避等待收到的毫秒数，按调用顺序记录。每次 `collect` 开始时清空。
   *
   * 等待经由注入，本组不实际等待：退避为分钟量级，实际等待时本文件无法在时限内执行完毕。
   */
  const backoffs: number[] = []

  interface Recorded {
    opened: number[]
    settled: { status: string; errorCode: string | null; errorMessage?: string }[]
    diagnostics: ProviderRequestDiagnostic[]
    /** 已新开的思考 step，按顺序记录。 */
    thinking: string[]
    /** 被置为失败终态的 step。 */
    failed: string[]
  }

  function recordingPersistence(rec: Recorded): LoopPersistence {
    const base = noopPersistence()
    let n = 0
    return {
      ...base,
      openThinkingStep: () => {
        const id = `st_think_${n++}`
        rec.thinking.push(id)
        return id
      },
      failThinkingSteps: (ids) => rec.failed.push(...ids),
      openRequest: (input) => {
        rec.opened.push(input.retryIndex)
        return `pr_${input.retryIndex}`
      },
      settleRequest: (_id, status, _usage, errorCode, _finishReason, errorMessage) => {
        rec.settled.push({
          status,
          errorCode,
          ...(errorMessage === null || errorMessage === undefined ? {} : { errorMessage }),
        })
      },
      recordRequestDiagnostic: (_id, diagnostic) => rec.diagnostics.push(diagnostic),
    }
  }

  /**
   * 按脚本决定每次 `stream()` 的结束方式。
   *
   * `'break'` 与 `'break-after-text'` 的区别即重发的判据：前者 provider
   * 未返回任何事件（重发无痕），后者已输出正文（原样重发会使用户看到两段不同的内容）。
   */
  function scriptedAdapter(
    script: (
      | 'break'
      | 'connect-timeout'
      | 'break-after-text'
      | 'break-after-thinking'
      | 'protocol-failure'
      | 'reject'
      | 'reject-relay'
      | 'reject-upstream-forbidden'
      | 'reject-opaque-invalid'
      | 'reject-image'
      | 'rate-limit'
      | 'rate-limit-no-header'
      | 'rate-limit-after-text'
      | 'quota'
      | 'ok'
    )[],
  ): LlmAdapter & { requests: ChatRequest['messages'][] } {
    let i = 0
    return {
      kind: 'anthropic_messages',
      transmits: { effort: true },
      spec: lookupModel('claude-opus-5', 'anthropic_messages'),
      /** 每次请求的消息，按发送顺序记录。带上下文续发的断言需要检查第二次请求携带的内容。 */
      requests: [],
      async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
        this.requests.push(req.messages)
        const act = script[i++] ?? 'ok'
        yield { type: 'request_prepared', measuredInputTokens: 10 }
        if (
          act === 'break' ||
          act === 'connect-timeout' ||
          act === 'break-after-text' ||
          act === 'break-after-thinking'
        ) {
          if (act === 'break-after-text')
            yield { type: 'text_delta', delta: '我先看看', at: Date.now() }
          if (act === 'break-after-thinking')
            yield { type: 'thinking_delta', delta: '失败那段思考', at: Date.now() }
          throw new ProviderError({
            code: 'network_error',
            message: act === 'connect-timeout' ? '连接超时' : '连接被断开',
            provider: 'anthropic_messages',
            ...(act === 'connect-timeout' ? { timedOut: true } : {}),
            cause: Object.assign(new Error('The socket connection was closed unexpectedly.'), {
              code: 'ECONNRESET',
            }),
          })
        }
        if (act === 'protocol-failure') {
          throw new ProviderError({
            code: 'provider_unavailable',
            message: '响应为 200 但不含任何 SSE 数据\n协议解析明细',
            provider: 'anthropic_messages',
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
          // 中转站不返回 5xx，而是把「后端暂时不可用」放入 400 响应。本条必须经过真实的分类器：
          // 手写 ProviderError 会绕过「400 归入哪个码」这一环节，而这正是要锁定的环节。
          throw classifyProviderError(
            'anthropic_messages',
            Object.assign(new Error('{"error":{"type":"<nil>","message":"暂不可用 请稍后再试"}}'), {
              status: 400,
            }),
          )
        }
        if (act === 'reject-upstream-forbidden') {
          throw classifyProviderError(
            'openai_responses',
            Object.assign(new Error('Upstream returned HTTP 403 Forbidden'), { status: 400 }),
          )
        }
        if (act === 'reject-opaque-invalid') {
          throw classifyProviderError(
            'openai_responses',
            Object.assign(new Error('Request contains an invalid argument.'), {
              status: 400,
              error: {
                message: 'Request contains an invalid argument.',
                type: 'invalid_request_error',
              },
            }),
          )
        }
        if (act === 'reject-image') {
          // 不接受图片的模型收到图像块。同样经过真实的分类器：手写 ProviderError
          // 会绕过「400 归入哪个码」，而这正是本条要锁定的环节。
          throw classifyProviderError(
            'anthropic_messages',
            Object.assign(
              new Error(
                '{"error":{"message":"Invalid content type: image_url is not supported by this model"}}',
              ),
              { status: 400 },
            ),
          )
        }
        if (
          act === 'rate-limit' ||
          act === 'rate-limit-no-header' ||
          act === 'rate-limit-after-text'
        ) {
          if (act === 'rate-limit-after-text')
            yield { type: 'text_delta', delta: '已输出', at: Date.now() }
          throw new ProviderError({
            code: 'rate_limited',
            message: '触发限速',
            provider: 'anthropic_messages',
            status: 429,
            detail: { providerMessage: 'Rate limit reached' },
            ...(act === 'rate-limit-no-header' ? {} : { retryAfterMs: 5 }),
          })
        }
        if (act === 'quota') {
          throw new ProviderError({
            code: 'insufficient_quota',
            message: '账户额度不足',
            provider: 'anthropic_messages',
            status: 429,
          })
        }
        yield { type: 'text_delta', delta: '完成', at: Date.now() }
        yield { type: 'done', stopReason: 'end_turn', rawStopReason: '' }
      },
    }
  }

  function run(
    adapter: LlmAdapter,
    rec: Recorded,
    signal: AbortSignal = new AbortController().signal,
  ) {
    return new AgentLoop({
      adapter,
      registry: new ToolRegistry(),
      systemPrompt: 's',
      persist: recordingPersistence(rec),
      makeToolContext: (runId) => baseCtx(runId),
      // 立即返回，但仍按信号裁决：停止发生在等待期间，缺少这一判断就无法验证停止能否生效。
      sleep: async (ms, sleepSignal) => {
        backoffs.push(ms)
        if (sleepSignal.aborted) throw new DOMException('已中断', 'AbortError')
      },
    }).run({ runId: 'rn_net' as never, history: [], signal })
  }

  async function collect(adapter: LlmAdapter): Promise<{ rec: Recorded; events: AgentEvent[] }> {
    backoffs.length = 0
    const rec: Recorded = { opened: [], settled: [], diagnostics: [], thinking: [], failed: [] }
    const events: AgentEvent[] = []
    for await (const ev of run(adapter, rec)) events.push(ev)
    return { rec, events }
  }

  test('零输出的断流：原样重发，第二次成功时视为无事发生', async () => {
    const { rec, events } = await collect(scriptedAdapter(['break', 'ok']))

    // 两行请求记录，`retry_index` 为 0 与 1。覆盖上一行会丢失「实际发送过两次」这一事实。
    expect(rec.opened).toEqual([0, 1])
    expect(rec.diagnostics[0]).toMatchObject({
      causes: [
        { name: 'ProviderError', code: 'network_error', message: '连接被断开' },
        { name: 'Error', code: 'ECONNRESET' },
      ],
      retry: { decision: 'resend', attempt: 1, max: MAX_RESENDS },
    })
    // 传输失败同样先等待：立即重发不能加快恢复，只会在几毫秒内耗尽五次额度。
    expectBackoff(rec.diagnostics[0]?.retry.backoffMs, 0)
    expect(backoffs).toEqual([rec.diagnostics[0]!.retry.backoffMs!])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('断流必须进入终态：无法确定 provider 是否收到时记为 uncertain', async () => {
    const { rec } = await collect(scriptedAdapter(['break', 'ok']))

    // 第一行是中断的那次。该路径必须 settle，否则账本中的记录永久处于 in_flight（实测 9 行）。
    expect(rec.settled[0]).toEqual({ status: 'uncertain', errorCode: 'network_error' })
    expect(rec.settled[1]?.status).toBe('received')
  })

  test('provider 明确答复过即为 rejected，不是 uncertain', async () => {
    const { rec } = await collect(scriptedAdapter(['reject']))

    // 有 HTTP 状态码表示 provider 已拒绝，请求确实到达。该情形与「无法连接」必须分开记录，
    // 两者的区别在于计费责任。
    expect(rec.settled[0]).toEqual({ status: 'rejected', errorCode: 'provider_unavailable' })
  })

  test('上游自报暂时不可用：等待后重发，第二次成功时视为无事发生', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject']))

    // 不重发并不节省费用：用户仍需手动继续，那一次支付的是同一份长 prompt 的费用，
    // 而且 run 已被写为 failed，新消息还需让模型重新理解上一轮的进度。
    expect(rec.opened).toEqual([0, 1])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('中转站用 400 报告「暂时不可用」：同样重发，整轮不应就此终结', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject-relay']))

    expect(rec.opened).toEqual([0, 1])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('中转站包装的上游 403：零输出时重发，下一条渠道可用时继续原 run', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject-upstream-forbidden', 'ok']))

    expect(rec.opened).toEqual([0, 1])
    expect(rec.settled[0]).toEqual({
      status: 'rejected',
      errorCode: 'provider_unavailable',
      errorMessage: 'Upstream returned HTTP 403 Forbidden',
    })
    expect(rec.diagnostics[0]?.retry).toMatchObject({
      decision: 'resend',
      attempt: 1,
      max: MAX_RESENDS,
    })
    expectBackoff(rec.diagnostics[0]?.retry.backoffMs, 0)
    expect(events.filter((e) => e.type === 'run.retrying')).toEqual([
      expect.objectContaining({ attempt: 1, max: MAX_RESENDS }),
    ])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
  })

  test('中转站以无参数细节的 400 拒绝：零输出时经由统一的五次重发路径', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject-opaque-invalid', 'ok']))

    expect(rec.opened).toEqual([0, 1])
    expect(events.filter((e) => e.type === 'run.retrying')).toEqual([
      expect.objectContaining({ attempt: 1, max: MAX_RESENDS }),
    ])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
  })

  test('无参数细节的 400 连续失败：五次额度耗尽后保留上游原文', async () => {
    const { rec, events } = await collect(
      scriptedAdapter(Array(MAX_RESENDS + 1).fill('reject-opaque-invalid')),
    )

    expect(rec.opened).toEqual([0, 1, 2, 3, 4, 5])
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('provider_unavailable')
    expect(err?.type === 'run.error' && err.message).toBe(
      'Request contains an invalid argument，已重发 5 次',
    )
  })

  test('429 按 Retry-After 等待后原样重发', async () => {
    const { rec, events } = await collect(scriptedAdapter(['rate-limit', 'ok']))

    expect(rec.opened).toEqual([0, 1])
    expect(rec.settled[0]).toEqual({
      status: 'rejected',
      errorCode: 'rate_limited',
      errorMessage: 'Rate limit reached',
    })
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
  })

  test('429 没有 Retry-After 时按指数退避', async () => {
    const { rec } = await collect(
      scriptedAdapter(['rate-limit-no-header', 'rate-limit-no-header', 'ok']),
    )

    expect(rec.opened).toEqual([0, 1, 2])
    expect(backoffs).toHaveLength(2)
    expectBackoff(backoffs[0], 0)
    expectBackoff(backoffs[1], 1)
  })

  test('额度不足不重发', async () => {
    const { rec, events } = await collect(scriptedAdapter(['quota', 'ok']))

    expect(rec.opened).toEqual([0])
    expect(events.filter((e) => e.type === 'run.retrying')).toEqual([])
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('insufficient_quota')
  })

  test('429 前已有正文：退避后携带正文续发', async () => {
    const adapter = scriptedAdapter(['rate-limit-after-text', 'ok'])
    const { rec, events } = await collect(adapter)

    expect(rec.opened).toEqual([0, 0])
    expect(events.filter((e) => e.type === 'run.retrying')).toHaveLength(1)
    expect(
      (adapter.requests[1] ?? []).some((m) => m.role === 'assistant' && m.content === '已输出'),
    ).toBe(true)
  })

  test('等待限速退避时可以停止', async () => {
    const controller = new AbortController()
    const rec: Recorded = { opened: [], settled: [], diagnostics: [], thinking: [], failed: [] }
    const events: AgentEvent[] = []
    for await (const ev of run(scriptedAdapter(['rate-limit', 'ok']), rec, controller.signal)) {
      events.push(ev)
      if (ev.type === 'run.retrying') controller.abort()
    }

    expect(rec.opened).toEqual([0])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('user_interrupt')
  })

  test('429 重发耗尽后保留上游原文', async () => {
    const { rec, events } = await collect(
      scriptedAdapter(Array(MAX_RESENDS + 1).fill('rate-limit')),
    )

    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.message).toBe(`触发限速，已重发 ${MAX_RESENDS} 次`)
    expect(rec.settled.at(-1)?.errorMessage).toBe('Rate limit reached')
  })

  /**
   * 原始失败形状：不接受图片的模型收到图像块，界面从「正在重连 1 / 5」计数到 5，
   * 而「模型不接受图片」这一原因始终未显示。
   *
   * 锁定的是**一次都不重发**：只开一行请求记录、没有 `run.retrying`、错误码为
   * `invalid_request`、provider 原文原样显示在界面上。
   */
  test('请求被明确拒绝：一次都不重发，界面不显示「正在重连」', async () => {
    const { rec, events } = await collect(scriptedAdapter(['reject-image', 'ok']))

    expect(rec.opened).toEqual([0])
    expect(events.filter((e) => e.type === 'run.retrying')).toEqual([])
    expect(rec.diagnostics[0]?.retry.decision).toBe('not_retryable')
    const err = events.find((e) => e.type === 'run.error')
    expect(err?.type === 'run.error' && err.code).toBe('invalid_request')
    expect(err?.type === 'run.error' && err.message).toContain('image_url is not supported')
    expect(rec.settled[0]).toEqual({
      status: 'rejected',
      errorCode: 'invalid_request',
      errorMessage:
        '{"error":{"message":"Invalid content type: image_url is not supported by this model"}}',
    })
  })

  test('重发后仍不可用：正文不得附带传输读数，上游已明确答复，请求已送达', async () => {
    const { events } = await collect(scriptedAdapter(Array(MAX_RESENDS + 1).fill('reject')))

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).toContain('服务端暂时不可用')
    expect(message).toContain(`已重发 ${MAX_RESENDS} 次`)
    // 「N 秒未收到响应」是传输层的读数，附加该读数等于告知用户请求未发出。
    expect(message).not.toMatch(/秒未收到响应/)
  })

  test('无状态码的协议失败不显示为超时，重试说明保留在首行', async () => {
    const { events } = await collect(
      scriptedAdapter(Array(MAX_RESENDS + 1).fill('protocol-failure')),
    )

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).toBe(`响应为 200 但不含任何 SSE 数据，已重发 ${MAX_RESENDS} 次`)
    expect(message).not.toContain('秒未收到')
    expect(message).not.toContain('\n')
  })

  /*
   * ── 中断于思考阶段 ──
   *
   * 原始失败形状取自 2026-08-22 的一次实测：11/11 的断流
   * 样本正文 0 字、tool_calls 0 片段，全部中断于 reasoning 中途。不完整的思考内容不进入模型
   * 视图，因此该情形同样属于「模型可见输出为零」，应当重发。
   */
  test('中断于思考阶段：同样重发，第二次成功时视为无事发生', async () => {
    const { rec, events } = await collect(scriptedAdapter(['break-after-thinking', 'ok']))

    expect(rec.opened).toEqual([0, 1])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('失败那次的思考 step 置为失败终态，否则会被投影回传给 provider', async () => {
    const { rec, events } = await collect(scriptedAdapter(['break-after-thinking', 'ok']))

    expect(rec.thinking).toHaveLength(1)
    expect(rec.failed).toEqual(rec.thinking)
    const retrying = events.find((e) => e.type === 'run.retrying')
    expect(retrying?.type).toBe('run.retrying')
    expect(
      retrying?.type === 'run.retrying' ? retrying.failedThinkingStepIds.map(String) : [],
    ).toEqual(rec.thinking)
  })

  test('重发后的新思考另开一条 step，不拼接到失败的 step', async () => {
    // 两次都中断：第二次的思考必须写入一条新 step。`open` 不复位时
    // `stepFor` 会命中旧 id，两段无关的生成内容被 `appendText` 拼接为一条。
    const { rec } = await collect(
      scriptedAdapter(['break-after-thinking', 'break-after-thinking', 'ok']),
    )

    expect(rec.thinking).toHaveLength(2)
    expect(rec.thinking[0]).not.toBe(rec.thinking[1])
    // 两次都中断，两条 step 都属于被丢弃的生成，均须置为失败终态。
    expect(rec.failed).toEqual(rec.thinking)
  })

  /**
   * 正文已显示后断开：正文是模型已输出的内容，作为上一条消息带入上下文再次请求，使模型继续执行。
   * 第二次请求中必须包含该段正文与继续执行的提示；这是新的一轮，不是同一轮的第二次尝试。
   */
  test('正文已显示后断开：携带正文续发，第二次成功时视为无事发生', async () => {
    const adapter = scriptedAdapter(['break-after-text', 'ok'])
    const { rec, events } = await collect(adapter)

    expect(rec.opened).toEqual([0, 0])
    expect(rec.diagnostics[0]?.retry.decision).toBe('resend')
    expect(events.filter((e) => e.type === 'run.retrying')).toHaveLength(1)
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const second = adapter.requests[1] ?? []
    expect(second.some((m) => m.role === 'assistant' && m.content === '我先看看')).toBe(true)
    const last = second[second.length - 1]
    expect(last?.role).toBe('user')
    expect(last?.content).toBe('上一条回复在此处中断，其后内容未送达。')
  })

  test('正文已显示后连续断开：续发次数与原样重发共用额度，用尽后才进入终态', async () => {
    const adapter = scriptedAdapter(Array(MAX_RESENDS + 1).fill('break-after-text'))
    const { events } = await collect(adapter)

    expect(adapter.requests).toHaveLength(MAX_RESENDS + 1)
    // 每次续发都携带上一段正文：最后一次请求中包含之前全部 MAX_RESENDS 段。
    const final = adapter.requests[MAX_RESENDS] ?? []
    expect(final.filter((m) => m.role === 'assistant' && m.content === '我先看看')).toHaveLength(
      MAX_RESENDS,
    )
    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).toBe(`连接被断开，已重发 ${MAX_RESENDS} 次`)
  })

  test('重发后仍立即断开：只报告重发次数，不伪造超时读数', async () => {
    const { events } = await collect(scriptedAdapter(Array(MAX_RESENDS + 1).fill('break')))

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    // ECONNRESET 是立即断开，不是计时器超时，不得附加「N 秒未收到响应」。
    expect(message).toContain('连接被断开')
    expect(message).not.toMatch(/秒未收到/)
    expect(message).toContain(`已重发 ${MAX_RESENDS} 次`)
  })

  /**
   * 连接超时与断连同等处理：等待 `PROVIDER_HTTP.timeout` 后响应头仍未返回，中止连接已是超时层
   * 的决定，不重发则必然失败。
   */
  test('连接超时原样重发，第二次成功时视为无事发生', async () => {
    const { rec, events } = await collect(scriptedAdapter(['connect-timeout', 'ok']))

    expect(rec.opened).toEqual([0, 1])
    expect(rec.diagnostics[0]?.retry.decision).toBe('resend')
    expect(events.filter((e) => e.type === 'run.retrying')).toHaveLength(1)
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
  })

  test('连接超时直至额度用尽：终态包含读数与重发次数，读数只出现一次', async () => {
    const { events } = await collect(
      scriptedAdapter(Array.from({ length: MAX_RESENDS + 1 }, () => 'connect-timeout' as const)),
    )

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).toContain('连接超时')
    expect(message.match(/未收到响应/g)).toHaveLength(1)
    expect(message).toContain(`已重发 ${MAX_RESENDS} 次`)
  })

  /*
   * 原始失败形状：`ox-alpha-free` 连续中断 4 次、第 5 次成功。只重发一次无法恢复的正是
   * 这种连续中断：锁定的是「第 5 次仍会重发」，而不是「发生过重发」。
   */
  test(`连续中断 ${MAX_RESENDS} 次：额度用满之前持续重发，最后一次成功时视为无事发生`, async () => {
    const { rec, events } = await collect(
      scriptedAdapter([...Array(MAX_RESENDS).fill('break'), 'ok']),
    )

    // 账本中每次发送单独一行：实际发送了 MAX_RESENDS + 1 次。
    expect(rec.opened).toEqual([...Array(MAX_RESENDS + 1).keys()])
    expect(events.find((e) => e.type === 'run.error')).toBeUndefined()
    const finished = events.find((e) => e.type === 'run.finished')
    expect(finished?.type === 'run.finished' && finished.stopReason).toBe('completed')
  })

  test('额度用满后不再重发：第 MAX_RESENDS + 1 次断流直接报错', async () => {
    const { rec } = await collect(scriptedAdapter(Array(MAX_RESENDS + 2).fill('break')))

    expect(rec.opened).toHaveLength(MAX_RESENDS + 1)
  })

  // 额度对重发集合中的每个码一视同仁，上游答复的不可用同样使用这一额度。
  test('上游连续报告不可用：同样重发直至额度用满', async () => {
    const { rec } = await collect(scriptedAdapter(Array(MAX_RESENDS + 2).fill('reject')))

    expect(rec.opened).toHaveLength(MAX_RESENDS + 1)
  })

  test('每次重发报告一次进度：界面据此显示「正在重连 N / M」', async () => {
    const { events } = await collect(scriptedAdapter(['break', 'break', 'ok']))

    const retrying = events.filter((e) => e.type === 'run.retrying')
    expect(retrying.map((e) => (e.type === 'run.retrying' ? e.attempt : 0))).toEqual([1, 2])
    // 上限由事件传给界面，前端不自行固定该数值。
    expect(retrying.every((e) => e.type === 'run.retrying' && e.max === MAX_RESENDS)).toBe(true)
  })

  test('已输出正文后立即断流：同样不伪造为超时', async () => {
    const { events } = await collect(scriptedAdapter(['break-after-text']))

    const err = events.find((e) => e.type === 'run.error')
    const message = err?.type === 'run.error' ? err.message : ''
    expect(message).not.toMatch(/秒未收到/)
  })
})
/**
 * 停止必须能使一轮从**停滞的工具**中返回。
 *
 * abort 只设置一个信号，等待方不检查该信号就等于没有停止。本组锁定：即使工具永不返回，
 * 点击停止后这一轮也在毫秒级进入终态，且终态为 `user_interrupt` 而不是红色的
 * `internal_error`。缺少该保证时，用户点击停止后没有任何响应，只能重启应用。
 */
