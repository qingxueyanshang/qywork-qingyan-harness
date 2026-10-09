/**
 * 生成适配器的请求、结果与接口。
 *
 * 与对话适配器（`LlmAdapter`）分离：生成接口不是流式接口，没有 token 事件，结果是一组文件。
 */

import type { Currency, MediaDiagnostic, MediaInputRole, MediaKind } from '@qywork/core'
import type { MediaModelSpec, MediaOperation } from './catalog.ts'

/** 发送生成请求所需的端点与凭证。 */
export interface MediaProfile {
  kind: MediaKind
  model: string
  apiKey: string
  baseUrl?: string
  headers?: Record<string, string>
}

/** 输入文件。字节由调用方预先读取，适配器只负责按协议放入请求。用途的含义见 `MediaInputRole`。 */
export interface MediaInput {
  role: MediaInputRole
  bytes: Uint8Array
  mime: string
  /** 工作区中的绝对路径。百炼的大文件经临时上传时按此路径读取。 */
  path: string
}

export interface MediaRequest {
  operation: MediaOperation
  prompt: string
  inputs: MediaInput[]
  /** 已按目录校验，原样发送。 */
  params: Record<string, unknown>
}

export interface MediaFile {
  bytes: Uint8Array
  mime: string
}

/**
 * 接口回报的计量。按接口原字段读取，不在本地估算；接口未回报的项不填。金额由目录据此计算（`MediaPrice`）。
 */
export interface MediaUsage {
  /** 成功输出的图片张数。 */
  images?: number
  /** 计费的输入图片张数。 */
  inputImages?: number
  /** 接口给出的输出档位，如百炼千问图像的 `qima_output_2k`。 */
  imageTier?: string
  /** 计费秒数，口径以接口为准（百炼万相含输入视频时长）。 */
  seconds?: number
  /** 输出视频分辨率，统一写为 `480p` / `720p` / `1080p` / `4k`。 */
  resolution?: string
  /** 输出是否包含声音。 */
  audio?: boolean
  /** 输入是否含视频。计价据此分档，由请求决定，不是接口回报。 */
  videoInput?: boolean
  /** 计费字符数。 */
  characters?: number
  inputTextTokens?: number
  inputImageTokens?: number
  outputTokens?: number
  /** Gemini 的全部输入 token，以及按模态拆分的输出；文字输出含思考。 */
  inputTokens?: number
  outputTextTokens?: number
  outputMediaTokens?: number
  /** 接口直接回报的扣费金额。存在时不按单价计算。 */
  billed?: { amount: number; currency: Currency }
}

export interface MediaResult {
  files: MediaFile[]
  usage?: MediaUsage
  /** 已有可用产物，但接口同时报告了部分失败。保留产物并将原因交给调用方。 */
  warning?: string
}

/** 图片接口已经返回的产物。持久化时不保存接口凭证，恢复时只读取这些产物。 */
export interface MediaImageResult {
  sources: ({ url: string } | { base64: string; mime: string })[]
  usage?: MediaUsage
  warning?: string
}

export interface MediaRunOptions {
  signal: AbortSignal
  /** 在下载之前保存结果引用与计量；回调完成后才开始下载。 */
  onImageResult?: (result: MediaImageResult) => void | Promise<void>
  /** 取得远端任务号后立即交出：调用方将其落盘，停止、超时或进程退出之后仍可取回。 */
  onTask?: (taskId: string) => void | Promise<void>
  /** 状态变化时回报一次（排队、生成中），不按轮询次数回报。 */
  onStatus?: (status: string) => void
  /** 只查询与下载该已提交的任务，不再提交。 */
  resumeTaskId?: string
}

/**
 * 按协议分派一次后，调用方只使用此接口。
 *
 * 不重试：生成按次计费，接口没有幂等键，断线后自动重发可能重复扣费。失败交还调用方。
 */
export interface MediaAdapter {
  readonly kind: MediaKind
  readonly spec: MediaModelSpec
  run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult>
  /** 只读取已返回的图片来源，不提交生成。 */
  resumeImage?(result: MediaImageResult, opts: MediaRunOptions): Promise<MediaResult>
  /**
   * 撤销已提交的异步任务。仅接口支持撤销的适配器实现此方法；未实现的一律视为无法撤销。
   * 撤销失败（网络、鉴权）时抛出 `MediaError`，调用方不得据此视为已撤销。
   */
  cancel?(taskId: string, signal: AbortSignal): Promise<MediaCancel>
}

/**
 * 撤销的结果。`cancelled`：远端已撤销，不计费。`started`：远端已开始生成或已结束，无法撤销，
 * 按结果计费（成功计费、失败不计费）。
 */
export type MediaCancel = 'cancelled' | 'started'

/**
 * 生成接口的失败。`status` 是 HTTP 状态码（网络层失败时缺省），`message` 含接口原文。
 *
 * `pendingTaskId`：远端任务已提交但尚无结果（等待超时），任务仍在远端，可以接续取回。
 * `diagnostic` 区分明确拒绝、结果未知与已有产物的下载失败；错误原文始终保留。
 */
export class MediaError extends Error {
  readonly status: number | undefined
  readonly pendingTaskId: string | undefined
  readonly diagnostic: MediaDiagnostic | undefined
  constructor(
    message: string,
    opts: {
      status?: number
      pendingTaskId?: string
      diagnostic?: MediaDiagnostic
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'MediaError'
    this.status = opts.status
    this.pendingTaskId = opts.pendingTaskId
    this.diagnostic = opts.diagnostic
  }
}
