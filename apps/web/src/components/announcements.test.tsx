/**
 * 公告：`lib/store/announcements.ts`（读取、未读判定与已读记录）与 `AnnouncementsDialog.tsx`（列表渲染、关闭）。
 * 服务端接口以替身代替。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Announcement } from '@qywork/core'

let store: typeof import('../lib/store/index.ts')
let feed: typeof import('../lib/store/announcements.ts')
let originalApi: typeof store.client.api
let calls: string[]
/** 替身的返回：公告列表，或抛出的错误。 */
let reply: Announcement[] | Error

const notice = (id: string, publishedAt: string): Announcement => ({
  id,
  kind: 'notice',
  version: null,
  title: `通知 ${id}`,
  body: '今晚 23:00 维护。',
  publishedAt,
})
const RELEASE: Announcement = {
  id: '1',
  kind: 'release',
  version: '0.3.11',
  title: 'qywork 0.3.11 更新',
  body: '### 云端账号\n\n- 应用内登录',
  publishedAt: '2026-11-04T11:22:21.544Z',
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
  store = await import('../lib/store/index.ts')
  feed = await import('../lib/store/announcements.ts')
  originalApi = store.client.api
  store.client.api = async <T,>(path: string): Promise<T> => {
    calls.push(path)
    if (path !== '/api/cloud/announcements') throw new Error(`unexpected ${path}`)
    if (reply instanceof Error) throw reply
    return structuredClone(reply) as T
  }
})

beforeEach(() => {
  calls = []
  feed.closeAnnouncements()
  localStorage.clear()
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

test('最新一条未读时显示圆点；打开后记为已读并写入本机记录；有更新的公告时再次未读', async () => {
  reply = [notice('2', '2026-11-05T08:00:00.000Z'), RELEASE]
  await feed.loadAnnouncements()
  expect(calls).toEqual(['/api/cloud/announcements'])
  expect(feed.announcements().map((a) => a.id)).toEqual(['2', '1'])
  expect(feed.announcementsUnread()).toBe(true)

  feed.openAnnouncements()
  expect(feed.announcementsOpen()).toBe(true)
  expect(feed.announcementsUnread()).toBe(false)
  expect(localStorage.getItem('qywork.announcements.seen')).toBe('2')
  feed.closeAnnouncements()
  expect(feed.announcementsOpen()).toBe(false)

  await feed.loadAnnouncements()
  expect(feed.announcementsUnread()).toBe(false)
  reply = [
    notice('3', '2026-11-06T08:00:00.000Z'),
    notice('2', '2026-11-05T08:00:00.000Z'),
    RELEASE,
  ]
  await feed.loadAnnouncements()
  expect(feed.announcementsUnread()).toBe(true)
})

test('读取失败时保留上一次的列表；没有公告时不算未读', async () => {
  reply = [RELEASE]
  await feed.loadAnnouncements()
  reply = new Error('无法连接账号服务')
  await feed.loadAnnouncements()
  expect(feed.announcements().map((a) => a.id)).toEqual(['1'])
  reply = []
  await feed.loadAnnouncements()
  expect(feed.announcements()).toEqual([])
  expect(feed.announcementsUnread()).toBe(false)
})

test('公告窗口：新者在前列出类型、日期、标题与按 Markdown 渲染的正文；关闭按钮关闭窗口', async () => {
  reply = [notice('2', '2026-11-05T08:00:00.000Z'), RELEASE]
  await feed.loadAnnouncements()
  feed.openAnnouncements()
  const { render } = await import('solid-js/web')
  const { default: AnnouncementsDialog } = await import('./AnnouncementsDialog.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <AnnouncementsDialog />, host)
  const items = [...host.querySelectorAll('.announcements-item')]
  expect(items.map((i) => i.querySelector('.announcements-meta')?.textContent)).toEqual([
    '通知 · 2026-11-05',
    '版本更新 · 2026-11-04',
  ])
  expect(items.map((i) => i.querySelector('h3')?.textContent)).toEqual([
    '通知 2',
    'qywork 0.3.11 更新',
  ])
  expect(items[1]?.querySelector('.markdown li')?.textContent).toBe('应用内登录')
  ;[...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === '关闭')?.click()
  expect(feed.announcementsOpen()).toBe(false)
  dispose()
  host.remove()
})
