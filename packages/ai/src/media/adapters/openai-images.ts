/**
 * `openai_images`：OpenAI 形状的图片生成接口 `/images/generations` 与 `/images/edits`。
 *
 * OpenAI、中转站、火山方舟 Seedream、百炼兼容接口共用此形状，差别只有两处，均由目录声明：
 * 参考图使用 multipart `/edits`（OpenAI、New API）还是 JSON 的 `image` 字段（火山、百炼兼容）；
 * 结果位于 `b64_json`（GPT Image 只返回该字段）还是 `url`（百炼兼容只返回该字段），两者都读取。
 *
 * **不发送 `response_format`**：GPT Image 不接受该字段，发送后整个请求被拒绝；其余两家默认返回 url，直接读取即可。
 *
 * Mumugofe（`imageFormat`）另有一种结构：JSON 提交到 `/images/generations`，参考图为 `images` 中的数据地址，
 * 请求异步任务并按 `/images/generations/tasks/{id}` 查询；直接出图的型号同步返回图片，没有任务号。
 */

import { basename } from 'node:path'
import { mediaParamValues } from '@qywork/core'
import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, getJson, postJson, sendJson } from '../http.ts'
import { resolveImages } from '../image-result.ts'
import { afterSubmit, failureDetail, pendingTask, type TaskState, waitTask } from '../task.ts'
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

export class OpenAIImagesAdapter implements MediaAdapter {
  readonly kind = 'openai_images' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    if (this.spec.imageFormat === 'mumugofe') return this.runMumugofe(req, opts)
    const { signal } = opts
    const base = normalizeBaseUrl(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    const multipart = req.inputs.length > 0 && this.spec.inputs.transport === 'multipart'

    let body: Record<string, unknown>
    if (multipart) {
      const form = new FormData()
      form.set('model', this.profile.model)
      form.set('prompt', req.prompt)
      for (const input of req.inputs) {
        form.append('image[]', new Blob([input.bytes], { type: input.mime }), basename(input.path))
      }
      for (const [key, value] of Object.entries(req.params)) form.set(key, String(value))
      body = await sendJson(
        `${base}/images/edits`,
        { method: 'POST', headers: auth, body: form },
        signal,
      )
    } else {
      body = await postJson(
        `${base}/images/generations`,
        {
          model: this.profile.model,
          prompt: req.prompt,
          ...(req.inputs.length ? { image: req.inputs.map((i) => dataUri(i.bytes, i.mime)) } : {}),
          ...req.params,
        },
        auth,
        signal,
      )
    }
    const result = readImages(body)
    result.usage = readUsage(body, result.sources.length)
    return resolveImages(result, opts)
  }

  resumeImage(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult> {
    return resolveImages(result, opts)
  }

  /** 渠道按请求中的 `n` 与 `resolution` 计价：每次一张，计量取发送的分辨率档位。 */
  private async runMumugofe(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const base = normalizeBaseUrl(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    const params = mediaParamValues(this.spec.params, req.params)
    const usage: MediaUsage = {
      images: 1,
      ...(typeof params.resolution === 'string' ? { resolution: params.resolution } : {}),
    }
    let taskId = opts.resumeTaskId
    if (!taskId) {
      if (req.inputs.some((i) => i.role !== 'reference'))
        throw new MediaError('该模型只接受参考图；未提交生成')
      signal.throwIfAborted()
      opts.onSubmit?.()
      const body = await postJson(
        `${base}/images/generations`,
        {
          model: this.profile.model,
          prompt: req.prompt,
          n: 1,
          ...params,
          response_format: 'url',
          async: true,
          ...(req.inputs.length ? { images: req.inputs.map((i) => dataUri(i.bytes, i.mime)) } : {}),
        },
        auth,
        signal,
        {
          validate: (b) =>
            mumugofeTaskId(b) || Array.isArray(b.data) ? undefined : '接口没有返回任务号或图片',
        },
      )
      const id = mumugofeTaskId(body)
      if (!id) return resolveImages(readImages(body, usage), opts)
      taskId = id
      await afterSubmit(id, signal, async () => opts.onTask?.(id))
    }
    const id = taskId
    return afterSubmit(id, signal, async () => {
      const done = await waitTask(() => checkMumugofe(base, id, auth, signal), opts)
      return resolveImages({ ...done.result, usage }, opts)
    })
  }
}

/** Mumugofe 的响应可能把任务对象包在 `data` 中；`data` 为数组时是图片列表。 */
function unwrap(body: Record<string, unknown>): Record<string, unknown> {
  return body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? (body.data as Record<string, unknown>)
    : body
}

function mumugofeTaskId(body: Record<string, unknown>): string | undefined {
  const task = unwrap(body)
  const id = task.task_id ?? task.id
  return typeof id === 'string' && id.trim() ? id : undefined
}

async function checkMumugofe(
  base: string,
  taskId: string,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<TaskState<{ result: MediaImageResult }>> {
  const body = await getJson(
    `${base}/images/generations/tasks/${encodeURIComponent(taskId)}`,
    auth,
    signal,
  )
  const task = unwrap(body)
  const status = String(task.status ?? '').toLowerCase()
  if (['completed', 'succeeded', 'success'].includes(status))
    return { state: 'done', result: readImages(task) }
  if (['failed', 'failure', 'cancelled', 'canceled', 'rejected'].includes(status)) {
    const error = (task.error ?? body.error) as { code?: unknown; message?: unknown } | undefined
    return {
      state: 'failed',
      message: failureDetail(error?.code, error?.message ?? task.fail_reason, '任务失败'),
    }
  }
  return pendingTask(status, [
    'queued',
    'pending',
    'submitted',
    'not_start',
    'in_progress',
    'processing',
    'running',
  ])
}

/**
 * 响应中的 `usage`。OpenAI 返回 token（`input_tokens_details` 区分文字与图片）；火山返回成功张数 `generated_images`、
 * 输入张数 `input_images` 与 `output_tokens`（像素总数 / 256）；千问图像 2.1 返回 `image_count`。
 * 张数以接口返回为准，未返回时取实际收到的张数。
 */
function readUsage(body: Record<string, unknown>, received: number): MediaUsage {
  const u = (body.usage ?? {}) as Record<string, unknown>
  const input = (u.input_tokens_details ?? {}) as Record<string, unknown>
  return defined<MediaUsage>({
    images: count(u.generated_images) ?? count(u.image_count) ?? received,
    inputImages: count(u.input_images),
    inputTextTokens: count(input.text_tokens),
    inputImageTokens: count(input.image_tokens),
    outputTokens: count(u.output_tokens),
  })
}

/** 响应中的 `data[]`：每项是 `b64_json` 或 `url`。单项失败（火山逐张报错）合并到消息中，不静默丢弃。 */
export function readImages(body: Record<string, unknown>, usage?: MediaUsage): MediaImageResult {
  const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []
  const sources: MediaImageResult['sources'] = []
  const errors: string[] = []
  for (const item of data) {
    if (typeof item.b64_json === 'string')
      sources.push({ base64: item.b64_json, mime: 'image/png' })
    else if (typeof item.url === 'string') sources.push({ url: item.url })
    else if (item.error && typeof item.error === 'object')
      errors.push(String((item.error as Record<string, unknown>).message ?? '单张生成失败'))
  }
  if (!sources.length)
    throw new MediaError(
      errors.length ? `接口没有返回图片：${errors.join('；')}` : '接口没有返回图片',
    )
  return {
    sources,
    ...(usage ? { usage: { ...usage, images: usage.images ?? sources.length } } : {}),
    ...(errors.length ? { warning: `部分图片生成失败：${errors.join('；')}` } : {}),
  }
}
