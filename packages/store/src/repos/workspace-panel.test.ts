/**
 * 覆盖 `workspace-panel.ts`：共享页签按工作区记录、同一 id 只有一页、关闭页签时清空指向它的最近查看文件、
 * 已移除的工作区不列出。原始失败形状：页签记在各客户端，电脑上打开的画布不在手机的页签中，手机发出的消息也不带它。
 */

import { expect, test } from 'bun:test'
import { Store } from '../db.ts'
import {
  clearViewing,
  closePanelTab,
  listPanelTabs,
  openPanelTab,
  setViewing,
  viewingOf,
} from './workspace-panel.ts'
import { removeWorkspace, upsertWorkspace } from './workspaces.ts'

function fresh() {
  const store = new Store({ path: ':memory:' })
  const a = upsertWorkspace(store, '/tmp/panel-a', 'A').id
  const b = upsertWorkspace(store, '/tmp/panel-b', 'B').id
  return { store, a, b }
}

test('按工作区记录、按打开顺序列出；同一 id 再次打开不新增', () => {
  const { store, a, b } = fresh()
  expect(
    openPanelTab(store, a, {
      id: 'canvas-x.canvas.json',
      kind: 'canvas',
      path: 'x.canvas.json',
      title: 'x',
    }),
  ).toBe(true)
  expect(
    openPanelTab(store, a, { id: 'plugin-p/w', kind: 'plugin', workbench: 'p/w', title: '工作台' }),
  ).toBe(true)
  expect(
    openPanelTab(store, b, { id: 'file-a.docx', kind: 'file', path: 'a.docx', title: 'a.docx' }),
  ).toBe(true)
  expect(
    openPanelTab(store, a, {
      id: 'canvas-x.canvas.json',
      kind: 'canvas',
      path: 'x.canvas.json',
      title: 'x',
    }),
  ).toBe(false)
  expect(listPanelTabs(store).map((t) => [t.workspaceId, t.id])).toEqual([
    [a, 'canvas-x.canvas.json'],
    [a, 'plugin-p/w'],
    [b, 'file-a.docx'],
  ])
  store.close()
})

test('关闭页签：清单移除该页；它是最近查看的文件时一并清空，不是时不变', () => {
  const { store, a } = fresh()
  openPanelTab(store, a, {
    id: 'canvas-x.canvas.json',
    kind: 'canvas',
    path: 'x.canvas.json',
    title: 'x',
  })
  openPanelTab(store, a, { id: 'file-a.docx', kind: 'file', path: 'a.docx', title: 'a.docx' })
  setViewing(store, a, 'x.canvas.json')
  expect(closePanelTab(store, a, 'file-a.docx')).toBe(true)
  expect(viewingOf(store, a)).toBe('x.canvas.json')
  expect(closePanelTab(store, a, 'canvas-x.canvas.json')).toBe(true)
  expect(viewingOf(store, a)).toBeNull()
  expect(closePanelTab(store, a, 'canvas-x.canvas.json')).toBe(false)
  expect(listPanelTabs(store)).toEqual([])
  store.close()
})

test('最近查看：后记录的覆盖先记录的；按路径清空只清空同一文件', () => {
  const { store, a } = fresh()
  setViewing(store, a, 'x.canvas.json')
  setViewing(store, a, 'y.canvas.json')
  clearViewing(store, a, 'x.canvas.json')
  expect(viewingOf(store, a)).toBe('y.canvas.json')
  clearViewing(store, a, 'y.canvas.json')
  expect(viewingOf(store, a)).toBeNull()
  store.close()
})

test('已移除的工作区不列出其页签', () => {
  const { store, a, b } = fresh()
  openPanelTab(store, a, {
    id: 'canvas-x.canvas.json',
    kind: 'canvas',
    path: 'x.canvas.json',
    title: 'x',
  })
  openPanelTab(store, b, { id: 'file-a.docx', kind: 'file', path: 'a.docx', title: 'a.docx' })
  removeWorkspace(store, b)
  expect(listPanelTabs(store).map((t) => t.workspaceId)).toEqual([a])
  store.close()
})
