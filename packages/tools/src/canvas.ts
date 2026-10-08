/**
 * 画布工具：大模型经画布端口（`ctx.canvas`）创建、读取、修改、运行工作区中的 `*.canvas.json`。
 *
 * 读取、编辑、运行与取回分别声明工具及参数；取回只查询已有任务，不重新提交生成。
 *
 * 读写与运行全部由服务端画布服务执行，与界面共用同一个实例：写入次序、运行中状态与失败原文只有一份，
 * 大模型写入的节点在写入时即推送给界面，不等待本次工具调用结束。
 * 运行使用本轮的生成端口（`ctx.media`），费用计入本轮。
 */

import type { CanvasPort, ToolOutcome, ToolSpec } from '@qywork/agent'
import {
  ART_SIZE_PARAM,
  type CanvasBatchRunResult,
  type CanvasView,
  displayNameOf,
  parseCanvasOps,
} from '@qywork/core'

function failure(message: string, errorKind?: string): ToolOutcome {
  return { status: 'failure', executed: false, message, ...(errorKind ? { errorKind } : {}) }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 把画布转写为供大模型读取的文本行：节点（id、类型、名称、状态、路径或提示词）与连线。 */
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

/** 读取与编辑工具共用的画布结构说明。 */
const CANVAS_NOTE =
  '画布是工作区里的 *.canvas.json，只引用工作区文件：file 节点是一个文件路径，' +
  'generate 节点是一张生成卡（输出类别、提示词、模型、参数与历次结果），timeline 节点是一条视频时间线' +
  '（clips 按顺序首尾相接，每段 {"path":"视频路径","in":起始秒,"out":结束秒}，只引用、不修改源文件；成片须由用户在界面上点击导出，本工具无法完成）。连线将素材连接到生成卡，用途 role 为 ' +
  'reference（参考图）、first_frame / last_frame（首尾帧，不能与参考素材同时提供）、video（参考视频）、audio（参考音频）。' +
  'output 为 art 的生成卡由对话模型写出一个 HTML 页面（3D 白模、动画、前端设计稿），产物是 generated/ 下的 .html，' +
  '再次运行时在当前页面上修改；它只接受参考图，本身不能作为输入（截图与录制由用户在界面上完成）。' +
  '.html 文件放上画布同样作为 art 页面显示。'

export const createCanvasTool: ToolSpec = {
  name: 'create_canvas',
  description:
    '在工作区指定路径创建空画布，path 必须以 .canvas.json 结尾。自动创建父目录，已有文件不覆盖。' +
    '随后使用 edit_canvas 添加节点与连线，使用 run_canvas 运行生成卡。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '新画布的工作区路径，例如 分镜/第1集.canvas.json' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '在指定路径创建画布',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    if (!ctx.canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    if (!path?.endsWith('.canvas.json'))
      return failure('path 必须是以 .canvas.json 结尾的画布路径', 'invalid_tool_arguments')
    const created = await ctx.canvas.create(path)
    return {
      status: 'success',
      message: `已创建空画布：${created}。使用 edit_canvas 添加节点与连线。`,
      data: { path: created },
      fileChanges: [{ path: created, changeType: 'created' }],
    }
  },
}

export const readCanvasTool: ToolSpec = {
  name: 'read_canvas',
  description:
    '读取画布。' +
    CANVAS_NOTE +
    '提供 path 时返回节点、连线与各节点状态（正常、文件缺失、未生成、生成中、待取回、失败）；省略 path 时列出工作区里的画布。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径；省略时列出工作区里的画布' },
    },
    required: [],
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '读取画布或列出工作区里的画布',
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
          message: list.length ? `工作区里的画布：\n${list.join('\n')}` : '工作区里尚无画布',
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

export const editCanvasTool: ToolSpec = {
  name: 'edit_canvas',
  description:
    '修改画布的节点、提示词、参数与连线，不发起生成。' +
    CANVAS_NOTE +
    '先用 read_canvas 查看节点与 id；画布尚不存在时先用 create_canvas 创建。' +
    'ops_json 是一批操作的 JSON 数组，整批生效或整批不生效。操作：' +
    '{"op":"add_file","path":"工作区路径"}、{"op":"add_generate","output":"image|video|audio|art","prompt":"…"}、' +
    '{"op":"update","id":"节点或连线 id",…要改的字段}、{"op":"connect","from":"id","to":"生成卡 id","role":"…"}、' +
    '{"op":"remove","id":"节点或连线 id"}（删除某一版时另加 "version"）、{"op":"set_mode","id":"视频卡 id","mode":"reference|first_last"}、' +
    '{"op":"add_timeline","clips":[…]}（修改片段时用 update 的 clips 整组替换，muted 切换整条静音）；' +
    'add_file、add_generate、add_timeline 可选 name、x、y，或用 "beside":"节点 id" 放在该节点右侧的空位、"near":{"x":…,"y":…} 放在该点附近的空位；add_generate 可选 provider、model、params（取值见本轮「可用的生成模型」；' +
    `art 卡的 provider、model 是对话模型，缺省为当前对话模型，params 只有 size：${ART_SIZE_PARAM.values?.join('、')}）。` +
    'add_* 与 connect 可带 "ref":"$名字"，同一批中后续的操作与提示词用它代替新节点的 id。' +
    '提示词中用 @[节点 id] 指代素材，引用未连线的素材时自动连线。运行生成卡使用 run_canvas。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径' },
      ops_json: { type: 'string', description: '画布操作数组，JSON' },
    },
    required: ['path', 'ops_json'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '修改画布的节点、提示词、参数与连线',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    try {
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
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}

function generationReceipt(result: Awaited<ReturnType<CanvasPort['run']>>): ToolOutcome {
  if (!result.ok) {
    return {
      status: 'failure',
      executed: true,
      message: result.pending
        ? `${result.message}\n远端任务仍存在，该版本保留在画布上，使用 retrieve_canvas 取回，不会重复计费。`
        : result.message,
    }
  }
  return {
    status: 'success',
    message: `已取得结果：${result.paths.join('、')}${result.warning ? `\n${result.warning}` : ''}`,
    data: { paths: result.paths, ...(result.warning ? { warning: result.warning } : {}) },
    fileChanges: result.paths.map((p) => ({ path: p, changeType: 'created' as const })),
  }
}

function batchReceipt(results: CanvasBatchRunResult): ToolOutcome {
  const successful = results.filter((r) => r.result.ok).length
  const skipped = results.filter((r) => r.skipped).length
  const paths = results.flatMap((r) => (r.result.ok ? r.result.paths : []))
  return {
    status: successful === results.length ? 'success' : 'failure',
    executed: results.some((r) => !r.skipped),
    message:
      `批量运行：${successful} 个成功，${results.length - successful - skipped} 个失败，${skipped} 个未运行。\n` +
      results
        .map(
          ({ node, result, skipped }) =>
            `- ${node}${skipped ? '（未运行）' : ''}：${generationReceipt(result).message}`,
        )
        .join('\n') +
      '\n成功节点已保存结果，不要整批重新运行；只处理失败或未运行的节点。',
    data: { results, paths },
    fileChanges: paths.map((path) => ({ path, changeType: 'created' as const })),
  }
}

export const runCanvasTool: ToolSpec = {
  name: 'run_canvas',
  description:
    '运行画布上 node 指定的生成卡并等待结果；node 可为单个 id 或非空 id 数组。先用 read_canvas 查看节点与 id。' +
    '批量时只运行指定节点（重复 id 只运行一次），最多同时运行 4 个独立节点，批内上游完成后才运行下游。' +
    '上游失败或待取回时跳过下游；未指定的上游只使用已有结果，不自动运行。按节点返回成功、失败与未运行原因，勿整批重新运行。' +
    '每次运行提交新的生成任务，按次计费，不得为试探效果重复调用。' +
    '已有待取回版本使用 retrieve_canvas，不重新运行。修改提示词、参数与连线使用 edit_canvas。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径' },
      node: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        description: '单个生成卡 id，或要批量运行的生成卡 id 数组',
      },
    },
    required: ['path', 'node'],
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '运行画布中的一个或多个生成节点',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    const batch = Array.isArray(args.node)
    const ids = (batch ? args.node : [args.node]) as unknown[]
    if (!ids.length || ids.some((id) => !text(id)))
      return failure('node 必须是生成卡 id 或非空 id 数组', 'invalid_tool_arguments')
    const nodes = [...new Set(ids.map((id) => text(id)!))]
    if (!ctx.media) return failure('本次执行没有生成通道')
    try {
      return batch
        ? batchReceipt(await canvas.runBatch(path, nodes, ctx.media, ctx.signal))
        : generationReceipt(await canvas.run(path, nodes[0]!, ctx.media, ctx.signal))
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}

export const retrieveCanvasTool: ToolSpec = {
  name: 'retrieve_canvas',
  description:
    '取回画布上 node 指定生成卡仍在远端的视频结果，不重新提交、不重复计费。' +
    '先用 read_canvas 查看待取回的节点与版本；version 省略时取当前版或最新的待取回版。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径' },
      node: { type: 'string', description: '待取回结果的生成卡 id' },
      version: { type: 'string', description: '取回的版本；省略时取当前版或最新的待取回版' },
    },
    required: ['path', 'node'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '取回画布视频并更新节点',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    const node = text(args.node)
    if (!node) return failure('缺少 node', 'invalid_tool_arguments')
    if (!ctx.media) return failure('本次执行没有生成通道')
    try {
      return generationReceipt(
        await canvas.retrieve(path, node, text(args.version), ctx.media, ctx.signal),
      )
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}
