/** Mumugofe 从已配置模型、参数校验到实际 HTTP 请求与任务恢复的回归测试。 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { MediaCall } from '@qywork/agent'
import { findMediaModel, lookupMediaModel, mediaKindsOf } from '@qywork/ai'
import type { MediaInputRole, MediaSpend } from '@qywork/core'
import { listMediaModels, type QyConfig } from './config.ts'
import { makeMediaPort } from './media.ts'
import { buildTailNotes } from './prompt.ts'

const MODEL = '满血sd2.5(30-10-10原生过人脸/720P)'
const PROMPT = '雨后咖啡馆，一位成年女性坐下阅读。\n镜头缓慢后退，人物望向窗外微笑。'
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
const TASK = 'task_mumugofe_test'
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
          ...(status === 'failed' ? { error: { message: 'video_generation_failed' } } : {}),
          // 实测终态没有 seconds、usage 或扣费金额，不能用请求值伪造计量。
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

const config = (): QyConfig => ({
  providers: {
    mumugofe: {
      kind: 'openai_chat_completions',
      apiKey: 'test-only-key',
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      models: {},
      media: { [MODEL]: { kind: 'openai_videos' } },
    },
  },
  mediaDefaults: { video: { provider: 'mumugofe', model: MODEL } },
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
      `GET /v1/videos/${TASK}`,
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
    `GET /v1/videos/${TASK}`,
    `GET /v1/videos/${TASK}/content`,
  ])
})

test('远端明确失败原样返回，不下载或重新生成', async () => {
  status = 'failed'
  const result = await makeMediaPort(config()).generate(call(), signal())
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected failure')
  expect(result.message).toContain('video_generation_failed')
  expect(result.pendingTaskId).toBeUndefined()
  expect(seen.map((s) => s.method)).toEqual(['POST', 'GET'])
})
