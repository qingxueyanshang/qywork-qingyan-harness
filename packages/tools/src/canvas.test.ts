/**
 * 覆盖 `canvas.ts` 的 `read_canvas` 与 `canvas` 两个工具，以及 `index.ts` 里按通道注册的那一条。
 *
 * 端口是假的：这里验的是工具这一侧的事——按有无通道注册、按动作声明权限、参数解析、
 * 运行用本轮的生成端口与中止信号、结果写成回执。端口背后的画布服务在 server 包测。
 */

import { describe, expect, test } from 'bun:test'
import { type CanvasPort, type MediaPort, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { applyCanvasOps, type CanvasOp, type CanvasView, emptyCanvas } from '@qywork/core'
import { canvasTool, readCanvasTool } from './canvas.ts'
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
  const seen: Seen = { edits: [], runs: [] }
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
      retrieve: async (_path, _node, _version, media, signal) => {
        seen.runs.push({ media, signal })
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
    expect(withPort.has('canvas')).toBe(true)
    expect(withPort.has('read_canvas')).toBe(true)
  })

  test('read_canvas 固定为读，canvas 固定为写（设置页要求权限效果不随参数变）', () => {
    expect(readCanvasTool.actionKind).toBe('read')
    expect(readCanvasTool.permissionEffect).toBe('read')
    expect(canvasTool.actionKind).toBe('write')
    expect(canvasTool.permissionEffect).toBe('write')
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
    const ok = await canvasTool.fn(
      {
        action: 'edit',
        path: 'board.canvas.json',
        ops_json: '[{"op":"add_generate","ref":"$x","output":"image"}]',
      },
      ctx(port),
    )
    expect(ok.status).toBe('success')
    expect(ok.message).toContain('$x = id9')
    expect(seen.edits).toEqual([[{ op: 'add_generate', ref: '$x', output: 'image' }]])
    const bad = await canvasTool.fn(
      { action: 'edit', path: 'board.canvas.json', ops_json: '{"op":"remove"}' },
      ctx(port),
    )
    expect(bad.errorKind).toBe('invalid_tool_arguments')
    const versions = await canvasTool.fn(
      {
        action: 'edit',
        path: 'board.canvas.json',
        ops_json: '[{"op":"update","id":"id2","versions":[]}]',
      },
      ctx(port),
    )
    expect(versions.errorKind).toBe('invalid_tool_arguments')
    expect(seen.edits).toHaveLength(1)
  })

  test('run 用本轮的生成端口与中止信号，产物进改动清单', async () => {
    const { port, seen } = fakePort({ ok: true, paths: ['generated/a.mp4'] })
    const c = ctx(port, media)
    const out = await canvasTool.fn({ action: 'run', path: 'board.canvas.json', node: 'id2' }, c)
    expect(seen.runs[0]!.media).toBe(media)
    expect(seen.runs[0]!.signal).toBe(c.signal)
    expect(out.fileChanges).toEqual([{ path: 'generated/a.mp4', changeType: 'created' }])
  })

  test('远端还在时回执说明怎么取回；没有生成通道时不调端口', async () => {
    const { port, seen } = fakePort({ ok: false, message: '等待超时', pending: true })
    const pending = await canvasTool.fn(
      { action: 'run', path: 'board.canvas.json', node: 'id2' },
      ctx(port, media),
    )
    expect(pending.message).toContain('action=retrieve')
    const noMedia = await canvasTool.fn(
      { action: 'run', path: 'board.canvas.json', node: 'id2' },
      ctx(port),
    )
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
})
