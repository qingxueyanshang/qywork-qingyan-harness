/**
 * 覆盖 `canvas.ts` 的 `canvasPort`：Agent 经由端口与界面经由 HTTP 使用同一个画布服务。
 *
 * 锁定的行为：同一批操作经两条路径写出的文件逐字节相同；经端口与经 HTTP 取帧写出的画布与图片逐字节相同；Agent 与用户同时修改时，双方的改动均保留；
 * 经端口运行视频时，任务节点在端口返回（工具结束）之前已写入画布并发出通知；
 * 经端口的修改按卡片名称引用、名称不重复、参数按模型参数表核对，经端口读取的生成卡参数为实际发送的参数
 * （`canvas-agent-ops.ts`）；本轮中止只结束端口的等待，生成照常完成并写回画布；
 * `cancel_canvas` 经端口与界面的取消调用同一个 `CanvasService.cancel` 与撤销函数（`tools/canvas.ts` 的工具经此覆盖）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CanvasEditResult,
  type CanvasPort,
  type MediaCall,
  type MediaCallResult,
  type MediaPort,
  type ToolContext,
  ToolRegistry,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  type AgentEvent,
  applyCanvasOps,
  type CanvasOp,
  type CanvasRunResult,
  displayNameOf,
  emptyCanvas,
  type MediaParamDefinition,
  parseCanvas,
  serializeCanvas,
} from '@qywork/core'
import { cancelMediaTask, makeMediaPort, type QyConfig } from '@qywork/runtime'
import { Store, upsertWorkspace } from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { type ApiDeps, handleApi } from './api/index.ts'
import { type CanvasCancelTask, CanvasService, canvasPort } from './canvas.ts'

const PATH = 'board.canvas.json'
const OPS: CanvasOp[] = [
  { op: 'add_file', ref: '$a', path: 'a.png', name: '小满' },
  { op: 'add_generate', ref: '$v', output: 'video', prompt: '@[$a] 走出校门', x: 400, y: 0 },
]

/** 端口逐条执行：返回被跳过条目的原因，供断言。 */
async function skippedOf(pending: Promise<CanvasEditResult>): Promise<string> {
  return (await pending).skipped.map((s) => s.error).join('\n')
}

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
    expect(
      await skippedOf(port.edit(PATH, [{ op: 'add_generate', output: 'video', name: '小满' }])),
    ).toContain('名称「小满」已被另一张卡使用')
    expect(
      await skippedOf(
        port.edit(PATH, [{ op: 'update', id: '走出校门', params: { duration: 30 } }]),
      ),
    ).toContain('「走出校门」的参数 duration 取值 30 不合法：范围 1–15')
    expect(
      await skippedOf(port.edit(PATH, [{ op: 'update', id: '走出校门', params: { seconds: 5 } }])),
    ).toContain('「走出校门」的参数 seconds 不存在。默认模型的可用参数：aspect_ratio、duration')
    const wide = await port.edit(PATH, [
      { op: 'update', id: '走出校门', params: { aspect_ratio: '16:9' } },
    ])
    expect(wide.view.doc.nodes.find((n) => n.type === 'generate')).toMatchObject({
      w: 300,
      h: 169,
    })
  })
  /** 原始失败形状：只改长提示词中的几句时 `update` 须重写整段提示词，模型改为用脚本直接改写画布文件。 */
  test('经端口用 edit_prompt 按卡片名称只改提示词中的一段，写入画布文件', async () => {
    const root = await workspace()
    const port = canvasPort(new CanvasService({ publish: () => {}, newId: sequence() }), {
      id: 'ws',
      root,
    })
    await port.edit(PATH, OPS)
    await port.edit(PATH, [{ op: 'edit_prompt', id: '视频1', old: '走出校门', new: '站在台口' }])
    const saved = parseCanvas(await readFile(join(root, PATH), 'utf8'))
    if (!saved.ok) throw new Error(saved.error)
    expect(saved.doc.nodes.find((n) => n.type === 'generate')).toMatchObject({
      prompt: '@[id1] 站在台口',
    })
  })

  test('经端口用 order_inputs 调整输入顺序后运行：发送的素材顺序与提示词编号随之改变', async () => {
    const root = await workspace()
    await writeFile(join(root, 'b.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const port = canvasPort(
      new CanvasService({ publish: () => {}, mentionStyleOf: () => ({ image: '图片{n}' }) }),
      { id: 'ws', root },
    )
    const { refs } = await port.edit(PATH, [
      { op: 'add_file', path: 'a.png', name: '小满' },
      { op: 'add_file', path: 'b.png', name: '妈妈' },
      {
        op: 'add_generate',
        ref: '$g',
        output: 'image',
        name: '合影',
        prompt: '@[小满] 和 @[妈妈]',
      },
    ])
    await port.edit(PATH, [{ op: 'order_inputs', id: '合影', inputs: ['妈妈', '小满'] }])
    const calls: { prompt: string; inputs: string[] }[] = []
    const result = await port.run(
      PATH,
      refs.$g!,
      {
        generate: async (call) => {
          calls.push({ prompt: call.prompt, inputs: call.inputs.map((i) => i.path) })
          return {
            ok: true,
            provider: 'q',
            model: 'm',
            files: [{ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' }],
          }
        },
      },
      new AbortController().signal,
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual([
      { prompt: '图片2 和 图片1', inputs: [join(root, 'b.png'), join(root, 'a.png')] },
    ])
  })

  /**
   * 原始失败形状：一批操作中有一条不成立时整批被拒，模型须把整批（会话中一次约 1.3 万字）重发。
   * 改为逐条生效：不成立的条目跳过，依赖它的批内名称的条目同样跳过，其余写入；
   * 新卡仍在本批全部连线之后按组排位，与整批应用的位置相同。
   */
  test('经端口一批中有不成立的条目时只跳过这些条目，其余写入，新卡按组排位', async () => {
    const root = await workspace()
    const service = new CanvasService({ publish: () => {}, newId: sequence() })
    const port = canvasPort(service, { id: 'ws', root })
    const result = await port.edit(PATH, [
      { op: 'add_file', ref: '$a', path: 'a.png', name: '小满', group: '角色/小满' },
      { op: 'add_file', ref: '$b', path: 'missing.png', name: '缺失' },
      { op: 'connect', from: '$b', to: '$v', role: 'reference' },
      {
        op: 'add_generate',
        ref: '$v',
        output: 'image',
        name: '定妆',
        group: '镜头/定妆',
        prompt: '@[$a]',
      },
      { op: 'update', id: '不存在的卡', name: 'x' },
    ])
    expect(result.skipped.map((s) => s.at)).toEqual([1, 2, 4])
    expect(result.skipped[2]!.error).toContain('不存在的卡')
    const names = result.view.doc.nodes.map((n) => (n.type === 'file' ? n.name : n.name))
    expect(names).toEqual(['小满', '定妆'])
    expect(result.changed).toHaveLength(2)

    // 同一批整批成立时的位置作为对照。
    const solo = await workspace()
    const reference = await canvasPort(
      new CanvasService({ publish: () => {}, newId: sequence() }),
      {
        id: 'ws',
        root: solo,
      },
    ).edit(PATH, [
      { op: 'add_file', ref: '$a', path: 'a.png', name: '小满', group: '角色/小满' },
      {
        op: 'add_generate',
        ref: '$v',
        output: 'image',
        name: '定妆',
        group: '镜头/定妆',
        prompt: '@[$a]',
      },
    ])
    const place = (v: CanvasEditResult) => v.view.doc.nodes.map((n) => [n.x, n.y])
    expect(place(result)).toEqual(place(reference))

    const nothing = await port.edit(PATH, [{ op: 'remove', id: '不存在的卡' }])
    expect(nothing.skipped).toHaveLength(1)
    expect(nothing.changed).toEqual([])
  })

  test('经端口的 replace_text 回报每张卡替换的处数', async () => {
    const root = await workspace()
    const port = canvasPort(new CanvasService({ publish: () => {} }), { id: 'ws', root })
    await port.edit(PATH, [
      { op: 'add_generate', output: 'image', name: '同学录', prompt: '暖黄灯光，暖黄灯光' },
      { op: 'add_generate', output: 'image', name: 'MP3', prompt: '冷光' },
    ])
    const result = await port.edit(PATH, [
      { op: 'replace_text', id: '同学录', old: '暖黄灯光', new: '自然光' },
      { op: 'replace_text', id: 'MP3', old: '暖黄灯光', new: '自然光' },
    ])
    expect(result.replaced).toEqual([{ at: 0, count: 2 }])
    expect(result.skipped).toEqual([{ at: 1, error: '「MP3」的提示词中没有「暖黄灯光」' }])
  })

  /** 原始失败形状：模型在后一批中以另一个名称再次放置同一份制作稿，画布上同一文件出现两张卡。 */
  test('经端口再次放置已在画布上的文件时该条跳过，并给出已有卡片的名称', async () => {
    const root = await workspace()
    const port = canvasPort(new CanvasService({ publish: () => {} }), { id: 'ws', root })
    await port.edit(PATH, [{ op: 'add_file', path: 'a.png', group: '角色/小满' }])
    expect(
      await skippedOf(
        port.edit(PATH, [{ op: 'add_file', path: 'a.png', name: '小满_审定', group: '角色/小满' }]),
      ),
    ).toContain('a.png 已在画布上，卡片名称为「a」：同一文件只放一张整篇的卡')
    const other = await port.create('b.canvas.json')
    expect(
      await skippedOf(
        port.edit(other, [
          { op: 'add_file', path: 'a.png', name: '小满' },
          { op: 'add_file', path: 'a.png', name: '小满_审定' },
        ]),
      ),
    ).toContain('a.png 已在画布上，卡片名称为「小满」')
    const view = await port.read(PATH)
    expect(view.doc.nodes.filter((n) => n.type === 'file')).toHaveLength(1)
  })

  test('同一文件可放整篇卡与多张摘录卡；同一段只放一张；摘录卡须有名称；失效原因随回执返回', async () => {
    const root = await workspace()
    await writeFile(join(root, '脚本.md'), '## 1-1\n阿七推门。\n## 1-2\n阿七握手。\n')
    const port = canvasPort(new CanvasService({ publish: () => {} }), { id: 'ws', root })
    const shot = (n: string, start: string) => ({
      op: 'add_file' as const,
      path: '脚本.md',
      name: `${n} 段`,
      excerpt: { after: `## ${n}`, start, end: '。' },
    })
    const placed = await port.edit(PATH, [
      { op: 'add_file', path: '脚本.md' },
      shot('1-1', '阿七'),
      shot('1-2', '阿七'),
      { ...shot('1-2', '阿七'), name: '1-2 重复' },
      { op: 'add_file', path: '脚本.md', excerpt: { start: '阿七握手', end: '。' } },
      shot('1-3', '阿七'),
    ])
    expect(placed.skipped.map((s) => s.error)).toEqual([
      '脚本.md 中的这一段已有摘录卡「1-2 段」：同一段只放一张卡',
      '摘录卡须给出 name：同一文件的各张摘录卡按名称区分',
    ])
    expect(placed.view.doc.nodes.map(displayNameOf)).toEqual(['脚本', '1-1 段', '1-2 段', '1-3 段'])
    expect(placed.view.references).toEqual({
      [placed.view.doc.nodes[3]!.id]: ['文中没有 after 「## 1-3」'],
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
    expect(await skippedOf(add('1536x864'))).toContain(
      '「林晚1536x864」的参数 size 取值 "1536x864" 不合法：可选 auto（自动宽高比）、1360x768（16:9 · 1K）、832x1248（2:3 · 1K）',
    )
    const { view } = await add('832x1248')
    expect(view.doc.nodes[0]).toMatchObject({ w: 169, h: 254 })
  })
  /** 原始失败形状：模型写入当前模式下不可用的参数，工具返回成功，而画布不发送该参数，参数面板也不显示。 */
  test('参数按卡片批后的输入与其他参数核对是否可用，不可用时该条跳过', async () => {
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
    expect(await skippedOf(card('压缩', { output_compression: 90 }))).toContain(
      '「压缩」的参数 output_compression 取值 90 在当前的输入与参数下不可用：当前生成模式或参数组合不支持此参数',
    )
    await card('压缩', { output_format: 'jpeg', output_compression: 90 })
    expect(await skippedOf(card('保真', { input_fidelity: 'high' }))).toContain(
      '「保真」的参数 input_fidelity 取值 "high" 在当前的输入与参数下不可用',
    )
    await port.edit(PATH, [{ op: 'add_file', path: 'a.png', name: '参考' }])
    await card('保真', { input_fidelity: 'high' }, '@[参考] 换背景')
  })

  /**
   * 原始失败形状：后一批断开参考图，或原样重写已不可用的取值，参数不再发送、面板不再显示，而工具返回成功；
   * 大模型读取的画布仍列出卡片上保存的全部参数，与参数面板不一致。
   */
  test('已发送的参数在后续批次中不会无提示地失效；大模型读取的参数与参数面板一致', async () => {
    const root = await workspace()
    const specs: MediaParamDefinition[] = [
      { name: 'output_format', type: 'enum', values: ['png', 'jpeg'], default: 'png' },
      { name: 'input_fidelity', type: 'enum', values: ['low', 'high'], operations: ['edit'] },
    ]
    const service = new CanvasService({ publish: () => {}, paramSpecsOf: () => specs })
    const port = canvasPort(service, { id: 'ws', root })
    const { view } = await port.edit(PATH, [
      { op: 'add_file', path: 'a.png', name: '参考' },
      {
        op: 'add_generate',
        output: 'image',
        name: '保真',
        prompt: '@[参考] 换背景',
        params: { input_fidelity: 'high' },
      },
    ])
    const edge = view.doc.edges[0]!
    expect(await skippedOf(port.edit(PATH, [{ op: 'remove', id: edge.id }]))).toContain(
      '「保真」的参数 input_fidelity 取值 "high" 在当前的输入与参数下不可用',
    )
    await port.edit(PATH, [
      { op: 'remove', id: edge.id },
      { op: 'update', id: '保真', params: { output_format: 'jpeg' } },
    ])

    await service.apply(root, PATH, [
      { op: 'update', id: '保真', params: { input_fidelity: 'high', output_format: 'jpeg' } },
    ])
    const saved = (await service.read(root, PATH)).doc.nodes.find((n) => n.type === 'generate')
    const read = (await port.read(PATH)).doc.nodes.find((n) => n.type === 'generate')
    expect(saved?.type === 'generate' && saved.params).toEqual({
      input_fidelity: 'high',
      output_format: 'jpeg',
    })
    expect(read?.type === 'generate' && read.params).toEqual({ output_format: 'jpeg' })
    expect(
      await skippedOf(
        port.edit(PATH, [
          { op: 'update', id: '保真', params: { input_fidelity: 'high', output_format: 'jpeg' } },
        ]),
      ),
    ).toContain('「保真」的参数 input_fidelity 取值 "high" 在当前的输入与参数下不可用')

    // 改换模型时恢复该模型保存的参数；取值与切换前相同的参数同样须可发送。
    const high = { input_fidelity: 'high' }
    await service.apply(root, PATH, [
      { op: 'add_generate', output: 'image', name: '换模型', provider: 'p', model: 'm2' },
      { op: 'update', id: '换模型', params: high },
      { op: 'update', id: '换模型', model: 'm1' },
      { op: 'update', id: '换模型', params: high },
    ])
    expect(
      await skippedOf(port.edit(PATH, [{ op: 'update', id: '换模型', model: 'm2' }])),
    ).toContain('「换模型」的参数 input_fidelity 取值 "high" 在当前的输入与参数下不可用')
  })

  test('卡片写入的生成模型须已配置，未配置时该条跳过', async () => {
    const root = await workspace()
    const specs: MediaParamDefinition[] = [{ name: 'n', type: 'integer', min: 1, max: 4 }]
    const service = new CanvasService({
      publish: () => {},
      paramSpecsOf: (_output, pick) => (!pick || pick.model === 'img-1' ? specs : undefined),
    })
    const port = canvasPort(service, { id: 'ws', root })
    const add = (name: string, model: string) =>
      port.edit(PATH, [{ op: 'add_generate', output: 'image', name, provider: 'p', model }])
    expect(await skippedOf(add('甲', 'img-x'))).toContain(
      '「甲」的生成模型 p / img-x 未配置：provider 与 model 取自本轮「可用的生成模型」中的同一行',
    )
    await add('甲', 'img-1')
    expect(
      await skippedOf(port.edit(PATH, [{ op: 'update', id: '甲', model: 'img-x' }])),
    ).toContain('未配置')
    const bare = canvasPort(
      new CanvasService({
        publish: () => {},
        paramSpecsOf: (_output, pick) => (pick?.model === 'img-1' ? specs : undefined),
      }),
      { id: 'ws', root },
    )
    expect(
      await skippedOf(bare.edit(PATH, [{ op: 'add_generate', output: 'image', name: '乙' }])),
    ).toContain('「乙」未指定生成模型，且没有默认的生成模型')
  })

  /**
   * 原始失败形状：add_generate 只写 model: gpt-image-2.5-sunburst，参数按默认模型的参数表核对，
   * 报错列出的是另一个模型的参数，也没有写明按哪个模型核对。
   */
  test('只给出 model 时按提供该模型的接口补上 provider，参数按该模型核对；没有或有多个接口提供时写明原因', async () => {
    const root = await workspace()
    const grok: MediaParamDefinition[] = [
      { name: 'aspect_ratio', type: 'enum', values: ['1:1', '16:9'] },
    ]
    const gpt: MediaParamDefinition[] = [
      { name: 'output_format', type: 'enum', values: ['png', 'jpeg'] },
    ]
    const owners: Record<string, string[]> = {
      'gpt-image-2.5-sunburst': ['relay'],
      seedream: ['ark', 'relay'],
    }
    const service = new CanvasService({
      publish: () => {},
      paramSpecsOf: (_output, pick) =>
        !pick ? grok : pick.model === 'gpt-image-2.5-sunburst' ? gpt : undefined,
      providersOf: (_output, model) => owners[model] ?? [],
    })
    const port = canvasPort(service, { id: 'ws', root })
    const placed = await port.edit(PATH, [
      {
        op: 'add_generate',
        output: 'image',
        name: 'P01 封面',
        model: 'gpt-image-2.5-sunburst',
        params: { output_format: 'png' },
      },
    ])
    expect(placed.skipped).toEqual([])
    expect(placed.view.doc.nodes[0]).toMatchObject({
      provider: 'relay',
      model: 'gpt-image-2.5-sunburst',
      params: { output_format: 'png' },
    })
    const add = (name: string, extra: Partial<Extract<CanvasOp, { op: 'add_generate' }>>) =>
      skippedOf(port.edit(PATH, [{ op: 'add_generate', output: 'image', name, ...extra }]))
    expect(await add('乙', { model: 'seedream' })).toContain(
      '「乙」只给出 model seedream，缺少 provider：ark、relay 都提供该模型，provider 写明其中一个',
    )
    expect(await add('丙', { model: 'img-x' })).toContain(
      '「丙」只给出 model img-x，缺少 provider，且本轮「可用的生成模型」中没有该模型',
    )
    expect(await add('丁', { params: { output_format: 'png' } })).toContain(
      '「丁」的参数 output_format 不存在。默认模型的可用参数：aspect_ratio',
    )
    expect(
      await add('戊', {
        provider: 'relay',
        model: 'gpt-image-2.5-sunburst',
        params: { quality: 'max' },
      }),
    ).toContain(
      '「戊」的参数 quality 不存在。relay / gpt-image-2.5-sunburst 的可用参数：output_format',
    )
    // 使用默认模型的卡改换模型时同样补上 provider。
    await port.edit(PATH, [{ op: 'add_generate', output: 'image', name: '己' }])
    const changed = await port.edit(PATH, [
      { op: 'update', id: '己', model: 'gpt-image-2.5-sunburst' },
    ])
    expect(
      changed.view.doc.nodes.find((n) => n.type === 'generate' && n.name === '己'),
    ).toMatchObject({ provider: 'relay', model: 'gpt-image-2.5-sunburst' })
  })

  /** 原始失败形状：同一批中先删除「P01 封面」再把另一张卡改名为「P01 封面」，被拒为名称已被另一张卡使用。 */
  test('同一批中先删除或改动的卡让出名称、文件与摘录；同一批中重复的名称、文件与摘录仍被拒绝', async () => {
    const root = await workspace()
    await writeFile(join(root, '脚本.md'), '## 1-1\n阿七推门。\n## 1-2\n阿七握手。\n')
    const port = canvasPort(new CanvasService({ publish: () => {} }), { id: 'ws', root })
    const shot = (after: string) => ({ after, start: '阿七', end: '。' })
    await port.edit(PATH, [
      { op: 'add_generate', output: 'image', name: 'P01 封面', group: '幻灯片' },
      { op: 'add_generate', output: 'image', name: 'P01 封面 重做', group: '幻灯片' },
      { op: 'add_file', path: 'a.png', name: '小满' },
      { op: 'add_file', path: '脚本.md', name: '1-1 段', excerpt: shot('## 1-1') },
    ])
    const swapped = await port.edit(PATH, [
      { op: 'remove', id: 'P01 封面' },
      { op: 'update', id: 'P01 封面 重做', name: 'P01 封面' },
      { op: 'remove', id: '小满' },
      { op: 'add_file', path: 'a.png', name: '小满_审定' },
      { op: 'update', id: '1-1 段', excerpt: shot('## 1-2') },
      { op: 'add_file', path: '脚本.md', name: '1-1 段 补', excerpt: shot('## 1-1') },
    ])
    expect(swapped.skipped).toEqual([])
    expect(swapped.view.doc.nodes.map(displayNameOf)).toEqual([
      'P01 封面',
      '1-1 段',
      '小满_审定',
      '1-1 段 补',
    ])
    const repeated = await port.edit(PATH, [
      { op: 'add_generate', output: 'image', name: 'P02' },
      { op: 'add_generate', output: 'image', name: 'P02' },
      { op: 'add_file', path: 'a.png', name: '小满' },
      { op: 'update', id: '1-1 段 补', excerpt: shot('## 1-2') },
    ])
    expect(repeated.skipped.map((s) => s.error)).toEqual([
      '名称「P02」已被另一张卡使用：同一张画布中的卡片名称不能重复',
      'a.png 已在画布上，卡片名称为「小满_审定」：同一文件只放一张整篇的卡',
      '脚本.md 中的这一段已有摘录卡「1-1 段」：同一段只放一张卡',
    ])
  })

  test('经端口排列卡片：只改变了位置的卡列入 moved，回执不列出其全文', async () => {
    const root = await workspace()
    const port = canvasPort(new CanvasService({ publish: () => {} }), { id: 'ws', root })
    await port.edit(
      PATH,
      ['P2', 'P1', 'P3'].map((name) => ({
        op: 'add_generate' as const,
        output: 'image' as const,
        name,
        group: '幻灯片',
        prompt: `${name} 的画面`,
      })),
    )
    const r = await port.edit(PATH, [{ op: 'arrange', group: '幻灯片', perRow: 2 }])
    const at = (name: string) => {
      const n = r.view.doc.nodes.find((x) => x.type === 'generate' && x.name === name)!
      return [n.x, n.y]
    }
    expect([at('P1'), at('P2'), at('P3')]).toEqual([
      [0, 0],
      [217, 0],
      [0, 217],
    ])
    expect(r.changed).toEqual([])
    expect(r.moved).toHaveLength(3)
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

  test('经端口取帧与经 HTTP 取帧写出的画布文件与图片逐字节相同', async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    const setup = async () => {
      const root = await workspace()
      await writeFile(join(root, 'clip.mp4'), 'mp4')
      const service = new CanvasService({ publish: () => {}, newId: sequence() })
      const { refs } = await service.apply(root, PATH, [
        { op: 'add_file', ref: '$v', path: 'clip.mp4', name: '视频1' },
      ])
      return { root, service, video: refs.$v! }
    }

    const viaPort = await setup()
    const landed = await canvasPort(viaPort.service, { id: 'ws', root: viaPort.root }).captureFrame(
      PATH,
      viaPort.video,
      '2.5s',
      PNG,
    )
    expect(landed.path).toBe('generated/视频1_2.5s.png')

    const viaHttp = await setup()
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, viaHttp.root, 'demo')
    const d = { store, canvas: viaHttp.service } as unknown as ApiDeps
    const query = new URLSearchParams({
      ws: ws.id,
      path: PATH,
      nodeId: viaHttp.video,
      label: '2.5s',
    })
    const url = `http://127.0.0.1/api/canvas/frame?${query}`
    const res = await handleApi(new URL(url), new Request(url, { method: 'POST', body: PNG }), d)
    expect(res?.status).toBe(200)

    expect(await readFile(join(viaHttp.root, PATH), 'utf8')).toBe(
      await readFile(join(viaPort.root, PATH), 'utf8'),
    )
    expect(new Uint8Array(await readFile(join(viaHttp.root, landed.path)))).toEqual(PNG)
    expect(new Uint8Array(await readFile(join(viaPort.root, landed.path)))).toEqual(PNG)
  })
})

/** 一次生成调用：`submit` 回报任务号，`finish` 使调用返回；中止信号到达时以中止原因拒绝，与真实端口一致。 */
interface Held {
  call: MediaCall
  signal: AbortSignal
  submit(taskId: string): Promise<void>
  finish(result: MediaCallResult): void
}

function heldPort(): { port: MediaPort; calls: Held[]; next(): Promise<Held> } {
  const calls: Held[] = []
  const waiters: ((held: Held) => void)[] = []
  let claimed = 0
  const port: MediaPort = {
    generate: (call, signal) =>
      new Promise((resolve, reject) => {
        if (!call.resumeTaskId) call.onSubmit?.()
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        const held: Held = {
          call,
          signal,
          submit: async (taskId) => {
            await call.onTask?.({ taskId, provider: 'ark', model: 'seedance' })
          },
          finish: resolve,
        }
        calls.push(held)
        waiters.shift()?.(held)
      }),
  }
  const next = () =>
    new Promise<Held>((resolve) => {
      const ready = calls[claimed]
      if (ready) {
        claimed++
        resolve(ready)
        return
      }
      waiters.push((held) => {
        claimed++
        resolve(held)
      })
    })
  return { port, calls, next }
}

/** 等到条件成立：端口的等待结束之后，生成在服务中继续进行，只能按画布状态判断进度。 */
async function until(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 经工具注册表执行 `cancel_canvas`，与会话中调用该工具相同。 */
async function cancelCanvas(port: CanvasPort, args: Record<string, unknown>) {
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, { canvas: true })
  const ctx: ToolContext = {
    workspaceRoot: '/w',
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    canvas: port,
  }
  return registry.execute('cancel_canvas', args, ctx)
}

const MP4 = new Uint8Array([0, 0, 0, 24])
const VIDEO_DONE: MediaCallResult = {
  ok: true,
  provider: 'ark',
  model: 'seedance',
  files: [{ bytes: MP4, mime: 'video/mp4' }],
}
const STOPPED_WAIT: CanvasRunResult = {
  ok: false,
  message: '已停止等待；该卡的生成照常进行，结束后写回画布',
  pending: false,
}

describe('画布端口：本轮中止与取消', () => {
  /**
   * 原始失败形状：Agent 经 run_canvas 提交视频后用户停止会话，本轮的中止信号并入了生成的轮询，
   * 轮询随之中止，收尾按失败处理：卡片显示生成失败，远端任务既未撤销也不再被等待。
   */
  test('经端口运行后本轮中止：等待结束，生成照常进行，完成后写回画布，记录与广播都不是 failed', async () => {
    const root = await workspace()
    const r = applyCanvasOps(emptyCanvas(), OPS)
    if (!r.ok) throw new Error(r.error)
    await writeFile(join(root, PATH), serializeCanvas(r.doc))
    const events: AgentEvent[] = []
    const service = new CanvasService({ publish: (e) => events.push(e) })
    const port = canvasPort(service, { id: 'ws', root })
    const id = r.refs.$v!
    const fake = heldPort()
    const stop = new AbortController()
    const waiting = port.run(PATH, id, fake.port, stop.signal)
    const held = await fake.next()
    await held.submit('t-1')
    stop.abort(new Error('用户停止'))
    expect(await waiting).toEqual(STOPPED_WAIT)
    expect(held.signal.aborted).toBe(false)
    expect((await service.read(root, PATH)).states[id]).toMatchObject({
      state: 'running',
      taskId: 't-1',
    })

    held.finish(VIDEO_DONE)
    await until(async () => (await service.read(root, PATH)).states[id]?.state === 'normal')
    const { doc } = await service.read(root, PATH)
    expect(doc.runs?.map((x) => [x.action, x.result, x.task])).toEqual([['run', 'done', 't-1']])
    const card = doc.nodes.find((n) => n.id === id)
    expect(card?.type === 'generate' && card.versions.map((v) => v.path)).toEqual([
      expect.stringMatching(/\.mp4$/),
    ])
    const published = events.filter((e) => e.type === 'canvas.run')
    expect(published.at(-1)).toMatchObject({ nodeId: id, state: 'done' })
    expect(published.some((e) => e.type === 'canvas.run' && e.state === 'failed')).toBe(false)
  })

  test('经端口取回后本轮中止：取回照常进行，完成后写回画布', async () => {
    const root = await workspace()
    const r = applyCanvasOps(emptyCanvas(), OPS)
    if (!r.ok) throw new Error(r.error)
    await writeFile(join(root, PATH), serializeCanvas(r.doc))
    const service = new CanvasService({ publish: () => {} })
    const ws = { id: 'ws', root }
    const id = r.refs.$v!
    const fake = heldPort()
    const first = await service.run(ws, PATH, id, { media: fake.port })
    const submitted = await fake.next()
    await submitted.submit('t-9')
    submitted.finish({ ok: false, message: '等待超时', pendingTaskId: 't-9' })
    await first.done

    const stop = new AbortController()
    const waiting = canvasPort(service, ws).retrieve(PATH, id, undefined, fake.port, stop.signal)
    const resume = await fake.next()
    expect(resume.call.resumeTaskId).toBe('t-9')
    stop.abort()
    expect(await waiting).toEqual(STOPPED_WAIT)
    expect(resume.signal.aborted).toBe(false)
    resume.finish(VIDEO_DONE)
    await until(async () => (await service.read(root, PATH)).states[id]?.state === 'normal')
    expect((await service.read(root, PATH)).doc.runs?.map((x) => [x.action, x.result])).toEqual([
      ['run', 'pending'],
      ['retrieve', 'done'],
    ])
  })

  /** 已经向服务商发出的节点继续生成；尚未派发的节点在中止后不再提交，不产生费用。 */
  test('经端口批量运行后本轮中止：已开始的节点照常完成并写回，排队的节点不再提交', async () => {
    const root = await workspace()
    const service = new CanvasService({ publish: () => {} })
    const port = canvasPort(service, { id: 'ws', root })
    const { refs } = await port.edit(
      PATH,
      Array.from({ length: 5 }, (_, i) => ({
        op: 'add_generate' as const,
        output: 'image' as const,
        ref: `$${i}`,
        name: `p${i}`,
        prompt: `p${i}`,
      })),
    )
    const ids = Object.values(refs)
    const fake = heldPort()
    const stop = new AbortController()
    const batch = port.runBatch(PATH, ids, fake.port, stop.signal)
    const started = await Promise.all(Array.from({ length: 4 }, () => fake.next()))
    stop.abort()
    const results = await batch
    expect(results.filter((x) => !x.skipped).map((x) => x.result)).toEqual(
      Array(4).fill(STOPPED_WAIT),
    )
    const skipped = results.filter((x) => x.skipped)
    expect(skipped.map((x) => x.result)).toEqual([
      { ok: false, message: '运行已中止，未提交生成', pending: false },
    ])
    expect(started.some((h) => h.signal.aborted)).toBe(false)

    for (const held of started) {
      held.finish({
        ok: true,
        provider: 'q',
        model: 'm',
        files: [{ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: 'image/png' }],
      })
    }
    await until(async () => (await service.read(root, PATH)).doc.runs?.length === 4)
    const view = await service.read(root, PATH)
    expect(view.doc.runs?.map((x) => x.result)).toEqual(['done', 'done', 'done', 'done'])
    expect(fake.calls).toHaveLength(4)
    expect(view.states[skipped[0]!.node]).toEqual({ state: 'empty' })
  })

  /** 撤销方式与界面的取消相同：同一个 `CanvasService.cancel`，撤销请求经 `cancelMediaTask` 发给服务商。 */
  test('cancel_canvas 对可撤销的视频任务发出撤销请求并得到 cancelled，卡片恢复到生成之前', async () => {
    const requests: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        requests.push(`${req.method} ${new URL(req.url).pathname}`)
        if (req.method === 'POST') return Response.json({ id: 'ark-1' })
        if (req.method === 'DELETE') return Response.json({})
        return Response.json({ id: 'ark-1', status: 'queued' })
      },
    })
    const model = 'doubao-seedance-2-5-260628'
    const config: QyConfig = {
      providers: {
        channel: {
          kind: 'openai_chat_completions',
          apiKey: 'test-only',
          models: {},
          baseUrl: `http://127.0.0.1:${server.port}`,
          media: { [model]: { kind: 'ark_videos' } },
        },
      },
      mediaDefaults: { video: { provider: 'channel', model } },
    }
    const service = new CanvasService({
      publish: () => {},
      cancelTask: (task) => cancelMediaTask(config, task, AbortSignal.timeout(10_000)),
    })
    try {
      const root = await workspace()
      const { refs } = await service.apply(root, PATH, [
        { op: 'add_generate', ref: '$v', output: 'video', name: '日落', prompt: '海边日落' },
      ])
      const id = refs.$v!
      const run = await service.run({ id: 'ws', root }, PATH, id, {
        media: makeMediaPort(config),
      })
      await until(async () => {
        const state = (await service.read(root, PATH)).states[id]
        return state?.state === 'running' && state.taskId === 'ark-1'
      })
      const out = await cancelCanvas(canvasPort(service, { id: 'ws', root }), {
        path: PATH,
        node: '日落',
      })
      expect(out).toMatchObject({ status: 'success', data: { outcome: 'cancelled' } })
      expect(out.message).toContain('已撤销「日落」的生成')
      expect(requests).toContain('DELETE /contents/generations/tasks/ark-1')
      expect(await run.done).toEqual({ ok: false, message: '已取消生成', pending: false })
      expect((await service.read(root, PATH)).states[id]).toEqual({ state: 'empty' })
    } finally {
      await service.stop()
      server.stop(true)
    }
  })

  test('cancel_canvas 对没有任务号的单次请求返回 stopped；对未在生成的卡片返回失败，均不调用撤销', async () => {
    const root = await workspace()
    const asked: unknown[] = []
    const service = new CanvasService({
      publish: () => {},
      cancelTask: async (task) => {
        asked.push(task)
        return 'cancelled'
      },
    })
    const port = canvasPort(service, { id: 'ws', root })
    const { refs } = await port.edit(PATH, [
      { op: 'add_generate', output: 'image', ref: '$g', name: '海报', prompt: '海报' },
    ])
    const fake = heldPort()
    const waiting = port.run(PATH, refs.$g!, fake.port, new AbortController().signal)
    await fake.next()
    const out = await cancelCanvas(port, { path: PATH, node: '海报' })
    expect(out).toMatchObject({ status: 'success', data: { outcome: 'stopped' } })
    expect(out.message).toContain('没有可撤销的远端任务，远端结果未知')
    expect(await waiting).toEqual({
      ok: false,
      message: '已停止等待；远端结果未知',
      pending: false,
    })

    expect(await cancelCanvas(port, { path: PATH, node: '海报' })).toMatchObject({
      status: 'failure',
      executed: false,
      message: '该卡片未在生成',
    })
    expect(asked).toEqual([])
  })

  test('界面的取消与 cancel_canvas 调用同一个撤销函数', async () => {
    const root = await workspace()
    const r = applyCanvasOps(emptyCanvas(), OPS)
    if (!r.ok) throw new Error(r.error)
    await writeFile(join(root, PATH), serializeCanvas(r.doc))
    const asked: string[] = []
    const cancelTask: CanvasCancelTask = async (task) => {
      asked.push(task.taskId)
      return 'cancelled'
    }
    const service = new CanvasService({ publish: () => {}, cancelTask })
    const store = new Store({ path: ':memory:' })
    const ws = upsertWorkspace(store, root, 'demo')
    const at = { id: ws.id, root: ws.rootPath }
    const id = r.refs.$v!
    const fake = heldPort()

    const viaUi = await service.run(at, PATH, id, { media: fake.port })
    await (await fake.next()).submit('t-ui')
    const url = `http://127.0.0.1/api/canvas/cancel?ws=${ws.id}`
    const res = await handleApi(
      new URL(url),
      new Request(url, { method: 'POST', body: JSON.stringify({ path: PATH, nodeId: id }) }),
      { store, canvas: service } as unknown as ApiDeps,
    )
    expect(await res?.json()).toEqual({ outcome: 'cancelled' })
    await viaUi.done

    const viaAgent = await service.run(at, PATH, id, { media: fake.port })
    await (await fake.next()).submit('t-agent')
    const out = await cancelCanvas(canvasPort(service, at), { path: PATH, node: id })
    expect(out.data).toEqual({ outcome: 'cancelled' })
    await viaAgent.done
    expect(asked).toEqual(['t-ui', 't-agent'])
    store.close()
  })
})
