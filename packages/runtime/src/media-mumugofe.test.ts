/** Mumugofe 从已配置模型、参数校验到实际 HTTP 请求与任务恢复的回归测试。 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { MediaCall } from '@qywork/agent'
import {
  findMediaModel,
  lookupMediaModel,
  mediaCatalog,
  mediaKindsOf,
  quoteMedia,
} from '@qywork/ai'
import type { MediaInputRole, MediaSpend } from '@qywork/core'
import { listMediaModels, type QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'
import { buildTailNotes } from './prompt.ts'

const REMOVED_FULL = '满血sd2.5(30-10-10原生过人脸/720P)'
const REMOVED_VIDEO_30S = 'video-sd25-30s'
const REMOVED_006 = '006系列/sd2.5(满血30-10-10原生过人脸720P15秒/480P30秒)'
const SERIES_006_720 = '006系列/sd2.5(满血30-10-10原生过人脸720P15秒)'
const SERIES_006_480 = '006系列/sd2.5(满血30-10-10原生过人脸/5-30秒/480P)'
const MODEL = 'seedance2.5-V'
const SERIES_007 = '007系列/sd2.5(30图10音/4-30秒/720P)'
const SERIES_X = 'X-SD25-301010'
const HIGH_QUALITY = '高质量sd2.5/(全参原生过真人速度快720P)'
const REMOVED_UPSCALED = '全能sd2.5(满血内置过脸30图超分1080P)'
const REMOVED_FULL_REFERENCE = 'sd-25-30/10/1-1'
const EXCLUSIVE = '专享sd2.5(30图10音/4-30秒/720p)'
const FULL_PARAMS = '高质量sd2.5(满血全参/720P/按次)'
const PROMPT = '雨后咖啡馆，一位成年女性坐下阅读。\n镜头缓慢后退，人物望向窗外微笑。'
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])
const TASK = 'task_mumugofe_test'
/** 2026-10-10 实测任务接口的拒绝原因原文；同一任务的 `/videos/{id}` 只返回通用失败信息。 */
const REJECTED =
  "版权保护拒绝（画面）：换掉参考素材或改提示词再试（跟时长无关）\n上游原话：For copyright protection, I can't show you the generated video. Use other references or edit the prompt and try again."
interface Seen {
  method: string
  path: string
  auth: string | null
  contentType: string | null
  uploadHeader: string | null
  body?: unknown
}
let server: ReturnType<typeof Bun.serve>
let seen: Seen[]
let status: 'completed' | 'failed'
let contentStatus: number
let taskStatuses: string[]
let resultUrl: unknown
interface UploadedAsset {
  asset: { id: string; sha256: string; bytes: number }
  url: string
}
let uploadResponse: ((body: UploadedAsset) => unknown) | undefined
let uploadStatus: number

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      seen.push({
        method: req.method,
        path,
        auth: req.headers.get('authorization'),
        contentType: req.headers.get('content-type'),
        uploadHeader: req.headers.get('x-upload-secret'),
        ...(req.method === 'POST' ? { body: await req.json() } : {}),
        ...(req.method === 'PUT' ? { body: new Uint8Array(await req.arrayBuffer()) } : {}),
      })
      if (req.method === 'PUT' && path.startsWith('/v1/studio/assets/')) {
        const bytes = seen.at(-1)!.body as Uint8Array
        const digest = createHash('sha256').update(bytes).digest('hex')
        expect(path).toBe(`/v1/studio/assets/${digest}`)
        const id = `studioasset_${'a'.repeat(64)}_${digest}`
        const body = {
          asset: { id, sha256: digest, bytes: bytes.length },
          url: `http://127.0.0.1:${server.port}/v1/studio/assets/${id}/artifacts/source/content?signature=test`,
        }
        return Response.json(uploadResponse ? uploadResponse(body) : body, { status: uploadStatus })
      }
      if (req.method === 'POST' && path === '/v1/videos')
        return Response.json({ id: TASK, status: 'queued', object: 'video' })
      if (req.method === 'GET' && path === `/v1/videos/${TASK}`)
        return Response.json({
          id: TASK,
          object: 'video',
          model: MODEL,
          status,
          ...(status === 'failed'
            ? {
                error: {
                  message: 'The video generation task failed.',
                  code: 'video_generation_failed',
                },
              }
            : {}),
          // 实测终态没有 seconds、usage 或扣费金额，不能用请求值伪造计量。
        })
      if (req.method === 'GET' && path === `/v1/video/generations/${TASK}`)
        return Response.json({
          code: 'success',
          message: '',
          data: {
            task_id: TASK,
            status: taskStatuses.shift() ?? (status === 'completed' ? 'SUCCESS' : 'FAILURE'),
            fail_reason: status === 'failed' ? REJECTED : '',
            progress: '100%',
            result_url: `http://127.0.0.1:${server.port}/v1/videos/${TASK}/content`,
            data: { download_url: resultUrl },
          },
        })
      if (req.method === 'GET' && path === `/generated/${TASK}.mp4`)
        return new Response(contentStatus === 200 ? MP4 : 'forbidden', {
          status: contentStatus,
          headers: { 'content-type': 'video/mp4' },
        })
      return new Response('unexpected route', { status: 400 })
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  seen = []
  status = 'completed'
  contentStatus = 200
  taskStatuses = []
  uploadResponse = undefined
  uploadStatus = 200
  resultUrl = `http://127.0.0.1:${server.port}/generated/${TASK}.mp4`
})

const config = (model = MODEL): QyConfig => ({
  providers: {
    mumugofe: {
      kind: 'openai_chat_completions',
      apiKey: 'test-only-key',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: {},
      media: { [model]: { kind: 'openai_videos' } },
    },
  },
  mediaDefaults: { video: { provider: 'mumugofe', model } },
})
const call = (over: Partial<MediaCall> = {}): MediaCall => ({
  type: 'video',
  prompt: PROMPT,
  inputs: [],
  params: {},
  ...over,
})
const signal = () => new AbortController().signal

test('渠道型号在模型库和 Agent 参数表中使用自己的协议与能力', () => {
  const spec = findMediaModel(MODEL)!
  expect(spec.vendor).toBe('Mumugofe')
  expect(spec.catalogued).toBe(true)
  expect(mediaKindsOf(spec)).toEqual(['openai_videos'])
  expect(spec.operations).toEqual(['text_to_video', 'reference_to_video'])
  expect(spec.inputs.maxImages).toBe(30)
  expect(spec.inputs.publicUrls).toBe(true)
  expect(spec.inputs.maxVideos).toBe(0)
  expect(spec.inputs.maxAudios).toBe(0)
  expect(quoteMedia(spec, {}, { images: 0, videos: 0 })).toEqual({ cost: 7.5, currency: 'CNY' })
  expect(lookupMediaModel(MODEL, 'ark_videos').catalogued).toBe(false)
  const text = buildTailNotes({
    workspaceRoot: '/w',
    platform: 'win32',
    mode: 'auto',
    mediaModels: listMediaModels(config()),
  })
    .map((n) => n.content)
    .join('\n')
  expect(text).toContain(MODEL)
  expect(text).toContain('5–30 秒整数，使用字符串')
  expect(text).toContain('1280x720')
  expect(text).toContain('720x1280')
  expect(text).not.toContain('参考视频最多')
  expect(text).not.toContain('参考音频最多')
  expect(text).not.toContain('temperature')
  expect(text).not.toContain('generate_audio')
})

test.each([{}, { seconds: '5', size: '1280x720' }])(
  '默认值和显式参数均提交实测请求，保存任务后鉴权查询下载：%j',
  async (params) => {
    const spends: MediaSpend[] = []
    const port = makeMediaPort(config(), (spend) => spends.push(spend))
    const tasks: unknown[] = []
    const result = await port.generate(
      call({
        params,
        onTask: async (task) => {
          expect(seen.map((s) => s.method)).toEqual(['POST'])
          tasks.push(task)
        },
      }),
      signal(),
    )
    expect(result).toMatchObject({
      ok: true,
      provider: 'mumugofe',
      model: MODEL,
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    expect(tasks).toEqual([{ taskId: TASK, provider: 'mumugofe', model: MODEL }])
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /v1/videos',
      `GET /v1/video/generations/${TASK}`,
      `GET /generated/${TASK}.mp4`,
    ])
    expect(seen.every((s) => s.auth === 'Bearer test-only-key')).toBe(true)
    expect(seen[0]?.contentType).toContain('application/json')
    expect(seen[0]?.body).toEqual({
      model: MODEL,
      prompt: PROMPT,
      seconds: '5',
      size: '1280x720',
    })
    expect(spends).toHaveLength(1)
    expect(spends[0]).toMatchObject({ quantity: null, cost: 7.5 })
  },
)

test.each([
  { seconds: '4' },
  { seconds: '31' },
  { seconds: '5.5' },
  { size: '854x480' },
  { seconds: 30 },
  { size: '1920x1080' },
  { temperature: 0.7 },
  { duration: 30 },
  { generate_audio: true },
])('未适配的参数在发送前被拒绝：%j', async (params) => {
  expect(await makeMediaPort(config()).generate(call({ params }), signal())).toMatchObject({
    ok: false,
    executed: false,
  })
  expect(seen).toEqual([])
})

test.each<MediaInputRole>(['video', 'audio', 'first_frame', 'last_frame'])(
  '未完成适配的素材不能被静默丢弃：%s',
  async (role) => {
    const result = await makeMediaPort(config()).generate(
      call({ inputs: [{ role, bytes: MP4, mime: 'video/mp4', path: '/reference.mp4' }] }),
      signal(),
    )
    expect(result).toMatchObject({ ok: false, executed: false })
    expect(seen).toEqual([])
  },
)

test.each([MODEL, SERIES_X])(
  '参考图直接上传到 mumu，原图字节、凭证和输入顺序保持一致：%s',
  async (model) => {
    const inputs = [PNG, new Uint8Array([...PNG, 2])].map((bytes, i) => ({
      role: 'reference' as const,
      bytes,
      mime: 'image/png',
      path: `/reference-${i}.png`,
    }))
    const result = await makeMediaPort(config(model)).generate(
      call({
        inputs,
        params: { seconds: '30' },
        onSubmit: () => {
          expect(seen.map((entry) => entry.method)).toEqual(['PUT', 'PUT'])
        },
      }),
      signal(),
    )
    expect(result).toMatchObject({ ok: true, files: [{ bytes: MP4 }] })
    expect(seen.slice(0, 2).map((entry) => entry.body)).toEqual(inputs.map((input) => input.bytes))
    expect(seen.slice(0, 2).every((entry) => entry.contentType === 'image/png')).toBe(true)
    expect(seen[2]?.body).toEqual({
      model,
      prompt: PROMPT,
      seconds: '30',
      size: '1280x720',
      images: inputs.map((input) => {
        const digest = createHash('sha256').update(input.bytes).digest('hex')
        return `http://127.0.0.1:${server.port}/v1/studio/assets/studioasset_${'a'.repeat(64)}_${digest}/artifacts/source/content?signature=test`
      }),
    })
    expect(seen.every((entry) => entry.auth === 'Bearer test-only-key')).toBe(true)
  },
)

test.each([
  'http',
  'missing',
  'hash',
  'bytes',
  'id',
  'origin',
  'credentials',
  'path',
  'signature',
  'fragment',
])('原生上传失败或回执无效时不提交生成：%s', async (fault) => {
  if (fault === 'http') uploadStatus = 403
  uploadResponse = (body) => {
    if (fault === 'missing') return {}
    if (fault === 'hash') body.asset.sha256 = 'b'.repeat(64)
    if (fault === 'bytes') body.asset.bytes += 1
    if (fault === 'id') body.asset.id = 'unexpected'
    const url = new URL(body.url)
    if (fault === 'origin') url.hostname = 'assets.test'
    if (fault === 'credentials') url.username = 'unexpected'
    if (fault === 'path') url.pathname = '/unexpected'
    if (fault === 'signature') url.search = ''
    if (fault === 'fragment') url.hash = '#unexpected'
    body.url = url.href
    return body
  }
  const result = await makeMediaPort(config()).generate(
    call({
      inputs: [{ role: 'reference', bytes: PNG, mime: 'image/png', path: '/ref.png' }],
    }),
    signal(),
  )
  expect(result).toMatchObject({ ok: false, diagnostic: { stage: 'upload' } })
  expect(result).not.toHaveProperty('pendingTaskId')
  expect(seen.map((entry) => entry.method)).toEqual(['PUT'])
})

test('已有任务恢复不重新上传原图，只查询和下载', async () => {
  const inputs = [{ role: 'reference' as const, bytes: PNG, mime: 'image/png', path: '/ref.png' }]
  expect(
    await makeMediaPort(config()).generate(call({ inputs, resumeTaskId: TASK }), signal()),
  ).toMatchObject({ ok: true })
  expect(seen.every((entry) => entry.method === 'GET')).toBe(true)
})

test('参考图超过三十张时在上传前拒绝', async () => {
  const result = await makeMediaPort(config()).generate(
    call({
      inputs: Array.from({ length: 31 }, () => ({
        role: 'reference' as const,
        bytes: PNG,
        mime: 'image/png',
        path: '/ref.png',
      })),
    }),
    signal(),
  )
  expect(result).toMatchObject({ ok: false, executed: false })
  expect(seen).toEqual([])
})

test('下载失败保留任务号，恢复只查询下载，不重复提交', async () => {
  contentStatus = 403
  const port = makeMediaPort(config())
  expect(await port.generate(call(), signal())).toMatchObject({
    ok: false,
    pendingTaskId: TASK,
  })
  seen = []
  contentStatus = 200
  expect(await port.generate(call({ resumeTaskId: TASK }), signal())).toMatchObject({ ok: true })
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    `GET /v1/video/generations/${TASK}`,
    `GET /generated/${TASK}.mp4`,
  ])
})

test('成片直链跨源下载不携带接口凭证，恢复不经过内容转发端点', async () => {
  let headers: Headers | undefined
  const asset = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      headers = req.headers
      return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
    },
  })
  try {
    resultUrl = `http://127.0.0.1:${asset.port}/result.mp4`
    const cfg = config()
    cfg.providers.mumugofe!.headers = { 'x-provider-key': 'private-header' }
    const result = await makeMediaPort(cfg).generate(call({ resumeTaskId: TASK }), signal())
    expect(result).toMatchObject({ ok: true, files: [{ bytes: MP4, mime: 'video/mp4' }] })
    expect(headers?.get('authorization')).toBeNull()
    expect(headers?.get('x-provider-key')).toBeNull()
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/video/generations/${TASK}`])
    expect(seen[0]?.auth).toBe('Bearer test-only-key')
  } finally {
    asset.stop(true)
  }
})

test.each([
  undefined,
  '',
  'invalid-url',
  'file:///result.mp4',
  'https://user:secret@media.test/v.mp4',
])('成功回执缺少有效成片直链时保留任务，不重新提交：%s', async (url) => {
  resultUrl = url
  const result = await makeMediaPort(config()).generate(call({ resumeTaskId: TASK }), signal())
  expect(result).toMatchObject({ ok: false, pendingTaskId: TASK })
  if (result.ok) throw new Error('expected failure')
  expect(result.message).toContain('任务成功但未返回有效成片地址')
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /v1/video/generations/${TASK}`])
})

test('远端明确失败时返回任务接口中的拒绝原因，不下载或重新生成', async () => {
  status = 'failed'
  const result = await makeMediaPort(config()).generate(call(), signal())
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected failure')
  expect(result.message).toContain(`远端任务失败：${REJECTED}`)
  expect(result.pendingTaskId).toBeUndefined()
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    'POST /v1/videos',
    `GET /v1/video/generations/${TASK}`,
  ])
})

test('007 按次型号提供独立的参考素材规格、参数与报价', () => {
  const spec = findMediaModel(SERIES_007)!
  expect(spec).toMatchObject({
    catalogued: true,
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video'],
    inputs: { maxImages: 30, maxVideos: 0, maxAudios: 10, transport: 'json' },
  })
  expect(spec.inputs.publicUrls).toBeUndefined()
  expect(mediaKindsOf(spec)).toEqual(['openai_videos'])
  const text = buildTailNotes({
    workspaceRoot: '/w',
    platform: 'win32',
    mode: 'auto',
    mediaModels: listMediaModels(config(SERIES_007)),
  })
    .map((n) => n.content)
    .join('\n')
  expect(text).toContain('参考图最多 30 张')
  expect(text).toContain('参考音频最多 10 段')
  expect(text).toContain('4–30 秒整数，使用字符串')
  expect(text).not.toContain('参考视频最多')
  for (const seconds of ['4', '17', '30']) {
    expect(quoteMedia(spec, { seconds }, { images: 30, videos: 0 })).toEqual({
      cost: 6,
      currency: 'CNY',
    })
  }
})

test.each([undefined, '4', '17', '30'])(
  '007 按次发送原始编号、字符串时长、图片和 MP3，成功后只计一次费用：%s',
  async (seconds) => {
    const spends: MediaSpend[] = []
    const result = await makeMediaPort(config(SERIES_007), (s) => spends.push(s)).generate(
      call({
        params: seconds === undefined ? {} : { seconds, size: '720x1280' },
        inputs: [
          { role: 'reference', bytes: PNG, mime: 'image/png', path: '/image.png' },
          { role: 'audio', bytes: MP3, mime: 'audio/mp3', path: '/voice.mp3' },
        ],
      }),
      signal(),
    )
    expect(result).toMatchObject({ ok: true, model: SERIES_007 })
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      'POST /v1/videos',
      `GET /v1/video/generations/${TASK}`,
      `GET /generated/${TASK}.mp4`,
    ])
    expect(seen[0]?.body).toEqual({
      model: SERIES_007,
      prompt: PROMPT,
      seconds: seconds ?? '5',
      size: seconds === undefined ? '1280x720' : '720x1280',
      images: [`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`],
      audios: [`data:audio/mpeg;base64,${Buffer.from(MP3).toString('base64')}`],
    })
    expect(spends).toHaveLength(1)
    expect(spends[0]).toMatchObject({ quantity: null, cost: 6, currency: 'CNY' })
  },
)

test.each([
  { seconds: '3' },
  { seconds: '31' },
  { seconds: '4.5' },
  { seconds: 4 },
  { size: '854x480' },
  { size: '1920x1080' },
])('007 按次在发送前拒绝无效时长或尺寸：%j', async (params) => {
  expect(
    await makeMediaPort(config(SERIES_007)).generate(call({ params }), signal()),
  ).toMatchObject({ ok: false, executed: false })
  expect(seen).toEqual([])
})

test('下架专享版保留旧配置的时长与音频规格', () => {
  const spec = lookupMediaModel(EXCLUSIVE, 'openai_videos')
  expect(spec).toMatchObject({
    vendor: 'Mumugofe',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video'],
    inputs: { maxImages: 30, maxVideos: 0, maxAudios: 10 },
  })
  expect(spec.price).toBeUndefined()
  expect(mediaKindsOf(spec)).toEqual(['openai_videos'])
  const text = buildTailNotes({
    workspaceRoot: '/w',
    platform: 'win32',
    mode: 'auto',
    mediaModels: listMediaModels(config(EXCLUSIVE)),
  })
    .map((n) => n.content)
    .join('\n')
  expect(text).toContain('参考音频最多 10 段')
  expect(text).toContain('4–30 秒整数，使用字符串')
  expect(findMediaModel(MODEL)!.inputs.maxAudios).toBe(0)
})

test.each([undefined, '4', '17', '30'])(
  '专享版默认 5 秒和 4–30 秒边界原样发送字符串：%s',
  async (seconds) => {
    const params = seconds === undefined ? {} : { seconds, size: '720x1280' }
    const spends: MediaSpend[] = []
    const result = await makeMediaPort(config(EXCLUSIVE), (s) => spends.push(s)).generate(
      call({ params }),
      signal(),
    )
    expect(result).toMatchObject({ ok: true, model: EXCLUSIVE })
    expect(seen[0]?.body).toEqual({
      model: EXCLUSIVE,
      prompt: PROMPT,
      seconds: seconds ?? '5',
      size: seconds === undefined ? '1280x720' : '720x1280',
    })
    expect(spends[0]).toMatchObject({ quantity: null, cost: 0 })
  },
)

test('图片和 MP3 交错输入时按类别保持顺序，音频别名统一成 audio/mpeg', async () => {
  const inputs = [
    { role: 'audio' as const, bytes: MP3, mime: 'audio/mp3', path: '/voice-1.mp3' },
    { role: 'reference' as const, bytes: PNG, mime: 'image/png', path: '/image-1.png' },
    {
      role: 'audio' as const,
      bytes: new Uint8Array([...MP3, 2]),
      mime: 'audio/mpeg',
      path: '/voice-2.mp3',
    },
    {
      role: 'reference' as const,
      bytes: new Uint8Array([...PNG, 2]),
      mime: 'image/png',
      path: '/image-2.png',
    },
  ]
  expect(await makeMediaPort(config(EXCLUSIVE)).generate(call({ inputs }), signal())).toMatchObject(
    {
      ok: true,
    },
  )
  expect(seen[0]?.body).toEqual({
    model: EXCLUSIVE,
    prompt: PROMPT,
    seconds: '5',
    size: '1280x720',
    images: [inputs[1], inputs[3]].map(
      (i) => `data:image/png;base64,${Buffer.from(i!.bytes).toString('base64')}`,
    ),
    audios: [inputs[0], inputs[2]].map(
      (i) => `data:audio/mpeg;base64,${Buffer.from(i!.bytes).toString('base64')}`,
    ),
  })
})

test.each([EXCLUSIVE])('%s 允许单独音频参考，最多 10 段，不伪造 images 字段', async (model) => {
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    role: 'audio' as const,
    bytes: new Uint8Array([...MP3, i]),
    mime: 'audio/mpeg',
    path: `/voice-${i}.mp3`,
  }))
  expect(await makeMediaPort(config(model)).generate(call({ inputs }), signal())).toMatchObject({
    ok: true,
  })
  expect(seen[0]?.body).toEqual({
    model,
    prompt: PROMPT,
    seconds: '5',
    size: '1280x720',
    audios: inputs.map((i) => `data:audio/mpeg;base64,${Buffer.from(i.bytes).toString('base64')}`),
  })
})

test.each([
  ['reference', 31],
  ['audio', 11],
] as const)('专享版素材数量越界时不提交：%s=%i', async (role, count) => {
  const inputs = Array.from({ length: count }, () => ({
    role,
    bytes: role === 'audio' ? MP3 : PNG,
    mime: role === 'audio' ? 'audio/mpeg' : 'image/png',
    path: '/reference',
  }))
  expect(await makeMediaPort(config(EXCLUSIVE)).generate(call({ inputs }), signal())).toMatchObject(
    {
      ok: false,
      executed: false,
    },
  )
  expect(seen).toEqual([])
})

test.each([
  { seconds: '3' },
  { seconds: '31' },
  { seconds: '4.5' },
  { seconds: 4 },
  { size: '1920x1080' },
  { face: true },
  { fps: 60 },
  { temperature: 0.7 },
])('专享版拒绝越界时长和未开放字段：%j', async (params) => {
  expect(await makeMediaPort(config(EXCLUSIVE)).generate(call({ params }), signal())).toMatchObject(
    {
      ok: false,
      executed: false,
    },
  )
  expect(seen).toEqual([])
})

test.each<MediaInputRole>(['first_frame', 'last_frame', 'video'])(
  '专享版未声明的素材类型在提交前拒绝：%s',
  async (role) => {
    expect(
      await makeMediaPort(config(EXCLUSIVE)).generate(
        call({ inputs: [{ role, bytes: MP4, mime: 'video/mp4', path: '/ref.mp4' }] }),
        signal(),
      ),
    ).toMatchObject({ ok: false, executed: false })
    expect(seen).toEqual([])
  },
)

test.each(['audio/wav', 'audio/mp4', 'audio/mpeg'])(
  '专享版拒绝非 MP3 内容，不因 MIME 标签而改写格式：%s',
  async (mime) => {
    const result = await makeMediaPort(config(EXCLUSIVE)).generate(
      call({ inputs: [{ role: 'audio', bytes: MP4, mime, path: '/voice.mp3' }] }),
      signal(),
    )
    expect(result).toMatchObject({ ok: false })
    if (result.ok) throw new Error('expected failure')
    expect(result.message).toContain('仅支持 MP3')
    expect(result.message).toContain('未提交生成')
    expect(seen).toEqual([])
  },
)

test('下架高质量版保留旧配置的图、视频、音频规格', () => {
  const spec = lookupMediaModel(FULL_PARAMS, 'openai_videos')
  expect(spec).toMatchObject({
    vendor: 'Mumugofe',
    videoFormat: 'mumugofe',
    operations: ['text_to_video', 'reference_to_video', 'video_to_video'],
    inputs: { maxImages: 30, maxVideos: 10, maxAudios: 10 },
  })
  expect(spec.price).toBeUndefined()
  expect(mediaKindsOf(spec)).toEqual(['openai_videos'])
  const text = buildTailNotes({
    workspaceRoot: '/w',
    platform: 'win32',
    mode: 'auto',
    mediaModels: listMediaModels(config(FULL_PARAMS)),
  })
    .map((n) => n.content)
    .join('\n')
  expect(text).toContain('参考图最多 30 张')
  expect(text).toContain('参考视频最多 10 个')
  expect(text).toContain('参考音频最多 10 段')
  expect(lookupMediaModel(EXCLUSIVE, 'openai_videos').inputs.maxVideos).toBe(0)
  expect(spec.params.find((p) => p.name === 'seconds')?.values).toEqual(['30'])
})

test.each([undefined, '30'])('满血全参版按实际接口固定 30 秒，保持字符串：%s', async (seconds) => {
  const result = await makeMediaPort(config(FULL_PARAMS)).generate(
    call({ params: seconds === undefined ? {} : { seconds, size: '720x1280' } }),
    signal(),
  )
  expect(result).toMatchObject({ ok: true, model: FULL_PARAMS })
  expect(seen[0]?.body).toEqual({
    model: FULL_PARAMS,
    prompt: PROMPT,
    seconds: seconds ?? '30',
    size: seconds === undefined ? '1280x720' : '720x1280',
  })
})

const fullInput = (role: 'reference' | 'video' | 'audio', i = 0) => ({
  role,
  bytes: new Uint8Array([...(role === 'reference' ? PNG : role === 'video' ? MP4 : MP3), i]),
  mime: role === 'reference' ? 'image/png' : role === 'video' ? 'video/mp4' : 'audio/mpeg',
  path: `/reference-${role}-${i}`,
})

test('007 按次支持 30 图 10 音频，在发送前拒绝超限素材与参考视频', async () => {
  const port = makeMediaPort(config(SERIES_007))
  for (const inputs of [
    Array.from({ length: 31 }, (_, i) => fullInput('reference', i)),
    Array.from({ length: 11 }, (_, i) => fullInput('audio', i)),
    [fullInput('video')],
  ]) {
    expect(await port.generate(call({ inputs }), signal())).toMatchObject({
      ok: false,
      executed: false,
    })
    expect(seen).toEqual([])
  }
  const inputs = [
    ...Array.from({ length: 30 }, (_, i) => fullInput('reference', i)),
    ...Array.from({ length: 10 }, (_, i) => fullInput('audio', i)),
  ]
  expect(await port.generate(call({ inputs }), signal())).toMatchObject({ ok: true })
  const body = seen[0]?.body as Record<string, unknown>
  expect(body.images).toHaveLength(30)
  expect(body.audios).toHaveLength(10)
  expect(body.videos).toBeUndefined()
})

test('模型库收录当前型号，下架型号保留旧任务取回规格', () => {
  expect(
    mediaCatalog()
      .filter((m) => m.vendor === 'Mumugofe')
      .map((m) => m.id),
  ).toEqual([MODEL, SERIES_007, SERIES_X])
  for (const id of [SERIES_006_720, SERIES_006_480]) {
    expect(findMediaModel(id)).toBeUndefined()
    expect(lookupMediaModel(id, 'openai_videos').videoFormat).toBeUndefined()
  }
  expect(findMediaModel(REMOVED_FULL)).toBeUndefined()
  expect(lookupMediaModel(REMOVED_FULL, 'openai_videos').videoFormat).toBeUndefined()
  expect(findMediaModel(REMOVED_006)).toBeUndefined()
  expect(findMediaModel(REMOVED_FULL_REFERENCE)).toBeUndefined()
  expect(lookupMediaModel(REMOVED_FULL_REFERENCE, 'openai_videos').videoFormat).toBeUndefined()
  expect(findMediaModel(REMOVED_VIDEO_30S)).toBeUndefined()
  expect(findMediaModel(REMOVED_UPSCALED)).toBeUndefined()
  expect(lookupMediaModel(REMOVED_UPSCALED, 'openai_videos').videoFormat).toBeUndefined()
  expect(findMediaModel(HIGH_QUALITY)).toBeUndefined()
  expect(lookupMediaModel(HIGH_QUALITY, 'openai_videos').videoFormat).toBeUndefined()
  for (const id of [EXCLUSIVE, FULL_PARAMS]) {
    expect(findMediaModel(id)).toBeUndefined()
    expect(lookupMediaModel(id, 'openai_videos')).toMatchObject({
      catalogued: false,
      videoFormat: 'mumugofe',
    })
    expect(lookupMediaModel(id, 'ark_videos').videoFormat).toBeUndefined()
  }
})

test.each([EXCLUSIVE, FULL_PARAMS, MODEL, SERIES_007, SERIES_X])(
  '当前与下架型号取回仅查询下载原任务：%s',
  async (model) => {
    expect(
      await makeMediaPort(config(model)).generate(call({ resumeTaskId: TASK }), signal()),
    ).toMatchObject({ ok: true, model })
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      `GET /v1/video/generations/${TASK}`,
      `GET /generated/${TASK}.mp4`,
    ])
  },
)

test.each([{}, { seconds: '30', size: '720x1280' }])(
  'X 型号发送固定 30 秒和横竖屏参数，按条计费：%j',
  async (params) => {
    const spends: MediaSpend[] = []
    expect(
      await makeMediaPort(config(SERIES_X), (spend) => spends.push(spend)).generate(
        call({ params }),
        signal(),
      ),
    ).toMatchObject({ ok: true, model: SERIES_X, files: [{ bytes: MP4 }] })
    expect(seen[0]?.body).toEqual({
      model: SERIES_X,
      prompt: PROMPT,
      seconds: '30',
      size: '1280x720',
      ...params,
    })
    expect(spends).toMatchObject([{ cost: 7, currency: 'CNY', quantity: null }])
  },
)

test.each([{ seconds: '5' }, { seconds: '29' }, { seconds: 30 }, { size: '1920x1080' }])(
  'X 型号不允许改变固定时长和清晰度：%j',
  async (params) => {
    expect(
      await makeMediaPort(config(SERIES_X)).generate(call({ params }), signal()),
    ).toMatchObject({ ok: false, executed: false })
    expect(seen).toEqual([])
  },
)

test('X 型号允许上传 30 张参考图，超限及尚未接通上传的素材在发送前拒绝', async () => {
  const port = makeMediaPort(config(SERIES_X))
  for (const inputs of [
    Array.from({ length: 31 }, (_, i) => fullInput('reference', i)),
    [fullInput('reference'), fullInput('video')],
    [fullInput('reference'), fullInput('audio')],
  ]) {
    expect(await port.generate(call({ inputs }), signal())).toMatchObject({
      ok: false,
      executed: false,
    })
    expect(seen).toEqual([])
  }
  const inputs = Array.from({ length: 30 }, (_, i) => fullInput('reference', i))
  expect(await port.generate(call({ inputs }), signal())).toMatchObject({ ok: true })
  expect(seen.filter((entry) => entry.method === 'PUT')).toHaveLength(30)
  const body = seen.find((entry) => entry.method === 'POST')!.body as Record<string, unknown>
  expect(body.images).toHaveLength(30)
  expect(body).toMatchObject({ model: SERIES_X, seconds: '30', size: '1280x720' })
  expect(body.videos).toBeUndefined()
  expect(body.audios).toBeUndefined()
})

test('X 型号原生上传被拒时不会提交收费的生成请求', async () => {
  uploadStatus = 400
  expect(
    await makeMediaPort(config(SERIES_X)).generate(
      call({ inputs: [fullInput('reference')] }),
      signal(),
    ),
  ).toMatchObject({ ok: false, diagnostic: { stage: 'upload' } })
  expect(seen.map((entry) => entry.method)).toEqual(['PUT'])
})

test.each(['5', '16', '30'])('seedance2.5-V 时长逐秒选择且按次报价：%s', async (seconds) => {
  const spec = findMediaModel(MODEL)!
  expect(spec.params.find((p) => p.name === 'seconds')?.values).toEqual(
    Array.from({ length: 26 }, (_, i) => String(i + 5)),
  )
  for (const size of ['1280x720', '720x1280']) {
    expect(quoteMedia(spec, { seconds, size }, { images: 0, videos: 0 })).toEqual({
      cost: 7.5,
      currency: 'CNY',
    })
    seen = []
    const spends: MediaSpend[] = []
    expect(
      await makeMediaPort(config(), (spend) => spends.push(spend)).generate(
        call({ params: { seconds, size } }),
        signal(),
      ),
    ).toMatchObject({ ok: true, model: MODEL })
    expect(seen[0]?.body).toEqual({ model: MODEL, prompt: PROMPT, seconds, size })
    expect(spends).toMatchObject([{ cost: 7.5, currency: 'CNY', quantity: null }])
  }
})

test('满血全参版混合素材分别进入 images、videos、audios 并保持各自顺序', async () => {
  const inputs = [
    fullInput('video', 1),
    fullInput('audio', 1),
    fullInput('reference', 1),
    fullInput('video', 2),
    fullInput('reference', 2),
    fullInput('audio', 2),
  ]
  expect(
    await makeMediaPort(config(FULL_PARAMS)).generate(call({ inputs }), signal()),
  ).toMatchObject({ ok: true })
  const field = (role: string) =>
    inputs
      .filter((i) => i.role === role)
      .map((i) => `data:${i.mime};base64,${Buffer.from(i.bytes).toString('base64')}`)
  expect(seen[0]?.body).toEqual({
    model: FULL_PARAMS,
    prompt: PROMPT,
    seconds: '30',
    size: '1280x720',
    images: field('reference'),
    videos: field('video'),
    audios: field('audio'),
  })
  expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
    'POST /v1/videos',
    `GET /v1/video/generations/${TASK}`,
    `GET /generated/${TASK}.mp4`,
  ])
})

test('满血全参版允许单独视频参考，图片和音频字段不伪造', async () => {
  const input = fullInput('video')
  expect(
    await makeMediaPort(config(FULL_PARAMS)).generate(call({ inputs: [input] }), signal()),
  ).toMatchObject({ ok: true })
  expect(seen[0]?.body).toEqual({
    model: FULL_PARAMS,
    prompt: PROMPT,
    seconds: '30',
    size: '1280x720',
    videos: [`data:video/mp4;base64,${Buffer.from(input.bytes).toString('base64')}`],
  })
})

test.each([
  [30, 10, 10, true],
  [31, 10, 10, false],
  [30, 11, 10, false],
  [30, 10, 11, false],
] as const)(
  '满血全参版各类素材独立校验数量：%i 图、%i 视频、%i 音频',
  async (images, videos, audios, ok) => {
    const inputs = [
      ...Array.from({ length: images }, (_, i) => fullInput('reference', i)),
      ...Array.from({ length: videos }, (_, i) => fullInput('video', i)),
      ...Array.from({ length: audios }, (_, i) => fullInput('audio', i)),
    ]
    expect(
      await makeMediaPort(config(FULL_PARAMS)).generate(call({ inputs }), signal()),
    ).toMatchObject(ok ? { ok: true } : { ok: false, executed: false })
    expect(seen.some((s) => s.method === 'POST')).toBe(ok)
  },
)

test.each([
  { seconds: '3' },
  { seconds: '31' },
  { seconds: '4.5' },
  { seconds: 10 },
  { seconds: '4' },
  { seconds: '10' },
  { seconds: '15' },
  { size: '1920x1080' },
  { face: true },
  { fps: 60 },
  { temperature: 0.7 },
])('满血全参版不把名称中的全参解释为任意参数：%j', async (params) => {
  expect(
    await makeMediaPort(config(FULL_PARAMS)).generate(call({ params }), signal()),
  ).toMatchObject({ ok: false, executed: false })
  expect(seen).toEqual([])
})

test('满血全参版非 MP3 音频与视频混用时仍在提交前拒绝', async () => {
  const result = await makeMediaPort(config(FULL_PARAMS)).generate(
    call({
      inputs: [
        fullInput('video'),
        { role: 'audio', bytes: MP4, mime: 'audio/mpeg', path: '/fake.mp3' },
      ],
    }),
    signal(),
  )
  expect(result).toMatchObject({ ok: false })
  if (result.ok) throw new Error('expected failure')
  expect(result.message).toContain('仅支持 MP3')
  expect(seen).toEqual([])
})

test.each([false, true])(
  'NOT_START 继续等待原任务，不提前进入待取回：resume=%s',
  async (resume) => {
    taskStatuses = ['NOT_START']
    const phases: string[] = []
    const result = await makeMediaPort(config(FULL_PARAMS)).generate(
      call({
        ...(resume ? { resumeTaskId: TASK } : {}),
        onStatus: (s) => phases.push(s),
      }),
      signal(),
    )
    expect(result).toMatchObject({ ok: true, model: FULL_PARAMS })
    expect(phases).toEqual(['queued'])
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(resume ? 0 : 1)
    expect(seen.filter((s) => s.path === `/v1/video/generations/${TASK}`)).toHaveLength(2)
    expect(seen.at(-1)?.path).toBe(`/generated/${TASK}.mp4`)
  },
  10000,
)
