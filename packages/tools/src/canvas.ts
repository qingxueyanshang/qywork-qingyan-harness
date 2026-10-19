/**
 * 画布工具：大模型经画布端口（`ctx.canvas`）创建、读取、修改、运行工作区中的 `*.canvas.json`。
 *
 * 读取、编辑、运行与取回分别声明工具及参数；取回只查询已有任务，不重新提交生成。
 *
 * 读写与运行全部由服务端画布服务执行，与界面共用同一个实例：写入次序、运行中状态与失败原文只有一份，
 * 大模型写入的节点在写入时即推送给界面，不等待本次工具调用结束。
 * 运行使用本轮的生成端口（`ctx.media`），费用计入本轮。
 */

import type {
  CanvasEditResult,
  CanvasPort,
  CanvasRender,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import {
  ART_SIZE_PARAM,
  type CanvasBatchRunResult,
  type CanvasNode,
  type CanvasOp,
  type CanvasView,
  canvasFileKind,
  canvasRunLabel,
  cardIdOf,
  displayNameOf,
  parseCanvasOps,
} from '@qywork/core'
import { jsonArg } from './args.ts'
import { shrinkImage } from './image.ts'

function failure(message: string, errorKind?: string): ToolOutcome {
  return { status: 'failure', executed: false, message, ...(errorKind ? { errorKind } : {}) }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function statusOf(view: CanvasView, n: CanvasNode): string {
  const state = view.states[n.id]
  if (state?.state === 'failed') return `失败：${state.message}`
  if (state?.state === 'unknown') return `结果未知：${state.message}`
  if (state?.state === 'pending') return `待取回（版本 ${state.version}）`
  if (state?.state === 'running')
    return canvasRunLabel(n.type === 'generate' ? n.output : 'image', state)
  return ({ normal: '正常', missing: '文件缺失', empty: '未生成' } as const)[
    state?.state ?? 'normal'
  ]
}

/** 每张卡写明输入：连线只列在末尾时，回执中不易发现哪张卡没有连接参考图。 */
function inputsText(view: CanvasView, id: string): string {
  const inputs = view.doc.edges
    .filter((e) => e.to === id)
    .map((e) => {
      const from = view.doc.nodes.find((n) => n.id === e.from)
      return `${from ? displayNameOf(from) : e.from}（${e.role}）`
    })
  return inputs.length ? inputs.join('、') : '无，只按提示词生成'
}

/** 节点的首行：id、类型、名称、组、模型、版本与状态。 */
function headLine(view: CanvasView, n: CanvasNode): string {
  const status = statusOf(view, n)
  const group = n.type !== 'timeline' && n.group ? `（组：${n.group}）` : ''
  if (n.type === 'file')
    return `- ${n.id} 文件「${displayNameOf(n)}」${group}${n.path}（${status}）`
  if (n.type === 'timeline') {
    const total = n.clips.reduce((sum, c) => sum + c.out - c.in, 0)
    return (
      `- ${n.id} 时间线「${n.name}」${n.clips.length} 段，共 ${Math.round(total * 10) / 10} 秒` +
      `${n.muted ? '，静音' : ''}（${status}）`
    )
  }
  const current = n.versions.find((v) => v.id === n.current)
  const model = n.provider && n.model ? `${n.provider} / ${n.model}` : '默认模型'
  return (
    `- ${n.id} ${n.output} 生成卡「${n.name}」${group}${model}，${n.versions.length} 版` +
    `${current ? `，当前 ${current.path}` : ''}（${status}）`
  )
}

/** 节点的全文：生成卡含提示词、参数、已提交的任务与输入，时间线含全部片段。 */
function nodeLines(view: CanvasView, n: CanvasNode): string[] {
  const lines = [headLine(view, n)]
  if (n.type === 'timeline') {
    lines.push(...n.clips.map((c, i) => `  ${i + 1}. ${c.path} ${c.in}–${c.out} 秒`))
    return lines
  }
  if (n.type === 'file') return lines
  lines.push(`  提示词：${n.prompt || '（空）'}`, `  参数：${paramsText(n.params)}`)
  for (const v of n.versions) {
    const task = view.tasks?.[v.id]
    if (!task) continue
    lines.push(
      `  已提交任务（版本 ${v.id}）：${task.taskId ?? '无任务号'}；恢复记录 ${task.record}；取回后结果位置 ${task.output}。取回此版本只查询、下载；再次生成会另发付费请求。`,
    )
  }
  const state = view.states[n.id]
  if (state?.state === 'running' && n.output === 'video') {
    lines.push(
      state.taskId
        ? `  远端任务号：${state.taskId}`
        : state.stage === 'preparing'
          ? '  正在准备素材，尚未提交生成；此时可以取消，不产生生成费用。'
          : '  尚未取得远端任务号，不能确认平台已受理；开始时间与用时仅为本地等待记录。',
    )
  }
  lines.push(`  输入：${inputsText(view, n.id)}`)
  const broken = view.references?.[n.id]
  if (broken?.length) lines.push(`  引用失效（运行前须修正）：${broken.join('；')}`)
  return lines
}

/** 概况中的一行：生成卡写参数、输入与提示词字数，不写提示词正文。 */
function overviewLine(view: CanvasView, n: CanvasNode): string {
  if (n.type !== 'generate') return nodeLines(view, n).join('\n')
  const broken = view.references?.[n.id]
  return (
    `${headLine(view, n)}；参数：${paramsText(n.params)}；输入：${inputsText(view, n.id)}；` +
    `提示词 ${n.prompt.length} 字${broken?.length ? `；引用失效：${broken.join('；')}` : ''}`
  )
}

function edgeLines(view: CanvasView): string[] {
  const name = (id: string) => {
    const n = view.doc.nodes.find((x) => x.id === id)
    return n ? displayNameOf(n) : id
  }
  return view.doc.edges.map((e) => `- 连线 ${e.id}：${name(e.from)} → ${name(e.to)}（${e.role}）`)
}

function countsLine(view: CanvasView): string {
  return `画布 ${view.path}：${view.doc.nodes.length} 个节点，${view.doc.edges.length} 条连线`
}

/**
 * 读取的回执。未指定节点时为概况：每张卡一行，生成卡只写提示词字数，另列全部连线；
 * 指定节点时为这些节点的全文。不要恢复为默认列出全部提示词：二十张卡的回执达数万字，
 * 模型因此改用脚本读写画布文件，跳过画布的全部核对。
 */
function describe(view: CanvasView, ids?: readonly string[]): string {
  if (ids) {
    const lines = [countsLine(view)]
    for (const id of ids) {
      const n = view.doc.nodes.find((x) => x.id === id)
      if (n) lines.push(...nodeLines(view, n))
    }
    return lines.join('\n')
  }
  return [
    countsLine(view),
    ...view.doc.nodes.map((n) => overviewLine(view, n)),
    ...edgeLines(view),
    '生成卡的提示词全文用 read_canvas 的 node 按卡片名称读取。',
  ].join('\n')
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
  'reference（参考图）、first_frame / last_frame（首尾帧，不能与参考素材同时提供）、video（参考视频）、audio（参考音频）、' +
  'text（文本卡）。' +
  '文本卡是放上画布的 .md / .txt：生成卡的提示词写 @[文本卡名称] 引用全文，写 @[文本卡名称#标题] 只引用该标题下的段落，' +
  '运行时展开为文件当前的内容，修改文件即改变所有引用它的卡发送的提示词，不需要把文字复制进各张卡；' +
  '多张卡共用的要求与剧本、制作稿各段都以此引用。文本的连线即引用：写入引用自动连线，删除引用自动断开。' +
  '引用的文件或标题不存在时该卡不能运行，读取画布时标为引用失效。' +
  'output 为 art 的生成卡由对话模型写出一个 HTML 页面（3D 白模、动画、前端设计稿），产物是 generated/ 下的 .html，' +
  '再次运行时在当前页面上修改；它只接受参考图，本身不能作为输入（截图与录制由用户在界面上完成）。' +
  '页面中要显示工作区里的图片时，把图片放上画布并连到 art 卡，页面按相对路径引用，画布显示时载入该图片；' +
  '不要把图片编码进 HTML。' +
  '.html 文件放上画布同样作为 art 页面显示。' +
  '核对设计稿的版面优先用 read_canvas 的 render：按页面声明的尺寸（与画布显示相同）渲染并附上截图；' +
  '浏览器标签页的尺寸与卡片不同，在其中看到的版面不是卡片上的版面。'

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
    '提供 path 时返回概况：每张卡一行（名称、组、模型、版本、状态即正常、文件缺失、未生成、生成中、待取回或失败、参数、输入与提示词字数）与全部连线；' +
    '同时提供 node 时返回这些卡的全文（提示词、参数、输入、已提交的任务）。省略 path 时列出工作区里的画布。' +
    'render 列出设计稿卡（art 生成卡或 .html 文件卡）时，在内置浏览器的隐藏页中按页面声明的尺寸渲染，' +
    '附上截图并列出页面脚本报错；界面不受影响。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径；省略时列出工作区里的画布' },
      // 只用数组一种类型，理由同 run_canvas 的 node。
      node: {
        type: 'array',
        items: { type: 'string' },
        description: '要读取全文的卡片名称数组；省略时返回概况',
      },
      render: {
        type: 'array',
        items: { type: 'string' },
        description: '要渲染截图的设计稿卡名称数组',
      },
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
      const refs = Array.isArray(args.node) ? args.node.map((r) => String(r)) : []
      const ids: string[] = []
      for (const ref of refs) {
        const found = cardIdOf(view.doc, ref)
        if (!found.ok) return failure(found.error, 'invalid_tool_arguments')
        ids.push(found.id)
      }
      const read = describe(view, ids.length ? ids : undefined)
      const wanted = Array.isArray(args.render) ? args.render.map((r) => String(r)) : []
      if (!wanted.length) return { status: 'success', message: read, data: { view } }
      if (!canvas.render) return failure('内置浏览器不可用，无法渲染设计稿')
      const rendered = await rendersOf(await canvas.render(path, wanted))
      return {
        status: 'success',
        message: `${read}\n${rendered.lines.join('\n')}`,
        data: { view, ...(rendered.images.length ? { images: rendered.images } : {}) },
      }
    } catch (err) {
      return { status: 'failure', executed: false, message: (err as Error).message }
    }
  },
}

/**
 * 渲染结果写成回执：每张卡一行（尺寸与截图序号，或无法渲染的原因），页面脚本报错跟在该卡之后。
 * 截图超过模型可接受的边长时缩小（`shrinkImage`），回执中的尺寸仍是页面的显示尺寸。
 */
async function rendersOf(
  items: CanvasRender[],
): Promise<{ lines: string[]; images: { data: string; mime: string }[] }> {
  const lines: string[] = []
  const images: { data: string; mime: string }[] = []
  for (const item of items) {
    if ('failure' in item) {
      lines.push(`「${item.name}」无法渲染：${item.failure}`)
      continue
    }
    const fit = await shrinkImage(new Uint8Array(Buffer.from(item.png, 'base64')), 'image/png')
    images.push({ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime })
    lines.push(`截图 ${images.length}：「${item.name}」按 ${item.size.w}×${item.size.h} 渲染`)
    if (item.errors.length) lines.push(`  页面脚本报错：${item.errors.join('；')}`)
  }
  return { lines, images }
}

/** 一条待发送的操作：`at` 为它在模型所写数组中的序号，`label` 用于回执中的指代。 */
interface PlannedOp {
  at: number
  label: string
  op: CanvasOp
}

/** 回执中指代一条操作：「第 3 条（update「镜头A」）」。 */
function labelOf(at: number, raw: unknown, target?: string): string {
  const op = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const name = target ?? [op.name, op.id, op.path].find((v) => typeof v === 'string')
  const kind = typeof op.op === 'string' ? op.op : '操作'
  return `第 ${at + 1} 条（${kind}${name ? `「${String(name)}」` : ''}）`
}

/**
 * `update` 与 `replace_text` 的 `ids`（卡片名称数组）或 `group`（组名，含其下以 `组名/` 开头的组）
 * 展开为逐卡操作。返回展开后的目标，或无法展开的原因；没有这两个字段时返回 null。
 * `group` 只匹配生成卡：这两种操作修改的是模型、参数与提示词。
 */
async function targetsOf(
  raw: Record<string, unknown>,
  read: () => Promise<CanvasView>,
): Promise<string[] | { error: string } | null> {
  // 新增操作的 group 是卡片所在的组，不是目标；其他操作带 ids 时由操作核对报出未知字段。
  if (raw.op !== 'update' && raw.op !== 'replace_text') return null
  if (!('ids' in raw) && !('group' in raw)) return null
  if ('id' in raw) return { error: 'id 与 ids、group 只能给出其中一个' }
  if ('ids' in raw && 'group' in raw) return { error: 'ids 与 group 只能给出其中一个' }
  if ('ids' in raw) {
    const ids = raw.ids
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string' || !x))
      return { error: 'ids 须为非空的卡片名称数组' }
    return ids as string[]
  }
  const group = raw.group
  if (typeof group !== 'string' || !group) return { error: 'group 须为组名' }
  const doc = (await read()).doc
  const names = doc.nodes
    .filter((n) => n.type === 'generate' && (n.group === group || n.group?.startsWith(`${group}/`)))
    .map((n) => displayNameOf(n))
  return names.length ? names : { error: `组「${group}」中没有生成卡` }
}

/**
 * 修改回执：执行与跳过的条目、新建的批内名称、每条 replace_text 替换的处数、改动的卡的全文与删除的卡。
 * 未改动的卡不写入：每次回执都列出整张画布时，二十张卡的回执达数万字，模型因此改用脚本读写画布文件。
 */
function editReceipt(
  planned: readonly PlannedOp[],
  rejected: readonly { label: string; error: string }[],
  result: CanvasEditResult | null,
  view: CanvasView | null,
): string {
  const skipped = [
    ...rejected,
    ...(result?.skipped ?? []).map((s) => ({ label: planned[s.at]!.label, error: s.error })),
  ]
  const total = planned.length + rejected.length
  const done = total - skipped.length
  const lines = [
    `本批 ${total} 项操作，执行 ${done} 项${skipped.length ? `，跳过 ${skipped.length} 项` : ''}。`,
  ]
  if (skipped.length)
    lines.push('跳过的操作（其余照常执行）：', ...skipped.map((s) => `- ${s.label}：${s.error}`))
  if (result) {
    const named = Object.entries(result.refs).map(([ref, id]) => `${ref} = ${id}`)
    if (named.length) lines.push(`新建：${named.join('、')}`)
    if (result.replaced.length)
      lines.push(
        `替换：${result.replaced.map((r) => `${planned[r.at]!.label} ${r.count} 处`).join('、')}`,
      )
  }
  if (view && result) {
    if (result.changed.length) {
      lines.push('改动的卡：')
      for (const id of result.changed) {
        const n = view.doc.nodes.find((x) => x.id === id)
        if (n) lines.push(...nodeLines(view, n))
      }
    }
    if (result.removed.length)
      lines.push(`删除：${result.removed.map((n) => `「${n}」`).join('、')}`)
    lines.push(`${countsLine(view)}；未改动的卡用 read_canvas 的 node 按名称读取全文。`)
  }
  return lines.join('\n')
}

/**
 * 新增操作中由模型给出的位置与尺寸。界面与服务端使用同一套操作，复制、粘贴与取帧需要坐标或相邻节点，
 * 因此只在本工具拒绝。
 *
 * 不要放开：模型给出的坐标与相邻节点使排列取决于模型的习惯，同一模型会把 169 高的卡片按 350 或 950 的
 * 步长排列；相邻节点还要求每张卡引用另一张卡，引用写错时整批被拒。画布按 group 排位时与模型无关。
 */
function placedOf(op: CanvasOp): string | null {
  if (op.op !== 'add_file' && op.op !== 'add_generate' && op.op !== 'add_timeline') return null
  const field = (['x', 'y', 'w', 'h', 'near', 'beside'] as const).find((k) => k in op)
  return field ? `${field} 不可用：新卡片的位置由画布按 group 排列` : null
}

/**
 * 逐条核对模型所写的操作并展开 `ids` / `group`。不成立的条目进入 `rejected`，其余按原顺序进入 `planned`；
 * 一条展开为多张卡时，每张卡各占一项，各自成立与否互不影响。
 */
async function planOps(
  raws: readonly unknown[],
  read: () => Promise<CanvasView>,
): Promise<{ planned: PlannedOp[]; rejected: { label: string; error: string }[] }> {
  const planned: PlannedOp[] = []
  const rejected: { label: string; error: string }[] = []
  for (const [at, raw] of raws.entries()) {
    const record =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null
    const targets = record ? await targetsOf(record, read) : null
    if (targets && 'error' in targets) {
      rejected.push({ label: labelOf(at, raw), error: targets.error })
      continue
    }
    const expanded = targets
      ? targets.map((id) => {
          const { ids: _ids, group: _group, ...rest } = record!
          return { raw: { ...rest, id }, label: labelOf(at, raw, id) }
        })
      : [{ raw, label: labelOf(at, raw) }]
    for (const item of expanded) {
      const parsed = parseCanvasOps([item.raw])
      const op = parsed.ok ? parsed.ops[0]! : null
      const error = parsed.ok ? placedOf(op!) : parsed.error.replace(/^第 1 条操作 ?/, '')
      if (error || !op) rejected.push({ label: item.label, error: error ?? '无法识别' })
      else planned.push({ at, label: item.label, op })
    }
  }
  return { planned, rejected }
}

export const editCanvasTool: ToolSpec = {
  name: 'edit_canvas',
  description:
    '修改画布的节点、提示词、参数与连线，不发起生成。' +
    CANVAS_NOTE +
    '先用 read_canvas 查看画布；画布尚不存在时先用 create_canvas 创建。' +
    'ops_json 是一批操作的 JSON 数组，逐条生效：某条不成立时跳过并在回执中写明原因，其余照常执行；' +
    '引用了被跳过操作的批内名称的操作同样跳过。回执只列出本批执行与跳过的操作、改动的卡的全文与删除的卡。操作：' +
    '{"op":"add_file","path":"工作区路径","name":"卡片名称","group":"组"}、' +
    '{"op":"add_generate","output":"image|video|audio|art","name":"卡片名称","group":"组","prompt":"…","params":{…}}、' +
    '{"op":"update","id":"卡片名称",…要改的字段}（prompt 整体替换提示词）、' +
    '{"op":"edit_prompt","id":"生成卡名称","old":"提示词中的一段原文","new":"替换后的文字"}（只改提示词中的一段：old 照抄 read_canvas 读取的原文，必须恰好出现一次；new 为空时删除该段）、' +
    '{"op":"edit_prompt","id":"生成卡名称","from":"前标记","to":"后标记","new":"…"}（替换两个标记之间的文字，标记保留，各须恰好出现一次；省略 to 时替换到末尾）、' +
    '{"op":"replace_text","id":"生成卡名称","old":"原文","new":"新文字"}（把提示词中出现的原文全部替换）、' +
    'update 与 replace_text 可用 "ids":["卡片名称",…] 或 "group":"组名"（含其下的「组名/对象」）代替 id，对每张生成卡各执行一次，逐卡报告、互不影响、' +
    '{"op":"connect","from":"素材卡片名称","to":"生成卡名称","role":"…"}（新连线排在该卡输入的末尾）、' +
    '{"op":"order_inputs","id":"生成卡名称","inputs":["素材卡片名称",…]}（按新顺序列出该卡的全部输入，含同批 connect 新连的素材）、' +
    '{"op":"remove","id":"卡片名称或连线 id"}（删除某一版时另加 "version"）、{"op":"set_mode","id":"视频卡名称","mode":"reference|first_last"}、' +
    '{"op":"add_timeline","name":"…","clips":[…]}（修改片段时用 update 的 clips 整组替换，muted 切换整条静音）。' +
    '引用卡片时写卡片名称（读取回执中的 id 同样可用）；同一张画布中卡片名称不能重复，同一文件只放一张卡。' +
    'add_file 放置生成用到的素材与成品（图片、视频、音频、.html）；剧本、制作稿、报告等文本文件在用户要求时放上画布。' +
    '新卡片的位置由画布排列，不写坐标：group 写「类别/对象」，斜杠前的类别决定卡片所在的列，同一对象的各张卡片在列中相连。' +
    '斜杠前只写类别，不写轮次、版本或项目名：之后的轮次新增的人物仍写「角色/人物名」，轮次写在卡片名称中。' +
    '人物、场景、道具按类别各占一列，如「角色/沈砚」「角色/顾衡」「场景/山门」「道具/玉佩」；同一对象的各套服装、各个角度写同一个组名。' +
    '其他卡片同样按类别写，如「预演/献丹」「文本/剧本」。' +
    '分镜或镜头按发生的场景各占一列，group 写「场景名·分镜」或「场景名·镜头」，如「山门·分镜」。' +
    '同一列的卡按创建顺序自上而下，后补的卡接在同一对象或同一列的末尾；新的列按创建顺序排在画布最右侧，时间线单独占一列。' +
    '因此先建人物、场景等素材再建分镜，同一列的卡按剧情顺序创建。' +
    'add_generate 可选 provider、model、params：取值见本轮「可用的生成模型」，参数名与取值按所用模型与卡片的输入核对，不合法或在当前输入下不可用时该条不执行并说明原因；' +
    'update 的 params 整体替换卡片参数，未写出的参数恢复缺省；read_canvas 列出的参数即实际发送的参数，与参数面板一致。' +
    '宽高比或尺寸参数同时决定卡片形状；未给出时卡片为方形，出图后按结果的比例改变形状，相邻的卡随之移开。' +
    `art 卡的 provider、model 是对话模型，缺省为当前对话模型，params 只有 size：${ART_SIZE_PARAM.values?.join('、')}。` +
    '提示词中用 @[卡片名称] 指代素材，引用未连线的素材时自动连线。' +
    '输入顺序即发送给模型的素材顺序；所用模型有素材编号写法时，提示词中的 @ 引用按输入顺序编号，与在提示词中出现的先后无关。' +
    '运行生成卡使用 run_canvas。',
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
      const raw = jsonArg(args.ops_json, 'array', 'ops_json')
      if (!raw.ok) return failure(raw.error, 'invalid_tool_arguments')
      const raws = raw.value as unknown[] | undefined
      if (!raws?.length) return failure('ops_json 须为非空数组', 'invalid_tool_arguments')
      const { planned, rejected } = await planOps(raws, () => canvas.read(path))
      if (!planned.length) {
        return failure(editReceipt(planned, rejected, null, null), 'invalid_tool_arguments')
      }
      const result = await canvas.edit(
        path,
        planned.map((p) => p.op),
      )
      const done = planned.length - result.skipped.length
      const message = editReceipt(planned, rejected, result, result.view)
      return done > 0
        ? { status: 'success', message, data: { refs: result.refs } }
        : { status: 'failure', executed: false, message, errorKind: 'invalid_tool_arguments' }
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
        ? `${result.message}\n已保留恢复记录，使用 retrieve_canvas 取回原结果，不会重新提交生成。`
        : result.message,
      ...(result.diagnostic
        ? { data: { diagnostic: result.diagnostic }, errorKind: `media_${result.diagnostic.kind}` }
        : {}),
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
