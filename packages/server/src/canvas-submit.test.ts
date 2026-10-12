/** 八种视频协议与本地 HTTP 端点：上传或提交不返回时，画布停止必须能结束本地等待。 */
import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addVersions, applyCanvasOps, emptyCanvas, serializeCanvas } from '@qywork/core'
import { cancelMediaTask, makeMediaPort, type QyConfig } from '@qywork/runtime'
import { CanvasService } from './canvas.ts'

const models = {
  binguo_videos: 'Seedance 2.5 720p',
  openai_videos: 'video-sd25-30s',
  ark_videos: 'doubao-seedance-2-5-260628',
  dashscope_videos: 'wan3.0-video',
  kling_videos: 'kling-3.0',
  gemini_videos: 'gemini-omni-1.1-flash',
  veo_videos: 'veo-3.1-generate-preview',
  xai_videos: 'grok-imagine-video-1.5',
}
const cases: { kind: keyof typeof models; stage: 'upload' | 'generate' }[] = [
  { kind: 'binguo_videos', stage: 'upload' },
  ...(
    [
      'binguo_videos',
      'openai_videos',
      'ark_videos',
      'dashscope_videos',
      'kling_videos',
      'gemini_videos',
      'veo_videos',
      'xai_videos',
    ] as const
  ).map((kind) => ({ kind, stage: 'generate' as const })),
]
for (const { kind, stage } of cases) {
  test(`${kind} ${stage} 始终不返回：停止立即解锁卡片，不声称已撤销，不重发生成`, async () => {
    const model = models[kind]
    let entered = () => {}
    let release = () => {}
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        calls.push(path)
        if (path === '/api/media/upload') {
          await req.formData()
          if (stage === 'upload') {
            entered()
            await held
          }
          return Response.json({ url: 'https://example.com/ref.png' })
        }
        if (req.method === 'POST') {
          await req.json()
          entered()
          await held
          return Response.json({ task_id: 'too-late', status: 'queued' })
        }
        return new Response('Unexpected request', { status: 500 })
      },
    })
    const svc = new CanvasService({ publish: () => {} })
    try {
      const root = await mkdtemp(join(tmpdir(), 'qy-canvas-submit-'))
      await writeFile(join(root, 'ref.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
      const seeded = applyCanvasOps(emptyCanvas(), [
        { op: 'add_file', ref: '$a', path: 'ref.png' },
        {
          op: 'add_generate',
          ref: '$v',
          output: 'video',
          prompt: '海边日落',
          params: {},
        },
        ...(kind === 'binguo_videos'
          ? [{ op: 'connect' as const, from: '$a', to: '$v', role: 'reference' as const }]
          : []),
      ])
      if (!seeded.ok) throw new Error(seeded.error)
      const path = 'board.canvas.json'
      await writeFile(join(root, path), serializeCanvas(seeded.doc))
      const config: QyConfig = {
        providers: {
          binguo: {
            kind: 'openai_chat_completions',
            apiKey: 'test-only',
            models: {},
            baseUrl: `http://127.0.0.1:${server.port}`,
            media: { [model]: { kind } },
          },
        },
        mediaDefaults: { video: { provider: 'binguo', model } },
      }
      const run = await svc.run({ id: 'ws', root }, path, seeded.refs.$v!, {
        media: makeMediaPort(config),
      })
      await ready
      const before = (await svc.read(root, path)).states[seeded.refs.$v!]
      expect(before).toMatchObject({
        state: 'running',
        stage: stage === 'upload' ? 'preparing' : 'submitting',
      })
      expect(before).not.toHaveProperty('taskId')
      expect(before).not.toHaveProperty('phase')
      expect(
        await svc.cancel(root, path, seeded.refs.$v!, (task) =>
          cancelMediaTask(config, task, new AbortController().signal),
        ),
      ).toBe(stage === 'upload' ? 'not_submitted' : 'stopped')
      expect(await run.done).toEqual({
        ok: false,
        message:
          stage === 'upload' ? '已取消，未提交生成，不产生生成费用' : '已停止等待；远端结果未知',
        pending: false,
      })
      expect((await svc.read(root, path)).states[seeded.refs.$v!]).toMatchObject({
        state: stage === 'upload' ? 'empty' : 'unknown',
      })
      const saved = JSON.parse(await readFile(join(root, path), 'utf8'))
      expect(saved.runs.at(-1)).toMatchObject({
        result: stage === 'upload' ? 'cancelled' : 'unknown',
      })
      expect(saved.runs.at(-1).task).toBeUndefined()
      if (kind === 'binguo_videos')
        expect(calls).toEqual(
          stage === 'upload' ? ['/api/media/upload'] : ['/api/media/upload', '/v1/videos'],
        )
      else expect(calls).toHaveLength(1)
      expect(svc.busyCount).toBe(0)
    } finally {
      release()
      await svc.stop()
      server.stop(true)
    }
  })
}

test('素材上传超时自动释放卡片，保留旧成片和任务号，并允许再次提交', async () => {
  let entered = () => {}
  let release = () => {}
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: string[] = []
  let uploads = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(path)
      if (path === '/api/media/upload') {
        await req.formData()
        if (++uploads === 1) {
          entered()
          await held
        }
        return Response.json({ url: 'https://example.com/ref.png' })
      }
      // 重试能走到真正的提交端点；该本机端点明确拒绝，避免引入另一个待取回任务。
      return Response.json({ error: '余额不足' }, { status: 402 })
    },
  })
  const svc = new CanvasService({ publish: () => {} })
  const originalTimer = globalThis.setTimeout
  let expire: () => void = () => {
    throw new Error('应设置上传期限')
  }
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms: number,
  ) => {
    if (ms === 300_000) expire = fn
    return originalTimer(fn, ms)
  }) as typeof setTimeout)
  try {
    const root = await mkdtemp(join(tmpdir(), 'qy-canvas-upload-timeout-'))
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    await writeFile(join(root, 'ref.png'), bytes)
    await writeFile(join(root, 'old.mp4'), 'existing video')
    const model = models.binguo_videos
    const made = {
      provider: 'binguo',
      model,
      params: {},
      prompt: '旧镜头',
      inputs: [],
      at: '2026-10-12T09:00:00Z',
    }
    const record = JSON.stringify({
      provider: 'binguo',
      model,
      taskId: 'original-task',
      params: {},
      output: 'pending',
      submittedAt: made.at,
    })
    await writeFile(join(root, 'pending.task.json'), record)
    const seeded = applyCanvasOps(emptyCanvas(), [
      { op: 'add_file', ref: '$a', path: 'ref.png' },
      { op: 'add_generate', ref: '$v', output: 'video', prompt: '海边日落' },
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    if (!seeded.ok) throw new Error(seeded.error)
    const nodeId = seeded.refs.$v!
    const versions = [
      { id: 'completed', path: 'old.mp4', made },
      { id: 'pending', path: 'pending.task.json', made },
    ]
    const added = addVersions(seeded.doc, nodeId, versions)
    if (!added.ok) throw new Error(added.error)
    const selected = applyCanvasOps(added.doc, [{ op: 'update', id: nodeId, current: 'completed' }])
    if (!selected.ok) throw new Error(selected.error)
    const path = 'board.canvas.json'
    await writeFile(join(root, path), serializeCanvas(selected.doc))
    const config: QyConfig = {
      providers: {
        binguo: {
          kind: 'openai_chat_completions',
          apiKey: 'test-only',
          models: {},
          baseUrl: `http://127.0.0.1:${server.port}`,
          media: { [model]: { kind: 'binguo_videos' } },
        },
      },
      mediaDefaults: { video: { provider: 'binguo', model } },
    }
    const media = makeMediaPort(config)
    const run = await svc.run({ id: 'ws', root }, path, nodeId, { media })
    await ready
    expect((await svc.read(root, path)).states[nodeId]).toMatchObject({
      state: 'running',
      stage: 'preparing',
    })
    expire()
    expect(await run.done).toMatchObject({
      ok: false,
      pending: false,
      message: expect.stringContaining('素材上传失败，未提交生成'),
      diagnostic: { stage: 'upload', kind: 'timeout', outcome: 'rejected', timeoutMs: 300_000 },
    })
    expect(svc.busyCount).toBe(0)
    expect(calls).toEqual(['/api/media/upload'])
    const after = await svc.read(root, path)
    expect(after.states[nodeId]).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('未提交生成'),
    })
    expect(after.doc.nodes.find((n) => n.id === nodeId)).toMatchObject({
      current: 'completed',
      versions,
    })
    expect(after.tasks?.pending?.taskId).toBe('original-task')
    expect(after.doc.runs?.at(-1)).toMatchObject({
      result: 'failed',
      diagnostic: { outcome: 'rejected' },
    })
    expect(await readFile(join(root, 'old.mp4'), 'utf8')).toBe('existing video')
    expect(await readFile(join(root, 'pending.task.json'), 'utf8')).toBe(record)
    release()
    const retry = await svc.run({ id: 'ws', root }, path, nodeId, { media })
    expect(await retry.done).toMatchObject({
      ok: false,
      message: expect.stringContaining('HTTP 402'),
    })
    expect(calls).toEqual(['/api/media/upload', '/api/media/upload', '/v1/videos'])
    expect(svc.busyCount).toBe(0)
  } finally {
    timers.mockRestore()
    release()
    await svc.stop()
    server.stop(true)
  }
})
