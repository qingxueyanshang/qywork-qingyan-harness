/**
 * 画布的接口调用。读写与运行都由服务端画布服务执行，此处只发送请求并取回应用后的画布。
 *
 * 卡片状态与失败原文以读取画布的响应体为准；`canvas.run` 事件只递增 `canvasVersion`，已打开的页签据此重新读取。
 */

import type { CanvasOp, CanvasView, MediaOutput } from '@qywork/core'
import { client } from './connection.ts'

/** 从文件树拖出一行时携带的数据类型，值为工作区相对路径。画布据此将拖入的文件添加为节点。 */
export const WORKSPACE_PATH_TYPE = 'application/x-qywork-path'

/** 画布文件的后缀。文件树据此用画布页签打开文件。 */
export const CANVAS_SUFFIX = '.canvas.json'

/**
 * 当前客户端是否可以使用画布。画布的操作均按鼠标设计（滚轮缩放、Shift 框选、悬停显示连接点、从文件树拖入），
 * 主指针不是鼠标时不提供入口，画布文件按文本打开。
 */
export function canvasAvailable(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
}

/** 页签名称：去掉 `.canvas.json` 后缀的文件名。 */
export function canvasTitle(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.endsWith(CANVAS_SUFFIX) ? name.slice(0, -CANVAS_SUFFIX.length) : name
}

export interface CanvasEdit extends CanvasView {
  refs: Record<string, string>
  /** 本次写入磁盘前后的文档指纹；两者相同表示没有改动。 */
  step: { before: string; after: string }
}

export interface CanvasQuote {
  cost: number
  currency: string
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  client.api<T>(path, { method: 'POST', body: JSON.stringify(body) })

/** 在工作区根新建一张空画布，返回它的工作区相对路径。 */
export async function createCanvas(): Promise<string> {
  return (await post<{ path: string }>('/api/canvas/new', {})).path
}

export function readCanvas(path: string): Promise<CanvasView> {
  return client.api<CanvasView>(`/api/canvas?path=${encodeURIComponent(path)}`)
}

/** 提交一批操作，整批生效或整批不生效；响应体是应用后的画布，不等待事件。 */
export function editCanvas(path: string, ops: CanvasOp[]): Promise<CanvasEdit> {
  return post<CanvasEdit>('/api/canvas/ops', { path, ops })
}

/** 发送：在同一次请求中先提交面板中的改动再运行。卡片标记为运行中后立即返回。 */
export function runCard(path: string, nodeId: string, ops: CanvasOp[] = []): Promise<CanvasView> {
  return post<CanvasView>('/api/canvas/run', { path, nodeId, ...(ops.length ? { ops } : {}) })
}

/**
 * 停止卡片的生成。`cancelled`：远端已撤销、不计费，卡片恢复到本次生成之前；`started`：远端已开始，无法撤销；
 * `unsupported`：接口不支持撤销，或生成在单次请求中完成；`ended`：生成已结束。后三种情况下生成照常进行、按结果计费。
 */
export async function cancelCard(
  path: string,
  nodeId: string,
): Promise<'cancelled' | 'started' | 'unsupported' | 'ended'> {
  return (
    await post<{ outcome: 'cancelled' | 'started' | 'unsupported' | 'ended' }>(
      '/api/canvas/cancel',
      { path, nodeId },
    )
  ).outcome
}

export function retrieveCard(path: string, nodeId: string, version?: string): Promise<CanvasView> {
  return post<CanvasView>('/api/canvas/retrieve', {
    path,
    nodeId,
    ...(version ? { version } : {}),
  })
}

/** 发送前的预估花费。无法推算（按 token 计价等）时为 `null`，界面不显示。 */
export async function quoteCard(input: {
  output: MediaOutput
  provider?: string
  model?: string
  params: Record<string, unknown>
  inputs: { images: number; videos: number }
}): Promise<CanvasQuote | null> {
  return (await post<{ quote: CanvasQuote | null }>('/api/canvas/quote', input)).quote
}

/** 将本机选择的文件交给服务端写入工作区 `uploads/`，并添加引用它的节点：以 `near` 为中心寻找空位，或排在 `beside` 节点右侧。 */
export async function uploadToCanvas(
  path: string,
  file: File,
  place: { near: { x: number; y: number } } | { beside: string },
): Promise<{ nodeId: string; path: string }> {
  const where =
    'beside' in place
      ? `beside=${encodeURIComponent(place.beside)}`
      : `x=${Math.round(place.near.x)}&y=${Math.round(place.near.y)}`
  return client.api(
    `/api/canvas/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}&${where}`,
    { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream' } },
  )
}

/** 撤销或重做：当前文件仍是指纹 `from` 对应的版本时换回 `to` 对应的版本；其间被修改过时返回 409。 */
export function restoreCanvas(path: string, from: string, to: string): Promise<CanvasEdit> {
  return client.api('/api/canvas/restore', {
    method: 'POST',
    body: JSON.stringify({ path, from, to }),
  })
}

/** 从系统拖入的本机文件（绝对路径）：工作区内的文件直接引用，工作区外的文件复制到 `uploads/`。返回新节点的 id。 */
export function importToCanvas(
  path: string,
  files: string[],
  near: { x: number; y: number },
): Promise<{ ids: string[] }> {
  return client.api('/api/canvas/import', {
    method: 'POST',
    body: JSON.stringify({ path, files, near }),
  })
}

/** 将浏览器截取的一帧交给服务端落盘，并在视频右侧添加一个节点。 */
export async function captureFrame(
  path: string,
  nodeId: string,
  label: string,
  png: Blob,
): Promise<{ nodeId: string; path: string }> {
  const query = new URLSearchParams({ path, nodeId, label })
  return client.api(`/api/canvas/frame?${query}`, {
    method: 'POST',
    body: png,
    headers: { 'content-type': 'image/png' },
  })
}

/**
 * 时间线导出的上传会话：开始时取得会话号，编码得到的字节块按位置写入服务端，完成后服务端重命名并落盘，在时间线右侧添加节点。
 * 中途失败或取消时须调用 `exportAbort`，否则服务端要到空闲超时才删除不完整的文件。
 */
export async function exportStart(path: string, nodeId: string): Promise<string> {
  const r = await client.api<{ upload: string }>('/api/canvas/export/start', {
    method: 'POST',
    body: JSON.stringify({ path, nodeId }),
  })
  return r.upload
}

export async function exportWrite(
  upload: string,
  at: number,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  await client.api(`/api/canvas/export/write?${new URLSearchParams({ upload, at: String(at) })}`, {
    method: 'POST',
    body: bytes,
    headers: { 'content-type': 'application/octet-stream' },
  })
}

export function exportFinish(upload: string): Promise<{ nodeId: string; path: string }> {
  return client.api('/api/canvas/export/finish', {
    method: 'POST',
    body: JSON.stringify({ upload }),
  })
}

export async function exportAbort(upload: string): Promise<void> {
  await client.api('/api/canvas/export/abort', {
    method: 'POST',
    body: JSON.stringify({ upload }),
  })
}
