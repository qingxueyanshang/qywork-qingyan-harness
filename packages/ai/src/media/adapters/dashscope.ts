/**
 * 百炼原生的生成接口：`dashscope_images` 同步出图（千问图像、万相图像），
 * `dashscope_videos` 异步视频任务（万相视频），`dashscope_speech` 同步语音合成（千问语音合成）。
 *
 * 路径挂在接口地址的 origin 上。接口里填的通常是对话用的 `…/compatible-mode/v1`，
 * 百炼原生路径是 `/api/v1/services/…`，只取 origin 才拼得对；按业务空间分配的
 * `*.maas.aliyuncs.com` 与旧的公共域名同一套路径。
 */

import {
  DASHSCOPE_INLINE_SOURCE_BYTES,
  uploadDashScopeMedia,
} from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson, sniffMime } from '../http.ts'
import { afterSubmit, type TaskState, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

const DEFAULT_ORIGIN = 'https://dashscope.aliyuncs.com'

/** 同步出图。修改与生成同一个端点，参考图放进消息内容。 */
const SYNC_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
/** 视频任务。只能异步：不带 `X-DashScope-Async: enable` 接口直接报错。 */
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'

export function dashScopeOrigin(baseUrl: string | undefined): string {
  if (!baseUrl?.trim()) return DEFAULT_ORIGIN
  try {
    return new URL(baseUrl).origin
  } catch {
    return DEFAULT_ORIGIN
  }
}

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
      `${dashScopeOrigin(this.profile.baseUrl)}${SYNC_PATH}`,
      {
        model: this.profile.model,
        input: { messages: [{ role: 'user', content }] },
        ...(Object.keys(req.params).length ? { parameters: req.params } : {}),
      },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      signal,
    )
    const urls = imageUrls(body)
    if (urls.length === 0) {
      const code = typeof body.code === 'string' ? body.code : ''
      const message = typeof body.message === 'string' ? body.message : ''
      throw new MediaError(
        `接口没有返回图片${code || message ? `：${code} ${message}`.trimEnd() : ''}`,
      )
    }
    const files = []
    for (const url of urls) files.push(await download(url, signal))
    return { files, usage: imageUsage(body, files.length) }
  }
}

/**
 * 出图的计量。千问图像回 `output_image_count`、`input_image_count` 与档位 `output_image_type`；
 * 万相图像回 `image_count`（它的 token 字段标明不计费，不读）。
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
 * `SR` 万相回数字、百炼上的可灵回字符串（`720` / `1080` / `4k`）；可灵另回 `audio`。
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

/** `output.choices[].message.content[].image` 里的地址。 */
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
 * 语音合成与出图同一个同步端点，但参数（音色、语种、朗读要求）全在 `input` 里，与 `text` 并列，
 * 不在 `parameters` 里；放错位置接口按默认音色合成、不报错。结果是地址（24 小时有效）或 base64。
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
      `${dashScopeOrigin(this.profile.baseUrl)}${SYNC_PATH}`,
      { model: this.profile.model, input: { text: req.prompt, ...req.params } },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      signal,
    )
    const audio = (body.output as { audio?: { url?: unknown; data?: unknown } } | undefined)?.audio
    // 千问语音合成 3 按输入字符计费，接口回 `characters`（一个汉字计 2 个字符）。
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
 * 同一端点上的可灵用另一套类型名，视频的类型还可以由参数 `video_type` 指定。
 */
const MEDIA_TYPE: Record<MediaInput['role'], string> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'reference_image',
  video: 'reference_video',
}

export class DashScopeVideosAdapter implements MediaAdapter {
  readonly kind = 'dashscope_videos' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const origin = dashScopeOrigin(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const { video_type: videoType, ...parameters } = req.params
      const types = { ...MEDIA_TYPE, ...this.spec.inputs.types }
      if (typeof videoType === 'string') types.video = videoType
      const media = []
      for (const input of req.inputs) {
        media.push({ type: types[input.role], url: await this.source(input, origin, signal) })
      }
      const body = await postJson(
        `${origin}${VIDEO_PATH}`,
        {
          model: this.profile.model,
          input: { prompt: req.prompt, ...(media.length ? { media } : {}) },
          ...(Object.keys(parameters).length ? { parameters } : {}),
        },
        {
          ...auth,
          'x-dashscope-async': 'enable',
          // 输入里有 `oss://` 临时地址时必须带这个头，否则接口不解析它。
          ...(media.some((m) => m.url.startsWith('oss://'))
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
   * 输入放进请求的形式：小文件直接 data URI；超过内联上限的走百炼临时上传换 `oss://` 地址，
   * 与对话里的大附件同一套上传。
   */
  private source(input: MediaInput, origin: string, signal: AbortSignal): Promise<string> {
    if (input.bytes.length <= DASHSCOPE_INLINE_SOURCE_BYTES) {
      return Promise.resolve(dataUri(input.bytes, input.mime))
    }
    return uploadDashScopeMedia({
      apiKey: this.profile.apiKey,
      baseUrl: origin,
      model: this.profile.model,
      path: input.path,
      size: input.bytes.length,
      signal,
    })
  }
}
