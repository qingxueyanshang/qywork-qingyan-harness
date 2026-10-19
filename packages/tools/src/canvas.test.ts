/**
 * 覆盖 `canvas.ts` 的读取、编辑、运行与取回工具，`index.ts` 中按通道注册的逻辑，
 * 以及 `files.ts` 写入文本文件后附上的画布引用说明。
 *
 * 端口使用假实现：此处验证工具一侧的行为，包括按通道是否存在决定注册、按动作声明权限、参数解析、
 * 运行时使用本轮的生成端口与中止信号、结果写为回执。端口背后的画布服务由 server 包的测试覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CanvasPort,
  type MediaPort,
  openBatchBudget,
  type ToolContext,
  ToolRegistry,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { applyCanvasOps, type CanvasOp, type CanvasView, emptyCanvas } from '@qywork/core'
import {
  createCanvasTool,
  editCanvasTool,
  readCanvasTool,
  retrieveCanvasTool,
  runCanvasTool,
} from './canvas.ts'
import { editFileTool, readFileTool, writeFileTool } from './files.ts'
import { registerBuiltinTools } from './index.ts'

function view(): CanvasView {
  const r = applyCanvasOps(
    emptyCanvas(),
    [
      { op: 'add_file', ref: '$a', path: '角色/小满.png' },
      { op: 'add_generate', ref: '$v', output: 'video', prompt: '@[$a] 走出校门' },
    ],
    (() => {
      let n = 0
      return () => `id${++n}`
    })(),
  )
  if (!r.ok) throw new Error(r.error)
  return {
    path: 'board.canvas.json',
    doc: r.doc,
    states: { id1: { state: 'normal' }, id2: { state: 'failed', message: '内容审核未通过' } },
  }
}

interface Seen {
  creates: string[]
  edits: CanvasOp[][]
  batches: { nodes: string[]; media: MediaPort; signal: AbortSignal }[]
  runs: { media: MediaPort; signal: AbortSignal }[]
  retrieves: {
    path: string
    node: string
    version: string | undefined
    media: MediaPort
    signal: AbortSignal
  }[]
}

function ctx(port: CanvasPort | undefined, media?: MediaPort): ToolContext {
  return {
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
    ...(port ? { canvas: port } : {}),
    ...(media ? { media } : {}),
  }
}

/** 有三张生成卡的画布：id 为 a、b、c，名称为 镜头A、镜头B、镜头C。 */
function cards(): CanvasView {
  const order = ['a', 'b', 'c']
  const r = applyCanvasOps(
    emptyCanvas(),
    order.map((id) => ({ op: 'add_generate', output: 'image', name: `镜头${id.toUpperCase()}` })),
    () => order.shift()!,
  )
  if (!r.ok) throw new Error(r.error)
  return { path: 'board.canvas.json', doc: r.doc, states: {} }
}

function fakePort(result: Awaited<ReturnType<CanvasPort['run']>>): {
  port: CanvasPort
  seen: Seen
} {
  const seen: Seen = { creates: [], edits: [], batches: [], runs: [], retrieves: [] }
  return {
    seen,
    port: {
      create: async (path) => {
        seen.creates.push(path)
        return path
      },
      list: async () => ['board.canvas.json', '分镜/第二集.canvas.json'],
      textReferences: async () => [],
      read: async () => view(),
      edit: async (_path, ops) => {
        seen.edits.push(ops)
        return {
          view: view(),
          refs: { $x: 'id9' },
          skipped: [],
          changed: ['id2'],
          removed: [],
          replaced: [],
        }
      },
      run: async (_path, _node, media, signal) => {
        seen.runs.push({ media, signal })
        return result
      },
      runBatch: async (_path, nodes, media, signal) => {
        seen.batches.push({ nodes, media, signal })
        return nodes.map((node) => ({ node, result }))
      },
      retrieve: async (path, node, version, media, signal) => {
        seen.retrieves.push({ path, node, version, media, signal })
        return result
      },
    },
  }
}

const media: MediaPort = { generate: async () => ({ ok: false, message: '不该直接调' }) }

const DONE: Awaited<ReturnType<CanvasPort['run']>> = { ok: true, outputs: [], params: {} }

describe('canvas 工具', () => {
  test('没有画布通道时不注册', () => {
    const none = new ToolRegistry()
    registerBuiltinTools(none)
    expect(none.has('canvas')).toBe(false)
    expect(none.has('read_canvas')).toBe(false)
    const withPort = new ToolRegistry()
    registerBuiltinTools(withPort, { canvas: true })
    expect(withPort.has('canvas')).toBe(false)
    for (const name of ['create_canvas', 'edit_canvas', 'run_canvas', 'retrieve_canvas']) {
      expect(none.has(name)).toBe(false)
      expect(withPort.has(name)).toBe(true)
    }
    expect(withPort.has('read_canvas')).toBe(true)
  })

  test('画布工具分别声明动作，编辑、运行与取回均需要写权限', () => {
    expect(readCanvasTool.actionKind).toBe('read')
    expect(readCanvasTool.permissionEffect).toBe('read')
    expect(editCanvasTool.actionKind).toBe('edit')
    expect(createCanvasTool.actionKind).toBe('write')
    expect(runCanvasTool.actionKind).toBe('run')
    for (const tool of [createCanvasTool, editCanvasTool, runCanvasTool, retrieveCanvasTool]) {
      expect(tool.permissionEffect).toBe('write')
      expect(tool.parameters.properties).not.toHaveProperty('action')
    }
  })

  test('创建返回文件改动；缺参、非画布路径或权限拒绝不创建', async () => {
    const { port, seen } = fakePort(DONE)
    const registry = new ToolRegistry()
    registerBuiltinTools(registry, { canvas: true })
    const c = ctx(port)
    expect(await registry.execute('create_canvas', {}, c)).toMatchObject({
      errorKind: 'invalid_tool_arguments',
    })
    expect(await registry.execute('create_canvas', { path: 'a.json' }, c)).toMatchObject({
      executed: false,
    })
    const path = '分镜/第一集.canvas.json'
    const out = await registry.execute('create_canvas', { path }, c)
    expect(out.status).toBe('success')
    expect(out.data).toEqual({ path })
    expect(out.fileChanges).toEqual([{ path, changeType: 'created' }])
    c.requestPermission = async () => ({ allowed: false, reason: '用户拒绝' })
    expect(await registry.execute('create_canvas', { path: 'b.canvas.json' }, c)).toMatchObject({
      errorKind: 'permission_denied',
    })
    expect(seen.creates).toEqual([path])
  })

  test('批量按卡片名称或 id 运行并去重，仍使用本轮生成端口与中止信号；非法数组或不存在的卡不派发', async () => {
    const { port, seen } = fakePort({ ok: true, outputs: [{ path: 'a.png' }], params: {} })
    port.read = async () => cards()
    const c = ctx(port, media)
    const args = { path: 'board.canvas.json', node: ['a', '镜头B', 'a'] }
    expect((await runCanvasTool.fn(args, c)).status).toBe('success')
    expect(seen.batches).toEqual([{ nodes: ['a', 'b'], media, signal: c.signal }])
    const missing = await runCanvasTool.fn({ ...args, node: ['镜头Z'] }, c)
    expect(missing.message).toBe('未找到卡片「镜头Z」：引用卡片时写画布上已有的卡片名称或 id')
    for (const node of [[], ['a', ''], ['a', 1], { id: 'a' }, null, 'a', '["a","b"]', ['镜头Z']]) {
      expect(await runCanvasTool.fn({ ...args, node }, c)).toMatchObject({
        executed: false,
        errorKind: 'invalid_tool_arguments',
      })
    }
    expect(seen.batches).toHaveLength(1)
    expect(seen.runs).toHaveLength(0)
  })

  test('批量部分失败仍返回成功文件与逐节点结果，不把整批报告为成功', async () => {
    const { port } = fakePort(DONE)
    port.read = async () => cards()
    port.runBatch = async () => [
      { node: 'a', result: { ok: true, outputs: [{ path: 'generated/a.png' }], params: {} } },
      { node: 'b', result: { ok: false, message: '等待超时', pending: true } },
      { node: 'c', skipped: true, result: { ok: false, message: '上游失败', pending: false } },
    ]
    const out = await runCanvasTool.fn(
      { path: 'board.canvas.json', node: ['a', 'b', 'c'] },
      ctx(port, media),
    )
    expect(out.status).toBe('failure')
    expect(out.executed).toBe(true)
    expect(out.message).toContain('1 个成功，1 个失败，1 个未运行')
    expect(out.message).toContain('retrieve_canvas')
    expect(out.message).toContain('不要整批重新运行')
    expect(out.message.match(/核对画面：用 read_file/g)).toHaveLength(1)
    expect(out.fileChanges).toEqual([{ path: 'generated/a.png', changeType: 'created' }])
    expect(out.data?.results).toHaveLength(3)
  })

  /**
   * 原始失败形状：读取回执列出每张卡的提示词全文，二十张卡达数万字，模型改用脚本读取画布文件。
   * 概况每张卡一行，只写提示词字数；全文按卡片名称读取。
   */
  test('read 不提供路径时列出画布；提供路径时为概况，提示词只写字数；node 给出时为这些卡的全文', async () => {
    const { port } = fakePort(DONE)
    const list = await readCanvasTool.fn({}, ctx(port))
    expect(list.message).toContain('分镜/第二集.canvas.json')
    const one = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(one.message).toContain('- id1 文件「小满」（组：图片）角色/小满.png（正常）')
    expect(one.message).toContain(
      '- id2 video 生成卡「视频1」（组：视频）默认模型，0 版（失败：内容审核未通过）；参数：未设置，按模型缺省值生成；输入：小满（reference）；提示词 11 字',
    )
    expect(one.message).not.toContain('走出校门')
    expect(one.message).toContain('小满 → 视频1（reference）')
    const full = await readCanvasTool.fn({ path: 'board.canvas.json', node: ['视频1'] }, ctx(port))
    expect(full.message).toContain('提示词：@[id1] 走出校门')
    expect(full.message).toContain('  输入：小满（reference）')
    expect(full.message).not.toContain('文件「小满」')
    const missing = await readCanvasTool.fn(
      { path: 'board.canvas.json', node: ['镜头9'] },
      ctx(port),
    )
    expect(missing.status).toBe('failure')
    port.read = async () => {
      const v = view()
      return { ...v, doc: { ...v.doc, edges: [] } }
    }
    const lone = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(lone.message).toContain('输入：无，只按提示词生成')
  })

  test('read 在概况与全文中标出失效的文本引用', async () => {
    const { port } = fakePort(DONE)
    const broken = '@[脚本#1-2 入梦]：文中没有标题「1-2 入梦」'
    port.read = async () => ({ ...view(), references: { id2: [broken] } })
    const one = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(one.message).toContain(`提示词 11 字；引用失效：${broken}`)
    const full = await readCanvasTool.fn({ path: 'board.canvas.json', node: ['视频1'] }, ctx(port))
    expect(full.message).toContain(`  引用失效（运行前须修正）：${broken}`)
  })

  test('read 的 render：截图作为图片附上，回执写明尺寸、截图序号、页面脚本报错与无法渲染的原因', async () => {
    const { port } = fakePort(DONE)
    const asked: string[][] = []
    port.render = async (_path, nodes) => {
      asked.push(nodes)
      return [
        {
          name: '首页',
          size: { w: 960, h: 1280 },
          png: 'iVBORw0KGgo=',
          errors: ['TypeError: x is null'],
        },
        { name: '小满', failure: '不是设计稿卡' },
      ]
    }
    const out = await readCanvasTool.fn(
      { path: 'board.canvas.json', render: ['首页', '小满'] },
      ctx(port),
    )
    expect(out.status).toBe('success')
    expect(asked).toEqual([['首页', '小满']])
    expect(out.message).toContain(
      '\n截图 1：「首页」按 960×1280 渲染\n  页面脚本报错：TypeError: x is null\n「小满」无法渲染：不是设计稿卡',
    )
    expect(out.data?.images).toEqual([{ data: 'iVBORw0KGgo=', mime: 'image/png' }])

    delete port.render
    const none = await readCanvasTool.fn({ path: 'board.canvas.json', render: ['首页'] }, ctx(port))
    expect(none).toMatchObject({ status: 'failure', message: '内置浏览器不可用，无法渲染设计稿' })
  })

  test('写入或编辑文本文件后，回执附上画布中引用它的卡与失效的引用；其他类型的文件不查询', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-canvas-note-'))
    const { port } = fakePort(DONE)
    const asked: string[] = []
    port.textReferences = async (path) => {
      asked.push(path)
      return ['画布 board.canvas.json 中 1 张卡引用此文件（视频1），下次运行时发送修改后的内容。']
    }
    const c = {
      ...ctx(port),
      workspaceRoot: dir,
      state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    }
    const created = await writeFileTool.fn(
      { path: '脚本.md', mode: 'create', content: '## 1-1\n推门。\n' },
      c,
    )
    expect(created.message).toBe(
      '创建 脚本.md\n画布 board.canvas.json 中 1 张卡引用此文件（视频1），下次运行时发送修改后的内容。',
    )
    await readFileTool.fn({ path: '脚本.md' }, c)
    const edited = await editFileTool.fn(
      { path: '脚本.md', edits: [{ old_string: '推门', new_string: '敲门' }] },
      c,
    )
    expect(edited.message).toContain('（1/1 项已写入）\n画布 board.canvas.json 中 1 张卡')
    await writeFileTool.fn({ path: 'a.json', mode: 'create', content: '{}' }, c)
    expect(asked).toEqual(['脚本.md', '脚本.md'])
  })

  test('读取运行中的视频：无任务号明确未确认受理，已有任务号立即展示并区分平台阶段', async () => {
    const { port } = fakePort(DONE)
    const v = view()
    port.read = async () => v
    const card = { path: v.path, node: ['视频1'] }
    v.states.id2 = { state: 'running', startedAt: 1 }
    expect((await readCanvasTool.fn({ path: v.path }, ctx(port))).message).toContain('提交中')
    const pending = await readCanvasTool.fn(card, ctx(port))
    expect(pending.message).toContain('提交中')
    expect(pending.message).toContain('尚未取得远端任务号，不能确认平台已受理')
    expect(pending.message).not.toContain('排队中')
    v.states.id2 = { state: 'running', startedAt: 1, taskId: 'remote-task' }
    const submitted = await readCanvasTool.fn(card, ctx(port))
    expect(submitted.message).toContain('已提交')
    expect(submitted.message).toContain('远端任务号：remote-task')
    v.states.id2.phase = 'queued'
    const queued = await readCanvasTool.fn(card, ctx(port))
    expect(queued.message).toContain('排队中')
    expect(queued.message).not.toContain('不能确认平台已受理')
    v.states.id2.phase = 'running'
    expect((await readCanvasTool.fn(card, ctx(port))).message).toContain('生成中')
  })

  test('edit 解析 ops_json 后交给端口；不是 JSON 数组或操作不合法时不调用端口', async () => {
    const { port, seen } = fakePort(DONE)
    const ok = await editCanvasTool.fn(
      {
        path: 'board.canvas.json',
        ops_json: '[{"op":"add_generate","ref":"$x","output":"image"}]',
      },
      ctx(port),
    )
    expect(ok.status).toBe('success')
    expect(ok.message).toContain('$x = id9')
    expect(seen.edits).toEqual([[{ op: 'add_generate', ref: '$x', output: 'image' }]])
    const bad = await editCanvasTool.fn(
      { path: 'board.canvas.json', ops_json: '{"op":"remove"}' },
      ctx(port),
    )
    expect(bad.errorKind).toBe('invalid_tool_arguments')
    const versions = await editCanvasTool.fn(
      { path: 'board.canvas.json', ops_json: '[{"op":"update","id":"id2","versions":[]}]' },
      ctx(port),
    )
    expect(versions.errorKind).toBe('invalid_tool_arguments')
    expect(seen.edits).toHaveLength(1)
  })

  /**
   * 原始失败形状：一批 8 张卡中的一条夹带未知字段 `_x`，整批被拒，模型重发约 1.3 万字；
   * 同一处修改要套到 10 张卡时只能逐张写，模型改用脚本改写画布文件。
   */
  test('edit 逐条生效：不成立的条目跳过并写明原因，其余照常交给端口；ids 与 group 展开为逐卡操作', async () => {
    const { port, seen } = fakePort(DONE)
    const out = await editCanvasTool.fn(
      {
        path: 'board.canvas.json',
        ops_json: [
          { op: 'update', id: '视频1', model: 'm', _x: 0 },
          { op: 'replace_text', ids: ['视频1', '镜头B'], old: '校门', new: '操场' },
          { op: 'update', group: '视频', provider: 'p', model: 'm' },
          { op: 'update', group: '道具', model: 'm' },
          { op: 'replace_text', id: '视频1', ids: ['视频1'], old: 'a', new: 'b' },
        ],
      },
      ctx(port),
    )
    expect(seen.edits).toEqual([
      [
        { op: 'replace_text', id: '视频1', old: '校门', new: '操场' },
        { op: 'replace_text', id: '镜头B', old: '校门', new: '操场' },
        { op: 'update', id: '视频1', provider: 'p', model: 'm' },
      ],
    ])
    expect(out.status).toBe('success')
    expect(out.message).toContain('本批 6 项操作，执行 3 项，跳过 3 项')
    expect(out.message).toContain('- 第 1 条（update「视频1」）：含有未知字段：_x')
    expect(out.message).toContain('- 第 4 条（update）：组「道具」中没有生成卡')
    expect(out.message).toContain(
      '- 第 5 条（replace_text「视频1」）：id 与 ids、group 只能给出其中一个',
    )
  })

  test('edit 回执只列改动的卡与端口跳过的条目，未改动的卡不写入', async () => {
    const { port } = fakePort(DONE)
    port.edit = async () => ({
      view: view(),
      refs: {},
      skipped: [{ at: 1, error: '「镜头9」不存在' }],
      changed: ['id2'],
      removed: ['旧卡'],
      replaced: [{ at: 0, count: 2 }],
    })
    const out = await editCanvasTool.fn(
      {
        path: 'board.canvas.json',
        ops_json: [
          { op: 'replace_text', id: '视频1', old: '校门', new: '操场' },
          { op: 'remove', id: '镜头9' },
        ],
      },
      ctx(port),
    )
    expect(out.message).toContain('- 第 2 条（remove「镜头9」）：「镜头9」不存在')
    expect(out.message).toContain('替换：第 1 条（replace_text「视频1」） 2 处')
    expect(out.message).toContain('提示词：@[id1] 走出校门')
    expect(out.message).not.toContain('文件「小满」')
    expect(out.message).toContain('删除：「旧卡」')
    expect(out.message).toContain('未改动的卡用 read_canvas 的 node 按名称读取全文')
    port.edit = async () => ({
      view: view(),
      refs: {},
      skipped: [{ at: 0, error: '原因' }],
      changed: [],
      removed: [],
      replaced: [],
    })
    const none = await editCanvasTool.fn(
      { path: 'board.canvas.json', ops_json: [{ op: 'remove', id: '镜头9' }] },
      ctx(port),
    )
    expect(none.status).toBe('failure')
  })

  test('ops_json 直接传数组时与 JSON 文本同样生效', async () => {
    const { port, seen } = fakePort(DONE)
    const ok = await editCanvasTool.fn(
      { path: 'board.canvas.json', ops_json: [{ op: 'add_generate', ref: '$x', output: 'image' }] },
      ctx(port),
    )
    expect(ok.status).toBe('success')
    expect(seen.edits).toEqual([[{ op: 'add_generate', ref: '$x', output: 'image' }]])
  })

  test('edit 的新增操作不接受坐标、尺寸与相邻节点，该条跳过，其余照常执行；移动已有节点不受影响', async () => {
    const { port, seen } = fakePort(DONE)
    for (const extra of [
      '"x":0,"y":950',
      '"w":1536,"h":1024',
      '"near":{"x":0,"y":0}',
      '"beside":"id1"',
    ]) {
      const out = await editCanvasTool.fn(
        {
          path: 'board.canvas.json',
          ops_json: `[{"op":"add_file","path":"a.png","group":"素材"},{"op":"add_generate","output":"image",${extra}}]`,
        },
        ctx(port),
      )
      expect(out.status).toBe('success')
      expect(out.message).toContain('本批 2 项操作，执行 1 项，跳过 1 项')
      expect(out.message).toContain('- 第 2 条（add_generate）：')
      expect(out.message).toContain('由画布按 group 排列')
    }
    expect(seen.edits).toEqual(Array(4).fill([{ op: 'add_file', path: 'a.png', group: '素材' }]))
    seen.edits.length = 0
    const moved = await editCanvasTool.fn(
      { path: 'board.canvas.json', ops_json: '[{"op":"update","id":"id1","x":10,"y":20}]' },
      ctx(port),
    )
    expect(moved.status).toBe('success')
    expect(seen.edits).toEqual([[{ op: 'update', id: 'id1', x: 10, y: 20 }]])
  })

  test('run 使用本轮的生成端口与中止信号，产物写入改动清单', async () => {
    const { port, seen } = fakePort({
      ok: true,
      outputs: [{ path: 'generated/a.mp4' }],
      params: {},
    })
    const c = ctx(port, media)
    const out = await runCanvasTool.fn({ path: 'board.canvas.json', node: ['id2'] }, c)
    expect(seen.runs[0]!.media).toBe(media)
    expect(seen.runs[0]!.signal).toBe(c.signal)
    expect(out.fileChanges).toEqual([{ path: 'generated/a.mp4', changeType: 'created' }])
  })

  test('运行回执写出产物实测的宽高与时长和实际发送的参数；未设置参数时写明按缺省值生成', async () => {
    const { port } = fakePort({
      ok: true,
      outputs: [{ path: 'generated/a.mp4', size: { w: 1920, h: 1080 }, duration: 5.041 }],
      params: {},
    })
    const out = await runCanvasTool.fn(
      { path: 'board.canvas.json', node: ['id2'] },
      ctx(port, media),
    )
    expect(out.message).toBe(
      '已取得结果：\n  generated/a.mp4（1920×1080，5.04 秒）\n  发送的参数：未设置，按模型缺省值生成' +
        '\n核对画面：用 read_file 查看上述图片与视频是否符合提示词。',
    )
    port.run = async () => ({
      ok: true,
      outputs: [{ path: 'generated/b.mp4', size: { w: 854, h: 480 }, duration: 15 }],
      params: { resolution: '480P', duration: 15 },
    })
    const sent = await runCanvasTool.fn(
      { path: 'board.canvas.json', node: ['id2'] },
      ctx(port, media),
    )
    expect(sent.message).toContain('generated/b.mp4（854×480，15 秒）')
    expect(sent.message).toContain('发送的参数：{"resolution":"480P","duration":15}')
    const read = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(read.message).toContain('参数：未设置，按模型缺省值生成')
  })

  test('远端任务未结束时回执说明取回方式；没有生成通道时不调用端口', async () => {
    const { port, seen } = fakePort({ ok: false, message: '等待超时', pending: true })
    const pending = await runCanvasTool.fn(
      { path: 'board.canvas.json', node: ['id2'] },
      ctx(port, media),
    )
    expect(pending.message).toContain('retrieve_canvas')
    const noMedia = await runCanvasTool.fn({ path: 'board.canvas.json', node: ['id2'] }, ctx(port))
    expect(noMedia.message).toContain('没有生成通道')
    expect(seen.runs).toHaveLength(1)
  })

  test('端口抛出的错误原文交给模型', async () => {
    const { port } = fakePort(DONE)
    port.read = async () => {
      throw new Error('board.canvas.json 不存在或不在当前项目中')
    }
    const out = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(out).toMatchObject({
      status: 'failure',
      message: 'board.canvas.json 不存在或不在当前项目中',
    })
  })

  test('取回指定版本只调用 retrieve，保留本轮端口、信号与文件回执', async () => {
    const { port, seen } = fakePort({
      ok: true,
      outputs: [{ path: 'generated/a.mp4' }],
      params: {},
      warning: '部分结果可用',
    })
    const c = ctx(port, media)
    const registry = new ToolRegistry()
    registerBuiltinTools(registry, { canvas: true })
    const out = await registry.execute(
      'retrieve_canvas',
      {
        path: 'board.canvas.json',
        node: 'id2',
        version: 'v1',
      },
      c,
    )
    expect(out.status).toBe('success')
    expect(out.message).toContain('部分结果可用')
    expect(out.fileChanges).toEqual([{ path: 'generated/a.mp4', changeType: 'created' }])
    expect(seen.retrieves).toEqual([
      { path: 'board.canvas.json', node: 'id2', version: 'v1', media, signal: c.signal },
    ])
    expect(seen.runs).toEqual([])
    expect(seen.edits).toEqual([])
    await registry.execute('retrieve_canvas', { path: 'board.canvas.json', node: 'id2' }, c)
    expect(seen.retrieves[1]?.version).toBeUndefined()
    expect(seen.runs).toEqual([])
  })

  test('缺少编辑操作或生成节点时在权限检查前拒绝，端口不执行', async () => {
    const { port, seen } = fakePort(DONE)
    const c = ctx(port, media)
    const permissions: string[] = []
    c.requestPermission = async ({ toolName }) => {
      permissions.push(toolName)
      return { allowed: true }
    }
    const registry = new ToolRegistry()
    registerBuiltinTools(registry, { canvas: true })
    for (const name of ['edit_canvas', 'run_canvas', 'retrieve_canvas']) {
      for (const args of [{}, { path: 'board.canvas.json' }]) {
        expect(await registry.execute(name, args, c)).toMatchObject({
          status: 'failure',
          executed: false,
          errorKind: 'invalid_tool_arguments',
        })
      }
    }
    expect(permissions).toEqual([])
    expect(seen).toEqual({ creates: [], edits: [], batches: [], runs: [], retrieves: [] })
  })
})
