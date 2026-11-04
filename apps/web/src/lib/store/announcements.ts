/**
 * 顶栏的公告：云端已发布的公告（服务端 `/api/cloud/announcements`），与官网顶栏的铃铛同一份数据、同一套规则。
 *
 * - 有公告时顶栏显示铃铛，最新一条未读时带圆点；没有公告、未配置云端或读取失败时铃铛不显示。
 * - 打开公告窗口即记为已读，已读位置是最新一条的 id，记在本机 localStorage。
 * - 每次与服务端的连接可用时读取一次（`App.tsx`）。
 */

import type { Announcement } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client } from './connection.ts'

const SEEN_KEY = 'qywork.announcements.seen'

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY)
  } catch {
    // 隐私模式下 localStorage 会抛出异常；按没有记录处理，圆点照常显示。
    return null
  }
}

const [list, setList] = createSignal<Announcement[]>([])
const [seen, setSeen] = createSignal<string | null>(readSeen())
const [open, setOpen] = createSignal(false)

export const announcements = list
export const announcementsOpen = open

/** 最新一条未读。 */
export function announcementsUnread(): boolean {
  const newest = list()[0]
  return newest !== undefined && newest.id !== seen()
}

/** 读取公告列表。失败时保留上一次的结果：铃铛的有无不随一次网络失败变化。 */
export async function loadAnnouncements(): Promise<void> {
  try {
    setList(await client.api<Announcement[]>('/api/cloud/announcements'))
  } catch {
    // 读取失败的终态是保留原列表（启动时为空，铃铛不显示），下次连接可用时再读取。
  }
}

export function openAnnouncements(): void {
  setOpen(true)
  const newest = list()[0]?.id
  if (!newest) return
  setSeen(newest)
  try {
    localStorage.setItem(SEEN_KEY, newest)
  } catch {
    // 同上：无法记录时下次启动仍显示圆点。
  }
}

export function closeAnnouncements(): void {
  setOpen(false)
}
