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
let seen: (string | undefined)[] = []
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { reasoning_effort?: string }
      const effort = body.reasoning_effort
      seen.push(effort)
      if (html)
        return new Response('<html>relay home</html>', { headers: { 'content-type': 'text/html' } })
      const status =
        effort && effort === transient
          ? 503
          : effort && !accepted.has(effort) && !ignoreAll
            ? 400
            : 200
      if (status !== 200)
        return new Response(
          JSON.stringify({
            error: { message: status === 400 ? 'unsupported effort' : 'upstream unavailable' },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  accepted = new Set(levels)
  ignoreAll = false
  transient = undefined
  html = false
  seen = []
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
    expect(toTransportCapabilities(r)).toEqual({})
  })
  test('端点连非法值也接受时报告不确定，不把五档写成已验证', async () => {
    ignoreAll = true
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.effortLevels).toEqual(levels)
    expect(r.inconclusive).toEqual(['effort'])
    expect(r.probes.at(-1)?.detail).toContain('非法档位')
    expect(toTransportCapabilities(r)).toEqual({})
  })
  test('某一档临时失败也继续其余档，但不覆盖已保存的结果', async () => {
    transient = 'medium'
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(seen.slice(1, 6)).toEqual(levels)
    expect(r.effortLevels).toEqual(['low', 'high', 'xhigh', 'max'])
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r)).toEqual({})
  })
  test('非法值对照临时失败也不能形成结论', async () => {
    transient = '__qy_probe_invalid_effort__'
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.inconclusive).toEqual(['effort'])
    expect(toTransportCapabilities(r)).toEqual({})
  })
  test('HTML 响应不是连接成功', async () => {
    html = true
    const r = await probeModel(profile(), { gapMs: 0 })
    expect(r.reachable).toBe(false)
    expect(seen).toEqual([undefined])
  })
})
