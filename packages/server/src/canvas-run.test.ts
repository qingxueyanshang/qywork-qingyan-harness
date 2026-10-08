/**
 * 覆盖 `canvas.ts` 的运行、取回与取消（`run` / `retrieve` / `cancel`），以及 `canvas.run` 与 `file.changed` 的时序。
 *
 * 生成端口为模拟实现：每次调用返回一个可从外部推进的句柄（任务号回调、完成、失败），
 * 测试据此控制「生成进行到一半」的时刻。中止信号到达时调用以中止原因拒绝，与真实端口一致。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { MediaCall, MediaCallResult, MediaPort } from '@qywork/agent'
import { findMediaModel } from '@qywork/ai'
import {
  type AgentEvent,
  ART_MENTION,
  ART_SIZE_PARAM,
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

/** 带真实 IHDR 的 PNG 头：服务端从这 24 字节读取宽高。 */
function pngHead(w: number, h: number): Uint8Array {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'latin1')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return new Uint8Array(b)
}

/** 一次端口调用：`submit` 触发任务号回调，`finish` 使调用返回。 */
interface Pending {
  call: MediaCall
  submit(taskId?: string): Promise<void>
  finish(result: MediaCallResult): void
}

function fakePort(): { port: MediaPort; calls: Pending[]; next(): Promise<Pending> } {
  const calls: Pending[] = []
  const waiters: ((p: Pending) => void)[] = []
  const port: MediaPort = {
    generate(call, signal) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
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
  test('隐藏参数不写入请求或历史记录，原选择保留并在恢复模式后重新发送', async () => {
    const model = findMediaModel('wan2.7-image-pro')!
    const prefs = { size: '4K', thinking_mode: true, seed: 42 }
    const { ws, ids } = await setup([
      { op: 'add_file', ref: '$i', path: 'a.png' },
      {
        op: 'add_generate',
        ref: '$g',
        output: 'image',
        prompt: '一只猫',
        provider: 'qwen',
        model: model.id,
        params: prefs,
      },
      { op: 'connect', ref: '$e', from: '$i', to: '$g', role: 'reference' },
    ])
    const svc = new CanvasService({ publish: () => {}, paramSpecsOf: () => model.params })
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    const first = await fake.next()
    expect(first.call.params).toEqual({ seed: 42 })
    first.finish({
      ok: true,
      provider: 'qwen',
      model: model.id,
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    expect(await run.done).toMatchObject({ ok: true })
    const saved = await node(ws.root, ids.$g!)
    expect(saved.params).toEqual(prefs)
    expect(saved.versions[0]!.made.params).toEqual({ seed: 42 })
    await svc.apply(ws.root, PATH, [{ op: 'remove', id: ids.$e! }])
    const again = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    const second = await fake.next()
    expect(second.call.params).toEqual(prefs)
    second.finish({
      ok: true,
      provider: 'qwen',
      model: model.id,
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    expect(await again.done).toMatchObject({ ok: true })
  })
  test('成功后追加版本；made 记录编译后的提示词，之后修改提示词不影响它', async () => {
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

  test('落盘的图片带像素宽高，卡片的框改为图片的比例、短边不变', async () => {
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
    expect({ w: g.w, h: g.h }).toEqual({ w: 169, h: 254 })
  })

  test('事件依次是 running → file.changed（版本、生成记录各一次）→ done', async () => {
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
      'file.changed',
      'run:done',
    ])
    expect(events[0]).toMatchObject({ workspaceId: 'ws1', path: PATH, nodeId: ids.$g })
  })

  test('生成图片失败：failed 带原文，状态显示原文；画布只增加一条生成记录', async () => {
    const { ws, svc, ids, events } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({ ok: false, message: '内容审核未通过' })
    expect(await done).toEqual({ ok: false, message: '内容审核未通过', pending: false })
    expect(events.map((e) => e.type)).toEqual(['canvas.run', 'file.changed', 'canvas.run'])
    expect(events[2]).toMatchObject({ state: 'failed', message: '内容审核未通过' })
    expect((await node(ws.root, ids.$g!)).versions).toEqual([])
    expect((await svc.read(ws.root, PATH)).states[ids.$g!]).toEqual({
      state: 'failed',
      message: '内容审核未通过',
    })
  })

  test('提示词为空、输入的生成节点尚无结果时不调用端口', async () => {
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
      '尚无结果',
    )
    expect(fake.calls).toHaveLength(0)
  })

  test('输入来自另一个生成节点时取其当前版本', async () => {
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

describe('画布运行：Art', () => {
  const page = (w: number, h: number, body: string) =>
    new TextEncoder().encode(
      `<!doctype html><html><head><meta name="viewport" content="width=${w}, height=${h}"></head><body>${body}</body></html>`,
    )

  test('再次运行时当前页面作为第一项参考输入；参考图按「图n」编号；产物尺寸取自 viewport，框随之调整', async () => {
    const { ws, ids } = await setup([
      { op: 'add_file', ref: '$a', path: 'a.png', name: '街口' },
      { op: 'add_generate', ref: '$g', output: 'art', prompt: '按 @[$a] 搭白模' },
      { op: 'update', id: '$g', params: { size: '720x1280', n: 4 } },
    ])
    // 与 server.ts 的装配相同：art 的参数表与指代写法固定。
    const svc = new CanvasService({
      publish: () => {},
      paramSpecsOf: (o) => (o === 'art' ? [ART_SIZE_PARAM] : undefined),
      mentionStyleOf: (o) => (o === 'art' ? ART_MENTION : undefined),
    })
    const fake = fakePort()
    const first = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    const p1 = await fake.next()
    expect(p1.call.type).toBe('art')
    expect(p1.call.prompt).toBe('按 图1 搭白模')
    expect(p1.call.params).toEqual({ size: '720x1280' })
    // 端口收到的是绝对路径。
    const rel = (abs: string) => relative(ws.root, abs).replaceAll('\\', '/')
    expect(p1.call.inputs.map((i) => rel(i.path))).toEqual(['a.png'])
    p1.finish({
      ok: true,
      provider: 'relay',
      model: 'chat',
      files: [{ bytes: page(720, 1280, '一'), mime: 'text/html' }],
    })
    expect(await first.done).toMatchObject({ ok: true })
    const g1 = await node(ws.root, ids.$g!)
    const v1 = g1.versions[0]!
    expect(v1.path).toMatch(/^generated\/\d{8}-\d{6}\.html$/)
    expect(v1.size).toEqual({ w: 720, h: 1280 })
    expect({ w: g1.w, h: g1.h }).toEqual({ w: 169, h: 300 })

    const second = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    const p2 = await fake.next()
    expect(p2.call.inputs.map((i) => [rel(i.path), i.mime])).toEqual([
      [v1.path, 'text/html'],
      ['a.png', 'image/png'],
    ])
    p2.finish({
      ok: true,
      provider: 'relay',
      model: 'chat',
      files: [{ bytes: page(720, 1280, '二'), mime: 'text/html' }],
    })
    expect(await second.done).toMatchObject({ ok: true })
    const g2 = await node(ws.root, ids.$g!)
    expect(g2.versions).toHaveLength(2)
    expect(g2.versions[1]!.made.inputs[0]).toEqual({ role: 'reference', path: v1.path })
  })
})

describe('画布运行：视频', () => {
  test('取得任务号即追加一版指向任务记录，状态为生成中；成功后改为指向产物并删除记录', async () => {
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
    // 运行中再次运行、取回、删除节点、删除该版本均被拒绝。
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

  test('模型返回尾帧：视频写入版本，尾帧图增加一个节点，名称为 <卡片名>_尾帧，位于卡片右侧', async () => {
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

  test('等待超时：该版本保留，状态为待取回；取回后改为指向产物', async () => {
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

  test('远端明确失败：删除该版本与任务记录，最近失败带原文', async () => {
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

  test('生成期间删除同一卡片的另一个旧版本，成功后回写的仍是正确的版本', async () => {
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

  test('生成期间画布被外部改写、节点已删除：产物照常落盘，failed 原文写明产物路径', async () => {
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

  test('一张卡有两个待取回版本时按版本 id 分别取回', async () => {
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
    // 当前版本指向 t-2；取回第一版后仍为待取回，指向 t-2。
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

describe('画布运行：取消', () => {
  const finished = {
    ok: true as const,
    provider: 'ark',
    model: 'seedance',
    files: [{ bytes: MP4, mime: 'video/mp4' }],
  }

  test('远端撤销成功：停止本地等待，删除该版本与任务记录，不记录失败，卡片恢复到生成之前', async () => {
    const { ws, svc, events, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-1')
    const asked: unknown[] = []
    const outcome = await svc.cancel(ws.root, PATH, ids.$v!, async (task) => {
      asked.push(task)
      return 'cancelled'
    })
    expect(outcome).toBe('cancelled')
    expect(asked).toEqual([
      {
        taskId: 't-1',
        provider: 'ark',
        model: 'seedance',
        record: expect.any(String),
        versionId: expect.any(String),
      },
    ])
    expect(await done).toEqual({ ok: false, message: '已取消生成', pending: false })
    expect((await node(ws.root, ids.$v!)).versions).toEqual([])
    expect(await readdir(join(ws.root, 'generated'))).toEqual([])
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toEqual({ state: 'empty' })
    expect(events.at(-1)).toMatchObject({ type: 'canvas.run', state: 'done' })
  })

  test('远端已开始：无法撤销，生成照常进行到成功', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-1')
    expect(await svc.cancel(ws.root, PATH, ids.$v!, async () => 'started')).toBe('started')
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toMatchObject({ state: 'running' })
    p.finish(finished)
    expect(await done).toMatchObject({ ok: true })
    expect((await node(ws.root, ids.$v!)).versions[0]!.path).toMatch(/\.mp4$/)
  })

  test('尚未取得任务号时先等待，取得后再撤销；图像等一次请求的生成不撤销；未在生成时返回 409', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    let asked = 0
    const cancelling = svc.cancel(ws.root, PATH, ids.$v!, async () => {
      asked++
      return 'cancelled'
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(asked).toBe(0)
    await p.submit('t-1')
    expect(await cancelling).toBe('cancelled')
    expect(asked).toBe(1)
    await done
    expect(
      (await failure(svc.cancel(ws.root, PATH, ids.$v!, async () => 'cancelled'))).status,
    ).toBe(409)

    const image = await setup(IMAGE_CARD)
    const imageFake = fakePort()
    const run = await image.svc.run(image.ws, PATH, image.ids.$g!, { media: imageFake.port })
    const q = await imageFake.next()
    expect(
      await image.svc.cancel(image.ws.root, PATH, image.ids.$g!, async () => 'cancelled'),
    ).toBe('unsupported')
    q.finish({
      ok: true,
      provider: 'ark',
      model: 'img',
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    expect(await run.done).toMatchObject({ ok: true })
  })

  test('取回期间也能撤销：任务号从任务记录中读取', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-9')
    p.finish({ ok: false, message: '等待超时', pendingTaskId: 't-9' })
    await run.done
    const again = await svc.retrieve(ws, PATH, ids.$v!, undefined, { media: fake.port })
    await fake.next()
    const asked: { taskId: string }[] = []
    const outcome = await svc.cancel(ws.root, PATH, ids.$v!, async (task) => {
      asked.push(task)
      return 'cancelled'
    })
    expect(outcome).toBe('cancelled')
    expect(asked[0]!.taskId).toBe('t-9')
    expect(await again.done).toMatchObject({ ok: false, message: '已取消生成' })
    expect((await node(ws.root, ids.$v!)).versions).toEqual([])
  })
})

describe('画布运行：排队中与生成中', () => {
  test('平台报告的状态写入卡片状态，变化时才发送 canvas.run；无法识别的状态词不修改状态', async () => {
    const { ws, svc, events, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-1')
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).not.toHaveProperty('phase')
    const runningEvents = () =>
      events.filter((e) => e.type === 'canvas.run' && e.state === 'running').length
    const before = runningEvents()
    p.call.onStatus?.('PENDING')
    p.call.onStatus?.('PENDING')
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toMatchObject({
      state: 'running',
      phase: 'queued',
    })
    expect(runningEvents()).toBe(before + 1)
    p.call.onStatus?.('RUNNING')
    p.call.onStatus?.('WHATEVER')
    expect((await svc.read(ws.root, PATH)).states[ids.$v!]).toMatchObject({ phase: 'running' })
    expect(runningEvents()).toBe(before + 2)
    p.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    await done
  })
})

describe('画布运行：生成记录', () => {
  const spend = (cost: number) => ({
    kind: 'ark_videos' as const,
    provider: 'ark',
    model: 'seedance',
    output: 'video' as const,
    quantity: 5,
    cost,
    currency: 'CNY' as const,
    at: Date.now(),
  })

  test('成功：一条 done，记录发出的提示词、参数、输入、接口、模型与花费', async () => {
    const { ws, svc, ids } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    const p = await fake.next()
    p.call.onSpend?.({ ...spend(0.2), kind: 'dashscope_images', output: 'image', quantity: 1 })
    p.finish({
      ok: true,
      provider: 'qwen',
      model: 'img',
      files: [{ bytes: PNG, mime: 'image/png' }],
    })
    await done
    const runs = (await onDisk(ws.root)).runs ?? []
    expect(runs).toEqual([
      {
        node: ids.$g!,
        action: 'run',
        start: expect.any(String),
        end: expect.any(String),
        result: 'done',
        provider: 'qwen',
        model: 'img',
        prompt: '小满 戴一顶帽子',
        params: {},
        inputs: [{ role: 'reference', path: 'a.png' }],
        cost: 0.2,
        currency: 'CNY',
      },
    ])
    expect(Date.parse(runs[0]!.end)).toBeGreaterThanOrEqual(Date.parse(runs[0]!.start))
  })

  test('失败：一条 failed，带失败原文、没有花费；重启后原文仍在画布文件中', async () => {
    const { ws, svc, ids } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({ ok: false, message: 'qwen / img：内容审核未通过' })
    await done
    const fresh = new CanvasService({ publish: () => {} })
    const runs = (await fresh.read(ws.root, PATH)).doc.runs ?? []
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ result: 'failed', message: 'qwen / img：内容审核未通过' })
    expect(runs[0]).not.toHaveProperty('cost')
  })

  test('视频超时留待取回、之后取回成功：两条记录，任务号相同，花费记在取回的记录上', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const run = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    const p = await fake.next()
    await p.submit('t-9')
    p.finish({ ok: false, message: '等待超过 20 分钟仍未完成', pendingTaskId: 't-9' })
    await run.done
    const again = await svc.retrieve(ws, PATH, ids.$v!, undefined, { media: fake.port })
    const r = await fake.next()
    r.call.onSpend?.(spend(1.5))
    r.finish({
      ok: true,
      provider: 'ark',
      model: 'seedance',
      files: [{ bytes: MP4, mime: 'video/mp4' }],
    })
    await again.done
    const runs = (await onDisk(ws.root)).runs ?? []
    expect(runs.map((x) => [x.action, x.result, x.task, x.provider, x.model, x.cost])).toEqual([
      ['run', 'pending', 't-9', 'ark', 'seedance', undefined],
      ['retrieve', 'done', 't-9', 'ark', 'seedance', 1.5],
    ])
    expect(runs[0]!.message).toBe('等待超过 20 分钟仍未完成')
    expect(runs[1]).not.toHaveProperty('prompt')
  })

  test('排队中撤销：一条 cancelled，不记录失败原文', async () => {
    const { ws, svc, ids } = await setup(VIDEO_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$v!, { media: fake.port })
    await (await fake.next()).submit('t-1')
    await svc.cancel(ws.root, PATH, ids.$v!, async () => 'cancelled')
    await done
    const runs = (await onDisk(ws.root)).runs ?? []
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ result: 'cancelled', task: 't-1' })
    expect(runs[0]).not.toHaveProperty('message')
  })

  test('删除生成卡之后记录仍保留', async () => {
    const { ws, svc, ids } = await setup(IMAGE_CARD)
    const fake = fakePort()
    const { done } = await svc.run(ws, PATH, ids.$g!, { media: fake.port })
    ;(await fake.next()).finish({ ok: false, message: '失败' })
    await done
    await svc.apply(ws.root, PATH, [{ op: 'remove', id: ids.$g! }])
    const doc = await onDisk(ws.root)
    expect(doc.nodes.some((n) => n.id === ids.$g)).toBe(false)
    expect(doc.runs?.map((x) => x.node)).toEqual([ids.$g!])
  })
})
