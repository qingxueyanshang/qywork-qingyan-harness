/** 覆盖五档实际请求、未知模型、非法值对照、部分失败与重测。 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { EffortLevel } from '@qywork/core'
import { buildAdapter } from './factory.ts'
import { probeModel, toTransportCapabilities } from './probe.ts'
import type { ProviderProfile } from './types.ts'

const levels: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
let accepted = new Set<string>(levels)
let ignoreAll = false
let transient: string | undefined
let html = false
let explicitThinking = false
let rejectStandard = false
let observation: 'text' | 'usage' | 'control' | 'none' = 'text'
let unrelatedRejection: string | undefined
let seen: (string | undefined)[] = []
let bodies: Record<string, unknown>[] = []
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        reasoning_effort?: string
        thinking?: { type: string }
        tools?: unknown[]
      }
      bodies.push(body)
      const effort = body.reasoning_effort
      if (!body.tools?.length) seen.push(effort)
      if (html)
        return new Response('<html>relay home</html>', { headers: { 'content-type': 'text/html' } })
      const enabled = !explicitThinking || body.thinking?.type === 'enabled'
      const status =
        effort && effort === transient
          ? 503
          : effort &&
              ((rejectStandard && !body.thinking) ||
                effort === unrelatedRejection ||
                (enabled && !accepted.has(effort) && !ignoreAll))
            ? 400
            : 200
      if (status !== 200)
        return new Response(
          JSON.stringify({
            error: {
              message:
                status === 400
                  ? effort === unrelatedRejection
                    ? 'max_tokens must be greater than 4096 when reasoning_effort is high'
                    : 'unsupported effort'
                  : 'upstream unavailable',
            },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      const thought =
        enabled &&
        effort &&
        (observation === 'control' ? !accepted.has(effort) : accepted.has(effort))
      const data = {
        choices: [
          {
            delta: {
              content: 'ok',
              ...(thought && (observation === 'text' || observation === 'control')
                ? { reasoning_content: '计算余数' }
                : {}),
            },
            finish_reason: 'stop',
          },
        ],
        ...(thought && observation === 'usage'
          ? {
              usage: {
                prompt_tokens: 1,
                completion_tokens: 20,
                completion_tokens_details: { reasoning_tokens: 16 },
              },
            }
          : {}),
      }
      return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  accepted = new Set(levels)
  ignoreAll = false
  transient = undefined
  html = false
  explicitThinking = false
  rejectStandard = false
  observation = 'text'
  unrelatedRejection = undefined
  seen = []
  bodies = []
})
const profile = (model = 'custom'): ProviderProfile => ({
  kind: 'openai_chat_completions',
  apiKey: 'sk-x',
  model,
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
})

describe('五档逐一检测', () => {
  test('MiMo 即使旧检测接受多档，也只做连接检测且不增加虚假强度', async () => {
    const r = await probeModel(
      { ...profile('mimo-v2.6-pro'), transport: { effort: true, effortLevels: levels } },
      { gapMs: 0 },
    )
    expect(seen).toEqual([undefined])
    expect(r.effortSource).toBe('catalog')
    expect(r.effortLevels).toEqual([])
    expect(toTransportCapabilities(r).effort).toBe(false)
  })
  test('未收录模型也真正发送五档和非法对照，并能在后续请求使用', async () => {
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(seen.slice(0, 6)).toEqual([undefined, ...levels])
    expect(seen[6]).not.toBeUndefined()
    expect(seen[6]).toBe('__qy_probe_invalid_effort__')
    expect(r.effortLevels).toEqual(levels)
    expect(r.effortSource).toBe('probe')
    expect(r.inconclusive).toEqual([])
    const transport = toTransportCapabilities(r)
    expect(buildAdapter({ ...profile(), transport }).spec.effortLevels).toEqual(levels)
    expect(buildAdapter({ ...profile(), transport }).transmits.effort).toBe(true)
  })
  test('逐档保留通过值，不因一档通过而采纳整份名单', async () => {
    accepted = new Set(['low', 'high', 'max'])
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(seen.slice(1, 6)).toEqual(levels)
    expect(r.effortLevels).toEqual(['low', 'high', 'max'])
    expect(toTransportCapabilities(r).effortLevels).toEqual(['low', 'high', 'max'])
  })
  test('DeepSeek 接受五个值但声明三档，只校验三档并纠正旧结果', async () => {
    const base = { ...profile('deepseek-flash'), transport: { effort: true, effortLevels: levels } }
    expect(buildAdapter(base).spec.effortLevels).toEqual(['low', 'high', 'max'])
    const r = await probeModel(base, { gapMs: 0 })
    expect(seen).toEqual([undefined, 'low', 'high', 'max', '__qy_probe_invalid_effort__'])
    expect(r.effortSource).toBe('catalog')
    expect(r.effortLevels).toEqual(['low', 'high', 'max'])
    expect(
      buildAdapter({ ...base, transport: toTransportCapabilities(r) }).spec.effortLevels,
    ).toEqual(['low', 'high', 'max'])
  })
  test('内置明确没有档位时仅检测连接，不凭请求成功添加档位', async () => {
    const r = await probeModel(
      { ...profile('claude-haiku-4-5'), spec: { effortLevels: [] }, transport: { effort: false } },
      { gapMs: 0 },
    )
    expect(seen).toEqual([undefined])
    expect(r.effortSource).toBe('catalog')
    expect(r.effortLevels).toEqual([])
    expect(toTransportCapabilities(r).effort).toBe(false)
  })
  test('旧检测为 false 不阻止重测，但仍以模型库候选档位为准', async () => {
    const r = await probeModel(
      { ...profile('deepseek-flash'), transport: { effort: false } },
      { gapMs: 0 },
    )
    expect(r.effortLevels).toEqual(['low', 'high', 'max'])
    expect(toTransportCapabilities(r).effort).toBe(true)
  })
  test('模型库档位被当前端点拒绝时只收窄，不添加库外档位', async () => {
    accepted = new Set(['low', 'max', 'medium', 'xhigh'])
    const r = await probeModel(profile('deepseek-flash'), { gapMs: 0 })
    expect(r.effortLevels).toEqual(['low', 'max'])
    expect(
      buildAdapter({ ...profile('deepseek-flash'), transport: toTransportCapabilities(r) }).spec
        .effortLevels,
    ).toEqual(['low', 'max'])
  })
  test('五档都被拒时保存空列表', async () => {
    accepted.clear()
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.effortLevels).toEqual([])
    expect(toTransportCapabilities(r)).toMatchObject({ effort: false, effortLevels: [] })
  })
  test('模型库声明的格式与当前协议不匹配时不伪报检测通过', async () => {
    const r = await probeModel(profile('claude-opus-5'), { gapMs: 0 })
    expect(seen).toEqual([undefined])
    expect(r.untested).toEqual(['effort'])
    expect(toTransportCapabilities(r).effort).toBeUndefined()
  })
  test('端点连非法值也接受时报告不确定，不把五档写成已验证', async () => {
    ignoreAll = true
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.effortLevels).toEqual(levels)
    expect(r.inconclusive).toEqual(['effort'])
    expect(r.probes.find((p) => p.name.endsWith('非法值对照'))?.detail).toContain('非法档位')
    expect(toTransportCapabilities(r).effort).toBeUndefined()
  })
  test('某一档临时失败也继续其余档，但不覆盖已保存的结果', async () => {
    transient = 'medium'
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(seen.slice(1, 6)).toEqual(levels)
    expect(r.effortLevels).toEqual(['low', 'high', 'xhigh', 'max'])
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r).effort).toBeUndefined()
  })
  test('非法值对照临时失败也不能形成结论', async () => {
    transient = '__qy_probe_invalid_effort__'
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r).effort).toBeUndefined()
  })
  test('HTML 响应不是连接成功', async () => {
    html = true
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.reachable).toBe(false)
    expect(seen).toEqual([undefined])
  })

  test('汇总带档位请求的思考，探针预算足以容纳思考与回答', async () => {
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.thinkingObserved).toBe(true)
    expect(bodies[0]?.max_tokens).toBe(2048)
    expect(bodies[0]?.messages).not.toEqual([{ role: 'user', content: 'hi' }])
    expect(bodies[1]?.max_tokens).toBe(2048)
    expect(toTransportCapabilities(r)).not.toHaveProperty('thinksByDefault')
  })

  test('只有服务端 reasoning_tokens，没有公开文本，也识别为观察到思考', async () => {
    observation = 'usage'
    expect((await probeModel(profile(), { gapMs: 0 })).thinkingObserved).toBe(true)
  })

  test('非法值请求的思考不作为正常配置的证据', async () => {
    observation = 'control'
    ignoreAll = true
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.thinkingObserved).toBe(false)
    expect(toTransportCapabilities(r).effort).toBeUndefined()
  })

  test('未知 Chat 模型识别显式思考格式，保存后真实请求使用同一格式', async () => {
    explicitThinking = true
    accepted = new Set(['low', 'high'])
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.thinking).toBe('deepseek_thinking')
    expect(r.thinkingObserved).toBe(true)
    expect(r.inconclusive).toEqual([])
    expect(r.effortLevels).toEqual(['low', 'high'])
    expect(r.probes.some((p) => p.name.startsWith('reasoning_effort /') && p.inconclusive)).toBe(
      true,
    )
    const adapter = buildAdapter({ ...profile(), transport: toTransportCapabilities(r) })
    for await (const _ of adapter.stream({
      model: 'custom',
      system: [],
      messages: [{ role: 'user', content: '实际对话' }],
      tools: [],
      effort: 'high',
      maxOutputTokens: 2048,
      idleTimeoutMs: 1000,
    })) {
    }
    expect(bodies.at(-1)).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' })
  })

  test('已有手动格式不被自动探测替换', async () => {
    explicitThinking = true
    const r = await probeModel(
      { ...profile(), spec: { thinking: 'reasoning_effort' } },
      { gapMs: 0 },
    )
    expect(bodies.every((body) => body.thinking === undefined)).toBe(true)
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r).thinking).toBeUndefined()
  })

  test('通用请求错误不误删原有档位', async () => {
    unrelatedRejection = 'high'
    const r = await probeModel(profile('deepseek-flash'), { gapMs: 0 })
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r).effortLevels).toBeUndefined()
  })

  test('临时错误不会切换另一种思考格式', async () => {
    transient = 'high'
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.inconclusive).toEqual(['effort'])
    expect(bodies.every((body) => body.thinking === undefined)).toBe(true)
  })

  test('未观察到思考不会阻止已通过参数校验的配置保存', async () => {
    observation = 'none'
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.thinkingObserved).toBe(false)
    expect(toTransportCapabilities(r)).toMatchObject({
      effort: true,
      thinking: 'reasoning_effort',
      effortLevels: levels,
    })
  })

  test('一个格式拒绝而另一格式未确认，不把未知模型写成无档位', async () => {
    rejectStandard = true
    ignoreAll = true
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r).effort).toBeUndefined()
  })
})

test.each([false, true])(
  '未知 Messages 模型识别格式并保留隐藏思考证据，恒开=%s',
  async (alwaysOn) => {
    const requests: Record<string, unknown>[] = []
    const endpoint = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          thinking?: { type: string }
          output_config?: { effort: string }
        }
        requests.push(body)
        const effort = body.output_config?.effort
        const error =
          alwaysOn && body.thinking
            ? 'thinking is not supported'
            : effort && !['low', 'high'].includes(effort)
              ? 'unsupported effort'
              : undefined
        if (error) return Response.json({ error: { message: error } }, { status: 400 })
        const events = [
          { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: 'opaque' },
          },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '192' } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 12 },
          },
          { type: 'message_stop' },
        ]
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    try {
      const target: ProviderProfile = {
        kind: 'anthropic_messages',
        model: 'unknown-messages',
        apiKey: 'test',
        baseUrl: `http://127.0.0.1:${endpoint.port}`,
      }
      const r = await probeModel(target, { gapMs: 0 })
      expect(r.thinkingObserved).toBe(true)
      expect(r.effortLevels).toEqual(['low', 'high'])
      expect(r.inconclusive).toEqual([])
      expect(r.thinking).toBe(alwaysOn ? 'none' : 'adaptive_only')
      const events = []
      for await (const event of buildAdapter({
        ...target,
        transport: toTransportCapabilities(r),
      }).stream({
        model: target.model,
        system: [],
        messages: [{ role: 'user', content: '实际请求' }],
        tools: [],
        effort: 'high',
        maxOutputTokens: 2048,
        idleTimeoutMs: 1000,
      }))
        events.push(event)
      expect(requests.at(-1)?.output_config).toEqual({ effort: 'high' })
      expect(requests.at(-1)?.thinking).toEqual(
        alwaysOn ? undefined : { type: 'adaptive', display: 'summarized' },
      )
      expect(events.some((event) => event.type === 'thinking_delta')).toBe(false)
      expect(events.at(-1)).toMatchObject({ type: 'done', thinkingObserved: true })
      expect(events.find((event) => event.type === 'usage')).toMatchObject({
        usage: { reasoningTokens: 0 },
      })
    } finally {
      endpoint.stop(true)
    }
  },
)
