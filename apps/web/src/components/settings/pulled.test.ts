/** 覆盖 `pulled.ts`：拉取结果刷新已添加型号、添加选定型号，以及两项摘要文字。 */
import { expect, test } from 'bun:test'
import type { ChannelVideoSpec } from '@qywork/core'
import type { PullResult, RedactedConfig } from '../../lib/store/index.ts'
import { addPulled, priceSummary, refreshPulled, specSummary } from './pulled.ts'

const SPEC: ChannelVideoSpec = {
  channel: 'mumugofe',
  seconds: [30],
  ratios: ['16:9', '9:16'],
  resolutions: ['720p'],
  sizes: { '720p': [1280, 720] },
  maxImages: 30,
  maxVideos: 0,
  maxAudios: 0,
  publicUrls: true,
  price: { per: 'request', amount: 7, currency: 'CNY' },
}
const PRICE = { input: 1.8, output: 9, cacheRead: 0.18, cacheWrite: 2.25, currency: 'CNY' as const }

const base = (): RedactedConfig => ({
  active: { provider: 'other', model: 'x' },
  providers: {
    mumu: {
      kind: 'openai_chat_completions',
      baseUrl: 'https://api.mumugofe.com/v1',
      hasApiKey: true,
      models: {
        'claude-sonnet-5-5': { effort: 'high' },
        'old-chat': { price: PRICE },
      },
      media: {
        'X-SD25-301010': { kind: 'openai_videos' },
        'old-video': { kind: 'openai_videos', spec: SPEC },
      },
    },
    other: { kind: 'openai_chat_completions', hasApiKey: true, models: { x: {} } },
  },
})

const RESULT: PullResult = {
  source: 'pricing',
  models: [
    { id: 'claude-sonnet-5-5', output: 'chat', known: true, price: PRICE },
    { id: 'deepseek-v4.1-flash', output: 'chat', known: false },
    { id: 'X-SD25-301010', output: 'video', kind: 'openai_videos', spec: SPEC },
    { id: 'seedance-2.5-deal', output: 'video', kind: 'openai_videos', spec: SPEC },
    {
      id: 'sd-2.0-vip',
      output: 'video',
      kind: 'openai_videos',
      unsupported: '该型号按表单上传素材，当前未接入',
    },
    { id: 'gpt-image-2', output: 'image', kind: 'openai_images' },
  ],
}

test('刷新：更新价格与规格，计费清单中没有的型号标记已下架，其他设置保留', () => {
  const next = refreshPulled(base(), 'mumu', RESULT)!
  const mumu = next.providers.mumu!
  expect(mumu.models).toEqual({
    'claude-sonnet-5-5': { effort: 'high', price: PRICE },
    'old-chat': { price: PRICE, delisted: true },
  })
  expect(mumu.media).toEqual({
    'X-SD25-301010': { kind: 'openai_videos', spec: SPEC },
    'old-video': { kind: 'openai_videos', spec: SPEC, delisted: true },
  })
  expect(next.providers.other).toEqual(base().providers.other)
  // 再次拉取到已下架的型号时清除标记；结果相同时不写入。
  expect(refreshPulled(next, 'mumu', RESULT)).toBeNull()
  const back = refreshPulled(next, 'mumu', {
    ...RESULT,
    models: [...RESULT.models, { id: 'old-chat', output: 'chat', known: false }],
  })!
  expect(back.providers.mumu!.models['old-chat']).toEqual({})
})

test('型号列表不完整，不据此标记已下架', () => {
  const next = refreshPulled(base(), 'mumu', { source: 'models', models: [] })
  expect(next).toBeNull()
})

test('添加：对话型号写价格与对应型号，生成型号写规格并补默认；不支持与已添加的跳过', () => {
  const picks = RESULT.models.map((model) =>
    model.id === 'deepseek-v4.1-flash' ? { model, base: 'deepseek-flash' } : { model },
  )
  const next = addPulled(base(), 'mumu', picks)!
  const mumu = next.providers.mumu!
  expect(Object.keys(mumu.models)).toEqual(['claude-sonnet-5-5', 'old-chat', 'deepseek-v4.1-flash'])
  expect(mumu.models['claude-sonnet-5-5']).toEqual({ effort: 'high' })
  expect(mumu.models['deepseek-v4.1-flash']).toEqual({})
  expect(next.catalog).toEqual({
    'deepseek-v4.1-flash|openai_chat_completions': { base: 'deepseek-flash' },
  })
  expect(mumu.media).toMatchObject({
    'seedance-2.5-deal': { kind: 'openai_videos', spec: SPEC },
    'gpt-image-2': { kind: 'openai_images' },
  })
  expect(mumu.media).not.toHaveProperty('sd-2.0-vip')
  expect(next.mediaDefaults).toEqual({
    video: { provider: 'mumu', model: 'seedance-2.5-deal' },
    image: { provider: 'mumu', model: 'gpt-image-2' },
  })
  // 接口已有对话型号，默认模型不变。
  expect(next.active).toEqual({ provider: 'other', model: 'x' })
  expect(addPulled(next, 'mumu', picks)).toBeNull()
})

test('接口原本没有对话型号时，第一个添加的成为默认模型', () => {
  const cfg = base()
  cfg.providers.mumu!.models = {}
  const next = addPulled(cfg, 'mumu', [{ model: RESULT.models[0]! }])!
  expect(next.active).toEqual({ provider: 'mumu', model: 'claude-sonnet-5-5' })
  expect(next.providers.mumu!.models['claude-sonnet-5-5']).toEqual({ price: PRICE })
})

test('摘要：时长与素材上限、价格', () => {
  expect(specSummary(RESULT.models[2]!)).toBe('30秒 · 图≤30')
  expect(
    specSummary({
      id: 'v',
      output: 'video',
      kind: 'openai_videos',
      spec: { ...SPEC, seconds: [5, 30], maxVideos: 10, maxAudios: 10 },
    }),
  ).toBe('5–30秒 · 图≤30、视频≤10、音频≤10')
  expect(priceSummary(RESULT.models[2]!)).toBe('¥7.00/次')
  expect(priceSummary(RESULT.models[0]!)).toBe('输入 ¥1.80 · 输出 ¥9.00 /百万')
  expect(priceSummary(RESULT.models[1]!)).toBe('')
})
