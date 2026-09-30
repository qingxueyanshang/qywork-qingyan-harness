/**
 * 覆盖 `canvas.ts` 的画布服务：串行写入、改名前复读、写失败不留半截、路径边界、节点状态、取帧与上传。
 * 生成、取回与通知时序在 `canvas-run.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentEvent,
  addVersions,
  applyCanvasOps,
  type CanvasDoc,
  emptyCanvas,
  parseCanvas,
  serializeCanvas,
} from '@qywork/core'
import { CanvasFailure, type CanvasIo, CanvasService } from './canvas.ts'

const PATH = 'board.canvas.json'

async function workspace(doc: CanvasDoc = emptyCanvas()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-canvas-'))
  await mkdir(join(root, '角色'), { recursive: true })
  for (let i = 0; i < 60; i++) await writeFile(join(root, '角色', `${i}.png`), 'png')
  await writeFile(join(root, PATH), serializeCanvas(doc))
  return root
}

function service(io?: Partial<CanvasIo>): { svc: CanvasService; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  return {
    svc: new CanvasService({ publish: (e) => events.push(e), ...(io ? { io } : {}) }),
    events,
  }
}

async function onDisk(root: string): Promise<CanvasDoc> {
  const r = parseCanvas(await readFile(join(root, PATH), 'utf8'))
  if (!r.ok) throw new Error(r.error)
  return r.doc
}

function withNodes(count: number): CanvasDoc {
  const r = applyCanvasOps(
    emptyCanvas(),
    Array.from({ length: count }, (_, i) => ({ op: 'add_file' as const, path: `角色/${i}.png` })),
  )
  if (!r.ok) throw new Error(r.error)
  return r.doc
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

describe('画布服务：写入', () => {
  test('同一画布并发 50 次移动加 50 次新建，100 条全在', async () => {
    const seed = withNodes(10)
    const root = await workspace(seed)
    const { svc } = service()
    const moved = seed.nodes.map((n) => n.id)
    await Promise.all([
      ...Array.from({ length: 50 }, (_, i) =>
        svc.apply(root, PATH, [{ op: 'update', id: moved[i % 10]!, x: 1000 + i }]),
      ),
      ...Array.from({ length: 50 }, (_, i) =>
        svc.apply(root, PATH, [{ op: 'add_file', path: `角色/${10 + i}.png`, name: `n${i}` }]),
      ),
    ])
    const doc = await onDisk(root)
    expect(doc.nodes).toHaveLength(60)
    for (let i = 0; i < 50; i++) expect(doc.nodes.some((n) => n.name === `n${i}`)).toBe(true)
    // 每个节点最后一次移动是 i = 40..49 那一轮。
    for (const [k, id] of moved.entries()) {
      expect(doc.nodes.find((n) => n.id === id)?.x).toBe(1040 + k)
    }
  })

  test('两次操作之间外部改写文件，第二次基于新内容', async () => {
    const root = await workspace()
    const { svc } = service()
    await svc.apply(root, PATH, [{ op: 'add_file', path: '角色/0.png', name: '界面' }])
    const outside = applyCanvasOps(await onDisk(root), [
      { op: 'add_file', path: '角色/1.png', name: '外部' },
    ])
    if (!outside.ok) throw new Error(outside.error)
    await writeFile(join(root, PATH), serializeCanvas(outside.doc))
    await svc.apply(root, PATH, [{ op: 'add_file', path: '角色/2.png', name: '再一次' }])
    expect((await onDisk(root)).nodes.map((n) => n.name)).toEqual(['界面', '外部', '再一次'])
  })

  test('读完、改名前外部改写文件，外部改动与本次操作都在', async () => {
    const root = await workspace()
    let injected = false
    const { svc } = service({
      writeFile: async (p, t) => {
        await writeFile(p, t, 'utf8')
        if (injected || !p.endsWith('.part')) return
        injected = true
        const outside = applyCanvasOps(await onDisk(root), [
          { op: 'add_file', path: '角色/1.png', name: '外部' },
        ])
        if (!outside.ok) throw new Error(outside.error)
        await writeFile(join(root, PATH), serializeCanvas(outside.doc))
      },
    })
    await svc.apply(root, PATH, [{ op: 'add_file', path: '角色/0.png', name: '本次' }])
    expect(injected).toBe(true)
    expect((await onDisk(root)).nodes.map((n) => n.name).sort()).toEqual(['外部', '本次'])
  })

  test('写入中途抛错不留 .part，原文件字节不变', async () => {
    const root = await workspace(withNodes(1))
    const before = await readFile(join(root, PATH), 'utf8')
    const { svc, events } = service({
      writeFile: async (p, t) => {
        await writeFile(p, t.slice(0, 10), 'utf8')
        throw new Error('磁盘满')
      },
    })
    await expect(svc.apply(root, PATH, [{ op: 'add_file', path: '角色/1.png' }])).rejects.toThrow(
      '磁盘满',
    )
    expect(await readFile(join(root, PATH), 'utf8')).toBe(before)
    expect((await readdir(root)).some((f) => f.endsWith('.part'))).toBe(false)
    expect(events).toHaveLength(0)
  })

  test('坏 JSON 时操作被拒且文件字节不变', async () => {
    const root = await workspace()
    await writeFile(join(root, PATH), '{"version":1,')
    const { svc } = service()
    const err = await failure(svc.apply(root, PATH, [{ op: 'add_file', path: '角色/0.png' }]))
    expect(err.status).toBe(422)
    expect(err.message).toContain('格式错误')
    expect(await readFile(join(root, PATH), 'utf8')).toBe('{"version":1,')
  })

  test('工作区外、`..`、不存在的路径都被拒', async () => {
    const root = await workspace()
    const outside = await mkdtemp(join(tmpdir(), 'qywork-outside-'))
    await writeFile(join(outside, 'x.png'), 'png')
    const { svc } = service()
    expect(
      (await failure(svc.apply(root, PATH, [{ op: 'add_file', path: join(outside, 'x.png') }])))
        .status,
    ).toBe(422)
    expect(
      (await failure(svc.apply(root, PATH, [{ op: 'add_file', path: '../x.png' }]))).status,
    ).toBe(422)
    expect(
      (await failure(svc.apply(root, PATH, [{ op: 'add_file', path: '角色/没有.png' }]))).status,
    ).toBe(422)
    expect((await failure(svc.read(root, '../other.canvas.json'))).status).toBe(404)
    expect((await failure(svc.read(root, '角色/0.png'))).status).toBe(422)
  })

  test('反斜杠路径规范成正斜杠相对路径', async () => {
    const root = await workspace()
    const { svc } = service()
    const { doc } = await svc.apply(root, PATH, [{ op: 'add_file', path: '角色\\3.png' }])
    expect(doc.nodes[0]).toMatchObject({ type: 'file', path: '角色/3.png' })
  })

  test('写盘发一条空 changes 的 file.changed；没有变化不写不发', async () => {
    const root = await workspace(withNodes(1))
    const { svc, events } = service()
    const id = (await onDisk(root)).nodes[0]!.id
    await svc.apply(root, PATH, [{ op: 'update', id, x: 5 }])
    expect(events).toEqual([{ type: 'file.changed', runId: null, changes: [] }])
    await svc.apply(root, PATH, [{ op: 'update', id, x: 5 }])
    expect(events).toHaveLength(1)
  })

  test('新建画布：在工作区根按时间命名，重名加序号', async () => {
    const root = await workspace()
    const { svc } = service()
    const now = new Date(2026, 8, 29, 10, 0, 0)
    expect(await svc.create(root, now)).toBe('canvas-20260929-100000.canvas.json')
    expect(await svc.create(root, now)).toBe('canvas-20260929-100000-2.canvas.json')
    const view = await svc.read(root, 'canvas-20260929-100000-2.canvas.json')
    expect(view.doc.nodes).toEqual([])
  })
})

describe('画布服务：节点状态', () => {
  test('缺失、空、待取回、正常', async () => {
    let doc = withNodes(1)
    const gen = applyCanvasOps(doc, [{ op: 'add_generate', output: 'video' }])
    if (!gen.ok) throw new Error(gen.error)
    doc = gen.doc
    const video = doc.nodes[1]!.id
    const root = await workspace(doc)
    const { svc } = service()
    const file = doc.nodes[0]!.id

    let view = await svc.read(root, PATH)
    expect(view.states[file]).toEqual({ state: 'normal' })
    expect(view.states[video]).toEqual({ state: 'empty' })

    await rm(join(root, '角色', '0.png'))
    view = await svc.read(root, PATH)
    expect(view.states[file]).toEqual({ state: 'missing' })

    // 替换路径后恢复正常。
    await svc.apply(root, PATH, [{ op: 'update', id: file, path: '角色/1.png' }])
    expect((await svc.read(root, PATH)).states[file]).toEqual({ state: 'normal' })

    // 一版正常的旧产物 + 一版还在远端的任务记录。
    await writeFile(join(root, 'old.mp4'), 'mp4')
    const made = { prompt: '', provider: 'q', model: 'm', params: {}, inputs: [], at: 't' }
    await svc.mutate(root, PATH, (d) =>
      addVersions(d, video, [{ id: 'old', path: 'old.mp4', made }]),
    )
    await svc.mutate(root, PATH, (d) =>
      addVersions(d, video, [{ id: 'task', path: 'x.task.json', made }]),
    )
    expect((await svc.read(root, PATH)).states[video]).toEqual({
      state: 'pending',
      version: 'task',
    })

    // 当前版切到更早那一版（文件正常），仍是待取回。
    await svc.apply(root, PATH, [{ op: 'update', id: video, current: 'old' }])
    expect((await svc.read(root, PATH)).states[video]).toEqual({
      state: 'pending',
      version: 'task',
    })

    await svc.apply(root, PATH, [{ op: 'remove', id: video, version: 'task' }])
    expect((await svc.read(root, PATH)).states[video]).toEqual({ state: 'normal' })
  })
})

describe('画布服务：撤销与重做', () => {
  test('撤销换回编辑前那一份、重做换回编辑后那一份；删掉的生成卡连同版本一起回来', async () => {
    const seeded = applyCanvasOps(emptyCanvas(), [
      { op: 'add_generate', ref: '$g', output: 'image', name: '图片1', x: 0, y: 0 },
    ])
    if (!seeded.ok) throw new Error(seeded.error)
    const withVersion = addVersions(seeded.doc, seeded.refs.$g!, [
      {
        id: 'v1',
        path: 'generated/1.png',
        made: {
          prompt: '猫',
          provider: 'p',
          model: 'm',
          params: {},
          inputs: [],
          at: '2026-09-30T00:00:00Z',
        },
      },
    ])
    if (!withVersion.ok) throw new Error(withVersion.error)
    const root = await workspace(withVersion.doc)
    const { svc } = service()
    const card = seeded.refs.$g!
    const removed = await svc.apply(root, PATH, [{ op: 'remove', id: card }])
    expect((await onDisk(root)).nodes).toHaveLength(0)

    const undone = await svc.restore(root, PATH, removed.step.after, removed.step.before)
    const back = (await onDisk(root)).nodes[0]
    expect(back).toMatchObject({ id: card, current: 'v1' })
    expect(undone.after).toBe(removed.step.before)

    await svc.restore(root, PATH, removed.step.before, removed.step.after)
    expect((await onDisk(root)).nodes).toHaveLength(0)
  })

  test('中间被别处改过就拒绝撤销（409），不覆盖；记录里没有的指纹回 404', async () => {
    const root = await workspace()
    const { svc } = service()
    const first = await svc.apply(root, PATH, [{ op: 'add_generate', output: 'image', x: 0, y: 0 }])
    await svc.apply(root, PATH, [{ op: 'add_generate', output: 'video', x: 300, y: 0 }])
    await expect(
      svc.restore(root, PATH, first.step.after, first.step.before),
    ).rejects.toMatchObject({ status: 409 })
    expect((await onDisk(root)).nodes).toHaveLength(2)
    await expect(
      svc.restore(root, PATH, first.step.after, '0000000000000000'),
    ).rejects.toMatchObject({
      status: 404,
    })
  })
})

describe('画布服务：上传', () => {
  const BYTES = new Uint8Array([1, 2, 3])

  test('原名落进 uploads/，重名加 -2；第一个以给定点为中心，第二个排在第一个右侧', async () => {
    const root = await workspace()
    const { svc } = service()
    const first = await svc.upload(root, PATH, '小满 正面.png', BYTES, {
      near: { x: 230, y: 162.5 },
    })
    expect(first.path).toBe('uploads/小满 正面.png')
    const second = await svc.upload(root, PATH, '小满 正面.png', BYTES, { beside: first.nodeId })
    expect(second.path).toBe('uploads/小满 正面-2.png')
    const doc = await onDisk(root)
    const a = doc.nodes.find((n) => n.id === first.nodeId)!
    const b = doc.nodes.find((n) => n.id === second.nodeId)!
    expect(a).toMatchObject({ type: 'file', x: 120, y: 80, w: 220, h: 165 })
    expect(b.x).toBeGreaterThan(a.x + a.w)
    expect(new Uint8Array(await readFile(join(root, first.path)))).toEqual(BYTES)
  })

  test('系统拖入：工作区里的直接引用，工作区外的复制进 uploads/；不存在回 404、目录回 422', async () => {
    const root = await workspace()
    await mkdir(join(root, '角色'), { recursive: true })
    await writeFile(join(root, '角色', '小满.png'), 'png')
    const outside = await mkdtemp(join(tmpdir(), 'qywork-outside-'))
    await writeFile(join(outside, '街景.png'), 'street')
    const { svc } = service()
    const ids = await svc.importPaths(
      root,
      PATH,
      [join(root, '角色', '小满.png'), join(outside, '街景.png')],
      { x: 0, y: 0 },
    )
    const doc = await onDisk(root)
    const paths = ids.map((id) => (doc.nodes.find((n) => n.id === id) as { path: string }).path)
    expect(paths).toEqual(['角色/小满.png', 'uploads/街景.png'])
    expect(await readFile(join(root, 'uploads', '街景.png'), 'utf8')).toBe('street')
    await expect(
      svc.importPaths(root, PATH, [join(outside, '没有.png')], { x: 0, y: 0 }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(svc.importPaths(root, PATH, [outside], { x: 0, y: 0 })).rejects.toMatchObject({
      status: 422,
    })
    await rm(outside, { recursive: true, force: true })
  })

  test('未登记的类型保持原扩展名', async () => {
    const root = await workspace()
    const { svc } = service()
    const r = await svc.upload(root, PATH, '剧本.md', BYTES, { near: { x: 0, y: 0 } })
    expect(r.path).toBe('uploads/剧本.md')
  })

  test('文件名带路径分隔符或是 .. 回 422，不落盘', async () => {
    const root = await workspace()
    const { svc } = service()
    for (const name of ['../x.png', 'a/b.png', 'a\\b.png', '..']) {
      await expect(
        svc.upload(root, PATH, name, BYTES, { near: { x: 0, y: 0 } }),
      ).rejects.toMatchObject({
        status: 422,
      })
    }
    expect((await onDisk(root)).nodes).toHaveLength(0)
    expect(await readdir(root)).not.toContain('uploads')
  })
})

describe('画布服务：取帧', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

  async function withVideo(): Promise<{ root: string; video: string }> {
    const r = applyCanvasOps(emptyCanvas(), [
      { op: 'add_file', ref: '$v', path: 'clip.mp4', name: '视频1', x: 100, y: 40, w: 300, h: 169 },
    ])
    if (!r.ok) throw new Error(r.error)
    const root = await workspace(r.doc)
    await writeFile(join(root, 'clip.mp4'), 'mp4')
    return { root, video: r.refs.$v! }
  }

  test('落成 generated/<视频名>_尾帧.png，重名加 -2；节点在视频右侧，第二帧排在第一帧下方', async () => {
    const { root, video } = await withVideo()
    const { svc } = service()
    const first = await svc.captureFrame(root, PATH, video, '尾帧', PNG)
    expect(first.path).toBe('generated/视频1_尾帧.png')
    const second = await svc.captureFrame(root, PATH, video, '尾帧', PNG)
    expect(second.path).toBe('generated/视频1_尾帧-2.png')
    const doc = await onDisk(root)
    const node = doc.nodes.find((n) => n.id === first.nodeId)!
    expect(node).toMatchObject({ type: 'file', path: 'generated/视频1_尾帧.png', x: 500, y: 40 })
    const below = doc.nodes.find((n) => n.id === second.nodeId)!
    expect(below.x).toBe(500)
    expect(below.y).toBeGreaterThanOrEqual(node.y + node.h)
    expect(new Uint8Array(await readFile(join(root, first.path)))).toEqual(PNG)
  })

  test('不是 PNG 回 422；不是视频节点回 422，都不落盘', async () => {
    const { root, video } = await withVideo()
    const { svc } = service()
    expect(
      (await failure(svc.captureFrame(root, PATH, video, '首帧', new Uint8Array([1, 2])))).status,
    ).toBe(422)
    const other = await svc.apply(root, PATH, [{ op: 'add_file', path: '角色/0.png' }])
    const image = other.doc.nodes.at(-1)!.id
    expect((await failure(svc.captureFrame(root, PATH, image, '首帧', PNG))).status).toBe(422)
    expect((await readdir(root)).includes('generated')).toBe(false)
  })
})
