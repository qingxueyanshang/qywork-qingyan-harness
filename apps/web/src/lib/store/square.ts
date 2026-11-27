/**
 * 创作广场：弹窗的打开状态与本机服务 `/api/square/*` 的调用（`packages/server/src/api/square.ts`）。
 * 文件地址只用作本界面中 `<img>` 与 `<video>` 的 `src`：查询串带本机服务的令牌，不要在右侧面板或内置浏览器中打开。
 */

import type {
  SquareCard,
  SquareDetail,
  SquareGithubRequest,
  SquareKind,
  SquareMineItem,
  SquarePublishSource,
} from '@qywork/core'
import { ApiError } from '../client.ts'
import { sessionSignal } from '../session.ts'
import { client } from './client.ts'
import { cloudState } from './cloud.ts'

/** 创作广场弹窗是否打开。与账号弹窗相同，整页刷新后恢复。 */
export const [squareOpen, setSquareOpen] = sessionSignal<boolean>('qywork.square.open', false)

/** 已登录且云端已开通创作广场。入口与弹窗都按它判定。 */
export function squareAvailable(): boolean {
  const s = cloudState()
  return s?.state === 'signed_in' && s.square
}

export interface SquarePage {
  items: SquareCard[]
  /** 下一页的起点；没有更多时为 null。 */
  next: string | null
}

export function listSquare(
  kind: SquareKind,
  q: string,
  before: string | null,
): Promise<SquarePage> {
  const query = new URLSearchParams({ kind, ...(q ? { q } : {}), ...(before ? { before } : {}) })
  return client.api<SquarePage>(`/api/square/items?${query}`)
}

export function squareDetail(id: string): Promise<SquareDetail> {
  return client.api<SquareDetail>(`/api/square/items/${encodeURIComponent(id)}`)
}

export function mySquareItems(): Promise<SquareMineItem[]> {
  return client.api<SquareMineItem[]>('/api/square/mine')
}

export function removeSquareItem(id: string): Promise<void> {
  return client.api(`/api/square/items/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 安装一个条目；画布导入时返回导入的画布文件路径。 */
export function installSquareItem(id: string): Promise<{ message: string; canvas?: string }> {
  return client.api('/api/square/install', { method: 'POST', body: JSON.stringify({ id }) })
}

export interface SquarePublishRequest {
  title: string
  summary: string
  source: SquarePublishSource
  /** 本人已有的条目：给出时发布该条目的新版本。 */
  itemId?: string
}

/** 发布到创作广场；`cover` 为视频作品的封面（PNG）。返回云端的条目与版本。 */
export async function publishSquare(
  manifest: SquarePublishRequest,
  cover?: Blob,
): Promise<{ id: string; version: number; status: string }> {
  const form = new FormData()
  form.set('manifest', JSON.stringify(manifest))
  if (cover) form.set('cover', cover, 'cover.png')
  const path = '/api/square/publish'
  const res = await client.raw(path, { method: 'POST', body: form })
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => ''))
  return (await res.json()) as { id: string; version: number; status: string }
}

/** 收录一个 GitHub 仓库：云端下载并校验仓库的内容后生成待审核的版本。 */
export function submitSquareGithub(
  request: SquareGithubRequest,
): Promise<{ id: string; version: number; status: string }> {
  return client.api('/api/square/github', { method: 'POST', body: JSON.stringify(request) })
}

export function squareFileUrl(hash: string): string {
  return client.assetUrl(`/api/square/files/${hash}`)
}

/** 文件的正文，用于查看技能与插件中的文本文件。 */
export async function squareFileText(hash: string): Promise<string> {
  const res = await client.raw(`/api/square/files/${hash}`)
  if (!res.ok) throw new Error(`读取失败：${res.status}`)
  return res.text()
}
