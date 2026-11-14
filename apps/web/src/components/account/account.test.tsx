/**
 * 账号界面：`AccountEntry.tsx`（侧栏入口）、`AccountDialog.tsx`（账号弹窗，其中的手机接入见 `PairPanel.test.tsx`）、`LoginForm.tsx`（登录表单）、`NameEdit.tsx`（用户名的修改）、
 * `RechargeDialog.tsx`（充值窗口）、
 * `ActivityGrid.tsx`（Token 活动方格）、`../LoginGate.tsx`（首次启动的登录页），以及 `lib/store/cloud.ts`。
 * 服务端接口以替身代替，状态以替身返回值为准。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Announcement, CloudRequest, CloudState, CloudUsage } from '@qywork/core'
import type { JSX } from 'solid-js'

let store: typeof import('../../lib/store/index.ts')
let cloudStore: typeof import('../../lib/store/cloud.ts')
let originalApi: typeof store.client.api
let ApiError: typeof import('../../lib/client.ts').ApiError
let cloud: CloudState
let providers: unknown[]
/** 模型目录中已配置的生成模型。 */
let media: unknown[]
let calls: string[]
let pages: CloudRequest[][]
/** 使用记录的读取在它完成前不返回。 */
let requestsGate: Promise<void>
/** 云端已发布的公告，新者在前。 */
let notices: Announcement[]
/** 充值订单状态的依次答复；`Error` 表示该次读取失败。 */
let rechargeReplies: (string | Error)[]
/** 为真时用量、可用模型与使用记录的读取全部失败。 */
let cloudDown: boolean
/** 服务端配置：云端接口下有两个型号，默认对话模型是本地接口的型号。 */
let stored: Record<string, unknown> = {}
const STORED = {
  providers: {
    local: { kind: 'openai_chat_completions', hasApiKey: true, models: { mine: {} } },
    qywork: {
      kind: 'anthropic_messages',
      hasApiKey: true,
      models: { 'claude-opus-5-5': {}, 'relay-model': {} },
    },
  },
  active: { provider: 'local', model: 'mine' },
}

const SIGNED_IN: CloudState = {
  state: 'signed_in',
  email: 'me@example.com',
  name: '',
  credits: 12.5,
  avatar: null,
  provider: 'qywork',
  origin: 'https://qywork.io',
  recharge: true,
  announcementSeen: null,
}

const USAGE: CloudUsage = {
  requests: 3,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 2000,
  cacheWriteTokens: 0,
  credits: 1.5,
  days: [],
}

function record(
  id: string,
  failure: string | null = null,
  terms: Partial<
    Pick<CloudRequest, 'longContext' | 'offPeak' | 'cacheWrite1hTokens' | 'mediaMeter' | 'modelId'>
  > = {},
): CloudRequest {
  return {
    id,
    modelId: 'claude-sonnet-5-5',
    failure,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: terms.cacheWrite1hTokens ?? 0,
    cacheWrite1hTokens: 0,
    longContext: false,
    offPeak: false,
    mediaMeter: null,
    ...terms,
    credits: 0.25,
    startedAt: new Date(Date.UTC(2026, 10, 1) + Number(id) * 60_000).toISOString(),
  }
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click', 'input', 'submit'])
  store = await import('../../lib/store/index.ts')
  cloudStore = await import('../../lib/store/cloud.ts')
  ApiError = (await import('../../lib/client.ts')).ApiError
  originalApi = store.client.api
  store.client.api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    calls.push(`${init?.method ?? 'GET'} ${path}`)
    if (path === '/api/models') {
      return { providers, media, mediaLibrary: [], library: [] } as T
    }
    if (path === '/api/cloud/state') return structuredClone(cloud) as T
    if (path === '/api/cloud/login') {
      const body = JSON.parse(String(init?.body)) as { password: string }
      if (body.password !== 'password-123') {
        throw new ApiError(400, path, JSON.stringify({ error: 'cloud', message: '邮箱或密码错误' }))
      }
      cloud = SIGNED_IN
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/logout') {
      cloud = { state: 'signed_out' }
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/avatar') {
      const { image } = JSON.parse(String(init?.body)) as { image: string }
      cloud = { ...(SIGNED_IN as Extract<CloudState, { state: 'signed_in' }>), avatar: image }
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/name') {
      const { name } = JSON.parse(String(init?.body)) as { name: string }
      if (name.length > 30) {
        throw new ApiError(
          400,
          path,
          JSON.stringify({ error: 'cloud', message: '用户名不超过 30 个字符' }),
        )
      }
      cloud = { ...(SIGNED_IN as Extract<CloudState, { state: 'signed_in' }>), name }
      return structuredClone(cloud) as T
    }
    if (path === '/api/config') {
      if (init?.method === 'PUT') {
        stored = JSON.parse(String(init.body)).config
        return { ok: true } as T
      }
      return {
        config: structuredClone(stored),
        path: '',
        version: 'v',
        notices: [],
        problems: [],
        defaultEnvAllowList: [],
      } as T
    }
    if (path === '/api/pairing') return { available: false, enabled: false, tunnel: null } as T
    if (cloudDown && /^\/api\/cloud\/(usage|models|requests)/.test(path)) {
      throw new ApiError(400, path, JSON.stringify({ error: 'cloud', message: '无法连接账号服务' }))
    }
    if (path === '/api/cloud/usage') return structuredClone(USAGE) as T
    if (path === '/api/cloud/models') {
      return [
        {
          output: 'chat',
          id: 'claude-opus-5-5',
          ratio: 0.85,
          official: true,
          price: { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 },
        },
        {
          output: 'chat',
          id: 'relay-model',
          ratio: 1,
          official: false,
          price: { input: 100, output: 200, cacheRead: 0.0175, cacheWrite: 0 },
        },
        {
          output: 'video',
          id: 'doubao-seedance-2-0-260128',
          unit: 'second',
          unitPrice: { '720p': 0.2, '1080p': 0.4 },
        },
      ] as T
    }
    if (path.startsWith('/api/cloud/requests')) {
      await requestsGate
      return (pages.shift() ?? []) as T
    }
    if (path === '/api/cloud/announcements') return structuredClone(notices) as T
    if (path === '/api/cloud/announcements/seen') {
      const { id } = JSON.parse(String(init?.body)) as { id: string }
      cloud = { ...(cloud as Extract<CloudState, { state: 'signed_in' }>), announcementSeen: id }
      return structuredClone(cloud) as T
    }
    if (path === '/api/cloud/recharge') {
      const { amount } = JSON.parse(String(init?.body)) as { amount: number }
      return {
        orderNo: `QY${calls.filter((c) => c === 'POST /api/cloud/recharge').length}`,
        codeUrl: 'weixin://wxpay/bizpayurl?pr=TEST',
        amount,
        expiresAt: '2026-11-04T04:05:00.000Z',
      } as T
    }
    if (path.startsWith('/api/cloud/recharge/')) {
      const reply = rechargeReplies.shift() ?? 'pending'
      if (reply instanceof Error) {
        throw new ApiError(400, path, JSON.stringify({ error: 'cloud', message: reply.message }))
      }
      if (reply === 'paid')
        cloud = { ...(SIGNED_IN as Extract<CloudState, { state: 'signed_in' }>), credits: 62.5 }
      return { status: reply } as T
    }
    throw new Error(`unexpected ${path}`)
  }
})

beforeEach(async () => {
  cloud = { state: 'signed_out' }
  providers = []
  media = []
  calls = []
  pages = []
  requestsGate = Promise.resolve()
  notices = []
  rechargeReplies = []
  cloudDown = false
  stored = structuredClone(STORED)
  store.setAccountOpen(false)
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mount(view: () => JSX.Element) {
  const { render } = await import('solid-js/web')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(view, host)
  return {
    host,
    text: () => host.textContent ?? '',
    button: (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label),
    fill: (type: string, value: string) => {
      const input = host.querySelector(`input[type="${type}"]`) as HTMLInputElement
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    },
    close: () => {
      dispose()
      host.remove()
    },
  }
}

async function entry() {
  const { AccountEntry } = await import('./AccountEntry.tsx')
  return mount(() => (
    <ul>
      <AccountEntry />
    </ul>
  ))
}

async function dialog(retryMs?: number) {
  const { default: AccountDialog } = await import('./AccountDialog.tsx')
  return mount(() => <AccountDialog {...(retryMs === undefined ? {} : { retryMs })} />)
}

test('侧栏入口：未配置云端服务时不出现；未登录显示「登录」，已登录显示邮箱；点击打开账号弹窗', async () => {
  cloud = { state: 'unavailable' }
  await cloudStore.refreshCloudState()
  const hidden = await entry()
  expect(hidden.host.querySelector('.account-entry')).toBeNull()
  hidden.close()

  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  const out = await entry()
  expect(out.text()).toBe('登录')
  out.close()

  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const view = await entry()
  expect(view.text()).toContain('me@example.com')
  ;(view.host.querySelector('.account-entry') as HTMLButtonElement).click()
  expect(store.accountOpen()).toBe(true)
  view.close()
})

test('登录表单：密码错误时显示原因；登录成功后弹窗显示账号、统计与使用记录，积分后标注计价条件', async () => {
  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  pages = [
    [
      record('3', null, { longContext: true, cacheWrite1hTokens: 100 }),
      record('2', null, { offPeak: true }),
      record('1', '429 请求过多'),
    ],
  ]
  const view = await dialog()
  await until(() => view.host.querySelector('.account-form') !== null)

  view.fill('email', 'me@example.com')
  view.fill('password', 'wrong-password')
  ;(view.host.querySelector('form') as HTMLFormElement).requestSubmit()
  await until(() => view.text().includes('邮箱或密码错误'))

  view.fill('password', 'password-123')
  ;(view.host.querySelector('form') as HTMLFormElement).requestSubmit()
  await until(() => view.text().includes('使用记录') && view.text().includes('429 请求过多'))
  expect(view.text()).toContain('me@example.com')
  expect(view.text()).toContain('12.50')
  expect(view.text()).toContain('1.50')
  // 累计 Token 为四项之和；「输入」含缓存命中。
  expect(view.text()).toContain('3.5K')
  expect(view.text()).toContain('完成')
  const rowOf = (id: string) => {
    const at = new Date(record(id).startedAt).getMinutes().toString().padStart(2, '0')
    return [...view.host.querySelectorAll('tbody tr')].find((r) =>
      r.querySelector('td')?.textContent?.endsWith(`:${at}`),
    )
  }
  const terms = (id: string) =>
    [...(rowOf(id)?.querySelectorAll('.account-term') ?? [])].map((t) => t.textContent)
  expect(terms('3')).toEqual(['长上下文', '1 小时缓存'])
  expect(terms('2')).toEqual(['空闲时段'])
  // 积分在前、标记在后。
  expect(rowOf('2')?.querySelector('.account-term')?.parentElement?.textContent).toBe(
    '0.25空闲时段',
  )
  expect(terms('1')).toEqual([])
  // 可用模型、倍率与单价（积分 / 百万 token）；读取后模型列表随之刷新。
  await until(() => view.text().includes('claude-opus-5-5'))
  expect(view.text()).toContain('1,500')
  expect(view.text()).toContain('0.85×')
  // 倍率只相对官方价列出；按单价计价的型号此列为「—」。
  expect(view.text()).toContain('倍率（官方价）')
  const relay = [...view.host.querySelectorAll('tr')].find((r) =>
    r.textContent?.includes('relay-model'),
  )
  expect(relay?.querySelectorAll('td')[1]?.textContent).toBe('—')
  // 单价按实际值显示，不按金额保留两位小数：0.0175 不显示为 0.02，0 不显示为 0.00。
  expect(
    [...(relay?.querySelectorAll('td') ?? [])].slice(2, 6).map((td) => td.textContent),
  ).toEqual(['100', '200', '0.0175', '0'])
  // 生成型号按类别单独成表：参数、计费单位与逐档单价；模型目录中没有该型号时参数为「—」。
  expect(view.text()).toContain('视频')
  const seedance = [...view.host.querySelectorAll('tr')].find((r) =>
    r.textContent?.includes('doubao-seedance-2-0-260128'),
  )
  expect(
    [...(seedance?.querySelectorAll('td') ?? [])].slice(1, 4).map((td) => td.textContent),
  ).toEqual(['—', '每秒', '720p 0.2 · 1080p 0.4'])
  expect(calls).toContain('GET /api/models')
  // 不足一页：没有更早的记录。
  expect(view.button('加载更早记录')).toBeUndefined()
  view.close()
})

test('使用记录满一页时可继续加载，续页位置为上一页最后一条的时间', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  pages = [Array.from({ length: 50 }, (_, i) => record(String(99 - i))), [record('1')]]
  const view = await dialog()
  await until(() => view.button('加载更早记录') !== undefined)
  view.button('加载更早记录')?.click()
  // 使用记录是弹窗中的最后一张表，上方还有「可用模型」表。
  const records = () =>
    [...view.host.querySelectorAll('.lib-table')].at(-1)?.querySelectorAll('tbody tr').length
  await until(() => records() === 51)
  const last = calls.filter((c) => c.startsWith('GET /api/cloud/requests')).at(-1)
  expect(last).toContain(`before=${encodeURIComponent(record('50').startedAt)}`)
  expect(view.button('加载更早记录')).toBeUndefined()
  view.close()
})

/**
 * 原始失败形状：使用记录按电脑的时区显示。电脑设为纽约时区时，北京时间 11-12 07:30 的记录显示为
 * 11/11 18:30，与云端网页账号页的北京时间不一致。
 */
test('使用记录按北京时间显示，不随电脑的时区变化', async () => {
  const tzBefore = process.env.TZ
  process.env.TZ = 'America/New_York'
  try {
    // 前提：本进程的本地时区已切换为纽约。
    expect(new Date('2026-11-11T23:30:00.000Z').getHours()).toBe(18)
    cloud = SIGNED_IN
    await cloudStore.refreshCloudState()
    pages = [[{ ...record('1'), startedAt: '2026-11-11T23:30:00.000Z' }]]
    const view = await dialog()
    const firstCell = () =>
      [...view.host.querySelectorAll('.lib-table')].at(-1)?.querySelector('tbody tr td')
    await until(() => firstCell() != null)
    expect(firstCell()?.textContent).toContain('11/12 07:30')
    view.close()
  } finally {
    if (tzBefore === undefined) delete process.env.TZ
    else process.env.TZ = tzBefore
  }
})

test('退出登录后弹窗显示登录表单', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const view = await dialog()
  await until(() => view.host.querySelector('button[aria-label="退出登录"]') !== null)
  ;(view.host.querySelector('button[aria-label="退出登录"]') as HTMLButtonElement).click()
  await until(() => view.host.querySelector('.account-form') !== null)
  expect(calls).toContain('POST /api/cloud/logout')
  view.close()
})

test('官网按钮：在右侧面板打开云端地址的首页，并关闭账号弹窗', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  // 右侧面板的页签属于工作区，没有工作区时不打开。
  store.setWorkspace({ id: 'ws_account', root: 'C:/ws', name: 'ws' })
  store.setAccountOpen(true)
  const view = await dialog()
  const button = () =>
    view.host.querySelector('button[aria-label="打开官网"]') as HTMLButtonElement | null
  await until(() => button() !== null)
  button()?.click()
  expect(
    store.panelTabs().some((t) => t.kind === 'preview' && t.url === 'https://qywork.io/'),
  ).toBe(true)
  expect(store.accountOpen()).toBe(false)
  store.setWorkspace(null)
  view.close()
})

test('公告：未读时侧栏入口与账号窗口的铃铛带圆点，打开公告后都消失；未登录时入口不带圆点；没有公告时没有铃铛', async () => {
  const feed = await import('../../lib/store/announcements.ts')
  const unread = (host: HTMLElement) => host.querySelector('[aria-label="有新公告"]') !== null
  notices = [
    {
      id: '7',
      kind: 'notice',
      version: null,
      title: '服务维护',
      body: '今晚维护。',
      publishedAt: '2026-11-05T08:00:00.000Z',
    },
  ]
  await feed.loadAnnouncements()

  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  const out = await entry()
  expect(unread(out.host)).toBe(false)
  out.close()

  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const side = await entry()
  expect(unread(side.host)).toBe(true)
  store.setAccountOpen(true)
  const view = await dialog()
  const bell = () =>
    view.host.querySelector('button[aria-label="公告"]') as HTMLButtonElement | null
  await until(() => bell() !== null)
  expect(unread(bell() as HTMLElement)).toBe(true)
  bell()?.click()
  expect(feed.announcementsOpen()).toBe(true)
  expect(unread(bell() as HTMLElement)).toBe(false)
  expect(unread(side.host)).toBe(false)
  feed.closeAnnouncements()
  // 已读位置写在云端账号上：另一端读取账号状态后同样没有圆点。
  await until(() => calls.includes('POST /api/cloud/announcements/seen'))
  expect((cloud as Extract<CloudState, { state: 'signed_in' }>).announcementSeen).toBe('7')
  // 另一端读到了更新的一条公告之后，本端重新读取账号状态，圆点随之消失。
  notices = [{ ...notices[0]!, id: '8' }]
  await feed.loadAnnouncements()
  expect(unread(side.host)).toBe(true)
  cloud = { ...(cloud as Extract<CloudState, { state: 'signed_in' }>), announcementSeen: '8' }
  await cloudStore.refreshCloudState()
  expect(unread(side.host)).toBe(false)

  notices = []
  await feed.loadAnnouncements()
  expect(bell()).toBeNull()
  side.close()
  view.close()
})

test('使用记录读取超过 200 毫秒时显示占位，读取到后显示记录', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  let release!: () => void
  requestsGate = new Promise((resolve) => {
    release = resolve
  })
  pages = [[record('1')]]
  const view = await dialog()
  await new Promise((resolve) => setTimeout(resolve, 260))
  // 统计与可用模型已返回，只有使用记录仍在读取。
  expect(view.host.querySelectorAll('.skeleton')).toHaveLength(1)
  release()
  await until(() => view.text().includes('完成'))
  expect(view.host.querySelector('.skeleton')).toBeNull()
  view.close()
})

test('用量、可用模型与使用记录都读取失败时只显示一处原因与一个重试；重试后重新读取账号状态并显示各节', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  cloudDown = true
  pages = [[record('1')]]
  const view = await dialog()
  await until(() => view.button('重试') !== undefined)
  // 三项读取都已失败之后再断言。
  await until(() => calls.filter((c) => c.startsWith('GET /api/cloud/requests')).length === 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(view.text().split('无法连接账号服务')).toHaveLength(2)
  expect(view.host.querySelectorAll('.settings-error')).toHaveLength(1)
  expect(view.text()).not.toContain('使用记录')
  expect(view.text()).not.toContain('积分 / 百万 token')

  cloudDown = false
  const stateReads = () => calls.filter((c) => c === 'GET /api/cloud/state').length
  const before = stateReads()
  view.button('重试')?.click()
  await until(() => view.text().includes('完成') && view.text().includes('claude-opus-5-5'))
  expect(view.text()).toContain('累计 Token')
  expect(view.host.querySelector('.settings-error')).toBeNull()
  expect(stateReads()).toBeGreaterThan(before)
  view.close()
})

test('读取失败后不经操作自动重新读取：云端恢复后各节出现，报错消失', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  cloudDown = true
  pages = [[record('1')]]
  const view = await dialog(20)
  await until(() => view.button('重试') !== undefined)
  // 云端未恢复期间持续重新读取，报错始终只有一处。
  const usageReads = () => calls.filter((c) => c === 'GET /api/cloud/usage').length
  await until(() => usageReads() >= 3)
  expect(view.host.querySelectorAll('.settings-error')).toHaveLength(1)

  cloudDown = false
  await until(() => view.text().includes('完成') && view.text().includes('claude-opus-5-5'))
  expect(view.text()).toContain('累计 Token')
  expect(view.host.querySelector('.settings-error')).toBeNull()
  // 成功后不再读取。
  const settled = usageReads()
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(usageReads()).toBe(settled)
  view.close()
})

test('首次启动且没有任何接口时显示登录页；已有接口时不显示', async () => {
  cloud = { state: 'signed_out' }
  await cloudStore.refreshCloudState()
  const { LoginGate } = await import('../LoginGate.tsx')
  const first = await mount(() => <LoginGate />)
  await until(() => first.host.querySelector('.login-gate .account-form') !== null)
  expect(first.text()).toContain('使用自己的 API key')
  first.close()

  providers = [{ name: 'mine', kind: 'openai_chat_completions', models: [] }]
  await (await import('../../lib/store/settings.ts')).reloadModelCatalog()
  const later = await mount(() => <LoginGate />)
  await new Promise((r) => setTimeout(r, 20))
  expect(later.host.querySelector('.login-gate')).toBeNull()
  later.close()
})

test('Token 活动：53 列 × 7 行，今天之后不绘制，按有请求日子中的名次分档，月初所在列带月份', async () => {
  const { activityCells } = await import('./ActivityGrid.tsx')
  const today = new Date(2026, 10, 4, 15) // 2026-11-04，周三
  const { cells, months } = activityCells(
    [
      { day: '2026-11-01', requests: 1, tokens: 10, credits: 0 },
      { day: '2026-11-02', requests: 1, tokens: 20, credits: 0 },
      { day: '2026-11-03', requests: 1, tokens: 30, credits: 0 },
      { day: '2026-11-04', requests: 1, tokens: 40, credits: 0 },
    ],
    today,
  )
  expect(cells).toHaveLength(53 * 7)
  const last = cells.slice(-7)
  expect(last.map((c) => c.day)).toEqual([
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
  ])
  expect(last.map((c) => c.future)).toEqual([false, false, false, true, true, true, true])
  const level = (day: string) => cells.find((c) => c.day === day)?.level
  expect([
    level('2026-11-01'),
    level('2026-11-02'),
    level('2026-11-03'),
    level('2026-11-04'),
  ]).toEqual([1, 2, 3, 4])
  expect(level('2026-10-31')).toBe(0)
  // 只有一天有请求时为最深一档。
  const single = activityCells([{ day: '2026-11-04', requests: 1, tokens: 5, credits: 0 }], today)
  expect(single.cells.find((c) => c.day === '2026-11-04')?.level).toBe(4)
  // 11 月 1 日是周日，位于倒数第二列。
  expect(months.at(-2)).toBe('11月')
  expect(months).toHaveLength(53)
})

test('模型下拉列表：已登录时账号的模型排在最前，分组名为「账号订阅」', async () => {
  const row = (id: string) => ({
    id,
    label: id,
    effortLevels: [],
    effort: null,
    currency: 'USD',
    vision: null,
    video: false,
    known: true,
  })
  providers = [
    { name: 'mine', models: [row('m1')] },
    { name: 'qywork', models: [row('claude-sonnet-5-5')] },
  ]
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  await (await import('../../lib/store/settings.ts')).reloadModelCatalog()
  store.setState({
    activeConversation: 'cv',
    conversations: [{ id: 'cv', provider: 'mine', model: 'm1' } as never],
    busyConversations: [],
    views: {},
  })
  const { ModelPicker } = await import('../ModelPicker.tsx')
  const view = await mount(() => <ModelPicker />)
  try {
    ;(view.host.querySelector('.mode-chip') as HTMLButtonElement).click()
    const entry = [...view.host.querySelectorAll<HTMLButtonElement>('.model-entry')].find((b) =>
      b.textContent?.includes('模型'),
    )
    entry?.click()
    await until(() => view.host.querySelectorAll('.model-group-name').length === 2)
    expect(
      [...view.host.querySelectorAll('.model-group-name')].map((g) => g.textContent?.trim()),
    ).toEqual(['账号订阅', 'mine'])
  } finally {
    view.close()
    store.setState({
      activeConversation: null,
      conversations: [],
      busyConversations: [],
      views: {},
    })
  }
})

test('更换头像后，侧栏入口与账号弹窗显示头像图片，不再显示首字母', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const side = await entry()
  const view = await dialog()
  await until(() => view.host.querySelector('.account-head .account-avatar') !== null)
  expect(view.host.querySelector('.account-head .account-avatar img')).toBeNull()
  const image = 'data:image/webp;base64,UklGRg=='
  await cloudStore.setCloudAvatar(image)
  await until(() => view.host.querySelector('.account-head .account-avatar img') !== null)
  expect(view.host.querySelector('.account-head .account-avatar img')?.getAttribute('src')).toBe(
    image,
  )
  expect(side.host.querySelector('.account-avatar img')?.getAttribute('src')).toBe(image)
  expect(calls).toContain('PUT /api/cloud/avatar')
  side.close()
  view.close()
})

test('用户名：未设置时入口显示邮箱、弹窗显示「设置用户名」；保存后入口、弹窗与头像首字符都改为用户名，邮箱仍显示；Escape 放弃且弹窗保留；清除后恢复', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  store.setAccountOpen(true)
  const side = await entry()
  const view = await dialog()
  const nameButton = () => view.host.querySelector<HTMLButtonElement>('.account-name')
  const input = () => view.host.querySelector<HTMLInputElement>('.account-name-input')
  const saves = () => calls.filter((c) => c === 'PUT /api/cloud/name').length
  await until(() => nameButton() !== null)
  expect(nameButton()?.textContent).toBe('设置用户名')
  expect(side.host.querySelector('.account-entry-name')?.textContent).toBe('me@example.com')
  expect(side.host.querySelector('.account-avatar')?.textContent).toBe('M')

  // Escape 放弃：不写入，账号弹窗保留。
  nameButton()?.click()
  await until(() => input() !== null)
  ;(input() as HTMLInputElement).value = '放弃'
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => input() === null)
  expect(saves()).toBe(0)
  expect(store.accountOpen()).toBe(true)

  // Enter 保存，首尾空白不保存。
  nameButton()?.click()
  await until(() => input() !== null)
  ;(input() as HTMLInputElement).value = '  青学  '
  input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(() => nameButton()?.textContent === '青学')
  expect(saves()).toBe(1)
  expect(side.host.querySelector('.account-entry-name')?.textContent).toBe('青学')
  expect(side.host.querySelector('.account-avatar')?.textContent).toBe('青')
  expect(view.host.querySelector('.account-email')?.textContent).toBe('me@example.com')

  // 内容未改变时失去焦点不写入。
  nameButton()?.click()
  await until(() => input() !== null)
  input()?.dispatchEvent(new Event('blur'))
  await until(() => input() === null)
  expect(saves()).toBe(1)

  // 云端拒绝时显示原因，用户名不变。
  nameButton()?.click()
  await until(() => input() !== null)
  ;(input() as HTMLInputElement).value = '字'.repeat(31)
  input()?.dispatchEvent(new Event('blur'))
  await until(() => view.text().includes('用户名不超过 30 个字符'))
  expect(nameButton()?.textContent).toBe('青学')

  // 保存空内容即清除。
  nameButton()?.click()
  await until(() => input() !== null)
  ;(input() as HTMLInputElement).value = ''
  input()?.dispatchEvent(new Event('blur'))
  await until(() => nameButton()?.textContent === '设置用户名')
  expect(side.host.querySelector('.account-entry-name')?.textContent).toBe('me@example.com')
  store.setAccountOpen(false)
  side.close()
  view.close()
})

test('充值按钮：云端开通充值时显示在头部行尾，未开通时不显示；点击打开充值窗口，关闭按钮移除窗口', async () => {
  cloud = { ...(SIGNED_IN as Extract<CloudState, { state: 'signed_in' }>), recharge: false }
  await cloudStore.refreshCloudState()
  const off = await dialog()
  await until(() => off.host.querySelector('.account-head') !== null)
  expect(off.button('充值')).toBeUndefined()
  off.close()

  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const view = await dialog()
  await until(() => view.button('充值') !== undefined)
  expect(view.button('充值')?.previousElementSibling?.classList.contains('account-actions')).toBe(
    true,
  )
  view.button('充值')?.click()
  await until(() => view.host.querySelector('.recharge-dialog') !== null)
  expect(view.host.querySelector<HTMLDialogElement>('.recharge-dialog')?.open).toBe(true)
  view.host.querySelector<HTMLButtonElement>('.recharge-close')?.click()
  await until(() => view.host.querySelector('.recharge-dialog') === null)
  view.close()
})

async function recharge() {
  const { default: RechargeDialog } = await import('./RechargeDialog.tsx')
  let closed = 0
  const view = await mount(() => <RechargeDialog pollMs={5} onClose={() => closed++} />)
  const submit = () => (view.host.querySelector('form') as HTMLFormElement).requestSubmit()
  return { view, submit, closed: () => closed }
}

const posted = () => calls.filter((c) => c === 'POST /api/cloud/recharge').length

test('充值窗口：默认 50 元，可选预设金额或输入其他金额；其他金额不合法时不能提交；显示客服微信', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const { view, submit } = await recharge()
  expect(view.text()).toContain('余额 12.50 积分')
  expect(view.text()).toContain('如有问题，请联系客服，微信：li1573i')
  expect(view.host.querySelector('.recharge-preset.active')?.textContent).toContain('¥50')
  expect(view.host.querySelector('.recharge-submit')?.textContent).toBe('微信支付 ¥50')
  view.button('¥100100 积分')?.click()
  expect(view.host.querySelector('.recharge-submit')?.textContent).toBe('微信支付 ¥100')
  view.fill('number', '0')
  expect(view.host.querySelector('.recharge-preset.active')).toBeNull()
  expect(view.host.querySelector<HTMLButtonElement>('.recharge-submit')?.disabled).toBe(true)
  submit()
  expect(posted()).toBe(0)
  view.fill('number', '8')
  expect(view.host.querySelector('.recharge-submit')?.textContent).toBe('微信支付 ¥8')
  submit()
  await until(() => view.host.querySelector('.recharge-qr img') !== null)
  expect(view.text()).toContain('¥8.00')
  view.close()
})

test('充值窗口：生成付款码后读取状态，读取失败时显示原因并继续读取；到账后刷新余额并停止读取，可继续充值', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  rechargeReplies = ['pending', new Error('无法连接账号服务'), 'pending', 'paid']
  const { view, submit, closed } = await recharge()
  submit()
  await until(() => view.host.querySelector('.recharge-qr img') !== null)
  expect(calls).toContain('POST /api/cloud/recharge')
  expect(view.host.querySelector('.recharge-qr img')?.getAttribute('src')).toStartWith(
    'data:image/svg+xml;utf8,',
  )
  expect(view.text()).toContain('微信扫码支付 · 到账 50 积分 · ')
  await until(() => view.text().includes('无法连接账号服务'))
  await until(() => view.text().includes('已到账 50 积分'))
  expect(view.host.querySelector('.recharge-qr img')).toBeNull()
  await until(() => (cloudStore.cloudState() as { credits?: number }).credits === 62.5)
  const polls = calls.filter((c) => c.startsWith('GET /api/cloud/recharge/')).length
  expect(polls).toBe(4)
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(calls.filter((c) => c.startsWith('GET /api/cloud/recharge/')).length).toBe(polls)
  view.button('继续充值')?.click()
  await until(() => view.host.querySelector('.recharge-presets') !== null)
  view.button('完成')?.click()
  expect(closed()).toBe(0)
  view.close()
})

test('充值窗口：付款码过期后停止读取，可按原金额重新生成或更换金额；关闭按钮与 Escape 交给调用方关闭', async () => {
  rechargeReplies = ['expired']
  const { view, submit, closed } = await recharge()
  view.fill('number', '8')
  submit()
  await until(() => view.text().includes('付款码已过期'))
  expect(view.host.querySelector('.recharge-qr')?.classList.contains('done')).toBe(true)
  expect(view.host.querySelector('.recharge-qr')?.classList.contains('paid')).toBe(false)
  view.button('重新生成')?.click()
  await until(() => calls.includes('GET /api/cloud/recharge/QY2'))
  expect(posted()).toBe(2)
  expect(view.text()).toContain('¥8.00')
  view.button('更换金额')?.click()
  await until(() => view.host.querySelector('.recharge-presets') !== null)
  view.host.querySelector<HTMLButtonElement>('.recharge-close')?.click()
  view.host
    .querySelector('.recharge-dialog')
    ?.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(closed()).toBe(2)
  view.close()
})

test('充值窗口打开时按 Escape 只关闭充值窗口：焦点不在窗口内（落在 body）时账号窗口同样保留', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  store.setAccountOpen(true)
  const view = await dialog()
  await until(() => view.button('充值') !== undefined)
  view.button('充值')?.click()
  await until(() => view.host.querySelector('.recharge-dialog') !== null)
  ;(document.activeElement as HTMLElement | null)?.blur()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(store.accountOpen()).toBe(true)
  view.host.querySelector<HTMLButtonElement>('.recharge-close')?.click()
  await until(() => view.host.querySelector('.recharge-dialog') === null)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(store.accountOpen()).toBe(false)
  view.close()
})

test('可用模型可设为默认对话模型，写入与模型设置页同一处；再次点击取消默认', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  const { reloadConfig, configBusy } = await import('../settings/configStore.ts')
  await reloadConfig()
  const view = await dialog()
  const row = () =>
    [...view.host.querySelectorAll('tr')].find((r) => r.textContent?.includes('claude-opus-5-5'))
  await until(() => row()?.querySelector('.model-pick')?.hasAttribute('disabled') === false)
  const pick = () => row()?.querySelector<HTMLButtonElement>('.model-pick')
  expect(pick()?.textContent).toBe('设为默认')
  pick()?.click()
  await until(() => !configBusy() && pick()?.classList.contains('on') === true)
  expect(stored.active).toEqual({ provider: 'qywork', model: 'claude-opus-5-5' })
  pick()?.click()
  await until(() => !configBusy() && pick()?.classList.contains('on') === false)
  expect(stored.active).toBeUndefined()
  // 云端清单中有、配置的云端接口下还没有的型号不能设为默认。
  delete (stored.providers as Record<string, { models: Record<string, unknown> }>).qywork!.models[
    'relay-model'
  ]
  await reloadConfig()
  const relay = [...view.host.querySelectorAll('tr')].find((r) =>
    r.textContent?.includes('relay-model'),
  )
  await until(() => relay?.querySelector('.model-pick')?.hasAttribute('disabled') === true)
  view.close()
})

test('可用模型、生成模型与使用记录显示模型目录中的名称，生成模型列出时长与素材上限；目录中没有的型号显示型号本身', async () => {
  const row = (id: string, label: string) => ({
    id,
    label,
    effortLevels: [],
    effort: null,
    currency: 'USD',
    vision: null,
    video: false,
    known: true,
  })
  providers = [
    {
      name: 'qywork',
      models: [
        row('claude-opus-5-5', 'Claude Opus 5.5'),
        row('claude-sonnet-5-5', 'Claude Sonnet 5.5'),
      ],
    },
  ]
  media = [
    {
      provider: 'qywork',
      id: 'doubao-seedance-2-0-260128',
      kind: 'ark_video',
      output: 'video',
      label: 'Seedance 2.0',
      operations: [],
      isDefault: false,
      known: true,
      maxImages: 9,
      maxVideos: 3,
      maxAudios: 3,
      params: [{ name: 'duration', label: '时长', type: 'integer', min: 4, max: 15 }],
    },
  ]
  pages = [[record('1')]]
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  await (await import('../../lib/store/settings.ts')).reloadModelCatalog()
  const view = await dialog()
  try {
    await until(
      () => view.text().includes('Claude Opus 5.5') && view.text().includes('Claude Sonnet 5.5'),
    )
    const first = (text: string) =>
      [...view.host.querySelectorAll('tbody tr')]
        .map((r) => r.querySelector('td')?.textContent)
        .includes(text)
    expect(first('Claude Opus 5.5')).toBe(true)
    expect(first('Seedance 2.0')).toBe(true)
    // 生成模型的参数：时长范围与参考素材上限。
    const seedance = [...view.host.querySelectorAll('tbody tr')].find(
      (r) => r.querySelector('td')?.textContent === 'Seedance 2.0',
    )
    expect(seedance?.querySelectorAll('td')[1]?.textContent).toBe('4–15秒 · 图≤9、视频≤3、音频≤3')
    // 目录中没有的型号（尚未同步到本机配置）显示型号本身。
    expect(first('relay-model')).toBe(true)
    expect(view.text()).not.toContain('claude-opus-5-5')
    expect(view.text()).not.toContain('doubao-seedance-2-0-260128')
    // 使用记录的型号同样显示名称。
    expect(view.text()).not.toContain('claude-sonnet-5-5')
  } finally {
    view.close()
    providers = []
    media = []
    await (await import('../../lib/store/settings.ts')).reloadModelCatalog()
  }
})

test('使用记录中的生成任务：三个 token 列合为一格显示计量（数量、单位与分辨率档位）；型号未知时显示「—」', async () => {
  cloud = SIGNED_IN
  await cloudStore.refreshCloudState()
  pages = [
    [
      record('2', null, { mediaMeter: { units: 30, unit: 'second', resolution: '720p' } }),
      record('1', '结果不明，积分已退回', { mediaMeter: { units: 2, unit: 'image' } }),
      record('0', '积分不足', { modelId: null }),
    ],
  ]
  const view = await dialog()
  await until(() => view.text().includes('30 秒 · 720p'))
  const cells = (text: string) =>
    [...view.host.querySelectorAll('tbody tr')]
      .find((r) => r.textContent?.includes(text))
      ?.querySelectorAll('td')
  expect(cells('30 秒 · 720p')?.length).toBe(5)
  expect(cells('2 张')?.[4]?.textContent).toBe('结果不明，积分已退回')
  // 读取请求之前被拒时型号未知。
  expect(cells('积分不足')?.[1]?.textContent).toBe('—')
  view.close()
})
