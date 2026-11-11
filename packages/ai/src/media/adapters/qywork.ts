/**
 * 云端生成协议（`qywork_images` / `qywork_videos` / `qywork_speech`）：请求提交到云端的生成任务接口，
 * 云端以上游接口运行原协议的适配器并按计量 × 单价扣费。
 *
 * 提交 `POST {base}/v1/media/jobs`（multipart：`request` JSON 与 `input.<用途>` 素材），任务号由本机生成并随 `request` 提交；
 * 查询 `GET {base}/v1/media/jobs/{id}`，结果 `GET {base}/v1/media/jobs/{id}/files/{n}`，撤销 `POST {base}/v1/media/jobs/{id}/cancel`。
 * 云端任务的终态：成功、失败（云端已退回）、已撤销、结果不明（云端已全额退回）。后三者都不计费，以原因交还调用方。
 * 查询时云端答复任务不存在（404）同为终态：任务没有建立，没有扣费。
 * 金额取云端回报的扣费（`billed`，积分）：云端按请求参数计量，本地不另行计算。
 */

import type { RetryWait } from '@qywork/core'
import type { MediaModelSpec } from '../catalog.ts'
import { confirmedRejected, download, getJson, sendJson } from '../http.ts'
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
  query_failed: '查询或下载结果持续失败',
  submit_lost: '提交时连接中断',
}

/** 云端答复任务不存在时的结果。 */
const NOT_ESTABLISHED = '任务未建立，未扣费'

/** 云端任务号的格式：`mj_` 加 16 位十六进制。本机提交时生成，云端按同一格式校验并以它为预扣流水的引用。 */
export const CLOUD_JOB_ID = /^mj_[0-9a-f]{16}$/

/** 生成一个云端任务号（`CLOUD_JOB_ID`）。 */
export function newCloudJobId(): string {
  return `mj_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

/** 云端答复任务不存在（404）。 */
function notFound(err: unknown): boolean {
  return err instanceof MediaError && err.status === 404
}

function jobPath(base: string, id: string): string {
  return `${base}/v1/media/jobs/${encodeURIComponent(id)}`
}

interface CloudJob {
  /** 云端任务的状态：`queued` 为云端尚未向上游提交，`running` 为已提交。不是上游报告的状态。 */
  status: string
  /** 上游报告的状态（排队中、生成中）；上游尚未报告时为 null。 */
  phase?: string | null
  /** 上游拒绝后云端正在等待重试；不在等待时为 null。 */
  retry?: RetryWait | null
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
    if (!base) throw new MediaError('接口缺少地址')
    return base
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
  }

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const base = this.base()
    const auth = this.auth()
    const taskId = opts.resumeTaskId ?? (await this.submit(base, auth, req, opts))
    const path = jobPath(base, taskId)
    return afterSubmit(taskId, opts.signal, async () => {
      let retrying = false
      const done = await waitTask<{ job: CloudJob }>(async () => {
        const job = (await getJson(path, auth, opts.signal).catch((err: unknown) => {
          if (notFound(err)) return null
          throw err
        })) as CloudJob | null
        if (!job) return { state: 'failed', message: NOT_ESTABLISHED, verbatim: true }
        if (job.status === 'succeeded') return { state: 'done', job }
        if (job.status === 'queued' || job.status === 'running') {
          // 云端一侧的重试与本机直连的重试经同一个回调回报，卡片的显示相同。
          if (job.retry) opts.onRetry?.(job.retry)
          else if (retrying) opts.onRetry?.(null)
          retrying = !!job.retry
          // 回报上游报告的状态。云端任务自身的状态不回报：`queued` 只表示云端尚未提交，不是上游的排队。
          return { state: 'pending', status: job.phase ?? '' }
        }
        if (job.status === 'unknown') {
          const reason = UNKNOWN_REASON[job.unknownReason ?? ''] ?? '结果不明'
          return { state: 'failed', message: `结果不明，积分已退回：${reason}` }
        }
        if (job.status === 'cancelled') return { state: 'failed', message: '任务已撤销' }
        // 云端的失败原因是上游一侧的报错文字，与本机直连同一来源，原样显示。
        return { state: 'failed', message: job.error ?? '生成失败', verbatim: true }
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

  /**
   * 提交任务，返回任务号。任务号由本机生成，云端已有该任务号的任务时不重复建立、不重复扣费。
   * 提交后没有收到有效应答（连接在发出后断开、网关的 5xx、响应无法解析）时按任务号查询一次：
   * 云端已建立任务则按已提交继续等待；答复任务不存在则判为未受理，可以重新提交；查询失败时带任务号结束等待，之后取回时再查询。
   * 查询之前先交出任务号（`onTask`）：确认期间停止或查询失败时，任务记录中已有任务号。
   */
  private async submit(
    base: string,
    auth: Record<string, string>,
    req: MediaRequest,
    opts: MediaRunOptions,
  ): Promise<string> {
    const id = newCloudJobId()
    const form = new FormData()
    // 素材类型随请求正文提交，与 `input.<用途>` 文件按顺序对应：Bun 1.4.2 解析 multipart 时不读取各部分的
    // Content-Type，只按文件名扩展名与 PNG / JPEG 文件头判定，WAV、MP3 等素材的类型为空。
    form.set(
      'request',
      JSON.stringify({
        id,
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
    try {
      return (await postTask(`${base}/v1/media/jobs`, form, auth, opts, (body) => body.id)).taskId
    } catch (err) {
      if (!(err instanceof MediaError) || err.diagnostic?.outcome !== 'unknown') throw err
      await afterSubmit(id, opts.signal, async () => opts.onTask?.(id))
      const established = await afterSubmit(id, opts.signal, () =>
        getJson(jobPath(base, id), auth, opts.signal).then(
          () => true,
          (query: unknown) => {
            if (notFound(query)) return false
            throw query
          },
        ),
      )
      if (!established) throw confirmedRejected(err, NOT_ESTABLISHED)
      return id
    }
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
