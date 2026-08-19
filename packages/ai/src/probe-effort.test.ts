/**
 * effort 校准：**档位表只从内置库取，探测只回答「这条链路接不接受」。**
 *
 * **覆盖范围**：`probe.ts` 的 effort 那一段。探针的其余部分（只写回真的探过的轴、
 * 报告怎么措辞）在 `probe.test.ts`。
 *
 * ## 要复现的形状
 *
 * OpenAI 兼容端点对 `reasoning_effort` 一律照收，不认识的值直接忽略。
 * 按「没被 400」逐档打满的话五档全过，探测器就往配置里写一个凭空的能力，
 * 界面照着画出厂商根本没有的档（grok-4.6 官方只有 low/medium/high/xhigh）。
 * 那是一个**端点行为**，纯函数测不出来，所以起一个照收不误的假端点。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { probeModel } from './probe.ts'
import type { ProviderProfile } from './types.ts'

/** 端点拒不拒这个 effort 值。默认全收——这正是要复现的行为。 */
let rejects: (effort: string | undefined) => boolean = () => false
/** true = 回一个 200 的网页，复现「Base URL 少了 /v1」那个形状。 */
let htmlInstead = false
/** 收到过的 effort 值，按顺序。用来验「试了几档」。 */
let seen: (string | undefined)[] = []

let server: ReturnType<typeof Bun.serve>
let base = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (htmlInstead) {
        return new Response('<!doctype html><html><body>relay home</body></html>', {
          headers: { 'content-type': 'text/html' },
        })
      }
      const body = (await req.json()) as { reasoning_effort?: string }
      seen.push(body.reasoning_effort)
      if (rejects(body.reasoning_effort)) {
        return new Response(JSON.stringify({ error: { message: 'unsupported effort' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      const sse =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
        'data: [DONE]\n\n'
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}/v1`
})

afterAll(() => server.stop(true))

const profile = (model = 'grok-4.6'): ProviderProfile => ({
  kind: 'openai_chat_completions',
  apiKey: 'sk-x',
  model,
  baseUrl: base,
})

describe('effort 校准', () => {
  /**
   * **端点全收，也只报库里那几档。**
   *
   * grok-4.6 官方是 low/medium/high/xhigh，没有 max。逐档打满的老写法在这里
   * 会写回五档，而那个 max 选了不会有任何反应。
   */
  test('档位以内置库为准，端点收下多的也不采信', async () => {
    seen = []
    rejects = () => false
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
    // 而且**没有**试过 max —— 库里没有的档根本不发。
    expect(seen).not.toContain('max')
  })

  /** 试通一档就够，不逐档打满：控制面成立之后档位表以库为准。 */
  test('通了一档就整份采纳，不再逐档试', async () => {
    seen = []
    rejects = () => false
    await probeModel(profile(), { gapMs: 0 })
    expect(seen.filter((e) => e !== undefined)).toEqual(['low'])
  })

  /** 两档都被拒 = 这条中转不接受这个控制面，报空并说清是谁拒的。 */
  test('链路拒了就报空，且说得出是链路拒的', async () => {
    seen = []
    rejects = (e) => e !== undefined
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.effortLevels).toEqual([])
    expect(r.probes.find((p) => p.name === 'effort 控制面')?.detail).toContain('本链路拒绝')
    // 只试前两档，不把库里的档全打一遍。
    expect(seen.filter((e) => e !== undefined)).toEqual(['low', 'medium'])
  })

  /** 库里没有 effort 的模型一个请求都不该发。 */
  test('库里没有档位就不发请求', async () => {
    seen = []
    rejects = () => false
    const r = await probeModel(profile('claude-haiku-4-5'), { gapMs: 0 })
    expect(r.effortLevels).toEqual([])
    expect(seen.filter((e) => e !== undefined)).toEqual([])
  })

  /**
   * 端点回了 200 但不是 SSE 流（Base URL 少了 `/v1` 时中转站会回一个网页）。
   *
   * 这条是那次真实故障的形状：`测连接` 显示通，而每一条真实请求都 0 token、
   * 0 步骤、`completed` —— 界面上是「发出去了什么也没发生」，账本里查不到原因。
   */
  test('端点回的不是流 —— 报不通，不是报通', async () => {
    htmlInstead = true
    const r = await probeModel(profile(), { gapMs: 0 })
    htmlInstead = false
    expect(r.reachable).toBe(false)
    expect(r.probes[0]?.detail).toContain('SSE')
  })
})
