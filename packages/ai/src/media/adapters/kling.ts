/**
 * `kling_videos`：可灵开放平台按路径带模型的视频接口。
 *
 * 路径按操作选：文生 `/text-to-video/{model}`，首帧与首尾帧 `/image-to-video/{model}`，参考图 `/omni-video/{model}`。
 * 文生只发 `prompt`；其余把文字与图片一起放进 `contents[]`。参数原样放进 `settings`。
 * 查询 `GET /tasks?task_ids={id}`，状态 `submitted / processing / succeeded / failed`，视频在 `outputs[]` 里 `type: video` 那一项。
 *
 * 鉴权只用 API Key（`Authorization: Bearer`）。AccessKey / SecretKey 签名只适用于按 `model_name` 字段选模型的那组接口，这里不走。
 * 图片按 base64 发，不带 `data:` 前缀；视频素材接口只收 URL，所以这条协议不收参考视频。
 */

import type { MediaModelSpec, MediaOperation } from '../catalog.ts'
import { download, getJson, postJson } from '../http.ts'
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

const DEFAULT_BASE = 'https://api-beijing.klingai.com'

const CONTENT_TYPE: Partial<Record<MediaInput['role'], string>> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'refer_image',
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
      const payload =
        req.operation === 'text_to_video'
          ? { prompt: req.prompt, ...settings }
          : {
              contents: [
                { type: 'prompt', text: req.prompt },
                ...req.inputs.map((input) => {
                  const type = CONTENT_TYPE[input.role]
                  if (!type) throw new MediaError('可灵官方接口的视频素材只收地址，不收本机文件')
                  return { type, url: Buffer.from(input.bytes).toString('base64') }
                }),
              ],
              ...settings,
            }
      const body = await postJson(
        `${base}/${pathOf(req.operation)}/${encodeURIComponent(this.profile.model)}`,
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
    const body = await getJson(`${base}/tasks?task_ids=${encodeURIComponent(taskId)}`, auth, signal)
    const tasks = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []
    const task = tasks.find((t) => t.id === taskId)
    const status = String(task?.status ?? '')
    if (status === 'succeeded') {
      const outputs = Array.isArray(task?.outputs)
        ? (task.outputs as Record<string, unknown>[])
        : []
      const url = outputs.find((o) => o.type === 'video')?.url
      if (typeof url === 'string') return { state: 'done', url }
      return { state: 'failed', message: '任务成功但没有返回视频地址' }
    }
    if (status === 'failed') {
      return { state: 'failed', message: `failed ${String(task?.message ?? '')}`.trim() }
    }
    return { state: 'pending', status: status || 'submitted' }
  }
}
