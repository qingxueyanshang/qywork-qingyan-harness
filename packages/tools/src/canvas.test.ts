/**
 * 覆盖 `canvas.ts` 的 读取、编辑、运行与取回工具，以及 `index.ts` 里按通道注册的那一条。
 *
 * 端口是假的：这里验的是工具这一侧的事——按有无通道注册、按动作声明权限、参数解析、
 * 运行用本轮的生成端口与中止信号、结果写成回执。端口背后的画布服务在 server 包测。
 */

import { describe, expect, test } from 'bun:test'
import { type CanvasPort, type MediaPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { applyCanvasOps, type CanvasOp, type CanvasView, emptyCanvas } from '@qywork/core'
import { editCanvasTool, readCanvasTool, retrieveCanvasTool, runCanvasTool } from './canvas.ts'
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
  edits: CanvasOp[][]
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
  const seen: Seen = { edits: [], runs: [], retrieves: [] }
  return {
    seen,
    port: {
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
    for (const name of ['edit_canvas', 'run_canvas', 'retrieve_canvas']) {
      expect(none.has(name)).toBe(false)
      expect(withPort.has(name)).toBe(true)
    }
    expect(withPort.has('read_canvas')).toBe(true)
  })

  test('画布工具分别声明动作，编辑、运行与取回均需要写权限', () => {
    expect(readCanvasTool.actionKind).toBe('read')
    expect(readCanvasTool.permissionEffect).toBe('read')
    expect(editCanvasTool.actionKind).toBe('edit')
    expect(runCanvasTool.actionKind).toBe('run')
    for (const tool of [editCanvasTool, runCanvasTool, retrieveCanvasTool]) {
      expect(tool.permissionEffect).toBe('write')
      expect(tool.parameters.properties).not.toHaveProperty('action')
    }
  })

  test('read 不给路径列出画布；给路径写出节点、状态与连线', async () => {
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

  test('edit 解析 ops_json 交给端口；不是 JSON 数组或操作不合法时不调端口', async () => {
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

  test('run 用本轮的生成端口与中止信号，产物进改动清单', async () => {
    const { port, seen } = fakePort({ ok: true, paths: ['generated/a.mp4'] })
    const c = ctx(port, media)
    const out = await runCanvasTool.fn({ path: 'board.canvas.json', node: 'id2' }, c)
    expect(seen.runs[0]!.media).toBe(media)
    expect(seen.runs[0]!.signal).toBe(c.signal)
    expect(out.fileChanges).toEqual([{ path: 'generated/a.mp4', changeType: 'created' }])
  })

  test('远端还在时回执说明怎么取回；没有生成通道时不调端口', async () => {
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

  test('端口抛出的原文交给大模型', async () => {
    const { port } = fakePort({ ok: true, paths: [] })
    port.read = async () => {
      throw new Error('board.canvas.json 不存在或不在这个项目里')
    }
    const out = await readCanvasTool.fn({ path: 'board.canvas.json' }, ctx(port))
    expect(out).toMatchObject({
      status: 'failure',
      message: 'board.canvas.json 不存在或不在这个项目里',
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
    expect(seen).toEqual({ edits: [], runs: [], retrieves: [] })
  })
})
