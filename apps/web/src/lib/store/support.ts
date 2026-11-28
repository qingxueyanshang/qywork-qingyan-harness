/**
 * 客服对话（服务端 `/api/cloud/support*`）。对话不在本地保存：「联系客服」弹窗打开时与收到 `support.changed` 时重新读取。
 *
 * - 未读数取自账号状态的 `supportUnread`（云端 `/v1/me`），侧栏账号入口与账号窗口的客服图标据此显示圆点。
 * - 弹窗打开期间取得的客服新回复即记为已读：用户正在查看这段对话。
 * - 云端推送经隧道到达本机服务，再以 `support.changed` 发给各屏幕（`events/global.ts`），不轮询。
 */

import type { SupportAttachment, SupportMessage } from '@qywork/core'
import { createSignal } from 'solid-js'
import { ApiError } from '../client.ts'
import { client } from './client.ts'
import { cloudState, markSupportRead, refreshCloudState } from './cloud.ts'

/** 每条消息的附件个数与合计大小上限，与云端相同；超出时云端拒绝并返回原因。 */
export const SUPPORT_FILES_MAX = 20
export const SUPPORT_BYTES_MAX = 200 * 1024 * 1024

/** `null` 表示尚未读取。 */
const [messages, setMessages] = createSignal<SupportMessage[] | null>(null)
const [open, setOpen] = createSignal(false)

export const supportMessages = messages
export const supportOpen = open

/** 有未读的客服回复。 */
export function supportUnread(): boolean {
  const s = cloudState()
  return s?.state === 'signed_in' && s.supportUnread > 0
}

export function openSupport(): void {
  setOpen(true)
}

export function closeSupport(): void {
  setOpen(false)
}

/** 读取对话；弹窗打开且有未读的回复时记为已读。失败时抛出，列表保留上一次的结果。 */
export async function loadSupport(): Promise<void> {
  const list = await client.api<SupportMessage[]>('/api/cloud/support')
  setMessages(list)
  const last = list.at(-1)
  if (open() && last && supportUnread()) await markSupportRead(last.id).catch(() => {})
}

/** 发送一条消息，成功后追加到对话末尾。失败时抛出 `ApiError`，由调用方显示原因。 */
export async function sendSupport(body: string, files: readonly File[]): Promise<void> {
  const form = new FormData()
  form.set('body', body)
  for (const f of files) form.append('files', f)
  const path = '/api/cloud/support'
  // 不经 `client.api`：它为带请求体的请求设置 JSON 类型，multipart 的分隔符随之丢失。
  const res = await client.raw(path, { method: 'POST', body: form })
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => ''))
  const sent = (await res.json()) as SupportMessage
  setMessages((list) => (list?.some((m) => m.id === sent.id) ? list : [...(list ?? []), sent]))
}

/**
 * 下载附件：经本机服务取得内容，以浏览器下载保存为原文件名。不要改为在右侧面板打开 `supportFileUrl`：
 * 地址的查询串带本机服务的令牌，内置浏览器可由模型操作并读取地址，令牌随之泄露给模型。
 */
export async function downloadSupportFile(a: SupportAttachment): Promise<void> {
  const path = `/api/cloud/support/files/${encodeURIComponent(a.id)}`
  const res = await client.raw(path)
  if (!res.ok) throw new ApiError(res.status, path, await res.text().catch(() => ''))
  const url = URL.createObjectURL(await res.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = a.name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 图片附件的地址，只用作本界面中 `<img>` 的 `src`（理由见 `downloadSupportFile`）。 */
export function supportFileUrl(id: string): string {
  return client.assetUrl(`/api/cloud/support/files/${encodeURIComponent(id)}`)
}

/**
 * 云端推送客服对话有变化：重新读取未读数；弹窗打开时再重新读取对话。须先取得未读数：
 * `loadSupport` 按它判断是否记为已读，并行读取时按旧的未读数判断，弹窗中已显示的回复仍带圆点。
 */
export async function supportChanged(): Promise<void> {
  await refreshCloudState().catch(() => {})
  if (open()) await loadSupport().catch(() => {})
}
