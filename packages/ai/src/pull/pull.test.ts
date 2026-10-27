/**
 * 覆盖 `index.ts`（拉取型号）：本地服务按 2026-10-21 取得的木木与 2026-10-27 取得的 hongcheng 响应片段应答，
 * 核对分类、渠道规格、价格，没有计费清单时退回型号列表、按条目自带的类别归类，以及官方接口按目录补齐自有协议的生成型号。
 */

import { afterAll, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PullError, pullModels } from './index.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures', name), 'utf8')) as Record<
    string,
    unknown
  >

const servers: ReturnType<typeof Bun.serve>[] = []
afterAll(() => {
  for (const s of servers) s.stop(true)
})

/** 公开接口按地址的来源（origin）请求，因此每个站点一个本地服务。 */
function site(routes: Record<string, unknown>) {
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
  return {
    seen,
    target: {
      kind: 'openai_chat_completions' as const,
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: 'sk-test',
    },
  }
}

const signal = () => new AbortController().signal

test('木木：计费清单区分对话、图像与视频，视频带渠道规格与价格', async () => {
  const data = fixture('newapi-mumugofe.json')
  const { target, seen } = site({
    '/api/pricing': data.pricing,
    '/api/status': data.status,
    '/docs/typetale-models.json': data.typetale,
  })
  const result = await pullModels(target, signal())
  expect(result.source).toBe('pricing')
  const by = new Map(result.models.map((m) => [m.id, m]))
  expect(by.get('X-SD25-301010')).toEqual({
    id: 'X-SD25-301010',
    output: 'video',
    kind: 'openai_videos',
    known: true,
    spec: {
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
    },
  })
  // 按尺寸分档的型号按分辨率档位分别保存单价。
  expect(by.get('007系列/sd2.5(30图10音/480P/720P)')).toMatchObject({
    output: 'video',
    spec: {
      resolutions: ['480p', '720p'],
      price: { per: 'second', amount: { '480p': 0.4, '720p': 0.6 }, currency: 'CNY' },
    },
  })
  // 表单上传；计费清单按请求中的 resolution 计价，规格标记提交时发送该字段，两档分别定价。
  expect(by.get('sd-2.0-vip')).toMatchObject({
    output: 'video',
    spec: {
      multipart: true,
      resolutionField: true,
      price: { per: 'second', amount: { '720p': 0.676, '1080p': 1.56 }, currency: 'CNY' },
    },
  })
  // 渠道说明：每次生成 1 张，0.052 元。
  expect(by.get('gpt-image-2')).toMatchObject({
    output: 'image',
    kind: 'openai_images',
    spec: {
      channel: 'mumugofe',
      resolutions: ['1K', '2K', '4K'],
      maxImages: 10,
      price: { per: 'request', amount: 0.052, currency: 'CNY' },
    },
  })
  expect(by.get('claude-sonnet-5-5')).toMatchObject({
    output: 'chat',
    known: true,
    price: { input: 1.8, output: 9, currency: 'CNY' },
  })
  expect(by.get('deepseek-v4.1-flash')).toMatchObject({
    id: 'deepseek-v4.1-flash',
    output: 'chat',
    known: false,
    price: { input: 1.04, output: 4.16, offPeak: { rate: 0.5 } },
  })
  // 公开接口不携带凭证，型号列表带凭证。
  expect(seen.filter((s) => s.path !== '/v1/models').every((s) => s.auth === null)).toBe(true)
})

// 2026-10-27 hongcheng 的视频规格只在带凭证的型号列表中（条目的 `parameters`），工作台目录需要登录。
test('hongcheng：型号列表的 parameters 给出规格，价格按计费清单折算', async () => {
  const data = fixture('newapi-hongcheng.json')
  const { target, seen } = site({
    '/api/pricing': data.pricing,
    '/api/status': data.status,
    '/v1/models': data.models,
  })
  const by = new Map((await pullModels(target, signal())).models.map((m) => [m.id, m]))
  expect(by.get('TTseadanco2.5-720')).toMatchObject({
    output: 'video',
    known: true,
    spec: {
      channel: 'hongcheng',
      ratios: ['16:9', '9:16', '1:1'],
      maxVideos: 10,
      price: { per: 'second', amount: 0.42, currency: 'CNY' },
    },
  })
  expect(by.get('seedance2.5-yx-stable')).toMatchObject({
    spec: {
      seconds: expect.arrayContaining([4, 30]),
      price: { per: 'request', amount: 7.2, currency: 'CNY' },
    },
  })
  expect(by.get('sedanco2.0-300秒必出')).toMatchObject({
    spec: { seconds: [15], resolutions: ['480p'], maxVideos: 0, maxAudios: 3 },
  })
  // 型号列表的 `pricing` 写为按条，计费清单为按秒：以计费清单为准。
  expect(by.get('TTsedanco2.0-720')).toMatchObject({
    spec: { price: { per: 'second', amount: 0.3 } },
  })
  // 型号列表中没有 parameters 的型号不带规格。
  expect(by.get('bb2.5')).toEqual({
    id: 'bb2.5',
    output: 'video',
    kind: 'openai_videos',
    known: false,
  })
  expect(seen.find((s) => s.path === '/v1/models')?.auth).toBe('Bearer sk-test')
  expect(seen.filter((s) => s.path.startsWith('/api/')).every((s) => s.auth === null)).toBe(true)
})

test('站点状态读取失败时价格不明，型号照常列出', async () => {
  const data = fixture('newapi-mumugofe.json')
  const { target } = site({ '/api/pricing': data.pricing })
  const result = await pullModels(target, signal())
  expect(result.models.find((m) => m.id === 'claude-sonnet-5-5')).toEqual({
    id: 'claude-sonnet-5-5',
    output: 'chat',
    known: true,
  })
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
      { id: 'veo-3.1-generate-preview', output: 'video', kind: 'veo_videos', known: true },
    ],
  })
  expect(seen.find((s) => s.path === '/v1/models')?.auth).toBe('Bearer sk-test')
})

// 2026-10-22 ai.apii.cn 的 /v1/models 原样：只有名称，没有计费清单；其中 5 个曾被归为对话。
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
  // 取最长的目录前缀；Gemini 名称经中转时不使用目录中的 Gemini 原生协议。
  expect(by.get('gpt-image-2.5-sunburst-4k')).toMatchObject({ base: 'gpt-image-2.5-sunburst' })
  expect(by.get('gemini-3-pro-image-preview')).toMatchObject({ base: 'gemini-3-pro-image' })
  // 目录 id 之后不是分隔符时不识别，名称也不在模型库中，归为未知。
  expect(by.get('gpt-image-2x')).toEqual({ id: 'gpt-image-2x', output: 'unknown' })
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
