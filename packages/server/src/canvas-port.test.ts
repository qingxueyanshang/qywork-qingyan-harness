/**
 * 覆盖 `canvas.ts` 的 `canvasPort`：Agent 经由端口与界面经由 HTTP 使用同一个画布服务。
 *
 * 锁定三项行为：同一批操作经两条路径写出的文件逐字节相同；Agent 与用户同时修改时，双方的改动均保留；
 * 经端口运行视频时，任务节点在端口返回（工具结束）之前已写入画布并发出通知。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaCallResult, MediaPort } from '@qywork/agent'
import {
  type AgentEvent,
  applyCanvasOps,
  type CanvasOp,
  emptyCanvas,
  parseCanvas,
  serializeCanvas,
} from '@qywork/core'
import { Store, upsertWorkspace } from '@qywork/store'
import { type ApiDeps, handleApi } from './api/index.ts'
import { CanvasService, canvasPort } from './canvas.ts'

const PATH = 'board.canvas.json'
const OPS: CanvasOp[] = [
  { op: 'add_file', ref: '$a', path: 'a.png', name: '小满' },
  { op: 'add_generate', ref: '$v', output: 'video', prompt: '@[$a] 走出校门', x: 400, y: 0 },
]

function sequence(): () => string {
  let n = 0
  return () => `id${++n}`
}

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-canvas-port-'))
  await writeFile(join(root, 'a.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  await writeFile(join(root, PATH), serializeCanvas(emptyCanvas()))
  return root
}

describe('画布端口', () => {
  test('同一批操作经端口与经 HTTP 写出的文件逐字节相同', async () => {
    const viaPort = await workspace()
    const port = canvasPort(new CanvasService({ publish: () => {}, newId: sequence() }), {
      id: 'ws',
      root: viaPort,
    })
    await port.edit(PATH, OPS)

    const viaHttp = await workspace()
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, viaHttp, 'demo')
    const d = {
      store,
      canvas: new CanvasService({ publish: () => {}, newId: sequence() }),
    } as unknown as ApiDeps
    const url = `http://127.0.0.1/api/canvas/ops?ws=${ws.id}`
    const res = await handleApi(
      new URL(url),
      new Request(url, { method: 'POST', body: JSON.stringify({ path: PATH, ops: OPS }) }),
      d,
    )
    expect(res?.status).toBe(200)

    const a = await readFile(join(viaPort, PATH), 'utf8')
    expect(await readFile(join(viaHttp, PATH), 'utf8')).toBe(a)
    expect(parseCanvas(a).ok).toBe(true)
  })

  test('Agent 与用户同时修改，双方的改动均保留', async () => {
    const root = await workspace()
    const svc = new CanvasService({ publish: () => {} })
    const port = canvasPort(svc, { id: 'ws', root })
    await Promise.all([
      port.edit(PATH, [{ op: 'add_generate', output: 'image', name: 'Agent 加的' }]),
      svc.apply(root, PATH, [{ op: 'add_file', path: 'a.png', name: '用户拖的' }]),
      port.edit(PATH, [{ op: 'add_generate', output: 'audio', name: 'Agent 又加的' }]),
    ])
    const doc = parseCanvas(await readFile(join(root, PATH), 'utf8'))
    if (!doc.ok) throw new Error(doc.error)
    expect(doc.doc.nodes.map((n) => n.name).sort()).toEqual([
      'Agent 加的',
      'Agent 又加的',
      '用户拖的',
    ])
  })

  test('经端口运行视频：任务节点在端口返回之前写入画布并发出 file.changed', async () => {
    const root = await workspace()
    const r = applyCanvasOps(emptyCanvas(), OPS)
    if (!r.ok) throw new Error(r.error)
    await writeFile(join(root, PATH), serializeCanvas(r.doc))
    const events: AgentEvent[] = []
    const port = canvasPort(new CanvasService({ publish: (e) => events.push(e) }), {
      id: 'ws',
      root,
    })
    let finish: (r: MediaCallResult) => void = () => {}
    let submitted: () => void = () => {}
    const onTask = new Promise<void>((resolve) => {
      submitted = resolve
    })
    const media: MediaPort = {
      generate: (call) =>
        new Promise((resolve) => {
          finish = resolve
          void Promise.resolve(
            call.onTask?.({ taskId: 't', provider: 'ark', model: 'seedance' }),
          ).then(submitted)
        }),
    }
    let returned = false
    const running = port
      .run(PATH, r.refs.$v!, media, new AbortController().signal)
      .then((result) => {
        returned = true
        return result
      })
    await onTask
    expect(returned).toBe(false)
    expect(events.some((e) => e.type === 'file.changed')).toBe(true)
    const during = parseCanvas(await readFile(join(root, PATH), 'utf8'))
    if (!during.ok) throw new Error(during.error)
    const video = during.doc.nodes.find((n) => n.id === r.refs.$v)
    expect(video?.type === 'generate' && video.versions[0]?.path.endsWith('.task.json')).toBe(true)
    finish({ ok: false, message: '等待超时', pendingTaskId: 't' })
    expect(await running).toEqual({ ok: false, message: '等待超时', pending: true })
  })
})
