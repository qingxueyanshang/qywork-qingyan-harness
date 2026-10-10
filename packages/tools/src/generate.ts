/**
 * 生成：经生成端口调用已配置的生成模型（画布 art 卡为对话模型），产物写入工作区。
 *
 * `generateMedia` / `resumeMedia` 是唯一的执行路径：读取输入、调用端口、记录远端任务、落盘与收尾均在此完成，
 * 与 `read_file` / `write_file` 使用同一路径边界与可写判定。生成工具、取回工具与服务端画布服务均调用它们，
 * 工具只负责解析参数并把结果写成供模型读取的回执。选择模型、推断操作、校验参数与调用接口由端口实现负责。
 *
 * 结果只返回产物的工作区路径，不含字节：用户点击路径在右侧预览中查看，模型需要查看图片时自行调用 `read_file`。
 */

import { lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import type { MediaCall, MediaCallResult, MediaPort, ToolOutcome, ToolSpec } from '@qywork/agent'
import { isImageResult, type MediaFile, type MediaImageResult, type MediaInput } from '@qywork/ai'
import {
  type GenerateOutput,
  isInlineAudio,
  isInlineImage,
  isInlineVideo,
  type MediaDiagnostic,
  type MediaInputRole,
  type MediaOutput,
  type MediaSpend,
  mimeOf,
} from '@qywork/core'
import { imageSizeOf } from './image.ts'
import {
  displayPath,
  type RootsInput,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
import { renameWithRetry } from './rename.ts'

/** 未提供输出路径时写入该工作区目录。 */
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
  'text/html': '.html',
}

/** 扩展名到格式的映射：`EXTENSION` 的反向映射，另含同一格式的别名。 */
const MIME_OF_EXTENSION: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXTENSION).map(([mime, ext]) => [ext, mime])),
  '.jpeg': 'image/jpeg',
}

/**
 * 产物实际落盘的路径。未写扩展名时按实际格式补全；写了与实际格式不符的已知扩展名
 * （如请求 `.mp3` 而接口返回 WAV）时改为实际格式的扩展名，否则文件名与内容不一致，播放器按错误的格式解析。
 * 无法识别的扩展名原样保留。
 */
function landingPath(target: string, mime: string): string {
  const actual = EXTENSION[mime]
  const { ext } = parse(target)
  if (!actual) return target
  if (!ext) return `${target}${actual}`
  const declared = MIME_OF_EXTENSION[ext.toLowerCase()]
  return declared && declared !== mime ? `${target.slice(0, -ext.length)}${actual}` : target
}

/** 远端任务记录的后缀。记录与产物位于同一目录，在文件树中可见。 */
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

/** 写入工作区的产物。`path` 是工作区相对路径（正斜杠）。 */
export interface GeneratedFile {
  path: string
  mime: string
  bytes: number
}

/**
 * 产物的写入位置：`target` 按实际格式确定扩展名（`landingPath`）后，从第 `first` 个编号起查找第一个未被占用的位置
 * （第 1 个不加编号，之后加 `-2`、`-3`），返回绝对路径。已存在的文件不覆盖。
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
 * 把产物写入工作区。先写入 `.part` 再重命名：不完整的文件不会出现在工作区中，写入失败时删除 `.part`。
 *
 * 多张时自第二张起追加 `-2`、`-3`，重名时序号继续递增（`freeLandingPath`）。
 */
export async function landFiles(
  roots: RootsInput,
  files: MediaFile[],
  target: string,
): Promise<GeneratedFile[]> {
  const landed: GeneratedFile[] = []
  for (const [index, file] of files.entries()) {
    for (let suffix = index + 1; ; suffix++) {
      const abs = await freeLandingPath(roots, target, file.mime, suffix)
      await mkdir(dirname(abs), { recursive: true })
      const part = `${abs}.part`
      // 查到空名不代表占用成功。只有独占打开成功后才能写入或清理这个临时文件。
      const handle = await open(part, 'wx').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'EEXIST') return null
        throw err
      })
      if (!handle) continue
      let renamed = false
      try {
        try {
          // 另一任务可能在查名与占用之间完成保存，此时继续选名，不能覆盖它的结果。
          if (await occupied(abs)) continue
          await handle.writeFile(file.bytes)
        } finally {
          await handle.close()
        }
        await renameWithRetry(part, abs)
        renamed = true
        landed.push({
          path: displayPath(workspaceOf(roots), abs),
          mime: file.mime,
          bytes: file.bytes.length,
        })
        break
      } finally {
        if (!renamed) await rm(part, { force: true })
      }
    }
  }
  return landed
}

/**
 * 本进程中已被占用、产物尚未落盘的默认输出位置（绝对路径）。
 * 默认名称精确到秒，同一秒内的两次生成（如在画布上连续点击两张卡片）依靠它区分，否则会共用同一份任务记录。
 */
const reserved = new Set<string>()

/** 占用一个默认输出位置：`generated/<时间>`；已被占用或已有同名任务记录时依次追加 `-2`、`-3`。 */
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

/** 生成任务与已返回图片的恢复记录。恢复不重新提交生成。 */
interface TaskRecord {
  provider: string
  model: string
  taskId?: string
  imageResult?: MediaImageResult
  params?: Record<string, unknown>
  /** 产物的目标工作区路径（可以不含扩展名，落盘时补全）。 */
  output: string
  submittedAt: string
}

/** 写入任务记录，不覆盖已有记录（已有记录属于另一个尚未取回的任务）：重名时追加 `-2` 并依次递增。返回写入的绝对路径。 */
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

/** 一次生成请求。输入只提供路径，读取字节与类型检查由 `generateMedia` 完成。 */
export interface GenerateRequest {
  roots: RootsInput
  media: MediaPort
  signal: AbortSignal
  type: GenerateOutput
  prompt: string
  inputs: { role: MediaInputRole; path: string }[]
  params: Record<string, unknown>
  pick?: { provider: string; model: string }
  /** 输出路径；已存在时在调用接口之前拒绝。未提供时写入 `generated/<时间>`。 */
  output?: string
  /** 写入恢复记录后回调。图片记录没有远端任务号。 */
  onTask?: (task: {
    record: string
    taskId?: string
    provider: string
    model: string
  }) => void | Promise<void>
  onStatus?: (status: string) => void
  /** 取得结果时回报本次的花费。 */
  onSpend?: (spend: MediaSpend) => void
}

/**
 * 生成的结果。失败时 `executed: false` 表示在调用接口之前已拒绝（未产生费用）；
 * `record` 表示远端任务仍存在且任务记录已保留，可按它取回。
 */
export type GenerateOutcome =
  | { ok: true; provider: string; model: string; files: GeneratedFile[]; warning?: string }
  | {
      ok: false
      message: string
      executed: boolean
      errorKind?: string
      record?: string
      diagnostic?: MediaDiagnostic
    }

function refused(message: string, errorKind: string): GenerateOutcome {
  return { ok: false, message, executed: false, errorKind }
}

const HTML_RE = /\.html?$/i

/**
 * 读取输入文件。路径经过工作区边界检查；类型不符时在调用接口之前拒绝。
 * `art` 的参考输入还可以是 HTML：即要在其上修改的当前页面。
 */
async function readInputs(
  roots: RootsInput,
  type: GenerateOutput,
  inputs: GenerateRequest['inputs'],
): Promise<MediaInput[] | GenerateOutcome> {
  const read: MediaInput[] = []
  for (const { role, path } of inputs) {
    const abs = await resolveInWorkspace(roots, path, { mustExist: true })
    const page = type === 'art' && role === 'reference' && HTML_RE.test(abs)
    const ok =
      role === 'video'
        ? isInlineVideo(abs)
        : role === 'audio'
          ? isInlineAudio(abs)
          : isInlineImage(abs) || page
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

/** 执行一次生成并落盘。取得任务号或图片来源时保存恢复记录。 */
export async function generateMedia(req: GenerateRequest): Promise<GenerateOutcome> {
  const inputs = await readInputs(req.roots, req.type, req.inputs)
  if (!Array.isArray(inputs)) return inputs
  if (req.output !== undefined) {
    const abs = await resolveWritablePath(req.roots, req.output, { followFinalSymlink: false })
    // 生成按次计费：无法写入的调用必须在产生费用之前拒绝。
    if (await occupied(abs)) {
      return refused(`${req.output} 已存在，不会覆盖。更换输出路径，或省略 output`, 'file_exists')
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
    if (req.type === 'image') {
      call.onImageResult = async (result, provider, model) => {
        recordPath = await writeRecord(req.roots, slot.target, {
          provider,
          model,
          imageResult: result,
          params: req.params,
          output: slot.target,
          submittedAt: new Date().toISOString(),
        })
        await req.onTask?.({
          record: displayPath(workspaceOf(req.roots), recordPath),
          provider,
          model,
        })
      }
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
    return await settle(
      req.roots,
      result,
      slot.target,
      recordPath,
      req.type === 'image' ? req.params : undefined,
    )
  } finally {
    slot.release()
  }
}

/** 按任务记录取回：只查询与下载，不重新提交、不重复扣费。 */
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
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.provider !== 'string' ||
    !record.provider ||
    typeof record.model !== 'string' ||
    !record.model ||
    typeof record.output !== 'string' ||
    !record.output ||
    (record.imageResult !== undefined
      ? !isImageResult(record.imageResult)
      : typeof record.taskId !== 'string' || !record.taskId)
  ) {
    return refused(`${req.record} 缺少任务号、接口、模型或输出路径`, 'invalid_tool_arguments')
  }
  const call: MediaCall = {
    type: record.imageResult ? 'image' : 'video',
    prompt: '',
    inputs: [],
    params: {},
    provider: record.provider,
    model: record.model,
    ...(record.imageResult
      ? { resumeImageResult: record.imageResult }
      : { resumeTaskId: record.taskId! }),
    ...(req.onSpend ? { onSpend: req.onSpend } : {}),
  }
  if (req.onStatus) call.onStatus = req.onStatus
  const result = await req.media.generate(call, req.signal)
  return settle(req.roots, result, record.output, recordPath, record.params)
}

/**
 * 收尾：成功时落盘并删除任务记录；远端任务仍存在（`pendingTaskId`）时保留记录；终态失败时删除记录。
 */
async function settle(
  roots: RootsInput,
  result: MediaCallResult,
  target: string,
  recordPath: string | null,
  imageParams?: Record<string, unknown>,
): Promise<GenerateOutcome> {
  if (!result.ok) {
    if ((result.pendingTaskId || result.recoverable || result.executed === false) && recordPath) {
      return {
        ok: false,
        executed: result.executed ?? true,
        message: result.message,
        record: displayPath(workspaceOf(roots), recordPath),
        ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      }
    }
    if (recordPath) await rm(recordPath, { force: true })
    return {
      ok: false,
      executed: result.executed ?? true,
      message: result.message,
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
    }
  }
  const files = await landFiles(roots, result.files, target)
  if (recordPath) await rm(recordPath, { force: true })
  const warning = [imageResultWarning(result.files, imageParams), result.warning]
    .filter(Boolean)
    .join('；')
  return {
    ok: true,
    provider: result.provider,
    model: result.model,
    files,
    ...(warning ? { warning } : {}),
  }
}

/** 按实际产物核对张数与明确指定的像素尺寸；接口少返回图片或降低分辨率时不视为完整成功。 */
function imageResultWarning(
  files: MediaFile[],
  params: Record<string, unknown> | undefined,
): string {
  if (!params) return ''
  const images = files.filter((f) => f.mime.startsWith('image/'))
  const warnings: string[] = []
  const requested = params.n
  if (typeof requested === 'number' && Number.isInteger(requested) && requested > images.length) {
    warnings.push(`请求 ${requested} 张，实际返回 ${images.length} 张`)
  }
  // auto、2K 等由模型决定具体边长的取值不做精确尺寸比较。
  const size = typeof params.size === 'string' ? /^(\d+)[x*](\d+)$/.exec(params.size) : null
  if (size) {
    const width = Number(size[1])
    const height = Number(size[2])
    const different = new Set<string>()
    for (const image of images) {
      const actual = imageSizeOf(image.bytes)
      if (
        actual &&
        actual.width > 0 &&
        actual.height > 0 &&
        (actual.width !== width || actual.height !== height)
      ) {
        different.add(`${actual.width}×${actual.height}`)
      }
    }
    if (different.size)
      warnings.push(`请求尺寸 ${width}×${height}，实际返回 ${[...different].join('、')}`)
  }
  return warnings.join('；')
}

// ── 工具 ──

/** 参数对象以 JSON 字符串传入：严格模式的工具 schema 无法表达字段由模型决定的开放对象。 */
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

/** 三个生成工具共有的参数：提示词、参数表、指定模型、输出路径。 */
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
    return failure('provider 与 model 须同时提供或同时省略', 'invalid_tool_arguments')
  }
  return {
    prompt,
    params,
    pick: provider && model ? { provider, model } : undefined,
    output: text(args.output),
  }
}

/** 路径参数：单个字符串或字符串数组，空值视为未提供。 */
function pathList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  return raw === undefined || raw === null || raw === '' ? [] : [String(raw)]
}

/** 把生成结果写成供模型读取的回执。 */
function receipt(outcome: GenerateOutcome, noun: (count: number) => string): ToolOutcome {
  if (!outcome.ok) {
    return {
      status: 'failure',
      executed: outcome.executed,
      message: outcome.record
        ? `${outcome.message}\n任务记录位于 ${outcome.record}，用 retrieve_media 的 path 传入该路径取回，不会重新提交。`
        : outcome.message,
      ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
      data: {
        ...(outcome.record ? { record: outcome.record } : {}),
        ...(outcome.diagnostic ? { diagnostic: outcome.diagnostic } : {}),
      },
      ...(outcome.diagnostic ? { errorKind: `media_${outcome.diagnostic.kind}` } : {}),
    }
  }
  return {
    status: 'success',
    message:
      `已生成${noun(outcome.files.length)}（${outcome.provider} / ${outcome.model}）：${outcome.files.map((f) => f.path).join('、')}` +
      (outcome.warning ? `\n${outcome.warning}` : ''),
    data: {
      provider: outcome.provider,
      model: outcome.model,
      files: outcome.files.map((f) => ({ path: f.path, mime: f.mime, bytes: f.bytes })),
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    },
    fileChanges: outcome.files.map((f) => ({ path: f.path, changeType: 'created' as const })),
  }
}

/** 三个生成工具共用的参数说明。 */
const PARAMS_NOTE =
  'params_json 仅使用本轮「可用的生成模型」中该模型列出的参数，取值依据用户要求或自行判断，无需设置的参数省略。' +
  'provider 与 model 须取自该清单的同一行；两者均省略时使用默认模型。'

/**
 * 生成文件在会话中的唯一展示入口是回复中的路径链接，点击后由正文链接的处理逻辑交给右侧文件预览。
 * 不写明时模型会以 Markdown 图片嵌入（相对地址在会话中渲染为损坏的图片），或多次写出同一路径。
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
    '生成按次计费；结果未知时停止自动重新生成，下载失败时使用恢复记录取回，不能通过修改提示词或参数重发生成。' +
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
  category: 'media',
  facet: '生成',
  summary: '用图像生成模型生成或编辑图片',
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
    '提交后在输出位置旁写入 .task.json 任务记录；等待中断后（停止、查询被拒绝或进程退出），用 retrieve_media 传入该记录路径取回结果，不会重新提交，也不会重复计费。' +
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
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '视频',
  category: 'media',
  facet: '生成',
  summary: '用视频生成模型生成、编辑或延长视频',
  targetExtractor: (a) => (typeof a.output === 'string' ? a.output : null),
  permissionEffect: 'write',
  async fn(args, ctx) {
    if (!ctx.media) return failure('本次执行没有生成通道')
    const onStatus = (status: string) => ctx.emit('progress', `${status}\n`)
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
        ctx.emit('progress', `已提交远端任务 ${taskId}，记录位于 ${record}\n`),
      onStatus,
    })
    return receipt(outcome, () => '视频')
  },
}

export const retrieveMediaTool: ToolSpec = {
  name: 'retrieve_media',
  description:
    '根据 generate_image 或 generate_video 返回的 .task.json 记录取回原结果，不重新提交生成、不重复计费。' +
    '模型、结果引用与输出位置均从记录中读取；画布中的待取回版本使用 retrieve_canvas。' +
    DISPLAY_NOTE,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: `待取回任务的记录文件路径（${TASK_SUFFIX}）` },
    },
    required: ['path'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: '生成结果',
  category: 'media',
  facet: '生成',
  summary: '取回已有的图片或视频结果',
  targetExtractor: (a) => text(a.path) ?? null,
  permissionEffect: 'write',
  async fn(args, ctx) {
    if (!ctx.media) return failure('本次执行没有生成通道')
    const path = text(args.path)
    if (!path) return failure('缺少 path', 'invalid_tool_arguments')
    const outcome = await resumeMedia({
      roots: rootsOf(ctx),
      media: ctx.media,
      signal: ctx.signal,
      record: path,
      onStatus: (status: string) => ctx.emit('progress', `${status}\n`),
    })
    return receipt(outcome, () => '产物')
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
  category: 'media',
  facet: '生成',
  summary: '用语音合成模型将文本合成为音频',
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

/** 每个生成类别对应的工具。注册、本轮快照与会话中判断某一类别是否有工具均查询本表。 */
export const MEDIA_TOOLS: Record<MediaOutput, ToolSpec> = {
  image: generateImageTool,
  video: generateVideoTool,
  audio: generateAudioTool,
}
