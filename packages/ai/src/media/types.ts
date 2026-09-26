/**
 * 生成适配器的请求、结果与接口。
 *
 * 与对话适配器（`LlmAdapter`）分开：生成接口不是流，没有 token 事件，结果是一组文件。
 */

import type { MediaKind } from '@qywork/core'
import type { MediaModelSpec, MediaOperation } from './catalog.ts'

/** 发一次生成请求需要的端点与凭证。 */
export interface MediaProfile {
  kind: MediaKind
  model: string
  apiKey: string
  baseUrl?: string
  headers?: Record<string, string>
}

/**
 * 一个输入文件。字节由调用方读好，适配器只负责按协议放进请求。
 *
 * `role`：`reference` 是参考图（出图时即待修改的图），`first_frame` / `last_frame` 是视频的首尾帧，
 * `video` 是参考视频（编辑、延长或参考生成，具体是哪一种由模型的原生参数或提示词决定）。
 */
export interface MediaInput {
  role: 'reference' | 'first_frame' | 'last_frame' | 'video'
  bytes: Uint8Array
  mime: string
  /** 工作区里的绝对路径。百炼的大文件走临时上传时按路径读。 */
  path: string
}

export interface MediaRequest {
  operation: MediaOperation
  prompt: string
  inputs: MediaInput[]
  /** 已按目录校验过，原样发出。 */
  params: Record<string, unknown>
}

export interface MediaFile {
  bytes: Uint8Array
  mime: string
}

export interface MediaResult {
  files: MediaFile[]
}

export interface MediaRunOptions {
  signal: AbortSignal
  /** 远端任务号一到手就交出去：调用方把它落盘，停止、超时、进程退出之后还能取回。 */
  onTask?: (taskId: string) => void | Promise<void>
  /** 状态变化时回报一句（排队、生成中）。不按轮询次数报。 */
  onStatus?: (status: string) => void
  /** 只查询与下载这个已提交的任务，不再提交。 */
  resumeTaskId?: string
}

/**
 * 按协议分派一次后，调用方只见这个接口。
 *
 * **不重试。** 生成按次计费，接口没有幂等键；断线后自动重发可能扣两次费。失败交还调用方。
 */
export interface MediaAdapter {
  readonly kind: MediaKind
  readonly spec: MediaModelSpec
  run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult>
}

/**
 * 生成接口的失败。`status` 是 HTTP 状态码（网络层失败时没有），`message` 带接口原文。
 *
 * `pendingTaskId`：远端任务已提交、还没有结果（等待超时），任务还在远端，可以接续取回。
 * 没有它的失败是终态：远端报了失败，或请求没有被接受。
 *
 * 不归类成错误码：生成失败只交给大模型读，不进重发表与 run 诊断链，原文比分类更有用。
 */
export class MediaError extends Error {
  readonly status: number | undefined
  readonly pendingTaskId: string | undefined
  constructor(message: string, opts: { status?: number; pendingTaskId?: string } = {}) {
    super(message)
    this.name = 'MediaError'
    this.status = opts.status
    this.pendingTaskId = opts.pendingTaskId
  }
}
