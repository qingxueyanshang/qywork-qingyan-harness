/**
 * 画布工具：大模型经画布端口（`ctx.canvas`）创建、读取、修改、运行工作区中的 `*.canvas.json`。
 *
 * 读取、编辑、运行、取回与取帧分别声明工具及参数；取回只查询已有任务，不重新提交生成；
 * 取帧经 Office 执行程序解码视频，落盘与界面取帧相同。
 *
 * 读写与运行全部由服务端画布服务执行，与界面共用同一个实例：写入次序、运行中状态与失败原文只有一份，
 * 大模型写入的节点在写入时即推送给界面，不等待本次工具调用结束。
 * 运行使用本轮的生成端口（`ctx.media`），费用计入本轮。
 */

import { readFile } from 'node:fs/promises'
import {
  type CanvasEditResult,
  type CanvasPort,
  type CanvasRender,
  chargeImage,
  type ToolOutcome,
  type ToolSpec,
} from '@qywork/agent'
import {
  ART_SIZE_PARAM,
  CARD_GAP,
  type CanvasBatchRunResult,
  type CanvasNode,
  type CanvasOp,
  type CanvasRunResult,
  type CanvasView,
  canvasFileKind,
  canvasMediaOf,
  canvasRunLabel,
  cardIdOf,
  displayNameOf,
  frameLabel,
  imageSizeOf,
  layoutOf,
  parseCanvasOps,
} from '@qywork/core'
import { jsonArg } from './args.ts'
import { shrinkImage } from './image.ts'
import { grabVideoFrame } from './office-worker.ts'
import { resolveInWorkspace, rootsOf } from './paths.ts'

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
  if (n.type === 'file') {
    const excerpt = n.excerpt ? `，摘录 ${JSON.stringify(n.excerpt)}` : ''
    return `- ${n.id} 文件「${displayNameOf(n)}」${group}${n.path}${excerpt}（${status}）`
  }
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
  if (n.type === 'file') {
    const broken = view.references?.[n.id]
    if (broken?.length) lines.push(`  引用失效（运行前须修正）：${broken.join('；')}`)
    return lines
  }
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
  if (broken?.length) lines.push(`  运行前须修正：${broken.join('；')}`)
  return lines
}

/** 概况中的一行：生成卡写参数、输入与提示词字数，不写提示词正文。 */
function overviewLine(view: CanvasView, n: CanvasNode): string {
  if (n.type !== 'generate') return nodeLines(view, n).join('\n')
  const broken = view.references?.[n.id]
  return (
    `${headLine(view, n)}；参数：${paramsText(n.params)}；输入：${inputsText(view, n.id)}；` +
    `提示词 ${n.prompt.length} 字${broken?.length ? `；运行前须修正：${broken.join('；')}` : ''}`
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

/** 重叠卡片最多列出的对数；其余只写总数。 */
const MAX_OVERLAPS = 10

/**
 * 按列的布局：每列一行，写明横坐标范围、各栏的横坐标、卡片数与左侧一列的间距，另列没有组的节点与重叠的卡。
 * 不要省略：回执没有坐标时模型无法核对布局，只能声称核对过。行数随列数增长，不随卡片数增长。
 */
function layoutLines(view: CanvasView): string[] {
  const { columns, overlaps, loose } = layoutOf(view.doc)
  if (!columns.length && !loose.length) return []
  const lines = ['布局（按列从左到右）：']
  for (const [i, c] of columns.entries()) {
    const gap =
      c.gap === undefined
        ? ''
        : `；与左侧「${columns[i - 1]!.column}」相距 ${c.gap}${c.gap === CARD_GAP ? '' : `，应为 ${CARD_GAP}`}`
    lines.push(
      `- 列「${c.column}」：x ${c.left}–${c.right}，${c.lanes.length} 栏（x=${c.lanes.join('、')}），${c.cards} 张卡${gap}`,
    )
  }
  for (const n of loose) lines.push(`- 没有组：「${displayNameOf(n)}」位于 x ${n.x}、y ${n.y}`)
  if (overlaps.length) {
    const shown = overlaps
      .slice(0, MAX_OVERLAPS)
      .map(([a, b]) => `「${displayNameOf(a)}」与「${displayNameOf(b)}」`)
    lines.push(
      `- 重叠 ${overlaps.length} 处：${shown.join('、')}${overlaps.length > MAX_OVERLAPS ? ' 等' : ''}`,
    )
  }
  return lines
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
    ...layoutLines(view),
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
  '（clips 按顺序首尾相接，每段 {"path":"视频路径","in":起始秒,"out":结束秒}，只引用、不修改源文件；导出成片用 export_timeline）。连线将素材连接到生成卡，用途 role 为 ' +
  'reference（参考图）、first_frame / last_frame（首尾帧，不能与参考素材同时提供）、video（参考视频）、audio（参考音频）、' +
  'text（文本卡）。' +
  '文本卡是放上画布的 .md / .txt：生成卡的提示词写 @[文本卡名称]，运行时展开为文件当前的内容，' +
  '修改文件即改变所有引用它的卡发送的提示词。' +
  'add_file 给出 excerpt 时该卡是摘录卡，只引用文件中的一段：' +
  '{"after":"该段之前全文唯一的一段文字，如所在的标题行","start":"该段开头的文字","end":"该段结尾的文字"}，' +
  '发送从 after 之后第一次出现的 start 起、到其后第一次出现的 end 止的文字（均含）；不给 after 时 start 须全文唯一。' +
  'start 与 end 逐字照抄原文，只取要发送的文字本身，不含标题行与代码块的围栏行；文档不需要为此改写。' +
  '生成卡的提示词取自工作区中的文档时（剧本、要求、制作稿中的镜头提示词），优先为该段建摘录卡并引用，而不是复制文字：复制的文字不随文档的修改而更新。' +
  '每段一张摘录卡，name 写该段的用途（如「1-1 视频提示词」），group 与引用它的生成卡相同：画布把摘录卡排在该生成卡左侧的同一行。' +
  '文本的连线即引用：写入引用自动连线，删除引用自动断开；用 connect 连接文本卡而提示词中尚未引用它时，在提示词末尾插入该卡的引用，发送时展开为该段全文。' +
  '文件不存在或摘录无法定位（after、start、end 被改动或不再唯一）时引用它的卡不能运行，读取画布时标为引用失效；' +
  '提示词（含展开的文本卡）中手写的素材编号与连线数量、或与所选模型的写法不一致时同样不能运行，读取画布与修改回执中标为运行前须修正，' +
  '换模型后按新模型的写法改写（文本卡改其文件）；' +
  '修改文档后按回执中的原因用 update 给出新的 excerpt。' +
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
    '提供 path 时返回概况：每张卡一行（名称、组、模型、版本、状态即正常、文件缺失、未生成、生成中、待取回或失败、参数、输入与提示词字数）、全部连线与按列的布局' +
    '（各列的横坐标范围、各栏的横坐标、与左侧一列的间距、重叠的卡；edit_canvas 的回执同样附上）；' +
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
 * 展开为逐卡操作。返回展开后的目标与用作目标的字段，或无法展开的原因；没有目标字段时返回 null。
 * `group` 只匹配生成卡：这两种操作修改的是模型、参数与提示词。
 * `update` 给出 `id` 或 `ids` 时 `group` 是卡片的新组，不是目标。
 */
async function targetsOf(
  raw: Record<string, unknown>,
  read: () => Promise<CanvasView>,
): Promise<{ names: string[]; key: 'ids' | 'group' } | { error: string } | null> {
  // 新增操作的 group 是卡片所在的组，不是目标；其他操作带 ids 时由操作核对报出未知字段。
  if (raw.op !== 'update' && raw.op !== 'replace_text') return null
  const byGroup = 'group' in raw && !(raw.op === 'update' && ('id' in raw || 'ids' in raw))
  if (!('ids' in raw) && !byGroup) return null
  if ('id' in raw) return { error: 'id 与 ids、group 只能给出其中一个' }
  if ('ids' in raw && byGroup) return { error: 'ids 与 group 只能给出其中一个' }
  if ('ids' in raw) {
    const ids = raw.ids
    if (!Array.isArray(ids) || !ids.length || ids.some((x) => typeof x !== 'string' || !x))
      return { error: 'ids 须为非空的卡片名称数组' }
    return { names: ids as string[], key: 'ids' }
  }
  const group = raw.group
  if (typeof group !== 'string' || !group) return { error: 'group 须为组名' }
  const doc = (await read()).doc
  const names = doc.nodes
    .filter((n) => n.type === 'generate' && (n.group === group || n.group?.startsWith(`${group}/`)))
    .map((n) => displayNameOf(n))
  return names.length ? { names, key: 'group' } : { error: `组「${group}」中没有生成卡` }
}

/**
 * 修改回执：执行与跳过的条目、新建的批内名称、每条 replace_text 替换的处数、改动的卡的全文、移动的卡与删除的卡。
 * 未改动的卡不写入，只改变了位置或尺寸的卡只写名称：每次回执都列出整张画布时，二十张卡的回执达数万字，
 * 模型因此改用脚本读写画布文件。
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
    const moved = result.moved.flatMap((id) => {
      const n = view.doc.nodes.find((x) => x.id === id)
      return n ? [`「${displayNameOf(n)}」`] : []
    })
    if (moved.length) lines.push(`位置或尺寸改变：${moved.join('、')}`)
    if (result.removed.length)
      lines.push(`删除：${result.removed.map((n) => `「${n}」`).join('、')}`)
    lines.push(...layoutLines(view))
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
      ? targets.names.map((id) => {
          const { [targets.key]: _target, ...rest } = record!
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
    '操作已由脚本写成 .json 文件时，用 ops_path 给出该文件的工作区路径，不要把文件内容抄进 ops_json；二者只给一个。' +
    'ops_json 是一批操作的 JSON 数组，逐条生效：某条不成立时跳过并在回执中写明原因，其余照常执行；' +
    '引用了被跳过操作的批内名称的操作同样跳过。回执只列出本批执行与跳过的操作、改动的卡的全文、位置或尺寸改变的卡的名称与删除的卡。操作：' +
    '{"op":"add_file","path":"工作区路径","name":"卡片名称","group":"组"}（摘录卡另加 "excerpt"）、' +
    '{"op":"add_generate","output":"image|video|audio|art","name":"卡片名称","group":"组","prompt":"…","params":{…}}、' +
    '{"op":"update","id":"卡片名称",…要改的字段}（可改 name、group、prompt、provider、model、params、current、path、excerpt、clips、muted 与位置尺寸 x、y、w、h；' +
    'prompt 整体替换提示词；excerpt 改摘录，为 null 时改为整篇；group 改变时卡片移到新组所在列的末尾，同时给出 x、y 时以其为准）、' +
    '{"op":"edit_prompt","id":"生成卡名称","old":"提示词中的一段原文","new":"替换后的文字"}（只改提示词中的一段：old 照抄 read_canvas 读取的原文，必须恰好出现一次；new 为空时删除该段）、' +
    '{"op":"edit_prompt","id":"生成卡名称","from":"前标记","to":"后标记","new":"…"}（替换两个标记之间的文字，标记保留，各须恰好出现一次；省略 to 时替换到末尾）、' +
    '{"op":"replace_text","id":"生成卡名称","old":"原文","new":"新文字"}（把提示词中出现的原文全部替换）、' +
    'update 与 replace_text 可用 "ids":["卡片名称",…] 或 "group":"组名"（含其下的「组名/对象」）代替 id，对每张生成卡各执行一次，逐卡报告、互不影响' +
    '（update 给出 id 或 ids 时，group 是要改成的组，不是目标）、' +
    '{"op":"connect","from":"素材卡片名称","to":"生成卡名称","role":"…"}（新连线排在该卡输入的末尾）、' +
    '{"op":"order_inputs","id":"生成卡名称","inputs":["素材卡片名称",…]}（按新顺序列出该卡的全部输入，含同批 connect 新连的素材）、' +
    '{"op":"remove","id":"卡片名称或连线 id"}（删除某一版时另加 "version"；删除卡片后同一列中其下方的卡上移，不留空位）、{"op":"set_mode","id":"视频卡名称","mode":"reference|first_last"}、' +
    '{"op":"arrange","group":"组名"} 或 {"op":"arrange","ids":["卡片名称",…]}（按卡片名称排成网格，名称中的数字按数值排序，P2 在 P10 之前；' +
    '"perRow" 为每行张数，缺省 4，按 group 排列时组内的摘录卡一并排列并计入张数；网格从这些卡原来所占区域的左上角开始，右侧与下方的卡随之让开；在本批其他操作之后执行，同一批新增的卡同样参与；只用于逐页排列，不用于人物、场景、道具、镜头等按列排列的卡）、' +
    '{"op":"arrange","group":"镜头","perColumn":7}（把该组所在的列按行重排：摘录卡排在左侧、生成卡排在右侧，按对象名的数字顺序每栏 perColumn 行，满了在右侧另起一栏；' +
    '视频列之后补卡沿用这一行数；用户要求视频每列几行时使用）。两种 arrange 之后，排列区域及其右侧各列向左靠拢，与左侧相隔一个间距、' +
    '{"op":"add_timeline","name":"…","clips":[…]}（修改片段时用 update 的 clips 整组替换，muted 切换整条静音）。' +
    '引用卡片时写卡片名称（读取回执中的 id 同样可用）；同一张画布中卡片名称不能重复，同一文件只放一张整篇的卡，同一段只放一张摘录卡；' +
    '同一批中先删除的卡让出其名称与文件，之后的操作可以使用。' +
    'add_file 放置生成用到的素材与成品（图片、视频、音频、.html）；剧本、制作稿、报告等文本文件整篇放上画布只在用户要求时进行，' +
    '生成卡要用其中的段落时放摘录卡。' +
    '新卡片的位置由画布排列，新增时不写坐标：group 写「类别/对象」，斜杠前的类别决定卡片所在的列，同一对象的各张卡片在列中相连。' +
    '斜杠前只写类别，不写轮次、版本或项目名：之后的轮次新增的人物仍写「角色/人物名」，轮次写在卡片名称中。' +
    '人物、场景、道具按类别各占一列，如「角色/沈砚」「角色/顾衡」「场景/山门」「道具/玉佩」；同一对象的各套服装、各个角度写同一个组名。' +
    '其他卡片同样按类别写，如「预演/献丹」「文本/剧本」。' +
    '视频镜头不按场景分列：全部视频卡写「镜头/镜号」，如「镜头/1-1」「镜头/2-3」，场景写在卡片名称或提示词中。' +
    '视频列按镜号的数字顺序排行（1-2 在 1-10 之前，后补的镜头插回镜号的位置），满一栏后在右侧另起一栏：' +
    '镜头不超过 24 个时每栏 6 行，不超过 35 个时 7 行，更多时 8 行。分镜图（图片）写「分镜/镜号」，与人物、场景等图片列一样不换栏。' +
    '图片等其他列的卡按创建顺序自上而下，后补的卡接在同一对象或同一列的末尾；新的列按创建顺序排在画布最右侧，时间线单独占一列。' +
    '因此先建人物、场景等素材再建镜头。' +
    '要按顺序成行排列（如逐页的幻灯片）时用 perRow 的 arrange；移动单张已有的卡用 update 的 x、y。' +
    '整理已有画布的布局时每一列写一条 perColumn 的 arrange：视频列为每栏行数，其他列不小于该列的行数，不换栏；' +
    '整理之后各行按对象名的数字顺序排列。不要用脚本计算并改写坐标。' +
    'add_generate 可选 provider、model、params：取值见本轮「可用的生成模型」，只写 model 时按提供该模型的接口补上 provider，有多个接口提供时须写明 provider；' +
    '参数名与取值按所用模型与卡片的输入核对，不合法或在当前输入下不可用时该条不执行并说明原因；' +
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
      ops_json: { type: 'string', description: '画布操作数组，JSON；与 ops_path 二选一' },
      ops_path: {
        type: 'string',
        description:
          '写有画布操作数组的 JSON 文件的工作区路径，如脚本生成的 canvas-ops.json；与 ops_json 二选一',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '修改画布的节点、提示词、参数与连线',
  targetExtractor: (a) => text(a.path) ?? null,
  requireOneOf: [['ops_json', 'ops_path']],
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    const opsPath = text(args.ops_path)
    if (opsPath && text(args.ops_json)) {
      return failure('ops_json 与 ops_path 只给一个', 'invalid_tool_arguments')
    }
    try {
      // 脚本写好的操作文件直接读取：由模型抄写数十 KB 的 JSON 时，会抄错、截断或自行挑拣其中几条
      // （宁德画布 2026-10-21：模型挑出部分操作重写，漏掉删除旧连线的几条，随后的 order_inputs 全部被拒）。
      const source = opsPath
        ? await readFile(
            await resolveInWorkspace(rootsOf(ctx), opsPath, { mustExist: true }),
            'utf8',
          )
        : args.ops_json
      const name = opsPath ? 'ops_path 文件' : 'ops_json'
      const raw = jsonArg(source, 'array', name)
      if (!raw.ok) return failure(raw.error, 'invalid_tool_arguments')
      const raws = raw.value as unknown[] | undefined
      if (!raws?.length) {
        return failure(
          opsPath ? `${name} 须为非空数组` : '缺少 ops_json 或 ops_path，或操作数组为空',
          'invalid_tool_arguments',
        )
      }
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
      currentText(result) +
      (result.canvas ? `\n发起时的画布已不含该卡，结果写回 ${result.canvas}` : '') +
      `${result.warning ? `\n${result.warning}` : ''}${step ? viewStep(paths) : ''}`,
    data: { outputs: result.outputs, params: result.params },
    fileChanges: paths.map((p) => ({ path: p, changeType: 'created' as const })),
  }
}

/**
 * 卡片显示哪一个结果：同类产物不止一个、或取回的不是当前版本时写明当前版本，模型据此查看与引用，不必推测。
 * 接口返回的图片多于请求的张数时一并写明：每张都保存为该卡的版本。同一秒开始的几次生成共用时间戳文件名，
 * 路径末尾的 `-2`、`-5` 等编号只用于避开已有文件，不表示属于哪一次生成。视频随附的尾帧图是另一张卡，不计入。
 */
function currentText(result: Extract<CanvasRunResult, { ok: true }>): string {
  const { current, outputs } = result
  if (!current) return ''
  const kind = canvasFileKind(current)
  const same = outputs.filter((o) => canvasFileKind(o.path) === kind)
  const included = same.some((o) => o.path === current)
  if (included && same.length === 1) return ''
  const n = result.params.n
  const extra =
    kind === 'image' && typeof n === 'number' && same.length > n
      ? `；请求 ${n} 张，接口返回 ${same.length} 张`
      : ''
  return included
    ? `\n  卡片的当前版本：${current}；本次其余 ${same.length - 1} 个结果保存为该卡的其他版本${extra}`
    : `\n  卡片的当前版本仍为 ${current}；本次结果保存为该卡的其他版本`
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
    '指定的卡正在生成（由界面或上一轮发起）时不重复提交、不计费，等待该次生成结束并返回其结果；等待生成结果用本工具。' +
    '回执列出每个产物的宽高、时长与实际发送的参数。运行后核对结果：先核对回执中的宽高、时长与参数是否符合要求，' +
    '再用 read_file 查看图片与视频的画面是否符合提示词；不符合时查明原因，用 edit_canvas 修改提示词或参数，再运行该节点。' +
    '同一张卡片的图片最多重新运行 3 次，视频最多 2 次；用尽后把最接近要求的版本设为当前版本，继续其余节点，在最终回复中说明差异，该节点按完成处理。回复中的分辨率、时长与参数以回执为准。' +
    '每次运行提交新的生成任务，按次计费，结果符合要求时不重复运行。' +
    '用户要求换模型或参数重新生成而未点名卡片时，只运行尚无可用结果的卡，在最终回复中列出未重新生成的卡。' +
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

/**
 * 卡片的视频文件：视频文件卡取其文件，视频生成卡取当前版本。
 * 待取回的版本是恢复记录（`.task.json`），不是视频，按尚无结果处理。
 */
function videoOf(node: CanvasNode): { path: string } | { error: string } {
  const name = displayNameOf(node)
  if (node.type === 'timeline' || canvasMediaOf(node) !== 'video') {
    return { error: `「${name}」不是视频卡` }
  }
  if (node.type === 'file') return { path: node.path }
  const current = node.versions.find((v) => v.id === node.current)
  return current && !current.path.endsWith('.task.json')
    ? { path: current.path }
    : { error: `「${name}」尚无视频结果` }
}

export const captureCanvasFrameTool: ToolSpec = {
  name: 'capture_canvas_frame',
  description:
    '从画布上的视频卡截取一帧，保存为 generated/ 下的 PNG，并作为图片卡放在该视频卡右侧，与界面中的取帧相同。' +
    'node 是视频生成卡或视频文件卡的名称，生成卡取当前版本；at 是秒数，0 为首帧，不小于视频时长时为尾帧。' +
    '回执附上截取的画面，据此核对是否为要取的时刻。' +
    '新卡作为素材使用时，用 edit_canvas 的 update 修改其名称与 group，再连线到使用它的生成卡。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径' },
      node: { type: 'string', description: '视频卡的名称' },
      at: { type: 'number', description: '截取的时刻（秒）' },
    },
    required: ['path', 'node', 'at'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '从画布视频卡截取一帧',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const office = ctx.office
    if (!office) return failure('本次执行没有 Office 执行程序，无法解码视频')
    if (!office.enabled()) return failure('Office 文档已关闭')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    const ref = text(args.node)
    if (!ref) return failure('缺少 node', 'invalid_tool_arguments')
    const at = args.at
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      return failure('at 须为不小于 0 的秒数', 'invalid_tool_arguments')
    }
    try {
      const { doc } = await canvas.read(path)
      const found = cardIdOf(doc, ref)
      if (!found.ok) return failure(found.error, 'invalid_tool_arguments')
      const node = doc.nodes.find((n) => n.id === found.id)!
      const video = videoOf(node)
      if ('error' in video) return failure(video.error, 'invalid_tool_arguments')
      const abs = await resolveInWorkspace(rootsOf(ctx), video.path, { mustExist: true })
      const frame = await grabVideoFrame(ctx, office, abs, video.path, at)
      if ('status' in frame) return frame
      const label = frameLabel(at, frame.duration ?? Number.POSITIVE_INFINITY)
      const landed = await canvas.captureFrame(path, node.id, label, frame.png)
      const card = (await canvas.read(path)).doc.nodes.find((n) => n.id === landed.nodeId)
      const fit = await shrinkImage(frame.png, 'image/png')
      chargeImage(ctx, imageSizeOf(fit.bytes))
      return {
        status: 'success',
        message:
          `已截取「${displayNameOf(node)}」${Math.round(frame.time * 100) / 100} 秒处的一帧` +
          `（${frame.width}×${frame.height}），保存为 ${landed.path}；` +
          `新卡「${card ? displayNameOf(card) : landed.nodeId}」位于该视频卡右侧。`,
        data: {
          nodeId: landed.nodeId,
          path: landed.path,
          images: [{ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }],
        },
        fileChanges: [{ path: landed.path, changeType: 'created' }],
      }
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}

export const exportTimelineTool: ToolSpec = {
  name: 'export_timeline',
  description:
    '把画布上的一条时间线导出为成片并等待完成：由界面执行与「导出」按钮相同的编码（界面会打开该画布并显示进度），' +
    '成片保存为 generated/<时间线名称>.mp4（重名时加 -2），时间线右侧新增引用它的视频卡。' +
    '片段按 clips 的顺序与入点、出点拼接；先用 edit_canvas 整理好片段再导出。qywork 界面未打开该项目时无法导出。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '画布文件的工作区路径' },
      node: { type: 'string', description: '时间线的名称或 id' },
    },
    required: ['path', 'node'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '画布',
  category: 'media',
  facet: '生成',
  summary: '导出画布时间线的成片',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    const canvas = ctx.canvas
    if (!canvas) return failure('本次执行没有画布通道')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    const ref = text(args.node)
    if (!ref) return failure('缺少 node', 'invalid_tool_arguments')
    try {
      const { doc } = await canvas.read(path)
      const found = cardIdOf(doc, ref)
      if (!found.ok) return failure(found.error, 'invalid_tool_arguments')
      const source = doc.nodes.find((n) => n.id === found.id)!
      if (source.type !== 'timeline') {
        return failure(`「${displayNameOf(source)}」不是时间线`, 'invalid_tool_arguments')
      }
      const landed = await canvas.exportTimeline(path, source.id, ctx.signal)
      const card = (await canvas.read(path)).doc.nodes.find((n) => n.id === landed.nodeId)
      const seconds = source.clips.reduce((sum, c) => sum + (c.out - c.in), 0)
      return {
        status: 'success',
        message:
          `已导出「${displayNameOf(source)}」（${source.clips.length} 段，共 ${Math.round(seconds * 100) / 100} 秒），` +
          `成片保存为 ${landed.path}；新卡「${card ? displayNameOf(card) : landed.nodeId}」位于该时间线右侧。`,
        data: { nodeId: landed.nodeId, path: landed.path },
        fileChanges: [{ path: landed.path, changeType: 'created' }],
      }
    } catch (err) {
      return { status: 'failure', executed: true, message: (err as Error).message }
    }
  },
}
