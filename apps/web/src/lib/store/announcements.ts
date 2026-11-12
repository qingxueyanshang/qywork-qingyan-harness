/**
 * 公告：云端已发布的公告（服务端 `/api/cloud/announcements`），与官网顶栏的铃铛同一份数据、同一套规则。
 *
 * - 有公告时账号窗口头部显示铃铛；最新一条未读时铃铛与侧栏的账号入口带圆点。
 *   没有公告、未配置云端或读取失败时铃铛不显示。
 * - 打开公告窗口即记为已读。已读位置是最新一条的 id，保存在云端账号上（账号状态的 `announcementSeen`）：
 *   官网、本机界面与远程打开的界面读写同一个值。不要另存在 localStorage：三处各存一份时互不可见。
 * - 每次与服务端的连接可用、窗口重新获得焦点时读取一次（`App.tsx`）。
 */

import type { Announcement } from '@qywork/core'
import { createSignal } from 'solid-js'
import { cloudState, markAnnouncementSeen } from './cloud.ts'
import { client } from './connection.ts'

const [list, setList] = createSignal<Announcement[]>([])
const [open, setOpen] = createSignal(false)

export const announcements = list
export const announcementsOpen = open

/**
 * 最新一条未读。未登录或已读位置未取得（账号状态中缺省）时不算未读。不要把缺省与 null（未读过任何公告）
 * 同等对待：缺省表示服务端从未取得云端的值，同等对待时云端读取失败即显示圆点。
 */
export function announcementsUnread(): boolean {
  const newest = list()[0]
  const account = cloudState()
  return (
    newest !== undefined &&
    account?.state === 'signed_in' &&
    account.announcementSeen !== undefined &&
    newest.id !== account.announcementSeen
  )
}

/** 读取公告列表。失败时保留上一次的结果：铃铛的有无不随一次网络失败变化。 */
export async function loadAnnouncements(): Promise<void> {
  try {
    setList(await client.api<Announcement[]>('/api/cloud/announcements'))
  } catch {
    // 读取失败的终态是保留原列表（启动时为空，铃铛不显示），下次连接可用时再读取。
  }
}

/** 打开公告窗口即记为已读；已读位置未取得时同样写入。 */
export function openAnnouncements(): void {
  setOpen(true)
  const newest = list()[0]?.id
  const account = cloudState()
  if (newest && account?.state === 'signed_in' && account.announcementSeen !== newest)
    void markAnnouncementSeen(newest).catch(() => {})
}

export function closeAnnouncements(): void {
  setOpen(false)
}
