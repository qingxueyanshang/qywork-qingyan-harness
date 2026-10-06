/**
 * 桌面图像几何的坐标换算。覆盖范围：`native-desktop.ts` 的 `imagePointToScreen`、
 * `screenPointToImage` 与 `imageRectToScreen`。
 *
 * 这三个函数是图像坐标换算的唯一实现：采集端只产出几何，不做换算；按图定位的请求由服务端
 * 据此换算为屏幕矩形后交给宿主。测试覆盖四种情形：原始尺寸、缩放图像、裁剪原点、多显示器
 * 负原点，另加 DPI 不参与换算一项。
 */

import { describe, expect, test } from 'bun:test'
import {
  type DesktopImageGeometry,
  imagePointToScreen,
  imageRectToScreen,
  screenPointToImage,
} from './native-desktop.ts'

/** 整窗原始尺寸：图像像素与屏幕像素一一对应。 */
const 原样: DesktopImageGeometry = {
  imageWidth: 506,
  imageHeight: 453,
  screen: { x: 87, y: 80, width: 506, height: 453 },
  dpi: 96,
  generation: '80,80,520,460@96#1',
}

/** 4K 整窗缩放至长边 1568：一个图像像素对应约 2.45 个屏幕像素。 */
const 缩图: DesktopImageGeometry = {
  imageWidth: 1568,
  imageHeight: 882,
  screen: { x: 10, y: 20, width: 3840, height: 2160 },
  dpi: 192,
  generation: '10,20,3840,2160@192#1',
}

/** 左侧显示器上的一块区域：屏幕原点为负值，图像原点仍为 (0,0)。 */
const 负原点: DesktopImageGeometry = {
  imageWidth: 400,
  imageHeight: 300,
  screen: { x: -1800, y: -100, width: 400, height: 300 },
  dpi: 96,
  generation: '-1920,-200,1920,1080@96#2',
}

/** 150% 缩放的显示器上的一块裁剪区域，再缩小一半：负原点与缩放同时存在。 */
const 负原点缩图: DesktopImageGeometry = {
  imageWidth: 200,
  imageHeight: 100,
  screen: { x: -1920, y: 540, width: 400, height: 200 },
  dpi: 144,
  generation: '-1920,400,1920,1080@144#2',
}

describe('图像坐标 → 屏幕物理坐标', () => {
  test('原始尺寸时只做一次平移', () => {
    expect(imagePointToScreen(原样, 0, 0)).toEqual({ x: 87, y: 80 })
    expect(imagePointToScreen(原样, 505, 452)).toEqual({ x: 592, y: 532 })
    expect(imagePointToScreen(原样, 253, 226)).toEqual({ x: 340, y: 306 })
  })

  test('缩放图像按图像与屏幕的比例放大，不使用 DPI', () => {
    // 左上角图像像素的中心对应屏幕的第一个像素。
    expect(imagePointToScreen(缩图, 0, 0)).toEqual({ x: 11, y: 21 })
    // 右下角仍位于该图像覆盖的范围内。
    expect(imagePointToScreen(缩图, 1567, 881)).toEqual({ x: 3848, y: 2178 })
    expect(imagePointToScreen(缩图, 784, 441)).toEqual({ x: 1931, y: 1101 })
  })

  test('裁剪原点与负原点使用同一次平移', () => {
    expect(imagePointToScreen(负原点, 0, 0)).toEqual({ x: -1800, y: -100 })
    expect(imagePointToScreen(负原点, 399, 299)).toEqual({ x: -1401, y: 199 })
    expect(imagePointToScreen(负原点缩图, 10, 5)).toEqual({ x: -1899, y: 551 })
  })

  /** DPI 是显示器的缩放读数，不是换算因子：仅 DPI 不同的两份几何，换算结果必须相同。 */
  test('DPI 不参与换算', () => {
    const 高缩放 = { ...原样, dpi: 240 }
    expect(imagePointToScreen(高缩放, 100, 100)).toEqual(imagePointToScreen(原样, 100, 100))
  })
})

describe('屏幕物理坐标 → 图像坐标', () => {
  test('位于图像范围内的点均可换算，包括四个角', () => {
    expect(screenPointToImage(原样, 87, 80)).toEqual({ x: 0, y: 0 })
    expect(screenPointToImage(原样, 592, 532)).toEqual({ x: 505, y: 452 })
    expect(screenPointToImage(负原点, -1800, -100)).toEqual({ x: 0, y: 0 })
    expect(screenPointToImage(负原点缩图, -1899, 551)).toEqual({ x: 10, y: 5 })
  })

  /** 钳制到边界会得到一个看似合法、实际指向另一位置的坐标。 */
  test('不在图像覆盖范围内时返回 null，不钳制到边界', () => {
    expect(screenPointToImage(原样, 86, 80)).toBeNull()
    expect(screenPointToImage(原样, 87, 79)).toBeNull()
    expect(screenPointToImage(原样, 593, 300)).toBeNull()
    expect(screenPointToImage(原样, 300, 533)).toBeNull()
    expect(screenPointToImage(负原点, -1801, -100)).toBeNull()
  })

  test('缩放图像往返换算后仍对应同一个图像像素', () => {
    for (const point of [
      [0, 0],
      [1, 1],
      [784, 441],
      [1567, 881],
    ] as const) {
      const screen = imagePointToScreen(缩图, point[0], point[1])
      expect(screenPointToImage(缩图, screen.x, screen.y)).toEqual({ x: point[0], y: point[1] })
    }
  })
})

describe('图像矩形 → 屏幕矩形', () => {
  test('原始尺寸时矩形只平移', () => {
    expect(imageRectToScreen(原样, { x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 97,
      y: 100,
      width: 100,
      height: 50,
    })
  })

  test('缩放图像的矩形按比例放大', () => {
    expect(imageRectToScreen(缩图, { x: 100, y: 100, width: 200, height: 100 })).toEqual({
      x: 255,
      y: 265,
      width: 490,
      height: 245,
    })
  })

  test('负原点上的矩形同样只做平移', () => {
    expect(imageRectToScreen(负原点, { x: 0, y: 0, width: 40, height: 30 })).toEqual({
      x: -1800,
      y: -100,
      width: 40,
      height: 30,
    })
  })

  /** 超出图像的部分按图像边界裁剪，不原样返回请求的矩形。 */
  test('超出图像的矩形按图像覆盖范围裁剪', () => {
    expect(imageRectToScreen(原样, { x: 400, y: 400, width: 500, height: 500 })).toEqual({
      x: 487,
      y: 480,
      width: 106,
      height: 53,
    })
  })

  test('与图像没有交集时返回 null', () => {
    expect(imageRectToScreen(原样, { x: 506, y: 0, width: 10, height: 10 })).toBeNull()
    expect(imageRectToScreen(原样, { x: 0, y: 453, width: 10, height: 10 })).toBeNull()
    expect(imageRectToScreen(原样, { x: -20, y: 0, width: 10, height: 10 })).toBeNull()
    expect(imageRectToScreen(原样, { x: 0, y: 0, width: 0, height: 10 })).toBeNull()
  })

  /** 在一个图像像素不足一个屏幕像素的方向上，宽高不能变为 0。 */
  test('极小的矩形至少有一个像素', () => {
    const 放大 = { ...原样, imageWidth: 1012, imageHeight: 906 }
    const out = imageRectToScreen(放大, { x: 0, y: 0, width: 1, height: 1 })
    expect(out).not.toBeNull()
    expect(out?.width).toBeGreaterThanOrEqual(1)
    expect(out?.height).toBeGreaterThanOrEqual(1)
  })
})
