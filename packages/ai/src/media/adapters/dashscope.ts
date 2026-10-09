/**
 * 百炼原生的生成接口：`dashscope_images` 同步生成图片（千问图像、万相图像），
 * `dashscope_videos` 异步视频任务（万相视频），`dashscope_speech` 同步语音合成（千问语音合成）。
 *
 * 原生路径为 `/api/v1/services/…`，与上传共用地址规范化：去除兼容接口后缀，保留部署前缀。
 */

import {
  DASHSCOPE_INLINE_SOURCE_BYTES,
  dashScopeBaseUrl,
  uploadDashScopeMedia,
} from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import {
  count,
  dataUri,
  defined,
  download,
  getJson,
  IMAGE_TIMEOUT_MS,
  postJson,
  send,
  sniffMime,
} from '../http.ts'
import { resolveImages } from '../image-result.ts'
import { afterSubmit, type TaskState, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  type MediaCancel,
  MediaError,
  type MediaImageResult,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

/** 同步生成图片。修改与生成使用同一端点，参考图放入消息内容。 */
const SYNC_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
/** 视频任务。只支持异步：不带 `X-DashScope-Async: enable` 时接口直接报错。 */
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'

export class DashScopeImagesAdapter implements MediaAdapter {
  readonly kind = 'dashscope_images' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const content = [
      ...req.inputs.map((i) => ({ image: dataUri(i.bytes, i.mime) })),
      { text: req.prompt },
    ]
    const body = await postJson(
      `${dashScopeBaseUrl(this.profile.baseUrl)}${SYNC_PATH}`,
      {
        model: this.profile.model,
        input: { messages: [{ role: 'user', content }] },
        ...(Object.keys(req.params).length ? { parameters: req.params } : {}),
      },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      signal,
      { timeoutMs: IMAGE_TIMEOUT_MS },
    )
    const urls = imageUrls(body)
    if (urls.length === 0) {
      const code = typeof body.code === 'string' ? body.code : ''
      const message = typeof body.message === 'string' ? body.message : ''
      throw new MediaError(
        `接口没有返回图片${code || message ? `：${code} ${message}`.trimEnd() : ''}`,
      )
    }
    return resolveImages(
      { sources: urls.map((url) => ({ url })), usage: imageUsage(body, urls.length) },
      opts,
    )
  }

  resumeImage(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult> {
    return resolveImages(result, opts)
  }
}

/**
 * 图片生成的计量。千问图像返回 `output_image_count`、`input_image_count` 与档位 `output_image_type`；
 * 万相图像返回 `image_count`（其 token 字段标明不计费，不读取）。
 */
function imageUsage(body: Record<string, unknown>, received: number): MediaUsage {
  const u = (body.usage ?? {}) as Record<string, unknown>
  return defined<MediaUsage>({
    images: count(u.output_image_count) ?? count(u.image_count) ?? received,
    inputImages: count(u.input_image_count),
    imageTier: typeof u.output_image_type === 'string' ? u.output_image_type : undefined,
  })
}

/**
 * 视频任务的计量（查询结果顶层的 `usage`）。`duration` 是计费秒数：万相有参考视频时含输入视频时长。
 * `SR` 万相返回数字，百炼上的可灵返回字符串（`720` / `1080` / `4k`）；可灵另返回 `audio`。
 */
function videoUsage(raw: unknown): MediaUsage {
  const u = (raw ?? {}) as Record<string, unknown>
  const sr = String(u.SR ?? '').toLowerCase()
  return defined<MediaUsage>({
    seconds: count(u.duration),
    resolution: sr ? (sr.endsWith('k') || sr.endsWith('p') ? sr : `${sr}p`) : undefined,
    audio: typeof u.audio === 'boolean' ? u.audio : undefined,
  })
}

/** `output.choices[].message.content[].image` 中的地址。 */
function imageUrls(body: Record<string, unknown>): string[] {
  const output = body.output as { choices?: { message?: { content?: unknown[] } }[] } | undefined
  const urls: string[] = []
  for (const choice of output?.choices ?? []) {
    for (const part of choice.message?.content ?? []) {
      const image = (part as { image?: unknown }).image
      if (typeof image === 'string') urls.push(image)
    }
  }
  return urls
}

/**
 * 语音合成与图片生成使用同一同步端点，但参数（音色、语种、朗读要求）全部位于 `input` 中，与 `text` 并列，
 * 不在 `parameters` 中；放错位置时接口按默认音色合成且不报错。结果是地址（24 小时有效）或 base64。
 */
export class DashScopeSpeechAdapter implements MediaAdapter {
  readonly kind = 'dashscope_speech' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const body = await postJson(
      `${dashScopeBaseUrl(this.profile.baseUrl)}${SYNC_PATH}`,
      {
        model: this.profile.model,
        input: {
          text: req.prompt,
          voice: this.spec.params.find((p) => p.name === 'voice')?.default,
          ...req.params,
        },
      },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      signal,
    )
    const audio = (body.output as { audio?: { url?: unknown; data?: unknown } } | undefined)?.audio
    // 千问语音合成 3 按输入字符计费，接口返回 `characters`（一个汉字计 2 个字符）。
    const usage = defined<MediaUsage>({
      characters: count((body.usage as Record<string, unknown> | undefined)?.characters),
    })
    if (typeof audio?.url === 'string' && audio.url)
      return { files: [await download(audio.url, signal)], usage }
    if (typeof audio?.data === 'string' && audio.data) {
      const bytes = new Uint8Array(Buffer.from(audio.data, 'base64'))
      return { files: [{ bytes, mime: sniffMime(bytes) ?? 'audio/wav' }], usage }
    }
    const code = typeof body.code === 'string' ? body.code : ''
    const message = typeof body.message === 'string' ? body.message : ''
    throw new MediaError(
      `接口没有返回音频${code || message ? `：${code} ${message}`.trimEnd() : ''}`,
    )
  }
}

/**
 * 输入用途到 `input.media[].type` 的对应（万相的取值）。目录的 `inputs.types` 按型号覆盖：
 * 同一端点上的可灵使用另一套类型名，视频的类型还可以由参数 `video_type` 指定。
 */
const MEDIA_TYPE: Record<MediaInput['role'], string> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'reference_image',
  video: 'reference_video',
  audio: 'reference_audio',
}

/** 原生与中转共用百炼的素材类型及参数层级，地址由各自的传输提供。 */
export async function dashScopeVideoPayload(
  req: MediaRequest,
  spec: MediaModelSpec,
  source: (input: MediaInput) => string | Promise<string>,
) {
  const { video_type: videoType, ...parameters } = req.params
  const types = { ...MEDIA_TYPE, ...spec.inputs.types }
  if (typeof videoType === 'string') types.video = videoType
  const media = []
  for (const input of req.inputs) media.push({ type: types[input.role], url: await source(input) })
  return { input: { prompt: req.prompt, ...(media.length ? { media } : {}) }, parameters }
}

export class DashScopeVideosAdapter implements MediaAdapter {
  readonly kind = 'dashscope_videos' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const origin = dashScopeBaseUrl(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const payload = await dashScopeVideoPayload(req, this.spec, (input) =>
        this.source(input, signal),
      )
      const body = await postJson(
        `${origin}${VIDEO_PATH}`,
        {
          model: this.profile.model,
          ...payload,
        },
        {
          ...auth,
          'x-dashscope-async': 'enable',
          // 输入中含 `oss://` 临时地址时必须带此请求头，否则接口不解析该地址。
          ...(payload.input.media?.some((m) => m.url.startsWith('oss://'))
            ? { 'x-dashscope-ossresourceresolve': 'enable' }
            : {}),
        },
        signal,
      )
      const output = body.output as { task_id?: unknown } | undefined
      if (typeof output?.task_id !== 'string') {
        throw new MediaError(`接口没有返回任务号：${JSON.stringify(body).slice(0, 300)}`)
      }
      taskId = output.task_id
      await opts.onTask?.(taskId)
    }
    const id = taskId
    const videoInput = req.inputs.some((i) => i.role === 'video')
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(id, () => this.check(origin, id, auth, signal), opts)
      return { files: [await download(done.url, signal)], usage: { ...done.usage, videoInput } }
    })
  }

  /**
   * 撤销任务：`POST /api/v1/tasks/{task_id}/cancel`。百炼只能撤销排队中（`PENDING`）的任务，其余状态返回 400；
   * 被拒绝时再查询一次状态，已不在排队则返回 `started`，仍在排队说明是其他原因，原样抛出。
   */
  async cancel(taskId: string, signal: AbortSignal): Promise<MediaCancel> {
    const origin = dashScopeBaseUrl(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    try {
      await send(
        `${origin}/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
        { method: 'POST', headers: auth },
        signal,
      )
      return 'cancelled'
    } catch (err) {
      if (signal.aborted || !(err instanceof MediaError) || err.status === undefined) throw err
      const now = await this.check(origin, taskId, auth, signal)
      if (now.state === 'pending' && now.status === 'PENDING') throw err
      return 'started'
    }
  }

  private async check(
    origin: string,
    taskId: string,
    auth: Record<string, string>,
    signal: AbortSignal,
  ): Promise<TaskState> {
    const body = await getJson(`${origin}/api/v1/tasks/${encodeURIComponent(taskId)}`, auth, signal)
    const out = (body.output ?? {}) as Record<string, unknown>
    const status = String(out.task_status ?? '')
    if (status === 'SUCCEEDED') {
      if (typeof out.video_url === 'string') {
        return { state: 'done', url: out.video_url, usage: videoUsage(body.usage) }
      }
      return { state: 'failed', message: '任务成功但没有返回视频地址' }
    }
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      return {
        state: 'failed',
        message: `${status} ${String(out.code ?? '')} ${String(out.message ?? '')}`.trim(),
      }
    }
    return { state: 'pending', status: status || 'PENDING' }
  }

  /**
   * 小图像使用 data URI；视频、音频与超过内联上限的图像经临时上传转换为 `oss://` 地址，
   * 与对话中的大附件使用同一套上传流程。
   */
  private async source(input: MediaInput, signal: AbortSignal): Promise<string> {
    if (
      input.role !== 'video' &&
      input.role !== 'audio' &&
      this.spec.inputs.inlineImages !== false &&
      input.bytes.length <= DASHSCOPE_INLINE_SOURCE_BYTES
    ) {
      return dataUri(input.bytes, input.mime)
    }
    try {
      return await uploadDashScopeMedia({
        apiKey: this.profile.apiKey,
        baseUrl: this.profile.baseUrl ?? '',
        model: this.profile.model,
        path: input.path,
        size: input.bytes.length,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      const status = (error as { status?: number })?.status
      throw new MediaError(
        `素材上传失败：${error instanceof Error ? error.message : String(error)}`,
        typeof status === 'number' ? { status } : {},
      )
    }
  }
}
