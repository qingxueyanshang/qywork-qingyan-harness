/** 覆盖 `desktop-target.ts`。 */
import { expect, test } from 'bun:test'
import { desktopWindowLabel } from './desktop-target.ts'

test('观察结果带着窗口标题时显示标题', () => {
  expect(desktopWindowLabel({ windowId: 'dw_3', app: 'Weixin.exe', title: '微信' })).toBe('微信')
})

test('动作与等待的结果把窗口信息放在 observation 里', () => {
  expect(
    desktopWindowLabel({ dispatch: 'submitted', observation: { app: 'notepad.exe', title: '' } }),
  ).toBe('notepad.exe')
})

test('结果里没有窗口信息就不显示，不回落到内部编号', () => {
  expect(desktopWindowLabel({ dispatch: 'unknown', observationError: 'x' })).toBeUndefined()
  expect(desktopWindowLabel(undefined)).toBeUndefined()
  expect(
    desktopWindowLabel({ windows: [{ windowId: 'dw_1', app: 'a', title: 'b' }] }),
  ).toBeUndefined()
})
