/**
 * 画布文档：工作区中的一个 `*.canvas.json`。
 *
 * 只保存布局、节点名称、生成节点的提示词与历次版本、时间线的片段、连线，以及每次生成的记录。图片、视频、音频、文本一律是
 * 工作区路径的引用，画布不保存字节。修改只经由 `applyCanvasOps`（界面与大模型可提交的操作）与 `addVersions` /
 * `settleVersion` / `recordRun`（只由服务端画布服务调用），均为纯函数。
 *
 * 不变式：
 * - 节点、连线、版本的 id 在全文中唯一，由本模块分配，不复用；
 * - 连线只连接到生成节点，用途与两端类别相符，首尾帧与参考素材不同时出现；
 * - 生成节点提示词中的每个 `@[id]` 都有一条从该节点连入的输入线。断开连线的操作把对应的 `@[id]`
 *   替换为节点名称纯文本；修改提示词后新引用了未连接的节点时补充一条连线。
 */

import { arrangeNew, CARD_GAP } from './canvas-arrange.ts'
import {
  GENERATE_OUTPUTS,
  type GenerateOutput,
  MEDIA_INPUT_ROLES,
  type MediaDiagnostic,
  type MediaInputRole,
  type MediaOutput,
} from './media.ts'
import { baseNameOf, isInlineImage, isInlineVideo } from './model.ts'

/** 写入文件的 `version`。格式变化时加一，读取时遇到未知版本直接拒绝。 */
export const CANVAS_SCHEMA_VERSION = 1

/** 一次生成实际发出的请求内容。`prompt` 是编译后的文本（`@[id]` 已替换为模型的写法）。 */
export interface CanvasMade {
  prompt: string
  provider: string
  model: string
  params: Record<string, unknown>
  inputs: { role: MediaInputRole; path: string }[]
  at: string
}

/** 图片或视频的像素宽高。 */
export interface CanvasPixels {
  w: number
  h: number
}

export interface CanvasVersion {
  id: string
  /** 产物的工作区路径；待取回时为恢复记录（`.task.json`）的路径。 */
  path: string
  made: CanvasMade
  /** 产物的像素宽高，由服务端落盘时从文件头读取；无法读取（音频、任务记录、未知格式）时缺省。 */
  size?: CanvasPixels
  /** 本次生成有可用产物但未完整返回；跟随结果保存，切换版本或重启后仍可查看。 */
  warning?: string
}

export interface CanvasFileNode {
  id: string
  type: 'file'
  /** 缺省时显示去掉扩展名的文件名。 */
  name?: string
  /** 所属的组（如「角色」「分镜」），决定新卡排在哪里，见 `canvas-arrange.ts`。界面添加的节点没有组。 */
  group?: string
  path: string
  x: number
  y: number
  w: number
  h: number
}

/** 生成节点即结果位置：`versions` 是历次结果，`current` 是当前显示版本的 id。 */
export interface CanvasGenerateNode {
  id: string
  type: 'generate'
  output: GenerateOutput
  name: string
  /** 同 `CanvasFileNode.group`。 */
  group?: string
  x: number
  y: number
  w: number
  h: number
  prompt: string
  /** 与 `model` 同时给出或同时省略；都省略时使用该类别的默认模型。 */
  provider?: string
  model?: string
  params: Record<string, unknown>
  /** 各模型的参数选择；当前模型以 params 为准，键是 [provider, model] 的 JSON。 */
  paramsByModel?: Record<string, Record<string, unknown>>
  versions: CanvasVersion[]
  /** 有版本时必须存在。 */
  current?: string
}

/** 时间线上的一个片段：源视频 `path` 中从 `in` 到 `out` 秒（`0 ≤ in < out`）。 */
export interface CanvasClip {
  path: string
  in: number
  out: number
}

/**
 * 时间线：一条视频轨道，片段按数组顺序首尾相接。剪辑只修改片段的入点、出点与顺序，不修改源文件；
 * 成片由界面导出为新文件。`muted` 为真时整条轨道静音，导出时不带音轨。
 */
export interface CanvasTimelineNode {
  id: string
  type: 'timeline'
  name: string
  x: number
  y: number
  w: number
  h: number
  clips: CanvasClip[]
  muted?: true
}

export type CanvasNode = CanvasFileNode | CanvasGenerateNode | CanvasTimelineNode

/** 输入线：`from` 的内容作为 `to` 的输入，用途见 `MediaInputRole`。连线在数组中的顺序即输入顺序。 */
export interface CanvasEdge {
  id: string
  from: string
  to: string
  role: MediaInputRole
}

export interface CanvasDoc {
  version: typeof CANVAS_SCHEMA_VERSION
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  /** 生成记录，按结束时间排序。没有记录时文件中不写入该键。 */
  runs?: CanvasRunRecord[]
}

/**
 * 一次生成（提交或取回）的记录，界面与 Agent 发起的生成都记录，结束时追加一条。删除节点或版本时不删除记录。
 * 失败原文只在此处落盘；`cost` 与账本记录的是同一笔花费，账本是全局合计，此处只统计本画布。
 */
export interface CanvasRunRecord {
  /** 生成卡的节点 id。 */
  node: string
  /** `retrieve`：取回已有结果，不重新提交生成。 */
  action: 'run' | 'retrieve'
  /** 开始与结束时刻，ISO 8601。 */
  start: string
  end: string
  /** `pending`：有恢复记录，可尝试取回。`unknown`：本地等待结束，不能确认远端结果。 */
  result: 'done' | 'failed' | 'pending' | 'cancelled' | 'unknown'
  diagnostic?: MediaDiagnostic
  /** 未发出请求即失败（没有可用模型）时缺省。 */
  provider?: string
  model?: string
  /** 远端任务号。仅视频生成具有。 */
  task?: string
  /** 发出的提示词（编译后）、参数与输入。取回不重新提交，因此没有这三项。 */
  prompt?: string
  params?: Record<string, unknown>
  inputs?: { role: MediaInputRole; path: string }[]
  /** 失败或未能取回时的原文。 */
  message?: string
  /** 按接口回报的用量折算的花费；图片下载失败时仍保留已回报的用量。 */
  cost?: number
  currency?: string
}

/**
 * 节点在界面上的状态。由服务端根据磁盘与运行中集合推导，不落盘。
 * 优先级：运行中 > 待取回 > 结果未知 > 失败 > 空 > 缺失 > 正常；生成中与待取回检查全部版本，而不只检查 `current`。
 */
export type CanvasNodeState =
  | { state: 'normal' }
  | { state: 'missing' }
  | { state: 'empty' }
  /** `phase`：远端任务处于排队中还是生成中，仅在平台回报后存在；图像与音频等单次请求的生成没有该字段。 */
  | { state: 'running'; startedAt: number; phase?: 'queued' | 'running' }
  /** `version`：点击「取回」时取回的版本。 */
  | { state: 'pending'; version: string }
  | { state: 'failed'; message: string }
  | { state: 'unknown'; message: string }

/** 读取画布接口的返回值：文档与各节点状态。 */
export interface CanvasView {
  /** 工作区相对路径。 */
  path: string
  doc: CanvasDoc
  states: Record<string, CanvasNodeState>
}

/** 一个产物：工作区路径，以及从文件头读取的像素宽高与时长（秒）；无法读取时缺省。 */
export interface CanvasOutput {
  path: string
  size?: CanvasPixels
  duration?: number
}

/**
 * 一次运行或取回的结果。`params` 是实际发送的参数（画布只发送当前模式允许的取值，可能少于卡片上保存的参数）；
 * `pending`：存在恢复记录，该版本保留以待取回。
 */
export type CanvasRunResult =
  | { ok: true; outputs: CanvasOutput[]; params: Record<string, unknown>; warning?: string }
  | { ok: false; message: string; pending: boolean; diagnostic?: MediaDiagnostic }

/** 批量运行按请求顺序返回每个节点的结果；skipped 表示该节点未提交生成。 */
export type CanvasBatchRunResult = {
  node: string
  result: CanvasRunResult
  skipped?: true
}[]

/** 视频生成节点的输入模式。不落盘，由输入线的用途推导（`modeOf`）。 */
export type CanvasMode = 'reference' | 'first_last'

/**
 * 界面与大模型可提交的操作。
 *
 * 引用节点的字段（`id` / `from` / `to` / `beside` 与提示词中的 `@[…]`）接受节点 id、卡片名称或批内名称。
 * `ref`：以 `$` 开头的批内名称，只在同一批中有效，应用结果返回名称到 id 的对照；界面据此取得新节点的 id。
 * 新增操作不给出位置（`x` / `y` / `beside` / `near`）时按 `group` 排位，见 `canvas-arrange.ts`。
 * `null` 表示清除该字段。
 */
export type CanvasOp =
  | {
      op: 'add_file'
      ref?: string
      path: string
      name?: string
      group?: string
      /** 放在该节点右侧的第一个空位。给出 `x` / `y` 时以其为准。 */
      beside?: string
      /** 以该点为中心放置，与已有节点相交时下移到空位。优先级低于 `x` / `y` 与 `beside`。 */
      near?: { x: number; y: number }
      x?: number
      y?: number
      w?: number
      h?: number
      /** 文件的像素宽高，未给出 `w` / `h` 时按其比例确定框。只由服务端核验路径时填写，提交的操作中不接受该字段。 */
      size?: CanvasPixels
    }
  | {
      op: 'add_generate'
      ref?: string
      output: GenerateOutput
      name?: string
      prompt?: string
      provider?: string
      model?: string
      params?: Record<string, unknown>
      group?: string
      /** 同 `add_file` 的 `beside` 与 `near`。 */
      beside?: string
      near?: { x: number; y: number }
      x?: number
      y?: number
      w?: number
      h?: number
    }
  | {
      op: 'add_timeline'
      ref?: string
      name?: string
      clips?: CanvasClip[]
      muted?: boolean
      /** 同 `add_file` 的 `beside` 与 `near`。 */
      beside?: string
      near?: { x: number; y: number }
      x?: number
      y?: number
    }
  | {
      op: 'update'
      id: string
      x?: number
      y?: number
      w?: number
      h?: number
      name?: string | null
      prompt?: string
      provider?: string | null
      model?: string | null
      params?: Record<string, unknown>
      current?: string
      path?: string
      /** 同 `add_file` 的 `size`，与 `path` 一起提供。 */
      size?: CanvasPixels
      role?: MediaInputRole
      /** 时间线的全部片段，整组替换。 */
      clips?: CanvasClip[]
      muted?: boolean
    }
  | { op: 'connect'; ref?: string; from: string; to: string; role: MediaInputRole }
  | { op: 'remove'; id: string; version?: string }
  | { op: 'set_mode'; id: string; mode: CanvasMode }

export type CanvasResult =
  | { ok: true; doc: CanvasDoc; refs: Record<string, string> }
  | { ok: false; error: string }

/** 没有节点的画布。新建画布文件时写入该内容。 */
export function emptyCanvas(): CanvasDoc {
  return { version: CANVAS_SCHEMA_VERSION, nodes: [], edges: [] }
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 随机 8 位字符。节点、连线、版本共用一个 id 空间。 */
export function newCanvasId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const b of bytes) id += ID_ALPHABET[b % 36]
  return id
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 批内名称允许中文等任意文字的字母与数字：只允许英文时，模型按画布内容起的中文名称整批被拒。 */
const REF_RE = /^\$[\p{L}\p{N}_-]{1,64}$/u
/** 已保存的提示词中的引用：只有节点 id。 */
const MENTION_RE = /@\[([A-Za-z0-9_-]{1,64})\]/g
/**
 * 本批写入的提示词中的引用：节点 id、卡片名称或批内名称，保存前一律换成 id。
 * 不要用于已保存的提示词：其中「@[」开头的普通文字会被当作引用，原本合法的文件读取时被拒。
 */
const INPUT_MENTION_RE = /@\[([^[\]\n]{1,80})\]/g
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i

/** 提示词中 `@[id]` 引用的 id，按首次出现顺序去重。 */
export function mentionsOf(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(MENTION_RE)].map((m) => m[1]!))]
}

const TEXT_RE = /\.(md|txt)$/i
const ART_RE = /\.html?$/i

/**
 * 工作区文件放到画布上时的显示类别：图片、视频、音频按媒体显示，HTML 按 Art 运行，`.md` / `.txt` 显示正文，
 * 其余返回 null（只显示文件名）。
 */
export type CanvasFileKind = GenerateOutput | 'text'
export const CANVAS_FILE_KINDS: readonly CanvasFileKind[] = [...GENERATE_OUTPUTS, 'text']

export function canvasFileKind(path: string): CanvasFileKind | null {
  if (isInlineImage(path)) return 'image'
  if (isInlineVideo(path)) return 'video'
  if (AUDIO_RE.test(path)) return 'audio'
  if (ART_RE.test(path)) return 'art'
  if (TEXT_RE.test(path)) return 'text'
  return null
}

/**
 * 节点的媒体类别。文件按扩展名判定，无法判定的（文本、压缩包等）为 null，不能作为生成的输入；
 * `art` 有类别，同样不能作为输入（`roleProblem`）。
 */
export function canvasMediaOf(node: CanvasNode): GenerateOutput | null {
  if (node.type === 'generate') return node.output
  if (node.type === 'timeline') return null
  const kind = canvasFileKind(node.path)
  return kind === 'text' ? null : kind
}

/** 节点在界面与提示词纯文本中的名称。 */
export function displayNameOf(node: CanvasNode): string {
  if (node.type !== 'file' || node.name) return node.name ?? ''
  const base = baseNameOf(node.path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * 提示词中指代第 n 个素材的写法，按类别登记，`{n}` 从 1 开始、按类别分别计数（如 `图片{n}`）。
 * 由生成目录按模型提供，见 `MediaModelSpec.mention`。
 */
export type MentionStyle = Partial<Record<GenerateOutput, string>>

/**
 * 把提示词中的 `@[id]` 编译为发给模型的文字。
 *
 * 参考素材（参考图、参考视频、参考音频）按其在本次输入中同类别的序号套用 `style`；首帧、尾帧、未登记写法的类别、
 * 不在输入中的节点替换为节点名称：各模型的文档均未说明首尾帧是否计入编号，因此不做推测。
 */
export function compilePrompt(doc: CanvasDoc, nodeId: string, style: MentionStyle = {}): string {
  const node = doc.nodes.find((n) => n.id === nodeId)
  if (node?.type !== 'generate') return ''
  const numbered = new Map<string, string>()
  const counts: Partial<Record<GenerateOutput, number>> = {}
  for (const edge of inputsOf(doc, nodeId)) {
    if (edge.role === 'first_frame' || edge.role === 'last_frame') continue
    const source = doc.nodes.find((n) => n.id === edge.from)
    const kind = source && canvasMediaOf(source)
    if (!kind || numbered.has(edge.from)) continue
    const n = (counts[kind] ?? 0) + 1
    counts[kind] = n
    const template = style[kind]
    if (template) numbered.set(edge.from, template.replaceAll('{n}', String(n)))
  }
  return node.prompt.replace(MENTION_RE, (_whole, id: string) => {
    const named = numbered.get(id)
    if (named) return named
    const source = doc.nodes.find((n) => n.id === id)
    return source ? displayNameOf(source) : id
  })
}

/** 一个生成节点的输入线，按输入顺序。 */
export function inputsOf(doc: CanvasDoc, nodeId: string): CanvasEdge[] {
  return doc.edges.filter((e) => e.to === nodeId)
}

/** 视频生成节点当前的输入模式：存在首帧或尾帧连线时为首尾帧，否则为参考。 */
export function modeOf(doc: CanvasDoc, nodeId: string): CanvasMode {
  return inputsOf(doc, nodeId).some((e) => e.role === 'first_frame' || e.role === 'last_frame')
    ? 'first_last'
    : 'reference'
}

/** 工作区相对路径，以正斜杠分隔，不含 `.` / `..` 段。工作区边界由服务端按真实路径再核对一次。 */
function isRelativePath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const OUTPUT_NAME: Record<GenerateOutput, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  art: 'Art',
}
const GENERATE_SIZE: Record<GenerateOutput, [number, number]> = {
  image: [169, 169],
  video: [300, 169],
  audio: [300, 96],
  art: [300, 169],
}
const FILE_SIZE: Record<GenerateOutput | 'other', [number, number]> = {
  image: [225, 169],
  video: [300, 169],
  audio: [300, 96],
  art: [300, 169],
  other: [220, 138],
}
/**
 * 时间线的框：宽度固定；为空时只有工具行、刻度与轨道（`TIMELINE_BARE`），有片段后上方增加预览区。
 * 预览区按 16:9 占满框宽：框宽减去预览区左右各 8 的外边距（`canvas.css` 的 `.canvas-tl-view`），再按 16:9 换算为高度。
 * 修改这两个常量或相关样式时须同步修改另一侧，否则 16:9 的画面两侧会留出空白。
 */
export const TIMELINE_W = 480
const TIMELINE_BARE = 120
const TIMELINE_FULL = TIMELINE_BARE + Math.round(((TIMELINE_W - 16) * 9) / 16)

/** 时间线的框高：有片段时包含预览区。 */
function timelineHeight(clips: readonly CanvasClip[]): number {
  return clips.length ? TIMELINE_FULL : TIMELINE_BARE
}

/** 片段不合法的原因，合法时返回 null。源文件的时长由服务端核对。 */
function clipProblem(clip: CanvasClip): string | null {
  if (!isRelativePath(clip.path)) return `不是工作区中的相对路径：${clip.path}`
  if (!isInlineVideo(clip.path)) return `只有视频可以加入时间线：${clip.path}`
  if (
    !Number.isFinite(clip.in) ||
    !Number.isFinite(clip.out) ||
    clip.in < 0 ||
    clip.out <= clip.in
  ) {
    return `片段的入点出点不合法：${clip.path} ${clip.in}–${clip.out}`
  }
  return null
}

/** `near` 查找空位时与其他节点保留的间距，包含节点上方的标题行。 */
const CLEARANCE = 40

/**
 * 把框调整为媒体的宽高比：短边长度不变，长边按比例计算。横图的高度、竖图的宽度都等于原框的短边。
 * 不要改为固定高度：竖图沿用横图的高度时，宽度只有横图的几分之一（9:16 约为 16:9 的三分之一）。
 * 界面按所选宽高比预览空卡时使用同一个函数。
 */
export function fitBox(
  box: { w: number; h: number },
  size: CanvasPixels,
): { w: number; h: number } {
  const side = Math.min(box.w, box.h)
  return size.w >= size.h
    ? { w: Math.round((side * size.w) / size.h), h: side }
    : { w: side, h: Math.round((side * size.h) / size.w) }
}

/** 新建生成卡的缺省框。界面为空卡重新选择「自动」宽高比时按其比例还原。 */
export function blankBox(output: GenerateOutput): { w: number; h: number } {
  const [w, h] = GENERATE_SIZE[output]
  return { w, h }
}

/** 生成卡的框随当前版本的媒体比例调整；当前版本没有尺寸（音频、仍在远端的视频）时保持不变。 */
function fitCurrent(node: CanvasGenerateNode): void {
  const size = node.versions.find((v) => v.id === node.current)?.size
  if (size) Object.assign(node, fitBox(node, size))
}

class CanvasError extends Error {}

function fail(message: string): never {
  throw new CanvasError(message)
}

/**
 * 按顺序应用一批操作。整批成功时才返回新文档；任何一条不成立都返回 `ok: false`，原文档不变。
 *
 * `newId` 只在测试中注入。分配的 id 不会与本批开始时文档中已有的任何 id 相同。
 * 未给出位置的新节点在全部操作与连线完成后按组排位：组的类别由连线决定。
 */
export function applyCanvasOps(
  doc: CanvasDoc,
  ops: CanvasOp[],
  newId: () => string = newCanvasId,
): CanvasResult {
  const next = structuredClone(doc)
  const refs: Record<string, string> = {}
  const taken = new Set<string>()
  for (const n of doc.nodes) {
    taken.add(n.id)
    if (n.type === 'generate') for (const v of n.versions) taken.add(v.id)
  }
  for (const e of doc.edges) taken.add(e.id)
  const mint = (): string => {
    for (let i = 0; i < 100; i++) {
      const id = newId()
      if (!taken.has(id)) {
        taken.add(id)
        return id
      }
    }
    return fail('无法分配新的 id')
  }

  try {
    const pending: string[] = []
    for (const op of ops) applyOne(next, op, refs, pending, mint)
    resolveInputMentions(doc, next, refs)
    keepMentionsConnected(doc, next, mint)
    arrangeNew(next, pending, extentOf)
  } catch (err) {
    if (err instanceof CanvasError) return { ok: false, error: err.message }
    throw err
  }
  const problem = validateCanvas(next)
  return problem ? { ok: false, error: problem } : { ok: true, doc: next, refs }
}

function applyOne(
  doc: CanvasDoc,
  op: CanvasOp,
  refs: Record<string, string>,
  pending: string[],
  mint: () => string,
): void {
  const resolve = (ref: string): string => resolveRef(doc, refs, ref)
  /** 给出位置时立即排位；否则坐标暂为 `NaN`，补上缺省的组，留待全部操作完成后按组排位。 */
  const put = (
    node: CanvasNode,
    at: { x?: number; y?: number; beside?: string; near?: { x: number; y: number } },
  ) => {
    if (at.x !== undefined || at.y !== undefined || at.beside !== undefined || at.near) {
      place(doc, node, at, resolve)
    } else {
      node.x = Number.NaN
      node.y = Number.NaN
      if (node.type !== 'timeline') node.group ??= defaultGroup(node)
      pending.push(node.id)
    }
    doc.nodes.push(node)
  }
  const claim = (ref: string | undefined, id: string) => {
    if (ref === undefined) return
    if (!REF_RE.test(ref))
      fail(`批内名称须为 $ 加 1 到 64 个字母、数字、下划线或连字符，不含空格与标点：${ref}`)
    if (refs[ref]) fail(`批内名称重复：${ref}`)
    refs[ref] = id
  }

  switch (op.op) {
    case 'add_file': {
      if (!isRelativePath(op.path)) fail(`不是工作区中的相对路径：${op.path}`)
      const id = mint()
      claim(op.ref, id)
      const kind = canvasMediaOf({ id, type: 'file', path: op.path, x: 0, y: 0, w: 0, h: 0 })
      const [dw, dh] = FILE_SIZE[kind ?? 'other']
      const fit = op.size ? fitBox({ w: dw, h: dh }, op.size) : { w: dw, h: dh }
      const node: CanvasFileNode = {
        id,
        type: 'file',
        path: op.path,
        x: 0,
        y: 0,
        w: op.w ?? fit.w,
        h: op.h ?? fit.h,
      }
      if (op.name) node.name = op.name
      if (op.group !== undefined) node.group = op.group
      put(node, op)
      return
    }
    case 'add_generate': {
      const id = mint()
      claim(op.ref, id)
      const [dw, dh] = GENERATE_SIZE[op.output]
      const node: CanvasGenerateNode = {
        id,
        type: 'generate',
        output: op.output,
        name: op.name || defaultName(doc, OUTPUT_NAME[op.output]),
        x: 0,
        y: 0,
        w: op.w ?? dw,
        h: op.h ?? dh,
        prompt: op.prompt ?? '',
        params: op.params ?? {},
        versions: [],
      }
      if (op.provider !== undefined) node.provider = op.provider
      if (op.model !== undefined) node.model = op.model
      if (op.group !== undefined) node.group = op.group
      put(node, op)
      return
    }
    case 'add_timeline': {
      const id = mint()
      claim(op.ref, id)
      const clips = structuredClone(op.clips ?? [])
      const node: CanvasTimelineNode = {
        id,
        type: 'timeline',
        name: op.name || defaultName(doc, TIMELINE_NAME),
        x: 0,
        y: 0,
        w: TIMELINE_W,
        h: timelineHeight(clips),
        clips,
      }
      if (op.muted) node.muted = true
      put(node, op)
      return
    }
    case 'update': {
      const id = resolve(op.id)
      const edge = doc.edges.find((e) => e.id === id)
      if (edge) {
        const { op: _op, id: _id, role, ...rest } = op
        if (Object.keys(rest).length > 0) fail(`连线只能修改用途：${Object.keys(rest).join('、')}`)
        if (role !== undefined) edge.role = role
        return
      }
      const node = doc.nodes.find((n) => n.id === id) ?? fail(`目标已不存在：${op.id}`)
      if (op.role !== undefined) fail('节点没有用途，用途属于连线')
      if (op.x !== undefined) node.x = op.x
      if (op.y !== undefined) node.y = op.y
      if (op.w !== undefined) node.w = op.w
      if (op.h !== undefined) node.h = op.h
      if (node.type === 'timeline') {
        for (const key of ['prompt', 'provider', 'model', 'params', 'current', 'path'] as const) {
          if (op[key] !== undefined) fail(`时间线没有 ${key}`)
        }
        if (op.name === null || op.name === '') fail('时间线必须有名称')
        if (op.name !== undefined) node.name = op.name
        if (op.muted === true) node.muted = true
        else if (op.muted === false) delete node.muted
        if (op.clips !== undefined) {
          node.clips = structuredClone(op.clips)
          // 是否有片段决定是否显示预览区；同一次操作给出 h 时以其为准。
          if (op.h === undefined) node.h = timelineHeight(node.clips)
        }
        return
      }
      if (op.clips !== undefined || op.muted !== undefined) fail('只有时间线有片段与静音')
      if (node.type === 'file') {
        for (const key of ['prompt', 'provider', 'model', 'params', 'current'] as const) {
          if (op[key] !== undefined) fail(`文件节点没有 ${key}`)
        }
        if (op.name === null || op.name === '') delete node.name
        else if (op.name !== undefined) node.name = op.name
        if (op.path !== undefined) {
          if (!isRelativePath(op.path)) fail(`不是工作区中的相对路径：${op.path}`)
          node.path = op.path
          // 更换文件时随之更换比例；同一次操作给出 w / h 时以其为准。
          if (op.size && op.w === undefined && op.h === undefined) {
            Object.assign(node, fitBox(node, op.size))
          }
        }
        return
      }
      if (op.path !== undefined) fail('生成节点的路径由生成结果决定，不能直接修改')
      if (op.name === null || op.name === '') fail('生成节点必须有名称')
      if (op.name !== undefined) node.name = op.name
      if (op.prompt !== undefined) node.prompt = op.prompt
      const beforeModel = JSON.stringify([node.provider ?? null, node.model ?? null])
      const afterModel = JSON.stringify([
        op.provider === undefined ? (node.provider ?? null) : op.provider,
        op.model === undefined ? (node.model ?? null) : op.model,
      ])
      if (beforeModel !== afterModel) {
        node.paramsByModel = { ...node.paramsByModel, [beforeModel]: structuredClone(node.params) }
        node.params = structuredClone(node.paramsByModel[afterModel] ?? {})
      }
      if (op.params !== undefined) node.params = op.params
      if (op.current !== undefined) {
        node.current = op.current
        if (op.w === undefined && op.h === undefined) fitCurrent(node)
      }
      if (op.provider === null) delete node.provider
      else if (op.provider !== undefined) node.provider = op.provider
      if (op.model === null) delete node.model
      else if (op.model !== undefined) node.model = op.model
      return
    }
    case 'connect': {
      const edge: CanvasEdge = {
        id: mint(),
        from: resolve(op.from),
        to: resolve(op.to),
        role: op.role,
      }
      claim(op.ref, edge.id)
      doc.edges.push(edge)
      return
    }
    case 'remove': {
      const id = resolve(op.id)
      if (op.version !== undefined) {
        const node = doc.nodes.find((n) => n.id === id) ?? fail(`目标已不存在：${op.id}`)
        if (node.type !== 'generate') fail('只有生成节点有版本')
        const at = node.versions.findIndex((v) => v.id === op.version)
        if (at < 0) fail(`版本已不存在：${op.version}`)
        node.versions.splice(at, 1)
        if (node.current === op.version) {
          const last = node.versions.at(-1)
          if (last) node.current = last.id
          else delete node.current
          fitCurrent(node)
        }
        return
      }
      if (doc.edges.some((e) => e.id === id)) {
        doc.edges = doc.edges.filter((e) => e.id !== id)
        return
      }
      if (!doc.nodes.some((n) => n.id === id)) fail(`目标已不存在：${op.id}`)
      doc.nodes = doc.nodes.filter((n) => n.id !== id)
      doc.edges = doc.edges.filter((e) => e.from !== id && e.to !== id)
      return
    }
    case 'set_mode': {
      const id = resolve(op.id)
      const node = doc.nodes.find((n) => n.id === id) ?? fail(`目标已不存在：${op.id}`)
      if (node.type !== 'generate' || node.output !== 'video') fail('只有视频生成节点有输入模式')
      if (modeOf(doc, id) === op.mode) return
      if (op.mode === 'reference') {
        for (const e of inputsOf(doc, id)) e.role = 'reference'
        return
      }
      // 参考 → 首尾帧：前两张图依次改为首帧、尾帧，其余连线断开（提示词中对它们的 @ 由 `keepMentionsConnected` 替换为纯文本）。
      const frames = inputsOf(doc, id).filter((e) => e.role === 'reference')
      const keep = new Map<string, MediaInputRole>()
      if (frames[0]) keep.set(frames[0].id, 'first_frame')
      if (frames[1]) keep.set(frames[1].id, 'last_frame')
      doc.edges = doc.edges.filter((e) => e.to !== id || keep.has(e.id))
      for (const e of doc.edges) {
        const role = keep.get(e.id)
        if (role) e.role = role
      }
      return
    }
  }
}

/**
 * 界面与服务端给出的位置：给出 `beside` 时放在该节点右侧的第一个空位；给出 `near` 时以该点为中心，
 * 被占用时向下查找空位。调用方给出的 `x` / `y` 优先于此结果。
 * 不要让被占用的 `beside` 改为向下查找：取帧、尾帧与导出依次排在源节点右侧，向下查找时与下方的卡混在一起。
 */
function place(
  doc: CanvasDoc,
  node: CanvasNode,
  op: { x?: number; y?: number; beside?: string; near?: { x: number; y: number } },
  resolve: (ref: string) => string,
): void {
  const size = extentOf(node)
  let spot = { x: 0, y: 0 }
  if (op.beside !== undefined) {
    const id = resolve(op.beside)
    const source = extentOf(doc.nodes.find((n) => n.id === id) ?? fail(`「${op.beside}」不是卡片`))
    const at = { x: source.x + source.w + CARD_GAP, y: source.y }
    spot = freeSpot(doc, { ...size, ...at }, 'right', CARD_GAP)
  } else if (op.near) {
    const at = { x: Math.round(op.near.x - node.w / 2), y: Math.round(op.near.y - node.h / 2) }
    spot = freeSpot(doc, { ...size, ...at }, 'down', CLEARANCE)
  }
  node.x = op.x ?? spot.x
  node.y = op.y ?? spot.y
}

/**
 * 排位时节点占用的框。结果到达后，图片、视频与 Art 生成卡的形状按结果比例改变（`fitCurrent`，短边不变）。
 * 尚无结果的方形卡不知道结果是横是竖，按横、竖 16:9 都能容纳的框占位；已按参数确定宽高比的卡按当前框占位。
 * 音频没有尺寸，形状不变。不要让方形卡也按当前框：169 见方的空卡生成 16:9 的结果后宽 300，会压到相邻的卡。
 */
function extentOf(n: CanvasNode): { x: number; y: number; w: number; h: number } {
  if (n.type !== 'generate' || n.output === 'audio' || n.w !== n.h) return n
  if (n.versions.find((v) => v.id === n.current)?.size) return n
  const long = Math.round((n.w * 16) / 9)
  return { x: n.x, y: n.y, w: long, h: long }
}

/**
 * 从 `box` 的位置开始查找空位：与已有节点（含同一批中先添加的节点）相交时，`right` 移到该节点右侧、
 * `down` 移到该节点下方相隔 `gap` 处，直到不再相交。每次移动至少越过一个节点。
 */
function freeSpot(
  doc: CanvasDoc,
  box: { x: number; y: number; w: number; h: number },
  along: 'right' | 'down',
  gap: number,
): { x: number; y: number } {
  let { x, y } = box
  for (;;) {
    const hit = doc.nodes
      .map(extentOf)
      .find(
        (n) =>
          n.x < x + box.w + CLEARANCE &&
          n.x + n.w + CLEARANCE > x &&
          n.y < y + box.h + CLEARANCE &&
          n.y + n.h + CLEARANCE > y,
      )
    if (!hit) return { x, y }
    if (along === 'right') x = hit.x + hit.w + gap
    else y = hit.y + hit.h + gap
  }
}

const TIMELINE_NAME = '时间线'

/** 「视频3」「时间线2」这类默认名称：取同前缀中已有的最大序号加一。 */
function defaultName(doc: CanvasDoc, prefix: string): string {
  let max = 0
  for (const n of doc.nodes) {
    const m = n.name?.startsWith(prefix) ? /^\d+$/.exec(n.name.slice(prefix.length)) : null
    if (m) max = Math.max(max, Number(m[0]))
  }
  return `${prefix}${max + 1}`
}

/** 未给出组的新节点的组：按卡片类别，如「图片」「视频」；文件按其媒体类别，其他文件为「文件」。 */
function defaultGroup(node: CanvasFileNode | CanvasGenerateNode): string {
  if (node.type === 'generate') return OUTPUT_NAME[node.output]
  const kind = canvasMediaOf(node)
  return kind ? OUTPUT_NAME[kind] : '文件'
}

/**
 * 引用的节点或连线 id。依次按 id、批内名称、卡片名称查找；卡片名称对应多张卡时整批拒绝。
 * 不要只接受 id 与批内名称：大模型按自己起的卡片名称引用，要求它抄写随机 id 或批内名称时，
 * 写错、跨批使用、编造 id 都会使整批被拒，模型随后删去连线继续执行。
 */
function resolveRef(doc: CanvasDoc, refs: Record<string, string>, ref: string): string {
  if (doc.nodes.some((n) => n.id === ref) || doc.edges.some((e) => e.id === ref)) return ref
  if (ref.startsWith('$')) {
    return refs[ref] ?? fail(`${ref} 未定义：批内名称只在同一批操作中有效，引用卡片时写卡片名称`)
  }
  const named = doc.nodes.filter((n) => displayNameOf(n) === ref)
  if (named.length > 1) {
    fail(
      `名称「${ref}」对应 ${named.length} 张卡（${named.map((n) => n.id).join('、')}），改用其中一张的 id`,
    )
  }
  return named[0]?.id ?? fail(`未找到卡片「${ref}」：引用卡片时写画布上已有的卡片名称或 id`)
}

/** 按 id 或卡片名称找到节点的 id，规则同操作中的引用。未找到或名称对应多张卡时返回原因。 */
export function cardIdOf(
  doc: CanvasDoc,
  ref: string,
): { ok: true; id: string } | { ok: false; error: string } {
  try {
    return { ok: true, id: resolveRef(doc, {}, ref) }
  } catch (err) {
    if (err instanceof CanvasError) return { ok: false, error: err.message }
    throw err
  }
}

/**
 * 把本批写入的提示词中的 `@[卡片名称]`、`@[$批内名称]` 换成 `@[id]`；未改动的提示词保持原样。
 * 本批删除的节点的 id 不在此处解析，由 `keepMentionsConnected` 替换为名称纯文本。
 */
function resolveInputMentions(
  before: CanvasDoc,
  doc: CanvasDoc,
  refs: Record<string, string>,
): void {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]))
  for (const n of doc.nodes) {
    if (n.type !== 'generate') continue
    const old = beforeById.get(n.id)
    if (old?.type === 'generate' && old.prompt === n.prompt) continue
    n.prompt = n.prompt.replace(INPUT_MENTION_RE, (whole, key: string) =>
      beforeById.has(key) || doc.nodes.some((x) => x.id === key)
        ? whole
        : `@[${resolveRef(doc, refs, key)}]`,
    )
  }
}

/**
 * 维持「提示词中的每个 @ 都有输入线」。对每个没有连线的 `@[m]`：
 * - 本批新写入提示词的：补充一条连线（用途见 `MENTION_ROLE`）；无法补充时整批拒绝；
 * - 本批之前已在提示词中的（连线或节点在本批被删除）：替换为节点名称纯文本。
 */
function keepMentionsConnected(before: CanvasDoc, doc: CanvasDoc, mint: () => string): void {
  const beforeById = new Map(before.nodes.map((n) => [n.id, n]))
  for (const node of doc.nodes) {
    if (node.type !== 'generate') continue
    const old = beforeById.get(node.id)
    const oldMentions = new Set(old?.type === 'generate' ? mentionsOf(old.prompt) : [])
    for (const m of mentionsOf(node.prompt)) {
      if (doc.edges.some((e) => e.from === m && e.to === node.id)) continue
      const source = doc.nodes.find((n) => n.id === m)
      if (!source || oldMentions.has(m)) {
        const named = source ?? beforeById.get(m) ?? fail(`提示词引用的节点不存在：${m}`)
        node.prompt = node.prompt.split(`@[${m}]`).join(displayNameOf(named))
        continue
      }
      if (source.id === node.id) fail(`「${node.name}」不能引用自己`)
      if (modeOf(doc, node.id) === 'first_last') {
        fail(`「${node.name}」是首尾帧模式，不能引用首帧、尾帧以外的素材：${displayNameOf(source)}`)
      }
      const kind = canvasMediaOf(source)
      if (!kind || kind === 'art')
        fail(`「${displayNameOf(source)}」不能作为「${node.name}」的输入`)
      doc.edges.push({ id: mint(), from: source.id, to: node.id, role: MENTION_ROLE[kind] })
    }
  }
}

/**
 * 复制一组节点：返回在 `target` 上添加副本的一批操作。副本与原节点设置相同、整体平移 `offset`；生成卡不带版本。
 *
 * 选区内部的连线照常复制，提示词中对选区内节点的 `@` 指向副本。从选区外连入的连线：`withInputs` 为真且 `target` 中有对应节点时
 * 一并连接到副本、保留 `@`；否则不连接，`@` 改为名称纯文本（与删除连线同一规则）。从选区连出的连线不复制。
 */
export function copyOps(
  source: CanvasDoc,
  ids: readonly string[],
  target: CanvasDoc,
  offset: { dx: number; dy: number },
  withInputs: boolean,
): CanvasOp[] {
  const picked = source.nodes.filter((n) => ids.includes(n.id))
  const refOf = new Map(picked.map((n, i) => [n.id, `$copy${i + 1}`]))
  const inTarget = new Set(target.nodes.map((n) => n.id))
  const keepsInput = (from: string) => withInputs && inTarget.has(from)
  const byId = new Map(source.nodes.map((n) => [n.id, n]))
  const ops: CanvasOp[] = []
  for (const n of picked) {
    const box = { x: n.x + offset.dx, y: n.y + offset.dy, w: n.w, h: n.h }
    const ref = refOf.get(n.id)!
    if (n.type === 'file') {
      ops.push({
        op: 'add_file',
        ref,
        path: n.path,
        ...(n.name ? { name: n.name } : {}),
        ...(n.group ? { group: n.group } : {}),
        ...box,
      })
      continue
    }
    if (n.type === 'timeline') {
      ops.push({
        op: 'add_timeline',
        ref,
        name: n.name,
        clips: structuredClone(n.clips),
        ...(n.muted ? { muted: true } : {}),
        x: box.x,
        y: box.y,
      })
      continue
    }
    const prompt = n.prompt.replace(MENTION_RE, (whole, id: string) => {
      const copy = refOf.get(id)
      if (copy) return `@[${copy}]`
      if (keepsInput(id)) return whole
      const named = byId.get(id)
      return named ? displayNameOf(named) : whole
    })
    ops.push({
      op: 'add_generate',
      ref,
      output: n.output,
      name: n.name,
      prompt,
      params: structuredClone(n.params),
      ...(n.provider !== undefined ? { provider: n.provider } : {}),
      ...(n.model !== undefined ? { model: n.model } : {}),
      ...(n.group ? { group: n.group } : {}),
      ...box,
    })
  }
  for (const e of source.edges) {
    const to = refOf.get(e.to)
    if (!to) continue
    const from = refOf.get(e.from) ?? (keepsInput(e.from) ? e.from : null)
    if (from) ops.push({ op: 'connect', from, to, role: e.role })
  }
  return ops
}

/** 提示词中新 @ 未连接的节点时，补充连线所用的用途。 */
const MENTION_ROLE: Record<MediaOutput, MediaInputRole> = {
  image: 'reference',
  video: 'video',
  audio: 'audio',
}

/** 连线用途与两端类别是否相符。 */
function roleProblem(
  source: CanvasNode,
  target: CanvasGenerateNode,
  role: MediaInputRole,
): string | null {
  const from = `「${displayNameOf(source)}」`
  const to = `「${target.name}」`
  const kind = canvasMediaOf(source)
  if (target.output === 'audio') return `${to} 是语音合成，不接受输入`
  if (target.output === 'image' || target.output === 'art') {
    return kind === 'image' && role === 'reference' ? null : `${to} 只接受参考图，${from} 无法连接`
  }
  if (kind === 'image') {
    return role === 'video' || role === 'audio' ? `${from} 是图片，只能作为参考图或首尾帧` : null
  }
  if (kind === 'video') return role === 'video' ? null : `${from} 是视频，只能作为参考视频`
  if (kind === 'audio') return role === 'audio' ? null : `${from} 是音频，只能作为参考音频`
  return `${from} 不能作为 ${to} 的输入`
}

/** 文档是否满足全部不变式。成立返回 null，否则返回第一条不成立的原因。 */
export function validateCanvas(doc: CanvasDoc): string | null {
  const ids = new Set<string>()
  const claim = (id: string): string | null => {
    if (!ID_RE.test(id)) return `id 不合法：${id}`
    if (ids.has(id)) return `id 重复：${id}`
    ids.add(id)
    return null
  }
  const byId = new Map<string, CanvasNode>()
  for (const n of doc.nodes) {
    const bad = claim(n.id)
    if (bad) return bad
    byId.set(n.id, n)
    if (![n.x, n.y, n.w, n.h].every(Number.isFinite) || n.w <= 0 || n.h <= 0) {
      return `「${displayNameOf(n)}」的位置或尺寸不合法`
    }
    if (n.type === 'file') {
      if (!isRelativePath(n.path)) return `不是工作区中的相对路径：${n.path}`
      continue
    }
    if (n.type === 'timeline') {
      if (!n.name) return '时间线必须有名称'
      const bad = n.clips.map(clipProblem).find(Boolean)
      if (bad) return `「${n.name}」${bad}`
      continue
    }
    if (!n.name) return '生成节点必须有名称'
    if ((n.provider === undefined) !== (n.model === undefined)) {
      return `「${n.name}」的接口与模型必须同时给出或同时省略`
    }
    for (const v of n.versions) {
      const bad = claim(v.id)
      if (bad) return bad
      if (!isRelativePath(v.path)) return `不是工作区中的相对路径：${v.path}`
    }
    if (
      n.versions.length === 0
        ? n.current !== undefined
        : !n.versions.some((v) => v.id === n.current)
    ) {
      return `「${n.name}」的当前版本不存在：${n.current ?? '（未指定）'}`
    }
  }
  const pairs = new Set<string>()
  for (const e of doc.edges) {
    const bad = claim(e.id)
    if (bad) return bad
    const source = byId.get(e.from)
    const target = byId.get(e.to)
    if (!source || !target) return `连线的端点已不存在：${e.id}`
    if (target.type !== 'generate') return `连线只能连接到生成节点：「${displayNameOf(target)}」`
    if (source.id === target.id) return `「${target.name}」不能连接到自己`
    if (pairs.has(`${e.from}>${e.to}`)) {
      return `「${displayNameOf(source)}」已连接到「${target.name}」`
    }
    pairs.add(`${e.from}>${e.to}`)
    const problem = roleProblem(source, target, e.role)
    if (problem) return problem
  }
  for (const n of doc.nodes) {
    if (n.type !== 'generate') continue
    const inputs = inputsOf(doc, n.id)
    const count = (role: MediaInputRole) => inputs.filter((e) => e.role === role).length
    const frames = count('first_frame') + count('last_frame')
    if (count('first_frame') > 1 || count('last_frame') > 1) {
      return `「${n.name}」的首帧、尾帧各只能有一张`
    }
    if (frames > 0 && count('reference') + count('video') + count('audio') > 0) {
      return `「${n.name}」的首尾帧不能与参考图、参考视频、参考音频同时提供`
    }
    for (const m of mentionsOf(n.prompt)) {
      if (!inputs.some((e) => e.from === m)) return `「${n.name}」的提示词引用了未连接的节点：${m}`
    }
  }
  return null
}

/**
 * 追加一次生成的结果，多张结果对应多个版本，`current` 指向第一张，框按其比例调整。只由服务端画布服务调用：
 * 版本中的 `made` 记录的是实际发出的请求，界面与大模型的操作不能写入版本。
 */
export function addVersions(
  doc: CanvasDoc,
  nodeId: string,
  versions: CanvasVersion[],
): CanvasResult {
  const next = structuredClone(doc)
  const node = next.nodes.find((n) => n.id === nodeId)
  if (node?.type !== 'generate') return { ok: false, error: `目标已不存在：${nodeId}` }
  if (versions.length === 0) return { ok: true, doc: next, refs: {} }
  node.versions.push(...structuredClone(versions))
  node.current = versions[0]!.id
  fitCurrent(node)
  const problem = validateCanvas(next)
  return problem ? { ok: false, error: problem } : { ok: true, doc: next, refs: {} }
}

/**
 * 把一个版本改指到新路径（远端视频取回后由任务记录改为产物），并带上产物的像素宽高。
 * 该版本为当前版本时，框按其比例调整。只由服务端画布服务调用。
 */
export function settleVersion(
  doc: CanvasDoc,
  nodeId: string,
  versionId: string,
  path: string,
  size?: CanvasPixels,
): CanvasResult {
  const next = structuredClone(doc)
  const node = next.nodes.find((n) => n.id === nodeId)
  const version = node?.type === 'generate' ? node.versions.find((v) => v.id === versionId) : null
  if (!version || node?.type !== 'generate')
    return { ok: false, error: `版本已不存在：${versionId}` }
  version.path = path
  if (size) version.size = size
  else delete version.size
  fitCurrent(node)
  const problem = validateCanvas(next)
  return problem ? { ok: false, error: problem } : { ok: true, doc: next, refs: {} }
}

/** 追加一条生成记录。节点已删除时同样记录：记录的是已发生的事实。只由服务端画布服务调用。 */
export function recordRun(doc: CanvasDoc, record: CanvasRunRecord): CanvasResult {
  const problem = checkFields('生成记录', record, RUN_FIELDS)
  if (problem) return { ok: false, error: problem }
  const next = structuredClone(doc)
  next.runs = [...(next.runs ?? []), structuredClone(record)]
  return { ok: true, doc: next, refs: {} }
}

// ── 读写 ──

type Shape =
  | 'string'
  | 'number'
  | 'object'
  | 'array'
  | 'role'
  | 'output'
  | 'mode'
  | 'nullable'
  | 'point'
  | 'size'
  | 'boolean'
  | 'true'
  | 'clips'
  | 'inputs'
  | 'action'
  | 'result'
  | 'diagnostic'

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function matches(v: unknown, shape: Shape): boolean {
  switch (shape) {
    case 'string':
      return typeof v === 'string'
    case 'nullable':
      return typeof v === 'string' || v === null
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
    case 'size':
      return (
        isObject(v) &&
        Object.keys(v).length === 2 &&
        matches(v.w, 'number') &&
        matches(v.h, 'number') &&
        (v.w as number) > 0 &&
        (v.h as number) > 0
      )
    case 'point':
      return (
        isObject(v) &&
        Object.keys(v).length === 2 &&
        matches(v.x, 'number') &&
        matches(v.y, 'number')
      )
    case 'object':
      return isObject(v)
    case 'array':
      return Array.isArray(v)
    case 'role':
      return (MEDIA_INPUT_ROLES as readonly unknown[]).includes(v)
    case 'output':
      return (GENERATE_OUTPUTS as readonly unknown[]).includes(v)
    case 'mode':
      return v === 'reference' || v === 'first_last'
    case 'boolean':
      return typeof v === 'boolean'
    case 'true':
      return v === true
    case 'clips':
      return Array.isArray(v) && v.every((c) => checkFields('片段', c, CLIP_FIELDS) === null)
    case 'inputs':
      return Array.isArray(v) && v.every((x) => checkFields('输入', x, INPUT_FIELDS) === null)
    case 'action':
      return v === 'run' || v === 'retrieve'
    case 'result':
      return (
        v === 'done' || v === 'failed' || v === 'pending' || v === 'cancelled' || v === 'unknown'
      )
    case 'diagnostic':
      return (
        isObject(v) &&
        ['generate', 'query', 'download'].includes(String(v.stage)) &&
        ['timeout', 'connection', 'http', 'response'].includes(String(v.kind)) &&
        ['unknown', 'rejected', 'available'].includes(String(v.outcome)) &&
        checkFields('请求诊断', v, DIAGNOSTIC_FIELDS) === null
      )
  }
}

/** 按字段表核对一个对象：存在多余的键、缺少必填键或类型错误时均不合法。必填键以 `!` 结尾。 */
function checkFields(where: string, raw: unknown, fields: Record<string, Shape>): string | null {
  if (!isObject(raw)) return `${where} 不是对象`
  const shapes = new Map(Object.entries(fields).map(([k, s]) => [k.replace(/!$/, ''), s]))
  for (const key of Object.keys(raw)) {
    if (!shapes.has(key)) return `${where} 含有未知字段：${key}`
  }
  for (const [key, shape] of Object.entries(fields)) {
    const name = key.replace(/!$/, '')
    if (!Object.hasOwn(raw, name)) {
      if (key.endsWith('!')) return `${where} 缺少 ${name}`
      continue
    }
    if (!matches(raw[name], shape)) {
      const want = TYPE_NAMES[shape]
      return want
        ? `${where} 的 ${name} 类型错误：应为${want}，收到的是${typeName(raw[name])}`
        : `${where} 的 ${name} 不合法`
    }
  }
  return null
}

/**
 * 类型不符时报错中写明的期望类型。不要只报「不合法」：大模型把对象再编码为 JSON 字符串时，
 * 无从得知错在类型，会删去该字段重试，参数随之丢失。其余形状的报错由取值范围决定。
 */
const TYPE_NAMES: Partial<Record<Shape | 'null', string>> = {
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  object: '对象',
  array: '数组',
  null: 'null',
}

function typeName(v: unknown): string {
  const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v
  return TYPE_NAMES[type as Shape | 'null'] ?? type
}

const BOX: Record<string, Shape> = { x: 'number', y: 'number', w: 'number', h: 'number' }

const OP_FIELDS: Record<CanvasOp['op'], Record<string, Shape>> = {
  add_file: {
    'op!': 'string',
    ref: 'string',
    'path!': 'string',
    name: 'string',
    group: 'string',
    beside: 'string',
    near: 'point',
    ...BOX,
  },
  add_generate: {
    'op!': 'string',
    ref: 'string',
    'output!': 'output',
    name: 'string',
    prompt: 'string',
    provider: 'string',
    model: 'string',
    params: 'object',
    group: 'string',
    beside: 'string',
    near: 'point',
    ...BOX,
  },
  add_timeline: {
    'op!': 'string',
    ref: 'string',
    name: 'string',
    clips: 'clips',
    muted: 'boolean',
    beside: 'string',
    near: 'point',
    x: 'number',
    y: 'number',
  },
  update: {
    'op!': 'string',
    'id!': 'string',
    ...BOX,
    name: 'nullable',
    prompt: 'string',
    provider: 'nullable',
    model: 'nullable',
    params: 'object',
    current: 'string',
    path: 'string',
    role: 'role',
    clips: 'clips',
    muted: 'boolean',
  },
  connect: { 'op!': 'string', ref: 'string', 'from!': 'string', 'to!': 'string', 'role!': 'role' },
  remove: { 'op!': 'string', 'id!': 'string', version: 'string' },
  set_mode: { 'op!': 'string', 'id!': 'string', 'mode!': 'mode' },
}

/** 核对界面或大模型提交的一批操作。版本不在可提交的字段中：带 `versions` 的操作一律拒绝。 */
export function parseCanvasOps(
  raw: unknown,
): { ok: true; ops: CanvasOp[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '操作必须是非空数组' }
  for (const [i, op] of raw.entries()) {
    const where = `第 ${i + 1} 条操作`
    if (!isObject(op) || typeof op.op !== 'string' || !Object.hasOwn(OP_FIELDS, op.op)) {
      return { ok: false, error: `${where} 的 op 无法识别` }
    }
    const bad = checkFields(where, op, OP_FIELDS[op.op as CanvasOp['op']])
    if (bad) return { ok: false, error: bad }
  }
  return { ok: true, ops: raw as CanvasOp[] }
}

const FILE_FIELDS: Record<string, Shape> = {
  'id!': 'string',
  'type!': 'string',
  name: 'string',
  group: 'string',
  'path!': 'string',
  ...boxRequired(),
}
const GENERATE_FIELDS: Record<string, Shape> = {
  'id!': 'string',
  'type!': 'string',
  'output!': 'output',
  'name!': 'string',
  group: 'string',
  ...boxRequired(),
  'prompt!': 'string',
  provider: 'string',
  model: 'string',
  'params!': 'object',
  paramsByModel: 'object',
  'versions!': 'array',
  current: 'string',
}
const TIMELINE_FIELDS: Record<string, Shape> = {
  'id!': 'string',
  'type!': 'string',
  'name!': 'string',
  ...boxRequired(),
  'clips!': 'clips',
  muted: 'true',
}
const CLIP_FIELDS: Record<string, Shape> = { 'path!': 'string', 'in!': 'number', 'out!': 'number' }
const VERSION_FIELDS: Record<string, Shape> = {
  'id!': 'string',
  'path!': 'string',
  'made!': 'object',
  size: 'size',
  warning: 'string',
}
const MADE_FIELDS: Record<string, Shape> = {
  'prompt!': 'string',
  'provider!': 'string',
  'model!': 'string',
  'params!': 'object',
  'inputs!': 'array',
  'at!': 'string',
}
const INPUT_FIELDS: Record<string, Shape> = { 'role!': 'role', 'path!': 'string' }
const DIAGNOSTIC_FIELDS: Record<string, Shape> = {
  'stage!': 'string',
  'kind!': 'string',
  'outcome!': 'string',
  'host!': 'string',
  'elapsedMs!': 'number',
  'timeoutMs!': 'number',
  status: 'number',
  code: 'string',
  requestId: 'string',
}
const RUN_FIELDS: Record<string, Shape> = {
  diagnostic: 'diagnostic',
  'node!': 'string',
  'action!': 'action',
  'start!': 'string',
  'end!': 'string',
  'result!': 'result',
  provider: 'string',
  model: 'string',
  task: 'string',
  prompt: 'string',
  params: 'object',
  inputs: 'inputs',
  message: 'string',
  cost: 'number',
  currency: 'string',
}
const EDGE_FIELDS: Record<string, Shape> = {
  'id!': 'string',
  'from!': 'string',
  'to!': 'string',
  'role!': 'role',
}

function boxRequired(): Record<string, Shape> {
  return { 'x!': 'number', 'y!': 'number', 'w!': 'number', 'h!': 'number' }
}

/** 读取画布文件。结构或不变式不成立时拒绝，不做修补：手动修改出错的文件由用户自行修正。 */
export function parseCanvas(
  text: string,
): { ok: true; doc: CanvasDoc } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '不是合法的 JSON' }
  }
  const problem = structureProblem(raw) ?? validateCanvas(raw as CanvasDoc)
  if (problem) return { ok: false, error: problem }
  const doc = raw as CanvasDoc
  // 音频节点使用 169×169 默认框时，读取时统一改为当前布局；自定义尺寸和其他媒体保持原样。
  for (const node of doc.nodes) {
    if (canvasMediaOf(node) === 'audio' && node.w === 169 && node.h === 169) {
      Object.assign(node, blankBox('audio'))
    }
  }
  return { ok: true, doc }
}

function structureProblem(raw: unknown): string | null {
  const top = checkFields('画布', raw, {
    'version!': 'number',
    'nodes!': 'array',
    'edges!': 'array',
    runs: 'array',
  })
  if (top) return top
  const doc = raw as { version: number; nodes: unknown[]; edges: unknown[]; runs?: unknown[] }
  if (doc.version !== CANVAS_SCHEMA_VERSION) return `未知的画布版本：${doc.version}`
  for (const [i, n] of doc.nodes.entries()) {
    const where = `第 ${i + 1} 个节点`
    const type = isObject(n) ? n.type : undefined
    if (type !== 'file' && type !== 'generate' && type !== 'timeline')
      return `${where} 的 type 无法识别`
    const fields = { file: FILE_FIELDS, generate: GENERATE_FIELDS, timeline: TIMELINE_FIELDS }[type]
    const bad = checkFields(where, n, fields)
    if (bad) return bad
    if (type !== 'generate') continue
    if (
      isObject(n) &&
      isObject(n.paramsByModel) &&
      Object.values(n.paramsByModel).some((p) => !isObject(p))
    )
      return `${where} 的模型参数记录不合法`
    for (const [j, v] of (n as { versions: unknown[] }).versions.entries()) {
      const at = `${where}的第 ${j + 1} 版`
      const made = isObject(v) ? v.made : undefined
      const inputs = isObject(made) && Array.isArray(made.inputs) ? made.inputs : []
      const vBad =
        checkFields(at, v, VERSION_FIELDS) ??
        checkFields(`${at}的 made`, made, MADE_FIELDS) ??
        inputs
          .map((x, k) => checkFields(`${at}的第 ${k + 1} 个输入`, x, INPUT_FIELDS))
          .find(Boolean)
      if (vBad) return vBad
    }
  }
  for (const [i, e] of doc.edges.entries()) {
    const bad = checkFields(`第 ${i + 1} 条连线`, e, EDGE_FIELDS)
    if (bad) return bad
  }
  for (const [i, r] of (doc.runs ?? []).entries()) {
    const bad = checkFields(`第 ${i + 1} 条生成记录`, r, RUN_FIELDS)
    if (bad) return bad
  }
  return null
}

/** 写入磁盘的文本。键按固定顺序排列，同一份文档无论经由哪条路径写出，字节都相同。 */
export function serializeCanvas(doc: CanvasDoc): string {
  const nodes = doc.nodes.map((n) =>
    n.type === 'file'
      ? {
          id: n.id,
          type: n.type,
          ...(n.name ? { name: n.name } : {}),
          ...(n.group ? { group: n.group } : {}),
          path: n.path,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h,
        }
      : n.type === 'timeline'
        ? {
            id: n.id,
            type: n.type,
            name: n.name,
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            clips: n.clips.map((c) => ({ path: c.path, in: c.in, out: c.out })),
            ...(n.muted ? { muted: true } : {}),
          }
        : {
            id: n.id,
            type: n.type,
            output: n.output,
            name: n.name,
            ...(n.group ? { group: n.group } : {}),
            x: n.x,
            y: n.y,
            w: n.w,
            h: n.h,
            prompt: n.prompt,
            ...(n.provider !== undefined ? { provider: n.provider } : {}),
            ...(n.model !== undefined ? { model: n.model } : {}),
            params: n.params,
            ...(n.paramsByModel ? { paramsByModel: n.paramsByModel } : {}),
            versions: n.versions.map((v) => ({
              id: v.id,
              path: v.path,
              made: {
                prompt: v.made.prompt,
                provider: v.made.provider,
                model: v.made.model,
                params: v.made.params,
                inputs: v.made.inputs.map((x) => ({ role: x.role, path: x.path })),
                at: v.made.at,
              },
              ...(v.size ? { size: { w: v.size.w, h: v.size.h } } : {}),
              ...(v.warning ? { warning: v.warning } : {}),
            })),
            ...(n.current !== undefined ? { current: n.current } : {}),
          },
  )
  const edges = doc.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, role: e.role }))
  const runs = (doc.runs ?? []).map((r) => ({
    node: r.node,
    action: r.action,
    start: r.start,
    end: r.end,
    result: r.result,
    ...(r.diagnostic !== undefined ? { diagnostic: r.diagnostic } : {}),
    ...(r.provider !== undefined ? { provider: r.provider } : {}),
    ...(r.model !== undefined ? { model: r.model } : {}),
    ...(r.task !== undefined ? { task: r.task } : {}),
    ...(r.prompt !== undefined ? { prompt: r.prompt } : {}),
    ...(r.params !== undefined ? { params: r.params } : {}),
    ...(r.inputs !== undefined
      ? { inputs: r.inputs.map((x) => ({ role: x.role, path: x.path })) }
      : {}),
    ...(r.message !== undefined ? { message: r.message } : {}),
    ...(r.cost !== undefined ? { cost: r.cost } : {}),
    ...(r.currency !== undefined ? { currency: r.currency } : {}),
  }))
  const top = runs.length
    ? { version: doc.version, nodes, edges, runs }
    : { version: doc.version, nodes, edges }
  return `${JSON.stringify(top, null, 2)}\n`
}
