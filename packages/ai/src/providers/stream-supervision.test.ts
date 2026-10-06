/**
 * 覆盖范围：`../transport.ts` 的响应体监督经三个适配器
 * （`openai-responses.ts`、`openai-compat.ts`、`anthropic.ts`）在真实 HTTP 连接上的行为；
 * 故障形态与三种协议的驱动由 `fault-server.test-helper.ts` 提供。
 *
 * 三条断言各对应响应头到达之后的一种情形：非 2xx 的正文不结束时，须在诊断上限内
 * 报告状态码与 Retry-After；2xx 的正文不再到达时，须按空闲上限报告断流；保活行在上限内到达时，
 * 不得被判定为断流。
 *
 * 协议终态与流内错误由 `stream-terminal.test.ts` 覆盖，两者判据不同。
 */

import { expect, test } from 'bun:test'
import { ProviderError } from '../errors.ts'
import { drainAdapter, FAULT_PROTOCOLS, withFault } from './fault-server.test-helper.ts'

for (const { kind, model } of FAULT_PROTOCOLS) {
  test(`${kind} 503 错误正文永不结束：在诊断上限内报告状态码与 Retry-After`, async () => {
    const result = await withFault('hung_error_body', async (fault) => {
      fault.retryAfterSeconds = 60
      return await drainAdapter({ fault, kind, model, idleTimeoutMs: 60_000 })
    })
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('provider_unavailable')
    expect(pe.status).toBe(503)
    expect(pe.retryAfterMs).toBe(60_000)
    expect(pe.transport?.status).toBe(503)
    // 非 2xx 时，响应头到达时刻只能经传输读数传出适配器，请求账的对应列取自该值。
    expect(pe.transport?.headersAt).not.toBeNull()
    expect(result.elapsedMs).toBeLessThan(10_000)
  }, 20_000)

  test(`${kind} 响应头之后不再发送字节：按空闲上限报告断流`, async () => {
    const result = await withFault('headers_then_silence', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 500 }),
    )
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('stream_idle_timeout')
    expect(pe.timedOut).toBe(true)
    expect(pe.transport?.status).toBe(200)
    expect(result.elapsedMs).toBeLessThan(5_000)
  }, 20_000)

  test(`${kind} 保活行间隔短于空闲上限：不中止，正常完成并附带用量`, async () => {
    const result = await withFault('keepalive_then_ok', (fault) =>
      drainAdapter({ fault, kind, model, idleTimeoutMs: 300 }),
    )
    expect(result.err).toBeNull()
    const usage = result.events.find((ev) => ev.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.inputTokens).toBe(11)
    expect(result.events.some((ev) => ev.type === 'done')).toBe(true)
    // 保活总时长须超过空闲上限，否则本用例只验证了执行时间短于上限。
    expect(result.elapsedMs).toBeGreaterThan(300)
  }, 20_000)
}
