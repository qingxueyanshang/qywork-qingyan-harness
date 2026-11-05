/**
 * 覆盖 `plaza.ts`（模型广场的价格折算），以及 `index.ts` 在没有计费清单时把广场价格附到型号列表中的对话型号。
 * 广场数据的形状取自 2026-11-04 读取的 zhende.ai `/api/v1/model-plaza`，价格为每 token 的美元基础价。
 */

import { afterAll, expect, test } from 'bun:test'
import { applySpecOverride, computeCost, lookupModel, type SpecOverride } from '../catalog.ts'
import { pullModels } from './index.ts'
import { plazaPrices } from './plaza.ts'

const M = 1e-6
const tier = (min: number, input: number, output: number, cacheRead: number, write: number) => ({
  min_tokens: min,
  max_tokens: null,
  input_price: input * M,
  output_price: output * M,
  cache_read_price: cacheRead * M,
  cache_write_price: write * M,
})
const model = (name: string, input: number, output: number, cacheRead: number, write: number) => ({
  name,
  pricing: {
    billing_mode: 'token',
    input_price: input * M,
    output_price: output * M,
    cache_read_price: cacheRead * M,
    cache_write_price: write * M,
    intervals: [] as ReturnType<typeof tier>[],
  },
})
const group = (rate: number, models: unknown[], extra: Record<string, unknown> = {}) => ({
  rate_multiplier: rate,
  peak_rate_enabled: false,
  long_context_pricing_enabled: true,
  models,
  ...extra,
})

const astra = model('gpt-6-astra', 10, 50, 1, 12.5)
astra.pricing.intervals = [tier(0, 10, 50, 1, 12.5), tier(272_000, 20, 75, 2, 25)]
// 站点仍按降价前的 $5 / $30 收费，与模型库的促销价不一致，分档也是站点自己的。
const sol = model('gpt-5.6-sol', 5, 30, 0.5, 6.25)
sol.pricing.intervals = [tier(0, 5, 30, 0.5, 6.25), tier(272_000, 10, 45, 1, 12.5)]

const PLAZA = {
  code: 0,
  data: {
    groups: [
      group(0.33, [astra, sol, model('both', 1, 2, 0, 0)]),
      group(0.33, [astra]),
      group(0.5, [model('both', 1, 2, 0, 0)]),
      group(0.25, [model('peak-only', 1, 2, 0, 0)], { peak_rate_enabled: true }),
      group(1, [{ name: 'per-call', pricing: { billing_mode: 'per_request', input_price: null } }]),
    ],
  },
}

test('基础价与分档都与模型库官方价一致时写倍率；站点自己的价格写单价并带站点的分档', () => {
  const prices = plazaPrices(PLAZA, 'openai_responses')
  expect(prices?.get('gpt-6-astra')).toEqual({ scale: 0.33, currency: 'USD' })
  const relay = prices?.get('gpt-5.6-sol') as SpecOverride
  expect(relay).toMatchObject({ input: 1.65, output: 9.9, cacheRead: 0.165, currency: 'USD' })
  // 30 万 token 的请求按站点的高档实扣：(300K × $10 + 1000 × $45) × 0.33。
  const spec = applySpecOverride(lookupModel('gpt-5.6-sol', 'openai_responses'), relay)
  const usage = { inputTokens: 300_000, outputTokens: 1000 }
  expect(computeCost(spec, usage)).toBeCloseTo((300_000 * 10 + 1000 * 45) * 1e-6 * 0.33, 9)
  expect(computeCost(spec, { inputTokens: 1000, outputTokens: 0 })).toBeCloseTo(0.00165, 9)
})

test('分组倍率不一致、分组开启高峰加价、不按 token 计费时价格不明；格式无法识别时返回 null', () => {
  const prices = plazaPrices(PLAZA, 'openai_responses')
  expect(prices?.has('both')).toBe(false)
  expect(prices?.has('peak-only')).toBe(false)
  expect(prices?.has('per-call')).toBe(false)
  expect(plazaPrices({ data: [] }, 'openai_responses')).toBeNull()
})

const servers: ReturnType<typeof Bun.serve>[] = []
afterAll(() => {
  for (const s of servers) s.stop(true)
})

test('没有计费清单时型号列表中的对话型号带广场价格；广场中没有的型号不带', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/v1/model-plaza') return Response.json(PLAZA)
      if (path === '/v1/models')
        return Response.json({ data: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-luna' }] })
      return new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  const result = await pullModels(
    {
      kind: 'openai_responses',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'sk-test',
    },
    new AbortController().signal,
  )
  expect(result.source).toBe('models')
  expect(result.models).toEqual([
    { id: 'gpt-6-astra', output: 'chat', known: true, price: { scale: 0.33, currency: 'USD' } },
    { id: 'gpt-6-luna', output: 'chat', known: true },
  ])
})
