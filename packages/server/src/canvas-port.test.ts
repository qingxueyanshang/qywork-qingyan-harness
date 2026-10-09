/**
 * 覆盖 `canvas.ts` 的 `canvasPort`：Agent 经由端口与界面经由 HTTP 使用同一个画布服务。
 *
 * 锁定四项行为：同一批操作经两条路径写出的文件逐字节相同；Agent 与用户同时修改时，双方的改动均保留；
 * 经端口运行视频时，任务节点在端口返回（工具结束）之前已写入画布并发出通知；
 * 经端口的修改按卡片名称引用、名称不重复、参数按模型参数表核对（`canvas-agent-ops.ts`）。
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
  type MediaParamDefinition,
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
  test('创建后可直接编辑、读取并批量运行，使用同一份画布文件', async () => {
    const root = await workspace()
    const port = canvasPort(new CanvasService({ publish: () => {} }), { id: 'ws', root })
    const path = await port.create('分镜/第1集.canvas.json')
    const { refs } = await port.edit(path, [
      { op: 'add_generate', output: 'image', ref: '$a', prompt: '角色' },
      { op: 'add_generate', output: 'image', ref: '$b', prompt: '场景' },
    ])
    const results = await port.runBatch(
      path,
      [refs.$a!, refs.$b!],
      {
        generate: async () => ({
          ok: true,
          provider: 'q',
          model: 'm',
          files: [{ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' }],
        }),
      },
      new AbortController().signal,
    )
    expect(results.every((r) => r.result.ok)).toBe(true)
    const view = await port.read(path)
    expect(Object.values(view.states).every((s) => s.state === 'normal')).toBe(true)
    expect(view.doc.runs).toHaveLength(2)
  })
  test('经端口按卡片名称引用并跨批有效；名称不能重复；参数按模型参数表核对，宽高比决定卡片形状', async () => {
    const root = await workspace()
    const specs: MediaParamDefinition[] = [
      { name: 'aspect_ratio', type: 'enum', values: ['16:9', '9:16', '1:1'] },
      { name: 'duration', type: 'integer', min: 1, max: 15 },
    ]
    const service = new CanvasService({
      publish: () => {},
      newId: sequence(),
      paramSpecsOf: () => specs,
    })
    const port = canvasPort(service, { id: 'ws', root })
    await port.edit(PATH, [{ op: 'add_file', path: 'a.png', name: '小满', group: '角色' }])
    const { view } = await port.edit(PATH, [
      {
        op: 'add_generate',
        output: 'video',
        name: '走出校门',
        group: '镜头',
        prompt: '@[小满] 走出校门',
        params: { aspect_ratio: '9:16', duration: 5 },
      },
    ])
    const card = () => view.doc.nodes.find((n) => n.type === 'generate')
    expect(card()).toMatchObject({ prompt: '@[id1] 走出校门', w: 169, h: 300 })
    expect(view.doc.edges.filter((e) => e.from === 'id1')).toHaveLength(1)
    await expect(
      port.edit(PATH, [{ op: 'add_generate', output: 'video', name: '小满' }]),
    ).rejects.toThrow('名称「小满」已被另一张卡使用')
    await expect(
      port.edit(PATH, [{ op: 'update', id: '走出校门', params: { duration: 30 } }]),
    ).rejects.toThrow('「走出校门」的参数 duration 取值 30 不合法：范围 1–15')
    await expect(
      port.edit(PATH, [{ op: 'update', id: '走出校门', params: { seconds: 5 } }]),
    ).rejects.toThrow('「走出校门」的参数 seconds 不存在。可用参数：aspect_ratio、duration')
    const wide = await port.edit(PATH, [
      { op: 'update', id: '走出校门', params: { aspect_ratio: '16:9' } },
    ])
    expect(wide.view.doc.nodes.find((n) => n.type === 'generate')).toMatchObject({
      w: 300,
      h: 169,
    })
  })
  /** 原始失败形状：模型填写表外的 1536x864，校验通过，而参数面板的宽高比与分辨率无一选中。 */
  test('带对照表的尺寸只接受表中的取值，报错列出全部可选值；表中取值决定卡片形状', async () => {
    const root = await workspace()
    const specs: MediaParamDefinition[] = [
      {
        name: 'size',
        type: 'string',
        pattern: '^(auto|\\d+x\\d+)$',
        shapes: [
          { value: 'auto' },
          { ratio: '16:9', tier: '1K', value: '1360x768' },
          { ratio: '2:3', tier: '1K', value: '832x1248' },
        ],
      },
    ]
    const service = new CanvasService({ publish: () => {}, paramSpecsOf: () => specs })
    const port = canvasPort(service, { id: 'ws', root })
    const add = (size: string) =>
      port.edit(PATH, [
        { op: 'add_generate', output: 'image', name: `林晚${size}`, params: { size } },
      ])
    await expect(add('1536x864')).rejects.toThrow(
      '「林晚1536x864」的参数 size 取值 "1536x864" 不合法：可选 auto（自动宽高比）、1360x768（16:9 · 1K）、832x1248（2:3 · 1K）',
    )
    const { view } = await add('832x1248')
    expect(view.doc.nodes[0]).toMatchObject({ w: 169, h: 254 })
  })
  /** 原始失败形状：模型写入当前模式下不可用的参数，工具返回成功，而画布不发送该参数，参数面板也不显示。 */
  test('参数按卡片批后的输入与其他参数核对是否可用，不可用时整批拒绝', async () => {
    const root = await workspace()
    const specs: MediaParamDefinition[] = [
      { name: 'output_format', type: 'enum', values: ['png', 'jpeg'], default: 'png' },
      {
        name: 'output_compression',
        type: 'integer',
        min: 0,
        max: 100,
        rules: [{ when: { params: { output_format: ['png'] } }, available: false }],
      },
      { name: 'input_fidelity', type: 'enum', values: ['low', 'high'], operations: ['edit'] },
    ]
    const service = new CanvasService({ publish: () => {}, paramSpecsOf: () => specs })
    const port = canvasPort(service, { id: 'ws', root })
    const card = (name: string, params: Record<string, unknown>, prompt = '') =>
      port.edit(PATH, [{ op: 'add_generate', output: 'image', name, prompt, params }])
    await expect(card('压缩', { output_compression: 90 })).rejects.toThrow(
      '「压缩」的参数 output_compression 取值 90 在当前的输入与参数下不可用：当前生成模式或参数组合不支持此参数',
    )
    await card('压缩', { output_format: 'jpeg', output_compression: 90 })
    await expect(card('保真', { input_fidelity: 'high' })).rejects.toThrow(
      '「保真」的参数 input_fidelity 取值 "high" 在当前的输入与参数下不可用',
    )
    await port.edit(PATH, [{ op: 'add_file', path: 'a.png', name: '参考' }])
    await card('保真', { input_fidelity: 'high' }, '@[参考] 换背景')
  })

  test('卡片写入的生成模型须已配置，未配置时整批拒绝', async () => {
    const root = await workspace()
    const specs: MediaParamDefinition[] = [{ name: 'n', type: 'integer', min: 1, max: 4 }]
    const service = new CanvasService({
      publish: () => {},
      paramSpecsOf: (_output, pick) => (!pick || pick.model === 'img-1' ? specs : undefined),
    })
    const port = canvasPort(service, { id: 'ws', root })
    const add = (name: string, model: string) =>
      port.edit(PATH, [{ op: 'add_generate', output: 'image', name, provider: 'p', model }])
    await expect(add('甲', 'img-x')).rejects.toThrow(
      '「甲」的生成模型 p / img-x 未配置：provider 与 model 取自本轮「可用的生成模型」中的同一行',
    )
    await add('甲', 'img-1')
    await expect(port.edit(PATH, [{ op: 'update', id: '甲', model: 'img-x' }])).rejects.toThrow(
      '未配置',
    )
  })

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
