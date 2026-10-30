/**
 * 百炼原生的生成接口：`dashscope_images` 同步生成图片（千问图像、万相图像），
 * `dashscope_videos` 异步视频任务（万相视频），`dashscope_speech` 同步语音合成（千问语音合成）。
 *
 * 原生路径为 `/api/v1/services/…`，与上传共用地址规范化：去除兼容接口后缀，保留部署前缀。
 */

import { mediaParamValues, resolveMediaParam } from '@qywork/core'
import {
  DASHSCOPE_INLINE_SOURCE_BYTES,
  dashScopeBaseUrl,
  uploadDashScopeMedia,
} from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson, send, sniffMime } from '../http.ts'
import { resolveImages } from '../image-result.ts'
import {
  afterSubmit,
  failureDetail,
  pendingTask,
  postTask,
  type TaskState,
  waitTask,
} from '../task.ts'
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
const SPEECH_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer'
/** 视频任务。只支持异步：不带 `X-DashScope-Async: enable` 时接口直接报错。 */
const VIDEO_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'
/** 任务的终止状态及其说明。 */
const ENDED: Record<string, string> = {
  FAILED: '任务失败',
  CANCELED: '任务已取消',
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
      `${dashScopeBaseUrl(this.profile.baseUrl)}${SYNC_PATH}`,
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
 * 图片生成的计量。千问图像 3.0 返回 `output_image_count`、`input_image_count` 与档位 `output_image_type`；
 * 千问图像 2.1 与万相图像返回 `image_count`（万相的 token 字段标明不计费，不读取）。
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
 * 按实际字节修正 WAV 头部的长度字段。千问语音合成返回的 WAV 由流式编码写成，RIFF 与 data 块的长度是占位值
 * （实测 data 块为 0x7FFFFF9B，按头部计算约 13.5 小时，实际 3 至 4 秒），读取时长、播放与上传都按头部长度处理。
 * 只修正超出实际字节的长度；不是 WAV 或长度未超出时原样返回。
 */
function wavWithActualLengths(bytes: Uint8Array): Uint8Array {
  if (sniffMime(bytes) !== 'audio/wav') return bytes
  const out = bytes.slice()
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  if (view.getUint32(4, true) + 8 > out.length) view.setUint32(4, out.length - 8, true)
  for (let at = 12; at + 8 <= out.length; ) {
    const size = view.getUint32(at + 4, true)
    if (at + 8 + size > out.length) {
      if (String.fromCharCode(...out.subarray(at, at + 4)) === 'data') {
        view.setUint32(at + 4, out.length - at - 8, true)
      }
      break
    }
    at += 8 + size + (size % 2)
  }
  return out
}

/**
 * 语音参数全部位于 `input`。旧 Qwen-TTS 使用多模态端点，新 Qwen-Audio 使用 SpeechSynthesizer；
 * Next 的正文为 text_prompt，参考音频为 references，且不能传 voice。结构由目录声明。
 * 结果是地址（24 小时有效）或 base64。
 */
export class DashScopeSpeechAdapter implements MediaAdapter {
  readonly kind = 'dashscope_speech' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const format = this.spec.speechFormat
    const next = format === 'qwen-audio-next'
    const params = { ...req.params }
    const outputFormat = this.spec.params.find((p) => p.name === 'format')?.default
    // 画布省略默认值；Flash 实测省略 format 时返回 WAV，与官方默认 MP3 的描述不符。
    // 始终发送目录中的输出格式，保证面板默认值与实际请求一致。
    if (params.format === undefined && outputFormat !== undefined) params.format = outputFormat
    const sampling = this.spec.params.find((p) => p.name === 'sample_rate')
    const input = next
      ? {
          text_prompt: req.prompt,
          ...(req.inputs.length
            ? { references: req.inputs.map((i) => ({ audio_data: dataUri(i.bytes, i.mime) })) }
            : {}),
          ...params,
        }
      : {
          text: req.prompt,
          voice: this.spec.params.find((p) => p.name === 'voice')?.default,
          ...(sampling
            ? {
                sample_rate: resolveMediaParam(
                  sampling,
                  req.operation,
                  mediaParamValues(this.spec.params, params),
                ).default,
              }
            : {}),
          ...params,
        }
    const body = await postJson(
      `${dashScopeBaseUrl(this.profile.baseUrl)}${format ? SPEECH_PATH : SYNC_PATH}`,
      {
        model: this.profile.model,
        input,
      },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      signal,
    )
    const audio = (body.output as { audio?: { url?: unknown; data?: unknown } } | undefined)?.audio
    const raw = (body.usage ?? {}) as Record<string, unknown>
    // 新系列按 Token 计费；Next 的 duration 不能代替 Token。旧系列仍按 characters。
    const usage = defined<MediaUsage>(
      format
        ? {
            inputTokens: count(raw.input_tokens),
            outputTokens: count(raw.output_tokens),
          }
        : { characters: count(raw.characters) },
    )
    if (typeof audio?.url === 'string' && audio.url) {
      const file = await download(audio.url, signal)
      return { files: [{ ...file, bytes: wavWithActualLengths(file.bytes) }], usage }
    }
    if (typeof audio?.data === 'string' && audio.data) {
      const bytes = wavWithActualLengths(new Uint8Array(Buffer.from(audio.data, 'base64')))
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
      const submitted = await postTask(
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
        opts,
        (body) => (body.output as { task_id?: unknown } | undefined)?.task_id,
      )
      taskId = submitted.taskId
    }
    const id = taskId
    const videoInput = req.inputs.some((i) => i.role === 'video')
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => this.check(origin, id, auth, signal), opts)
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
        // 撤销可以重复发送，按查询计时；按生成计时则不设上限，撤销无响应时停止操作随之阻塞。
        { stage: 'query' },
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
      throw new MediaError('任务成功但没有返回视频地址')
    }
    const ended = ENDED[status]
    if (ended) return { state: 'failed', message: failureDetail(out.code, out.message, ended) }
    if (status === 'UNKNOWN') throw new MediaError('任务状态未知，可能不存在或已超过保留期')
    return pendingTask(status, ['PENDING', 'RUNNING'])
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
