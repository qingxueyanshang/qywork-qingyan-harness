/** 覆盖 `pulled.ts`：拉取结果刷新已添加型号、按对应型号确定类别、添加选定型号，以及两项摘要文字。 */
import { expect, test } from 'bun:test'
import type { ChannelImageSpec, ChannelVideoSpec } from '@qywork/core'
import type { MediaLibraryModel, PullResult, RedactedConfig } from '../../lib/store/index.ts'
import {
  addPulled,
  type ClassifiedModel,
  durationSummary,
  priceSummary,
  referenceSummary,
  refreshPulled,
  withBase,
  withCategory,
} from './pulled.ts'

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
const IMAGE: ChannelImageSpec = {
  channel: 'mumugofe',
  resolutions: ['1K', '2K'],
  sizes: ['1024x1024'],
  maxImages: 10,
  price: { per: 'request', amount: { '1K': 0.36, '2K': 0.52 }, currency: 'CNY' },
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

const MODELS: ClassifiedModel[] = [
  { id: 'claude-sonnet-5-5', output: 'chat', known: true, price: PRICE },
  { id: 'deepseek-v4.1-flash', output: 'chat', known: false },
  { id: 'X-SD25-301010', output: 'video', kind: 'openai_videos', known: true, spec: SPEC },
  { id: 'seedance-2.5-deal', output: 'video', kind: 'openai_videos', known: true, spec: SPEC },
  { id: 'gpt-image-2', output: 'image', kind: 'openai_images', known: true, spec: IMAGE },
]
const RESULT = { source: 'pricing' as const, models: MODELS } satisfies PullResult

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

test('添加：对话型号写价格与对应型号，生成型号写规格并补默认；已添加的跳过', () => {
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
    'gpt-image-2': { kind: 'openai_images', spec: IMAGE },
  })
  expect(next.mediaDefaults).toEqual({
    video: { provider: 'mumu', model: 'seedance-2.5-deal' },
    image: { provider: 'mumu', model: 'gpt-image-2' },
  })
  // 接口已有对话型号，默认模型不变。
  expect(next.active).toEqual({ provider: 'other', model: 'x' })
  expect(addPulled(next, 'mumu', picks)).toBeNull()
})

const LIBRARY: MediaLibraryModel[] = [
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 Sunburst',
    vendor: 'OpenAI',
    kind: 'openai_images',
    kinds: ['openai_images'],
    output: 'image',
    operations: ['generate', 'edit'],
    maxImages: 16,
    maxVideos: 0,
    params: [],
  },
]

test('对应型号决定类别：对话型号改为生成目录的类别，类别改变时不保留原类别的价格', () => {
  const relay = 'https://ai.apii.cn/'
  const chat = RESULT.models[1]!
  expect(withBase(chat, 'gpt-image-2.5-sunburst', LIBRARY, relay)).toEqual({
    id: 'deepseek-v4.1-flash',
    output: 'image',
    kind: 'openai_images',
    known: false,
  })
  expect(withBase(RESULT.models[0]!, 'gpt-image-2.5-sunburst', LIBRARY, relay)).not.toHaveProperty(
    'price',
  )
  expect(withBase(chat, 'deepseek-flash', LIBRARY, relay)).toBe(chat)
  const alias = {
    id: 'gpt-image-2.5-sunburst-4k',
    output: 'image' as const,
    kind: 'openai_images' as const,
    known: false,
    base: 'gpt-image-2.5-sunburst',
  }
  expect(withBase(alias, 'gpt-image-2.5-sunburst', LIBRARY, relay)).toBe(alias)
  expect(withBase(chat, undefined, LIBRARY, relay)).toBe(chat)
})

test('添加：生成型号的对应型号写入 spec.base', () => {
  const model = {
    id: 'gpt-image-2.5-sunburst-4k',
    output: 'image' as const,
    kind: 'openai_images' as const,
    known: false,
  }
  const next = addPulled(base(), 'mumu', [{ model, base: 'gpt-image-2.5-sunburst' }])!
  expect(next.providers.mumu!.media!['gpt-image-2.5-sunburst-4k']).toEqual({
    kind: 'openai_images',
    spec: { base: 'gpt-image-2.5-sunburst' },
  })
  expect(next.catalog).toBeUndefined()
})

test('接口原本没有对话型号时，第一个添加的成为默认模型', () => {
  const cfg = base()
  cfg.providers.mumu!.models = {}
  const next = addPulled(cfg, 'mumu', [{ model: RESULT.models[0]! }])!
  expect(next.active).toEqual({ provider: 'mumu', model: 'claude-sonnet-5-5' })
  expect(next.providers.mumu!.models['claude-sonnet-5-5']).toEqual({ price: PRICE })
})

test('未知型号按选定的类别归类，协议按接口地址取默认值；未选定时不变', () => {
  const unknown = { id: 'mimo-v2.5-asr', output: 'unknown' as const }
  const mimo = 'https://api.xiaomimimo.com/v1'
  expect(withCategory(unknown, undefined, mimo)).toBe(unknown)
  expect(withCategory(unknown, 'chat', mimo)).toEqual({
    id: 'mimo-v2.5-asr',
    output: 'chat',
    known: false,
  })
  expect(withCategory(unknown, 'audio', mimo)).toEqual({
    id: 'mimo-v2.5-asr',
    output: 'audio',
    kind: 'mimo_speech',
    known: false,
  })
  expect(withCategory(unknown, 'image', 'https://relay.example/v1')).toMatchObject({
    kind: 'openai_images',
  })
  const chat = MODELS[0]!
  expect(withCategory(chat, 'image', mimo)).toBe(chat)
})

test('摘要：时长与素材上限、价格', () => {
  expect([durationSummary(RESULT.models[2]!), referenceSummary(RESULT.models[2]!)]).toEqual([
    '30秒',
    '图≤30',
  ])
  const full = {
    id: 'v',
    output: 'video' as const,
    kind: 'openai_videos' as const,
    known: true,
    spec: { ...SPEC, seconds: [5, 30], maxVideos: 10, maxAudios: 10 },
  }
  expect([durationSummary(full), referenceSummary(full)]).toEqual([
    '5–30秒',
    '图≤30、视频≤10、音频≤10',
  ])
  expect(durationSummary(RESULT.models[0]!)).toBe('')
  expect(priceSummary(RESULT.models[2]!)).toBe('¥7.00/次')
  expect(priceSummary(RESULT.models[0]!)).toBe('输入 ¥1.80 · 输出 ¥9.00 /百万')
  expect(priceSummary(RESULT.models[1]!)).toBe('')
  const discounted = {
    id: 'deepseek-v4.1-flash',
    output: 'chat' as const,
    known: false,
    price: {
      ...PRICE,
      offPeak: { rate: 0.5, peakWindowsUtc: [[1, 4]] as [number, number][], peakWeekdaysUtc: [1] },
    },
  }
  expect(priceSummary(discounted)).toBe('输入 ¥1.80 · 输出 ¥9.00 /百万 · 空闲时段 5 折')
  const tiered = {
    ...full,
    spec: {
      ...full.spec,
      price: {
        per: 'second' as const,
        amount: { '480p': 0.4, '720p': 0.6 },
        currency: 'CNY' as const,
      },
    },
  }
  expect(priceSummary(tiered)).toBe('480p ¥0.40 · 720p ¥0.60 /秒')
  // 图像规格没有时长，参考素材只有图，价格按张。
  const image = RESULT.models[4]!
  expect([durationSummary(image), referenceSummary(image), priceSummary(image)]).toEqual([
    '',
    '图≤10',
    '1K ¥0.36 · 2K ¥0.52 /张',
  ])
})
