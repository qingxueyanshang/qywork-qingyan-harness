/**
 * `ark_videos`：火山方舟的视频生成任务（Seedance）。
 *
 * 提交 `POST {base}/contents/generations/tasks`，查询 `GET {base}/contents/generations/tasks/{id}`。
 * 输入全放进 `content[]`：文字一条，图片与视频各一条并带 `role`（首帧、尾帧、参考图、参考视频）。
 * 参数（分辨率、画幅、时长……）是请求体顶层字段。
 */

import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson } from '../http.ts'
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

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

const ROLE: Record<MediaInput['role'], string> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'reference_image',
  video: 'reference_video',
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
      const content: Record<string, unknown>[] = [{ type: 'text', text: req.prompt }]
      for (const input of req.inputs) {
        const url = dataUri(input.bytes, input.mime)
        content.push(
          input.role === 'video'
            ? { type: 'video_url', video_url: { url }, role: ROLE.video }
            : { type: 'image_url', image_url: { url }, role: ROLE[input.role] },
        )
      }
      const body = await postJson(
        `${base}/contents/generations/tasks`,
        { model: this.profile.model, content, ...req.params },
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
      return { files: [await download(done.url, signal)], usage: { ...done.usage, videoInput } }
    })
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
      const url = (body.content as { video_url?: unknown } | undefined)?.video_url
      if (typeof url === 'string') return { state: 'done', url, usage: taskUsage(body) }
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
