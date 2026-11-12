/**
 * 生成适配器的请求、结果与接口。
 *
 * 与对话适配器（`LlmAdapter`）分离：生成接口不是流式接口，没有 token 事件，结果是一组文件。
 */

import type {
  Currency,
  ErrorCode,
  MediaDiagnostic,
  MediaInputRole,
  MediaKind,
  RetryWait,
  StoredMediaSpec,
} from '@qywork/core'
import type { MediaModelSpec, MediaOperation } from './catalog.ts'

/** 发送生成请求所需的端点与凭证。 */
export interface MediaProfile {
  kind: MediaKind
  model: string
  apiKey: string
  baseUrl?: string
  headers?: Record<string, string>
  /** 该型号配置中保存的规格（渠道规格或对应型号），见 `lookupMediaModel`。 */
  spec?: StoredMediaSpec
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
  /** 参考视频的计费秒数。仅在接口分开回报、按不同单价计费时填写（MiniMax H3）。 */
  inputSeconds?: number
  /**
   * 输出分辨率档位。视频统一写为 `480p` / `720p` / `1080p` / `4k`；中转渠道按目录中的档位写，
   * 渠道按请求中的档位计价时取发送的值。
   */
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
  /** 接口回报的全部输入 token（Gemini、千问音频等）。 */
  inputTokens?: number
  /** 按模态拆分的输出；Gemini 文字输出含思考。 */
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
  /**
   * 提交或上传被拒绝后进入重试等待时回报一次，等待结束、请求重新发出时以 `null` 回报一次；等待被中止时不回报 `null`。
   * 调用方据此显示重试，等待期间远端没有受理请求。进入等待时 `failure` 为引起等待的失败，`retry.reason` 是它的报错原文；
   * 调用方按失败类别改写显示的原因时读取 `failure`。
   */
  onRetry?: (retry: RetryWait | null, failure?: MediaError) => void
  /**
   * 生成请求即将发出：每次发出各回报一次（含被拒绝后的重试，异步任务的提交与同步出图、语音都在内），素材上传、查询与下载不回报。
   * 由 `send` 统一回报（`reportingRetries`），适配器不另行调用。用于区分未提交时的停止与受理结果未知。
   */
  onSubmit?: () => void
  /** 在下载之前保存结果引用与计量；回调完成后才开始下载。 */
  onImageResult?: (result: MediaImageResult) => void | Promise<void>
  /**
   * 取得远端任务号后立即交出：调用方将其落盘，停止、超时或进程退出之后仍可取回。
   * 任务号由本机生成的协议（云端）在提交结果未知、提交请求已发出而应答到达之前停止时同样交出：远端可能已建立该任务。
   */
  onTask?: (taskId: string) => void | Promise<void>
  /** 状态变化时回报一次（排队、生成中），不按轮询次数回报。 */
  onStatus?: (status: string) => void
  /** 只查询与下载该已提交的任务，不再提交。 */
  resumeTaskId?: string
  /**
   * 本次运行的日志标识，附在重试等待、查询失败与按任务号确认的日志行中（`reportingRetries`）：本机为画布路径与节点或工具调用，
   * 云端为任务号。值写入日志文件，不得放入密钥、提示词与素材内容。
   */
  logFields?: Record<string, string>
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
 * `pendingTaskId`：远端任务已提交但尚无结果（查询被拒绝、下载失败），任务仍在远端，可以接续取回。
 * `diagnostic` 区分明确拒绝、结果未知与已有产物的下载失败；错误原文始终保留。
 */
export class MediaError extends Error {
  readonly status: number | undefined
  readonly pendingTaskId: string | undefined
  readonly diagnostic: MediaDiagnostic | undefined
  /**
   * 失败的原因类别，与对话请求同一套失败码（`httpFailureCode`、`upstreamFailureCode`）：重试与云端给用户的文字按它判断。
   * 接口答复了错误状态、在正文中报告了失败或上游报告任务失败时存在；连接失败与响应无法解析时缺省，按 `diagnostic` 判断。
   */
  readonly code: ErrorCode | undefined
  /** 自动重试用尽后 `message` 末尾的一句，写明已做的重试（「已自动重试 5 次，仍失败」）；没有自动重试时缺省。 */
  readonly retryReceipt: string | undefined
  constructor(
    message: string,
    opts: {
      status?: number
      pendingTaskId?: string
      diagnostic?: MediaDiagnostic
      code?: ErrorCode
      retryReceipt?: string
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: opts.cause })
    this.name = 'MediaError'
    this.status = opts.status
    this.pendingTaskId = opts.pendingTaskId
    this.diagnostic = opts.diagnostic
    this.code = opts.code
    this.retryReceipt = opts.retryReceipt
  }
}
