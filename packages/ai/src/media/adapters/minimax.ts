/**
 * MiniMax 开放平台的三种生成协议。Base URL 为 `https://api.minimax.cn/v1` 一类带版本段的地址。
 *
 * `minimax_speech`：同步语音合成 `POST {base}/t2a_v2`，非流式。目录参数平铺，按接口结构放入 `voice_setting` 与
 * `audio_setting`，其余放在请求体顶层。音频为 hex 编码。按 `extra_info.usage_characters` 计费。
 *
 * `minimax_images`：同步图像生成 `POST {base}/image_generation`，结果为 24 小时有效的地址。
 *
 * `minimax_videos`：视频生成 V2，路径不在版本段之下：提交 `POST {根}/v2/video_generation`，
 * 查询 `GET {根}/v2/query/video_generation/{id}`。素材结构与方舟相同，见 `arkVideoContent`。
 *
 * 语音与图像在 HTTP 200 时 `base_resp.status_code` 非 0 仍是失败；视频接口以 HTTP 状态码报告失败。
 */

import { resolveMediaParam } from '@qywork/core'
import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson, sniffMime } from '../http.ts'
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
  MediaError,
  type MediaImageResult,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'
import { arkVideoContent } from './ark-videos.ts'

const VOICE_FIELDS = ['voice_id', 'speed', 'vol', 'pitch', 'emotion']
const AUDIO_FIELDS = ['format', 'sample_rate', 'bitrate', 'channel']

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
}

function auth(profile: MediaProfile): Record<string, string> {
  return { authorization: `Bearer ${profile.apiKey}`, ...profile.headers }
}

/** `base_resp.status_code` 非 0 时抛出接口原文。 */
function rejectStatus(body: Record<string, unknown>): void {
  const status = body.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined
  if (typeof status?.status_code === 'number' && status.status_code !== 0)
    throw new MediaError(
      `接口拒绝生成：${failureDetail(status.status_code, status.status_msg, '未提供原因')}`,
    )
}

export class MiniMaxSpeechAdapter implements MediaAdapter {
  readonly kind = 'minimax_speech' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const rest: Record<string, unknown> = { ...req.params }
    // 音色必填；画布省略默认值时发送目录中的默认音色。
    rest.voice_id ??= this.spec.params.find((p) => p.name === 'voice_id')?.default
    const take = (fields: readonly string[]) => {
      const out: Record<string, unknown> = {}
      for (const f of fields) {
        if (rest[f] !== undefined) out[f] = rest[f]
        delete rest[f]
      }
      return out
    }
    const voice = take(VOICE_FIELDS)
    const audio = take(AUDIO_FIELDS)
    const body = await postJson(
      `${normalizeBaseUrl(this.profile.baseUrl)}/t2a_v2`,
      {
        model: this.profile.model,
        text: req.prompt,
        stream: false,
        voice_setting: voice,
        ...(Object.keys(audio).length ? { audio_setting: audio } : {}),
        ...rest,
      },
      auth(this.profile),
      opts.signal,
    )
    rejectStatus(body)
    const hex = (body.data as { audio?: unknown } | null | undefined)?.audio
    if (typeof hex !== 'string' || !hex) throw new MediaError('接口没有返回音频')
    const bytes = new Uint8Array(Buffer.from(hex, 'hex'))
    const extra = body.extra_info as
      | { usage_characters?: unknown; audio_format?: unknown }
      | undefined
    const format = String(extra?.audio_format ?? audio.format ?? 'mp3')
    return {
      files: [{ bytes, mime: sniffMime(bytes) ?? FORMAT_MIME[format] ?? 'audio/mpeg' }],
      usage: defined<MediaUsage>({ characters: count(extra?.usage_characters) }),
    }
  }
}

/**
 * 参考图作为人物主体参考（`subject_reference`，类型 `character`）发送。
 * `metadata.failed_count` 是未通过内容安全检查的张数：有其余产物时作为警告交回，全部未通过时报错。
 */
export class MiniMaxImagesAdapter implements MediaAdapter {
  readonly kind = 'minimax_images' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { style_type, ...rest } = req.params
    const body = await postJson(
      `${normalizeBaseUrl(this.profile.baseUrl)}/image_generation`,
      {
        model: this.profile.model,
        prompt: req.prompt,
        ...rest,
        ...(style_type !== undefined ? { style: { style_type } } : {}),
        ...(req.inputs.length
          ? {
              subject_reference: req.inputs.map((i) => ({
                type: 'character',
                image_file: dataUri(i.bytes, i.mime),
              })),
            }
          : {}),
      },
      auth(this.profile),
      opts.signal,
    )
    rejectStatus(body)
    const listed = (body.data as { image_urls?: unknown } | null | undefined)?.image_urls
    const urls = Array.isArray(listed)
      ? listed.filter((u): u is string => typeof u === 'string')
      : []
    const meta = body.metadata as { success_count?: unknown; failed_count?: unknown } | undefined
    const failed = count(meta?.failed_count) ?? 0
    const blocked = `${failed} 张图片未通过内容安全检查`
    if (!urls.length) throw new MediaError(failed ? blocked : '接口没有返回图片')
    return resolveImages(
      {
        sources: urls.map((url) => ({ url })),
        usage: { images: count(meta?.success_count) ?? urls.length },
        ...(failed ? { warning: blocked } : {}),
      },
      opts,
    )
  }

  resumeImage(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult> {
    return resolveImages(result, opts)
  }
}

/** 任务的终止状态及其说明，没有错误内容时显示。 */
const ENDED: Record<string, string> = {
  failed: '任务失败',
  cancelled: '任务已取消',
}

/** `extra` 只接受 `prompt_expansion_mode`，其余参数位于请求体顶层。 */
const EXTRA_FIELDS = ['prompt_expansion_mode']

/** 分辨率、时长为必填字段，文生视频还须指定画幅；画布省略的取值按当前操作的目录缺省值补齐。 */
const REQUIRED = ['resolution', 'duration', 'ratio']

/**
 * 查询结果中 `usage.output_seconds` 是输出秒数，`input_seconds` 是参考视频秒数，
 * `input_image_count` 含首尾帧与参考图。`resolution` 为 `768P` / `2K` 等，统一为小写。
 */
function taskUsage(task: Record<string, unknown>): MediaUsage {
  const usage = (task.usage ?? {}) as Record<string, unknown>
  return defined<MediaUsage>({
    seconds: count(usage.output_seconds),
    inputSeconds: count(usage.input_seconds),
    inputImages: count(usage.input_image_count),
    resolution: typeof task.resolution === 'string' ? task.resolution.toLowerCase() : undefined,
  })
}

export class MiniMaxVideosAdapter implements MediaAdapter {
  readonly kind = 'minimax_videos' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  /** 版本段之上的根地址：`https://api.minimax.cn/v1` → `https://api.minimax.cn`。 */
  private root(): string {
    return normalizeBaseUrl(this.profile.baseUrl).replace(/\/v1$/i, '')
  }

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const root = this.root()
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const params: Record<string, unknown> = { ...req.params }
      for (const p of this.spec.params) {
        if (!REQUIRED.includes(p.name) || params[p.name] !== undefined) continue
        const value = resolveMediaParam(p, req.operation, params).default
        if (value !== undefined) params[p.name] = value
      }
      const extra: Record<string, unknown> = {}
      for (const f of EXTRA_FIELDS) {
        if (params[f] !== undefined) extra[f] = params[f]
        delete params[f]
      }
      const submitted = await postTask(
        `${root}/v2/video_generation`,
        {
          model: this.profile.model,
          content: arkVideoContent(req),
          ...params,
          ...(Object.keys(extra).length ? { extra } : {}),
        },
        auth(this.profile),
        opts,
        (body) => body.task_id,
      )
      taskId = submitted.taskId
    }
    const id = taskId
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => this.check(root, id, signal), opts)
      return {
        files: [await download(done.url, signal)],
        ...(done.usage ? { usage: done.usage } : {}),
      }
    })
  }

  private async check(root: string, taskId: string, signal: AbortSignal): Promise<TaskState> {
    const body = await getJson(
      `${root}/v2/query/video_generation/${encodeURIComponent(taskId)}`,
      auth(this.profile),
      signal,
    )
    const task = (body.task ?? {}) as Record<string, unknown>
    const status = String(task.status ?? '')
    if (status === 'succeeded') {
      const url = (task.content as { url?: unknown } | undefined)?.url
      if (typeof url === 'string') return { state: 'done', url, usage: taskUsage(task) }
      throw new MediaError('任务成功但没有返回视频地址')
    }
    const ended = ENDED[status]
    if (ended) {
      const error = task.error as { code?: unknown; message?: unknown } | undefined
      return { state: 'failed', message: failureDetail(error?.code, error?.message, ended) }
    }
    return pendingTask(status, ['queued', 'running'])
  }
}
