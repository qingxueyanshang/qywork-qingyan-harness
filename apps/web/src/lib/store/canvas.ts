/**
 * 画布的接口调用。读写与运行都由服务端画布服务执行，这里只发请求、取回应用后的画布。
 *
 * 卡片状态与失败原文以读画布的回体为准；`canvas.run` 事件只推进 `canvasVersion`，开着的页签据此重读。
 */

import type { CanvasOp, CanvasView, MediaOutput } from '@qywork/core'
import { client } from './connection.ts'

/** 文件树拖出一行时带的数据类型，值是工作区相对路径。画布据此把拖进来的文件加成节点。 */
export const WORKSPACE_PATH_TYPE = 'application/x-qywork-path'

/** 画布文件的后缀。文件树按它把文件交给画布页签打开。 */
export const CANVAS_SUFFIX = '.canvas.json'

/**
 * 这一端能不能用画布。画布的操作全按鼠标设计（滚轮缩放、Shift 框选、悬停出连接点、从文件树拖入），
 * 主指针不是鼠标时不给入口，画布文件按文本打开。
 */
export function canvasAvailable(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
}

/** 页签上的名字：文件名去掉 `.canvas.json`。 */
export function canvasTitle(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.endsWith(CANVAS_SUFFIX) ? name.slice(0, -CANVAS_SUFFIX.length) : name
}

export interface CanvasEdit extends CanvasView {
  refs: Record<string, string>
  /** 这次写盘前后的文档指纹；两者相同表示没有改动。 */
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

/** 提交一批操作，整批生效或整批不生效；回体是应用后的画布，不等事件。 */
export function editCanvas(path: string, ops: CanvasOp[]): Promise<CanvasEdit> {
  return post<CanvasEdit>('/api/canvas/ops', { path, ops })
}

/** 发送：先提交面板里的改动再运行，同一次请求。卡片标成在跑之后立刻返回。 */
export function runCard(path: string, nodeId: string, ops: CanvasOp[] = []): Promise<CanvasView> {
  return post<CanvasView>('/api/canvas/run', { path, nodeId, ...(ops.length ? { ops } : {}) })
}

export function retrieveCard(path: string, nodeId: string, version?: string): Promise<CanvasView> {
  return post<CanvasView>('/api/canvas/retrieve', {
    path,
    nodeId,
    ...(version ? { version } : {}),
  })
}

/** 发送前的花费。推不出（按 token 计价等）时是 `null`，界面不显示。 */
export async function quoteCard(input: {
  output: MediaOutput
  provider?: string
  model?: string
  params: Record<string, unknown>
  inputs: { images: number; videos: number }
}): Promise<CanvasQuote | null> {
  return (await post<{ quote: CanvasQuote | null }>('/api/canvas/quote', input)).quote
}

/** 把本机选的文件交给服务端写进工作区 `uploads/`，并加一个引用它的节点：以 `near` 为中心找空位，或排在 `beside` 那个节点右侧。 */
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

/** 撤销或重做：当前文件仍是指纹 `from` 那一份时换回 `to` 那一份；中间被改过回 409。 */
export function restoreCanvas(path: string, from: string, to: string): Promise<CanvasEdit> {
  return client.api('/api/canvas/restore', {
    method: 'POST',
    body: JSON.stringify({ path, from, to }),
  })
}

/** 从系统拖入的本机文件（绝对路径）：工作区里的直接引用，工作区外的复制进 `uploads/`。回新节点的 id。 */
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

/** 把浏览器截下的一帧交给服务端落盘，并在视频右侧加一个节点。 */
export async function captureFrame(
  path: string,
  nodeId: string,
  label: string,
  png: Blob,
): Promise<{ nodeId: string; path: string }> {
  const query = `path=${encodeURIComponent(path)}&nodeId=${encodeURIComponent(nodeId)}&label=${encodeURIComponent(label)}`
  return client.api(`/api/canvas/frame?${query}`, {
    method: 'POST',
    body: png,
    headers: { 'content-type': 'image/png' },
  })
}
