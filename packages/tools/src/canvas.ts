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
  type CanvasOp,
  type CanvasView,
  canvasFileKind,
  cardIdOf,
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
    const group = n.type !== 'timeline' && n.group ? `（组：${n.group}）` : ''
    if (n.type === 'file') {
      lines.push(`- ${n.id} 文件「${displayNameOf(n)}」${group}${n.path}（${status}）`)
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
      `- ${n.id} ${n.output} 生成卡「${n.name}」${group}${model}，${n.versions.length} 版` +
        `${current ? `，当前 ${current.path}` : ''}（${status}）`,
      `  提示词：${n.prompt || '（空）'}`,
    )
    lines.push(`  参数：${paramsText(n.params)}`)
    // 每张卡写明输入：连线只列在末尾时，回执中不易发现哪张卡没有连接参考图。
    const inputs = view.doc.edges
      .filter((e) => e.to === n.id)
      .map((e) => {
        const from = byId.get(e.from)
        return `${from ? displayNameOf(from) : e.from}（${e.role}）`
      })
    lines.push(`  输入：${inputs.length ? inputs.join('、') : '无，只按提示词生成'}`)
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

/**
 * 参数的文本形式。为空时写明按缺省值生成：不写这一行时，丢失参数的卡片在回执中与设置了参数的卡片无从区分。
 */
function paramsText(params: Record<string, unknown>): string {
  return Object.keys(params).length ? JSON.stringify(params) : '未设置，按模型缺省值生成'
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

/**
 * 新增操作中由模型给出的位置与尺寸。界面与服务端使用同一套操作，复制、粘贴与取帧需要坐标或相邻节点，
 * 因此只在本工具拒绝。
 *
 * 不要放开：模型给出的坐标与相邻节点使排列取决于模型的习惯，同一模型会把 169 高的卡片按 350 或 950 的
 * 步长排列；相邻节点还要求每张卡引用另一张卡，引用写错时整批被拒。画布按 group 排位时与模型无关。
 */
function placedOf(ops: readonly CanvasOp[]): string | null {
  for (const [i, op] of ops.entries()) {
    if (op.op !== 'add_file' && op.op !== 'add_generate' && op.op !== 'add_timeline') continue
    const field = (['x', 'y', 'w', 'h', 'near', 'beside'] as const).find((k) => k in op)
    if (field) return `第 ${i + 1} 条操作的 ${field} 不可用：新卡片的位置由画布按 group 排列`
  }
  return null
}

export const editCanvasTool: ToolSpec = {
  name: 'edit_canvas',
  description:
    '修改画布的节点、提示词、参数与连线，不发起生成。' +
    CANVAS_NOTE +
    '先用 read_canvas 查看画布；画布尚不存在时先用 create_canvas 创建。' +
    'ops_json 是一批操作的 JSON 数组，整批生效或整批不生效。操作：' +
    '{"op":"add_file","path":"工作区路径","name":"卡片名称","group":"组"}、' +
    '{"op":"add_generate","output":"image|video|audio|art","name":"卡片名称","group":"组","prompt":"…","params":{…}}、' +
    '{"op":"update","id":"卡片名称",…要改的字段}、{"op":"connect","from":"素材卡片名称","to":"生成卡名称","role":"…"}、' +
    '{"op":"remove","id":"卡片名称或连线 id"}（删除某一版时另加 "version"）、{"op":"set_mode","id":"视频卡名称","mode":"reference|first_last"}、' +
    '{"op":"add_timeline","name":"…","clips":[…]}（修改片段时用 update 的 clips 整组替换，muted 切换整条静音）。' +
    '引用卡片时写卡片名称（读取回执中的 id 同样可用）；同一张画布中卡片名称不能重复。' +
    '新卡片的位置由画布排列，不写坐标：group 写卡片所属的对象，组名相同的卡排在同一列。' +
    '同一人物的各套服装或表情写该人物名，同一场景的各个角度写该场景名；分镜或镜头按发生的场景分组，组名写「场景名·分镜」或「场景名·镜头」（如「客厅·分镜」），同一场景的全部分镜为一组。' +
    '同组的卡按创建顺序纵向排成一列；不同组横向排列，没有输入的组（素材）在左，连接了素材的组（分镜、镜头）在素材右侧；时间线在其下方。' +
    '因此同组的卡按剧情顺序创建。' +
    'add_generate 可选 provider、model、params：取值见本轮「可用的生成模型」，参数名与取值按所用模型核对，不合法时整批拒绝并列出可选值；' +
    '宽高比或尺寸参数同时决定卡片形状；未给出时卡片为方形，并为横竖两种结果预留位置，排列较松。' +
    `art 卡的 provider、model 是对话模型，缺省为当前对话模型，params 只有 size：${ART_SIZE_PARAM.values?.join('、')}。` +
    '提示词中用 @[卡片名称] 指代素材，引用未连线的素材时自动连线。运行生成卡使用 run_canvas。',
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
      const placed = placedOf(parsed.ops)
      if (placed) return failure(placed, 'invalid_tool_arguments')
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

/**
 * 产物中有图片或视频时附在回执末尾的核对步骤，批量运行只附一次。
 * 不要只写在工具说明中：只依据回执的模型按宽高一致即判定符合要求，不查看画面。
 */
function viewStep(paths: string[]): string {
  return paths.some((p) => canvasFileKind(p) === 'image' || canvasFileKind(p) === 'video')
    ? '\n核对画面：用 read_file 查看上述图片与视频是否符合提示词。'
    : ''
}

/**
 * 一次运行的回执：每个产物的路径与从文件头读取的宽高、时长，以及实际发送的参数。
 * 不要只回传路径：模型据此核对结果是否符合要求，没有实测值时只能按自己设定的参数复述结果。
 */
function generationReceipt(
  result: Awaited<ReturnType<CanvasPort['run']>>,
  step = true,
): ToolOutcome {
  if (!result.ok) {
    return {
      status: 'failure',
      executed: true,
      message: result.pending
        ? `${result.message}\n远端任务仍存在，该版本保留在画布上，使用 retrieve_canvas 取回，不会重复计费。`
        : result.message,
    }
  }
  const outputs = result.outputs.map((o) => {
    const measured = [
      o.size ? `${o.size.w}×${o.size.h}` : null,
      o.duration === undefined ? null : `${Math.round(o.duration * 100) / 100} 秒`,
    ].filter((x) => x !== null)
    return `  ${o.path}${measured.length ? `（${measured.join('，')}）` : ''}`
  })
  const paths = result.outputs.map((o) => o.path)
  return {
    status: 'success',
    message:
      `已取得结果：\n${outputs.join('\n')}\n  发送的参数：${paramsText(result.params)}` +
      `${result.warning ? `\n${result.warning}` : ''}${step ? viewStep(paths) : ''}`,
    data: { outputs: result.outputs, params: result.params },
    fileChanges: paths.map((p) => ({ path: p, changeType: 'created' as const })),
  }
}

/** 卡片名称或 id 按画布当前内容换成 id；有一项无法确定时返回原因。 */
async function idsOf(canvas: CanvasPort, path: string, refs: string[]): Promise<string[] | string> {
  const { doc } = await canvas.read(path)
  const ids: string[] = []
  for (const ref of refs) {
    const found = cardIdOf(doc, ref)
    if (!found.ok) return found.error
    ids.push(found.id)
  }
  return ids
}

function batchReceipt(results: CanvasBatchRunResult): ToolOutcome {
  const successful = results.filter((r) => r.result.ok).length
  const skipped = results.filter((r) => r.skipped).length
  const paths = results.flatMap((r) => (r.result.ok ? r.result.outputs.map((o) => o.path) : []))
  return {
    status: successful === results.length ? 'success' : 'failure',
    executed: results.some((r) => !r.skipped),
    message:
      `批量运行：${successful} 个成功，${results.length - successful - skipped} 个失败，${skipped} 个未运行。\n` +
      results
        .map(
          ({ node, result, skipped }) =>
            `- ${node}${skipped ? '（未运行）' : ''}：${generationReceipt(result, false).message}`,
        )
        .join('\n') +
      '\n成功节点已保存结果，不要整批重新运行；只处理失败或未运行的节点。' +
      viewStep(paths),
    data: { results, paths },
    fileChanges: paths.map((path) => ({ path, changeType: 'created' as const })),
  }
}

export const runCanvasTool: ToolSpec = {
  name: 'run_canvas',
  description:
    '运行画布上 node 指定的生成卡并等待结果；node 是生成卡名称的数组，单张卡写成一个元素的数组。' +
    '批量时只运行指定的卡（重复的只运行一次），最多同时运行 4 个独立节点，批内上游完成后才运行下游。' +
    '上游失败或待取回时跳过下游；未指定的上游只使用已有结果，不自动运行。按节点返回成功、失败与未运行原因，勿整批重新运行。' +
    '回执列出每个产物的宽高、时长与实际发送的参数。运行后核对结果：先核对回执中的宽高、时长与参数是否符合要求，' +
    '再用 read_file 查看图片与视频的画面是否符合提示词；不符合时用 edit_canvas 修改提示词或参数，再运行该节点。' +
    '同一节点重新运行一次后仍不符合时停止重试，在回复中说明差异，由用户决定。回复中的分辨率、时长与参数以回执为准。' +
    '每次运行提交新的生成任务，按次计费，结果符合要求时不重复运行。' +
    '已有待取回版本使用 retrieve_canvas，不重新运行。修改提示词、参数与连线使用 edit_canvas。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径' },
      // 只用数组一种类型：写成「字符串或数组」时，Claude 把数组编码为 JSON 字符串传入，整个字符串被当作一个 id。
      node: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: '要运行的生成卡名称数组；单张卡写成一个元素的数组',
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
    const refs = args.node
    if (!Array.isArray(refs) || !refs.length || refs.some((ref) => !text(ref)))
      return failure(
        'node 必须是生成卡名称的数组（不是 JSON 字符串），单张卡写成一个元素的数组',
        'invalid_tool_arguments',
      )
    if (!ctx.media) return failure('本次执行没有生成通道')
    try {
      const ids = await idsOf(
        canvas,
        path,
        refs.map((ref) => text(ref)!),
      )
      if (typeof ids === 'string') return failure(ids, 'invalid_tool_arguments')
      const nodes = [...new Set(ids)]
      return nodes.length > 1
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
      node: { type: 'string', description: '待取回结果的生成卡名称' },
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
    const ref = text(args.node)
    if (!ref) return failure('缺少 node', 'invalid_tool_arguments')
    if (!ctx.media) return failure('本次执行没有生成通道')
    try {
      const ids = await idsOf(canvas, path, [ref])
      if (typeof ids === 'string') return failure(ids, 'invalid_tool_arguments')
      return generationReceipt(
        await canvas.retrieve(path, ids[0]!, text(args.version), ctx.media, ctx.signal),
      )
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}
