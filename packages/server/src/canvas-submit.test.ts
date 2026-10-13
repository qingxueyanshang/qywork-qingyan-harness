/** 七种视频协议与本地 HTTP 端点：提交不返回时，画布停止必须能结束本地等待。 */
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCanvasOps, emptyCanvas, serializeCanvas } from '@qywork/core'
import { cancelMediaTask, makeMediaPort, type QyConfig } from '@qywork/runtime'
import { CanvasService } from './canvas.ts'

const models = {
  openai_videos: 'video-sd25-30s',
  ark_videos: 'doubao-seedance-2-5-260628',
  dashscope_videos: 'wan3.0-video',
  kling_videos: 'kling-3.0',
  gemini_videos: 'gemini-omni-1.1-flash',
  veo_videos: 'veo-3.1-generate-preview',
  xai_videos: 'grok-imagine-video-1.5',
}
for (const kind of Object.keys(models) as (keyof typeof models)[]) {
  test(`${kind} 提交始终不返回：停止立即解锁卡片，不声称已撤销，不重发生成`, async () => {
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
      const seeded = applyCanvasOps(emptyCanvas(), [
        {
          op: 'add_generate',
          ref: '$v',
          output: 'video',
          prompt: '海边日落',
          params: {},
        },
      ])
      if (!seeded.ok) throw new Error(seeded.error)
      const path = 'board.canvas.json'
      await writeFile(join(root, path), serializeCanvas(seeded.doc))
      const config: QyConfig = {
        providers: {
          channel: {
            kind: 'openai_chat_completions',
            apiKey: 'test-only',
            models: {},
            baseUrl: `http://127.0.0.1:${server.port}`,
            media: { [model]: { kind } },
          },
        },
        mediaDefaults: { video: { provider: 'channel', model } },
      }
      const run = await svc.run({ id: 'ws', root }, path, seeded.refs.$v!, {
        media: makeMediaPort(config),
      })
      await ready
      const before = (await svc.read(root, path)).states[seeded.refs.$v!]
      expect(before).toMatchObject({
        state: 'running',
        stage: 'submitting',
      })
      expect(before).not.toHaveProperty('taskId')
      expect(before).not.toHaveProperty('phase')
      expect(
        await svc.cancel(root, path, seeded.refs.$v!, (task) =>
          cancelMediaTask(config, task, new AbortController().signal),
        ),
      ).toBe('stopped')
      expect(await run.done).toEqual({
        ok: false,
        message: '已停止等待；远端结果未知',
        pending: false,
      })
      expect((await svc.read(root, path)).states[seeded.refs.$v!]).toMatchObject({
        state: 'unknown',
      })
      const saved = JSON.parse(await readFile(join(root, path), 'utf8'))
      expect(saved.runs.at(-1)).toMatchObject({
        result: 'unknown',
      })
      expect(saved.runs.at(-1).task).toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(svc.busyCount).toBe(0)
    } finally {
      release()
      await svc.stop()
      server.stop(true)
    }
  })
}
