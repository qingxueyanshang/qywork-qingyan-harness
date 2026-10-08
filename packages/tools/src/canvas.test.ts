/**
 * 覆盖 `canvas.ts` 的读取、编辑、运行与取回工具，以及 `index.ts` 中按通道注册的逻辑。
 *
 * 端口使用假实现：此处验证工具一侧的行为，包括按通道是否存在决定注册、按动作声明权限、参数解析、
 * 运行时使用本轮的生成端口与中止信号、结果写为回执。端口背后的画布服务由 server 包的测试覆盖。
 */

import { describe, expect, test } from 'bun:test'
import { type CanvasPort, type MediaPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { applyCanvasOps, type CanvasOp, type CanvasView, emptyCanvas } from '@qywork/core'
import {
  createCanvasTool,
  editCanvasTool,
  readCanvasTool,
  retrieveCanvasTool,
  runCanvasTool,
} from './canvas.ts'
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
      read: async () => view(),
      edit: async (_path, ops) => {
        seen.edits.push(ops)
        return { view: view(), refs: { $x: 'id9' } }
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
    const { port, seen } = fakePort({ ok: true, paths: [] })
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

  test('批量 id 去重，仍使用本轮生成端口与中止信号；非法数组不派发', async () => {
    const { port, seen } = fakePort({ ok: true, paths: ['a.png'] })
    const c = ctx(port, media)
    const args = { path: 'board.canvas.json', node: ['a', 'b', 'a'] }
    expect((await runCanvasTool.fn(args, c)).status).toBe('success')
    expect(seen.batches).toEqual([{ nodes: ['a', 'b'], media, signal: c.signal }])
    for (const node of [[], ['a', ''], ['a', 1], { id: 'a' }, null]) {
      expect(await runCanvasTool.fn({ ...args, node }, c)).toMatchObject({
        executed: false,
        errorKind: 'invalid_tool_arguments',
      })
    }
    expect(seen.batches).toHaveLength(1)
    expect(seen.runs).toHaveLength(0)
  })

  test('批量部分失败仍返回成功文件与逐节点结果，不把整批报告为成功', async () => {
    const { port } = fakePort({ ok: true, paths: [] })
    port.runBatch = async () => [
      { node: 'a', result: { ok: true, paths: ['generated/a.png'] } },
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
    expect(out.fileChanges).toEqual([{ path: 'generated/a.png', changeType: 'created' }])
    expect(out.data?.results).toHaveLength(3)
  })

  test('read 不提供路径时列出画布；提供路径时输出节点、状态与连线', async () => {
    const { port } = fakePort({ ok: true, paths: [] })
    const list = await readCanvasTool.fn({}, ctx(port))
    expect(list.message).toContain('分镜/第二集.canvas.json')
    const one = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(one.message).toContain('- id1 文件「小满」角色/小满.png（正常）')
    expect(one.message).toContain(
      '- id2 video 生成卡「视频1」默认模型，0 版（失败：内容审核未通过）',
    )
    expect(one.message).toContain('提示词：@[id1] 走出校门')
    expect(one.message).toContain('小满 → 视频1（reference）')
  })

  test('edit 解析 ops_json 后交给端口；不是 JSON 数组或操作不合法时不调用端口', async () => {
    const { port, seen } = fakePort({ ok: true, paths: [] })
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

  test('run 使用本轮的生成端口与中止信号，产物写入改动清单', async () => {
    const { port, seen } = fakePort({ ok: true, paths: ['generated/a.mp4'] })
    const c = ctx(port, media)
    const out = await runCanvasTool.fn({ path: 'board.canvas.json', node: 'id2' }, c)
    expect(seen.runs[0]!.media).toBe(media)
    expect(seen.runs[0]!.signal).toBe(c.signal)
    expect(out.fileChanges).toEqual([{ path: 'generated/a.mp4', changeType: 'created' }])
  })

  test('远端任务未结束时回执说明取回方式；没有生成通道时不调用端口', async () => {
    const { port, seen } = fakePort({ ok: false, message: '等待超时', pending: true })
    const pending = await runCanvasTool.fn(
      { path: 'board.canvas.json', node: 'id2' },
      ctx(port, media),
    )
    expect(pending.message).toContain('retrieve_canvas')
    const noMedia = await runCanvasTool.fn({ path: 'board.canvas.json', node: 'id2' }, ctx(port))
    expect(noMedia.message).toContain('没有生成通道')
    expect(seen.runs).toHaveLength(1)
  })

  test('端口抛出的错误原文交给模型', async () => {
    const { port } = fakePort({ ok: true, paths: [] })
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
      paths: ['generated/a.mp4'],
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
    const { port, seen } = fakePort({ ok: true, paths: [] })
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
