/**
 * 生成：经生成端口调用已配置的生成模型，产物写进工作区。
 *
 * `generateMedia` / `resumeMedia` 是唯一的执行路径：读输入、调端口、记远端任务、落盘、收尾都在这里，
 * 与 `read_file` / `write_file` 走同一条路径边界与可写判定。三个生成工具与服务端画布服务都调它们，
 * 工具只负责解析参数和把结果写成给大模型读的回执。选模型、推操作、校验参数、调接口在端口实现里。
 *
 * 结果只回产物的工作区路径，不带字节：用户点路径在右侧预览里看，大模型要看图就自己 `read_file`。
 */

import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import type { MediaCall, MediaCallResult, MediaPort, ToolOutcome, ToolSpec } from '@qywork/agent'
import type { MediaFile, MediaInput } from '@qywork/ai'
import {
  isInlineAudio,
  isInlineImage,
  isInlineVideo,
  type MediaInputRole,
  type MediaOutput,
  type MediaSpend,
  mimeOf,
} from '@qywork/core'
import {
  displayPath,
  type RootsInput,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
import { renameWithRetry } from './rename.ts'

/** 没给输出路径时写到这个工作区目录。 */
const DEFAULT_DIR = 'generated'

const EXTENSION: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.opus',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/pcm': '.pcm',
}

/** 扩展名到格式，`EXTENSION` 的反查，外加同一格式的别名。 */
const MIME_OF_EXTENSION: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXTENSION).map(([mime, ext]) => [ext, mime])),
  '.jpeg': 'image/jpeg',
}

/**
 * 产物实际要落盘的路径。没写扩展名就按实际格式补上；写了一个与实际格式不符的已知扩展名
 * （如要 `.mp3` 而接口回的是 WAV）就换成实际格式的，否则文件名与内容对不上，播放器按错的格式解析。
 * 不认识的扩展名原样保留。
 */
function landingPath(target: string, mime: string): string {
  const actual = EXTENSION[mime]
  const { ext } = parse(target)
  if (!actual) return target
  if (!ext) return `${target}${actual}`
  const declared = MIME_OF_EXTENSION[ext.toLowerCase()]
  return declared && declared !== mime ? `${target.slice(0, -ext.length)}${actual}` : target
}

/** 远端任务记录的后缀。记录与产物同目录，文件树里看得见。 */
export const TASK_SUFFIX = '.task.json'

/** 默认文件名的时间戳：`YYYYMMDD-HHmmss`，本地时间。 */
function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  )
}

async function occupied(abs: string): Promise<boolean> {
  return lstat(abs).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false
      throw err
    },
  )
}

function workspaceOf(roots: RootsInput): string {
  return typeof roots === 'string' ? roots : roots.workspaceRoot
}

/** 落进工作区的一个产物。`path` 是工作区相对路径（正斜杠）。 */
export interface GeneratedFile {
  path: string
  mime: string
  bytes: number
}

/**
 * 产物落在哪：`target` 按实际格式定扩展名（`landingPath`）后，从第 `first` 个编号起找第一个没被占的位置
 * （第 1 个不加编号，之后加 `-2`、`-3`），回绝对路径。已存在的文件不覆盖。
 */
export async function freeLandingPath(
  roots: RootsInput,
  target: string,
  mime: string,
  first = 1,
): Promise<string> {
  const base = landingPath(target, mime)
  const { dir, name, ext } = parse(base)
  for (let suffix = first; ; suffix++) {
    const candidate = suffix === 1 ? base : join(dir, `${name}-${suffix}${ext}`)
    const abs = await resolveWritablePath(roots, candidate, { followFinalSymlink: false })
    if (!(await occupied(abs))) return abs
  }
}

/**
 * 把产物写进工作区。先写 `.part` 再改名：半截文件不会出现在工作区里，写失败时删掉 `.part`。
 *
 * 多张时从第二张起加 `-2`、`-3`，撞名继续往后加（`freeLandingPath`）。
 */
export async function landFiles(
  roots: RootsInput,
  files: MediaFile[],
  target: string,
): Promise<GeneratedFile[]> {
  const landed: GeneratedFile[] = []
  for (const [index, file] of files.entries()) {
    const abs = await freeLandingPath(roots, target, file.mime, index + 1)
    await mkdir(dirname(abs), { recursive: true })
    const part = `${abs}.part`
    try {
      await writeFile(part, file.bytes, { flag: 'wx' })
      await renameWithRetry(part, abs)
    } catch (err) {
      await rm(part, { force: true })
      throw err
    }
    landed.push({
      path: displayPath(workspaceOf(roots), abs),
      mime: file.mime,
      bytes: file.bytes.length,
    })
  }
  return landed
}

/**
 * 本进程里已被占用、产物还没落盘的默认输出位置（绝对路径）。
 * 默认名精确到秒，同一秒里的两次生成（画布上连点两张卡）靠它错开，否则会共用一份任务记录。
 */
const reserved = new Set<string>()

/** 占一个默认输出位置：`generated/<时间>`，被占或已有同名任务记录就往后加 `-2`、`-3`。 */
async function reserveDefault(roots: RootsInput): Promise<{ target: string; release(): void }> {
  const base = join(DEFAULT_DIR, stamp())
  for (let n = 1; ; n++) {
    const target = n === 1 ? base : `${base}-${n}`
    const abs = await resolveWritablePath(roots, target, { followFinalSymlink: false })
    if (reserved.has(abs)) continue
    reserved.add(abs)
    if (await occupied(`${abs}${TASK_SUFFIX}`)) {
      reserved.delete(abs)
      continue
    }
    return { target, release: () => reserved.delete(abs) }
  }
}

/** 远端视频任务的本地记录：停止、超时、进程退出之后，靠它接续取回、不重新提交。 */
interface TaskRecord {
  provider: string
  model: string
  taskId: string
  /** 产物要写到的工作区路径（可以没有扩展名，落盘时补上）。 */
  output: string
  submittedAt: string
}

/** 写任务记录，不覆盖已有的记录（那是另一个还没取回的任务）：撞名就往后加 `-2`。返回写到的绝对路径。 */
async function writeRecord(roots: RootsInput, target: string, record: TaskRecord): Promise<string> {
  const text = `${JSON.stringify(record, null, 2)}\n`
  for (let n = 1; ; n++) {
    const abs = await resolveWritablePath(
      roots,
      `${n === 1 ? target : `${target}-${n}`}${TASK_SUFFIX}`,
      { followFinalSymlink: false },
    )
    await mkdir(dirname(abs), { recursive: true })
    try {
      await writeFile(abs, text, { flag: 'wx' })
      return abs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/** 一次生成。输入只给路径，读字节与类型检查在 `generateMedia` 里做。 */
export interface GenerateRequest {
  roots: RootsInput
  media: MediaPort
  signal: AbortSignal
  type: MediaOutput
  prompt: string
  inputs: { role: MediaInputRole; path: string }[]
  params: Record<string, unknown>
  pick?: { provider: string; model: string }
  /** 输出路径；已存在就在调接口之前拒绝。不给时写到 `generated/<时间>`。 */
  output?: string
  /** 视频任务号到手、任务记录写好之后回调。`record` 是记录的工作区相对路径。 */
  onTask?: (task: {
    record: string
    taskId: string
    provider: string
    model: string
  }) => void | Promise<void>
  onStatus?: (status: string) => void
  /** 拿到结果时回报这次的花费。 */
  onSpend?: (spend: MediaSpend) => void
}

/**
 * 生成的结果。失败时 `executed: false` 表示在调接口之前就退回了（没有花钱）；
 * `record` 表示远端任务还在、任务记录留着，可以按它取回。
 */
export type GenerateOutcome =
  | { ok: true; provider: string; model: string; files: GeneratedFile[] }
  | { ok: false; message: string; executed: boolean; errorKind?: string; record?: string }

function refused(message: string, errorKind: string): GenerateOutcome {
  return { ok: false, message, executed: false, errorKind }
}

/** 读输入文件。路径走工作区边界；类型不对在调接口之前就退回。 */
async function readInputs(
  roots: RootsInput,
  inputs: GenerateRequest['inputs'],
): Promise<MediaInput[] | GenerateOutcome> {
  const read: MediaInput[] = []
  for (const { role, path } of inputs) {
    const abs = await resolveInWorkspace(roots, path, { mustExist: true })
    const ok =
      role === 'video'
        ? isInlineVideo(abs)
        : role === 'audio'
          ? isInlineAudio(abs)
          : isInlineImage(abs)
    if (!ok) {
      const want =
        role === 'video'
          ? 'mp4 / mov / webm / mkv 视频'
          : role === 'audio'
            ? 'wav / mp3 音频'
            : 'png / jpg / gif / webp 图片'
      return refused(`${path} 不是 ${want}`, 'invalid_tool_arguments')
    }
    read.push({ role, bytes: new Uint8Array(await readFile(abs)), mime: mimeOf(abs), path: abs })
  }
  return read
}

/** 生成一次并落盘。视频在任务号到手时写任务记录，成功后删掉，远端终态失败也删掉。 */
export async function generateMedia(req: GenerateRequest): Promise<GenerateOutcome> {
  const inputs = await readInputs(req.roots, req.inputs)
  if (!Array.isArray(inputs)) return inputs
  if (req.output !== undefined) {
    const abs = await resolveWritablePath(req.roots, req.output, { followFinalSymlink: false })
    // 生成按次计费：写不进去的调用在花钱之前就要挡掉。
    if (await occupied(abs)) {
      return refused(`${req.output} 已存在，不会覆盖。换一个输出路径，或不填 output`, 'file_exists')
    }
  }
  const slot =
    req.output !== undefined
      ? { target: req.output, release() {} }
      : await reserveDefault(req.roots)
  try {
    let recordPath: string | null = null
    const call: MediaCall = {
      type: req.type,
      prompt: req.prompt,
      inputs,
      params: req.params,
      ...(req.pick ?? {}),
      ...(req.onSpend ? { onSpend: req.onSpend } : {}),
    }
    if (req.type === 'video') {
      call.onTask = async ({ taskId, provider, model }) => {
        recordPath = await writeRecord(req.roots, slot.target, {
          provider,
          model,
          taskId,
          output: slot.target,
          submittedAt: new Date().toISOString(),
        })
        await req.onTask?.({
          record: displayPath(workspaceOf(req.roots), recordPath),
          taskId,
          provider,
          model,
        })
      }
      if (req.onStatus) call.onStatus = req.onStatus
    }
    const result = await req.media.generate(call, req.signal)
    return await settle(req.roots, result, slot.target, recordPath)
  } finally {
    slot.release()
  }
}

/** 按任务记录取回：只查询与下载，不再提交、不重复扣费。 */
export async function resumeMedia(req: {
  roots: RootsInput
  media: MediaPort
  signal: AbortSignal
  /** 任务记录的路径。 */
  record: string
  onStatus?: (status: string) => void
  onSpend?: (spend: MediaSpend) => void
}): Promise<GenerateOutcome> {
  const recordPath = await resolveWritablePath(req.roots, req.record, { mustExist: true })
  let record: TaskRecord
  try {
    record = JSON.parse(await readFile(recordPath, 'utf8')) as TaskRecord
  } catch {
    return refused(`${req.record} 不是任务记录`, 'invalid_tool_arguments')
  }
  if (!record.taskId || !record.provider || !record.model || !record.output) {
    return refused(`${req.record} 缺少任务号、接口、模型或输出路径`, 'invalid_tool_arguments')
  }
  const call: MediaCall = {
    type: 'video',
    prompt: '',
    inputs: [],
    params: {},
    provider: record.provider,
    model: record.model,
    resumeTaskId: record.taskId,
    ...(req.onSpend ? { onSpend: req.onSpend } : {}),
  }
  if (req.onStatus) call.onStatus = req.onStatus
  const result = await req.media.generate(call, req.signal)
  return settle(req.roots, result, record.output, recordPath)
}

/**
 * 收尾：成功就落盘并删掉任务记录；远端还在（`pendingTaskId`）就留着记录；终态失败删掉记录。
 */
async function settle(
  roots: RootsInput,
  result: MediaCallResult,
  target: string,
  recordPath: string | null,
): Promise<GenerateOutcome> {
  if (!result.ok) {
    if (result.pendingTaskId && recordPath) {
      return {
        ok: false,
        executed: true,
        message: result.message,
        record: displayPath(workspaceOf(roots), recordPath),
      }
    }
    if (recordPath) await rm(recordPath, { force: true })
    return { ok: false, executed: true, message: result.message }
  }
  const files = await landFiles(roots, result.files, target)
  if (recordPath) await rm(recordPath, { force: true })
  return { ok: true, provider: result.provider, model: result.model, files }
}

// ── 工具 ──

/** 参数对象以 JSON 字符串传入：严格模式的工具 schema 表达不了「字段由模型决定」的开放对象。 */
function parseParams(raw: unknown): Record<string, unknown> | string {
  if (raw === undefined || raw === null || raw === '') return {}
  try {
    const value = JSON.parse(String(raw)) as unknown
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {}
  return 'params_json 必须是一个 JSON 对象，例如 {"size":"1024x1536"}'
}

function failure(message: string, errorKind?: string): ToolOutcome {
  return { status: 'failure', executed: false, message, ...(errorKind ? { errorKind } : {}) }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** 两个生成工具共有的参数：提示词、参数表、模型点名、输出路径。 */
function commonArgs(args: Record<string, unknown>):
  | {
      prompt: string
      params: Record<string, unknown>
      pick: { provider: string; model: string } | undefined
      output: string | undefined
    }
  | ToolOutcome {
  const prompt = text(args.prompt)
  if (!prompt) return failure('prompt 不能为空', 'invalid_tool_arguments')
  const params = parseParams(args.params_json)
  if (typeof params === 'string') return failure(params, 'invalid_tool_arguments')
  const provider = text(args.provider)
  const model = text(args.model)
  if ((provider === undefined) !== (model === undefined)) {
    return failure('provider 与 model 要一起给，或都不给', 'invalid_tool_arguments')
  }
  return {
    prompt,
    params,
    pick: provider && model ? { provider, model } : undefined,
    output: text(args.output),
  }
}

/** 路径参数：单个字符串或字符串数组，空值即没给。 */
function pathList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  return raw === undefined || raw === null || raw === '' ? [] : [String(raw)]
}

/** 把生成结果写成给大模型读的回执。 */
function receipt(outcome: GenerateOutcome, noun: (count: number) => string): ToolOutcome {
  if (!outcome.ok) {
    return {
      status: 'failure',
      executed: outcome.executed,
      message: outcome.record
        ? `${outcome.message}\n任务记录在 ${outcome.record}，用 generate_video 的 resume 传这个路径取回，不会重新提交。`
        : outcome.message,
      ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
    }
  }
  return {
    status: 'success',
    message: `已生成${noun(outcome.files.length)}（${outcome.provider} / ${outcome.model}）：${outcome.files.map((f) => f.path).join('、')}`,
    data: {
      provider: outcome.provider,
      model: outcome.model,
      files: outcome.files.map((f) => ({ path: f.path, mime: f.mime, bytes: f.bytes })),
    },
    fileChanges: outcome.files.map((f) => ({ path: f.path, changeType: 'created' as const })),
  }
}

/** 三个生成工具共用的参数说明。 */
const PARAMS_NOTE =
  'params_json 仅使用本轮「可用的生成模型」中该模型列出的参数，取值依据用户要求或自行判断，无需设置的参数省略。' +
  'provider 与 model 须取自该清单的同一行；两者均省略时使用默认模型。'

/**
 * 生成文件在会话中的唯一展示入口：回复里的路径链接，点击由正文链接的处理交给右侧文件预览。
 * 不写明时模型会以 Markdown 图片嵌入，相对地址在会话里是一张损坏的图，或同一路径写出多次。
 */
const DISPLAY_NOTE =
  '回复中以 Markdown 链接写出生成文件的工作区路径，链接文字与地址均为该路径，例如 [generated/cover.png](generated/cover.png)，' +
  '用户点击链接即可在右侧面板预览；每个文件只引用一次，不得以 Markdown 图片形式嵌入。'

export const generateImageTool: ToolSpec = {
  name: 'generate_image',
  description:
    '调用已配置的图像生成模型执行文生图或图像编辑，生成的文件写入工作区，结果仅返回文件路径。' +
    '未提供 images 时按提示词生成；提供 images（工作区内的图片路径）时以这些图片为基础进行编辑或参考生成，编辑的部位与方式在 prompt 中说明。' +
    PARAMS_NOTE +
    '生成按次计费，不得为试探效果重复调用。' +
    DISPLAY_NOTE,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '生成内容的描述；编辑时说明修改的部位与方式' },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图或待编辑图片的工作区路径',
      },
      params_json: {
        type: 'string',
        description: '该模型的参数，JSON 对象，字段与取值见本轮「可用的生成模型」',
      },
      provider: { type: 'string', description: '接口名' },
      model: { type: 'string', description: '模型 id' },
      output: {
        type: 'string',
        description: `输出文件的工作区路径；生成多张时自第二张起追加 -2、-3 后缀；省略时写入 ${DEFAULT_DIR}/`,
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '图片',
  category: 'external',
  facet: '生成',
  summary: '用图像生成模型出图或改图',
  targetExtractor: (a) => (typeof a.output === 'string' ? a.output : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    if (!ctx.media) return failure('本次执行没有生成通道')
    const common = commonArgs(args)
    if ('status' in common) return common
    const outcome = await generateMedia({
      roots: rootsOf(ctx),
      media: ctx.media,
      signal: ctx.signal,
      type: 'image',
      prompt: common.prompt,
      inputs: pathList(args.images).map((path) => ({ role: 'reference' as const, path })),
      params: common.params,
      ...(common.pick ? { pick: common.pick } : {}),
      ...(common.output ? { output: common.output } : {}),
    })
    return receipt(outcome, (n) => ` ${n} 张`)
  },
}

export const generateVideoTool: ToolSpec = {
  name: 'generate_video',
  description:
    '调用已配置的视频生成模型生成视频，生成的文件写入工作区，结果仅返回文件路径。远端任务需排队处理，通常耗时数分钟。' +
    '任务类型由提供的输入决定：均未提供时为文生视频；提供 first_frame 为首帧生视频；同时提供 last_frame 为首尾帧生视频；' +
    '提供 images 为参考图生视频；提供 videos 表示以参考视频为输入，编辑、延长或参考由该模型参数表中的对应字段指定，无对应字段时在 prompt 中说明。' +
    '提供 audios 为参考音频，须与 images 或 videos 同时提供。' +
    'first_frame、last_frame 不能与 images、videos、audios 同时提供。' +
    PARAMS_NOTE +
    '提交后在输出位置旁写入 .task.json 任务记录；等待中断或超时后，以 resume 传入该记录路径取回结果，不会重新提交，也不会重复计费。' +
    DISPLAY_NOTE,
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '视频内容的描述；编辑或延长时说明修改内容或延长方向' },
      first_frame: { type: 'string', description: '首帧图片的工作区路径' },
      last_frame: {
        type: 'string',
        description: '尾帧图片的工作区路径，须与 first_frame 同时提供',
      },
      images: { type: 'array', items: { type: 'string' }, description: '参考图的工作区路径' },
      videos: { type: 'array', items: { type: 'string' }, description: '参考视频的工作区路径' },
      audios: {
        type: 'array',
        items: { type: 'string' },
        description: '参考音频（wav / mp3）的工作区路径',
      },
      params_json: {
        type: 'string',
        description: '该模型的参数，JSON 对象，字段与取值见本轮「可用的生成模型」',
      },
      provider: { type: 'string', description: '接口名' },
      model: { type: 'string', description: '模型 id' },
      output: {
        type: 'string',
        description: `输出文件的工作区路径；省略时写入 ${DEFAULT_DIR}/`,
      },
      resume: {
        type: 'string',
        description: `待取回任务的记录文件路径（${TASK_SUFFIX}）；提供该参数时无需提供其他参数`,
      },
    },
    required: [],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '视频',
  category: 'external',
  facet: '生成',
  summary: '用视频生成模型生成、编辑或延长视频',
  targetExtractor: (a) => (typeof a.output === 'string' ? a.output : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    if (!ctx.media) return failure('本次执行没有生成通道')
    const onStatus = (status: string) => ctx.emit('progress', `${status}\n`)
    const resume = text(args.resume)
    if (resume) {
      const outcome = await resumeMedia({
        roots: rootsOf(ctx),
        media: ctx.media,
        signal: ctx.signal,
        record: resume,
        onStatus,
      })
      return receipt(outcome, () => '视频')
    }

    const common = commonArgs(args)
    if ('status' in common) return common
    const inputs = (
      [
        ['first_frame', 'first_frame'],
        ['last_frame', 'last_frame'],
        ['images', 'reference'],
        ['videos', 'video'],
        ['audios', 'audio'],
      ] as const
    ).flatMap(([key, role]) => pathList(args[key]).map((path) => ({ role, path })))
    const outcome = await generateMedia({
      roots: rootsOf(ctx),
      media: ctx.media,
      signal: ctx.signal,
      type: 'video',
      prompt: common.prompt,
      inputs,
      params: common.params,
      ...(common.pick ? { pick: common.pick } : {}),
      ...(common.output ? { output: common.output } : {}),
      onTask: ({ taskId, record }) =>
        ctx.emit('progress', `已提交远端任务 ${taskId}，记录在 ${record}\n`),
      onStatus,
    })
    return receipt(outcome, () => '视频')
  },
}

export const generateAudioTool: ToolSpec = {
  name: 'generate_audio',
  description:
    '调用已配置的语音合成模型将文本合成为音频，生成的文件写入工作区，结果仅返回文件路径。' +
    '音色、语种、语气等在 params_json 中设置。' +
    PARAMS_NOTE +
    DISPLAY_NOTE,
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '待合成的文本' },
      params_json: {
        type: 'string',
        description: '该模型的参数，JSON 对象，字段与取值见本轮「可用的生成模型」',
      },
      provider: { type: 'string', description: '接口名' },
      model: { type: 'string', description: '模型 id' },
      output: {
        type: 'string',
        description: `输出文件的工作区路径；省略时写入 ${DEFAULT_DIR}/`,
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '音频',
  category: 'external',
  facet: '生成',
  summary: '用语音合成模型把文字读成音频',
  targetExtractor: (a) => (typeof a.output === 'string' ? a.output : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    if (!ctx.media) return failure('本次执行没有生成通道')
    const common = commonArgs({ ...args, prompt: args.text })
    if ('status' in common) return common
    const outcome = await generateMedia({
      roots: rootsOf(ctx),
      media: ctx.media,
      signal: ctx.signal,
      type: 'audio',
      prompt: common.prompt,
      inputs: [],
      params: common.params,
      ...(common.pick ? { pick: common.pick } : {}),
      ...(common.output ? { output: common.output } : {}),
    })
    return receipt(outcome, () => '音频')
  },
}

/** 每个生成类别对应的工具。注册、本轮快照与会话里「这一类有没有工具」都查这一张表。 */
export const MEDIA_TOOLS: Record<MediaOutput, ToolSpec> = {
  image: generateImageTool,
  video: generateVideoTool,
  audio: generateAudioTool,
}
