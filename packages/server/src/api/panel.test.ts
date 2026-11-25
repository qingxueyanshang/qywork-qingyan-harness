/**
 * 覆盖 `api/panel.ts`：共享页签的打开与关闭（id 由类型与对象确定、同一对象只有一页、变化时广播 `panel.tabs`），
 * 最近查看的文件的记录与清空（发送消息时读取，见 `commands/messages.ts`）。
 *
 * 原始失败形状：页签记在各客户端，电脑上打开的画布不在手机的页签中；手机发出的消息不带该画布，
 * 模型无法确定「这个画布」指哪一张。
 */

import { afterEach, expect, test } from 'bun:test'
import type { AgentEvent } from '@qywork/core'
import { Store, upsertWorkspace, viewingOf } from '@qywork/store'
import { handlePanelApi } from './panel.ts'
import type { ApiRequestDeps } from './types.ts'

let store: Store
let workspaceId = ''
let events: AgentEvent[] = []

function fresh() {
  store = new Store({ path: ':memory:' })
  workspaceId = upsertWorkspace(store, '/tmp/panel-api', 'P').id
  events = []
}

afterEach(() => store.close())

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://x${path}`)
  const deps = { store, workspaceId, bus: { publish: (e: AgentEvent) => events.push(e) } }
  const res = await handlePanelApi(
    url,
    new Request(url.href, init),
    deps as unknown as ApiRequestDeps,
  )
  if (!res) throw new Error(`未处理：${path}`)
  return res
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
/** 最近一次广播的清单中的页签 id。 */
const published = () => {
  const last = events.findLast((e) => e.type === 'panel.tabs')
  return last?.type === 'panel.tabs' ? last.tabs.map((t) => t.id) : null
}

test('打开返回按类型与对象生成 id 的页签并广播；再次打开同一对象不广播；关闭后广播移除后的清单', async () => {
  fresh()
  const opened = await call(
    '/api/panel/tabs',
    post({ kind: 'canvas', path: '作品/甲.canvas.json', title: '甲' }),
  )
  expect(await opened.json()).toEqual({
    id: 'canvas-作品/甲.canvas.json',
    kind: 'canvas',
    path: '作品/甲.canvas.json',
    title: '甲',
    workspaceId,
  })
  await call('/api/panel/tabs', post({ kind: 'plugin', workbench: 'p/w', title: '工作台' }))
  expect(published()).toEqual(['canvas-作品/甲.canvas.json', 'plugin-p/w'])
  const count = events.length
  await call('/api/panel/tabs', post({ kind: 'canvas', path: '作品/甲.canvas.json', title: '甲' }))
  expect(events.length).toBe(count)

  await call(`/api/panel/tabs?id=${encodeURIComponent('plugin-p/w')}`, { method: 'DELETE' })
  expect(published()).toEqual(['canvas-作品/甲.canvas.json'])
})

test('最近查看：记录后可读取；关闭该画布的页签时清空；按路径清空只清空同一文件', async () => {
  fresh()
  await call('/api/panel/tabs', post({ kind: 'canvas', path: 'a.canvas.json', title: 'a' }))
  await call('/api/panel/viewing', post({ path: 'a.canvas.json' }))
  expect(viewingOf(store, workspaceId)).toBe('a.canvas.json')
  await call(`/api/panel/tabs?id=${encodeURIComponent('canvas-a.canvas.json')}`, {
    method: 'DELETE',
  })
  expect(viewingOf(store, workspaceId)).toBeNull()

  await call('/api/panel/viewing', post({ path: 'b.docx' }))
  await call(`/api/panel/viewing?path=${encodeURIComponent('c.docx')}`, { method: 'DELETE' })
  expect(viewingOf(store, workspaceId)).toBe('b.docx')
  await call(`/api/panel/viewing?path=${encodeURIComponent('b.docx')}`, { method: 'DELETE' })
  expect(viewingOf(store, workspaceId)).toBeNull()
})

test('参数不合法时返回 400 且不写入', async () => {
  fresh()
  expect((await call('/api/panel/tabs', post({ kind: 'terminal', title: 't' }))).status).toBe(400)
  expect((await call('/api/panel/tabs', post({ kind: 'canvas', title: 'x' }))).status).toBe(400)
  expect((await call('/api/panel/viewing', post({ path: '' }))).status).toBe(400)
  expect(published()).toBeNull()
})
