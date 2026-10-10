/** 集梦单一视频型号、上传、异步任务恢复、跨域凭证隔离及影币结算。 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { defaultMediaKind, MEDIA_KINDS } from '@qywork/core'
import { lookupMediaModel, mediaCatalog, mediaCost } from './catalog.ts'
import { buildMediaAdapter } from './index.ts'
import { validateMediaCall } from './params.ts'
import type { MediaRequest } from './types.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const MP4 = new Uint8Array([0, 0, 0, 24, ...Buffer.from('ftypisom')])
// moov/mvhd：时间刻度 1000，实际时长 4.2 秒；上传接口不返回时长。
const VIDEO = Buffer.alloc(116)
VIDEO.writeUInt32BE(116, 0)
VIDEO.write('moov', 4)
VIDEO.writeUInt32BE(108, 8)
VIDEO.write('mvhd', 12)
VIDEO.writeUInt32BE(1000, 28)
VIDEO.writeUInt32BE(4200, 32)
let server: ReturnType<typeof Bun.serve>
let cdn: ReturnType<typeof Bun.serve>
let calls: { path: string; method: string; auth: string | null; body?: Record<string, unknown> }[]
let terminal: Record<string, unknown>
let upload: Record<string, unknown>
let uploadStatus: number
let submitStatus: number
let queried = 0
let cdnAuth: string | null
let downloadStatus: number
const url = () => `http://127.0.0.1:${server.port}`
const model = 'Seedance 2.5 720p'
const req = (over: Partial<MediaRequest> = {}): MediaRequest => ({
  operation: 'text_to_video',
  prompt: '海边日落',
  inputs: [],
  params: { duration: 5 },
  ...over,
})
const adapter = (suffix = '') =>
  buildMediaAdapter({
    kind: 'binguo_videos',
    model,
    apiKey: 'test-secret',
    baseUrl: `${url()}${suffix}`,
  })
const signal = () => new AbortController().signal

beforeAll(() => {
  cdn = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      cdnAuth = request.headers.get('authorization')
      return new Response(new URL(request.url).pathname.endsWith('.png') ? PNG : MP4, {
        status: downloadStatus,
      })
    },
  })
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const record: (typeof calls)[number] = {
        path,
        method: request.method,
        auth: request.headers.get('authorization'),
      }
      calls.push(record)
      if (path.endsWith('/api/media/upload')) {
        const form = await request.formData()
        const file = form.get('file') as File
        expect(file.name).toBe(file.type === 'video/mp4' ? 'ref.mp4' : 'ref.png')
        expect(new Uint8Array(await file.arrayBuffer())).toEqual(
          new Uint8Array(file.type === 'video/mp4' ? VIDEO : PNG),
        )
        return Response.json(upload, { status: uploadStatus })
      }
      if (request.method === 'POST') {
        record.body = (await request.json()) as Record<string, unknown>
        return Response.json(
          submitStatus === 200
            ? { task_id: 'task-1', status: 'queued', cost: 9999 }
            : { error: '余额不足' },
          { status: submitStatus },
        )
      }
      queried++
      return Response.json(terminal)
    },
  })
})
afterAll(() => {
  server.stop(true)
  cdn.stop(true)
})
beforeEach(() => {
  calls = []
  queried = 0
  cdnAuth = null
  submitStatus = 200
  downloadStatus = 200
  uploadStatus = 200
  upload = { url: `http://127.0.0.1:${cdn.port}/ref.png`, durationSeconds: null }
  terminal = {
    task_id: 'task-1',
    status: 'completed',
    cost: 1000,
    video_url: `http://127.0.0.1:${cdn.port}/out.mp4`,
  }
})

test('集梦仅收录 2.5 720p，保留独立协议、能力与价格', () => {
  const models = mediaCatalog().filter((m) => m.vendor === '集梦')
  expect(models.map((m) => m.id)).toEqual([model])
  expect(models[0]!.kind).toBe('binguo_videos')
  expect(MEDIA_KINDS).not.toContain('binguo_images')
  expect(defaultMediaKind('video', 'https://binguofilm.com', 'binguo_videos')).toBe('binguo_videos')
  const spec = lookupMediaModel(model, 'binguo_videos')
  expect(
    validateMediaCall(spec, 'text_to_video', { duration: 5 }, { images: 0, videos: 0 }),
  ).toEqual([])
  for (const duration of [-1, 4, 31])
    expect(
      validateMediaCall(spec, 'text_to_video', { duration }, { images: 0, videos: 0 }).length,
    ).toBeGreaterThan(0)
  expect(
    validateMediaCall(
      spec,
      'first_last_frame',
      {},
      { images: 0, videos: 0, firstFrames: 1, lastFrames: 1 },
    ).length,
  ).toBeGreaterThan(0)
  expect(mediaCost(spec, { billed: { amount: 440, currency: 'BINGUO_CREDIT' } })).toEqual({
    cost: 440,
    currency: 'BINGUO_CREDIT',
  })
  expect(lookupMediaModel(model, 'ark_videos').catalogued).toBe(false)
})

test('保存 task_id 后查询，按直链下载且不向 CDN 发送 API Key', async () => {
  const result = await adapter('/v1/').run(req(), {
    signal: signal(),
    onTask: (id) => {
      expect(id).toBe('task-1')
      expect(queried).toBe(0)
    },
  })
  expect(calls.map((c) => c.path)).toEqual(['/v1/videos', '/v1/videos/task-1'])
  expect(calls[0]!.body).toEqual({ model, prompt: '海边日落', duration: 5 })
  expect(calls.every((c) => c.auth === 'Bearer test-secret')).toBe(true)
  expect(cdnAuth).toBeNull()
  expect(result.files[0]!.bytes).toEqual(MP4)
  expect(result.usage?.billed).toEqual({ amount: 1000, currency: 'BINGUO_CREDIT' })
  expect(result.usage?.seconds).toBeUndefined()
})

test('本地素材先上传，视频时长随参考视频发送，保留部署前缀', async () => {
  await adapter('/prefix/v1').run(
    req({
      operation: 'video_to_video',
      inputs: [
        { role: 'reference', path: '/work/ref.png', bytes: PNG, mime: 'image/png' },
        { role: 'video', path: '/work/ref.mp4', bytes: VIDEO, mime: 'video/mp4' },
        { role: 'audio', path: '/work/ref.png', bytes: PNG, mime: 'audio/wav' },
      ],
    }),
    { signal: signal() },
  )
  expect(calls.slice(0, 3).map((c) => c.path)).toEqual(Array(3).fill('/prefix/api/media/upload'))
  expect(calls[3]!.body).toMatchObject({
    extra_images: [upload.url],
    extra_videos: [upload.url],
    extra_audios: [upload.url],
    extra_video_durations: [5],
  })
})

test('参考视频无法读取有效时长时在上传前拒绝，避免按最大时长收费', async () => {
  await expect(
    adapter().run(
      req({ inputs: [{ role: 'video', path: '/work/ref.png', bytes: PNG, mime: 'video/mp4' }] }),
      { signal: signal() },
    ),
  ).rejects.toThrow('时长')
  expect(calls).toHaveLength(0)
})

test('上传失败明确标记上传阶段，生成尚未提交，不报告生成结果未知', async () => {
  uploadStatus = 502
  try {
    await adapter().run(
      req({ inputs: [{ role: 'video', path: '/work/ref.mp4', bytes: VIDEO, mime: 'video/mp4' }] }),
      { signal: signal() },
    )
    throw new Error('应报告上传失败')
  } catch (error) {
    expect((error as Error).message).not.toContain('远端结果未知')
    expect(error).toMatchObject({
      diagnostic: { stage: 'upload', kind: 'http', status: 502 },
      message: expect.stringContaining('素材上传失败，未提交生成'),
    })
  }
  expect(calls.map((c) => c.path)).toEqual(['/api/media/upload'])
})

test('不支持的首帧在上传或提交前拒绝', async () => {
  await expect(
    adapter().run(
      req({
        inputs: [{ role: 'first_frame', path: '/work/ref.png', bytes: PNG, mime: 'image/png' }],
      }),
      { signal: signal() },
    ),
  ).rejects.toThrow('首尾帧')
  expect(calls).toHaveLength(0)
})

test('查询失败和未知状态保留原任务号，恢复不上传也不提交', async () => {
  terminal.status = 'unrecognized'
  await expect(adapter().run(req(), { signal: signal() })).rejects.toMatchObject({
    pendingTaskId: 'task-1',
  })
  terminal.status = 'completed'
  calls = []
  await adapter().run(req(), { signal: signal(), resumeTaskId: 'task-1' })
  expect(calls.map((c) => c.method)).toEqual(['GET'])
})

test('视频下载失败保留任务号，恢复不重复提交生成', async () => {
  downloadStatus = 403
  await expect(adapter().run(req(), { signal: signal() })).rejects.toMatchObject({
    pendingTaskId: 'task-1',
  })
  downloadStatus = 200
  calls = []
  await adapter().run(req(), { signal: signal(), resumeTaskId: 'task-1' })
  expect(calls.map((c) => c.method)).toEqual(['GET'])
})

test('远端失败或结果过期为终态，余额不足不重发', async () => {
  terminal.status = 'failed'
  terminal.error = '上游拒绝'
  await expect(adapter().run(req(), { signal: signal() })).rejects.toMatchObject({
    pendingTaskId: undefined,
    message: '远端任务失败：上游拒绝',
  })
  terminal.status = 'completed'
  terminal.video_expired = true
  await expect(adapter().run(req(), { signal: signal() })).rejects.toThrow('保留期')
  calls = []
  submitStatus = 402
  await expect(adapter().run(req(), { signal: signal() })).rejects.toMatchObject({ status: 402 })
  expect(calls).toHaveLength(1)
})
