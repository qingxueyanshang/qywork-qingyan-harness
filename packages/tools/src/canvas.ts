/**
 * 画布工具：大模型经画布端口（`ctx.canvas`）读、改、运行工作区里的 `*.canvas.json`。
 *
 * 分成 `read_canvas`（读）与 `canvas`（改、运行、取回）两个：设置页的工具目录要求权限效果不随参数变，
 * 读画布也不该像写入那样在结束时让各客户端的文件快照失效。
 *
 * 读写与运行全部由服务端画布服务执行，与界面同一个实例：写入次序、在跑状态与失败原文只有那一份，
 * 大模型写进的节点在写入当下就推给界面，不等本次工具调用结束。
 * 运行用本轮的生成端口（`ctx.media`），花费进本轮。
 */

import type { ToolOutcome, ToolSpec } from '@qywork/agent'
import { type CanvasView, displayNameOf, parseCanvasOps } from '@qywork/core'

const ACTIONS = ['edit', 'run', 'retrieve'] as const
type Action = (typeof ACTIONS)[number]

function failure(message: string, errorKind?: string): ToolOutcome {
  return { status: 'failure', executed: false, message, ...(errorKind ? { errorKind } : {}) }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function actionOf(args: Record<string, unknown>): Action | undefined {
  return (ACTIONS as readonly unknown[]).includes(args.action) ? (args.action as Action) : undefined
}

/** 画布写成给大模型读的几行：节点（id、类型、名字、状态、路径或提示词）与连线。 */
function describe(view: CanvasView): string {
  const byId = new Map(view.doc.nodes.map((n) => [n.id, n]))
  const lines = [
    `画布 ${view.path}：${view.doc.nodes.length} 个节点，${view.doc.edges.length} 条连线`,
  ]
  for (const n of view.doc.nodes) {
    const state = view.states[n.id]
    const status =
      state?.state === 'failed'
        ? `失败：${state.message}`
        : state?.state === 'pending'
          ? `待取回（版本 ${state.version}）`
          : ({ normal: '正常', missing: '文件缺失', empty: '未生成', running: '生成中' } as const)[
              state?.state ?? 'normal'
            ]
    if (n.type === 'file') {
      lines.push(`- ${n.id} 文件「${displayNameOf(n)}」${n.path}（${status}）`)
      continue
    }
    if (n.type === 'timeline') {
      const total = n.clips.reduce((sum, c) => sum + c.out - c.in, 0)
      lines.push(
        `- ${n.id} 时间线「${n.name}」${n.clips.length} 段，共 ${Math.round(total * 10) / 10} 秒` +
          `${n.muted ? '，静音' : ''}（${status}）`,
        ...n.clips.map((c, i) => `  ${i + 1}. ${c.path} ${c.in}–${c.out} 秒`),
      )
      continue
    }
    const current = n.versions.find((v) => v.id === n.current)
    const model = n.provider && n.model ? `${n.provider} / ${n.model}` : '默认模型'
    lines.push(
      `- ${n.id} ${n.output} 生成卡「${n.name}」${model}，${n.versions.length} 版` +
        `${current ? `，当前 ${current.path}` : ''}（${status}）`,
      `  提示词：${n.prompt || '（空）'}`,
    )
    const params = Object.keys(n.params).length ? JSON.stringify(n.params) : ''
    if (params) lines.push(`  参数：${params}`)
  }
  for (const e of view.doc.edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    lines.push(
      `- 连线 ${e.id}：${from ? displayNameOf(from) : e.from} → ${to ? displayNameOf(to) : e.to}（${e.role}）`,
    )
  }
  return lines.join('\n')
}

/** 画布的结构说明，两个工具共用。 */
const CANVAS_NOTE =
  '画布是工作区里的 *.canvas.json，只引用工作区文件：file 节点是一个文件路径，' +
  'generate 节点是一张生成卡（输出类别、提示词、模型、参数与历次结果），timeline 节点是一条视频时间线' +
  '（clips 按顺序首尾相接，每段 {"path":"视频路径","in":起始秒,"out":结束秒}，只引用源文件、不改它；成片要用户在界面上点导出，工具做不了）。连线把素材接到生成卡上，用途 role 为 ' +
  'reference（参考图）、first_frame / last_frame（首尾帧，不能与参考素材同时给）、video（参考视频）、audio（参考音频）。'

export const readCanvasTool: ToolSpec = {
  name: 'read_canvas',
  description:
    '读画布。' +
    CANVAS_NOTE +
    '给 path 返回节点、连线与各节点状态（正常、文件缺失、未生成、生成中、待取回、失败）；不给 path 列出工作区里的画布。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径；不给时列出工作区里的画布' },
    },
    required: [],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '画布',
  category: 'external',
  facet: '生成',
  summary: '读画布或列出工作区里的画布',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'read',
  parallelSafe: true,
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    try {
      if (!path) {
        const list = await canvas.list()
        return {
          status: 'success',
          message: list.length ? `工作区里的画布：\n${list.join('\n')}` : '工作区里还没有画布',
          data: { canvases: list },
        }
      }
      const view = await canvas.read(path)
      return { status: 'success', message: describe(view), data: { view } }
    } catch (err) {
      return { status: 'failure', executed: false, message: (err as Error).message }
    }
  },
}

export const canvasTool: ToolSpec = {
  name: 'canvas',
  description:
    '改画布、运行画布上的生成卡。' +
    CANVAS_NOTE +
    '先用 read_canvas 看节点与 id。' +
    'action=edit：ops_json 是一批操作的 JSON 数组，整批生效或整批不生效。操作：' +
    '{"op":"add_file","path":"工作区路径"}、{"op":"add_generate","output":"image|video|audio","prompt":"…"}、' +
    '{"op":"update","id":"节点或连线 id",…要改的字段}、{"op":"connect","from":"id","to":"生成卡 id","role":"…"}、' +
    '{"op":"remove","id":"节点或连线 id"}（删某一版再加 "version"）、{"op":"set_mode","id":"视频卡 id","mode":"reference|first_last"}、' +
    '{"op":"add_timeline","clips":[…]}（改片段用 update 的 clips 整组替换，muted 切换整条静音）；' +
    'add_file、add_generate、add_timeline 可选 name、x、y，或用 "beside":"节点 id" 放在该节点右侧的空位、"near":{"x":…,"y":…} 放在该点附近的空位；add_generate 可选 provider、model、params（取值见本轮「可用的生成模型」）。' +
    'add_* 与 connect 可带 "ref":"$名字"，同一批后面的操作与提示词里用它代替新节点的 id。' +
    '提示词里用 @[节点 id] 指代素材，引用了未连线的素材时自动连上。' +
    'action=run：运行 node 指定的生成卡并等到结果，按次计费，不得为试探效果重复调用。' +
    'action=retrieve：取回 node 上还在远端的视频（version 可选），不重新提交、不重复计费。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: '要做什么' },
      path: { type: 'string', description: '画布文件的工作区路径' },
      ops_json: { type: 'string', description: 'edit 的操作数组，JSON' },
      node: { type: 'string', description: 'run / retrieve 的生成卡 id' },
      version: { type: 'string', description: 'retrieve 取哪一版；不给取当前版或最新的待取回版' },
    },
    required: ['action', 'path'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '画布',
  category: 'external',
  facet: '生成',
  summary: '改画布、运行画布上的生成卡',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const action = actionOf(args)
    if (!action) return failure('action 只能是 edit、run、retrieve', 'invalid_tool_arguments')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    try {
      if (action === 'edit') {
        let raw: unknown
        try {
          raw = JSON.parse(String(args.ops_json ?? ''))
        } catch {
          return failure('ops_json 必须是 JSON 数组', 'invalid_tool_arguments')
        }
        const parsed = parseCanvasOps(raw)
        if (!parsed.ok) return failure(parsed.error, 'invalid_tool_arguments')
        const { view, refs } = await canvas.edit(path, parsed.ops)
        const named = Object.entries(refs).map(([ref, id]) => `${ref} = ${id}`)
        return {
          status: 'success',
          message: `${named.length ? `新建：${named.join('、')}\n` : ''}${describe(view)}`,
          data: { refs },
        }
      }
      const node = text(args.node)
      if (!node) return failure('缺少 node', 'invalid_tool_arguments')
      if (!ctx.media) return failure('本次执行没有生成通道：还没有配置生成模型')
      const result =
        action === 'run'
          ? await canvas.run(path, node, ctx.media, ctx.signal)
          : await canvas.retrieve(path, node, text(args.version), ctx.media, ctx.signal)
      if (!result.ok) {
        return {
          status: 'failure',
          executed: true,
          message: result.pending
            ? `${result.message}\n远端任务还在，这一版留在画布上，用 action=retrieve 取回，不会重复计费。`
            : result.message,
        }
      }
      return {
        status: 'success',
        message: `已生成：${result.paths.join('、')}`,
        data: { paths: result.paths },
        fileChanges: result.paths.map((p) => ({ path: p, changeType: 'created' as const })),
      }
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}
