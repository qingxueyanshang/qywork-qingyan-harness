/**
 * `openai_videos`：中转站的 `/v1/videos`（New API 等按 OpenAI 视频接口的形状转发各家视频模型）。
 *
 * 提交 `POST {base}/videos`，查询 `GET {base}/videos/{id}`，取内容 `GET {base}/videos/{id}/content`
 * （须携带同一个 key）。厂商扩展结构由目录声明，素材与参数按对应结构发送。
 */

import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson } from '../http.ts'
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
import { arkVideoContent } from './ark-videos.ts'
import { dashScopeVideoPayload } from './dashscope.ts'

/** 按目录声明构造已核实的中转请求；未知型号只发送通用字段。 */
async function payloadOf(
  req: MediaRequest,
  spec: MediaModelSpec,
): Promise<Record<string, unknown>> {
  switch (spec.videoFormat) {
    case 'dashscope':
      return { metadata: await dashScopeVideoPayload(req, spec, (i) => dataUri(i.bytes, i.mime)) }
    case 'ark':
      return { metadata: { ...req.params, content: arkVideoContent(req) } }
    case 'veo':
      return {
        ...(req.params.durationSeconds !== undefined
          ? { seconds: String(req.params.durationSeconds) }
          : {}),
        ...(req.inputs.length ? { images: req.inputs.map((i) => dataUri(i.bytes, i.mime)) } : {}),
        metadata: req.params,
      }
    default:
      return req.params
  }
}

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
      const body = await postJson(
        `${base}/videos`,
        {
          model: this.profile.model,
          prompt: req.prompt,
          ...(await payloadOf(req, this.spec)),
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
    // 视频对象只包含时长 `seconds`（字符串），没有用量与金额字段。
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
