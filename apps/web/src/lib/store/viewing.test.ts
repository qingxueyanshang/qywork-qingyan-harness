/**
 * 覆盖范围（B6）：`store/ui.ts` 的 `viewingFile`，即随消息发送的「界面右侧面板当前打开的文件」。
 *
 * 原始失败形状：用户说「批量生成这个画布」并附上标题被截断的页签截图，上下文中没有当前打开的文件，
 * 模型只能用电脑控制读取 qywork 窗口来确认是哪一张画布。
 */

import { afterEach, expect, test } from 'bun:test'

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

const {
  openCanvasTab,
  openFileTab,
  openPanel,
  setOpenFile,
  setSidePanel,
  setWorkspace,
  viewingFile,
} = await import('./ui.ts')

const WS = { id: 'ws_viewing', root: 'C:/w', name: 'W' }

afterEach(() => {
  setSidePanel(null)
  setOpenFile(null)
  setWorkspace(null)
})

test('画布页或文件预览页在显示时为其路径；面板收起或显示其他固定页时为 undefined', () => {
  setWorkspace(WS)
  expect(viewingFile()).toBeUndefined()

  openCanvasTab('作品/甲/甲_第五版.canvas.json', '甲_第五版')
  expect(viewingFile()).toBe('作品/甲/甲_第五版.canvas.json')

  openFileTab('generated/a.png')
  expect(viewingFile()).toBe('generated/a.png')

  openPanel('todos')
  expect(viewingFile()).toBeUndefined()

  setSidePanel(null)
  expect(viewingFile()).toBeUndefined()
})

test('文件页中打开的文件同样计入', () => {
  setWorkspace(WS)
  setOpenFile('docs/plan.md')
  openPanel('files')
  expect(viewingFile()).toBe('docs/plan.md')
})
