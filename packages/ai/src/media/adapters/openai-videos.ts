/**
 * `openai_videos`：中转站的 `/v1/videos`（New API 等按 OpenAI 视频接口的形状转发各家视频模型）。
 *
 * 提交 `POST {base}/videos`，查询 `GET {base}/videos/{id}`，取内容 `GET {base}/videos/{id}/content`
 * （要带同一把 key）。`seconds` 与 `size` 是这个形状自己的字段，放顶层；其余参数是厂商字段，
 * 放进 `metadata` 由中转站原样转给厂商。只做文生，理由见目录的协议默认。
 */

import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, defined, download, getJson, postJson } from '../http.ts'
import { afterSubmit, type TaskState, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

/** OpenAI 视频接口自己的字段。其余参数一律进 `metadata`。 */
const OWN_FIELDS = new Set(['seconds', 'size'])

export class OpenAIVideosAdapter implements MediaAdapter {
  readonly kind = 'openai_videos' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const base = normalizeBaseUrl(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const own: Record<string, unknown> = {}
      const metadata: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(req.params)) {
        if (OWN_FIELDS.has(key)) own[key] = value
        else metadata[key] = value
      }
      const body = await postJson(
        `${base}/videos`,
        {
          model: this.profile.model,
          prompt: req.prompt,
          ...own,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        },
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
      const done = await waitTask(id, () => this.check(base, id, auth, signal), opts)
      return {
        files: [await download(done.url, signal, auth)],
        ...(done.usage ? { usage: done.usage } : {}),
      }
    })
  }

  private async check(
    base: string,
    taskId: string,
    auth: Record<string, string>,
    signal: AbortSignal,
  ): Promise<TaskState> {
    const path = `${base}/videos/${encodeURIComponent(taskId)}`
    const body = await getJson(path, auth, signal)
    const status = String(body.status ?? '')
    // 视频对象只带时长 `seconds`（字符串），没有用量与金额字段。
    if (status === 'completed') {
      return {
        state: 'done',
        url: `${path}/content`,
        usage: defined<MediaUsage>({ seconds: count(body.seconds) }),
      }
    }
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      const error = body.error as { message?: unknown } | undefined
      return { state: 'failed', message: `${status} ${String(error?.message ?? '')}`.trim() }
    }
    return { state: 'pending', status: status || 'queued' }
  }
}
