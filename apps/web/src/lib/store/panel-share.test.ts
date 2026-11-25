/**
 * 覆盖 `panel-share.ts` 与 `ui.ts` 的 `syncSharedTabs`：共享页签按电脑上的清单显示（其他客户端打开的页出现、关闭的页移除、
 * 当前页被移除时改为相邻页），本端打开与关闭立即显示并通知服务端，通知失败时显示回执。
 *
 * 原始失败形状：页签记在各客户端，电脑上打开的画布不在手机的页签中，手机上关闭的页在电脑上仍然打开。
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { SharedPanelTab } from '@qywork/core'

const g = globalThis as Record<string, unknown>
g.location ??= {
  hash: '',
  href: 'http://127.0.0.1:5180/',
  search: '',
  pathname: '/',
  origin: 'http://127.0.0.1:5180',
}
g.sessionStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }
g.matchMedia ??= () => ({ matches: false })
g.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} }

const { panelTabs, setSidePanel, setWorkspace, sidePanel, syncSharedTabs } = await import('./ui.ts')
const { closePanelTab, openCanvasTab } = await import('./panel-share.ts')
const { client } = await import('./client.ts')
const { setState, state } = await import('./state.ts')

const WS = { id: 'ws_share', root: 'C:/w', name: 'W' }
const tab = (path: string): SharedPanelTab => ({
  id: `canvas-${path}`,
  workspaceId: WS.id,
  kind: 'canvas',
  path,
  title: path,
})

let calls: string[] = []
let fail = false
const originalApi = client.api

beforeEach(() => {
  calls = []
  fail = false
  ;(client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }).api =
    async (path, init) => {
      calls.push(`${init?.method ?? 'GET'} ${decodeURIComponent(path)}`)
      if (fail) throw new Error('连接已断开')
      return {}
    }
  setWorkspace(WS)
})

afterEach(() => {
  ;(client as unknown as { api: typeof originalApi }).api = originalApi
  syncSharedTabs([])
  setSidePanel(null)
  setWorkspace(null)
  setState('notice', null)
})

test('按电脑上的清单显示：其他客户端打开的页出现，关闭的页移除，当前页被移除时改为相邻页', () => {
  syncSharedTabs([tab('a.canvas.json'), tab('b.canvas.json')])
  expect(panelTabs().map((t) => t.id)).toEqual(['canvas-a.canvas.json', 'canvas-b.canvas.json'])
  setSidePanel({ tab: 'canvas-a.canvas.json' })
  syncSharedTabs([tab('b.canvas.json')])
  expect(panelTabs().map((t) => t.id)).toEqual(['canvas-b.canvas.json'])
  expect(sidePanel()).toEqual({ tab: 'canvas-b.canvas.json' })
  // 清单中已没有该工作区时同样移除。
  syncSharedTabs([])
  expect(panelTabs()).toEqual([])
})

test('本端打开立即显示并通知服务端，电脑随后推送的同一页不重复；关闭同样通知服务端', () => {
  openCanvasTab('作品/甲.canvas.json', '甲')
  expect(panelTabs().map((t) => t.id)).toEqual(['canvas-作品/甲.canvas.json'])
  expect(sidePanel()).toEqual({ tab: 'canvas-作品/甲.canvas.json' })
  expect(calls).toEqual(['POST /api/panel/tabs'])
  syncSharedTabs([tab('作品/甲.canvas.json')])
  expect(panelTabs()).toHaveLength(1)

  closePanelTab('canvas-作品/甲.canvas.json')
  expect(panelTabs()).toEqual([])
  expect(calls[1]).toBe('DELETE /api/panel/tabs?id=canvas-作品/甲.canvas.json')
})

test('通知服务端失败时显示回执', async () => {
  fail = true
  openCanvasTab('b.canvas.json', 'b')
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(state.notice?.message).toContain('页签未能同步到电脑')
})
