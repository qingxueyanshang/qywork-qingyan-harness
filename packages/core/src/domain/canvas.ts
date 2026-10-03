/**
 * 画布文档：工作区里的一个 `*.canvas.json`。
 *
 * 只存布局、节点名、生成节点的提示词与历次版本、时间线的片段、连线，以及每次生成的记录。图片、视频、音频、文本一律是
 * 工作区路径的引用，画布不存字节。修改只经 `applyCanvasOps`（界面与大模型可提交的操作）与 `addVersions` /
 * `settleVersion` / `recordRun`（只由服务端画布服务调用），都是纯函数。
 *
 * 不变式：
 * - 节点、连线、版本的 id 全文唯一，由本模块分配，不复用；
 * - 连线只连到生成节点，用途与两端类别相符，首尾帧与参考素材不同时出现；
 * - 生成节点提示词里的每个 `@[id]` 都有一条从该节点连过来的输入线。断线的操作把对应的 `@[id]`
 *   换成节点名纯文本，改提示词新引用了未连的节点时补一条线。
 */

import { MEDIA_INPUT_ROLES, MEDIA_OUTPUTS, type MediaInputRole, type MediaOutput } from './media.ts'
import { baseNameOf, isInlineImage, isInlineVideo } from './model.ts'

/** 写进文件的 `version`。格式变了就加一，读不认识的版本直接拒绝。 */
export const CANVAS_SCHEMA_VERSION = 1

/** 一次生成实际发出的请求内容。`prompt` 是编译后的那一份（`@[id]` 已换成模型的写法）。 */
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
  /** 产物的工作区路径；视频还在远端时是任务记录（`.task.json`）的路径。 */
  path: string
  made: CanvasMade
  /** 产物的像素宽高，服务端落盘时从文件头读出；读不出（音频、任务记录、不认识的格式）时没有。 */
  size?: CanvasPixels
  /** 本次生成有可用产物但未完整返回；跟随结果保存，切换版本或重启后仍可查看。 */
  warning?: string
}

export interface CanvasFileNode {
  id: string
  type: 'file'
  /** 缺省显示文件名去扩展名。 */
  name?: string
  path: string
  x: number
  y: number
  w: number
  h: number
}

/** 生成节点就是结果位：`versions` 是历次结果，`current` 是当前显示那一版的 id。 */
export interface CanvasGenerateNode {
  id: string
  type: 'generate'
  output: MediaOutput
  name: string
  x: number
  y: number
  w: number
  h: number
  prompt: string
  /** 与 `model` 同给同不给；都不给用该类别的默认模型。 */
  provider?: string
  model?: string
  params: Record<string, unknown>
  /** 各模型的参数选择；当前模型以 params 为准，键是 [provider, model] 的 JSON。 */
  paramsByModel?: Record<string, Record<string, unknown>>
  versions: CanvasVersion[]
  /** 有版本时必有。 */
  current?: string
}

/** 时间线上的一段：源视频 `path` 里从 `in` 到 `out` 秒（`0 ≤ in < out`）。 */
export interface CanvasClip {
  path: string
  in: number
  out: number
}

/**
 * 时间线：一条视频轨，片段按数组顺序首尾相接。剪辑只改片段的入点出点与顺序，不改源文件；
 * 成片由界面导出成新文件。`muted` 为真时整条轨道静音，导出不带音轨。
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

/** 输入线：`from` 的内容作为 `to` 的输入，用途见 `MediaInputRole`。线在数组里的顺序即输入顺序。 */
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
  /** 生成记录，按结束先后排。没有记录时文件里不写这个键。 */
  runs?: CanvasRunRecord[]
}

/**
 * 一次生成（提交或取回）的记录，界面与 Agent 发起的都记，结束时追加一条。删节点、删版本都不删记录。
 * 失败原文只在这里落盘；`cost` 与账本记的是同一笔，账本是全局合计，这里只管本画布。
 */
export interface CanvasRunRecord {
  /** 生成卡的节点 id。 */
  node: string
  /** `retrieve`：取回已提交的视频任务，不再提交、不重复计费。 */
  action: 'run' | 'retrieve'
  /** 开始与结束时刻，ISO 8601。 */
  start: string
  end: string
  /** `pending`：远端任务还在，可以取回。`cancelled`：排队中撤销，不计费。 */
  result: 'done' | 'failed' | 'pending' | 'cancelled'
  /** 没有发出请求就失败（没有可用模型）时没有。 */
  provider?: string
  model?: string
  /** 远端任务号。只有视频有。 */
  task?: string
  /** 发出的提示词（编译后）、参数与输入。取回不提交，没有这三项。 */
  prompt?: string
  params?: Record<string, unknown>
  inputs?: { role: MediaInputRole; path: string }[]
  /** 失败、未能取回时的原文。 */
  message?: string
  /** 接口回报用量折算的花费。拿到结果才计费，其余结果没有。 */
  cost?: number
  currency?: string
}

/**
 * 节点在界面上的状态。由服务端按磁盘与在跑集合推出，不存盘。
 * 先后次序：在跑 > 待取回 > 失败 > 空 > 缺失 > 正常；生成中与待取回看全部版本，不只看 `current`。
 */
export type CanvasNodeState =
  | { state: 'normal' }
  | { state: 'missing' }
  | { state: 'empty' }
  /** `phase`：远端任务排队中还是生成中，平台回报过才有；图像与音频这类一次请求的生成没有。 */
  | { state: 'running'; startedAt: number; phase?: 'queued' | 'running' }
  /** `version`：点「取回」时取哪一版。 */
  | { state: 'pending'; version: string }
  | { state: 'failed'; message: string }

/** 读画布接口的出参：文档加各节点状态。 */
export interface CanvasView {
  /** 工作区相对路径。 */
  path: string
  doc: CanvasDoc
  states: Record<string, CanvasNodeState>
}

/** 一次运行或取回的结果。`pending`：远端任务还在，这一版留着等取回。 */
export type CanvasRunResult =
  | { ok: true; paths: string[]; warning?: string }
  | { ok: false; message: string; pending: boolean }

/** 视频生成节点的输入模式。不存盘，由输入线的用途推出（`modeOf`）。 */
export type CanvasMode = 'reference' | 'first_last'

/**
 * 界面与大模型能提交的操作。
 *
 * `ref`：以 `$` 开头的批内名字。同一批后面的操作可以用它代替还没分配的 id（`id` / `from` / `to` 与
 * 提示词里的 `@[$名字]`），应用结果回报名字到 id 的对照。`null` 表示清掉该字段。
 */
export type CanvasOp =
  | {
      op: 'add_file'
      ref?: string
      path: string
      name?: string
      /** 放在这个节点（id 或批内名字）右侧的第一个空位。给了 `x` / `y` 时以它们为准。 */
      beside?: string
      /** 以这一点为中心放，与已有节点相交就下移到空位。优先级低于 `x` / `y` 与 `beside`。 */
      near?: { x: number; y: number }
      x?: number
      y?: number
      w?: number
      h?: number
      /** 文件的像素宽高，没给 `w` / `h` 时框按它的比例定。只由服务端核验路径时填，提交的操作里不认。 */
      size?: CanvasPixels
    }
  | {
      op: 'add_generate'
      ref?: string
      output: MediaOutput
      name?: string
      prompt?: string
      provider?: string
      model?: string
      params?: Record<string, unknown>
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
      /** 同 `add_file` 的 `size`，随 `path` 一起。 */
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

/** 没有节点的画布。新建画布文件写的就是它。 */
export function emptyCanvas(): CanvasDoc {
  return { version: CANVAS_SCHEMA_VERSION, nodes: [], edges: [] }
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 随机 8 位。节点、连线、版本共用一个 id 空间。 */
export function newCanvasId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  let id = ''
  for (const b of bytes) id += ID_ALPHABET[b % 36]
  return id
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const REF_RE = /^\$[A-Za-z0-9_-]{1,64}$/
const MENTION_RE = /@\[(\$?[A-Za-z0-9_-]{1,64})\]/g
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i

/** 提示词里 `@[id]` 引用的 id，按首次出现的顺序去重。 */
export function mentionsOf(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(MENTION_RE)].map((m) => m[1]!))]
}

const TEXT_RE = /\.(md|txt)$/i

/** 工作区文件放上画布按哪一类显示：图片、视频、音频按媒体，`.md` / `.txt` 显示正文，其余回 null（只显示文件名）。 */
export type CanvasFileKind = MediaOutput | 'text'
export const CANVAS_FILE_KINDS: readonly CanvasFileKind[] = [...MEDIA_OUTPUTS, 'text']

export function canvasFileKind(path: string): CanvasFileKind | null {
  if (isInlineImage(path)) return 'image'
  if (isInlineVideo(path)) return 'video'
  if (AUDIO_RE.test(path)) return 'audio'
  if (TEXT_RE.test(path)) return 'text'
  return null
}

/** 节点能作为哪一类输入。文件按扩展名判；判不出的（文本、压缩包等）不能作为生成的输入。 */
export function canvasMediaOf(node: CanvasNode): MediaOutput | null {
  if (node.type === 'generate') return node.output
  if (node.type === 'timeline') return null
  const kind = canvasFileKind(node.path)
  return kind === 'text' ? null : kind
}

/** 节点在界面与提示词纯文本里的名字。 */
export function displayNameOf(node: CanvasNode): string {
  if (node.type !== 'file' || node.name) return node.name ?? ''
  const base = baseNameOf(node.path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/**
 * 提示词里指代第 n 个素材的写法，按类别登记，`{n}` 从 1 起、按类别分别计数（如 `图片{n}`）。
 * 由生成目录按模型给出，见 `MediaModelSpec.mention`。
 */
export type MentionStyle = Partial<Record<MediaOutput, string>>

/**
 * 把提示词里的 `@[id]` 编译成发给模型的文字。
 *
 * 参考素材（参考图、参考视频、参考音频）按它在本次输入里同类别的序号套 `style`；首帧、尾帧、没登记写法的类别、
 * 不在输入里的节点换成节点名：各家文档没有说首尾帧是否计入编号，不猜。
 */
export function compilePrompt(doc: CanvasDoc, nodeId: string, style: MentionStyle = {}): string {
  const node = doc.nodes.find((n) => n.id === nodeId)
  if (node?.type !== 'generate') return ''
  const numbered = new Map<string, string>()
  const counts: Partial<Record<MediaOutput, number>> = {}
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

/** 视频生成节点当前的输入模式：有首帧或尾帧线就是首尾帧，否则是参考。 */
export function modeOf(doc: CanvasDoc, nodeId: string): CanvasMode {
  return inputsOf(doc, nodeId).some((e) => e.role === 'first_frame' || e.role === 'last_frame')
    ? 'first_last'
    : 'reference'
}

/** 工作区相对路径，正斜杠分隔，不含 `.` / `..` 段。工作区边界由服务端再按真实路径核一次。 */
function isRelativePath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
}

const OUTPUT_NAME: Record<MediaOutput, string> = { image: '图片', video: '视频', audio: '音频' }
const GENERATE_SIZE: Record<MediaOutput, [number, number]> = {
  image: [169, 169],
  video: [300, 169],
  audio: [300, 96],
}
const FILE_SIZE: Record<MediaOutput | 'other', [number, number]> = {
  image: [225, 169],
  video: [300, 169],
  audio: [300, 96],
  other: [220, 138],
}
/**
 * 时间线的框：宽度固定；空时只有工具行、刻度与轨道（`TIMELINE_BARE`），有片段后上方多出预览区。
 * 预览区按 16:9 铺满框宽：框宽减去预览区左右各 8 的外边距（`canvas.css` 的 `.canvas-tl-view`），再按 16:9 折成高。
 * 改这两个常量或那几处样式时两边一起改，否则 16:9 的画面两侧会留边。
 */
export const TIMELINE_W = 480
const TIMELINE_BARE = 120
const TIMELINE_FULL = TIMELINE_BARE + Math.round(((TIMELINE_W - 16) * 9) / 16)

/** 时间线的框高：有片段时带预览区。 */
function timelineHeight(clips: readonly CanvasClip[]): number {
  return clips.length ? TIMELINE_FULL : TIMELINE_BARE
}

/** 片段不成立的原因，成立回 null。源文件的时长由服务端核对。 */
function clipProblem(clip: CanvasClip): string | null {
  if (!isRelativePath(clip.path)) return `不是工作区里的相对路径：${clip.path}`
  if (!isInlineVideo(clip.path)) return `只有视频能放进时间线：${clip.path}`
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

/** 没给位置时新节点放在最右边那个节点再往右这么远；`beside` 放在那个节点右侧同样远处。 */
const NEW_NODE_GAP = 100
/** `beside` 找空位时与其他节点留的间距，含节点上方的标题行。 */
const CLEARANCE = 40

/**
 * 把框换成媒体的宽高比：短边长度不变，长边按比例。横图的高、竖图的宽都是原框的短边。
 * 不要改成固定高度：竖图沿用横图的高度时宽度只剩横图的几分之一（9:16 只有 16:9 的约三分之一）。
 * 界面给空卡按所选宽高比预览时用同一个函数。
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

/** 新建生成卡的缺省框。界面给空卡选回「自动」宽高比时按它的比例还原。 */
export function blankBox(output: MediaOutput): { w: number; h: number } {
  const [w, h] = GENERATE_SIZE[output]
  return { w, h }
}

/** 生成卡的框跟当前那一版的媒体比例走；当前版没有尺寸（音频、还在远端的视频）时不动。 */
function fitCurrent(node: CanvasGenerateNode): void {
  const size = node.versions.find((v) => v.id === node.current)?.size
  if (size) Object.assign(node, fitBox(node, size))
}

class CanvasError extends Error {}

function fail(message: string): never {
  throw new CanvasError(message)
}

/**
 * 按顺序应用一批操作。整批成功才返回新文档；任何一条不成立都回 `ok: false`，原文档不动。
 *
 * `newId` 只在测试里注入。分配的 id 不会与本批开始时文档里已有的任何 id 相同。
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
    return fail('分配不到新的 id')
  }

  try {
    for (const op of ops) applyOne(next, op, refs, mint)
    resolvePromptRefs(next, refs)
    keepMentionsConnected(doc, next, mint)
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
  mint: () => string,
): void {
  const resolve = (id: string): string => {
    if (!id.startsWith('$')) return id
    return refs[id] ?? fail(`${id} 没有在这一批前面的操作里定义`)
  }
  const claim = (ref: string | undefined, id: string) => {
    if (ref === undefined) return
    if (!REF_RE.test(ref)) fail(`批内名字要以 $ 开头：${ref}`)
    if (refs[ref]) fail(`批内名字重复：${ref}`)
    refs[ref] = id
  }

  switch (op.op) {
    case 'add_file': {
      if (!isRelativePath(op.path)) fail(`不是工作区里的相对路径：${op.path}`)
      const id = mint()
      claim(op.ref, id)
      const kind = canvasMediaOf({ id, type: 'file', path: op.path, x: 0, y: 0, w: 0, h: 0 })
      const [dw, dh] = FILE_SIZE[kind ?? 'other']
      const fit = op.size ? fitBox({ w: dw, h: dh }, op.size) : { w: dw, h: dh }
      const w = op.w ?? fit.w
      const h = op.h ?? fit.h
      const spot = placeOf(doc, op, resolve, w, h)
      const node: CanvasFileNode = {
        id,
        type: 'file',
        path: op.path,
        x: op.x ?? spot?.x ?? rightEdge(doc),
        y: op.y ?? spot?.y ?? 0,
        w,
        h,
      }
      if (op.name) node.name = op.name
      doc.nodes.push(node)
      return
    }
    case 'add_generate': {
      const id = mint()
      claim(op.ref, id)
      const [dw, dh] = GENERATE_SIZE[op.output]
      const w = op.w ?? dw
      const h = op.h ?? dh
      const spot = placeOf(doc, op, resolve, w, h)
      const node: CanvasGenerateNode = {
        id,
        type: 'generate',
        output: op.output,
        name: op.name || defaultName(doc, OUTPUT_NAME[op.output]),
        x: op.x ?? spot?.x ?? rightEdge(doc),
        y: op.y ?? spot?.y ?? 0,
        w,
        h,
        prompt: op.prompt ?? '',
        params: op.params ?? {},
        versions: [],
      }
      if (op.provider !== undefined) node.provider = op.provider
      if (op.model !== undefined) node.model = op.model
      doc.nodes.push(node)
      return
    }
    case 'add_timeline': {
      const id = mint()
      claim(op.ref, id)
      const clips = structuredClone(op.clips ?? [])
      const h = timelineHeight(clips)
      const spot = placeOf(doc, op, resolve, TIMELINE_W, h)
      const node: CanvasTimelineNode = {
        id,
        type: 'timeline',
        name: op.name || defaultName(doc, TIMELINE_NAME),
        x: op.x ?? spot?.x ?? rightEdge(doc),
        y: op.y ?? spot?.y ?? 0,
        w: TIMELINE_W,
        h,
        clips,
      }
      if (op.muted) node.muted = true
      doc.nodes.push(node)
      return
    }
    case 'update': {
      const id = resolve(op.id)
      const edge = doc.edges.find((e) => e.id === id)
      if (edge) {
        const { op: _op, id: _id, role, ...rest } = op
        if (Object.keys(rest).length > 0) fail(`连线只能改用途：${Object.keys(rest).join('、')}`)
        if (role !== undefined) edge.role = role
        return
      }
      const node = doc.nodes.find((n) => n.id === id) ?? fail(`目标已不存在：${op.id}`)
      if (op.role !== undefined) fail('节点没有用途，用途在连线上')
      if (op.x !== undefined) node.x = op.x
      if (op.y !== undefined) node.y = op.y
      if (op.w !== undefined) node.w = op.w
      if (op.h !== undefined) node.h = op.h
      if (node.type === 'timeline') {
        for (const key of ['prompt', 'provider', 'model', 'params', 'current', 'path'] as const) {
          if (op[key] !== undefined) fail(`时间线没有 ${key}`)
        }
        if (op.name === null || op.name === '') fail('时间线必须有名字')
        if (op.name !== undefined) node.name = op.name
        if (op.muted === true) node.muted = true
        else if (op.muted === false) delete node.muted
        if (op.clips !== undefined) {
          node.clips = structuredClone(op.clips)
          // 有无片段决定有没有预览区；同一次操作给了 h 时以它为准。
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
          if (!isRelativePath(op.path)) fail(`不是工作区里的相对路径：${op.path}`)
          node.path = op.path
          // 换了文件就换比例；同一次操作给了 w / h 时以它们为准。
          if (op.size && op.w === undefined && op.h === undefined) {
            Object.assign(node, fitBox(node, op.size))
          }
        }
        return
      }
      if (op.path !== undefined) fail('生成节点的路径由生成结果决定，不能直接改')
      if (op.name === null || op.name === '') fail('生成节点必须有名字')
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
      // 参考 → 首尾帧：前两张图依次变首帧、尾帧，其余断开（提示词里对它们的 @ 由收尾换成纯文本）。
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

/** 最右边那个节点再往右 `NEW_NODE_GAP`；空画布从 0 开始。 */
function rightEdge(doc: CanvasDoc): number {
  return doc.nodes.length ? Math.max(...doc.nodes.map((n) => n.x + n.w)) + NEW_NODE_GAP : 0
}

/** `beside` 或 `near` 算出的位置；两者都没给回 `null`，由调用方用 `x` / `y` 或默认位置。 */
function placeOf(
  doc: CanvasDoc,
  op: { beside?: string; near?: { x: number; y: number } },
  resolve: (id: string) => string,
  w: number,
  h: number,
): { x: number; y: number } | null {
  if (op.beside !== undefined) {
    const id = resolve(op.beside)
    const source = doc.nodes.find((n) => n.id === id) ?? fail(`没有这个节点：${id}`)
    return freeSpot(doc, source.x + source.w + NEW_NODE_GAP, source.y, w, h)
  }
  if (op.near)
    return freeSpot(doc, Math.round(op.near.x - w / 2), Math.round(op.near.y - h / 2), w, h)
  return null
}

/**
 * 从 (x, y) 起找空位：与已有节点（含同一批先加的）相交就挪到相交那个节点下沿之后，直到不相交。
 * 每次下移都越过一个节点，最多移动节点数次。
 */
function freeSpot(
  doc: CanvasDoc,
  x: number,
  top: number,
  w: number,
  h: number,
): { x: number; y: number } {
  let y = top
  for (;;) {
    const hit = doc.nodes.find(
      (n) =>
        n.x < x + w + CLEARANCE &&
        n.x + n.w + CLEARANCE > x &&
        n.y < y + h + CLEARANCE &&
        n.y + n.h + CLEARANCE > y,
    )
    if (!hit) return { x, y }
    y = hit.y + hit.h + CLEARANCE
  }
}

const TIMELINE_NAME = '时间线'

/** 「视频3」「时间线2」这类默认名：同前缀里已有的最大序号加一。 */
function defaultName(doc: CanvasDoc, prefix: string): string {
  let max = 0
  for (const n of doc.nodes) {
    const m = n.name?.startsWith(prefix) ? /^\d+$/.exec(n.name.slice(prefix.length)) : null
    if (m) max = Math.max(max, Number(m[0]))
  }
  return `${prefix}${max + 1}`
}

/** 提示词里的 `@[$名字]` 换成分配到的 id。 */
function resolvePromptRefs(doc: CanvasDoc, refs: Record<string, string>): void {
  for (const n of doc.nodes) {
    if (n.type !== 'generate' || !n.prompt.includes('@[$')) continue
    n.prompt = n.prompt.replace(MENTION_RE, (whole, id: string) => {
      if (!id.startsWith('$')) return whole
      return `@[${refs[id] ?? fail(`${id} 没有在这一批里定义`)}]`
    })
  }
}

/**
 * 维持「提示词里的 @ 都有输入线」。对每个没有线的 `@[m]`：
 * - 这一批新写进提示词的：补一条线（用途见 `MENTION_ROLE`）；补不了就整批拒绝；
 * - 原来就在提示词里的（线或节点在这一批被删了）：换成节点名纯文本。
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
      if (!kind) fail(`「${displayNameOf(source)}」不能作为「${node.name}」的输入`)
      doc.edges.push({ id: mint(), from: source.id, to: node.id, role: MENTION_ROLE[kind] })
    }
  }
}

/**
 * 复制一组节点：返回在 `target` 上加出副本的一批操作。副本与原节点同设置、整体平移 `offset`；生成卡不带版本。
 *
 * 选区内部的连线照连，提示词里对选区内节点的 `@` 指向副本。选区外连进来的线：`withInputs` 为真且 `target` 里有那个节点时
 * 一并连到副本上、`@` 保留；否则不连，`@` 改成名字纯文本（与删线同一规则）。从选区连出去的线不复制。
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
      ops.push({ op: 'add_file', ref, path: n.path, ...(n.name ? { name: n.name } : {}), ...box })
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

/** 提示词里新 @ 了一个未连的节点时补的那条线的用途。 */
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
  if (target.output === 'audio') return `${to} 是语音合成，不收输入`
  if (target.output === 'image') {
    return kind === 'image' && role === 'reference' ? null : `${to} 只收参考图，${from} 连不上`
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
      if (!isRelativePath(n.path)) return `不是工作区里的相对路径：${n.path}`
      continue
    }
    if (n.type === 'timeline') {
      if (!n.name) return '时间线必须有名字'
      const bad = n.clips.map(clipProblem).find(Boolean)
      if (bad) return `「${n.name}」${bad}`
      continue
    }
    if (!n.name) return '生成节点必须有名字'
    if ((n.provider === undefined) !== (n.model === undefined)) {
      return `「${n.name}」的接口与模型要同给同不给`
    }
    for (const v of n.versions) {
      const bad = claim(v.id)
      if (bad) return bad
      if (!isRelativePath(v.path)) return `不是工作区里的相对路径：${v.path}`
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
    if (target.type !== 'generate') return `连线只能连到生成节点：「${displayNameOf(target)}」`
    if (source.id === target.id) return `「${target.name}」不能连到自己`
    if (pairs.has(`${e.from}>${e.to}`)) {
      return `「${displayNameOf(source)}」已经连着「${target.name}」`
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
      return `「${n.name}」的首尾帧不能与参考图、参考视频、参考音频同时给`
    }
    for (const m of mentionsOf(n.prompt)) {
      if (!inputs.some((e) => e.from === m))
        return `「${n.name}」的提示词引用了没有连线的节点：${m}`
    }
  }
  return null
}

/**
 * 追加一次生成的结果，多张就是多版，`current` 指向第一张，框按它的比例改。只由服务端画布服务调用：
 * 版本里的 `made` 记的是真正发出去的请求，界面与大模型的操作不能写版本。
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
 * 把一版改指到新路径（远端视频取回后由任务记录改成产物），带上产物的像素宽高。
 * 这一版是当前版时框按它的比例改。只由服务端画布服务调用。
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

/** 追加一条生成记录。节点已删掉也照记：记录的是发生过的事。只由服务端画布服务调用。 */
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
      return (MEDIA_OUTPUTS as readonly unknown[]).includes(v)
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
      return v === 'done' || v === 'failed' || v === 'pending' || v === 'cancelled'
  }
}

/** 按字段表核一个对象：多出来的键、缺了必填的键、类型不对，都算不成立。必填键以 `!` 结尾。 */
function checkFields(where: string, raw: unknown, fields: Record<string, Shape>): string | null {
  if (!isObject(raw)) return `${where} 不是对象`
  const shapes = new Map(Object.entries(fields).map(([k, s]) => [k.replace(/!$/, ''), s]))
  for (const key of Object.keys(raw)) {
    if (!shapes.has(key)) return `${where} 有不认识的字段：${key}`
  }
  for (const [key, shape] of Object.entries(fields)) {
    const name = key.replace(/!$/, '')
    if (!Object.hasOwn(raw, name)) {
      if (key.endsWith('!')) return `${where} 缺少 ${name}`
      continue
    }
    if (!matches(raw[name], shape)) return `${where} 的 ${name} 不合法`
  }
  return null
}

const BOX: Record<string, Shape> = { x: 'number', y: 'number', w: 'number', h: 'number' }

const OP_FIELDS: Record<CanvasOp['op'], Record<string, Shape>> = {
  add_file: {
    'op!': 'string',
    ref: 'string',
    'path!': 'string',
    name: 'string',
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

/** 核对界面或大模型提交的一批操作。版本不在可提交的字段里：带 `versions` 的操作一律不认。 */
export function parseCanvasOps(
  raw: unknown,
): { ok: true; ops: CanvasOp[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: '操作要是非空数组' }
  for (const [i, op] of raw.entries()) {
    const where = `第 ${i + 1} 条操作`
    if (!isObject(op) || typeof op.op !== 'string' || !Object.hasOwn(OP_FIELDS, op.op)) {
      return { ok: false, error: `${where} 的 op 不认识` }
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
  'path!': 'string',
  ...boxRequired(),
}
const GENERATE_FIELDS: Record<string, Shape> = {
  'id!': 'string',
  'type!': 'string',
  'output!': 'output',
  'name!': 'string',
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
const RUN_FIELDS: Record<string, Shape> = {
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

/** 读画布文件。结构或不变式不成立就拒绝，不做修补：手改坏的文件由人来改回。 */
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
  // 旧版音频使用 169×169 的默认框；读取时统一升级布局，自定义尺寸和其他媒体保持原样。
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
  if (doc.version !== CANVAS_SCHEMA_VERSION) return `不认识的画布版本：${doc.version}`
  for (const [i, n] of doc.nodes.entries()) {
    const where = `第 ${i + 1} 个节点`
    const type = isObject(n) ? n.type : undefined
    if (type !== 'file' && type !== 'generate' && type !== 'timeline')
      return `${where} 的 type 不认识`
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

/** 写盘的文本。键按固定顺序排，同一份文档无论经哪条路径写出，字节都相同。 */
export function serializeCanvas(doc: CanvasDoc): string {
  const nodes = doc.nodes.map((n) =>
    n.type === 'file'
      ? {
          id: n.id,
          type: n.type,
          ...(n.name ? { name: n.name } : {}),
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
