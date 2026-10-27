/**
 * MiniMax 图像与视频生成。
 *
 * 覆盖范围：`media/adapters/minimax.ts` 的 `MiniMaxImagesAdapter` 与 `MiniMaxVideosAdapter` 实际发出的请求与响应的解析方式，
 * `catalog-minimax-image.ts`、`catalog-minimax-video.ts` 的参数约束与单价，`@qywork/core` 的 `defaultMediaKind` 对 MiniMax 官方地址的取值。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { defaultMediaKind } from '@qywork/core'
import { lookupMediaModel, mediaCost, quoteMedia } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import type { MediaError } from './types.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const MP4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom')])

interface Seen {
  method: string
  path: string
  auth: string | null
  json?: Record<string, unknown>
}

let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
let reply: () => Response = () => new Response('')
let polls: (() => Response)[] = []
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/files/a.png') return new Response(PNG)
      if (url.pathname === '/files/out.mp4') return new Response(MP4)
      seen.push({
        method: req.method,
        path: url.pathname,
        auth: req.headers.get('authorization'),
        ...(req.method === 'POST' ? { json: (await req.json()) as Record<string, unknown> } : {}),
      })
      if (req.method === 'GET')
        return (polls.shift() ?? (() => new Response('', { status: 500 })))()
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  seen = []
  polls = []
})

const opts = () => ({ signal: new AbortController().signal })

test('MiniMax 官方地址的图像、视频、语音默认使用 MiniMax 协议', () => {
  for (const base of ['https://api.minimax.cn/v1', 'https://api.minimax.io/v1']) {
    expect(defaultMediaKind('image', base)).toBe('minimax_images')
    expect(defaultMediaKind('video', base)).toBe('minimax_videos')
    expect(defaultMediaKind('audio', base)).toBe('minimax_speech')
  }
  expect(defaultMediaKind('image', 'https://relay.example/v1')).toBe('openai_images')
})

describe('minimax_images', () => {
  const adapter = (model = 'image-01') =>
    buildMediaAdapter({ kind: 'minimax_images', model, apiKey: 'sk', baseUrl: `${origin()}/v1` })
  const ok = (meta: Record<string, unknown>, urls = [`${origin()}/files/a.png`]) =>
    Response.json({
      id: 't1',
      data: { image_urls: urls },
      metadata: meta,
      base_resp: { status_code: 0, status_msg: 'success' },
    })

  test('参考图作为人物主体参考发送，画风放入 style，按成功张数计价', async () => {
    reply = () =>
      ok({ success_count: '2', failed_count: '0' }, [
        `${origin()}/files/a.png`,
        `${origin()}/files/a.png`,
      ])
    const out = await adapter('image-01-live').run(
      {
        operation: 'edit',
        prompt: '图书馆窗边远眺的女孩',
        inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' }],
        params: { aspect_ratio: '16:9', n: 2, style_type: '水彩' },
      },
      opts(),
    )
    expect(seen[0]).toEqual({
      method: 'POST',
      path: '/v1/image_generation',
      auth: 'Bearer sk',
      json: {
        model: 'image-01-live',
        prompt: '图书馆窗边远眺的女孩',
        aspect_ratio: '16:9',
        n: 2,
        style: { style_type: '水彩' },
        subject_reference: [
          {
            type: 'character',
            image_file: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
          },
        ],
      },
    })
    expect(out.files).toHaveLength(2)
    expect(out.files[0]?.mime).toBe('image/png')
    expect(out.usage).toEqual({ images: 2 })
    expect(mediaCost(adapter().spec, out.usage!)).toEqual({ cost: 0.05, currency: 'CNY' })
    const quote = quoteMedia(
      lookupMediaModel('image-01', 'minimax_images'),
      { n: 3 },
      {
        images: 0,
        videos: 0,
      },
    )
    expect(quote?.cost).toBeCloseTo(0.075, 10)
  })

  test('部分图片未通过内容安全检查时保留其余产物并带警告；全部未通过时报错', async () => {
    reply = () => ok({ success_count: 1, failed_count: 1 })
    const partial = await adapter().run(
      { operation: 'generate', prompt: 'p', inputs: [], params: { n: 2 } },
      opts(),
    )
    expect(partial.files).toHaveLength(1)
    expect(partial.warning).toBe('1 张图片未通过内容安全检查')

    reply = () => ok({ success_count: 0, failed_count: 2 }, [])
    await expect(
      adapter().run({ operation: 'generate', prompt: 'p', inputs: [], params: {} }, opts()),
    ).rejects.toThrow('2 张图片未通过内容安全检查')
  })

  test('base_resp 非 0 时报告接口原文', async () => {
    reply = () =>
      Response.json({ base_resp: { status_code: 1026, status_msg: 'sensitive content' } })
    await expect(
      adapter().run({ operation: 'generate', prompt: 'p', inputs: [], params: {} }, opts()),
    ).rejects.toThrow('接口拒绝生成：1026：sensitive content')
  })

  test('image-01-live 不接受 21:9；参考图每次一张', () => {
    const live = lookupMediaModel('image-01-live', 'minimax_images')
    const problems = validateMediaCall(
      live,
      'edit',
      { aspect_ratio: '21:9' },
      { images: 2, videos: 0 },
    )
    expect(problems.join('\n')).toContain('21:9')
    expect(problems.join('\n')).toContain('最多接受 1 张参考图')
  })
})

describe('minimax_videos', () => {
  const adapter = (model = 'MiniMax-H3') =>
    buildMediaAdapter({ kind: 'minimax_videos', model, apiKey: 'sk', baseUrl: `${origin()}/v1` })
  const succeeded =
    (usage: Record<string, unknown>, resolution = '2K') =>
    () =>
      Response.json({
        task: {
          id: 'v1',
          status: 'succeeded',
          content: { url: `${origin()}/files/out.mp4` },
          resolution,
          duration: 5,
          usage,
        },
      })

  test('文生视频补齐必填的分辨率、时长与画幅，提交与查询位于版本段之外', async () => {
    reply = () => Response.json({ task_id: 'v1' })
    polls = [succeeded({ output_seconds: 5, input_seconds: 0, input_image_count: 0 }, '768P')]
    const out = await adapter().run(
      { operation: 'text_to_video', prompt: '海边打篮球', inputs: [], params: {} },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/v2/video_generation')
    expect(post.json).toEqual({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: '海边打篮球' }],
      resolution: '768P',
      duration: 5,
      ratio: '16:9',
    })
    expect(seen.find((s) => s.method === 'GET')?.path).toBe('/v2/query/video_generation/v1')
    expect(out.files[0]?.mime).toBe('video/mp4')
    expect(out.usage).toEqual({ seconds: 5, inputSeconds: 0, inputImages: 0, resolution: '768p' })
  })

  test('首尾帧带 role 且画幅为 adaptive；Max 的扩写模式放入 extra', async () => {
    reply = () => Response.json({ task_id: 'v1' })
    polls = [succeeded({ output_seconds: 5 }, '768P')]
    await adapter('MiniMax-H3-Max').run(
      {
        operation: 'first_last_frame',
        prompt: '小女孩长大',
        inputs: [
          { role: 'first_frame', bytes: PNG, mime: 'image/png', path: '/w/a.png' },
          { role: 'last_frame', bytes: PNG, mime: 'image/png', path: '/w/b.png' },
        ],
        params: { prompt_expansion_mode: 'quality', duration: 8 },
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.json).toMatchObject({
      model: 'MiniMax-H3-Max',
      content: [
        { type: 'text', text: '小女孩长大' },
        { type: 'image_url', role: 'first_frame' },
        { type: 'image_url', role: 'last_frame' },
      ],
      resolution: '768P',
      duration: 8,
      ratio: 'adaptive',
      extra: { prompt_expansion_mode: 'quality' },
    })
    expect(post.json).not.toHaveProperty('prompt_expansion_mode')
  })

  test('远端失败时报告错误码与原文', async () => {
    reply = () => Response.json({ task_id: 'v2' })
    polls = [
      () =>
        Response.json({
          task: {
            id: 'v2',
            status: 'failed',
            error: { code: '1026', message: 'video description contains sensitive content' },
          },
        }),
    ]
    const err = await adapter()
      .run({ operation: 'text_to_video', prompt: 'p', inputs: [], params: {} }, opts())
      .then(
        () => {
          throw new Error('应当失败')
        },
        (e: unknown) => e as MediaError,
      )
    expect(err.message).toBe('远端任务失败：1026：video description contains sensitive content')
    expect(err.pendingTaskId).toBeUndefined()
  })

  test('输出与参考视频按秒、参考图超出免费张数按张计价；发送前按参数报价', () => {
    const h3 = lookupMediaModel('MiniMax-H3', 'minimax_videos')
    const h3Cost = mediaCost(h3, { seconds: 5, inputSeconds: 3, inputImages: 7, resolution: '2k' })
    expect(h3Cost.currency).toBe('CNY')
    expect(h3Cost.cost).toBeCloseTo(6.8, 10)
    const max = lookupMediaModel('MiniMax-H3-Max', 'minimax_videos')
    expect(
      mediaCost(max, { seconds: 10, inputSeconds: 4, inputImages: 3, resolution: '768p' }).cost,
    ).toBeCloseTo(9.38, 10)
    expect(
      quoteMedia(h3, { resolution: '2K', duration: 10 }, { images: 6, videos: 0 })?.cost,
    ).toBeCloseTo(8.2, 10)
    expect(quoteMedia(h3, {}, { images: 0, videos: 1 })).toBeNull()
  })

  test('文生视频不接受 adaptive；Max 不支持 4 秒；Lite 的参考生视频须指定画幅', () => {
    const problems = (model: string, op: 'text_to_video' | 'reference_to_video', params: object) =>
      validateMediaCall(
        lookupMediaModel(model, 'minimax_videos'),
        op,
        params as Record<string, unknown>,
        {
          images: op === 'reference_to_video' ? 1 : 0,
          videos: 0,
        },
      ).join('\n')
    expect(problems('MiniMax-H3', 'text_to_video', { ratio: 'adaptive' })).toContain('adaptive')
    expect(problems('MiniMax-H3-Max', 'text_to_video', { duration: 4 })).toContain('duration')
    expect(problems('MiniMax-H3-Lite', 'reference_to_video', { ratio: 'adaptive' })).toContain(
      'adaptive',
    )
    expect(problems('MiniMax-H3', 'reference_to_video', { ratio: 'adaptive' })).toBe('')
  })
})
