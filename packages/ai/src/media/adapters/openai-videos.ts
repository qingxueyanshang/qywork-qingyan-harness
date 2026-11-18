/**
 * `openai_videos`：第三方接口的 `/v1/videos`（New API 等按 OpenAI 视频接口的形状转发各家视频模型）。
 *
 * 提交 `POST {base}/videos`，查询 `GET {base}/videos/{id}`，成片从 `GET {base}/videos/{id}/content` 取回。
 * 厂商扩展结构由目录声明，素材与参数按对应结构发送。登记的渠道可另给请求结构与任务查询（`VideoRequestFormat`），
 * 任务的提交、等待与取回仍由本适配器负责。
 */

import { mediaParamValues } from '@qywork/core'
import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson } from '../http.ts'
import {
  afterSubmit,
  failureDetail,
  pendingTask,
  postTask,
  type TaskState,
  waitTask,
} from '../task.ts'
import type {
  MediaAdapter,
  MediaProfile,
  MediaRequest,
  MediaResult,
  MediaRunOptions,
  MediaUsage,
} from '../types.ts'
import { arkVideoContent, ENDED } from './ark-videos.ts'
import { dashScopeVideoPayload } from './dashscope.ts'

/** 一次运行的连接参数，交给请求结构的实现。 */
export interface VideoTaskContext {
  profile: MediaProfile
  spec: MediaModelSpec
  /** 规范化的接口地址（`normalizeBaseUrl`）。 */
  base: string
  auth: Record<string, string>
  signal: AbortSignal
}

/**
 * `/v1/videos` 上的一种请求结构。`payload` 返回 JSON 字段时由适配器补上 `model` 与 `prompt`，返回表单时表单已包含全部字段；
 * `check` 省略时按 `GET {base}/videos/{id}` 查询。`submittedSeconds` 是提交参数中的时长（含目录默认值）。
 */
export interface VideoRequestFormat {
  payload(req: MediaRequest, ctx: VideoTaskContext): Promise<Record<string, unknown> | FormData>
  check?(
    taskId: string,
    ctx: VideoTaskContext,
    submittedSeconds: number | undefined,
  ): Promise<TaskState>
}

/** 按目录声明构造已核实的请求；未知型号只发送通用字段。 */
const CATALOG_FORMAT: VideoRequestFormat = {
  async payload(req, { spec }) {
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
  },
}

/** `GET {base}/videos/{id}` 查询；完成后从 `{id}/content` 取回。 */
async function checkVideo(
  taskId: string,
  { base, auth, signal }: VideoTaskContext,
  submittedSeconds: number | undefined,
): Promise<TaskState> {
  const path = `${base}/videos/${encodeURIComponent(taskId)}`
  const body = await getJson(path, auth, signal)
  const status = String(body.status ?? '')
  // 视频对象只包含时长 `seconds`（字符串），没有用量与金额字段。
  // 部分渠道不返回时长，而按提交的时长计费：此时按提交时长计量。不要留空，按秒计价的型号会因此记为 0。
  if (status === 'completed') {
    return {
      state: 'done',
      url: `${path}/content`,
      usage: defined<MediaUsage>({ seconds: count(body.seconds) ?? submittedSeconds }),
    }
  }
  const ended = ENDED[status]
  if (ended) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined
    return { state: 'failed', message: failureDetail(error?.code, error?.message, ended) }
  }
  return pendingTask(status, ['queued', 'in_progress'])
}

export class OpenAIVideosAdapter implements MediaAdapter {
  readonly kind = 'openai_videos' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
    private readonly format: VideoRequestFormat = CATALOG_FORMAT,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const ctx: VideoTaskContext = {
      profile: this.profile,
      spec: this.spec,
      base: normalizeBaseUrl(this.profile.baseUrl),
      auth: { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      signal,
    }
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const payload = await this.format.payload(req, ctx)
      const submitted = await postTask(
        `${ctx.base}/videos`,
        payload instanceof FormData
          ? payload
          : { model: this.profile.model, prompt: req.prompt, ...payload },
        ctx.auth,
        opts,
        (body) => body.id,
      )
      taskId = submitted.taskId
    }
    const id = taskId
    // 提交参数中的时长（含目录默认值）；取回时由调用方传入任务记录中的提交参数。
    const submittedSeconds = count(mediaParamValues(this.spec.params, req.params).seconds)
    const check = this.format.check ?? checkVideo
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => check(id, ctx, submittedSeconds), opts)
      const url = new URL(done.url)
      return {
        files: [
          await download(url.href, signal, url.origin === new URL(ctx.base).origin ? ctx.auth : {}),
        ],
        ...(done.usage ? { usage: done.usage } : {}),
      }
    })
  }
}

/** 以登记渠道的请求结构构造 `/v1/videos` 的适配器（`registerMediaChannel` 的 `adapter`）。 */
export const openAIVideosAdapter = (
  profile: MediaProfile,
  spec: MediaModelSpec,
  format: VideoRequestFormat,
): MediaAdapter => new OpenAIVideosAdapter(profile, spec, format)
