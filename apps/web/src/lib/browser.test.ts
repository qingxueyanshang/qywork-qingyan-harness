/**
 * 内置浏览器视图的矩形换算（`browser.ts` 的 `viewRect`）。
 *
 * 只测试这一段纯逻辑：它是界面测得的位置与宿主放置位置之间唯一的换算，
 * 换算错误时网页会覆盖工具栏或偏出面板，且不会产生任何报错。
 * 实际放置是否准确由真实桌面应用的截图验收；本测试无法访问 DOM 与窗口，不测试这一部分。
 */

import { describe, expect, test } from 'bun:test'
import { viewRect } from './browser.ts'

describe('占位矩形换算为宿主所需的物理像素', () => {
  test('100% 缩放下原样输出', () => {
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

  test('无法测得尺寸时不返回矩形：隐藏的页签必须移出可视区，不能放置为 0 尺寸', () => {
    expect(viewRect({ left: 0, top: 0, width: 0, height: 0 }, 1)).toBeNull()
    expect(viewRect({ left: 10, top: 10, width: 380, height: 0.5 }, 1)).toBeNull()
  })

  test('无法取得缩放比例时不推测取值：宁可不放置，也不放到错误的位置', () => {
    expect(viewRect({ left: 10, top: 10, width: 380, height: 640 }, 0)).toBeNull()
    expect(viewRect({ left: 10, top: 10, width: 380, height: 640 }, Number.NaN)).toBeNull()
  })
})
