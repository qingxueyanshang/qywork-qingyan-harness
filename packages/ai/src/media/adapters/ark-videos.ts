/**
 * `ark_videos`：火山方舟的视频生成任务（Seedance）。
 *
 * 提交 `POST {base}/contents/generations/tasks`，查询 `GET {base}/contents/generations/tasks/{id}`。
 * 输入全放进 `content[]`：文字一条，图片与视频各一条并带 `role`（首帧、尾帧、参考图、参考视频）。
 * 参数（分辨率、画幅、时长……）是请求体顶层字段。
 */

import type { MediaModelSpec } from '../catalog.ts'
import { dataUri, download, getJson, postJson } from '../http.ts'
import { afterSubmit, type TaskState, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
} from '../types.ts'

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3'

const ROLE: Record<MediaInput['role'], string> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'reference_image',
  video: 'reference_video',
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
    return afterSubmit(id, signal, async () => {
      const url = await waitTask(id, () => this.check(base, id, auth, signal), opts)
      return { files: [await download(url, signal)] }
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
      if (typeof url === 'string') return { state: 'done', url }
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
