/** 覆盖 `pulled.ts`：拉取结果刷新已添加型号、按对应型号确定类别、添加选定型号，以及价格摘要。 */
import { expect, test } from 'bun:test'
import type { MediaLibraryModel, PullResult, RedactedConfig } from '../../lib/store/index.ts'
import {
  addPulled,
  type ClassifiedModel,
  priceSummary,
  refreshPulled,
  withBase,
  withCategory,
} from './pulled.ts'

const PRICE = { input: 1.8, output: 9, cacheRead: 0.18, cacheWrite: 2.25, currency: 'CNY' as const }

const base = (): RedactedConfig => ({
  active: { provider: 'other', model: 'x' },
  providers: {
    relay: {
      kind: 'openai_chat_completions',
      baseUrl: 'https://relay.example.com/v1',
      hasApiKey: true,
      models: {
        'claude-sonnet-5-5': { effort: 'high' },
        'old-chat': { price: PRICE },
      },
      media: {
        'video-a': { kind: 'openai_videos', delisted: true },
        'old-video': { kind: 'openai_videos' },
      },
    },
    other: { kind: 'openai_chat_completions', hasApiKey: true, models: { x: {} } },
  },
})

const MODELS: ClassifiedModel[] = [
  { id: 'claude-sonnet-5-5', output: 'chat', known: true, price: PRICE },
  { id: 'deepseek-v4.1-flash', output: 'chat', known: false },
  { id: 'video-a', output: 'video', kind: 'openai_videos', known: false },
  { id: 'video-b', output: 'video', kind: 'openai_videos', known: false },
  { id: 'gpt-image-2', output: 'image', kind: 'openai_images', known: true },
]
const RESULT = { source: 'pricing' as const, models: MODELS } satisfies PullResult

test('刷新：更新价格，计费清单中没有的型号标记已下架，再次列出的清除标记，其他设置保留', () => {
  const next = refreshPulled(base(), 'relay', RESULT)!
  const relay = next.providers.relay!
  expect(relay.models).toEqual({
    'claude-sonnet-5-5': { effort: 'high', price: PRICE },
    'old-chat': { price: PRICE, delisted: true },
  })
  expect(relay.media).toEqual({
    'video-a': { kind: 'openai_videos' },
    'old-video': { kind: 'openai_videos', delisted: true },
  })
  expect(next.providers.other).toEqual(base().providers.other)
  // 再次拉取到已下架的型号时清除标记；结果相同时不写入。
  expect(refreshPulled(next, 'relay', RESULT)).toBeNull()
  const back = refreshPulled(next, 'relay', {
    ...RESULT,
    models: [...RESULT.models, { id: 'old-chat', output: 'chat', known: false }],
  })!
  expect(back.providers.relay!.models['old-chat']).toEqual({})
})

test('对话型号的协议：添加时写入，刷新时随拉取结果更新，拉取结果不带时删除', () => {
  const claude: ClassifiedModel = {
    id: 'claude-x',
    output: 'chat',
    kind: 'anthropic_messages',
    known: true,
  }
  const added = addPulled(base(), 'relay', [{ model: claude }])!
  expect(added.providers.relay?.models['claude-x']).toEqual({ kind: 'anthropic_messages' })
  const unchanged = refreshPulled(added, 'relay', {
    source: 'pricing',
    models: [...MODELS, claude],
  })!
  expect(unchanged.providers.relay?.models['claude-x']).toEqual({ kind: 'anthropic_messages' })
  const plain = refreshPulled(added, 'relay', {
    source: 'pricing',
    models: [...MODELS, { id: 'claude-x', output: 'chat', known: true }],
  })!
  expect(plain.providers.relay?.models['claude-x']).toEqual({})
})

test('型号列表不完整，不据此标记已下架', () => {
  const next = refreshPulled(base(), 'relay', { source: 'models', models: [] })
  expect(next).toBeNull()
})

test('添加：对话型号写入价格与对应型号，生成型号写入协议并补充默认模型；跳过已添加的型号', () => {
  const picks = RESULT.models.map((model) =>
    model.id === 'deepseek-v4.1-flash' ? { model, base: 'deepseek-flash' } : { model },
  )
  const next = addPulled(base(), 'relay', picks)!
  const relay = next.providers.relay!
  expect(Object.keys(relay.models)).toEqual([
    'claude-sonnet-5-5',
    'old-chat',
    'deepseek-v4.1-flash',
  ])
  expect(relay.models['claude-sonnet-5-5']).toEqual({ effort: 'high' })
  expect(relay.models['deepseek-v4.1-flash']).toEqual({})
  expect(next.catalog).toEqual({
    'deepseek-v4.1-flash|openai_chat_completions': { base: 'deepseek-flash' },
  })
  expect(relay.media).toMatchObject({
    'video-b': { kind: 'openai_videos' },
    'gpt-image-2': { kind: 'openai_images' },
  })
  expect(next.mediaDefaults).toEqual({
    video: { provider: 'relay', model: 'video-b' },
    image: { provider: 'relay', model: 'gpt-image-2' },
  })
  // 接口已有对话型号，默认模型不变。
  expect(next.active).toEqual({ provider: 'other', model: 'x' })
  expect(addPulled(next, 'relay', picks)).toBeNull()
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
  const url = 'https://relay.example.com/'
  const chat = RESULT.models[1]!
  expect(withBase(chat, 'gpt-image-2.5-sunburst', LIBRARY, url)).toEqual({
    id: 'deepseek-v4.1-flash',
    output: 'image',
    kind: 'openai_images',
    known: false,
  })
  expect(withBase(RESULT.models[0]!, 'gpt-image-2.5-sunburst', LIBRARY, url)).not.toHaveProperty(
    'price',
  )
  expect(withBase(chat, 'deepseek-flash', LIBRARY, url)).toBe(chat)
  const alias = {
    id: 'gpt-image-2.5-sunburst-4k',
    output: 'image' as const,
    kind: 'openai_images' as const,
    known: false,
    base: 'gpt-image-2.5-sunburst',
  }
  expect(withBase(alias, 'gpt-image-2.5-sunburst', LIBRARY, url)).toBe(alias)
  expect(withBase(chat, undefined, LIBRARY, url)).toBe(chat)
})

test('添加：生成型号的对应型号写入 spec.base', () => {
  const model = {
    id: 'gpt-image-2.5-sunburst-4k',
    output: 'image' as const,
    kind: 'openai_images' as const,
    known: false,
  }
  const next = addPulled(base(), 'relay', [{ model, base: 'gpt-image-2.5-sunburst' }])!
  expect(next.providers.relay!.media!['gpt-image-2.5-sunburst-4k']).toEqual({
    kind: 'openai_images',
    spec: { base: 'gpt-image-2.5-sunburst' },
  })
  expect(next.catalog).toBeUndefined()
})

test('接口原本没有对话型号时，第一个添加的成为默认模型', () => {
  const cfg = base()
  cfg.providers.relay!.models = {}
  const next = addPulled(cfg, 'relay', [{ model: RESULT.models[0]! }])!
  expect(next.active).toEqual({ provider: 'relay', model: 'claude-sonnet-5-5' })
  expect(next.providers.relay!.models['claude-sonnet-5-5']).toEqual({ price: PRICE })
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

test('价格摘要：对话为每百万 Token 的输入与输出，生成型号为空', () => {
  expect(priceSummary(RESULT.models[0]!)).toBe('输入 ¥1.80 · 输出 ¥9.00 /百万')
  expect(priceSummary(RESULT.models[1]!)).toBe('')
  expect(priceSummary(RESULT.models[2]!)).toBe('')
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
})
