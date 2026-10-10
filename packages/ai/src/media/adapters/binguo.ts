/** 集梦的视频任务与同源素材上传；任务恢复共用现有 afterSubmit / waitTask。 */
import { basename } from 'node:path'
import { videoMetadataOf } from '@qywork/core'
import type { MediaModelSpec } from '../catalog.ts'
import { count, defined, download, getJson, postJson, sendJson } from '../http.ts'
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

function endpoint(profile: MediaProfile) {
  const root = (profile.baseUrl?.trim() || 'https://binguofilm.com')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
  return {
    root,
    base: `${root}/v1`,
    auth: { authorization: `Bearer ${profile.apiKey}`, ...profile.headers },
  }
}

function resultUrl(value: unknown, root: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MediaError('集梦没有返回结果地址')
  const url = new URL(value, `${root}/`)
  if (!['http:', 'https:'].includes(url.protocol)) throw new MediaError('集梦返回的地址协议无效')
  return url.href
}

function usageOf(body: Record<string, unknown>): MediaUsage {
  const cost = count(body.cost)
  return defined<MediaUsage>({
    billed: cost === undefined ? undefined : { amount: cost, currency: 'BINGUO_CREDIT' },
    seconds: count(body.duration),
    resolution: typeof body.resolution === 'string' ? body.resolution : undefined,
  })
}

export class BinguoAdapter implements MediaAdapter {
  readonly kind = 'binguo_videos'

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  private async read(url: string, signal: AbortSignal) {
    const { root, auth } = endpoint(this.profile)
    const target = resultUrl(url, root)
    return download(target, signal, new URL(target).origin === new URL(root).origin ? auth : {})
  }

  private async payload(
    req: MediaRequest,
    opts: MediaRunOptions,
  ): Promise<Record<string, unknown>> {
    if (req.inputs.some((input) => input.role === 'first_frame' || input.role === 'last_frame')) {
      throw new MediaError('集梦接口仅支持参考素材，不支持首尾帧控制')
    }
    const { root, auth } = endpoint(this.profile)
    const images: string[] = []
    const videos: string[] = []
    const audios: string[] = []
    const durations: number[] = []
    for (const input of req.inputs) {
      const seconds = input.role === 'video' ? videoMetadataOf(input.bytes)?.duration : null
      if (input.role === 'video' && !(seconds && Number.isFinite(seconds) && seconds > 0))
        throw new MediaError('参考视频须为可读取有效时长的 MP4 / MOV 文件，未提交生成')
      const form = new FormData()
      form.append('file', new Blob([input.bytes], { type: input.mime }), basename(input.path))
      // 网站公开客户端使用此端点；视频时长由本地容器读取，上传响应不保证提供时长。
      const uploaded = await sendJson(
        `${root}/api/media/upload`,
        { method: 'POST', headers: auth, body: form },
        opts.signal,
        { stage: 'upload' },
      )
      const url = resultUrl(uploaded.url, root)
      if (input.role === 'video') {
        videos.push(url)
        durations.push(Math.ceil(seconds!))
      } else if (input.role === 'audio') audios.push(url)
      else images.push(url)
    }
    return {
      model: this.profile.model,
      prompt: req.prompt,
      ...req.params,
      ...(images.length ? { extra_images: images } : {}),
      ...(videos.length ? { extra_videos: videos, extra_video_durations: durations } : {}),
      ...(audios.length ? { extra_audios: audios } : {}),
    }
  }

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { base, auth, root } = endpoint(this.profile)
    const path = `${base}/videos`
    let id = opts.resumeTaskId
    if (!id) {
      const body = await postJson(path, await this.payload(req, opts), auth, opts.signal)
      if (typeof body.task_id !== 'string' || !body.task_id)
        throw new MediaError('集梦没有返回任务号')
      id = body.task_id
      await opts.onTask?.(id)
    }
    const taskId = id
    return afterSubmit(taskId, opts.signal, async () => {
      const done = await waitTask<{ body: Record<string, unknown> }>(
        async (): Promise<TaskState<{ body: Record<string, unknown> }>> => {
          const body = await getJson(`${path}/${encodeURIComponent(taskId)}`, auth, opts.signal)
          switch (body.status) {
            case 'completed':
              if (body.video_expired === true)
                return { state: 'failed', message: '视频已超过保留期，结果已清理' }
              return { state: 'done', body }
            case 'failed':
              return {
                state: 'failed',
                message: typeof body.error === 'string' ? body.error : '集梦未提供失败原因',
              }
            case 'queued':
            case 'in_progress':
              return { state: 'pending', status: body.status }
            default:
              throw new MediaError(`集梦返回无法识别的任务状态：${String(body.status)}`)
          }
        },
        opts,
      )
      const usage = usageOf(done.body)
      return { files: [await this.read(resultUrl(done.body.video_url, root), opts.signal)], usage }
    })
  }
}
