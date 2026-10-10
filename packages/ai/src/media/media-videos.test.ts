/**
 * 视频生成：四个视频适配器与任务等待。
 *
 * 覆盖范围：`media/adapters/dashscope.ts` 的 `DashScopeVideosAdapter`、`media/adapters/ark-videos.ts`、
 * `media/adapters/openai-videos.ts`、`media/adapters/kling.ts` 实际发出的提交与查询、`media/task.ts` 对终态与可接续失败的区分，
 * `media/catalog.ts` 视频模型按 id 回退时的操作交集与按型号区分的参数表，以及 `@qywork/core` 的 `defaultMediaKind` 对视频的选择；
 * 百炼与方舟的任务撤销（`cancel`），以及各厂商进行中状态词归并为排队中 / 生成中（`taskPhase`）。
 *
 * 启动本机端点作为远端：记录每个请求，查询按预设的状态序列应答。
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultMediaKind } from '@qywork/core'
import { lookupMediaModel } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import { taskPhase } from './task.ts'
import { MediaError } from './types.ts'

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 2])

interface Seen {
  method: string
  path: string
  search: string
  headers: Record<string, string>
  json?: Record<string, unknown>
}

let server: ReturnType<typeof Bun.serve>
let seen: Seen[] = []
/** 提交请求的应答。 */
let submit: () => Response = () => Response.json({})
/** 每次查询依次取一个应答，取到最后一个后持续使用该应答。 */
let polls: (() => Response)[] = []
/** DELETE 请求的应答（方舟撤销）。 */
let remove: () => Response = () => Response.json({})
let downloadStatus = 200
let inputDir: string
let uploadFetch: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(async () => {
  inputDir = await mkdtemp(join(tmpdir(), 'media-upload-'))
  await writeFile(join(inputDir, 'a.mp4'), MP4)
  await writeFile(join(inputDir, 'b.png'), PNG)
  await writeFile(join(inputDir, 'v.wav'), new Uint8Array([0x52, 0x49, 0x46, 0x46]))
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
      if (req.method === 'POST' && req.headers.get('content-type')?.includes('json')) {
        entry.json = (await req.json()) as Record<string, unknown>
      }
      seen.push(entry)
      if (url.pathname.endsWith('/api/v1/uploads')) {
        return Response.json({
          data: {
            policy: 'policy',
            signature: 'signature',
            upload_dir: 'dashscope-instant/test',
            upload_host: 'https://bucket.oss-cn-beijing.aliyuncs.com',
            oss_access_key_id: 'test',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
          },
        })
      }
      if (url.pathname.endsWith('/last.jpg')) {
        return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
      }
      if (url.pathname.endsWith('/out.mp4') || url.pathname.endsWith('/content')) {
        return new Response(downloadStatus === 200 ? MP4 : 'gone', {
          status: downloadStatus,
          headers: { 'content-type': 'video/mp4' },
        })
      }
      if (req.method === 'POST') return submit()
      if (req.method === 'DELETE') return remove()
      const next = polls.length > 1 ? polls.shift()! : polls[0]!
      return next()
    },
  })
})
afterAll(() => server.stop(true))
afterEach(() => {
  uploadFetch?.mockRestore()
  uploadFetch = undefined
})
beforeEach(() => {
  seen = []
  polls = []
  downloadStatus = 200
})

/** 取出本次调用的失败；调用成功时使测试失败。 */
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

function captureUpload(...bytes: Uint8Array[]) {
  const original = globalThis.fetch
  uploadFetch = spyOn(globalThis, 'fetch').mockImplementation((async (url, init) => {
    if (String(url) !== 'https://bucket.oss-cn-beijing.aliyuncs.com/') return original(url, init)
    const form = init?.body as FormData
    const uploaded = Buffer.from(await (form.get('file') as File).arrayBuffer())
    expect(bytes.some((expected) => uploaded.equals(Buffer.from(expected)))).toBe(true)
    seen.push({ method: 'POST', path: '/oss-upload', search: '', headers: {} })
    return new Response('')
  }) as typeof fetch)
}

describe('dashscope_videos', () => {
  const adapter = () =>
    buildMediaAdapter({
      kind: 'dashscope_videos',
      model: 'wan3.0-video',
      apiKey: 'sk-ds',
      baseUrl: `${origin()}/compatible-mode/v1`,
    })

  test('带前缀的原生接口在上传、提交、查询和撤销时使用同一地址', async () => {
    captureUpload(MP4)
    const addresses = ['', '/compatible-mode', '/compatible-mode/v1', '/api/v1', '/v1/'].map(
      (suffix) => ({ path: `/gateway/ali${suffix}`, prefix: '/gateway/ali' }),
    )
    addresses.push({ path: '/gateway/v1/compatible-mode/v1', prefix: '/gateway/v1' })
    for (const { path, prefix } of addresses) {
      seen = []
      submit = () => Response.json({ output: { task_id: 'prefix-task', task_status: 'PENDING' } })
      polls = [
        () =>
          Response.json({
            output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
          }),
      ]
      const a = buildMediaAdapter({
        kind: 'dashscope_videos',
        model: 'wan3.0-video',
        apiKey: 'sk-ds',
        baseUrl: `${origin()}${path}`,
      })
      const result = await a.run(
        {
          operation: 'video_to_video',
          prompt: '花开',
          inputs: [{ role: 'video', bytes: MP4, mime: 'video/mp4', path: join(inputDir, 'a.mp4') }],
          params: { duration: 2 },
        },
        opts(),
      )
      expect(result.files[0]?.bytes).toEqual(MP4)
      expect(seen.map((entry) => entry.path)).toEqual([
        `${prefix}/api/v1/uploads`,
        '/oss-upload',
        `${prefix}/api/v1/services/aigc/video-generation/video-synthesis`,
        `${prefix}/api/v1/tasks/prefix-task`,
        '/files/out.mp4',
      ])
      expect(seen[0]?.headers.authorization).toBe('Bearer sk-ds')
      expect(seen[2]?.json).toMatchObject({
        input: { media: [{ type: 'reference_video', url: expect.stringMatching(/^oss:\/\//) }] },
        parameters: { duration: 2 },
      })
      submit = () => Response.json({})
      expect(await a.cancel!('prefix-task', opts().signal)).toBe('cancelled')
      expect(seen.at(-1)?.path).toBe(`${prefix}/api/v1/tasks/prefix-task/cancel`)
    }
  })

  test('提交时携带异步请求头，输入按用途放入 media，返回任务号后查询到成功即下载', async () => {
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

  /** 远端明确失败是终态：没有可接续的任务号，调用方据此删除任务记录。 */
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
    expect(failed.message).toBe('远端任务失败：DataInspectionFailed：不合规')
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

  /** 同一端点上的可灵使用另一套素材类型名；视频的用途由 `video_type` 指定，`video_type` 不作为请求参数发送。 */
  test('可灵按目录中的类型名放置素材，video_type 写入视频项', async () => {
    captureUpload(MP4, PNG)
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
          { role: 'video', bytes: MP4, mime: 'video/mp4', path: join(inputDir, 'a.mp4') },
          { role: 'reference', bytes: PNG, mime: 'image/png', path: join(inputDir, 'b.png') },
        ],
        params: { video_type: 'base', mode: 'std' },
      },
      opts(),
    )
    const post = seen.find((s) => s.path.endsWith('/video-synthesis'))!
    expect(post.json).toMatchObject({
      model: 'kling/kling-v3-omni-video-generation',
      input: { media: [{ type: 'base' }, { type: 'refer' }] },
    })
    expect(post.json?.parameters).toEqual({ mode: 'std' })
    expect(post.headers['x-dashscope-ossresourceresolve']).toBe('enable')
    expect(seen.filter((s) => s.path === '/oss-upload')).toHaveLength(2)
    // 可灵的 `SR` 是字符串，另外回报 `audio`；输入是否含视频由请求决定。
    expect(out.usage).toEqual({ seconds: 5, resolution: '720p', audio: false, videoInput: true })
  })
})

/**
 * 参考音频的请求形状依据方舟与万相的「创建视频生成任务」文档原文：方舟为 `content[]` 中一项 `type: audio_url`、`role: reference_audio`，
 * data URI 写格式名 `data:audio/mp3`；万相为 `media[]` 中一项 `type: reference_audio`。
 */
describe('参考音频', () => {
  test('百炼可灵仅允许已声明的素材组合，有视频时最多四张参考图', () => {
    const spec = lookupMediaModel('kling/kling-v3-omni-video-generation', 'dashscope_videos')
    const validate = (images: number, firstFrames = 0, video_type = 'feature') =>
      validateMediaCall(spec, 'video_to_video', { video_type }, { images, videos: 1, firstFrames })
    expect(validate(4)).toEqual([])
    expect(validate(5).join()).toContain('素材组合或数量')
    expect(validate(0, 1)).toEqual([])
    expect(validate(0, 1, 'base').join()).toContain('素材组合或数量')
  })
  const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46])
  const MP3 = new Uint8Array([0x49, 0x44, 0x33])

  test('方舟：audio_url + reference_audio，mp3 写为 data:audio/mp3', async () => {
    submit = () => Response.json({ id: 'cgt-a' })
    polls = [
      () =>
        Response.json({ status: 'succeeded', content: { video_url: `${origin()}/files/out.mp4` } }),
    ]
    const adapter = buildMediaAdapter({
      kind: 'ark_videos',
      model: 'doubao-seedance-2-0-260128',
      apiKey: 'sk-ark',
      baseUrl: `${origin()}/api/v3`,
    })
    await adapter.run(
      {
        operation: 'reference_to_video',
        prompt: '图片1 开口说话',
        inputs: [
          { role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' },
          { role: 'audio', bytes: MP3, mime: 'audio/mpeg', path: '/w/v.mp3' },
        ],
        params: {},
      },
      opts(),
    )
    const content = seen.find((s) => s.method === 'POST')?.json?.content as unknown[]
    expect(content[2]).toEqual({
      type: 'audio_url',
      audio_url: { url: `data:audio/mp3;base64,${Buffer.from(MP3).toString('base64')}` },
      role: 'reference_audio',
    })
  })

  test('万相：media 中一项 reference_audio', async () => {
    captureUpload(WAV)
    submit = () => Response.json({ output: { task_id: 'task-a', task_status: 'PENDING' } })
    polls = [
      () =>
        Response.json({
          output: { task_status: 'SUCCEEDED', video_url: `${origin()}/files/out.mp4` },
        }),
    ]
    await buildMediaAdapter({
      kind: 'dashscope_videos',
      model: 'wan3.0-video',
      apiKey: 'sk-ds',
      baseUrl: `${origin()}/compatible-mode/v1`,
    }).run(
      {
        operation: 'reference_to_video',
        prompt: '图1 唱歌',
        inputs: [
          { role: 'reference', bytes: PNG, mime: 'image/png', path: '/w/a.png' },
          { role: 'audio', bytes: WAV, mime: 'audio/wav', path: join(inputDir, 'v.wav') },
        ],
        params: {},
      },
      opts(),
    )
    const post = seen.find((s) => s.path.endsWith('/video-synthesis'))!
    const media = (post.json?.input as { media: unknown[] }).media
    expect(media[1]).toEqual({
      type: 'reference_audio',
      url: expect.stringMatching(/^oss:\/\/dashscope-instant\/test\/.+-v.wav$/),
    })
    expect(post.headers['x-dashscope-ossresourceresolve']).toBe('enable')
    expect(seen.filter((s) => s.path === '/oss-upload')).toHaveLength(1)
  })

  test('段数超出目录上限时拒绝；目录未声明上限的模型不接受参考音频', () => {
    const seedance = lookupMediaModel('doubao-seedance-2-0-260128', 'ark_videos')
    expect(
      validateMediaCall(seedance, 'reference_to_video', {}, { images: 1, videos: 0, audios: 4 }),
    ).toEqual([`${seedance.id} 最多接受 3 段参考音频，本次提供了 4 段`])
    const kling = lookupMediaModel('kling/kling-v3-omni-video-generation', 'dashscope_videos')
    expect(
      validateMediaCall(kling, 'reference_to_video', {}, { images: 1, videos: 0, audios: 1 }),
    ).toContain(`${kling.id} 不接受参考音频`)
  })
})

describe('ark_videos', () => {
  test('输入放入 content 并带 role，参数位于顶层，状态词按方舟的定义读取', async () => {
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

  test('请求尾帧时：查询结果带尾帧地址则下载为第二个产物，类型为图片', async () => {
    submit = () => Response.json({ id: 'cgt-2' })
    polls = [
      () =>
        Response.json({
          status: 'succeeded',
          content: {
            video_url: `${origin()}/files/out.mp4`,
            last_frame_url: `${origin()}/files/last.jpg`,
          },
          usage: { completion_tokens: 1000 },
        }),
    ]
    const adapter = buildMediaAdapter({
      kind: 'ark_videos',
      model: 'doubao-seedance-2-0-260128',
      apiKey: 'sk-ark',
      baseUrl: `${origin()}/api/v3`,
    })
    const out = await adapter.run(
      {
        operation: 'text_to_video',
        prompt: '雨夜',
        inputs: [],
        params: { return_last_frame: true },
      },
      opts(),
    )
    expect(seen.find((s) => s.method === 'POST')?.json).toMatchObject({ return_last_frame: true })
    expect(out.files).toEqual([
      { bytes: MP4, mime: 'video/mp4' },
      { bytes: JPEG, mime: 'image/jpeg' },
    ])
  })

  test('远端失败显示错误码与原文；超时终止没有错误内容时显示状态说明', async () => {
    const adapter = buildMediaAdapter({
      kind: 'ark_videos',
      model: 'doubao-seedance-2-5-260628',
      apiKey: 'sk-ark',
      baseUrl: `${origin()}/api/v3`,
    })
    const req = { operation: 'text_to_video' as const, prompt: '雨夜', inputs: [], params: {} }
    for (const [body, message] of [
      [
        {
          status: 'failed',
          error: {
            code: 'OutputVideoSensitiveContentDetected',
            message: '生成的视频可能包含敏感信息',
          },
        },
        '远端任务失败：OutputVideoSensitiveContentDetected：生成的视频可能包含敏感信息',
      ],
      [{ status: 'expired', error: null }, '远端任务失败：任务超过过期时间未完成，已被终止'],
    ] as const) {
      submit = () => Response.json({ id: 'cgt-2' })
      polls = [() => Response.json(body)]
      const failed = await rejection(adapter.run(req, opts()))
      expect(failed.message).toBe(message)
      expect(failed.pendingTaskId).toBeUndefined()
    }
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

  test('Omni 的文生与首尾帧均使用 Omni 端点，允许首帧与参考图组合', async () => {
    const spec = lookupMediaModel('kling-3.0-omni', 'kling_videos')
    for (const inputs of [
      [],
      [
        { role: 'first_frame' as const, bytes: PNG, mime: 'image/png', path: '/w/a.png' },
        { role: 'last_frame' as const, bytes: PNG, mime: 'image/png', path: '/w/b.png' },
      ],
    ]) {
      seen = []
      submit = () => Response.json({ code: 0, data: { id: 'omni' } })
      polls = [succeeded('omni')]
      const operation = inputs.length ? 'first_last_frame' : 'text_to_video'
      expect(
        validateMediaCall(
          spec,
          operation,
          {},
          {
            images: 0,
            videos: 0,
            firstFrames: inputs.length ? 1 : 0,
            lastFrames: inputs.length ? 1 : 0,
          },
        ),
      ).toEqual([])
      await adapter('kling-3.0-omni').run({ operation, prompt: '动作', inputs, params: {} }, opts())
      expect(seen[0]?.path).toBe('/omni-video/kling-3.0-omni')
      expect(seen[0]?.json?.contents).toHaveLength(inputs.length + 1)
      expect(seen[0]?.json).not.toHaveProperty('prompt')
    }
    expect(
      validateMediaCall(spec, 'reference_to_video', {}, { images: 1, videos: 0, firstFrames: 1 }),
    ).toEqual([])
  })

  test('文生视频只发送 prompt 与 settings，按任务号查询，取 outputs 中的视频', async () => {
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

  /** 金额取自余额扣费的条目；资源包扣费的条目只有单位数，没有金额。 */
  test('计量取视频时长与 billing 中的实际扣费金额', async () => {
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

  test('首尾帧使用 image-to-video，文字与图片放入 contents，图片为不带前缀的 base64', async () => {
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

  test('参考图使用 omni-video；远端失败是终态；提交被拒时带接口原文', async () => {
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
    expect(failed.message).toBe('远端任务失败：内容不合规')
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
  test('Seedance 2.0 Fast 的清晰度与时长按其自身的参数表校验', () => {
    const spec = lookupMediaModel('doubao-seedance-2-0-fast-260128', 'ark_videos')
    const none = { images: 0, videos: 0 }
    expect(validateMediaCall(spec, 'text_to_video', { resolution: '1080p' }, none)).toHaveLength(1)
    expect(validateMediaCall(spec, 'text_to_video', { duration: 20 }, none)).toHaveLength(1)
    expect(
      validateMediaCall(spec, 'text_to_video', { resolution: '720p', duration: 15 }, none),
    ).toEqual([])
  })

  test('添加视频模型时按接口地址确定协议', () => {
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
  test('Seedance 参数和素材放入 metadata，下载内容时携带 key', async () => {
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
        params: { duration: 5, ratio: '9:16', resolution: '720p' },
      },
      opts(),
    )
    const post = seen.find((s) => s.method === 'POST')!
    expect(post.path).toBe('/v1/videos')
    expect(post.json).toEqual({
      model: 'doubao-seedance-2-5-260628',
      prompt: '海浪',
      metadata: {
        duration: 5,
        ratio: '9:16',
        resolution: '720p',
        content: [{ type: 'text', text: '海浪' }],
      },
    })
    const content = seen.find((s) => s.path === '/v1/videos/video_1/content')
    expect(content?.headers.authorization).toBe('Bearer sk-relay')
    expect(out.files[0]?.bytes).toEqual(MP4)
  })

  test('经中转站调用 Seedance 时保留已核实的素材能力，未知型号只提供通用参数', () => {
    const spec = lookupMediaModel('doubao-seedance-2-5-260628', 'openai_videos')
    expect(spec.operations).toContain('reference_to_video')
    expect(spec.inputs).toMatchObject({ maxImages: 30, maxVideos: 10, maxAudios: 10 })
    expect(spec.params.map((p) => p.name)).toContain('omni_reference_task_type')
    const unknown = lookupMediaModel('custom-video', 'openai_videos')
    expect(unknown.operations).toEqual(['text_to_video'])
    expect(unknown.params.map((p) => p.name)).toEqual(['seconds', 'size'])
  })
})

describe('撤销任务', () => {
  const dashscope = () =>
    buildMediaAdapter({
      kind: 'dashscope_videos',
      model: 'wan3.0-video',
      apiKey: 'sk-ds',
      baseUrl: `${origin()}/compatible-mode/v1`,
    })
  const ark = () =>
    buildMediaAdapter({
      kind: 'ark_videos',
      model: 'doubao-seedance-2-5-260628',
      apiKey: 'sk-ark',
      baseUrl: `${origin()}/api/v3`,
    })
  const signal = new AbortController().signal
  const status = (task_status: string) => () => Response.json({ output: { task_status } })
  const refused = () =>
    Response.json(
      {
        code: 'UnsupportedOperation',
        message: 'Failed to cancel the task, please confirm if the task is in PENDING status.',
      },
      { status: 400 },
    )

  test('百炼：排队中可撤销；已开始时撤销被拒，查询确认已不在排队中则返回 started；仍在排队中说明拒绝另有原因，原样抛出', async () => {
    submit = () => Response.json({ request_id: 'r1' })
    expect(await dashscope().cancel!('t-1', signal)).toBe('cancelled')
    const post = seen.find((x) => x.method === 'POST')!
    expect(post.path).toBe('/api/v1/tasks/t-1/cancel')
    expect(post.headers.authorization).toBe('Bearer sk-ds')

    submit = refused
    polls = [status('RUNNING')]
    expect(await dashscope().cancel!('t-2', signal)).toBe('started')
    polls = [status('PENDING')]
    expect((await rejection(dashscope().cancel!('t-3', signal))).status).toBe(400)
  })

  test('方舟：先查询状态，仅在排队中时删除；运行中或已结束时不发送删除请求（对已结束的任务，删除操作会删除其记录）', async () => {
    polls = [() => Response.json({ status: 'queued' })]
    expect(await ark().cancel!('cgt-1', signal)).toBe('cancelled')
    const del = seen.find((x) => x.method === 'DELETE')!
    expect(del.path).toBe('/api/v3/contents/generations/tasks/cgt-1')

    for (const state of ['running', 'succeeded']) {
      seen = []
      polls = [
        () => Response.json({ status: state, content: { video_url: `${origin()}/files/out.mp4` } }),
      ]
      expect(await ark().cancel!('cgt-2', signal)).toBe('started')
      expect(seen.some((x) => x.method === 'DELETE')).toBe(false)
    }
  })

  test('方舟：任务在查询与删除之间开始，删除被拒后再次查询确认不在排队，返回 started', async () => {
    polls = [() => Response.json({ status: 'queued' }), () => Response.json({ status: 'running' })]
    remove = () => Response.json({ error: { code: 'InvalidParameter' } }, { status: 400 })
    expect(await ark().cancel!('cgt-3', signal)).toBe('started')
    remove = () => Response.json({})
  })

  test('其余视频接口不支持撤销：可灵、Veo、Sora、Grok 的适配器没有 cancel', () => {
    for (const [kind, model] of [
      ['kling_videos', 'kling-v3'],
      ['openai_videos', 'sora-2'],
    ] as const) {
      expect(buildMediaAdapter({ kind, model, apiKey: 'k' }).cancel).toBeUndefined()
    }
  })
})

describe('排队中与生成中', () => {
  test('各厂商的进行中状态词归并为两个阶段，无法识别的返回 null', () => {
    for (const s of ['PENDING', 'queued', 'pending', 'submitted'])
      expect(taskPhase(s)).toBe('queued')
    for (const s of ['RUNNING', 'running', 'in_progress', 'processing'])
      expect(taskPhase(s)).toBe('running')
    expect(taskPhase('SUCCEEDED')).toBeNull()
  })
})
