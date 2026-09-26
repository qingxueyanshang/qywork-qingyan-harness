/**
 * 视频生成：四个视频适配器与任务等待。
 *
 * 覆盖范围：`media/adapters/dashscope.ts` 的 `DashScopeVideosAdapter`、`media/adapters/ark-videos.ts`、
 * `media/adapters/openai-videos.ts`、`media/adapters/kling.ts` 实际发出的提交与查询、`media/task.ts` 的终态与可接续的区分，
 * `media/catalog.ts` 视频模型按 id 兜底时的操作交集与按型号的参数表，以及 `@qywork/core` 的 `defaultMediaKind` 对视频的选择。
 *
 * 起一个本机端点当远端：记下每个请求，查询按预设的状态序列回答。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { defaultMediaKind } from '@qywork/core'
import { lookupMediaModel } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import { MediaError } from './types.ts'

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])

interface Seen {
  method: string
  path: string
  search: string
  headers: Record<string, string>
  json?: Record<string, unknown>
}

let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
/** 提交的回复。 */
let submit: () => Response = () => Response.json({})
/** 每次查询依次取一个回复，取到最后一个后一直用它。 */
let polls: (() => Response)[] = []
let downloadStatus = 200
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => {
        headers[k] = v
      })
      const entry: Seen = { method: req.method, path: url.pathname, search: url.search, headers }
      if (req.headers.get('content-type')?.includes('json')) {
        entry.json = (await req.json()) as Record<string, unknown>
      }
      seen.push(entry)
      if (url.pathname.endsWith('/out.mp4') || url.pathname.endsWith('/content')) {
        return new Response(downloadStatus === 200 ? MP4 : 'gone', {
          status: downloadStatus,
          headers: { 'content-type': 'video/mp4' },
        })
      }
      if (req.method === 'POST') return submit()
      const next = polls.length > 1 ? polls.shift()! : polls[0]!
      return next()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  seen = []
  polls = []
  downloadStatus = 200
})

/** 取出这次调用的失败；成功了就让测试失败。 */
function rejection(run: Promise<unknown>): Promise<MediaError> {
  return run.then(
    () => {
      throw new Error('应当失败')
    },
    (e: unknown) => e as MediaError,
  )
}

const opts = (extra: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  ...extra,
})

describe('dashscope_videos', () => {
  const adapter = () =>
    buildMediaAdapter({
      kind: 'dashscope_videos',
      model: 'wan3.0-video',
      apiKey: 'sk-ds',
      baseUrl: `${origin()}/compatible-mode/v1`,
    })

  test('提交带异步头、输入按用途放进 media，任务号交出后查询到成功就下载', async () => {
    submit = () => Response.json({ output: { task_id: 'task-1', task_status: 'PENDING' } })
    polls = [
      () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
          usage: { video_count: 1, duration: 2.0, SR: 480, fps: 30 },
        }),
    ]
    const tasks: string[] = []
    const out = await adapter().run(
      {
        operation: 'first_last_frame',
        prompt: '花开',
        inputs: [
          { role: 'first_frame', bytes: PNG, mime: 'image/png', path: '/w/a.png' },
          { role: 'last_frame', bytes: PNG, mime: 'image/png', path: '/w/b.png' },
        ],
        params: { resolution: '480P', duration: 2 },
      },
      opts({ onTask: (id: string) => tasks.push(id) }),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/api/v1/services/aigc/video-generation/video-synthesis')
    expect(post.headers['x-dashscope-async']).toBe('enable')
    expect(post.json).toMatchObject({
      model: 'wan3.0-video',
      input: {
        prompt: '花开',
        media: [
          { type: 'first_frame', url: expect.stringMatching(/^data:image\/png;base64,/) },
          { type: 'last_frame', url: expect.stringMatching(/^data:image\/png;base64,/) },
        ],
      },
      parameters: { resolution: '480P', duration: 2 },
    })
    expect(tasks).toEqual(['task-1'])
    expect(seen.some((s) => s.path === '/api/v1/tasks/task-1')).toBe(true)
    expect(out.files[0]?.bytes).toEqual(MP4)
    // 计量取查询结果顶层的 `usage`：万相的 `SR` 是数字。
    expect(out.usage).toEqual({ seconds: 2, resolution: '480p', videoInput: false })
  })

  test('接续取回只查询与下载，不再提交', async () => {
    polls = [
      () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
        }),
    ]
    await adapter().run(
      { operation: 'text_to_video', prompt: '', inputs: [], params: {} },
      opts({ resumeTaskId: 'task-9' }),
    )
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(0)
    expect(seen[0]?.path).toBe('/api/v1/tasks/task-9')
  })

  /** 远端明确失败是终态：没有任务号可接续，调用方据此删掉任务记录。 */
  test('远端失败不带任务号；下载失败带任务号可接续', async () => {
    submit = () => Response.json({ output: { task_id: 'task-2' } })
    polls = [
      () =>
        Response.json({
          output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: '不合规' },
        }),
    ]
    const failed = await rejection(
      adapter().run({ operation: 'text_to_video', prompt: 'x', inputs: [], params: {} }, opts()),
    )
    expect(failed.message).toContain('DataInspectionFailed')
    expect(failed.pendingTaskId).toBeUndefined()

    polls = [
      () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
        }),
    ]
    downloadStatus = 500
    const pending = await rejection(
      adapter().run({ operation: 'text_to_video', prompt: 'x', inputs: [], params: {} }, opts()),
    )
    expect(pending).toBeInstanceOf(MediaError)
    expect(pending.pendingTaskId).toBe('task-2')
  })

  test('状态变化时回报一次，不按查询次数回报', async () => {
    submit = () => Response.json({ output: { task_id: 'task-3' } })
    polls = [
      () => Response.json({ output: { task_status: 'RUNNING' } }),
      () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
        }),
    ]
    const statuses: string[] = []
    await adapter().run(
      { operation: 'text_to_video', prompt: 'x', inputs: [], params: {} },
      opts({ onStatus: (s: string) => statuses.push(s) }),
    )
    expect(statuses).toEqual(['RUNNING'])
  }, 15_000)

  /** 同一端点上的可灵用另一套素材类型名；视频的用途由 `video_type` 指定，它不作为参数发出。 */
  test('可灵按目录的类型名放素材，video_type 写进视频那一项', async () => {
    submit = () => Response.json({ output: { task_id: 'task-k' } })
    polls = [
      () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
          usage: {
            duration: 5,
            size: '1280*720',
            fps: 24,
            video_count: 1,
            audio: false,
            SR: '720',
          },
        }),
    ]
    const out = await buildMediaAdapter({
      kind: 'dashscope_videos',
      model: 'kling/kling-v3-omni-video-generation',
      apiKey: 'sk-ds',
      baseUrl: `${origin()}/compatible-mode/v1`,
    }).run(
      {
        operation: 'video_to_video',
        prompt: '把视频里的人换成图里的人',
        inputs: [
          { role: 'video', bytes: MP4, mime: 'video/mp4', path: '/w/a.mp4' },
          { role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/b.png' },
        ],
        params: { video_type: 'base', mode: 'std' },
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.json).toMatchObject({
      model: 'kling/kling-v3-omni-video-generation',
      input: { media: [{ type: 'base' }, { type: 'refer' }] },
    })
    expect(post.json?.parameters).toEqual({ mode: 'std' })
    // 可灵的 `SR` 是字符串，另回 `audio`；输入含视频由请求决定。
    expect(out.usage).toEqual({ seconds: 5, resolution: '720p', audio: false, videoInput: true })
  })
})

describe('ark_videos', () => {
  test('输入进 content 并带 role，参数在顶层，状态词按方舟的读', async () => {
    submit = () => Response.json({ id: 'cgt-1' })
    polls = [
      () =>
        Response.json({
          status: 'succeeded',
          content: { video_url: `${origin()}/files/out.mp4` },
          usage: { completion_tokens: 108000, total_tokens: 108000 },
          duration: 5,
          resolution: '720p',
          generate_audio: true,
        }),
    ]
    const adapter = buildMediaAdapter({
      kind: 'ark_videos',
      model: 'doubao-seedance-2-5-260628',
      apiKey: 'sk-ark',
      baseUrl: `${origin()}/api/v3`,
    })
    const out = await adapter.run(
      {
        operation: 'video_to_video',
        prompt: '把背景换成夜晚',
        inputs: [{ role: 'video', bytes: MP4, mime: 'video/mp4', path: '/w/a.mp4' }],
        params: { omni_reference_task_type: 'edit', ratio: 'adaptive', duration: -1 },
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/api/v3/contents/generations/tasks')
    expect(post.json).toMatchObject({
      model: 'doubao-seedance-2-5-260628',
      content: [
        { type: 'text', text: '把背景换成夜晚' },
        {
          type: 'video_url',
          video_url: { url: expect.stringMatching(/^data:video\/mp4;/) },
          role: 'reference_video',
        },
      ],
      omni_reference_task_type: 'edit',
      ratio: 'adaptive',
      duration: -1,
    })
    expect(seen.some((s) => s.path === '/api/v3/contents/generations/tasks/cgt-1')).toBe(true)
    expect(out.usage).toEqual({
      outputTokens: 108000,
      seconds: 5,
      resolution: '720p',
      audio: true,
      videoInput: true,
    })
  })
})

describe('kling_videos', () => {
  const adapter = (model: string) =>
    buildMediaAdapter({ kind: 'kling_videos', model, apiKey: 'kling-key', baseUrl: origin() })
  const succeeded = (id: string) => () =>
    Response.json({
      code: 0,
      data: [
        { id, status: 'succeeded', outputs: [{ type: 'video', url: `${origin()}/files/out.mp4` }] },
      ],
    })

  test('文生只发 prompt 与 settings，按任务号查询，取 outputs 里的视频', async () => {
    submit = () => Response.json({ code: 0, data: { id: 'kt-1', status: 'submitted' } })
    polls = [succeeded('kt-1')]
    const out = await adapter('kling-3.0').run(
      {
        operation: 'text_to_video',
        prompt: '海浪',
        inputs: [],
        params: { resolution: '1080p', duration: 5 },
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/text-to-video/kling-3.0')
    expect(post.headers.authorization).toBe('Bearer kling-key')
    expect(post.json).toEqual({ prompt: '海浪', settings: { resolution: '1080p', duration: 5 } })
    expect(seen.some((s) => s.path === '/tasks' && s.search === '?task_ids=kt-1')).toBe(true)
    expect(out.files[0]?.bytes).toEqual(MP4)
  })

  /** 金额取从余额扣的那几项；从资源包扣的只有单位数，没有金额。 */
  test('计量取视频时长与 billing 里的实扣金额', async () => {
    const task = (billing: unknown[]) => () =>
      Response.json({
        code: 0,
        data: [
          {
            id: 'kt-b',
            status: 'succeeded',
            outputs: [{ type: 'video', url: `${origin()}/files/out.mp4`, duration: '5' }],
            billing,
          },
        ],
      })
    const run = () =>
      adapter('kling-3.0').run(
        { operation: 'text_to_video', prompt: '海浪', inputs: [], params: {} },
        opts({ resumeTaskId: 'kt-b' }),
      )
    polls = [task([{ charge_type: 'cash', amount: '0.56', currency: 'CNY', list_price: '0.6' }])]
    expect((await run()).usage).toEqual({ seconds: 5, billed: { amount: 0.56, currency: 'CNY' } })
    polls = [task([{ charge_type: 'unit', amount: '4', package_type: 'video' }])]
    expect((await run()).usage).toEqual({ seconds: 5 })
  })

  test('首尾帧走 image-to-video，文字与图片进 contents，图片是不带前缀的 base64', async () => {
    submit = () => Response.json({ code: 0, data: { id: 'kt-2' } })
    polls = [succeeded('kt-2')]
    await adapter('kling-3.0').run(
      {
        operation: 'first_last_frame',
        prompt: '花开',
        inputs: [
          { role: 'first_frame', bytes: PNG, mime: 'image/png', path: '/w/a.png' },
          { role: 'last_frame', bytes: PNG, mime: 'image/png', path: '/w/b.png' },
        ],
        params: {},
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    const base64 = Buffer.from(PNG).toString('base64')
    expect(post.path).toBe('/image-to-video/kling-3.0')
    expect(post.json).toEqual({
      contents: [
        { type: 'prompt', text: '花开' },
        { type: 'first_frame', url: base64 },
        { type: 'last_frame', url: base64 },
      ],
    })
  })

  test('参考图走 omni-video；远端失败是终态；提交被拒带接口原文', async () => {
    submit = () => Response.json({ code: 0, data: { id: 'kt-3' } })
    polls = [
      () =>
        Response.json({ code: 0, data: [{ id: 'kt-3', status: 'failed', message: '内容不合规' }] }),
    ]
    const failed = await rejection(
      adapter('kling-3.0-omni').run(
        {
          operation: 'reference_to_video',
          prompt: '图里的猫在跑',
          inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' }],
          params: { aspect_ratio: '1:1' },
        },
        opts(),
      ),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/omni-video/kling-3.0-omni')
    expect(post.json).toMatchObject({
      contents: [{ type: 'prompt' }, { type: 'refer_image' }],
      settings: { aspect_ratio: '1:1' },
    })
    expect(failed.message).toContain('内容不合规')
    expect(failed.pendingTaskId).toBeUndefined()

    submit = () => Response.json({ code: 1201, message: 'model not supported' })
    const refused = await rejection(
      adapter('kling-3.0').run(
        { operation: 'text_to_video', prompt: 'x', inputs: [], params: {} },
        opts(),
      ),
    )
    expect(refused.message).toContain('model not supported')
  })
})

describe('目录与默认协议', () => {
  test('Seedance 2.0 Fast 的清晰度与时长按它自己的表校验', () => {
    const spec = lookupMediaModel('doubao-seedance-2-0-fast-260128', 'ark_videos')
    const none = { images: 0, videos: 0 }
    expect(validateMediaCall(spec, 'text_to_video', { resolution: '1080p' }, none)).toHaveLength(1)
    expect(validateMediaCall(spec, 'text_to_video', { duration: 20 }, none)).toHaveLength(1)
    expect(
      validateMediaCall(spec, 'text_to_video', { resolution: '720p', duration: 15 }, none),
    ).toEqual([])
  })

  test('添加视频模型时按接口地址定协议', () => {
    expect(defaultMediaKind('video', 'https://api-beijing.klingai.com')).toBe('kling_videos')
    expect(defaultMediaKind('video', 'https://api-singapore.klingai.com/')).toBe('kling_videos')
    expect(defaultMediaKind('video', 'https://ark.cn-beijing.volces.com/api/v3')).toBe('ark_videos')
    expect(
      defaultMediaKind('video', 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
    ).toBe('dashscope_videos')
    expect(defaultMediaKind('video', 'https://relay.example.com/v1')).toBe('openai_videos')
  })
})

describe('openai_videos', () => {
  test('seconds 与 size 在顶层，厂商字段进 metadata，内容带 key 下载', async () => {
    submit = () => Response.json({ id: 'video_1', status: 'queued' })
    polls = [() => Response.json({ id: 'video_1', status: 'completed' })]
    const adapter = buildMediaAdapter({
      kind: 'openai_videos',
      model: 'doubao-seedance-2-5-260628',
      apiKey: 'sk-relay',
      baseUrl: origin(),
    })
    const out = await adapter.run(
      {
        operation: 'text_to_video',
        prompt: '海浪',
        inputs: [],
        params: { seconds: '5', size: '720x1280', resolution: '720p' },
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/v1/videos')
    expect(post.json).toEqual({
      model: 'doubao-seedance-2-5-260628',
      prompt: '海浪',
      seconds: '5',
      size: '720x1280',
      metadata: { resolution: '720p' },
    })
    const content = seen.find((s) => s.path === '/v1/videos/video_1/content')
    expect(content?.headers.authorization).toBe('Bearer sk-relay')
    expect(out.files[0]?.bytes).toEqual(MP4)
  })

  /** 中转站的参考图形状没有核实过，按 id 兜底时只留两边都支持的操作。 */
  test('目录里的视频模型挂在中转站上时只剩文生', () => {
    const spec = lookupMediaModel('doubao-seedance-2-5-260628', 'openai_videos')
    expect(spec.operations).toEqual(['text_to_video'])
    expect(spec.inputs).toMatchObject({ maxImages: 0, maxVideos: 0 })
    expect(spec.params.map((p) => p.name)).toContain('omni_reference_task_type')
  })
})
