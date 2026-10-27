/** 画布启动恢复与任务记录的归属：多个服务进程共用同一工作区时，只有归属进程已退出的任务才由本进程取回。 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCanvasOps, type CanvasGenerateNode, emptyCanvas, serializeCanvas } from '@qywork/core'
import { makeMediaPort, type QyConfig } from '@qywork/runtime'
import { CanvasService } from './canvas.ts'

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70])
const PATH = 'board.canvas.json'

test('另一个服务进程仍在等待的视频任务不在启动恢复中取回；该进程退出后正常取回且只计一次', async () => {
  let done = false
  const calls: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      calls.push(`${req.method} ${path}`)
      if (req.method === 'POST') return Response.json({ id: 'task-1', status: 'queued' })
      if (path === '/v1/videos/task-1/content')
        return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
      return Response.json({ status: done ? 'completed' : 'queued' })
    },
  })
  const config: QyConfig = {
    providers: {
      channel: {
        kind: 'openai_chat_completions',
        apiKey: 'test-only',
        models: {},
        baseUrl: `http://127.0.0.1:${server.port}`,
        media: { 'relay-video': { kind: 'openai_videos' } },
      },
    },
    mediaDefaults: { video: { provider: 'channel', model: 'relay-video' } },
  }
  const root = await mkdtemp(join(tmpdir(), 'qy-canvas-owner-'))
  const ws = { id: 'ws', root }
  const seeded = applyCanvasOps(emptyCanvas(), [
    { op: 'add_generate', ref: '$v', output: 'video', prompt: '海边日落', params: {} },
  ])
  if (!seeded.ok) throw new Error(seeded.error)
  const id = seeded.refs.$v!
  await writeFile(join(root, PATH), serializeCanvas(seeded.doc))
  const other = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'])
  const spends: number[] = []
  const port = () => makeMediaPort(config, (s) => spends.push(s.cost))
  try {
    const first = new CanvasService({ publish: () => {} })
    const run = await first.run(ws, PATH, id, { media: port() })
    while (!calls.some((c) => c.startsWith('GET'))) await Bun.sleep(10)
    await first.stop()
    await run.done
    const node = () =>
      JSON.parse(readFileSync(join(root, PATH), 'utf8')).nodes.find(
        (n: CanvasGenerateNode) => n.id === id,
      ) as CanvasGenerateNode
    const record = join(root, node().versions[0]!.path)
    const task = JSON.parse(await readFile(record, 'utf8'))
    await writeFile(record, JSON.stringify({ ...task, ownerPid: other.pid }))

    done = true
    const before = calls.length
    await new CanvasService({ publish: () => {} }).recover([ws], () => port())
    expect(calls.length).toBe(before)
    expect(node().versions[0]!.path).toEndWith('.task.json')

    other.kill()
    await other.exited
    await new CanvasService({ publish: () => {} }).recover([ws], () => port())
    expect(node().versions.map((v) => v.path.endsWith('.mp4'))).toEqual([true])
    expect(calls.filter((c) => c === 'GET /v1/videos/task-1/content')).toHaveLength(1)
    expect(spends).toHaveLength(1)
  } finally {
    other.kill()
    server.stop(true)
  }
})
