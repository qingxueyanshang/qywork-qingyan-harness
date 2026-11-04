/**
 * 本版说明：`lib/store/release-notes.ts`（启动时显示一次的判定与记录）与 `ReleaseNotesDialog.tsx`（读取、失败重试、没有说明）。
 * 服务端接口以替身代替。
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReleaseNotes } from '@qywork/core'

let store: typeof import('../lib/store/index.ts')
let notesStore: typeof import('../lib/store/release-notes.ts')
let originalApi: typeof store.client.api
let ApiError: typeof import('../lib/client.ts').ApiError
let calls: string[]
/** 替身的返回：说明、null，或抛出的错误。 */
let reply: ReleaseNotes | null | Error

const NOTES: ReleaseNotes = {
  version: '0.3.12',
  title: 'qywork 0.3.12 更新',
  body: '### 新增\n\n- 更新后显示本版说明',
  publishedAt: '2026-11-04T12:00:00.000Z',
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
  store = await import('../lib/store/index.ts')
  notesStore = await import('../lib/store/release-notes.ts')
  ApiError = (await import('../lib/client.ts')).ApiError
  originalApi = store.client.api
  store.client.api = async <T,>(path: string): Promise<T> => {
    calls.push(path)
    if (!path.startsWith('/api/cloud/release-notes')) throw new Error(`unexpected ${path}`)
    if (reply instanceof Error) throw reply
    return structuredClone(reply) as T
  }
})

beforeEach(() => {
  calls = []
  reply = NOTES
  localStorage.clear()
  notesStore.closeReleaseNotes()
  localStorage.clear()
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

const unavailable = () =>
  new ApiError(400, '/api/cloud/release-notes', JSON.stringify({ message: '无法连接账号服务' }))

test('没有记录时读取并显示一次，关闭后记录当前版本，同一版本不再读取', async () => {
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(calls).toEqual(['/api/cloud/release-notes?version=0.3.12'])
  expect(notesStore.releaseNotesView()).toEqual({ version: '0.3.12', notes: NOTES })
  notesStore.closeReleaseNotes()
  expect(notesStore.releaseNotesView()).toBeNull()
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(calls).toHaveLength(1)
  // 升级到下一个版本时再显示一次。
  await notesStore.showReleaseNotesOnce('0.3.13')
  expect(calls).toHaveLength(2)
})

test('读取失败或该版本没有说明时不显示、不记录，下次启动再读取', async () => {
  reply = unavailable()
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(notesStore.releaseNotesView()).toBeNull()
  reply = null
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(notesStore.releaseNotesView()).toBeNull()
  reply = NOTES
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(notesStore.releaseNotesView()?.notes).toEqual(NOTES)
  expect(calls).toHaveLength(3)
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mount(view: import('../lib/store/release-notes.ts').ReleaseNotesView) {
  const { render } = await import('solid-js/web')
  const { default: ReleaseNotesDialog } = await import('./ReleaseNotesDialog.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ReleaseNotesDialog view={view} />, host)
  return {
    host,
    text: () => host.textContent ?? '',
    button: (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label),
    close: () => {
      dispose()
      host.remove()
    },
  }
}

test('启动时已读取到的说明直接显示，不再请求；正文按 Markdown 渲染', async () => {
  const view = await mount({ version: '0.3.12', notes: NOTES })
  expect(view.host.querySelector('h2')?.textContent).toBe('qywork 0.3.12 更新')
  await until(() => view.host.querySelector('.markdown li') !== null)
  expect(view.host.querySelector('.markdown li')?.textContent).toBe('更新后显示本版说明')
  expect(calls).toHaveLength(0)
  view.close()
})

test('从设置页打开：读取失败时显示原因与重试，重试成功后显示说明；没有说明时写明', async () => {
  reply = unavailable()
  const view = await mount({ version: '0.3.12' })
  await until(() => view.button('重试') !== undefined)
  expect(view.text()).toContain('无法连接账号服务')
  reply = NOTES
  view.button('重试')?.click()
  await until(() => view.host.querySelector('.markdown li') !== null)
  expect(calls).toHaveLength(2)
  view.close()

  reply = null
  const empty = await mount({ version: '0.3.12' })
  await until(() => empty.text().includes('暂无说明'))
  expect(empty.host.querySelector('h2')?.textContent).toBe('qywork 0.3.12')
  empty.close()
})

test('关闭按钮关闭弹窗并记录版本', async () => {
  notesStore.openReleaseNotes('0.3.12')
  const view = await mount({ version: '0.3.12', notes: NOTES })
  view.button('关闭')?.click()
  expect(notesStore.releaseNotesView()).toBeNull()
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(calls).toHaveLength(0)
  view.close()
})
