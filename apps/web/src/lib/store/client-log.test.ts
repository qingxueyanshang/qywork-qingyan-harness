/**
 * 覆盖 `store/client-log.ts`：记录先进入 sessionStorage 中的队列，连接可用时分批上报、成功后移除，失败时保留；
 * `index.html` 在加载失败时写入的记录在连接可用后补报；慢请求与未收到响应的请求上报，上报自身的请求不计入。
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ClientLogRequest } from '@qywork/core'

let store: typeof import('./index.ts')
let log: typeof import('./client-log.ts')
let originalApi: typeof store.client.api
let posted: ClientLogRequest[] = []
let failing = false

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  store = await import('./index.ts')
  log = await import('./client-log.ts')
  originalApi = store.client.api
  store.client.api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (path !== '/api/client-log') throw new Error(`未替换的接口：${path}`)
    if (failing) throw new Error('未收到服务响应')
    posted.push(JSON.parse(String(init?.body)) as ClientLogRequest)
    return { ok: true } as T
  }
})

afterAll(async () => {
  store.client.api = originalApi
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  posted = []
  failing = false
  sessionStorage.clear()
  store.setState({ connection: 'reconnecting' })
})

const queued = () => JSON.parse(sessionStorage.getItem('qywork.clientLog') ?? '[]') as unknown[]

test('断线期间的记录保留在队列中，连接可用后上报并移除；上报失败时保留', async () => {
  log.report('warn', '断线期间的记录', { n: 1 })
  expect(posted).toEqual([])
  expect(queued()).toHaveLength(1)

  store.setState({ connection: 'ready' })
  failing = true
  await log.flushReports()
  expect(queued()).toHaveLength(1)

  failing = false
  await log.flushReports()
  expect(posted).toHaveLength(1)
  expect(posted[0]?.entries).toMatchObject([
    { level: 'warn', message: '断线期间的记录', fields: { n: 1 } },
  ])
  expect(queued()).toEqual([])
})

test('index.html 在加载失败时写入的记录在连接可用后补报，超过一批时分批上报', async () => {
  const entries = Array.from({ length: 25 }, (_, i) => ({
    at: i,
    level: 'error',
    message: '界面代码加载失败',
    fields: { detail: `/assets/a-${i}.js` },
  }))
  sessionStorage.setItem('qywork.clientLog', JSON.stringify(entries))
  store.setState({ connection: 'ready' })
  await log.flushReports()
  expect(posted.map((p) => p.entries.length)).toEqual([20, 5])
  expect(posted[1]?.entries.at(-1)?.fields?.detail).toBe('/assets/a-24.js')
  expect(queued()).toEqual([])
})

test('慢请求与未收到响应的请求上报，快速请求与上报自身的请求不上报', () => {
  log.reportRequest({ method: 'GET', path: '/api/conversations', status: 200, ms: 50 })
  log.reportRequest({ method: 'POST', path: '/api/client-log', status: 0, ms: 9000 })
  log.reportRequest({ method: 'GET', path: '/api/files/tree', status: 200, ms: 2500 })
  log.reportRequest({ method: 'POST', path: '/api/workspaces', status: 0, ms: 15000 })
  expect(queued()).toMatchObject([
    { level: 'info', message: '慢请求', fields: { path: '/api/files/tree', ms: 2500 } },
    { level: 'warn', message: '请求未收到响应', fields: { path: '/api/workspaces', status: 0 } },
  ])
})
