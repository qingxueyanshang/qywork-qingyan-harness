/**
 * 本版说明：云端为当前版本发布的版本公告（服务端 `/api/cloud/release-notes`）。
 *
 * 更新后首次启动时显示一次：本机记录的版本与当前版本不同（包括没有记录）且读取到公告时弹出，关闭后记录当前版本。
 * 不要改为「只在记录存在且不同时弹出」：从不含本功能的版本升级时同样没有记录，这一次恰好不会显示。
 * 读取失败或该版本没有公告时不弹出、不记录，下次启动再读取。设置页的「本版说明」随时打开同一个弹窗。
 */

import type { ReleaseNotes } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client } from './connection.ts'

const SEEN_KEY = 'qywork.releaseNotes.seen'

/** 弹窗显示的版本。`notes` 是启动时已读取到的公告；从设置页打开时没有该项，由弹窗读取。 */
export interface ReleaseNotesView {
  version: string
  notes?: ReleaseNotes
}

const [view, setView] = createSignal<ReleaseNotesView | null>(null)
export const releaseNotesView = view

/** 该版本已发布的版本公告；没有或未配置云端时为 null。云端无法访问时抛出可直接显示的原因。 */
export function fetchReleaseNotes(version: string): Promise<ReleaseNotes | null> {
  return client.api<ReleaseNotes | null>(
    `/api/cloud/release-notes?version=${encodeURIComponent(version)}`,
  )
}

export function openReleaseNotes(version: string): void {
  setView({ version })
}

export function closeReleaseNotes(): void {
  const current = view()
  if (!current) return
  try {
    localStorage.setItem(SEEN_KEY, current.version)
  } catch {
    // 隐私模式下 localStorage 会抛出异常；无法记录时下次启动再显示一次。
  }
  setView(null)
}

/** 启动后以当前版本调用一次。 */
export async function showReleaseNotesOnce(version: string): Promise<void> {
  let seen: string | null = null
  try {
    seen = localStorage.getItem(SEEN_KEY)
  } catch {
    // 同上：读取失败按没有记录处理。
  }
  if (seen === version) return
  const notes = await fetchReleaseNotes(version).catch(() => null)
  if (notes && !view()) setView({ version, notes })
}
