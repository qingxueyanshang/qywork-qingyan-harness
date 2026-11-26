/**
 * 覆盖 `appearance/preferences.ts` 与 `events/global.ts` 中 `preferences.changed` 的条目：
 * 本端没有记录时连接后采用电脑上的界面偏好；另一端保存后推送的内容直接应用；修改立即应用、停顿后只提交改动的字段，
 * 期间推送的结果不应用；提交失败时显示原因并回到电脑上的值；电脑上从未保存时以本端的值作为初值写入。
 *
 * 用例共用模块状态，按顺序执行。
 */

import { afterAll, beforeAll, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPreferences, UiPreferencesEntry } from '@qywork/core'
import { until } from '@qywork/core/until.test-helper'

let server: { entry: UiPreferencesEntry; puts: unknown[]; fail: string | null }
let store: typeof import('../index.ts')

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  server = {
    entry: { preferences: { theme: 'dark', fontScale: 1.2, followUpMode: 'steer' }, updatedAt: 5 },
    puts: [],
    fail: null,
  }
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!String(url).includes('/api/preferences')) throw new Error(`unexpected ${url}`)
    if (init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as Partial<UiPreferences>
      server.puts.push(patch)
      if (server.fail) return new Response(JSON.stringify({ error: server.fail }), { status: 500 })
      server.entry = { preferences: { ...server.entry.preferences, ...patch }, updatedAt: 9 }
    }
    return new Response(JSON.stringify(server.entry), { status: 200 })
  }) as unknown as typeof fetch
  store = await import('../index.ts')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const root = () => document.documentElement

test('本端没有记录时，连接就绪后采用电脑上的主题、字体大小与跟进处理方式，并写入本机记录', async () => {
  expect(store.theme()).toBe('system')
  store.setState('connection', 'connecting')
  const stop = store.observePreferences()
  try {
    store.setState('connection', 'ready')
    await until(() => store.theme() === 'dark', '采用电脑上的主题')
    expect(root().getAttribute('data-theme')).toBe('dark')
    expect(store.fontScale()).toBe(1.2)
    expect(root().style.getPropertyValue('--font-scale')).toBe('1.2')
    expect(store.followUpMode()).toBe('steer')
    expect(localStorage.getItem('qywork.theme')).toBe('dark')
    expect(localStorage.getItem('qywork.fontScale')).toBe('1.2')
    expect(localStorage.getItem('qywork.followUpMode')).toBe('steer')
    expect(server.puts).toEqual([])
  } finally {
    stop()
  }
})

test('另一端保存后推送的内容直接应用', () => {
  const preferences: UiPreferences = { theme: 'light', fontScale: 1, followUpMode: 'queue' }
  server.entry = { preferences, updatedAt: 6 }
  store.applyEvent({ seq: 1, at: 0, event: { type: 'preferences.changed', preferences } } as never)
  expect(store.theme()).toBe('light')
  expect(root().getAttribute('data-theme')).toBe('light')
  expect(store.fontScale()).toBe(1)
  expect(root().style.getPropertyValue('--font-scale')).toBe('')
  expect(store.followUpMode()).toBe('queue')
})

test('修改立即应用，停顿后只提交改动的字段一次；期间推送的结果不应用；提交后采用电脑上合并后的结果', async () => {
  // 另一端在本次提交之前修改了跟进处理方式，提交的响应带回该字段。
  server.entry = {
    preferences: { theme: 'light', fontScale: 1, followUpMode: 'steer' },
    updatedAt: 7,
  }
  jest.useFakeTimers()
  try {
    store.editPreferences({ fontScale: 1.1 })
    store.editPreferences({ fontScale: 1.15 })
    expect(store.fontScale()).toBe(1.15)
    store.applyEvent({
      seq: 2,
      at: 0,
      event: {
        type: 'preferences.changed',
        preferences: { theme: 'light', fontScale: 1, followUpMode: 'queue' },
      },
    } as never)
    expect(store.fontScale()).toBe(1.15)
    jest.advanceTimersByTime(300)
    expect(server.puts).toEqual([{ fontScale: 1.15 }])
  } finally {
    jest.useRealTimers()
  }
  await until(() => store.followUpMode() === 'steer', '采用提交后电脑上的结果')
  expect(store.fontScale()).toBe(1.15)
})

test('提交失败时显示原因，本端回到电脑上的值', async () => {
  server.fail = '磁盘空间不足'
  store.editPreferences({ theme: 'dark' })
  expect(store.theme()).toBe('dark')
  await until(() => store.preferencesError() === '磁盘空间不足', '显示失败原因')
  await until(() => store.theme() === 'light', '回到电脑上的主题')
  expect(store.preferencesError()).toBe('磁盘空间不足')
  server.fail = null
})

test('电脑上从未保存时，连接后以本端的值作为初值写入', async () => {
  server.entry = {
    preferences: { theme: 'system', fontScale: 1, followUpMode: 'queue' },
    updatedAt: 0,
  }
  server.puts = []
  store.setState('connection', 'connecting')
  const stop = store.observePreferences()
  try {
    store.setState('connection', 'ready')
    await until(() => server.puts.length === 1, '写入初值')
    expect(server.puts[0]).toEqual({ theme: 'light', fontScale: 1.15, followUpMode: 'steer' })
    await until(() => server.entry.updatedAt === 9, '初值已保存')
    expect(store.theme()).toBe('light')
    expect(store.preferencesError()).toBeNull()
  } finally {
    stop()
  }
})
