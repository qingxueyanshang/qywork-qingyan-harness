/**
 * 布局桥的矩形换算（`browser.ts` 的 `viewRect`）。
 *
 * 只测这一段纯逻辑：它是「界面量到的位置」与「宿主摆在哪」之间唯一的换算，
 * 算错的表现是网页盖在工具栏上或整块偏出面板，而那不会报任何错。
 * 真正摆得准不准由真实桌面应用上的截图验收，测不到 DOM 与窗口的这里不假装测。
 */

import { describe, expect, test } from 'bun:test'
import { viewRect } from './browser.ts'

describe('占位矩形换算成宿主要的物理像素', () => {
  test('100% 缩放下逐字照搬', () => {
    expect(viewRect({ left: 940, top: 72, width: 380, height: 640 }, 1)).toEqual({
      x: 940,
      y: 72,
      width: 380,
      height: 640,
    })
  })

  test('150% 与 200% 缩放各乘一次，四舍五入到整像素', () => {
    // 宿主收到的是 `PhysicalPosition` / `PhysicalSize`，不会再乘一次缩放。
    expect(viewRect({ left: 940.4, top: 72.2, width: 380.6, height: 640 }, 1.5)).toEqual({
      x: 1411,
      y: 108,
      width: 571,
      height: 960,
    })
    expect(viewRect({ left: 940, top: 72, width: 380, height: 640 }, 2)).toEqual({
      x: 1880,
      y: 144,
      width: 760,
      height: 1280,
    })
  })

  test('量不出尺寸就不给矩形：藏起来的页签必须移出可视区，不能摆成 0 尺寸', () => {
    expect(viewRect({ left: 0, top: 0, width: 0, height: 0 }, 1)).toBeNull()
    expect(viewRect({ left: 10, top: 10, width: 380, height: 0.5 }, 1)).toBeNull()
  })

  test('缩放比例取不到时不猜一个：宁可不摆，也不摆到错的位置', () => {
    expect(viewRect({ left: 10, top: 10, width: 380, height: 640 }, 0)).toBeNull()
    expect(viewRect({ left: 10, top: 10, width: 380, height: 640 }, Number.NaN)).toBeNull()
  })
})
