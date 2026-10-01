/** 真 HTTP 生成与重启：重载等待画布、接续只查询原任务、更新占位后不再启动生成。 */
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCanvasOps,
  type CanvasDoc,
  type CanvasView,
  emptyCanvas,
  serializeCanvas,
} from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { Store, upsertWorkspace } from '@qywork/store'
import { CanvasService } from '../packages/server/src/canvas.ts'
import { serve } from '../packages/server/src/server.ts'
import { createReloadSupervisor } from './reload-supervisor.ts'
import { requestUpdateClaim } from './update/claim.ts'

const PATH = 'board.canvas.json'
const MP4 = new Uint8Array([0, 0, 0, 24])

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error('任务未在时限内达到预期状态')
}

test('画布生成阻止重载，后端重启自动接续并只落一版；空闲后才允许换代码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-recovery-'))
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, root, 'canvas')
  let submitted = 0
  let queried = 0
  let downloaded = 0
  let complete = false
  const remote = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req): Response {
      const path = new URL(req.url).pathname
      if (req.method === 'POST' && path.endsWith('/video-synthesis')) {
        submitted++
        return Response.json({ output: { task_id: 'original-task' } })
      }
      if (req.method === 'GET' && path === '/api/v1/tasks/original-task') {
        queried++
        return Response.json({
          output: complete
            ? { task_status: 'SUCCEEDED', video_url: `http://127.0.0.1:${remote.port}/video.mp4` }
            : { task_status: 'RUNNING' },
        })
      }
      if (path === '/video.mp4') {
        downloaded++
        return new Response(MP4, { headers: { 'content-type': 'video/mp4' } })
      }
      return new Response('unexpected request', { status: 404 })
    },
  })
  const config: QyConfig = {
    providers: {
      qwen: {
        kind: 'openai_chat_completions',
        apiKey: 'test-only',
        baseUrl: `http://127.0.0.1:${remote.port}`,
        models: {},
        media: { 'wan3.0-video': { kind: 'dashscope_videos' } },
      },
    },
    mediaDefaults: { video: { provider: 'qwen', model: 'wan3.0-video' } },
    officeEnabled: false,
  }
  const seeded = applyCanvasOps(emptyCanvas(), [
    { op: 'add_generate', ref: '$v', output: 'video', prompt: 'test' },
  ])
  if (!seeded.ok) throw new Error(seeded.error)
  const nodeId = seeded.refs.$v!
  await writeFile(join(root, PATH), serializeCanvas(seeded.doc))
  const options = {
    store,
    config,
    workspaceRoot: root,
    port: 0,
    host: '127.0.0.1',
    token: 'pair-token',
    updateHostKey: 'update-owner',
  }
  let handle = serve(options)
  const request = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${handle.port}${path}${path.includes('?') ? '&' : '?'}ws=${ws.id}`, {
      headers: { Authorization: 'Bearer pair-token', 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    })
  const read = async () => (await (await request(`/api/canvas?path=${PATH}`)).json()) as CanvasView
  let tick: (() => void) | undefined
  let checks = 0
  let restarts = 0
  const supervisor = createReloadSupervisor({
    busy: async () => {
      const result = await requestUpdateClaim(handle.port, 'update-owner', 'claim')
      checks++
      return !result.claimed
    },
    restart: async () => {
      restarts++
    },
    debounceMs: 1,
    idlePollMs: 1,
    setTimer: (fn) => {
      tick = fn
      return fn
    },
    clearTimer: () => {
      tick = undefined
    },
    log() {},
  })
  try {
    expect((await request('/api/canvas/run', { path: PATH, nodeId })).status).toBe(200)
    await until(async () => queried === 1)
    const before = await read()
    expect(before.states[nodeId]?.state).toBe('running')
    const original = before.doc.nodes.find((n) => n.id === nodeId)
    if (original?.type !== 'generate') throw new Error('生成卡未找到')
    const version = original.versions[0]!
    expect(version.path.endsWith('.task.json')).toBe(true)
    expect(JSON.parse(await readFile(join(root, version.path), 'utf8')).taskId).toBe(
      'original-task',
    )

    supervisor.onChange()
    tick?.()
    await until(async () => checks === 1)
    expect(restarts).toBe(0)
    // 重复读取模拟刷新；它不会再提交或丢失服务端的运行状态。
    expect((await read()).states[nodeId]?.state).toBe('running')
    expect(submitted).toBe(1)

    await handle.stop()
    expect(JSON.parse(await readFile(join(root, version.path), 'utf8')).taskId).toBe(
      'original-task',
    )
    complete = true
    handle = serve(options)
    await until(async () => (await read()).states[nodeId]?.state === 'normal')
    const recovered = (await read()).doc.nodes.find((n) => n.id === nodeId)
    if (recovered?.type !== 'generate') throw new Error('生成卡未找到')
    expect(recovered.versions).toHaveLength(1)
    expect(recovered.current).toBe(version.id)
    expect(recovered.versions[0]?.id).toBe(version.id)
    expect(recovered.versions[0]?.path.endsWith('.mp4')).toBe(true)
    expect(submitted).toBe(1)
    expect(queried).toBe(2)
    expect(downloaded).toBe(1)
    expect(
      store.db.query('SELECT count(*) AS n FROM usage_ledger WHERE kind = ?').get('media'),
    ).toEqual({ n: 1 })

    tick?.()
    await until(async () => restarts === 1)
    expect((await request('/api/canvas/run', { path: PATH, nodeId })).status).toBe(409)
    expect(submitted).toBe(1)
    await requestUpdateClaim(handle.port, 'update-owner', 'cancel')
  } finally {
    await handle.stop()
    remote.stop(true)
    store.close()
  }
})

test('恢复扫描不受搜索的 300 条上限截断，配置不可用时保留任务文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-recovery-list-'))
  const seeded = applyCanvasOps(emptyCanvas(), [
    { op: 'add_generate', ref: '$v', output: 'video', prompt: 'test' },
  ])
  if (!seeded.ok) throw new Error(seeded.error)
  const doc = seeded.doc
  const node = doc.nodes[0]!
  if (node.type !== 'generate') throw new Error('生成卡未找到')
  node.versions = [
    {
      id: 'version',
      path: 'pending.task.json',
      made: {
        provider: 'missing',
        model: 'wan3.0-video',
        prompt: 'test',
        params: {},
        inputs: [],
        at: new Date().toISOString(),
      },
    },
  ]
  node.current = 'version'
  await writeFile(join(root, 'pending.task.json'), JSON.stringify({ taskId: 'original' }))
  await Promise.all(
    Array.from({ length: 301 }, (_, i) =>
      writeFile(
        join(root, `${String(i).padStart(3, '0')}.canvas.json`),
        serializeCanvas(i === 300 ? doc : emptyCanvas()),
      ),
    ),
  )
  const service = new CanvasService({ publish() {} })
  let seen = 0
  await service.recover([{ id: 'ws', root }], () => {
    seen++
    return undefined
  })
  expect(seen).toBe(1)
  expect(service.busyCount).toBe(0)
  expect(JSON.parse(await readFile(join(root, 'pending.task.json'), 'utf8')).taskId).toBe(
    'original',
  )
  const persisted = JSON.parse(await readFile(join(root, '300.canvas.json'), 'utf8')) as CanvasDoc
  expect(persisted).toEqual(doc)
})

test('文件校验期间取得更新占位，生成在真正调用接口之前被拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'canvas-claim-race-'))
  const seeded = applyCanvasOps(emptyCanvas(), [
    { op: 'add_generate', ref: '$v', output: 'video', prompt: 'test' },
  ])
  if (!seeded.ok) throw new Error(seeded.error)
  await writeFile(join(root, PATH), serializeCanvas(seeded.doc))
  let updating = false
  let called = false
  const service = new CanvasService({ publish() {}, updating: () => updating })
  const run = service.run({ id: 'ws', root }, PATH, seeded.refs.$v!, {
    media: {
      generate: async () => {
        called = true
        return { ok: false, message: '不应调用' }
      },
    },
  })
  updating = true
  await expect(run).rejects.toMatchObject({ status: 409 })
  expect(called).toBe(false)
  expect(service.busyCount).toBe(0)
})
