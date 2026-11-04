/**
 * 本版说明：云端为当前版本发布的版本公告（服务端 `/api/cloud/release-notes`）。
 *
 * 更新后首次启动时显示一次：本机记录的版本与当前版本不同（包括没有记录）且读取到公告时弹出，关闭后记录当前版本。
 * 不要改为「只在记录存在且不同时弹出」：从不含本功能的版本升级时同样没有记录，这一次恰好不会显示。
 * 读取失败或该版本没有公告时不弹出、不记录，下次启动再读取。
 */

import type { ReleaseNotes } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client } from './connection.ts'

const SEEN_KEY = 'qywork.releaseNotes.seen'

/** 弹窗显示的公告；没有弹窗时为 null。 */
const [shown, setShown] = createSignal<ReleaseNotes | null>(null)
export const releaseNotesShown = shown

export function closeReleaseNotes(): void {
  const current = shown()
  if (!current) return
  try {
    localStorage.setItem(SEEN_KEY, current.version)
  } catch {
    // 隐私模式下 localStorage 会抛出异常；无法记录时下次启动再显示一次。
  }
  setShown(null)
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
  const notes = await client
    .api<ReleaseNotes | null>(`/api/cloud/release-notes?version=${encodeURIComponent(version)}`)
    .catch(() => null)
  if (notes && !shown()) setShown(notes)
}
