/** xAI 图片编辑使用 JSON；视频使用 request_id 提交与查询。 */
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
        ...req.params,
        ...(images.length === 1 ? { image: images[0] } : images.length ? { images } : {}),
      },
      auth,
      opts.signal,
    )
    const result = await readImages(body, opts.signal)
    return { ...result, usage: { ...usageOf(body), images: result.files.length } }
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
      const done = await waitTask(
        id,
        async (): Promise<TaskState> => {
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
        },
        opts,
      )
      return {
        files: [await download(done.url, opts.signal)],
        ...(done.usage ? { usage: done.usage } : {}),
      }
    })
  }
}
