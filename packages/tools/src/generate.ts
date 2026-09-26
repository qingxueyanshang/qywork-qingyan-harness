/**
 * 生成工具：大模型经生成端口（`ctx.media`）调用已配置的生成模型，产物写进工作区。
 *
 * 结果只回产物的工作区路径，不带字节：用户点路径在右侧预览里看，大模型要看图就自己 `read_file`。
 * 选模型、推操作、校验参数、调接口在端口实现里；读输入、写产物、记远端任务在这里，
 * 与 `read_file` / `write_file` 走同一条路径边界与可写判定。
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import type { MediaCall, MediaCallResult, ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import type { MediaFile, MediaInput } from '@qywork/ai'
import {
  type FileChange,
  isInlineImage,
  isInlineVideo,
  type MediaOutput,
  mimeOf,
} from '@qywork/core'
import { displayPath, resolveInWorkspace, resolveWritablePath, rootsOf } from './paths.ts'

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
const TASK_SUFFIX = '.task.json'

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

/**
 * 把产物写进工作区。先写 `.part` 再改名：半截文件不会出现在工作区里，写失败时删掉 `.part`。
 *
 * 大模型给的输出路径已存在时不覆盖（与 `write_file` 新建同名一致），这一条在调接口之前就查过；
 * 多张时从第二张起加 `-2`、`-3`，撞名继续往后加。扩展名按实际格式定（`landingPath`）。
 */
async function land(ctx: ToolContext, files: MediaFile[], target: string): Promise<FileChange[]> {
  const changes: FileChange[] = []
  for (const [index, file] of files.entries()) {
    const base = landingPath(target, file.mime)
    const { dir, name, ext } = parse(base)
    let abs = ''
    for (let suffix = index + 1; ; suffix++) {
      const candidate = suffix === 1 ? base : join(dir, `${name}-${suffix}${ext}`)
      abs = await resolveWritablePath(rootsOf(ctx), candidate, { followFinalSymlink: false })
      if (!(await occupied(abs))) break
    }
    await mkdir(dirname(abs), { recursive: true })
    const part = `${abs}.part`
    try {
      await writeFile(part, file.bytes, { flag: 'wx' })
      await rename(part, abs)
    } catch (err) {
      await rm(part, { force: true })
      throw err
    }
    changes.push({ path: displayPath(ctx.workspaceRoot, abs), changeType: 'created' })
  }
  return changes
}

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

/** 读输入文件。路径走工作区边界；类型不对在调接口之前就退回。 */
async function readInputs(
  ctx: ToolContext,
  raw: unknown,
  role: MediaInput['role'],
): Promise<MediaInput[] | ToolOutcome> {
  const list = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null || raw === ''
      ? []
      : [raw]
  const inputs: MediaInput[] = []
  for (const item of list) {
    const abs = await resolveInWorkspace(rootsOf(ctx), String(item), { mustExist: true })
    const ok = role === 'video' ? isInlineVideo(abs) : isInlineImage(abs)
    if (!ok) {
      return failure(
        `${String(item)} 不是${role === 'video' ? ' mp4 / mov / webm / mkv 视频' : ' png / jpg / gif / webp 图片'}`,
        'invalid_tool_arguments',
      )
    }
    inputs.push({ role, bytes: new Uint8Array(await readFile(abs)), mime: mimeOf(abs), path: abs })
  }
  return inputs
}

/** 输出路径已存在就在调接口之前拒绝：生成按次计费，写不进去的调用不能先扣费。 */
async function outputTaken(
  ctx: ToolContext,
  output: string | undefined,
): Promise<ToolOutcome | null> {
  if (!output) return null
  const abs = await resolveWritablePath(rootsOf(ctx), output, { followFinalSymlink: false })
  return (await occupied(abs))
    ? failure(`${output} 已存在，不会覆盖。换一个输出路径，或不填 output`, 'file_exists')
    : null
}

function succeeded(
  result: Extract<MediaCallResult, { ok: true }>,
  changes: FileChange[],
  noun: string,
): ToolOutcome {
  return {
    status: 'success',
    message: `生成${noun}（${result.provider} / ${result.model}）：${changes.map((c) => c.path).join('、')}`,
    data: {
      provider: result.provider,
      model: result.model,
      files: changes.map((c, i) => ({
        path: c.path,
        mime: result.files[i]?.mime,
        bytes: result.files[i]?.bytes.length,
      })),
    },
    fileChanges: changes,
    presentation: { files: 'open' },
  }
}

export const generateImageTool: ToolSpec = {
  name: 'generate_image',
  description:
    '用已配置的图像生成模型出图或改图，产物写进工作区，结果只返回文件路径。' +
    '不给 images 是按提示词生成；给 images（工作区里的图片路径）是在这些图的基础上修改或参考生成，改哪里、怎么改写在 prompt 里。' +
    'params_json 只填本轮「可用的生成模型」里该模型列出的参数，按用户的要求或你的判断取值，用不到的不填。' +
    'provider 与 model 只接受那份清单里同一行的值，都不给就用默认模型。生成按次计费，不要为了试探重复调用。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要生成什么，或要怎么修改' },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '参考图或待修改图的工作区路径',
      },
      params_json: {
        type: 'string',
        description: '该模型的参数，JSON 对象，字段与取值见本轮「可用的生成模型」',
      },
      provider: { type: 'string', description: '接口名' },
      model: { type: 'string', description: '模型 id' },
      output: {
        type: 'string',
        description: `输出文件的工作区路径；多张时从第二张起加 -2、-3。不填写到 ${DEFAULT_DIR}/`,
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
    const inputs = await readInputs(ctx, args.images, 'reference')
    if (!Array.isArray(inputs)) return inputs
    const taken = await outputTaken(ctx, common.output)
    if (taken) return taken

    const result = await ctx.media.generate(
      {
        type: 'image',
        prompt: common.prompt,
        inputs,
        params: common.params,
        ...(common.pick ?? {}),
      },
      ctx.signal,
    )
    if (!result.ok) return { status: 'failure', executed: true, message: result.message }
    const changes = await land(ctx, result.files, common.output ?? join(DEFAULT_DIR, stamp()))
    return succeeded(result, changes, ` ${changes.length} 张`)
  },
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

export const generateVideoTool: ToolSpec = {
  name: 'generate_video',
  description:
    '用已配置的视频生成模型生成视频，产物写进工作区，结果只返回文件路径。远端要排队生成，通常要等几分钟。' +
    '按给了哪些输入决定做什么：都不给是文生视频；给 first_frame 是首帧生视频；再给 last_frame 是首尾帧；' +
    '给 images 是参考图生成；给 videos 是以参考视频为输入（编辑、延长还是参考，看该模型参数表里的字段，没有字段就写在 prompt 里）。' +
    '首尾帧不能与 images、videos 同时给。params_json 只填本轮「可用的生成模型」里该模型列出的参数。' +
    '提交后会在输出位置旁写一个 .task.json 任务记录；等待被中断或超时时，用 resume 传这个记录的路径取回结果，不会重新提交、不重复扣费。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '视频内容；编辑或延长时写清要怎么改、往哪个方向延长' },
      first_frame: { type: 'string', description: '首帧图片的工作区路径' },
      last_frame: { type: 'string', description: '尾帧图片的工作区路径，要与 first_frame 一起给' },
      images: { type: 'array', items: { type: 'string' }, description: '参考图的工作区路径' },
      videos: { type: 'array', items: { type: 'string' }, description: '参考视频的工作区路径' },
      params_json: {
        type: 'string',
        description: '该模型的参数，JSON 对象，字段与取值见本轮「可用的生成模型」',
      },
      provider: { type: 'string', description: '接口名' },
      model: { type: 'string', description: '模型 id' },
      output: {
        type: 'string',
        description: `输出文件的工作区路径，不填写到 ${DEFAULT_DIR}/`,
      },
      resume: {
        type: 'string',
        description: `要取回的任务记录（${TASK_SUFFIX}）路径。给了它其余参数都不用给`,
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
    const resume = text(args.resume)
    if (resume) return resumeVideo(ctx, resume)

    const common = commonArgs(args)
    if ('status' in common) return common
    const inputs: MediaInput[] = []
    for (const [key, role] of [
      ['first_frame', 'first_frame'],
      ['last_frame', 'last_frame'],
      ['images', 'reference'],
      ['videos', 'video'],
    ] as const) {
      const read = await readInputs(ctx, args[key], role)
      if (!Array.isArray(read)) return read
      inputs.push(...read)
    }
    const taken = await outputTaken(ctx, common.output)
    if (taken) return taken

    const target = common.output ?? join(DEFAULT_DIR, stamp())
    const recordPath = await resolveWritablePath(rootsOf(ctx), `${target}${TASK_SUFFIX}`, {
      followFinalSymlink: false,
    })
    let recorded = false
    const call: MediaCall = {
      type: 'video',
      prompt: common.prompt,
      inputs,
      params: common.params,
      ...(common.pick ?? {}),
      onTask: async ({ taskId, provider, model }) => {
        const record: TaskRecord = {
          provider,
          model,
          taskId,
          output: target,
          submittedAt: new Date().toISOString(),
        }
        await mkdir(dirname(recordPath), { recursive: true })
        await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)
        recorded = true
        ctx.emit(
          'progress',
          `已提交远端任务 ${taskId}，记录在 ${displayPath(ctx.workspaceRoot, recordPath)}\n`,
        )
      },
      onStatus: (status) => ctx.emit('progress', `${status}\n`),
    }
    const result = await ctx.media.generate(call, ctx.signal)
    return settleVideo(ctx, result, target, recorded ? recordPath : null)
  },
}

/** 按任务记录取回：只查询与下载，不再提交。 */
async function resumeVideo(ctx: ToolContext, raw: string): Promise<ToolOutcome> {
  const recordPath = await resolveWritablePath(rootsOf(ctx), raw, { mustExist: true })
  let record: TaskRecord
  try {
    record = JSON.parse(await readFile(recordPath, 'utf8')) as TaskRecord
  } catch {
    return failure(`${raw} 不是任务记录`, 'invalid_tool_arguments')
  }
  if (!record.taskId || !record.provider || !record.model || !record.output) {
    return failure(`${raw} 缺少任务号、接口、模型或输出路径`, 'invalid_tool_arguments')
  }
  const result = await ctx.media!.generate(
    {
      type: 'video',
      prompt: '',
      inputs: [],
      params: {},
      provider: record.provider,
      model: record.model,
      resumeTaskId: record.taskId,
      onStatus: (status) => ctx.emit('progress', `${status}\n`),
    },
    ctx.signal,
  )
  return settleVideo(ctx, result, record.output, recordPath)
}

/**
 * 收尾：成功就落盘并删掉任务记录；远端还在（`pendingTaskId`）就留着记录、告诉大模型怎么取回；
 * 终态失败删掉记录。
 */
async function settleVideo(
  ctx: ToolContext,
  result: MediaCallResult,
  target: string,
  recordPath: string | null,
): Promise<ToolOutcome> {
  if (!result.ok) {
    if (result.pendingTaskId && recordPath) {
      const shown = displayPath(ctx.workspaceRoot, recordPath)
      return {
        status: 'failure',
        executed: true,
        message: `${result.message}\n任务记录在 ${shown}，用 generate_video 的 resume 传这个路径取回，不会重新提交。`,
      }
    }
    if (recordPath) await rm(recordPath, { force: true })
    return { status: 'failure', executed: true, message: result.message }
  }
  const changes = await land(ctx, result.files, target)
  if (recordPath) await rm(recordPath, { force: true })
  return succeeded(result, changes, '视频')
}

export const generateAudioTool: ToolSpec = {
  name: 'generate_audio',
  description:
    '用已配置的语音合成模型把文字读成音频，产物写进工作区，结果只返回文件路径。' +
    '音色、语种、语气等写在 params_json 里，只填本轮「可用的生成模型」里该模型列出的参数，按用户的要求或你的判断取值。' +
    'provider 与 model 只接受那份清单里同一行的值，都不给就用默认模型。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要读出来的文字' },
      params_json: {
        type: 'string',
        description: '该模型的参数，JSON 对象，字段与取值见本轮「可用的生成模型」',
      },
      provider: { type: 'string', description: '接口名' },
      model: { type: 'string', description: '模型 id' },
      output: {
        type: 'string',
        description: `输出文件的工作区路径，不填写到 ${DEFAULT_DIR}/`,
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
    const taken = await outputTaken(ctx, common.output)
    if (taken) return taken
    const result = await ctx.media.generate(
      {
        type: 'audio',
        prompt: common.prompt,
        inputs: [],
        params: common.params,
        ...(common.pick ?? {}),
      },
      ctx.signal,
    )
    if (!result.ok) return { status: 'failure', executed: true, message: result.message }
    const changes = await land(ctx, result.files, common.output ?? join(DEFAULT_DIR, stamp()))
    return succeeded(result, changes, '音频')
  },
}

/** 每个生成类别对应的工具。注册、本轮快照与会话里「这一类有没有工具」都查这一张表。 */
export const MEDIA_TOOLS: Record<MediaOutput, ToolSpec> = {
  image: generateImageTool,
  video: generateVideoTool,
  audio: generateAudioTool,
}
