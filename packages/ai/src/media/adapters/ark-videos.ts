/**
 * `ark_videos`：火山方舟的视频生成任务（Seedance）。
 *
 * 提交 `POST {base}/contents/generations/tasks`，查询 `GET {base}/contents/generations/tasks/{id}`。
 * 输入全放进 `content[]`：文字一条，图片、视频、音频各一条并带 `role`（首帧、尾帧、参考图、参考视频、参考音频）。
 * 参数（分辨率、画幅、时长……）是请求体顶层字段。
 */

import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson, send } from '../http.ts'
import { afterSubmit, type TaskState, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  type MediaCancel,
  MediaError,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

const ROLE: Record<MediaInput['role'], string> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'reference_image',
  video: 'reference_video',
  audio: 'reference_audio',
}

/** 原生与中转共用素材的类型、用途及 Base64 格式。 */
export function arkVideoContent(req: MediaRequest): Record<string, unknown>[] {
  return [
    { type: 'text', text: req.prompt },
    ...req.inputs.map((input) => {
      const type =
        input.role === 'audio' ? 'audio_url' : input.role === 'video' ? 'video_url' : 'image_url'
      const mime = input.mime === 'audio/mpeg' ? 'audio/mp3' : input.mime
      return { type, [type]: { url: dataUri(input.bytes, mime) }, role: ROLE[input.role] }
    }),
  ]
}

/**
 * 任务的计量。计费按 `usage.completion_tokens`（有参考视频时不足最低用量按最低用量回报）；
 * `duration` 是输出秒数，`resolution` 与 `generate_audio` 是实际生成的规格。
 */
function taskUsage(body: Record<string, unknown>): MediaUsage {
  const usage = (body.usage ?? {}) as Record<string, unknown>
  return defined<MediaUsage>({
    outputTokens: count(usage.completion_tokens),
    seconds: count(body.duration),
    resolution: typeof body.resolution === 'string' ? body.resolution.toLowerCase() : undefined,
    audio: typeof body.generate_audio === 'boolean' ? body.generate_audio : undefined,
  })
}

export class ArkVideosAdapter implements MediaAdapter {
  readonly kind = 'ark_videos' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const base = (this.profile.baseUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const body = await postJson(
        `${base}/contents/generations/tasks`,
        { model: this.profile.model, content: arkVideoContent(req), ...req.params },
        auth,
        signal,
      )
      if (typeof body.id !== 'string') {
        throw new MediaError(`接口没有返回任务号：${JSON.stringify(body).slice(0, 300)}`)
      }
      taskId = body.id
      await opts.onTask?.(taskId)
    }
    const id = taskId
    const videoInput = req.inputs.some((i) => i.role === 'video')
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(id, () => this.check(base, id, auth, signal), opts)
      const extra = await Promise.all((done.extra ?? []).map((url) => download(url, signal)))
      return {
        files: [await download(done.url, signal), ...extra],
        usage: { ...done.usage, videoInput },
      }
    })
  }

  /**
   * 撤销任务：`DELETE {base}/contents/generations/tasks/{id}`，方舟只撤得动排队中（`queued`）的任务。
   * 先查状态、排队中才删：同一个接口对已结束的任务是删掉任务记录，结果就取不回了。
   * 删除被拒时再查一次，已不在排队（查询与删除之间开始了）回 `started`，仍在排队原样抛。
   */
  async cancel(taskId: string, signal: AbortSignal): Promise<MediaCancel> {
    const base = (this.profile.baseUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    const queued = async () => {
      const now = await this.check(base, taskId, auth, signal)
      return now.state === 'pending' && now.status === 'queued'
    }
    if (!(await queued())) return 'started'
    try {
      await send(
        `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        { method: 'DELETE', headers: auth },
        signal,
      )
      return 'cancelled'
    } catch (err) {
      if (signal.aborted || !(err instanceof MediaError) || err.status === undefined) throw err
      if (await queued()) throw err
      return 'started'
    }
  }

  private async check(
    base: string,
    taskId: string,
    auth: Record<string, string>,
    signal: AbortSignal,
  ): Promise<TaskState> {
    const body = await getJson(
      `${base}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
      auth,
      signal,
    )
    const status = String(body.status ?? '')
    if (status === 'succeeded') {
      const content = body.content as { video_url?: unknown; last_frame_url?: unknown } | undefined
      const url = content?.video_url
      // 请求里带了 `return_last_frame` 才有尾帧地址，有效期同视频地址。
      const last = content?.last_frame_url
      if (typeof url === 'string') {
        return {
          state: 'done',
          url,
          ...(typeof last === 'string' ? { extra: [last] } : {}),
          usage: taskUsage(body),
        }
      }
      return { state: 'failed', message: '任务成功但没有返回视频地址' }
    }
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      const error = body.error as { code?: unknown; message?: unknown } | undefined
      return {
        state: 'failed',
        message: `${status} ${String(error?.code ?? '')} ${String(error?.message ?? '')}`.trim(),
      }
    }
    return { state: 'pending', status: status || 'queued' }
  }
}
