/**
 * `openai_videos`：中转站的 `/v1/videos`（New API 等按 OpenAI 视频接口的形状转发各家视频模型）。
 *
 * 提交 `POST {base}/videos`，查询 `GET {base}/videos/{id}`（Mumugofe 为 `GET {base}/video/generations/{id}`），
 * 通用视频从 `GET {base}/videos/{id}/content` 取回，Mumugofe 使用上游回执的 `download_url`。
 * 厂商扩展结构由目录声明，素材与参数按对应结构发送。
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
import { hongchengVideoPayload } from './hongcheng.ts'
import { mumugofeBilled, uploadMumugofeReference } from './mumugofe.ts'

/**
 * 按目录声明构造已核实的中转请求；未知型号只发送通用字段。
 * 返回 JSON 字段时由调用方补上 `model` 与 `prompt`；返回表单时表单已包含全部字段。
 */
async function payloadOf(
  req: MediaRequest,
  spec: MediaModelSpec,
  profile: MediaProfile,
  signal: AbortSignal,
): Promise<Record<string, unknown> | FormData> {
  switch (spec.videoFormat) {
    case 'mumugofe': {
      const images: string[] = []
      const videos: string[] = []
      const audios: string[] = []
      // 先校验完整输入，避免后续素材无效时已上传前面的文件。
      for (const input of req.inputs) {
        if (
          !(
            (input.role === 'reference' && spec.inputs.maxImages) ||
            (input.role === 'video' && spec.inputs.maxVideos) ||
            (input.role === 'audio' && spec.inputs.maxAudios)
          )
        )
          throw new MediaError('该模型尚未接通此类参考素材；未提交生成')
        if (input.role === 'audio' && sniffMime(input.bytes) !== 'audio/mpeg')
          throw new MediaError('该模型的参考音频仅支持 MP3，请先转换为 MP3；未提交生成')
      }
      // 画布省略处于默认值的参数；该渠道仍显式发送目录中声明的时长和尺寸。
      const params = mediaParamValues(spec.params, req.params)
      const resolution = spec.resolutionBySize?.[String(params.size)]
      const fields = resolution ? { ...params, resolution } : params
      // 表单提交：参数为文本字段，参考图逐张放入同名文件字段 `input_reference`。没有参考素材时按 JSON 提交。
      if (spec.inputs.transport === 'multipart' && req.inputs.length) {
        const form = new FormData()
        form.set('model', profile.model)
        form.set('prompt', req.prompt)
        for (const [key, value] of Object.entries(fields)) form.set(key, String(value))
        for (const input of req.inputs)
          form.append(
            'input_reference',
            new Blob([input.bytes], { type: input.mime }),
            basename(input.path),
          )
        return form
      }
      for (const input of req.inputs) {
        const value = spec.inputs.publicUrls
          ? await uploadMumugofeReference(
              input,
              normalizeBaseUrl(profile.baseUrl),
              { authorization: `Bearer ${profile.apiKey}`, ...profile.headers },
              signal,
            )
          : dataUri(input.bytes, input.role === 'audio' ? 'audio/mpeg' : input.mime)
        if (input.role === 'reference' && spec.inputs.maxImages) {
          images.push(value)
        } else if (input.role === 'video' && spec.inputs.maxVideos) {
          videos.push(value)
        } else if (input.role === 'audio' && spec.inputs.maxAudios) {
          audios.push(value)
        }
      }
      return {
        ...fields,
        ...(images.length ? { images } : {}),
        ...(videos.length ? { videos } : {}),
        ...(audios.length ? { audios } : {}),
      }
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
      const payload =
        this.spec.videoFormat === 'hongcheng'
          ? await hongchengVideoPayload(req, this.spec, base, auth, signal)
          : await payloadOf(req, this.spec, this.profile, signal)
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
    const submittedSeconds = count(mediaParamValues(this.spec.params, req.params).seconds)
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => this.check(base, id, auth, signal, submittedSeconds), opts)
      const url = new URL(done.url)
      return {
        files: [await download(url.href, signal, url.origin === new URL(base).origin ? auth : {})],
        ...(done.usage ? { usage: done.usage } : {}),
      }
    })
  }

  /** `submittedSeconds`：提交参数中的时长（含目录默认值），取回时由调用方传入任务记录中的提交参数。 */
  private async check(
    base: string,
    taskId: string,
    auth: Record<string, string>,
    signal: AbortSignal,
    submittedSeconds: number | undefined,
  ): Promise<TaskState> {
    const path = `${base}/videos/${encodeURIComponent(taskId)}`
    if (this.spec.videoFormat === 'mumugofe') {
      // 任务失败时 `/videos/{id}` 只返回「The video generation task failed.」，拒绝原因（如版权保护拒绝）
      // 只在任务接口的 `fail_reason` 中。成功后按上游回执的下载直链取回，避免经过渠道的内容转发接口。
      // 扣费取任务记录的 `quota`：各上游回执中的时长、尺寸字段不一致，常常缺失。
      const body = await getJson(
        `${base}/video/generations/${encodeURIComponent(taskId)}`,
        auth,
        signal,
      )
      const task = (body.data ?? {}) as {
        status?: unknown
        fail_reason?: unknown
        quota?: unknown
        data?: { download_url?: unknown; duration?: unknown }
      }
      const status = String(task.status ?? '').toLowerCase()
      if (status === 'success') {
        const value = task.data?.download_url
        const url = typeof value === 'string' ? URL.parse(value) : null
        if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw new MediaError('任务成功但未返回有效成片地址')
        const quota = typeof task.quota === 'number' && task.quota > 0 ? task.quota : undefined
        const billed = quota === undefined ? undefined : await mumugofeBilled(base, quota, signal)
        return {
          state: 'done',
          url: url.href,
          usage: defined<MediaUsage>({ seconds: count(task.data?.duration), billed }),
        }
      }
      if (status === 'failure') {
        return { state: 'failed', message: failureDetail(undefined, task.fail_reason, '任务失败') }
      }
      // Mumugofe 实际返回 NOT_START：任务已创建、尚未开始，继续等待原任务。
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
}
