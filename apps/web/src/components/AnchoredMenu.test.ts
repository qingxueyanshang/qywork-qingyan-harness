import { describe, expect, test } from 'bun:test'
import { placeMenu } from './AnchoredMenu.tsx'

const view = { width: 1000, height: 800 }
const box = { width: 300, height: 200 }
const at = (top: number, left: number) => ({ top, bottom: top + 30, left, right: left + 100 })

describe('菜单摆位', () => {
  test('above-start：上方、左缘对齐按钮', () => {
    expect(placeMenu(at(500, 100), box, view, 'above-start')).toEqual({ top: 296, left: 100 })
  })

  test('above-start：上方放不下翻到下方；越过窗口右沿收回', () => {
    expect(placeMenu(at(150, 100), box, view, 'above-start')).toEqual({ top: 184, left: 100 })
    expect(placeMenu(at(500, 900), box, view, 'above-start')).toEqual({ top: 296, left: 692 })
  })

  test('below-start：左上角落在锚点处；下方放不下翻到上方，越过窗口右沿收回', () => {
    const point = (top: number, left: number) => ({ top, bottom: top, left, right: left })
    expect(placeMenu(point(300, 400), box, view, 'below-start')).toEqual({ top: 304, left: 400 })
    expect(placeMenu(point(700, 400), box, view, 'below-start')).toEqual({ top: 496, left: 400 })
    expect(placeMenu(point(300, 900), box, view, 'below-start')).toEqual({ top: 304, left: 692 })
  })

  test('below-end：下方、右缘对齐按钮；下方放不下翻到上方；越过窗口左沿收回', () => {
    expect(placeMenu(at(100, 500), box, view, 'below-end')).toEqual({ top: 134, left: 300 })
    expect(placeMenu(at(700, 500), box, view, 'below-end')).toEqual({ top: 496, left: 300 })
    expect(placeMenu(at(100, 100), box, view, 'below-end')).toEqual({ top: 134, left: 8 })
  })
})
