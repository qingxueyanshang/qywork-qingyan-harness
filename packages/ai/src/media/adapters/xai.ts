/**
 * xAI 图片编辑使用 JSON；视频使用 request_id 提交与查询。
 *
 * 图片请求固定 `response_format: 'b64_json'`，图片内容随生成响应返回。不要改为默认的 `url`：
 * 该值是 `imgen.x.ai` 上的临时地址，需另行连接下载；客户端无法访问该域名或地址过期时，已计费的结果无法取回。
 */
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, getJson, postJson } from '../http.ts'
import { resolveImages } from '../image-result.ts'
import { afterSubmit, type TaskState, waitTask } from '../task.ts'
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
import { readImages } from './openai-images.ts'

function connection(profile: MediaProfile) {
  const url = new URL(profile.baseUrl?.trim() || 'https://api.x.ai/v1')
  if (url.pathname === '/') url.pathname = '/v1'
  return {
    base: url.href.replace(/\/+$/, ''),
    auth: { authorization: `Bearer ${profile.apiKey}`, ...profile.headers },
  }
}

/** https://docs.x.ai/developers/cost-tracking：1 USD = 10^10 ticks。 */
function usageOf(body: Record<string, unknown>): MediaUsage {
  const usage = body.usage as Record<string, unknown> | undefined
  const ticks = count(usage?.cost_in_usd_ticks)
  return ticks === undefined ? {} : { billed: { amount: ticks / 1e10, currency: 'USD' } }
}

export class XaiImagesAdapter implements MediaAdapter {
  readonly kind = 'xai_images' as const
  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { base, auth } = connection(this.profile)
    const images = req.inputs.map((i) => ({ type: 'image_url', url: dataUri(i.bytes, i.mime) }))
    const body = await postJson(
      `${base}/images/${images.length ? 'edits' : 'generations'}`,
      {
        model: this.profile.model,
        prompt: req.prompt,
        response_format: 'b64_json',
        ...req.params,
        ...(images.length === 1 ? { image: images[0] } : images.length ? { images } : {}),
      },
      auth,
      opts.signal,
    )
    return resolveImages(readImages(body, usageOf(body)), opts)
  }

  resumeImage(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult> {
    return resolveImages(result, opts)
  }
}

export class XaiVideosAdapter implements MediaAdapter {
  readonly kind = 'xai_videos' as const
  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { base, auth } = connection(this.profile)
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const input: Record<string, unknown> = {}
      const references = req.inputs
        .filter((i) => i.role === 'reference')
        .map((i) => ({ url: dataUri(i.bytes, i.mime) }))
      if (references.length) input.reference_images = references
      for (const i of req.inputs) {
        if (i.role === 'first_frame') input.image = { url: dataUri(i.bytes, i.mime) }
        if (i.role === 'last_frame') input.last_frame = { url: dataUri(i.bytes, i.mime) }
      }
      const body = await postJson(
        `${base}/videos/generations`,
        {
          model: this.profile.model,
          prompt: req.prompt,
          ...req.params,
          ...input,
        },
        auth,
        opts.signal,
      )
      if (typeof body.request_id !== 'string' || !body.request_id)
        throw new MediaError('xAI 接口没有返回任务号')
      taskId = body.request_id
      await opts.onTask?.(taskId)
    }
    const id = taskId
    return afterSubmit(id, opts.signal, async () => {
      const done = await waitTask(async (): Promise<TaskState> => {
        const body = await getJson(`${base}/videos/${encodeURIComponent(id)}`, auth, opts.signal)
        const status = String(body.status ?? '')
        if (status === 'done') {
          const video = body.video as Record<string, unknown> | undefined
          if (video?.respect_moderation === false)
            return { state: 'failed', message: 'xAI 视频未通过内容审核' }
          if (typeof video?.url !== 'string')
            return { state: 'failed', message: 'xAI 任务完成但没有返回视频地址' }
          return {
            state: 'done',
            url: video.url,
            usage: {
              ...usageOf(body),
              ...defined<MediaUsage>({ seconds: count(video.duration) }),
            },
          }
        }
        if (status === 'pending' || status === 'processing' || status === 'queued')
          return { state: 'pending', status }
        return {
          state: 'failed',
          message: `xAI ${status || '未知任务状态'}：${JSON.stringify(body.error ?? '').slice(0, 500)}`,
        }
      }, opts)
      const url = new URL(done.url, `${base}/`)
      return {
        files: [
          await download(url.href, opts.signal, url.origin === new URL(base).origin ? auth : {}),
        ],
        ...(done.usage ? { usage: done.usage } : {}),
      }
    })
  }
}
