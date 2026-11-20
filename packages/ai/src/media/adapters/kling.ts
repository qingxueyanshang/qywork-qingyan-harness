/**
 * 可灵开放平台在路径中指定模型的接口：`kling_videos` 视频，`kling_images` 图像。
 *
 * 视频路径按操作选择：文生视频 `/text-to-video/{model}`，首帧与首尾帧 `/image-to-video/{model}`，参考图 `/omni-video/{model}`。
 * 文生视频只发送 `prompt`；其余操作将文字与图片一起放入 `contents[]`。
 * 图像只有 `/image-generation/{model}`：文字与参考图都放入 `contents[]`，参考图的 `id` 依次为 `ref_1`、`ref_2`…，
 * 提示词以 `@ref_1` 指代（目录的 `mention` 与此一致）。参数原样放入 `settings`。
 * 查询 `GET /tasks?task_ids={id}`，状态 `submitted / processing / succeeded / failed`，产物位于 `outputs[]`，按 `type` 区分视频与图片。
 *
 * 提交与查询的失败以 HTTP 状态码与正文的业务码 `code` 同时报告，业务码按可灵的错误码归类（`upstreamFailureCode`）：
 * 429 同时用于限流、欠费与账户异常。
 * 鉴权只使用 API Key（`Authorization: Bearer`）。AccessKey / SecretKey 签名只适用于按 `model_name` 字段选择模型的接口，此处不使用。
 * 图片按 base64 发送，不带 `data:` 前缀；视频素材接口只接受 URL，因此视频协议不接受参考视频。
 */

import type { Currency, MediaOperation } from '@qywork/core'
import type { MediaModelSpec } from '../catalog.ts'
import { count, defined, download, getJson } from '../http.ts'
import { resolveImages } from '../image-result.ts'
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
  type MediaImageResult,
  type MediaInput,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

const DEFAULT_BASE = 'https://api-beijing.klingai.com'

/** 提交与查询的业务码按可灵的错误码归类（`upstreamFailureCode`）。 */
const UPSTREAM = { vendor: 'kling' } as const

const CONTENT_TYPE: Partial<Record<MediaInput['role'], string>> = {
  first_frame: 'first_frame',
  last_frame: 'last_frame',
  reference: 'refer_image',
}

interface Connection {
  base: string
  auth: Record<string, string>
}

function connection(profile: MediaProfile): Connection {
  return {
    base: (profile.baseUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_BASE,
    auth: { authorization: `Bearer ${profile.apiKey}`, ...profile.headers },
  }
}

const base64 = (input: MediaInput) => Buffer.from(input.bytes).toString('base64')
const settingsOf = (params: Record<string, unknown>) =>
  Object.keys(params).length ? { settings: params } : {}

/** 提交到 `{path}/{model}`，返回任务号。正文的业务码不为 0 时按接口拒绝处理。 */
async function submitTask(
  conn: Connection,
  path: string,
  model: string,
  payload: Record<string, unknown>,
  opts: MediaRunOptions,
): Promise<string> {
  const submitted = await postTask(
    `${conn.base}/${path}/${encodeURIComponent(model)}`,
    payload,
    conn.auth,
    opts,
    (body) => (body.code === 0 ? (body.data as { id?: unknown } | undefined)?.id : undefined),
    {
      ...UPSTREAM,
      refused: (body) =>
        typeof body.code === 'number' && body.code !== 0
          ? `接口拒绝生成：${failureDetail(body.code, body.message, '未提供原因')}`
          : undefined,
    },
  )
  return submitted.taskId
}

/** 等待任务结束，返回成功的任务。 */
function waitSucceeded(
  conn: Connection,
  taskId: string,
  opts: MediaRunOptions,
): Promise<{ task: Record<string, unknown> }> {
  return waitTask(async (): Promise<TaskState<{ task: Record<string, unknown> }>> => {
    const body = await getJson(
      `${conn.base}/tasks?task_ids=${encodeURIComponent(taskId)}`,
      conn.auth,
      opts.signal,
      { upstream: UPSTREAM },
    )
    const tasks = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []
    const task = tasks.find((t) => t.id === taskId)
    const status = String(task?.status ?? '')
    if (task && status === 'succeeded') return { state: 'done', task }
    if (status === 'failed') {
      return { state: 'failed', message: failureDetail(undefined, task?.message, '任务失败') }
    }
    return pendingTask(status, ['submitted', 'processing'])
  }, opts)
}

/** 任务 `outputs[]` 中该类型且带地址的产物。 */
function outputsOf(
  task: Record<string, unknown>,
  type: 'video' | 'image',
): (Record<string, unknown> & { url: string })[] {
  const outputs = Array.isArray(task.outputs) ? (task.outputs as Record<string, unknown>[]) : []
  return outputs.flatMap((o) =>
    o.type === type && typeof o.url === 'string' && o.url ? [{ ...o, url: o.url }] : [],
  )
}

/**
 * 实际扣费金额：`billing[]` 中从余额扣除的条目（`charge_type: cash`，`amount` 为实扣金额，`currency` 为 CNY / USD）之和；
 * 从资源包扣除的条目（`charge_type: unit`）只有单位数、没有金额，不记录金额。
 */
function billedOf(billing: unknown): MediaUsage['billed'] {
  const cash = (Array.isArray(billing) ? (billing as Record<string, unknown>[]) : []).filter(
    (b) => b.charge_type === 'cash' && (b.currency === 'CNY' || b.currency === 'USD'),
  )
  const currency = cash[0]?.currency as Currency | undefined
  const amounts = cash.filter((b) => b.currency === currency).map((b) => count(b.amount))
  return currency && amounts.every((a) => a !== undefined)
    ? { amount: amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0), currency }
    : undefined
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
    const conn = connection(this.profile)
    let taskId = opts.resumeTaskId
    if (!taskId) {
      const omni = this.spec.videoFormat === 'kling-omni'
      const payload =
        req.operation === 'text_to_video' && !omni
          ? { prompt: req.prompt, ...settingsOf(req.params) }
          : {
              contents: [
                { type: 'prompt', text: req.prompt },
                ...req.inputs.map((input) => {
                  const type = CONTENT_TYPE[input.role]
                  if (!type)
                    throw new MediaError('可灵官方接口的视频素材只接受地址，不接受本机文件')
                  return { type, url: base64(input) }
                }),
              ],
              ...settingsOf(req.params),
            }
      const path = omni ? 'omni-video' : pathOf(req.operation)
      taskId = await submitTask(conn, path, this.profile.model, payload, opts)
    }
    const id = taskId
    return afterSubmit(id, opts.signal, async () => {
      const { task } = await waitSucceeded(conn, id, opts)
      const video = outputsOf(task, 'video')[0]
      if (!video) throw new MediaError('任务成功但没有返回视频地址')
      return {
        files: [await download(video.url, opts.signal)],
        usage: defined<MediaUsage>({
          seconds: count(video.duration),
          billed: billedOf(task.billing),
        }),
      }
    })
  }
}

/** 只使用单张模式：不发送 `result_type`，张数由 `n` 决定。 */
export class KlingImagesAdapter implements MediaAdapter {
  readonly kind = 'kling_images' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const conn = connection(this.profile)
    const id =
      opts.resumeTaskId ??
      (await submitTask(
        conn,
        'image-generation',
        this.profile.model,
        {
          contents: [
            { type: 'prompt', text: req.prompt },
            ...req.inputs.map((input, n) => ({
              type: 'refer_image',
              url: base64(input),
              id: `ref_${n + 1}`,
            })),
          ],
          ...settingsOf(req.params),
        },
        opts,
      ))
    return afterSubmit(id, opts.signal, async () => {
      const { task } = await waitSucceeded(conn, id, opts)
      const images = outputsOf(task, 'image')
      if (!images.length) throw new MediaError('任务成功但没有返回图片')
      return resolveImages(
        {
          sources: images.map((o) => ({ url: o.url })),
          usage: defined<MediaUsage>({ images: images.length, billed: billedOf(task.billing) }),
        },
        opts,
      )
    })
  }

  resumeImage(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult> {
    return resolveImages(result, opts)
  }
}
