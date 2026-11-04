/**
 * 本版说明：`lib/store/release-notes.ts`（启动时显示一次的判定与记录）与 `ReleaseNotesDialog.tsx`（正文渲染与关闭）。
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
  expect(notesStore.releaseNotesShown()).toEqual(NOTES)
  notesStore.closeReleaseNotes()
  expect(notesStore.releaseNotesShown()).toBeNull()
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(calls).toHaveLength(1)
  // 升级到下一个版本时再显示一次。
  await notesStore.showReleaseNotesOnce('0.3.13')
  expect(calls).toHaveLength(2)
})

test('读取失败或该版本没有说明时不显示、不记录，下次启动再读取', async () => {
  reply = unavailable()
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(notesStore.releaseNotesShown()).toBeNull()
  reply = null
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(notesStore.releaseNotesShown()).toBeNull()
  reply = NOTES
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(notesStore.releaseNotesShown()).toEqual(NOTES)
  expect(calls).toHaveLength(3)
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function mount(notes: ReleaseNotes) {
  const { render } = await import('solid-js/web')
  const { default: ReleaseNotesDialog } = await import('./ReleaseNotesDialog.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ReleaseNotesDialog notes={notes} />, host)
  return {
    host,
    button: (label: string) =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label),
    close: () => {
      dispose()
      host.remove()
    },
  }
}

test('弹窗显示标题，正文按 Markdown 渲染', async () => {
  const view = await mount(NOTES)
  expect(view.host.querySelector('h2')?.textContent).toBe('qywork 0.3.12 更新')
  await until(() => view.host.querySelector('.markdown li') !== null)
  expect(view.host.querySelector('.markdown li')?.textContent).toBe('更新后显示本版说明')
  expect(calls).toHaveLength(0)
  view.close()
})

test('关闭按钮关闭弹窗并记录版本', async () => {
  await notesStore.showReleaseNotesOnce('0.3.12')
  const view = await mount(NOTES)
  view.button('关闭')?.click()
  expect(notesStore.releaseNotesShown()).toBeNull()
  await notesStore.showReleaseNotesOnce('0.3.12')
  expect(calls).toHaveLength(1)
  view.close()
})
