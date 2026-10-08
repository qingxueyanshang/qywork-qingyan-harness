/**
 * 覆盖 `canvas.ts` 的画布服务：串行写入、改名前重新读取、写入失败不遗留不完整文件、路径边界、节点状态、
 * 取帧、时间线导出的上传会话、时间线片段核对与上传。
 * 生成、取回与通知时序由 `canvas-run.test.ts` 覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
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
  test('同一画布并发 50 次移动与 50 次新建，100 条全部保留', async () => {
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
    // 每个节点的最后一次移动属于 i = 40..49 这一轮。
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

  test('读取后、改名前外部改写文件，外部改动与本次操作均保留', async () => {
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

  test('写入中途抛出错误时不遗留 .part，原文件字节不变', async () => {
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

  test('JSON 无效时操作被拒绝且文件字节不变', async () => {
    const root = await workspace()
    await writeFile(join(root, PATH), '{"version":1,')
    const { svc } = service()
    const err = await failure(svc.apply(root, PATH, [{ op: 'add_file', path: '角色/0.png' }]))
    expect(err.status).toBe(422)
    expect(err.message).toContain('格式错误')
    expect(await readFile(join(root, PATH), 'utf8')).toBe('{"version":1,')
  })

  test('工作区外、`..`、不存在的路径均被拒绝', async () => {
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

  test('反斜杠路径规范化为正斜杠相对路径', async () => {
    const root = await workspace()
    const { svc } = service()
    const { doc } = await svc.apply(root, PATH, [{ op: 'add_file', path: '角色\\3.png' }])
    expect(doc.nodes[0]).toMatchObject({ type: 'file', path: '角色/3.png' })
  })

  test('写盘时发送一条 changes 为空的 file.changed；没有变化时不写盘也不发送', async () => {
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

    // 一版正常的旧产物 + 一版仍在远端的任务记录。
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

    // 当前版本切换到更早的版本（文件正常），仍为待取回。
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
  test('撤销恢复编辑前的文档、重做恢复编辑后的文档；已删除的生成卡连同版本一起恢复', async () => {
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

  test('期间被其他来源修改时拒绝撤销（409），不覆盖；记录中没有的指纹返回 404', async () => {
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

  test('按原名写入 uploads/，重名加 -2；第一个以给定点为中心，第二个排在第一个右侧', async () => {
    const root = await workspace()
    const { svc } = service()
    const first = await svc.upload(root, PATH, '小满 正面.png', BYTES, {
      near: { x: 232.5, y: 164.5 },
    })
    expect(first.path).toBe('uploads/小满 正面.png')
    const second = await svc.upload(root, PATH, '小满 正面.png', BYTES, { beside: first.nodeId })
    expect(second.path).toBe('uploads/小满 正面-2.png')
    const doc = await onDisk(root)
    const a = doc.nodes.find((n) => n.id === first.nodeId)!
    const b = doc.nodes.find((n) => n.id === second.nodeId)!
    expect(a).toMatchObject({ type: 'file', x: 120, y: 80, w: 225, h: 169 })
    expect(b.x).toBeGreaterThan(a.x + a.w)
    expect(new Uint8Array(await readFile(join(root, first.path)))).toEqual(BYTES)
  })

  test('节点的框按文件头读出的比例确定：上传与从文件树拖入使用同一条路径', async () => {
    const root = await workspace()
    const { svc } = service()
    const head = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
    head.writeUInt32BE(13, 8)
    head.write('IHDR', 12, 'latin1')
    head.writeUInt32BE(1536, 16)
    head.writeUInt32BE(1024, 20)
    const wide = await svc.upload(root, PATH, '横图.png', new Uint8Array(head), {
      near: { x: 0, y: 0 },
    })
    // 从文件树拖入经由同一条核验路径。
    await writeFile(
      join(root, '竖图.png'),
      (() => {
        const b = Buffer.from(head)
        b.writeUInt32BE(1024, 16)
        b.writeUInt32BE(1536, 20)
        return b
      })(),
    )
    const { refs } = await svc.apply(root, PATH, [{ op: 'add_file', ref: '$t', path: '竖图.png' }])
    const doc = await onDisk(root)
    const box = (id: string) => {
      const n = doc.nodes.find((x) => x.id === id)!
      return { w: n.w, h: n.h }
    }
    expect(box(wide.nodeId)).toEqual({ w: 254, h: 169 })
    expect(box(refs.$t!)).toEqual({ w: 169, h: 254 })
  })

  test('系统拖入：工作区中的文件直接引用，工作区外的文件复制到 uploads/；不存在时返回 404、目录返回 422', async () => {
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

  test('文件名含路径分隔符或为 .. 时返回 422，不落盘', async () => {
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

  test('保存为 generated/<视频名>_尾帧.png，重名加 -2；节点位于视频右侧，第二帧排在第一帧下方', async () => {
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

  test('按时刻截取的帧名称带小数点，仍保存为 .png', async () => {
    const { root, video } = await withVideo()
    const { svc } = service()
    expect((await svc.captureFrame(root, PATH, video, '1.6s', PNG)).path).toBe(
      'generated/视频1_1.6s.png',
    )
  })

  test('Art 节点的截图保存为 generated/<节点名>_截图.png，放在该节点右侧', async () => {
    const root = await workspace()
    await mkdir(join(root, 'generated'), { recursive: true })
    await writeFile(join(root, 'generated', '白模.html'), '<html></html>')
    const { svc } = service()
    const { refs } = await svc.apply(root, PATH, [
      { op: 'add_file', ref: '$p', path: 'generated/白模.html', x: 0, y: 0 },
    ])
    const shot = await svc.captureFrame(root, PATH, refs.$p!, '截图', PNG)
    expect(shot.path).toBe('generated/白模_截图.png')
    const node = (await onDisk(root)).nodes.find((n) => n.id === shot.nodeId)!
    expect(node.x).toBeGreaterThan(0)
  })

  test('不是 PNG 时返回 422；不是视频节点时返回 422，均不落盘', async () => {
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

describe('画布服务：时间线导出', () => {
  /** ftyp 头 + 一段内容：导出完成时只核对 ftyp。 */
  const MP4 = new Uint8Array([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 1, 2, 3, 4,
  ])

  async function withTimeline(idleMs?: number) {
    const root = await workspace()
    const svc = new CanvasService({
      publish: () => {},
      ...(idleMs !== undefined ? { exportIdleMs: idleMs } : {}),
    })
    const { refs } = await svc.apply(root, PATH, [
      { op: 'add_timeline', ref: '$t', name: '粗剪', x: 0, y: 400 },
      { op: 'add_file', ref: '$f', path: '角色/0.png', x: 0, y: 0 },
    ])
    return { root, svc, timeline: refs.$t!, file: refs.$f! }
  }

  const parts = async (root: string) =>
    (await readdir(join(root, 'generated')).catch(() => [] as string[])).filter((n) =>
      n.endsWith('.part'),
    )

  test('按位置写入（先写后半、最后回写开头）拼合整个文件，完成后保存为 generated/<时间线名>.mp4，并在时间线右侧添加节点', async () => {
    const { root, svc, timeline } = await withTimeline()
    const id = await svc.exportStart(root, PATH, timeline)
    expect(await parts(root)).toEqual([`.${id}.part`])
    await svc.exportWrite(root, id, 16, MP4.subarray(16))
    await svc.exportWrite(root, id, 0, MP4.subarray(0, 16))
    const landed = await svc.exportFinish(root, id)
    expect(landed.path).toBe('generated/粗剪.mp4')
    expect(new Uint8Array(await readFile(join(root, landed.path)))).toEqual(MP4)
    expect(await parts(root)).toEqual([])
    const node = (await onDisk(root)).nodes.find((n) => n.id === landed.nodeId)!
    expect(node).toMatchObject({ type: 'file', path: 'generated/粗剪.mp4', x: 580, y: 400 })
    // 会话完成即结束，不能再写入。
    expect((await failure(svc.exportWrite(root, id, 0, MP4))).status).toBe(404)
  })

  test('两次导出同时完成：各自保存为一个文件名（重名加 -2），互不覆盖', async () => {
    const { root, svc, timeline } = await withTimeline()
    const first = await svc.exportStart(root, PATH, timeline)
    const second = await svc.exportStart(root, PATH, timeline)
    const other = new Uint8Array([...MP4, 9, 9])
    await svc.exportWrite(root, first, 0, MP4)
    await svc.exportWrite(root, second, 0, other)
    const [a, b] = await Promise.all([
      svc.exportFinish(root, first),
      svc.exportFinish(root, second),
    ])
    expect([a.path, b.path].sort()).toEqual(['generated/粗剪-2.mp4', 'generated/粗剪.mp4'])
    expect(new Uint8Array(await readFile(join(root, a.path)))).toEqual(MP4)
    expect(new Uint8Array(await readFile(join(root, b.path)))).toEqual(other)
    expect(await parts(root)).toEqual([])
  })

  test('不是时间线时返回 422；收到的不是 mp4 时返回 422 并删除 .part；放弃时删除 .part；其他项目无法取得该会话', async () => {
    const { root, svc, timeline, file } = await withTimeline()
    expect((await failure(svc.exportStart(root, PATH, file))).status).toBe(422)
    const bad = await svc.exportStart(root, PATH, timeline)
    await svc.exportWrite(root, bad, 0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect((await failure(svc.exportFinish(root, bad))).status).toBe(422)
    expect(await parts(root)).toEqual([])
    const other = await workspace()
    const aborted = await svc.exportStart(root, PATH, timeline)
    expect((await failure(svc.exportWrite(other, aborted, 0, MP4))).status).toBe(404)
    await svc.exportAbort(root, aborted)
    expect(await parts(root)).toEqual([])
    expect((await readdir(join(root, 'generated'))).filter((n) => n.endsWith('.mp4'))).toEqual([])
  })

  test('Art 节点录制的视频保存为 generated/<节点名>.mp4，放在该节点右侧', async () => {
    const { root, svc } = await withTimeline()
    const { refs } = await svc.apply(root, PATH, [
      { op: 'add_generate', ref: '$a', output: 'art', name: '街口', x: 0, y: 800 },
    ])
    const id = await svc.exportStart(root, PATH, refs.$a!)
    await svc.exportWrite(root, id, 0, MP4)
    const landed = await svc.exportFinish(root, id)
    expect(landed.path).toBe('generated/街口.mp4')
    const node = (await onDisk(root)).nodes.find((n) => n.id === landed.nodeId)!
    expect(node).toMatchObject({ type: 'file', y: 800 })
  })

  test('会话超过空闲上限未写入：作废并删除 .part', async () => {
    const { root, svc, timeline } = await withTimeline(30)
    const id = await svc.exportStart(root, PATH, timeline)
    await svc.exportWrite(root, id, 0, MP4)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(await parts(root)).toEqual([])
    expect((await failure(svc.exportFinish(root, id))).status).toBe(404)
  })

  test('停止服务时结束进行中的导出并删除临时文件', async () => {
    const { root, svc, timeline } = await withTimeline()
    const id = await svc.exportStart(root, PATH, timeline)
    await svc.exportWrite(root, id, 0, MP4)
    await svc.stop()
    expect(await parts(root)).toEqual([])
    expect((await failure(svc.exportFinish(root, id))).status).toBe(404)
  })

  test('启动时删除上一个进程被结束时遗留的导出临时文件；进行中会话的与生成落盘的 .part 保留', async () => {
    const { root, svc, timeline } = await withTimeline()
    const live = await svc.exportStart(root, PATH, timeline)
    const dir = join(root, 'generated')
    await writeFile(join(dir, `.${randomUUID()}.part`), MP4)
    await writeFile(join(dir, '视频.mp4.part'), MP4)
    await svc.recover([{ id: 'w', root }], () => undefined)
    expect((await parts(root)).sort()).toEqual([`.${live}.part`, '视频.mp4.part'])
    await svc.exportAbort(root, live)
  })
})

describe('画布服务：时间线片段', () => {
  /** 只有 `moov/mvhd` 的 mp4：时长 = duration / 1000 秒。 */
  function mp4Of(ms: number): Buffer {
    const box = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8)
      head.writeUInt32BE(body.length + 8, 0)
      head.write(type, 4, 'latin1')
      return Buffer.concat([head, body])
    }
    const mvhd = Buffer.alloc(100)
    mvhd.writeUInt32BE(1000, 12)
    mvhd.writeUInt32BE(ms, 16)
    return Buffer.concat([
      box('ftyp', Buffer.from('isom0000', 'latin1')),
      box('moov', box('mvhd', mvhd)),
    ])
  }

  test('片段路径按工作区核实并写成正斜杠；文件不存在、出点超过视频时长时返回 422，不落盘', async () => {
    const root = await workspace()
    await mkdir(join(root, '素材'))
    await writeFile(join(root, '素材', 'a.mp4'), mp4Of(5000))
    const { svc } = service()
    const before = await readFile(join(root, PATH), 'utf8')
    const missing = await failure(
      svc.apply(root, PATH, [
        { op: 'add_timeline', clips: [{ path: '素材/没有.mp4', in: 0, out: 1 }] },
      ]),
    )
    expect(missing.status).toBe(422)
    const over = await failure(
      svc.apply(root, PATH, [
        { op: 'add_timeline', clips: [{ path: '素材/a.mp4', in: 0, out: 6 }] },
      ]),
    )
    expect([over.status, over.message]).toEqual([
      422,
      '片段超出视频时长：素材/a.mp4 时长为 5 秒，出点为 6 秒',
    ])
    expect(await readFile(join(root, PATH), 'utf8')).toBe(before)
    const { doc } = await svc.apply(root, PATH, [
      { op: 'add_timeline', clips: [{ path: '素材\\a.mp4', in: 1, out: 5 }] },
    ])
    expect(doc.nodes[0]).toMatchObject({
      type: 'timeline',
      clips: [{ path: '素材/a.mp4', in: 1, out: 5 }],
    })
  })

  test('片段的文件已删除时，时间线标记为缺失', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.mp4'), mp4Of(3000))
    const { svc } = service()
    await svc.apply(root, PATH, [{ op: 'add_timeline', clips: [{ path: 'a.mp4', in: 0, out: 2 }] }])
    const id = (await onDisk(root)).nodes[0]!.id
    expect((await svc.read(root, PATH)).states[id]).toEqual({ state: 'normal' })
    await rm(join(root, 'a.mp4'))
    expect((await svc.read(root, PATH)).states[id]).toEqual({ state: 'missing' })
  })
})
