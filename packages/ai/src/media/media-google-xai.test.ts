/** Google 与 xAI 生成接口的请求、任务恢复、错误终态及计价回归。 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { defaultMediaKind, MEDIA_KIND_OUTPUT, type MediaKind } from '@qywork/core'
import { findMediaModel, lookupMediaModel, mediaCatalog, mediaCost, quoteMedia } from './catalog.ts'
import { download } from './http.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import { MediaError, type MediaRequest } from './types.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const MP4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom')])
let server: ReturnType<typeof Bun.serve>
let requests: {
  path: string
  method: string
  key: string | null
  auth: string | null
  body?: Record<string, unknown>
}[] = []
let reply: (path: string, method: string) => Response
const base = () => `http://127.0.0.1:${server.port}`
const signal = () => new AbortController().signal
const request = (over: Partial<MediaRequest> = {}): MediaRequest => ({
  operation: 'generate',
  prompt: '一只猫',
  params: {},
  inputs: [],
  ...over,
})
const input = (role: 'reference' | 'first_frame' | 'last_frame') => ({
  role,
  mime: 'image/png',
  bytes: PNG,
  path: '/workspace/a.png',
})
const adapter = (kind: MediaKind, model: string) =>
  buildMediaAdapter({ kind, model, baseUrl: `${base()}/v1beta`, apiKey: 'test-secret' })
const block = (type: 'image' | 'video') => ({
  type,
  mime_type: type === 'image' ? 'image/png' : 'video/mp4',
  data: Buffer.from(type === 'image' ? PNG : MP4).toString('base64'),
})
const completed = (type: 'image' | 'video' = 'image') => ({
  id: 'task-1',
  status: 'completed',
  steps: [
    { type: 'thought', content: [block(type)] },
    { type: 'user_input', content: [block(type)] },
    { type: 'model_output', content: [{ type: 'text', text: '完成' }, block(type)] },
  ],
  usage: {
    total_input_tokens: 100,
    total_output_tokens: 1120,
    total_thought_tokens: 10,
    output_tokens_by_modality: [{ modality: type, tokens: 1100 }],
  },
})

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      requests.push({
        path,
        method: req.method,
        key: req.headers.get('x-goog-api-key'),
        auth: req.headers.get('authorization'),
        ...(req.method === 'POST' ? { body: (await req.json()) as Record<string, unknown> } : {}),
      })
      return reply(path, req.method)
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  requests = []
  reply = (path) => (path === '/video.mp4' ? new Response(MP4) : Response.json(completed()))
})

describe('Google 与 xAI 目录', () => {
  test('当前生成型号均已收录，类别与参数对应原生协议', () => {
    const ids = [
      'gemini-3.1-flash-lite-image',
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'gemini-omni-1.1-flash',
      'veo-3.1-generate-preview',
      'veo-3.1-fast-generate-preview',
      'veo-3.1-lite-generate-preview',
      'grok-imagine-image-2.0',
      'grok-imagine-video-1.5',
    ]
    for (const id of ids) {
      const spec = findMediaModel(id)!
      expect(spec.catalogued).toBe(true)
      expect(mediaCatalog().filter((m) => m.id === id)).toHaveLength(1)
      expect(MEDIA_KIND_OUTPUT[spec.kind]).toBe(id.includes('image') ? 'image' : 'video')
      expect(buildMediaAdapter({ kind: spec.kind, model: id, apiKey: 'key' }).spec.id).toBe(id)
    }
    expect(findMediaModel('gemini-2.5-flash-image')).toBeUndefined()
    expect(findMediaModel('veo-3.1-lite-generate-preview')!.operations).not.toContain(
      'reference_to_video',
    )
  })

  test('已收录模型默认使用目录协议，自定义地址不改变生成能力', () => {
    expect(defaultMediaKind('image', 'https://generativelanguage.googleapis.com/v1beta')).toBe(
      'gemini_images',
    )
    expect(
      defaultMediaKind('video', 'https://generativelanguage.googleapis.com/v1beta', 'veo_videos'),
    ).toBe('veo_videos')
    expect(
      defaultMediaKind(
        'video',
        'https://generativelanguage.googleapis.com/v1beta',
        'gemini_videos',
      ),
    ).toBe('gemini_videos')
    expect(defaultMediaKind('image', 'https://api.x.ai/v1')).toBe('xai_images')
    expect(defaultMediaKind('video', 'https://api.x.ai/v1')).toBe('xai_videos')
    expect(defaultMediaKind('video', 'https://relay.example/v1', 'veo_videos')).toBe('veo_videos')
    expect(defaultMediaKind('image', 'https://api.x.ai.evil.example/v1', 'xai_images')).toBe(
      'xai_images',
    )
    for (const spec of mediaCatalog()) {
      expect(
        defaultMediaKind(MEDIA_KIND_OUTPUT[spec.kind], 'https://relay.example/v1', spec.kind),
      ).toBe(spec.kind)
      expect(defaultMediaKind(MEDIA_KIND_OUTPUT[spec.kind], undefined, spec.kind)).toBe(spec.kind)
    }
    expect(lookupMediaModel('grok-imagine-video-1.5', 'openai_videos').price).toBeUndefined()
  })

  test('联合规格约束在发送前拒绝，Veo Lite 不允许 4k', () => {
    const none = { images: 0, videos: 0 }
    expect(
      validateMediaCall(
        findMediaModel('veo-3.1-fast-generate-preview')!,
        'text_to_video',
        { resolution: '1080p', durationSeconds: 4 },
        none,
      ),
    ).toHaveLength(1)
    expect(
      validateMediaCall(
        findMediaModel('veo-3.1-lite-generate-preview')!,
        'text_to_video',
        { resolution: '4k' },
        none,
      ),
    ).toHaveLength(1)
    expect(
      validateMediaCall(
        findMediaModel('grok-imagine-video-1.5')!,
        'first_last_frame',
        { resolution: '1080p' },
        none,
      ),
    ).toHaveLength(1)
    expect(
      validateMediaCall(
        findMediaModel('grok-imagine-video-1.5')!,
        'reference_to_video',
        { resolution: '720p', duration: 15 },
        { images: 7, videos: 0 },
      ),
    ).toEqual([])
    expect(
      validateMediaCall(
        findMediaModel('gemini-3.1-flash-lite-image')!,
        'generate',
        { image_size: '4K' },
        none,
      ),
    ).toHaveLength(1)
  })

  test('报价使用官方档位，Grok 自动质量不编造报价', () => {
    expect(
      quoteMedia(
        findMediaModel('veo-3.1-fast-generate-preview')!,
        { resolution: '1080p', durationSeconds: 8 },
        { images: 0, videos: 0 },
      ),
    ).toEqual({ cost: 0.96, currency: 'USD' })
    expect(
      quoteMedia(
        findMediaModel('grok-imagine-image-2.0')!,
        { n: 2, resolution: '2k', quality: 'medium' },
        { images: 2, videos: 0 },
      )?.cost,
    ).toBeCloseTo(0.18)
    expect(
      quoteMedia(findMediaModel('grok-imagine-image-2.0')!, {}, { images: 0, videos: 0 }),
    ).toBeNull()
    expect(mediaCost(findMediaModel('veo-3.1-fast-generate-preview')!, {}).cost).toBe(0)
  })
})

describe('Gemini Interactions', () => {
  test('Google 文件跳转到产物存储时不转发自定义凭证', async () => {
    let receivedKey: string | null = null
    const storage = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        receivedKey = req.headers.get('x-goog-api-key')
        return new Response(MP4)
      },
    })
    try {
      reply = () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${storage.port}/video.mp4` },
        })
      const result = await download(`${base()}/files/video`, signal(), {
        'x-goog-api-key': 'test-secret',
      })
      expect(requests[0]!.key).toBe('test-secret')
      expect(receivedKey).toBeNull()
      expect(result.bytes).toEqual(MP4)
    } finally {
      storage.stop(true)
    }
  })

  test('参考图按原生输入发送，只读取 model_output 图片并按模态计费', async () => {
    const tasks: string[] = []
    const a = adapter('gemini_images', 'gemini-3.1-flash-image')
    const result = await a.run(
      request({
        operation: 'edit',
        inputs: [input('reference')],
        params: { aspect_ratio: '16:9', image_size: '2K' },
      }),
      {
        signal: signal(),
        onTask: (id) => {
          tasks.push(id)
        },
      },
    )
    expect(requests[0]).toMatchObject({
      path: '/v1beta/interactions',
      key: 'test-secret',
      auth: null,
      body: {
        model: 'gemini-3.1-flash-image',
        background: false,
        store: false,
        response_format: { type: 'image', aspect_ratio: '16:9', image_size: '2K' },
      },
    })
    expect(requests[0]!.body!.input).toEqual([block('image'), { type: 'text', text: '一只猫' }])
    expect(tasks).toEqual([])
    expect(result.files).toEqual([{ bytes: PNG, mime: 'image/png' }])
    expect(mediaCost(a.spec, result.usage!).cost).toBeCloseTo(
      (100 * 0.5 + 30 * 3 + 1100 * 60) / 1e6,
    )
  })

  test('缺少模态计量时金额未知，不把全部 token 当作图像 token', async () => {
    reply = () => Response.json({ ...completed(), usage: { total_output_tokens: 1120 } })
    const a = adapter('gemini_images', 'gemini-3-pro-image')
    const result = await a.run(request(), { signal: signal() })
    expect(mediaCost(a.spec, result.usage!).cost).toBe(0)
  })

  test('Omni 首尾帧排序与原生指代一致，接续只查询已有任务', async () => {
    reply = () => Response.json(completed('video'))
    const a = adapter('gemini_videos', 'gemini-omni-1.1-flash')
    const result = await a.run(
      request({
        operation: 'first_last_frame',
        inputs: [input('last_frame'), input('first_frame')],
        params: { resolution: '720p' },
      }),
      { signal: signal() },
    )
    const body = requests[0]!.body!
    expect(body.response_format).toEqual({ type: 'video', resolution: '720p' })
    expect((body.input as { text?: string }[])[2]!.text).toBe(
      '[# Sources <FIRST_FRAME>@Image1 <LAST_FRAME>@Image2] 一只猫',
    )
    expect(result.files).toEqual([{ bytes: MP4, mime: 'video/mp4' }])
    requests = []
    await a.run(request(), { signal: signal(), resumeTaskId: 'task-1' })
    expect(requests.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/v1beta/interactions/task-1'],
    ])
  })

  /** 原始失败形状：查询遇到一次网络波动即结束等待，远端仍在生成的任务只能事后取回。 */
  test('远端失败与空产物是终态；查询遇到可重发的失败时继续查询，被拒绝时保留任务号', async () => {
    const a = adapter('gemini_videos', 'gemini-omni-1.1-flash')
    for (const [body, message] of [
      [{ id: 'task-1', status: 'failed', error: { message: 'blocked' } }, '远端任务失败：blocked'],
      [
        {
          id: 'task-1',
          status: 'failed',
          errors: [{ code: 'content_blocked', message: 'blocked' }],
        },
        '远端任务失败：content_blocked：blocked',
      ],
      [{ id: 'task-1', status: 'cancelled' }, '远端任务失败：任务已取消'],
      [{ id: 'task-1', status: 'completed', steps: [] }, '远端任务失败：任务完成但没有返回视频'],
    ] as const) {
      reply = () => Response.json(body)
      const err = await a.run(request(), { signal: signal() }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MediaError)
      expect((err as MediaError).message).toBe(message)
      expect((err as MediaError).pendingTaskId).toBeUndefined()
    }
    let queries = 0
    reply = (path) => {
      if (path === '/video.mp4') return new Response(MP4)
      queries++
      return queries === 1
        ? new Response('unavailable', { status: 503 })
        : Response.json(completed('video'))
    }
    const result = await a.run(request(), { signal: signal(), resumeTaskId: 'task-1' })
    expect(result.files).toEqual([{ bytes: MP4, mime: 'video/mp4' }])
    expect(queries).toBe(2)
    reply = () => new Response('not found', { status: 404 })
    const err = await a
      .run(request(), { signal: signal(), resumeTaskId: 'task-1' })
      .catch((e: unknown) => e)
    expect((err as MediaError).pendingTaskId).toBe('task-1')
  }, 15_000)

  test('Omni 首帧与参考图组合按实际图片顺序声明用途', async () => {
    reply = () => Response.json(completed('video'))
    const a = adapter('gemini_videos', 'gemini-omni-1.1-flash')
    expect(
      validateMediaCall(a.spec, 'reference_to_video', {}, { images: 1, videos: 0, firstFrames: 1 }),
    ).toEqual([])
    await a.run(
      request({
        operation: 'reference_to_video',
        inputs: [input('reference'), input('first_frame')],
      }),
      { signal: signal() },
    )
    expect((requests[0]!.body!.input as { text?: string }[])[2]!.text).toBe(
      '[# Sources <FIRST_FRAME>@Image1] [# References <IMAGE_REF_0>@Image2] 一只猫',
    )
  })

  test('URI 产物从同源文件接口携带 key 下载', async () => {
    reply = (path) =>
      path === '/video.mp4'
        ? new Response(MP4)
        : Response.json({
            ...completed('video'),
            steps: [
              { type: 'model_output', content: [{ type: 'video', uri: `${base()}/video.mp4` }] },
            ],
          })
    const result = await adapter('gemini_videos', 'gemini-omni-1.1-flash').run(request(), {
      signal: signal(),
    })
    expect(result.files[0]!.bytes).toEqual(MP4)
    expect(requests[1]!.key).toBe('test-secret')
  })
})

describe('Veo 长任务', () => {
  const id = 'models/veo-3.1-generate-preview/operations/task-1'
  const a = () => adapter('veo_videos', 'veo-3.1-generate-preview')
  test('首尾帧进入 instances，轮询取得视频并支持原任务恢复', async () => {
    reply = (path, method) =>
      method === 'POST'
        ? Response.json({ name: id })
        : path === '/video.mp4'
          ? new Response(MP4)
          : Response.json({
              done: true,
              response: {
                generateVideoResponse: {
                  generatedSamples: [{ video: { uri: `${base()}/video.mp4` } }],
                },
              },
            })
    const result = await a().run(
      request({
        operation: 'first_last_frame',
        inputs: [input('first_frame'), input('last_frame')],
        params: { durationSeconds: 8, resolution: '1080p' },
      }),
      { signal: signal() },
    )
    expect(requests[0]!.path).toBe('/v1beta/models/veo-3.1-generate-preview:predictLongRunning')
    expect(requests[0]!.body).toMatchObject({
      instances: [
        {
          prompt: '一只猫',
          image: { inlineData: { mimeType: 'image/png' } },
          lastFrame: { inlineData: { mimeType: 'image/png' } },
        },
      ],
      parameters: { durationSeconds: 8, resolution: '1080p' },
    })
    expect(requests[1]!.path).toBe(`/v1beta/${id}`)
    expect(result.files[0]!.bytes).toEqual(MP4)
    expect(result.usage).toBeUndefined()
    requests = []
    await a().run(request(), { signal: signal(), resumeTaskId: id })
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
  })

  test('参考图带 asset 类型，远端过滤作为明确失败返回', async () => {
    reply = (_path, method) =>
      Response.json(
        method === 'POST'
          ? { name: id }
          : {
              done: true,
              response: { generateVideoResponse: { raiMediaFilteredReasons: ['filtered'] } },
            },
      )
    await expect(
      a().run(request({ operation: 'reference_to_video', inputs: [input('reference')] }), {
        signal: signal(),
      }),
    ).rejects.toThrow('filtered')
    expect(requests[0]!.body).toMatchObject({
      instances: [
        {
          referenceImages: [
            { referenceType: 'asset', image: { inlineData: { mimeType: 'image/png' } } },
          ],
        },
      ],
    })
  })
})

describe('xAI 生成', () => {
  /** 未请求 `b64_json` 时 xAI 返回 imgen.x.ai 上的临时地址；此处用一个无法连接的地址代替。 */
  test('图片编辑发送 JSON images，图片内容随响应返回，实际扣费优先于目录价目', async () => {
    reply = () =>
      Response.json({
        data: [
          requests.at(-1)?.body?.response_format === 'b64_json'
            ? { b64_json: Buffer.from(PNG).toString('base64'), mime_type: 'image/jpeg' }
            : { url: 'http://127.0.0.1:1/unreachable.png' },
        ],
        usage: { cost_in_usd_ticks: 987000000 },
      })
    const a = adapter('xai_images', 'grok-imagine-image-2.0')
    const result = await a.run(
      request({
        operation: 'edit',
        inputs: [input('reference'), input('reference')],
        params: { quality: 'medium', resolution: '2k' },
      }),
      { signal: signal() },
    )
    expect(requests[0]).toMatchObject({
      path: '/v1beta/images/edits',
      key: null,
      auth: 'Bearer test-secret',
      body: {
        images: [
          {
            type: 'image_url',
            url: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
          },
          { type: 'image_url' },
        ],
      },
    })
    expect(requests).toHaveLength(1)
    expect(result.files[0]!.bytes).toEqual(PNG)
    expect(mediaCost(a.spec, result.usage!).cost).toBeCloseTo(0.0987)
    requests = []
    await a.run(request(), { signal: signal() })
    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe('/v1beta/images/generations')
    expect(requests[0]!.body!.images).toBeUndefined()
  })

  test('视频使用 request_id，首尾帧是独立字段，同源下载携带 API key', async () => {
    reply = (path, method) =>
      method === 'POST'
        ? Response.json({ request_id: 'xai-task' })
        : path === '/video.mp4'
          ? new Response(MP4)
          : Response.json({
              status: 'done',
              video: { url: `${base()}/video.mp4`, duration: 8, respect_moderation: true },
              usage: { cost_in_usd_ticks: 1000000000 },
            })
    const a = adapter('xai_videos', 'grok-imagine-video-1.5')
    const result = await a.run(
      request({
        operation: 'first_last_frame',
        inputs: [input('first_frame'), input('last_frame')],
        params: { duration: 8, resolution: '720p' },
      }),
      { signal: signal() },
    )
    expect(requests[0]).toMatchObject({
      path: '/v1beta/videos/generations',
      body: {
        duration: 8,
        resolution: '720p',
        image: { url: expect.stringContaining('data:') },
        last_frame: { url: expect.stringContaining('data:') },
      },
    })
    expect(requests[1]!.path).toBe('/v1beta/videos/xai-task')
    expect(requests[2]!.auth).toBe('Bearer test-secret')
    expect(result.usage!.seconds).toBe(8)
    expect(mediaCost(a.spec, result.usage!).cost).toBe(0.1)
    requests = []
    await a.run(request(), { signal: signal(), resumeTaskId: 'xai-task' })
    expect(requests.every((r) => r.method === 'GET')).toBe(true)
  })

  test('相对结果地址按接口解析，同源下载带鉴权，恢复任务不重新提交', async () => {
    const a = adapter('xai_videos', 'grok-imagine-video-1.5')
    for (const url of ['/v1beta/videos/xai-task/content', 'videos/xai-task/content']) {
      requests = []
      reply = (path) =>
        path.endsWith('/content')
          ? requests.at(-1)?.auth === 'Bearer test-secret'
            ? new Response(MP4)
            : new Response(null, { status: 401 })
          : Response.json({ status: 'done', video: { url } })
      const result = await a.run(request(), { signal: signal(), resumeTaskId: 'xai-task' })
      expect(requests.map((r) => [r.method, r.path])).toEqual([
        ['GET', '/v1beta/videos/xai-task'],
        ['GET', '/v1beta/videos/xai-task/content'],
      ])
      expect(result.files[0]?.bytes).toEqual(MP4)
    }
  })

  test('外域结果与跨域下载跳转均不携带接口凭证', async () => {
    const credentials: { auth: string | null; key: string | null }[] = []
    const storage = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        credentials.push({
          auth: req.headers.get('authorization'),
          key: req.headers.get('x-goog-api-key'),
        })
        return new Response(MP4)
      },
    })
    try {
      const external = `http://127.0.0.1:${storage.port}/video.mp4`
      const a = buildMediaAdapter({
        kind: 'xai_videos',
        model: 'grok-imagine-video-1.5',
        baseUrl: `${base()}/v1`,
        apiKey: 'test-secret',
        headers: { 'x-goog-api-key': 'custom-secret' },
      })
      for (const url of [external, '/v1/videos/xai-task/content']) {
        requests = []
        reply = (path) =>
          path.endsWith('/content')
            ? new Response(null, { status: 302, headers: { location: external } })
            : Response.json({ status: 'done', video: { url } })
        const result = await a.run(request(), { signal: signal(), resumeTaskId: 'xai-task' })
        expect(result.files[0]?.bytes).toEqual(MP4)
        if (url.startsWith('/'))
          expect(requests.at(-1)).toMatchObject({
            auth: 'Bearer test-secret',
            key: 'custom-secret',
          })
      }
      expect(credentials).toEqual([
        { auth: null, key: null },
        { auth: null, key: null },
      ])
    } finally {
      storage.stop(true)
    }
  })

  test('xAI 失败、过期、审核失败均不作为可取回任务', async () => {
    const a = adapter('xai_videos', 'grok-imagine-video-1.5')
    for (const [body, message] of [
      [
        { status: 'failed', error: { code: 'invalid_argument', message: 'invalid' } },
        '远端任务失败：invalid_argument：invalid',
      ],
      [{ status: 'expired' }, '远端任务失败：未知任务状态 expired'],
      [
        { status: 'done', video: { respect_moderation: false, url: `${base()}/video.mp4` } },
        '远端任务失败：视频未通过内容审核',
      ],
    ] as const) {
      reply = () => Response.json(body)
      const err = await a
        .run(request(), { signal: signal(), resumeTaskId: 'xai-task' })
        .catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MediaError)
      expect((err as MediaError).message).toBe(message)
      expect((err as MediaError).pendingTaskId).toBeUndefined()
    }
  })
})
