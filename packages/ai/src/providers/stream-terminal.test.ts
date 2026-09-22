/**
 * 覆盖范围：三个适配器（`openai-responses.ts`、`openai-compat.ts`、`anthropic.ts`）
 * 对协议终态、流内错误事件与终态前 EOF 的处置，经真实 HTTP 与
 * `fault-server.test-helper.ts` 的故障端点。共用读取器是 `../sse.ts`。
 *
 * 与 `stream-supervision.test.ts` 的分界：那边问「响应体何时算结束」（字节空闲、
 * 诊断上限），这边问「协议说这一轮结束了没有」。
 */

import { expect, test } from 'bun:test'
import { ProviderError } from '../errors.ts'
import type { ProviderEvent } from '../types.ts'
import { drainAdapter, FAULT_PROTOCOLS, withFault } from './fault-server.test-helper.ts'

/** 轮询等待一个服务端侧事实成立。连接关闭要经过网络，不会在同一个微任务里可见。 */
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
   * E3 / T07：完整工具调用与协议终态都已发出，HTTP 永不 EOF。
   *
   * 等 EOF 的写法在这个形状下永远交付不出结果——中转发完终态不关连接是常见形状。
   */
  test(`${kind} 协议终态到达即交付工具调用与用量，随后释放连接`, async () => {
    const result = await withFault('tool_then_no_eof', async (fault) => {
      const drained = await drainAdapter({
        fault,
        kind,
        model,
        // 空闲上限远大于断言时限：交付必须由协议终态触发，不能是超时兜出来的。
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
    // 服务端侧的独立事实：body 被取消，这条连接不再占着名额。
    expect(result.released).toBe(true)
  }, 20_000)

  /** E4 / T03：200 之后的流内错误事件。 */
  test(`${kind} 流内 overloaded 事件落可重发码并保留原文`, async () => {
    const result = await withFault('inline_error', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 }),
    )
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('provider_unavailable')
    expect(pe.message).toContain('Upstream is overloaded')
    // 原文进账本那一格。分类词在 Responses 里是 `code`、另两条里是 `type`，
    // 这条断言不挑字段，逐字段的映射由 `../errors.test.ts` 锁。
    expect(pe.detail?.providerMessage).toBe('Upstream is overloaded, please retry')
    expect(pe.status).toBeUndefined()
  }, 20_000)

  test(`${kind} 流内 authentication_error 落 auth_failed，rate_limit_error 落 rate_limited`, async () => {
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

  /** T02：正常 FIN，没有协议终态。 */
  test(`${kind} 终态之前 EOF 报 network_error`, async () => {
    const result = await withFault('eof_before_terminal', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 30_000 }),
    )
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('network_error')
    // 没有 HTTP 状态码：是否送达、是否计费无从判断，账本行因此落 uncertain。
    expect(pe.status).toBeUndefined()
    expect(result.events.some((ev) => ev.type === 'done')).toBe(false)
  }, 20_000)

  /** T08 后半：参数拼到一半撞上输出上限，不能把截断抹成一次工具调用。 */
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
 * T08 前半：`finish_reason` 之后还会再来一个只带用量的 chunk，`[DONE]` 才是终止标记。
 *
 * 只有 chat/completions 有这个形状，另两条协议的用量在终态事件里。
 */
test('openai_chat_completions finish_reason 之后的用量 chunk 不丢', async () => {
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
 * T02 的另一半：失败之前 provider 已经报过的用量必须随错误带上去。
 *
 * Responses 协议的用量只在终态事件里，这个形状下一个字节都没回报过——
 * 那时不带比带一个零更准确。
 */
test('终态前 EOF 时已回报的用量挂在错误上，没回报的不编零', async () => {
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
