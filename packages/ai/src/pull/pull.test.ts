/**
 * 覆盖 `index.ts`（拉取型号）：本地服务按计费清单与型号列表应答，核对分类、价格，没有计费清单时退回型号列表、
 * 按条目自带的类别与接口类型归类，名称按前缀对应模型库与生成目录的型号，官方接口按目录补齐自有协议的生成型号，
 * 以及登记的渠道（`registerPullChannel`）给出规格或完成整个拉取。站点与条目为合成数据。
 */

import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { identifyMediaModel } from '@qywork/core'
import { PullError, pullModels, registerPullChannel } from './index.ts'

const servers: ReturnType<typeof Bun.serve>[] = []
afterAll(async () => {
  for (const s of servers) await s.stop(true)
})

const restores: (() => void)[] = []
afterEach(() => {
  for (const restore of restores.splice(0)) restore()
})

/**
 * 公开接口按地址的来源（origin）请求，因此每个站点一个本地服务。
 * 给出 `host` 时接口地址使用该主机名，对它的请求转到本地服务：渠道按接口地址的主机名识别。
 */
function site(routes: Record<string, unknown>, host?: string) {
  const seen: { path: string; auth: string | null }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      seen.push({ path, auth: req.headers.get('authorization') })
      return path in routes
        ? Response.json(routes[path])
        : new Response('not found', { status: 404 })
    },
  })
  servers.push(server)
  const local = `http://127.0.0.1:${server.port}`
  if (host) {
    const original = globalThis.fetch
    const spy = spyOn(globalThis, 'fetch').mockImplementation(((url, init) => {
      const u = new URL(String(url))
      return original(u.host === host ? `${local}${u.pathname}${u.search}` : url, init)
    }) as typeof fetch)
    restores.push(() => spy.mockRestore())
  }
  return {
    seen,
    target: {
      kind: 'openai_chat_completions' as const,
      baseUrl: `${host ? `https://${host}` : local}/v1`,
      apiKey: 'sk-test',
    },
  }
}

const signal = () => new AbortController().signal

/** 计费清单中的一条：默认分组、按倍率计费。 */
const priced = (model_name: string, types: string[], fields: Record<string, unknown> = {}) => ({
  model_name,
  quota_type: 0,
  model_ratio: 1.5,
  enable_groups: ['default'],
  supported_endpoint_types: types,
  ...fields,
})

test('计费清单区分对话、图像与视频，对话价格按站点充值价折算，不携带凭证', async () => {
  const { target, seen } = site({
    '/api/pricing': {
      data: [
        priced('claude-sonnet-5-5', ['openai']),
        priced('video-a', ['openai-video'], { quota_type: 1, model_price: 1 }),
        priced('gpt-image-2', ['openai', 'image-generation'], { quota_type: 1, model_price: 0.01 }),
        priced('embedding-a', ['embeddings']),
      ],
      group_ratio: { default: 1 },
    },
    '/api/status': { data: { price: 7.3 } },
  })
  const result = await pullModels(target, signal())
  expect(result.source).toBe('pricing')
  expect(result.models).toEqual([
    {
      id: 'claude-sonnet-5-5',
      output: 'chat',
      known: true,
      price: { input: 21.9, output: 21.9, cacheRead: 21.9, cacheWrite: 21.9, currency: 'CNY' },
    },
    { id: 'video-a', output: 'video', kind: 'openai_videos', known: false },
    { id: 'gpt-image-2', output: 'image', kind: 'openai_images', known: true },
  ])
  expect(seen.every((s) => s.auth === null)).toBe(true)
})

test('型号不支持接口的协议时带上它支持的协议；同时支持接口协议的型号不带', async () => {
  const { target } = site({
    '/api/pricing': {
      data: [
        priced('claude-sonnet-5-5', ['anthropic']),
        priced('gpt-5', ['openai-response']),
        priced('both', ['openai', 'anthropic']),
      ],
      group_ratio: { default: 1 },
    },
    '/api/status': { data: {} },
  })
  const by = new Map((await pullModels(target, signal())).models.map((m) => [m.id, m]))
  expect(by.get('claude-sonnet-5-5')).toMatchObject({ kind: 'anthropic_messages', known: true })
  expect(by.get('gpt-5')).toMatchObject({ kind: 'openai_responses' })
  expect(by.get('both')).not.toHaveProperty('kind')
})

test('站点状态读取失败时价格不明，型号照常列出', async () => {
  const { target } = site({
    '/api/pricing': {
      data: [priced('claude-sonnet-5-5', ['openai'])],
      group_ratio: { default: 1 },
    },
  })
  const result = await pullModels(target, signal())
  expect(result.models.find((m) => m.id === 'claude-sonnet-5-5')).toEqual({
    id: 'claude-sonnet-5-5',
    output: 'chat',
    known: true,
  })
})

test('登记的渠道按目录给出生成型号的规格：只在接口地址属于该渠道时读取目录', async () => {
  registerPullChannel({
    matches: (baseUrl) => new URL(baseUrl).host === 'catalog.example.com',
    async specs(ctx) {
      const body = (await ctx.getJson(`${ctx.origin}/catalog.json`, {})) as {
        models: { id: string; seconds: number[] }[]
      }
      const listed = new Map(body.models.map((m) => [m.id, m]))
      return (entry, output) => {
        const hit = listed.get(entry.model_name)
        return output === 'video' && hit ? { channel: 'example', seconds: hit.seconds } : undefined
      }
    },
  })
  const routes = {
    '/api/pricing': {
      data: [priced('video-a', ['openai-video']), priced('video-b', ['openai-video'])],
      group_ratio: { default: 1 },
    },
    '/api/status': { data: {} },
    '/catalog.json': { models: [{ id: 'video-a', seconds: [5, 10] }] },
  }
  const channel = site(routes, 'catalog.example.com')
  const by = new Map((await pullModels(channel.target, signal())).models.map((m) => [m.id, m]))
  expect(by.get('video-a') as object).toEqual({
    id: 'video-a',
    output: 'video',
    kind: 'openai_videos',
    known: true,
    spec: { channel: 'example', seconds: [5, 10] },
  })
  expect(by.get('video-b')).toEqual({
    id: 'video-b',
    output: 'video',
    kind: 'openai_videos',
    known: false,
  })
  // 其他地址返回同名目录也不读取，型号不带规格。
  const other = site(routes)
  const plain = await pullModels(other.target, signal())
  expect(plain.models.find((m) => m.id === 'video-a')).not.toHaveProperty('spec')
  expect(other.seen.map((s) => s.path).sort()).toEqual(['/api/pricing', '/api/status'])
})

test('登记的渠道可完成整个拉取：条目经通用的对话与生成条目构造，带凭证请求', async () => {
  registerPullChannel({
    matches: (baseUrl) => new URL(baseUrl).host === 'own.example.com',
    async pull(ctx) {
      await ctx.getJson(`${ctx.origin}/own/models`, ctx.auth)
      return {
        source: 'pricing',
        models: [
          ctx.chat('gpt-5.6-sol', ['openai']),
          ctx.media('video-a', 'video', 'openai_videos', { channel: 'example' }),
        ],
      }
    },
  })
  const { target, seen } = site({ '/own/models': {} }, 'own.example.com')
  const result = await pullModels({ ...target, kind: 'openai_responses' }, signal())
  expect(result).toEqual({
    source: 'pricing',
    models: [
      { id: 'gpt-5.6-sol', output: 'chat', kind: 'openai_chat_completions', known: true },
      {
        id: 'video-a',
        output: 'video',
        kind: 'openai_videos',
        known: true,
        spec: { channel: 'example' },
      },
    ],
  })
  expect(seen).toEqual([{ path: '/own/models', auth: 'Bearer sk-test' }])
})

test('没有计费清单时退回型号列表，带凭证请求，按生成目录归类', async () => {
  const { target, seen } = site({
    '/v1/models': { data: [{ id: 'gpt-5.6-sol' }, { id: 'veo-3.1-generate-preview' }] },
  })
  const result = await pullModels(target, signal())
  expect(result).toEqual({
    source: 'models',
    models: [
      { id: 'gpt-5.6-sol', output: 'chat', known: true },
      { id: 'veo-3.1-generate-preview', output: 'video', kind: 'openai_videos', known: true },
    ],
  })
  expect(seen.find((s) => s.path === '/v1/models')?.auth).toBe('Bearer sk-test')
})

// 第三方接口按目录协议添加为百炼图像时，原生路径 /api/v1/services/aigc/multimodal-generation/generation 返回 404。
test('第三方接口上与目录 id 相同、登记了兼容映射的厂商型号使用通用协议，官方地址与未填地址仍用厂商协议', async () => {
  const { target } = site({
    '/v1/models': { data: [{ id: 'qwen-image-3.0-pro' }, { id: 'wan2.7-image' }] },
  })
  const relay = await pullModels(target, signal())
  expect(relay.models).toHaveLength(2)
  for (const m of relay.models) expect(m).toMatchObject({ output: 'image', kind: 'openai_images' })
  const library = [
    {
      id: 'qwen-image-3.0-pro',
      kind: 'dashscope_images' as const,
      kinds: ['dashscope_images', 'openai_images'] as const,
    },
  ]
  expect(
    identifyMediaModel('qwen-image-3.0-pro', library, 'https://dashscope.aliyuncs.com/api/v1'),
  ).toEqual({ output: 'image', kind: 'dashscope_images' })
  expect(identifyMediaModel('qwen-image-3.0-pro', library, undefined)).toEqual({
    output: 'image',
    kind: 'dashscope_images',
  })
})

// 第三方接口的 /v1/models 只有名称，没有计费清单。
test('型号列表中带后缀的生成型号按目录 id 识别，协议按接口地址取默认值', async () => {
  const ids = [
    'gpt-image-2',
    'gpt-image-2.0-4k',
    'gemini-3-pro-image-preview',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-sunburst-4k',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-flare-4k',
  ]
  const { target } = site({
    '/v1/models': {
      data: [...ids, 'gpt-image-2x'].map((id) => ({
        id,
        object: 'model',
        owned_by: 'gpt-image2-api',
      })),
    },
  })
  const result = await pullModels(target, signal())
  const by = new Map(result.models.map((m) => [m.id, m]))
  for (const id of ids) expect(by.get(id)).toMatchObject({ output: 'image', kind: 'openai_images' })
  expect(by.get('gpt-image-2')).toMatchObject({ known: true })
  expect(by.get('gpt-image-2')).not.toHaveProperty('base')
  expect(by.get('gpt-image-2.0-4k')).toMatchObject({ known: false, base: 'gpt-image-2' })
  // 取最长的目录前缀；Gemini 名称经第三方接口时不使用目录中的 Gemini 原生协议。
  expect(by.get('gpt-image-2.5-sunburst-4k')).toMatchObject({ base: 'gpt-image-2.5-sunburst' })
  expect(by.get('gemini-3-pro-image-preview')).toMatchObject({ base: 'gemini-3-pro-image' })
  // 目录 id 之后不是分隔符时不识别，名称也不在模型库中，归为未知。
  expect(by.get('gpt-image-2x')).toEqual({ id: 'gpt-image-2x', output: 'unknown' })
})

// 第三方接口的 Gemini 名称带思考档位后缀（如 `gemini-4-argon-high`），型号列表只有名称。
test('型号列表中以模型库 id 为前缀的对话型号归入对话，对应型号为该 id；前缀之后不是分隔符时仍为未知', async () => {
  const { target } = site({
    '/v1/models': {
      data: [
        { id: 'gemini-4-argon' },
        { id: 'gemini-4-argon-high' },
        { id: 'gemini-3.1-pro-preview-low' },
        { id: 'gemini-4-argonx' },
      ],
    },
  })
  const by = new Map((await pullModels(target, signal())).models.map((m) => [m.id, m]))
  expect(by.get('gemini-4-argon')).toEqual({ id: 'gemini-4-argon', output: 'chat', known: true })
  expect(by.get('gemini-4-argon-high')).toEqual({
    id: 'gemini-4-argon-high',
    output: 'chat',
    known: false,
    base: 'gemini-4-argon',
  })
  expect(by.get('gemini-3.1-pro-preview-low')).toMatchObject({
    output: 'chat',
    base: 'gemini-3.1-pro-preview',
  })
  expect(by.get('gemini-4-argonx')).toEqual({ id: 'gemini-4-argonx', output: 'unknown' })
})

test('计费清单中以模型库 id 为前缀的对话型号带对应型号', async () => {
  const { target } = site({
    '/api/pricing': {
      data: [
        {
          model_name: 'claude-opus-4-7-thinking',
          quota_type: 0,
          model_ratio: 1,
          enable_groups: ['default'],
          supported_endpoint_types: ['openai'],
        },
      ],
      group_ratio: { default: 1 },
    },
    '/api/status': { data: {} },
  })
  const [model] = (await pullModels(target, signal())).models
  expect(model).toMatchObject({ output: 'chat', known: false, base: 'claude-opus-4-7' })
})

// New API 站点的计费清单需要登录（返回 401），型号列表的条目带 `supported_endpoint_types`。
test('型号列表的条目带接口类型时按类型归类：生成类型优先，名称先于对话类型，只带不可用类型的不列出', async () => {
  const typed = (id: string, types: string[]) => ({
    id,
    object: 'model',
    owned_by: 'custom',
    supported_endpoint_types: types,
  })
  const { target } = site({
    '/v1/models': {
      data: [
        typed('kimi-k2.5', ['openai']),
        typed('vendor-reasoner-1', ['openai-response']),
        typed('kling-image-4.0', ['image-generation']),
        typed('kling-v1', ['openai-video', 'openai']),
        typed('kling-v1-5', ['video']),
        typed('qwen-image-3.0-pro', ['openai']),
        typed('vendor-tts-1', ['custom-tts', 'openai']),
        typed('text-embedding-a', ['embeddings']),
        typed('rerank-a', ['rerank']),
        typed('voice-live-1', ['realtime']),
      ],
    },
  })
  const result = await pullModels(target, signal())
  expect(result.source).toBe('models')
  const by = new Map(result.models.map((m) => [m.id, m]))
  expect(by.get('kimi-k2.5')).toEqual({ id: 'kimi-k2.5', output: 'chat', known: false })
  expect(by.get('vendor-reasoner-1')).toEqual({
    id: 'vendor-reasoner-1',
    output: 'chat',
    kind: 'openai_responses',
    known: false,
  })
  expect(by.get('kling-image-4.0')).toEqual({
    id: 'kling-image-4.0',
    output: 'image',
    kind: 'openai_images',
    known: false,
  })
  for (const id of ['kling-v1', 'kling-v1-5'])
    expect(by.get(id)).toMatchObject({ output: 'video', kind: 'openai_videos' })
  // 同时标为 `openai` 的生成型号按名称归类。
  expect(by.get('qwen-image-3.0-pro')).toMatchObject({ output: 'image', known: true })
  // 带有未登记类型时，`openai` 不能说明它是对话型号。
  expect(by.get('vendor-tts-1')).toEqual({ id: 'vendor-tts-1', output: 'unknown' })
  for (const id of ['text-embedding-a', 'rerank-a', 'voice-live-1']) expect(by.has(id)).toBe(false)
})

test('计费清单与型号列表使用同一分类：标为 openai 的生成型号按名称归类，未登记类型的型号列为未知', async () => {
  const { target } = site({
    '/api/pricing': {
      data: [
        priced('qwen-image-3.0-pro', ['openai'], { quota_type: 1, model_price: 0.2 }),
        priced('vendor-tts-1', ['custom-tts']),
        priced('rerank-a', ['rerank']),
      ],
      group_ratio: { default: 1 },
    },
    '/api/status': { data: {} },
  })
  const result = await pullModels(target, signal())
  expect(result.models).toEqual([
    { id: 'qwen-image-3.0-pro', output: 'image', kind: 'openai_images', known: true },
    { id: 'vendor-tts-1', output: 'unknown' },
  ])
})

// 2026-10-27 api.minimax.cn 的 /v1/models 原样（节选）：只列出对话型号，没有计费清单。
test('官方接口的型号列表不含自有协议的生成型号时，按目录补齐', async () => {
  const original = globalThis.fetch
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
    const path = new URL(String(url)).pathname
    if (new URL(String(url)).host !== 'api.minimax.cn') return original(url, init)
    if (path !== '/v1/models') return new Response('not found', { status: 404 })
    return Response.json({
      object: 'list',
      data: ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7'].map((id) => ({
        id,
        object: 'model',
        owned_by: 'minimax',
      })),
    })
  }) as typeof fetch)
  try {
    const result = await pullModels(
      { kind: 'openai_chat_completions', baseUrl: 'https://api.minimax.cn/v1/', apiKey: 'sk' },
      signal(),
    )
    expect(result.source).toBe('models')
    const by = new Map(result.models.map((m) => [m.id, m]))
    expect(by.get('MiniMax-M3.1-Flash')).toEqual({
      id: 'MiniMax-M3.1-Flash',
      output: 'chat',
      known: true,
    })
    expect(by.get('speech-2.8-hd')).toEqual({
      id: 'speech-2.8-hd',
      output: 'audio',
      kind: 'minimax_speech',
      known: true,
    })
    expect(by.get('image-01')).toMatchObject({ output: 'image', kind: 'minimax_images' })
    expect(by.get('MiniMax-H3')).toMatchObject({ output: 'video', kind: 'minimax_videos' })
    // 模型库未收录的名称归为未知，不默认归入对话。
    expect(by.get('MiniMax-M2.7')).toEqual({ id: 'MiniMax-M2.7', output: 'unknown' })
    // 其他厂商自有协议的目录条目不补入。
    expect(
      result.models.some(
        (m) => m.output !== 'chat' && m.output !== 'unknown' && !m.kind.startsWith('minimax_'),
      ),
    ).toBe(false)
  } finally {
    spy.mockRestore()
  }
})

// 2026-10-27 方舟 /api/v3/models 的条目（节选，省略 features 等无关字段）。
test('条目带类别时按类别归类：向量、3D 与已下线型号不列出，目录中没有的生成型号使用接口地址的默认协议', async () => {
  const entry = (
    id: string,
    domain: string,
    out: string[] | undefined,
    status?: string,
  ): Record<string, unknown> => ({
    id,
    object: 'model',
    domain,
    ...(out ? { modalities: { output_modalities: out } } : {}),
    ...(status ? { status } : {}),
  })
  const original = globalThis.fetch
  const spy = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
    const u = new URL(String(url))
    if (u.host !== 'ark.cn-beijing.volces.com') return original(url, init)
    if (u.pathname !== '/api/v3/models') return new Response('not found', { status: 404 })
    return Response.json({
      object: 'list',
      data: [
        entry('doubao-seed-2-1-pro-260915', 'VLM', ['text']),
        entry('qwen3-8b-20250429', '', undefined),
        entry('doubao-pro-32k-240828', 'LLM', ['text'], 'Shutdown'),
        entry('doubao-seedream-5-0-flash-260915', 'ImageGeneration', undefined),
        entry('doubao-seedream-4-5-251128', 'ImageGeneration', ['image'], 'Retiring'),
        entry('doubao-seedance-1-0-pro-250528', 'VideoGeneration', ['video'], 'Retiring'),
        entry('wan2-1-14b-t2v-250225', '', ['video'], 'Shutdown'),
        entry('doubao-embedding-text-240715', 'Embedding', undefined, 'Retiring'),
        entry('doubao-seed3d-2-0-260328', '3DGeneration', ['three_d']),
      ],
    })
  }) as typeof fetch)
  try {
    const result = await pullModels(
      {
        kind: 'openai_chat_completions',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/',
        apiKey: 'sk',
      },
      signal(),
    )
    const by = new Map(result.models.map((m) => [m.id, m]))
    expect(by.get('doubao-seed-2-1-pro-260915')).toMatchObject({ output: 'chat' })
    // 条目没有类别、名称也未收录时归为未知。
    expect(by.get('qwen3-8b-20250429')).toEqual({ id: 'qwen3-8b-20250429', output: 'unknown' })
    expect(by.get('doubao-seedream-5-0-flash-260915')).toEqual({
      id: 'doubao-seedream-5-0-flash-260915',
      output: 'image',
      kind: 'openai_images',
      known: true,
    })
    expect(by.get('doubao-seedream-4-5-251128')).toEqual({
      id: 'doubao-seedream-4-5-251128',
      output: 'image',
      kind: 'openai_images',
      known: false,
    })
    expect(by.get('doubao-seedance-1-0-pro-250528')).toEqual({
      id: 'doubao-seedance-1-0-pro-250528',
      output: 'video',
      kind: 'ark_videos',
      known: false,
    })
    for (const id of [
      'doubao-pro-32k-240828',
      'wan2-1-14b-t2v-250225',
      'doubao-embedding-text-240715',
      'doubao-seed3d-2-0-260328',
    ])
      expect(by.has(id)).toBe(false)
  } finally {
    spy.mockRestore()
  }
})

test('两种来源都无法读取时报告失败的地址', async () => {
  const { target } = site({})
  await expect(pullModels(target, signal())).rejects.toThrow(PullError)
  await expect(pullModels(target, signal())).rejects.toThrow('/v1/models 返回 HTTP 404')
})
