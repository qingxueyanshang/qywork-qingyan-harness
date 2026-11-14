/**
 * 公告：`lib/store/announcements.ts`（读取、未读判定与已读记录）、`lib/store/cloud.ts` 的 `markAnnouncementSeen`
 * 与 `AnnouncementsDialog.tsx`（列表渲染、关闭）。服务端接口以替身代替，已读位置在替身的账号状态中。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Announcement, CloudState } from '@qywork/core'

let store: typeof import('../lib/store/index.ts')
let feed: typeof import('../lib/store/announcements.ts')
let cloudStore: typeof import('../lib/store/cloud.ts')
let originalApi: typeof store.client.api
let calls: string[]
/** 替身的返回：公告列表，或抛出的错误。 */
let reply: Announcement[] | Error
/** 替身的账号状态：已读位置保存在其中，与云端账号相同。 */
let account: Extract<CloudState, { state: 'signed_in' }>
/** 读取账号状态时代替 `account` 的返回：另一种账号状态，或抛出的错误（本机服务无法访问）。 */
let stateReply: CloudState | Error | null

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
  cloudStore = await import('../lib/store/cloud.ts')
  originalApi = store.client.api
  store.client.api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(path)
    if (path === '/api/cloud/state') {
      if (stateReply instanceof Error) throw stateReply
      return structuredClone(stateReply ?? account) as T
    }
    if (path === '/api/cloud/announcements/seen') {
      account = {
        ...account,
        announcementSeen: (JSON.parse(String(init?.body)) as { id: string }).id,
      }
      return structuredClone(account) as T
    }
    if (path !== '/api/cloud/announcements') throw new Error(`unexpected ${path}`)
    if (reply instanceof Error) throw reply
    return structuredClone(reply) as T
  }
})

beforeEach(async () => {
  account = {
    state: 'signed_in',
    email: 'me@example.com',
    name: '',
    credits: 1,
    avatar: null,
    provider: 'qywork',
    origin: 'https://qywork.io',
    recharge: false,
    announcementSeen: null,
  }
  stateReply = null
  feed.closeAnnouncements()
  calls = []
  await cloudStore.refreshCloudState()
  calls = []
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

test('最新一条未读时显示圆点；打开后记为已读并写入云端账号；另一端已读后本端读取账号状态即为已读；有更新的公告时再次未读', async () => {
  reply = [notice('2', '2026-11-05T08:00:00.000Z'), RELEASE]
  await feed.loadAnnouncements()
  expect(calls).toEqual(['/api/cloud/announcements'])
  expect(feed.announcements().map((a) => a.id)).toEqual(['2', '1'])
  expect(feed.announcementsUnread()).toBe(true)

  feed.openAnnouncements()
  expect(feed.announcementsOpen()).toBe(true)
  expect(feed.announcementsUnread()).toBe(false)
  await Bun.sleep(0)
  expect(calls).toContain('/api/cloud/announcements/seen')
  expect(account.announcementSeen).toBe('2')
  expect(localStorage.getItem('qywork.announcements.seen')).toBeNull()
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
  // 另一端（官网或另一台设备上打开的界面）读过之后，本端重新读取账号状态即为已读。
  account = { ...account, announcementSeen: '3' }
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)
})

/**
 * 原始失败形状：云端读取失败时账号状态的已读位置为 null，与「未读过任何公告」相同，最新一条被判为未读，
 * 窗口每次获得焦点时的读取失败一次，圆点就重新出现。
 */
test('账号状态 成功 → 失败 → 成功：已读位置未取得时不算未读，沿用的值照常判定；退出后不算未读', async () => {
  reply = [notice('2', '2026-11-05T08:00:00.000Z'), RELEASE]
  await feed.loadAnnouncements()
  account = { ...account, announcementSeen: '2' }
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)

  // 服务端从未取得已读位置：缺省。
  const { announcementSeen: _seen, ...unknown } = account
  stateReply = unknown
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)
  // 本机服务本身无法访问：账号状态不变。
  stateReply = new Error('无法连接服务端')
  await expect(cloudStore.refreshCloudState()).rejects.toThrow('无法连接服务端')
  expect(feed.announcementsUnread()).toBe(false)

  stateReply = null
  reply = [notice('3', '2026-11-06T08:00:00.000Z'), notice('2', '2026-11-05T08:00:00.000Z')]
  await feed.loadAnnouncements()
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(true)
  // 读取失败时服务端沿用上一次取得的值：确有未读时圆点保留。
  stateReply = { ...account, credits: null }
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(true)
  stateReply = null
  account = { ...account, announcementSeen: '3' }
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)

  stateReply = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)
})

test('已读位置未取得时打开公告窗口同样写入已读位置', async () => {
  reply = [notice('2', '2026-11-05T08:00:00.000Z'), RELEASE]
  await feed.loadAnnouncements()
  const { announcementSeen: _seen, ...unknown } = account
  account = unknown
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)
  // 写入请求在 `openAnnouncements` 返回前即已发出（替身同步记下已读位置）。
  feed.openAnnouncements()
  expect(calls).toContain('/api/cloud/announcements/seen')
  expect(account.announcementSeen).toBe('2')
  await cloudStore.refreshCloudState()
  expect(feed.announcementsUnread()).toBe(false)
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
