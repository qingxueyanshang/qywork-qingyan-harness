/**
 * 云端生成协议（`qywork_images` / `qywork_videos` / `qywork_speech`）：请求提交到云端的生成任务接口，
 * 云端以上游接口运行原协议的适配器并按计量 × 单价扣费。
 *
 * 提交 `POST {base}/v1/media/jobs`（multipart：`request` JSON 与 `input.<用途>` 素材），返回任务号；
 * 查询 `GET {base}/v1/media/jobs/{id}`，结果 `GET {base}/v1/media/jobs/{id}/files/{n}`，撤销 `POST {base}/v1/media/jobs/{id}/cancel`。
 * 云端任务的终态：成功、失败（云端已退回）、已撤销、结果不明（云端已全额退回）。后三者都不计费，以原因交还调用方。
 * 金额取云端回报的扣费（`billed`，积分）：云端按请求参数计量，本地不另行计算。
 */

import type { MediaModelSpec } from '../catalog.ts'
import { download, getJson, sendJson } from '../http.ts'
import { afterSubmit, postTask, waitTask } from '../task.ts'
import {
  type MediaAdapter,
  type MediaCancel,
  MediaError,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
} from '../types.ts'

/** 云端任务的终态给用户的说明。 */
const UNKNOWN_REASON: Record<string, string> = {
  stuck: '上游 24 小时内一直生成中',
  query_failed: '查询结果持续失败',
  submit_lost: '提交时连接中断',
}

interface CloudJob {
  status: string
  error: string | null
  unknownReason: string | null
  credits: number
  files: number
}

export class CloudMediaAdapter implements MediaAdapter {
  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  get kind() {
    return this.profile.kind
  }

  /** 云端接口的地址是站点根地址（如 `https://qywork.io`），不按 OpenAI 兼容地址补 `/v1`。 */
  private base(): string {
    const base = this.profile.baseUrl?.replace(/\/+$/, '')
    if (!base) throw new MediaError('云端接口缺少地址')
    return base
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
  }

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const base = this.base()
    const auth = this.auth()
    let id = opts.resumeTaskId
    if (!id) {
      const form = new FormData()
      // 素材类型随请求正文提交，与 `input.<用途>` 文件按顺序对应：Bun 1.4.2 解析 multipart 时不读取各部分的
      // Content-Type，只按文件名扩展名与 PNG / JPEG 文件头判定，WAV、MP3 等素材的类型为空。
      form.set(
        'request',
        JSON.stringify({
          model: this.profile.model,
          operation: req.operation,
          prompt: req.prompt,
          params: req.params,
          mimes: req.inputs.map((i) => i.mime),
        }),
      )
      for (const input of req.inputs) {
        form.append(`input.${input.role}`, new Blob([input.bytes], { type: input.mime }))
      }
      id = (await postTask(`${base}/v1/media/jobs`, form, auth, opts, (body) => body.id)).taskId
    }
    const taskId = id
    const path = `${base}/v1/media/jobs/${encodeURIComponent(taskId)}`
    return afterSubmit(taskId, opts.signal, async () => {
      const done = await waitTask<{ job: CloudJob }>(async () => {
        const job = (await getJson(path, auth, opts.signal)) as unknown as CloudJob
        if (job.status === 'succeeded') return { state: 'done', job }
        if (job.status === 'queued' || job.status === 'running')
          return { state: 'pending', status: job.status }
        if (job.status === 'unknown') {
          const reason = UNKNOWN_REASON[job.unknownReason ?? ''] ?? '结果不明'
          return { state: 'failed', message: `结果不明，积分已退回：${reason}` }
        }
        if (job.status === 'cancelled') return { state: 'failed', message: '任务已撤销' }
        return { state: 'failed', message: job.error ?? '生成失败' }
      }, opts)
      const files = []
      for (let n = 0; n < done.job.files; n++) {
        files.push(await download(`${path}/files/${n}`, opts.signal, auth))
      }
      return {
        files,
        usage: {
          ...(this.spec.kind === 'qywork_images' ? { images: files.length } : {}),
          billed: { amount: done.job.credits, currency: 'CREDIT' },
        },
      }
    })
  }

  async cancel(taskId: string, signal: AbortSignal): Promise<MediaCancel> {
    try {
      await sendJson(
        `${this.base()}/v1/media/jobs/${encodeURIComponent(taskId)}/cancel`,
        { method: 'POST', headers: this.auth() },
        signal,
      )
      return 'cancelled'
    } catch (err) {
      // 上游已开始生成或不支持撤销：按结果计费（成功计费、失败退回），与「无法撤销」同义。
      if (err instanceof MediaError && err.status === 409) return 'started'
      throw err
    }
  }
}
