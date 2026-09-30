/**
 * 覆盖 `canvas.ts` 的运行与取回（`run` / `retrieve`），以及 `canvas.run` 与 `file.changed` 的时序。
 *
 * 生成端口是假的：每次调用交出一个可以从外面推进的句柄（任务号回调、完成、失败），
 * 测试据此控制「生成到一半」的时刻。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaCall, MediaCallResult, MediaPort } from '@qywork/agent'
import {
  type AgentEvent,
  applyCanvasOps,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasOp,
  emptyCanvas,
  parseCanvas,
  serializeCanvas,
} from '@qywork/core'
import { CanvasFailure, CanvasService, type CanvasWorkspace } from './canvas.ts'

const PATH = 'board.canvas.json'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const MP4 = new Uint8Array([0, 0, 0, 24])

/** 带真实 IHDR 的 PNG 头：服务端从这 24 字节读宽高。 */
function pngHead(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}

/** 一次端口调用：`submit` 触发任务号回调，`finish` 让调用返回。 */
interface Pending {
  call: MediaCall
  submit(taskId?: string): Promise<void>
  finish(result: MediaCallResult): void
}

function fakePort(): { port: MediaPort; calls: Pending[]; next(): Promise<Pending> } {
  const calls: Pending[] = []
  const waiters: ((p: Pending) => void)[] = []
  const port: MediaPort = {
    generate(call) {
      return new Promise((resolve) => {
        const p: Pending = {
          call,
          submit: async (taskId = `task-${calls.length}`) => {
            await call.onTask?.({ taskId, provider: 'ark', model: 'seedance' })
          },
          finish: resolve,
        }
        calls.push(p)
        waiters.shift()?.(p)
      })
    },
  }
  const next = () =>
    new Promise<Pending>((resolve) => {
      const unclaimed = calls.find((c) => !(c as { claimed?: boolean }).claimed)
      if (unclaimed) {
        ;(unclaimed as { claimed?: boolean }).claimed = true
        resolve(unclaimed)
        return
      }
      waiters.push((p) => {
        ;(p as { claimed?: boolean }).claimed = true
        resolve(p)
      })
    })
  return { port, calls, next }
}

async function setup(ops: CanvasOp[]): Promise<{
  ws: CanvasWorkspace
  svc: CanvasService
  events: AgentEvent[]
  ids: Record<string, string>
}> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-canvas-run-'))
  await writeFile(join(root, 'a.png'), PNG)
  await writeFile(join(root, 'b.png'), PNG)
  const r = applyCanvasOps(emptyCanvas(), ops)
  if (!r.ok) throw new Error(r.error)
  await writeFile(join(root, PATH), serializeCanvas(r.doc))
  const events: AgentEvent[] = []
  const svc = new CanvasService({ publish: (e) => events.push(e) })
  return { ws: { id: 'ws1', root }, svc, events, ids: r.refs }
}

async function onDisk(root: string): Promise<CanvasDoc> {
  const r = parseCanvas(await readFile(join(root, PATH), 'utf8'))
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

async function node(root: string, id: string): Promise<CanvasGenerateNode> {
  const n = (await onDisk(root)).nodes.find((x) => x.id === id)
  if (n?.type !== 'generate') throw new Error(`${id} 不是生成节点`)
  return n
}

async function failure(p: Promise<unknown>): Promise<CanvasFailure> {
  try {
    await p
  } catch (err) {
    if (err instanceof CanvasFailure) return err
    throw err
  }
  throw new Error('应当失败')
}

const IMAGE_CARD: CanvasOp[] = [
  { op: 'add_file', ref: '$a', path: 'a.png', name: '小满' },
  { op: 'add_generate', ref: '$g', output: 'image', prompt: '@[$a] 戴一顶帽子' },
]
const VIDEO_CARD: CanvasOp[] = [
  { op: 'add_file', ref: '$a', path: 'a.png', name: '小满' },
  { op: 'add_generate', ref: '$v', output: 'video', prompt: '@[$a] 走出校门' },
]

describe('画布运行：图像', () => {
  test('成功后追加版本；made 记编译后的提示词，之后改提示词不影响它', async () => {
    const { ws, svc, ids } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    const p = await fake.next()
    expect(p.call.prompt).toBe('小满 戴一顶帽子')
    expect(p.call.inputs.map((i) => i.role)).toEqual(['reference'])
    p.finish({
      ok: true,
      provider: 'qwen',
      model: 'img',
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    expect(await done).toMatchObject({ ok: true })
    await svc.apply(ws.root, PATH, [{ op: 'update', id: ids.$g!, prompt: '换一个' }])
    const g = await node(ws.root, ids.$g!)
    expect(g.versions).toHaveLength(1)
    expect(g.current).toBe(g.versions[0]!.id)
    expect(g.versions[0]!.made).toMatchObject({
      prompt: '小满 戴一顶帽子',
      provider: 'qwen',
      model: 'img',
      inputs: [{ role: 'reference', path: 'a.png' }],
    })
    expect(g.versions[0]!.path).toMatch(/^generated\/\d{8}-\d{6}\.png$/)
  })

  test('落地的图带像素宽高，卡片的框换成图的比例、面积不变', async () => {
    const { ws, svc, ids } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({
      ok: true,
      provider: 'q',
      model: 'm',
      files: [{ bytes: pngHead(1024, 1536), mime: 'image/png' }],
    })
    expect(await done).toMatchObject({ ok: true })
    const g = await node(ws.root, ids.$g!)
    expect(g.versions[0]!.size).toEqual({ w: 1024, h: 1536 })
    expect({ w: g.w, h: g.h }).toEqual({ w: 138, h: 207 })
  })

  test('事件依次是 running → file.changed → done', async () => {
    const { ws, svc, ids, events } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({
      ok: true,
      provider: 'q',
      model: 'm',
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    await done
    expect(events.map((e) => (e.type === 'canvas.run' ? `run:${e.state}` : e.type))).toEqual([
      'run:running',
      'file.changed',
      'run:done',
    ])
    expect(events[0]).toMatchObject({ workspaceId: 'ws1', path: PATH, nodeId: ids.$g })
  })

  test('出图失败：failed 带原文、没有 file.changed，状态显示原文', async () => {
    const { ws, svc, ids, events } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({ ok: false, message: '内容审核未通过' })
    expect(await done).toEqual({ ok: false, message: '内容审核未通过', pending: false })
    expect(events.map((e) => e.type)).toEqual(['canvas.run', 'canvas.run'])
    expect(events[1]).toMatchObject({ state: 'failed', message: '内容审核未通过' })
    expect((await svc.read(ws.root, PATH)).states[ids.$g!]).toEqual({
      state: 'failed',
      message: '内容审核未通过',
    })
  })

  test('提示词为空、输入的生成节点还没有结果时不调端口', async () => {
    const { ws, svc, ids } = await setup([
      ...IMAGE_CARD,
      { op: 'add_generate', ref: '$e', output: 'image' },
      { op: 'add_generate', ref: '$h', output: 'image', prompt: '以 @[$g] 为参考' },
    ])
    const fake = fakePort()
    expect((await failure(svc.run(ws, PATH, ids.$e!, { media: fake.port }))).message).toContain(
      '提示词为空',
    )
    expect((await failure(svc.run(ws, PATH, ids.$h!, { media: fake.port }))).message).toContain(
      '还没有结果',
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('输入来自另一个生成节点时取它当前版本', async () => {
    const { ws, svc, ids } = await setup([
      ...IMAGE_CARD,
      { op: 'add_generate', ref: '$h', output: 'image', prompt: '以 @[$g] 为参考' },
    ])
    const fake = fakePort()
    const first = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({
      ok: true,
      provider: 'q',
      model: 'm',
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    await first.done
    const made = (await node(ws.root, ids.$g!)).versions[0]!.path
    const second = await svc.run(ws, PATH, ids.$h!, { media: fake.port })
    const p = await fake.next()
    expect(p.call.inputs.map((i) => i.path)).toEqual([join(ws.root, made)])
    expect(p.call.prompt).toBe('以 图片1 为参考')
    p.finish({ ok: false, message: 'x' })
    await second.done
  })
})

describe('画布运行：视频', () => {
  test('任务号到手即追加一版指向任务记录，状态为生成中；成功后改指产物、删记录', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-1')
    const during = await node(ws.root, ids.$v!)
    expect(during.versions).toHaveLength(1)
    expect(during.versions[0]!.path).toMatch(/\.task\.json$/)
    expect(during.versions[0]!.made).toMatchObject({ provider: 'ark', model: 'seedance' })
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toMatchObject({ state: 'running' })
    // 在跑时再跑、取回、删节点、删这一版都被拒。
    expect((await failure(svc.run(ws, PATH, ids.$v!, { media: fake.port }))).status).toBe(409)
    expect(
      (await failure(svc.retrieve(ws, PATH, ids.$v!, undefined, { media: fake.port }))).status,
    ).toBe(409)
    expect((await failure(svc.apply(ws.root, PATH, [{ op: 'remove', id: ids.$v! }]))).status).toBe(
      409,
    )
    expect(
      (
        await failure(
          svc.apply(ws.root, PATH, [
            { op: 'remove', id: ids.$v!, version: during.versions[0]!.id },
          ]),
        )
      ).status,
    ).toBe(409)
    p.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    expect(await done).toMatchObject({ ok: true })
    const after = await node(ws.root, ids.$v!)
    expect(after.versions.map((v) => v.id)).toEqual([during.versions[0]!.id])
    expect(after.versions[0]!.path).toMatch(/^generated\/\d{8}-\d{6}\.mp4$/)
    expect((await readdir(join(ws.root, 'generated'))).some((f) => f.endsWith('.task.json'))).toBe(
      false,
    )
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toEqual({ state: 'normal' })
  })

  test('模型返回尾帧：视频进版本，尾帧图多一个节点，名字 <卡片名>_尾帧，在卡片右侧', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit()
    p.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [
        { bytes: MP4, mime: 'video/mp4' },
        { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mime: 'image/jpeg' },
      ],
    })
    expect(await run.done).toMatchObject({ ok: true })
    const doc = await onDisk(ws.root)
    const video = doc.nodes.find((n) => n.id === ids.$v)!
    const frame = doc.nodes.find((n) => n.type === 'file' && n.name === '视频1_尾帧')
    expect(frame).toMatchObject({ type: 'file', path: expect.stringMatching(/\.jpg$/) })
    expect(frame!.x).toBeGreaterThan(video.x + video.w)
    expect((await node(ws.root, ids.$v!)).versions[0]!.path).toMatch(/\.mp4$/)
  })

  test('等待超时：这一版留着，状态为待取回；取回后改指产物', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-1')
    p.finish({ ok: false, message: '等待超过 20 分钟仍未完成', pendingTaskId: 't-1' })
    expect(await run.done).toEqual({
      ok: false,
      message: '等待超过 20 分钟仍未完成',
      pending: true,
    })
    const v = (await node(ws.root, ids.$v!)).versions[0]!
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toEqual({
      state: 'pending',
      version: v.id,
    })

    const again = await svc.retrieve(ws, PATH, ids.$v!, undefined, { media: fake.port })
    const r = await fake.next()
    expect(r.call).toMatchObject({ resumeTaskId: 't-1', provider: 'ark', model: 'seedance' })
    r.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    expect(await again.done).toMatchObject({ ok: true })
    expect((await node(ws.root, ids.$v!)).versions[0]!.path).toMatch(/\.mp4$/)
  })

  test('远端明确失败：删这一版与任务记录，最近失败有原文', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit()
    p.finish({ ok: false, message: '远端任务失败：不合规' })
    await run.done
    expect((await node(ws.root, ids.$v!)).versions).toEqual([])
    expect(await readdir(join(ws.root, 'generated'))).toEqual([])
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toEqual({
      state: 'failed',
      message: '远端任务失败：不合规',
    })
  })

  test('生成期间删掉同卡另一个旧版，成功后回写的仍是对的那一版', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const first = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const a = await fake.next()
    await a.submit()
    a.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    await first.done
    const old = (await node(ws.root, ids.$v!)).versions[0]!

    const second = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const b = await fake.next()
    await b.submit()
    await svc.apply(ws.root, PATH, [{ op: 'remove', id: ids.$v!, version: old.id }])
    b.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    expect(await second.done).toMatchObject({ ok: true })
    const after = await node(ws.root, ids.$v!)
    expect(after.versions).toHaveLength(1)
    expect(after.versions[0]!.path).toMatch(/\.mp4$/)
    expect(after.current).toBe(after.versions[0]!.id)
  })

  test('生成期间画布被外部改写、节点没了：产物照常落盘，failed 原文写明产物路径', async () => {
    const { ws, svc, ids, events } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit()
    await writeFile(join(ws.root, PATH), serializeCanvas(emptyCanvas()))
    p.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    const result = await run.done
    expect(result.ok).toBe(false)
    const product = (await readdir(join(ws.root, 'generated'))).find((f) => f.endsWith('.mp4'))
    expect(product).toBeDefined()
    expect(result.ok ? '' : result.message).toContain(`generated/${product}`)
    expect(events.at(-1)).toMatchObject({ type: 'canvas.run', state: 'failed' })
  })

  test('一张卡有两个待取回版本时按版本 id 各取各的', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    for (const task of ['t-1', 't-2']) {
      const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
      const p = await fake.next()
      await p.submit(task)
      p.finish({ ok: false, message: '超时', pendingTaskId: task })
      await run.done
    }
    const [v1, v2] = (await node(ws.root, ids.$v!)).versions
    const got = await svc.retrieve(ws, PATH, ids.$v!, v1!.id, { media: fake.port })
    const r = await fake.next()
    expect(r.call.resumeTaskId).toBe('t-1')
    r.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    await got.done
    // 当前版指向 t-2；取回第一版后仍是待取回，指向 t-2。
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toEqual({
      state: 'pending',
      version: v2!.id,
    })
  })

  test('两个工作区根下同名画布、同一个节点 id 同时运行互不影响', async () => {
    const one = await setup(VIDEO_CARD)
    const two = await setup([])
    await writeFile(join(two.ws.root, PATH), await readFile(join(one.ws.root, PATH), 'utf8'))
    const svc = one.svc
    const id = one.ids.$v!
    const fake = fakePort()
    const a = await svc.run(one.ws, PATH, id, { media: fake.port })
    const b = await svc.run({ id: 'ws2', root: two.ws.root }, PATH, id, { media: fake.port })
    const [pa, pb] = [await fake.next(), await fake.next()]
    pa.finish({ ok: false, message: 'a' })
    await a.done
    expect((await svc.read(two.ws.root, PATH)).states[id]).toMatchObject({ state: 'running' })
    pb.finish({ ok: false, message: 'b' })
    expect(await b.done).toMatchObject({ message: 'b' })
    expect((await svc.read(one.ws.root, PATH)).states[id]).toEqual({
      state: 'failed',
      message: 'a',
    })
    expect((await svc.read(two.ws.root, PATH)).states[id]).toEqual({
      state: 'failed',
      message: 'b',
    })
  })
})
