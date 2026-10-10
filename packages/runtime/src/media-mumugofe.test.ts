/** Mumugofe 从已配置模型、参数校验到实际 HTTP 请求与任务恢复的回归测试。 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { MediaCall } from '@qywork/agent'
import { findMediaModel, lookupMediaModel, mediaKindsOf } from '@qywork/ai'
import type { MediaInputRole, MediaSpend } from '@qywork/core'
import { listMediaModels, type QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'
import { buildTailNotes } from './prompt.ts'

const MODEL = '满血sd2.5(30-10-10原生过人脸/720P)'
const EXCLUSIVE = '专享sd2.5(30图10音/4-30秒/720p)'
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
  body?: unknown
}
let server: ReturnType<typeof Bun.serve>
let seen: Seen[]
let status: 'completed' | 'failed'
let contentStatus: number

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
        ...(req.method === 'POST' ? { body: await req.json() } : {}),
      })
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
            status: status === 'completed' ? 'SUCCESS' : 'FAILURE',
            fail_reason: status === 'failed' ? REJECTED : '',
            progress: '100%',
          },
        })
      if (req.method === 'GET' && path === `/v1/videos/${TASK}/content`)
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
  expect(spec.price).toBeUndefined()
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
  expect(text).toContain('seconds：30')
  expect(text).toContain('1280x720')
  expect(text).toContain('720x1280')
  expect(text).not.toContain('temperature')
  expect(text).not.toContain('generate_audio')
})

test.each([{}, { seconds: '30', size: '1280x720' }])(
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
      `GET /v1/videos/${TASK}/content`,
    ])
    expect(seen.every((s) => s.auth === 'Bearer test-only-key')).toBe(true)
    expect(seen[0]?.contentType).toContain('application/json')
    expect(seen[0]?.body).toEqual({
      model: MODEL,
      prompt: PROMPT,
      seconds: '30',
      size: '1280x720',
    })
    expect(spends).toHaveLength(1)
    expect(spends[0]).toMatchObject({ quantity: null, cost: 0 })
  },
)

test.each([1, 30])('参考图原样按顺序进入 images，支持竖屏，张数=%i', async (count) => {
  const inputs = Array.from({ length: count }, (_, i) => ({
    role: 'reference' as const,
    bytes: new Uint8Array([...PNG, i]),
    mime: 'image/png',
    path: `/reference-${i}.png`,
  }))
  expect(
    await makeMediaPort(config()).generate(
      call({ inputs, params: { size: '720x1280' } }),
      signal(),
    ),
  ).toMatchObject({ ok: true })
  expect(seen[0]?.body).toEqual({
    model: MODEL,
    prompt: PROMPT,
    seconds: '30',
    size: '720x1280',
    images: inputs.map((i) => `data:image/png;base64,${Buffer.from(i.bytes).toString('base64')}`),
  })
})

test('超过渠道声明的 30 张参考图时在提交前拒绝', async () => {
  const inputs = Array.from({ length: 31 }, () => ({
    role: 'reference' as const,
    bytes: PNG,
    mime: 'image/png',
    path: '/reference.png',
  }))
  expect(await makeMediaPort(config()).generate(call({ inputs }), signal())).toMatchObject({
    ok: false,
    executed: false,
  })
  expect(seen).toEqual([])
})

test.each([
  { seconds: '10' },
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

test.each<MediaInputRole>(['first_frame', 'last_frame', 'video', 'audio'])(
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
    `GET /v1/videos/${TASK}/content`,
  ])
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

test('专享版独立登记能力，Agent 可见参考音频上限，不继承满血版固定时长', () => {
  const spec = findMediaModel(EXCLUSIVE)!
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

test('专享版允许单独音频参考，最多 10 段，不伪造 images 字段', async () => {
  const inputs = Array.from({ length: 10 }, (_, i) => ({
    role: 'audio' as const,
    bytes: new Uint8Array([...MP3, i]),
    mime: 'audio/mpeg',
    path: `/voice-${i}.mp3`,
  }))
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
