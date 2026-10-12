/**
 * `openai_videos`：第三方接口的 `/v1/videos`（New API 等按 OpenAI 视频接口的形状转发各家视频模型）。
 *
 * 提交 `POST {base}/videos`，查询 `GET {base}/videos/{id}`（providerb 为 `GET {base}/video/generations/{id}`），
 * 取内容 `GET {base}/videos/{id}/content`（须携带同一个 key）。厂商扩展结构由目录声明，素材与参数按对应结构发送。
 */

import { basename } from 'node:path'
import { mediaParamValues } from '@qywork/core'
import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, sniffMime } from '../http.ts'
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
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'
import { arkVideoContent, ENDED } from './ark-videos.ts'
import { dashScopeVideoPayload } from './dashscope.ts'

/** 按目录声明构造已核实的第三方请求；未知型号只发送通用字段。 */
async function payloadOf(
  req: MediaRequest,
  spec: MediaModelSpec,
  model: string,
): Promise<Record<string, unknown> | FormData> {
  switch (spec.videoFormat) {
    case 'providerb': {
      const images: string[] = []
      const videos: string[] = []
      const audios: string[] = []
      const form =
        spec.inputs.transport === 'multipart' && req.inputs.some((i) => i.role === 'reference')
          ? new FormData()
          : undefined
      for (const input of req.inputs) {
        if (input.role === 'reference') {
          if (form) {
            form.append(
              'input_reference',
              new Blob([input.bytes], { type: input.mime }),
              basename(input.path),
            )
          } else images.push(dataUri(input.bytes, input.mime))
        } else if (input.role === 'video' && spec.inputs.maxVideos) {
          videos.push(dataUri(input.bytes, input.mime))
        } else if (input.role === 'audio' && spec.inputs.maxAudios) {
          if (sniffMime(input.bytes) !== 'audio/mpeg') {
            throw new MediaError('该模型的参考音频仅支持 MP3，请先转换为 MP3；未提交生成')
          }
          audios.push(dataUri(input.bytes, 'audio/mpeg'))
        } else {
          throw new MediaError('该模型尚未接通此类参考素材；未提交生成')
        }
      }
      // 画布省略处于默认值的参数；该渠道仍显式发送目录中声明的时长和尺寸。
      const fields = {
        ...mediaParamValues(spec.params, req.params),
        ...(images.length ? { images } : {}),
        ...(videos.length ? { videos } : {}),
        ...(audios.length ? { audios } : {}),
      }
      if (!form) return fields
      form.set('model', model)
      form.set('prompt', req.prompt)
      for (const [key, value] of Object.entries(fields)) {
        form.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value))
      }
      return form
    }
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
      const payload = await payloadOf(req, this.spec, this.profile.model)
      const submitted = await postTask(
        `${base}/videos`,
        payload instanceof FormData
          ? payload
          : { model: this.profile.model, prompt: req.prompt, ...payload },
        auth,
        opts,
        (body) => body.id,
      )
      taskId = submitted.taskId
    }
    const id = taskId
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => this.check(base, id, auth, signal), opts)
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
    if (this.spec.videoFormat === 'providerb') {
      // 任务失败时 `/videos/{id}` 只返回「The video generation task failed.」，拒绝原因（如版权保护拒绝）
      // 只在任务接口的 `fail_reason` 中。结果仍从 `/videos/{id}/content` 下载，与该接口的 `result_url` 相同。
      const body = await getJson(
        `${base}/video/generations/${encodeURIComponent(taskId)}`,
        auth,
        signal,
      )
      const task = (body.data ?? {}) as { status?: unknown; fail_reason?: unknown }
      const status = String(task.status ?? '').toLowerCase()
      if (status === 'success') return { state: 'done', url: `${path}/content` }
      if (status === 'failure') {
        return { state: 'failed', message: failureDetail(undefined, task.fail_reason, '任务失败') }
      }
      // providerb 实际返回 NOT_START：任务已创建、尚未开始，继续等待原任务。
      if (status === 'not_start') return { state: 'pending', status: 'queued' }
      return pendingTask(status, [
        'queued',
        'pending',
        'submitted',
        'in_progress',
        'processing',
        'running',
      ])
    }
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
    const ended = ENDED[status]
    if (ended) {
      const error = body.error as { code?: unknown; message?: unknown } | undefined
      return { state: 'failed', message: failureDetail(error?.code, error?.message, ended) }
    }
    return pendingTask(status, ['queued', 'in_progress'])
  }
}
