/**
 * 覆盖范围：三个适配器（`openai-responses.ts`、`openai-compat.ts`、`anthropic.ts`）
 * 对协议终态、流内错误事件与终态前 EOF 的处置，经真实 HTTP 与
 * `fault-server.test-helper.ts` 的故障端点。共用读取器是 `../sse.ts`。
 *
 * 与 `stream-supervision.test.ts` 的分界：该文件验证响应体何时结束（字节空闲、
 * 诊断上限），本文件验证协议是否已报告本轮结束。
 */

import { expect, test } from 'bun:test'
import { ProviderError } from '../errors.ts'
import type { ProviderEvent } from '../types.ts'
import { drainAdapter, FAULT_PROTOCOLS, withFault } from './fault-server.test-helper.ts'

/** 轮询等待服务端侧的条件成立。连接关闭须经过网络传递，在同一微任务中不可见。 */
async function waitFor(ok: () => boolean, limitMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    if (ok()) return true
    await Bun.sleep(10)
  }
  return ok()
}

function toolCallsOf(events: ProviderEvent[]) {
  return events.filter((ev) => ev.type === 'tool_calls')
}

for (const { kind, model } of FAULT_PROTOCOLS) {
  /**
   * 完整工具调用与协议终态均已发出，HTTP 始终不到达 EOF。
   *
   * 中转站发出终态后不关闭连接是常见情形，等待 EOF 的实现在此情形下无法交付结果。
   */
  test(`${kind} 协议终态到达即交付工具调用与用量，随后释放连接`, async () => {
    const result = await withFault('tool_then_no_eof', async (fault) => {
      const drained = await drainAdapter({
        fault,
        kind,
        model,
        // 空闲上限远大于断言时限：交付必须由协议终态触发，不能由超时触发。
        idleTimeoutMs: 30_000,
      })
      const released = await waitFor(() => fault.closedByClient > 0)
      return { ...drained, released }
    })
    expect(result.err).toBeNull()
    expect(result.elapsedMs).toBeLessThan(1_000)

    const calls = toolCallsOf(result.events)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.type === 'tool_calls' && calls[0].calls).toEqual([
      { id: expect.any(String), name: 'echo', arguments: { a: 1 } },
    ])

    const usage = result.events.find((ev) => ev.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.outputTokens).toBe(7)
    expect(result.events.some((ev) => ev.type === 'done')).toBe(true)
    // 从服务端侧独立确认：body 已被取消，该连接不再占用名额。
    expect(result.released).toBe(true)
  }, 20_000)

  /** 200 之后的流内错误事件。 */
  test(`${kind} 流内 overloaded 事件记为可重发错误码并保留原文`, async () => {
    const result = await withFault('inline_error', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 }),
    )
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('provider_unavailable')
    expect(pe.message).toContain('Upstream is overloaded')
    // 原文写入账本的对应字段。分类词在 Responses 中是 `code`，在另两种协议中是 `type`；
    // 本断言不区分字段，逐字段的映射由 `../errors.test.ts` 锁定。
    expect(pe.detail?.providerMessage).toBe('Upstream is overloaded, please retry')
    expect(pe.status).toBeUndefined()
  }, 20_000)

  test(`${kind} 流内 authentication_error 记为 auth_failed，rate_limit_error 记为 rate_limited`, async () => {
    const auth = await withFault('inline_error', (fault) => {
      fault.inlineError = { type: 'authentication_error', message: 'invalid x-api-key' }
      return drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 })
    })
    expect((auth.err as ProviderError).code).toBe('auth_failed')
    expect((auth.err as ProviderError).detail?.providerMessage).toBe('invalid x-api-key')

    const limited = await withFault('inline_error', (fault) => {
      fault.inlineError = { type: 'rate_limit_error', message: 'Number of requests has exceeded' }
      return drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 })
    })
    expect((limited.err as ProviderError).code).toBe('rate_limited')
    expect((limited.err as ProviderError).detail?.providerMessage).toBe(
      'Number of requests has exceeded',
    )
  }, 20_000)

  /** 正常 FIN，没有协议终态。 */
  test(`${kind} 终态之前 EOF 时报告 network_error`, async () => {
    const result = await withFault('eof_before_terminal', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 }),
    )
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('network_error')
    // 没有 HTTP 状态码：是否送达、是否计费无从判断，账本行因此记为 uncertain。
    expect(pe.status).toBeUndefined()
    expect(result.events.some((ev) => ev.type === 'done')).toBe(false)
  }, 20_000)

  /** 参数拼接中途触及输出上限，不得将截断记为一次工具调用。 */
  test(`${kind} 参数截断加输出上限终态：终态仍是 max_tokens，参数原文另存`, async () => {
    const result = await withFault('truncated_tool_call', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 }),
    )
    expect(result.err).toBeNull()
    const done = result.events.find((ev) => ev.type === 'done')
    expect(done?.type === 'done' && done.stopReason).toBe('max_tokens')
    const calls = toolCallsOf(result.events)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.type === 'tool_calls' && calls[0].calls[0]).toMatchObject({
      name: 'echo',
      arguments: {},
      argumentsError: '{"a":',
    })
  }, 20_000)
}

/**
 * `finish_reason` 之后还有一个只含用量的 chunk，终止标记是 `[DONE]`。
 *
 * 只有 chat/completions 有此形状，另两种协议的用量位于终态事件中。
 */
test('openai_chat_completions finish_reason 之后的用量 chunk 不丢失', async () => {
  const result = await withFault('complete', (fault) =>
    drainAdapter({
      fault,
      kind: 'openai_chat_completions',
      model: 'deepseek-chat',
      idleTimeoutMs: 30_000,
    }),
  )
  expect(result.err).toBeNull()
  const usage = result.events.find((ev) => ev.type === 'usage')
  expect(usage?.type === 'usage' && usage.usage.inputTokens).toBe(11)
  expect(usage?.type === 'usage' && usage.usage.outputTokens).toBe(3)
  expect(usage?.type === 'usage' && usage.usage.source).toBe('provider')
  const done = result.events.find((ev) => ev.type === 'done')
  expect(done?.type === 'done' && done.rawStopReason).toBe('stop')
}, 20_000)

/**
 * 终态之前 EOF 时，失败之前 provider 已回报的用量必须随错误一并传出。
 *
 * Responses 协议的用量只在终态事件中，此情形下未回报任何用量；
 * 此时不附带用量比附带零更准确。
 */
test('终态前 EOF 时已回报的用量附在错误上，未回报时不填零', async () => {
  const withUsage = ['openai_chat_completions', 'anthropic_messages']
  for (const { kind, model } of FAULT_PROTOCOLS) {
    const result = await withFault('eof_before_terminal', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 }),
    )
    const pe = result.err as ProviderError
    if (withUsage.includes(kind)) {
      expect(pe.usage?.inputTokens).toBe(11)
      expect(pe.usage?.source).toBe('provider')
    } else {
      expect(pe.usage).toBeUndefined()
    }
  }
}, 30_000)
