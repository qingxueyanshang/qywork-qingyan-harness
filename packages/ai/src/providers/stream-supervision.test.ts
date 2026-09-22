/**
 * 覆盖范围：`../transport.ts` 的响应体监督经三个适配器
 * （`openai-responses.ts`、`openai-compat.ts`、`anthropic.ts`）到达真实 HTTP 之后的行为，
 * 故障形态由 `fault-server.test-helper.ts` 提供。
 *
 * 三条断言各对应一种「响应头已到、之后怎么办」：非 2xx 的正文不结束要在诊断上限内
 * 报出状态码与 Retry-After；2xx 的正文不来要按空闲上限报断流；保活行在上限内到达
 * 不能被误杀。
 */

import { expect, test } from 'bun:test'
import { ProviderError } from '../errors.ts'
import { buildAdapter } from '../factory.ts'
import type { ProviderEvent, ProviderProfile } from '../types.ts'
import { type FaultMode, type FaultServer, startFaultServer } from './fault-server.test-helper.ts'

const PROTOCOLS = [
  { kind: 'openai_responses', model: 'deepseek-flash' },
  { kind: 'openai_chat_completions', model: 'deepseek-chat' },
  { kind: 'anthropic_messages', model: 'claude-opus-5' },
] as const satisfies readonly { kind: ProviderProfile['kind']; model: string }[]

function baseUrlOf(fault: FaultServer, kind: ProviderProfile['kind']): string {
  return kind === 'anthropic_messages' ? fault.anthropicBaseUrl : fault.openaiBaseUrl
}

/** 跑完一条流，把事件和终态一起交出来——「断之前收到了什么」和错误本身要一起看。 */
async function drain(
  fault: FaultServer,
  kind: ProviderProfile['kind'],
  model: string,
  idleTimeoutMs: number,
): Promise<{ events: ProviderEvent[]; err: unknown; elapsedMs: number }> {
  const adapter = buildAdapter({ kind, apiKey: 'sk-fault', baseUrl: baseUrlOf(fault, kind), model })
  const events: ProviderEvent[] = []
  const started = Date.now()
  try {
    for await (const ev of adapter.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      maxOutputTokens: 64,
      idleTimeoutMs,
    })) {
      events.push(ev)
    }
    return { events, err: null, elapsedMs: Date.now() - started }
  } catch (err) {
    return { events, err, elapsedMs: Date.now() - started }
  }
}

async function withFault<T>(mode: FaultMode, fn: (fault: FaultServer) => Promise<T>): Promise<T> {
  const fault = startFaultServer(mode)
  try {
    return await fn(fault)
  } finally {
    fault.stop()
  }
}

for (const { kind, model } of PROTOCOLS) {
  test(`${kind} 503 错误正文永不结束：在诊断上限内报出状态码与 Retry-After`, async () => {
    const result = await withFault('hung_error_body', async (fault) => {
      fault.retryAfterSeconds = 60
      return await drain(fault, kind, model, 60_000)
    })
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('provider_unavailable')
    expect(pe.status).toBe(503)
    expect(pe.retryAfterMs).toBe(60_000)
    expect(pe.transport?.status).toBe(503)
    expect(result.elapsedMs).toBeLessThan(10_000)
  }, 20_000)

  test(`${kind} 响应头之后不再发字节：按空闲上限报断流`, async () => {
    const result = await withFault('headers_then_silence', (fault) =>
      drain(fault, kind, model, 500),
    )
    expect(result.err).toBeInstanceOf(ProviderError)
    const pe = result.err as ProviderError
    expect(pe.code).toBe('stream_idle_timeout')
    expect(pe.timedOut).toBe(true)
    expect(pe.transport?.status).toBe(200)
    expect(result.elapsedMs).toBeLessThan(5_000)
  }, 20_000)

  test(`${kind} 保活行间隔短于空闲上限：不被误杀，正常完成并带用量`, async () => {
    const result = await withFault('keepalive_then_ok', (fault) => drain(fault, kind, model, 300))
    expect(result.err).toBeNull()
    const usage = result.events.find((ev) => ev.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.inputTokens).toBe(11)
    expect(result.events.some((ev) => ev.type === 'done')).toBe(true)
    // 保活总时长超过空闲上限，否则这条用例验的只是「跑得够快」。
    expect(result.elapsedMs).toBeGreaterThan(300)
  }, 20_000)
}
