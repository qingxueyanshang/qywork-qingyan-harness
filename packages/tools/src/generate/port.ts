import { definePort } from '@qywork/agent'
import type { MediaFile, MediaImageResult, MediaInput } from '@qywork/ai'
import type {
  GenerateOutput,
  MediaDiagnostic,
  MediaOutput,
  MediaSpend,
  RetryWait,
} from '@qywork/core'

/**
 * 生成端口：生成工具与画布的运行经由它调用生成模型。
 *
 * 选择模型、按目录校验参数、调用接口由实现方完成（runtime，只有它持有配置与凭证）；读取参考图、写入产物由工具完成，
 * 与 `read_file` / `write_file` 使用同一套路径边界。
 *
 * runtime 在配置了生成模型或提供了画布端口时提供本端口：画布上的 art 卡与文本生成卡使用对话模型，没有生成模型也能运行。
 * 生成工具按已配置模型的类别注册，注册时本端口必然存在。
 */
export interface MediaPort {
  generate(call: MediaCall, signal: AbortSignal): Promise<MediaCallResult>
  /**
   * 接口下为该模型保存的显示名称（由云端同步写入）；没有时为 undefined。使用对话模型的类别（`isChatOutput`）按对话模型查找。
   * 回执中提及模型时经 `modelMention` 使用它：有显示名称时只写该名称。
   */
  displayName(type: GenerateOutput, provider: string, model: string): string | undefined
  /**
   * 该类别当前配置的生成模型与参数表（文本），按调用时的配置生成。`load_tool` 读取生成工具时一并返回：
   * 参数表不随每次请求携带，模型需要生成或建生成卡时读取。
   */
  parameterTable(output: MediaOutput): string
}

export const MediaPort = definePort<MediaPort>('media')

export interface MediaCall {
  /** `art` 由对话模型写出 HTML 页面，`text` 由对话模型写出文本，其余类别由生成模型生成。 */
  type: GenerateOutput
  prompt: string
  /** 输入文件，各自带有用途。操作由用途推导（见实现方），不由大模型选择。 */
  inputs: MediaInput[]
  /**
   * 产物将写入的目录（绝对路径）。`art` 据此告知模型每张参考图相对页面的路径，页面按该路径引用图片。
   */
  outputDir?: string
  /** 工作区根目录（绝对路径）。对话生成为参考视频抽帧时，worker 的临时目录位于其中；缺省时不能抽帧。 */
  workspaceRoot?: string
  /** 大模型按参数表填写的原生字段，由实现方按目录校验。 */
  params: Record<string, unknown>
  /** 与 `model` 须同时提供或同时省略；均省略时使用该类别的默认模型。 */
  provider?: string
  model?: string
  /** 继续取回已提交的远端任务：只查询与下载，不再提交，不重复扣费。须同时提供 provider 与 model。 */
  resumeTaskId?: string
  /** 已返回的图片来源；恢复时不得再提交生成。 */
  resumeImageResult?: MediaImageResult
  onImageResult?: (
    result: MediaImageResult,
    provider: string,
    model: string,
  ) => void | Promise<void>
  /**
   * 取得远端任务号后立即回调，附带实际选中的接口与模型，由调用方落盘；
   * 此后即使停止、超时或进程退出，仍可取回结果。
   */
  onTask?: (task: { taskId: string; provider: string; model: string }) => void | Promise<void>
  onSubmit?: () => void
  /** 远端任务状态变化时回报一条状态文字。 */
  onStatus?: (status: string) => void
  /** 请求被拒绝后进入重试等待时回报第几次、上限与原因，等待结束时回报 `null`。 */
  onRetry?: (retry: RetryWait | null) => void
  /** 结果下载的进度：已接收的字节与总字节（服务器未给出时为 null），至多每 0.5 秒回报一次。 */
  onDownload?: (received: number, total: number | null) => void
  /** 本次生成的花费，取得服务商结果时回报一次；恢复下载不再次回报。 */
  onSpend?: (spend: MediaSpend) => void
  /**
   * 写入重试与查询失败日志的标识，用于从日志对应到发起方：画布路径与节点，或工具调用所在的会话、执行与工具名，
   * 另加任务记录的路径。不得放入密钥、提示词与素材内容。
   */
  logFields?: Record<string, string>
}

/**
 * 失败（无法选定模型、参数不合法、接口报错）时的 `message` 直接交给大模型，须写明修正方法。
 * `pendingTaskId` 或 `recoverable` 表示已有恢复依据；其余失败是否确定由 diagnostic.outcome 判定。
 */
export type MediaCallResult =
  | { ok: true; provider: string; model: string; files: MediaFile[]; warning?: string }
  | {
      ok: false
      message: string
      pendingTaskId?: string
      recoverable?: boolean
      diagnostic?: MediaDiagnostic
      executed?: boolean
    }
