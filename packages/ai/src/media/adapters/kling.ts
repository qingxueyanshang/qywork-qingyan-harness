/**
 * `kling_videos`：可灵开放平台在路径中指定模型的视频接口。
 *
 * 路径按操作选择：文生视频 `/text-to-video/{model}`，首帧与首尾帧 `/image-to-video/{model}`，参考图 `/omni-video/{model}`。
 * 文生视频只发送 `prompt`；其余操作将文字与图片一起放入 `contents[]`。参数原样放入 `settings`。
 * 查询 `GET /tasks?task_ids={id}`，状态 `submitted / processing / succeeded / failed`，视频位于 `outputs[]` 中 `type: video` 的条目。
 *
 * 鉴权只使用 API Key（`Authorization: Bearer`）。AccessKey / SecretKey 签名只适用于按 `model_name` 字段选择模型的接口，此处不使用。
 * 图片按 base64 发送，不带 `data:` 前缀；视频素材接口只接受 URL，因此该协议不接受参考视频。
 */

import type { Currency } from '@qywork/core'
import type { MediaModelSpec, MediaOperation } from '../catalog.ts'
import { count, defined, download, getJson, postJson } from '../http.ts'
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

const DEFAULT_BASE = 'https://api-beijing.klingai.com'

const CONTENT_TYPE: Partial<Record<MediaInput['role'], string>> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'refer_image',
}

/**
 * 任务的计量。金额取 `billing[]` 中从余额扣除的条目（`charge_type: cash`，`amount` 为实扣金额，`currency` 为 CNY / USD）；
 * 从资源包扣除的条目（`charge_type: unit`）只有单位数、没有金额，不记录金额。秒数取视频条目的 `duration`。
 */
function taskUsage(video: Record<string, unknown>, billing: unknown): MediaUsage {
  const cash = (Array.isArray(billing) ? (billing as Record<string, unknown>[]) : []).filter(
    (b) => b.charge_type === 'cash' && (b.currency === 'CNY' || b.currency === 'USD'),
  )
  const currency = cash[0]?.currency as Currency | undefined
  const amounts = cash.filter((b) => b.currency === currency).map((b) => count(b.amount))
  return defined<MediaUsage>({
    seconds: count(video.duration),
    billed:
      currency && amounts.every((a) => a !== undefined)
        ? { amount: amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0), currency }
        : undefined,
  })
}

function pathOf(operation: MediaOperation): string {
  if (operation === 'text_to_video') return 'text-to-video'
  if (operation === 'image_to_video' || operation === 'first_last_frame') return 'image-to-video'
  return 'omni-video'
}

export class KlingVideosAdapter implements MediaAdapter {
  readonly kind = 'kling_videos' as const

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
      const settings = Object.keys(req.params).length ? { settings: req.params } : {}
      const omni = this.spec.videoFormat === 'kling-omni'
      const payload =
        req.operation === 'text_to_video' && !omni
          ? { prompt: req.prompt, ...settings }
          : {
              contents: [
                { type: 'prompt', text: req.prompt },
                ...req.inputs.map((input) => {
                  const type = CONTENT_TYPE[input.role]
                  if (!type)
                    throw new MediaError('可灵官方接口的视频素材只接受地址，不接受本机文件')
                  return { type, url: Buffer.from(input.bytes).toString('base64') }
                }),
              ],
              ...settings,
            }
      const body = await postJson(
        `${base}/${omni ? 'omni-video' : pathOf(req.operation)}/${encodeURIComponent(this.profile.model)}`,
        payload,
        auth,
        signal,
      )
      const data = body.data as { id?: unknown } | undefined
      if (body.code !== 0 || typeof data?.id !== 'string') {
        throw new MediaError(`接口没有返回任务号：${JSON.stringify(body).slice(0, 300)}`)
      }
      taskId = data.id
      await opts.onTask?.(taskId)
    }
    const id = taskId
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => this.check(base, id, auth, signal), opts)
      return {
        files: [await download(done.url, signal)],
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
    const body = await getJson(`${base}/tasks?task_ids=${encodeURIComponent(taskId)}`, auth, signal)
    const tasks = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []
    const task = tasks.find((t) => t.id === taskId)
    const status = String(task?.status ?? '')
    if (status === 'succeeded') {
      const outputs = Array.isArray(task?.outputs)
        ? (task.outputs as Record<string, unknown>[])
        : []
      const video = outputs.find((o) => o.type === 'video')
      if (typeof video?.url === 'string') {
        return { state: 'done', url: video.url, usage: taskUsage(video, task?.billing) }
      }
      return { state: 'failed', message: '任务成功但没有返回视频地址' }
    }
    if (status === 'failed') {
      return { state: 'failed', message: `failed ${String(task?.message ?? '')}`.trim() }
    }
    return { state: 'pending', status: status || 'submitted' }
  }
}
