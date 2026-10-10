/** Gemini Interactions 的图片、视频生成，以及 Veo 的长任务接口。 */
import type { MediaKind } from '@qywork/core'
import type { MediaModelSpec } from '../catalog.ts'
import { count, defined, download, getJson, postJson, sniffMime } from '../http.ts'
import { resolveImages } from '../image-result.ts'
import { afterSubmit, failureDetail, type TaskState, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaFile,
  type MediaImageResult,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

function connection(profile: MediaProfile) {
  const base = (
    profile.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/, '')
  const url = new URL(base)
  if (url.hostname === 'generativelanguage.googleapis.com' && url.pathname === '/v1beta/openai') {
    url.pathname = '/v1beta'
  }
  if (url.pathname === '/') url.pathname = '/v1beta'
  return {
    base: url.href.replace(/\/+$/, ''),
    auth: { 'x-goog-api-key': profile.apiKey, ...profile.headers },
  }
}

/** 交互的终止状态及其说明。 */
const ENDED: Record<string, string> = {
  failed: '任务失败',
  cancelled: '任务已取消',
  incomplete: '任务结束但结果不完整',
}

/**
 * 交互未成功时的原因。接口参考把错误放在 `errors[]`，示例代码读取 `error`，两处都是官方字段。
 */
function interactionFailure(body: Record<string, unknown>): string {
  const error = (Array.isArray(body.errors) ? body.errors[0] : body.error) as
    | { code?: unknown; message?: unknown }
    | undefined
  const status = String(body.status ?? '')
  return failureDetail(error?.code, error?.message, ENDED[status] ?? `未知任务状态 ${status}`)
}

/** API 凭证只用于同源文件端点；其他结果地址按公开临时链接下载。 */
function readFile(
  uri: string,
  base: string,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<MediaFile> {
  return download(uri, signal, new URL(uri).origin === new URL(base).origin ? auth : {})
}

function outputs(
  body: Record<string, unknown>,
  type: 'image' | 'video',
): Record<string, unknown>[] {
  const steps = Array.isArray(body.steps) ? (body.steps as Record<string, unknown>[]) : []
  return steps.flatMap((step) =>
    step.type === 'model_output' && Array.isArray(step.content)
      ? (step.content as Record<string, unknown>[]).filter((part) => part.type === type)
      : [],
  )
}

function usageOf(
  body: Record<string, unknown>,
  type: 'image' | 'video',
  images: number,
): MediaUsage {
  const u = (body.usage ?? {}) as Record<string, unknown>
  const modalities = Array.isArray(u.output_tokens_by_modality)
    ? (u.output_tokens_by_modality as Record<string, unknown>[])
    : []
  const media = count(modalities.find((m) => m.modality === type)?.tokens)
  const total = count(u.total_output_tokens)
  const thoughts = count(u.total_thought_tokens) ?? 0
  return defined<MediaUsage>({
    images: type === 'image' ? images : undefined,
    inputTokens:
      (count(u.total_cached_tokens) ?? 0) === 0 ? count(u.total_input_tokens) : undefined,
    outputTokens: total,
    outputMediaTokens: media,
    outputTextTokens:
      total !== undefined && media !== undefined && total >= media
        ? total - media + thoughts
        : undefined,
  })
}

export class GeminiMediaAdapter implements MediaAdapter {
  readonly kind: MediaKind

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {
    this.kind = profile.kind
  }

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { base, auth } = connection(this.profile)
    const type = this.kind === 'gemini_images' ? 'image' : 'video'
    let taskId = opts.resumeTaskId
    let initial: Record<string, unknown> | undefined
    if (!taskId) {
      const ordered = [...req.inputs].sort((a, b) => {
        const rank = (i: MediaInput) =>
          i.role === 'first_frame' ? 0 : i.role === 'last_frame' ? 1 : 2
        return rank(a) - rank(b)
      })
      const input: Record<string, unknown>[] = ordered.map((i) => ({
        type: i.role === 'video' ? 'video' : 'image',
        data: Buffer.from(i.bytes).toString('base64'),
        mime_type: i.mime,
      }))
      const sources: string[] = []
      const references: string[] = []
      let imageIndex = 0
      let referenceIndex = 0
      if (type === 'video') {
        for (const item of ordered) {
          if (item.role === 'video') continue
          imageIndex++
          if (item.role === 'first_frame') sources.push(`<FIRST_FRAME>@Image${imageIndex}`)
          else if (item.role === 'last_frame') sources.push(`<LAST_FRAME>@Image${imageIndex}`)
          else references.push(`<IMAGE_REF_${referenceIndex++}>@Image${imageIndex}`)
        }
      }
      const declarations = [
        ...(sources.length ? [`[# Sources ${sources.join(' ')}]`] : []),
        ...(references.length ? [`[# References ${references.join(' ')}]`] : []),
      ]
      input.push({ type: 'text', text: [...declarations, req.prompt].join(' ') })
      initial = await postJson(
        `${base}/interactions`,
        {
          model: this.profile.model,
          input,
          response_format: { type, ...req.params },
          background: type === 'video',
          store: type === 'video',
        },
        auth,
        opts.signal,
      )
      // 图片使用同步生成，恢复保存输出引用；视频保存任务号。
      if (type === 'image') {
        if (initial.status !== 'completed' || outputs(initial, type).length === 0) {
          throw new MediaError(
            initial.status === 'completed'
              ? '接口没有返回图片'
              : `接口没有返回图片：${interactionFailure(initial)}`,
          )
        }
        const sources: MediaImageResult['sources'] = outputs(initial, 'image').map((part) => {
          if (typeof part.data === 'string' && part.data)
            return {
              base64: part.data,
              mime: typeof part.mime_type === 'string' ? part.mime_type : 'image/png',
            }
          if (typeof part.uri === 'string') return { url: part.uri }
          throw new MediaError('Gemini 输出缺少文件内容或下载地址')
        })
        return this.resumeImage({ sources, usage: usageOf(initial, 'image', sources.length) }, opts)
      }
      if (typeof initial.id !== 'string' || !initial.id)
        throw new MediaError('Gemini 接口没有返回任务号')
      taskId = initial.id
      await opts.onTask?.(taskId)
    }
    const id = taskId
    return afterSubmit(id, opts.signal, async () => {
      const done = await waitTask<{ body: Record<string, unknown> }>(async () => {
        const body =
          initial ??
          (await getJson(`${base}/interactions/${encodeURIComponent(id)}`, auth, opts.signal))
        initial = undefined
        const status = String(body.status ?? '')
        if (status === 'completed') {
          if (outputs(body, type).length === 0)
            return {
              state: 'failed',
              message: `任务完成但没有返回${type === 'image' ? '图片' : '视频'}`,
            }
          return { state: 'done', body }
        }
        if (status === 'in_progress' || status === 'queued') return { state: 'pending', status }
        return {
          state: 'failed',
          message: interactionFailure(body),
        }
      }, opts)
      return this.readResult(done.body, type, base, auth, opts.signal)
    })
  }

  resumeImage(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult> {
    const { base, auth } = connection(this.profile)
    return resolveImages(result, opts, (url) => readFile(url, base, auth, opts.signal))
  }

  private async readResult(
    body: Record<string, unknown>,
    type: 'image' | 'video',
    base: string,
    auth: Record<string, string>,
    signal: AbortSignal,
  ): Promise<MediaResult> {
    const files: MediaFile[] = []
    for (const part of outputs(body, type)) {
      if (typeof part.data === 'string' && part.data) {
        const bytes = new Uint8Array(Buffer.from(part.data, 'base64'))
        if (bytes.length === 0) throw new MediaError('Gemini 返回的文件内容为空')
        files.push({
          bytes,
          mime:
            sniffMime(bytes) ??
            (typeof part.mime_type === 'string'
              ? part.mime_type
              : `${type}/${type === 'image' ? 'png' : 'mp4'}`),
        })
      } else if (typeof part.uri === 'string') {
        files.push(await readFile(part.uri, base, auth, signal))
      } else throw new MediaError('Gemini 输出缺少文件内容或下载地址')
    }
    return { files, usage: usageOf(body, type, files.length) }
  }
}

const inline = (i: MediaInput) => ({
  inlineData: { mimeType: i.mime, data: Buffer.from(i.bytes).toString('base64') },
})

export class VeoVideosAdapter implements MediaAdapter {
  readonly kind = 'veo_videos' as const
  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { base, auth } = connection(this.profile)
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const instance: Record<string, unknown> = { prompt: req.prompt }
      const refs = req.inputs.filter((i) => i.role === 'reference')
      if (refs.length)
        instance.referenceImages = refs.map((i) => ({ image: inline(i), referenceType: 'asset' }))
      for (const i of req.inputs) {
        if (i.role === 'first_frame') instance.image = inline(i)
        if (i.role === 'last_frame') instance.lastFrame = inline(i)
      }
      const body = await postJson(
        `${base}/models/${encodeURIComponent(this.profile.model)}:predictLongRunning`,
        {
          instances: [instance],
          parameters: req.params,
        },
        auth,
        opts.signal,
      )
      if (typeof body.name !== 'string' || !body.name)
        throw new MediaError('Veo 接口没有返回任务号')
      taskId = body.name
      await opts.onTask?.(taskId)
    }
    const id = taskId
    return afterSubmit(id, opts.signal, async () => {
      const done = await waitTask<{ uris: string[] }>(
        async (): Promise<TaskState<{ uris: string[] }>> => {
          if (
            !/^models\/[\w.-]+\/operations\/[\w.-]+$/.test(id) &&
            !/^operations\/[\w.-]+$/.test(id)
          ) {
            return { state: 'failed', message: 'Veo 任务号格式无效' }
          }
          const body = await getJson(`${base}/${id}`, auth, opts.signal)
          // `error.code` 是 google.rpc.Code 的数值，不是 HTTP 状态码，只显示原文。
          const error = body.error as { message?: unknown } | undefined
          if (error)
            return { state: 'failed', message: failureDetail(undefined, error.message, '任务失败') }
          if (body.done !== true) return { state: 'pending', status: 'processing' }
          const response = body.response as
            | {
                generateVideoResponse?: {
                  generatedSamples?: { video?: { uri?: unknown } }[]
                  raiMediaFilteredReasons?: string[]
                }
              }
            | undefined
          const result = response?.generateVideoResponse
          const uris = (result?.generatedSamples ?? []).flatMap((s) =>
            typeof s.video?.uri === 'string' ? [s.video.uri] : [],
          )
          return uris.length
            ? { state: 'done', uris }
            : {
                state: 'failed',
                message: `没有返回视频：${result?.raiMediaFilteredReasons?.join('；') ?? '空结果'}`,
              }
        },
        opts,
      )
      return {
        files: await Promise.all(done.uris.map((uri) => readFile(uri, base, auth, opts.signal))),
      }
    })
  }
}
