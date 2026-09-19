/**
 * 桌面图像几何的坐标换算。**覆盖范围**：`native-desktop.ts` 的 `imagePointToScreen`、
 * `screenPointToImage` 与 `imageRectToScreen`，以及 `DESKTOP_PROTOCOL_VERSION`。
 *
 * 这一份是图像坐标换算的唯一实现：采集端只产出几何，不做换算；按图定位的请求由服务端
 * 按它算成屏幕矩形再交给宿主。四种形状都要覆盖——原样尺寸、缩图、裁剪原点、多显示器
 * 负原点，外加不同 DPI 不参与换算这一条。
 */

import { describe, expect, test } from 'bun:test'
import {
  DESKTOP_PROTOCOL_VERSION,
  type DesktopImageGeometry,
  imagePointToScreen,
  imageRectToScreen,
  screenPointToImage,
} from './native-desktop.ts'

/** 整窗原样：图像像素与屏幕像素一一对应。 */
const 原样: DesktopImageGeometry = {
  imageWidth: 506,
  imageHeight: 453,
  screen: { x: 87, y: 80, width: 506, height: 453 },
  dpi: 96,
  generation: '80,80,520,460@96#1',
}

/** 4K 整窗缩到长边 1568：一个图像像素对应约 2.45 个屏幕像素。 */
const 缩图: DesktopImageGeometry = {
  imageWidth: 1568,
  imageHeight: 882,
  screen: { x: 10, y: 20, width: 3840, height: 2160 },
  dpi: 192,
  generation: '10,20,3840,2160@192#1',
}

/** 左侧显示器上的一块：屏幕原点是负的，图像原点仍然是 (0,0)。 */
const 负原点: DesktopImageGeometry = {
  imageWidth: 400,
  imageHeight: 300,
  screen: { x: -1800, y: -100, width: 400, height: 300 },
  dpi: 96,
  generation: '-1920,-200,1920,1080@96#2',
}

/** 150% 缩放的显示器上一块裁剪区，再缩一半：负原点与缩图叠在一起。 */
const 负原点缩图: DesktopImageGeometry = {
  imageWidth: 200,
  imageHeight: 100,
  screen: { x: -1920, y: 540, width: 400, height: 200 },
  dpi: 144,
  generation: '-1920,400,1920,1080@144#2',
}

describe('图像坐标 → 屏幕物理坐标', () => {
  test('原样尺寸时只做一次平移', () => {
    expect(imagePointToScreen(原样, 0, 0)).toEqual({ x: 87, y: 80 })
    expect(imagePointToScreen(原样, 505, 452)).toEqual({ x: 592, y: 532 })
    expect(imagePointToScreen(原样, 253, 226)).toEqual({ x: 340, y: 306 })
  })

  test('缩图时按图像与屏幕的比例放大，不看 DPI', () => {
    // 左上角那个图像像素的中心落在屏幕的第一个像素上。
    expect(imagePointToScreen(缩图, 0, 0)).toEqual({ x: 11, y: 21 })
    // 右下角仍然落在这张图覆盖的范围里。
    expect(imagePointToScreen(缩图, 1567, 881)).toEqual({ x: 3848, y: 2178 })
    expect(imagePointToScreen(缩图, 784, 441)).toEqual({ x: 1931, y: 1101 })
  })

  test('裁剪原点与负原点一起走同一条平移', () => {
    expect(imagePointToScreen(负原点, 0, 0)).toEqual({ x: -1800, y: -100 })
    expect(imagePointToScreen(负原点, 399, 299)).toEqual({ x: -1401, y: 199 })
    expect(imagePointToScreen(负原点缩图, 10, 5)).toEqual({ x: -1899, y: 551 })
  })

  /** DPI 是显示器的缩放读数，不是换算因子：两份只差 DPI 的几何换算结果必须一样。 */
  test('DPI 不参与换算', () => {
    const 高缩放 = { ...原样, dpi: 240 }
    expect(imagePointToScreen(高缩放, 100, 100)).toEqual(imagePointToScreen(原样, 100, 100))
  })
})

describe('屏幕物理坐标 → 图像坐标', () => {
  test('落在图里就换算得出来，四个角都算', () => {
    expect(screenPointToImage(原样, 87, 80)).toEqual({ x: 0, y: 0 })
    expect(screenPointToImage(原样, 592, 532)).toEqual({ x: 505, y: 452 })
    expect(screenPointToImage(负原点, -1800, -100)).toEqual({ x: 0, y: 0 })
    expect(screenPointToImage(负原点缩图, -1899, 551)).toEqual({ x: 10, y: 5 })
  })

  /** 夹到边上会给出一个看着合法、指的却是另一处的坐标。 */
  test('不在这张图覆盖的范围里就返回 null，不夹到边上', () => {
    expect(screenPointToImage(原样, 86, 80)).toBeNull()
    expect(screenPointToImage(原样, 87, 79)).toBeNull()
    expect(screenPointToImage(原样, 593, 300)).toBeNull()
    expect(screenPointToImage(原样, 300, 533)).toBeNull()
    expect(screenPointToImage(负原点, -1801, -100)).toBeNull()
  })

  test('缩图之后换回去仍落在同一个图像像素上', () => {
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
  test('原样尺寸时矩形只平移', () => {
    expect(imageRectToScreen(原样, { x: 10, y: 20, width: 100, height: 50 })).toEqual({
      x: 97,
      y: 100,
      width: 100,
      height: 50,
    })
  })

  test('缩图时矩形按比例放大', () => {
    expect(imageRectToScreen(缩图, { x: 100, y: 100, width: 200, height: 100 })).toEqual({
      x: 255,
      y: 265,
      width: 490,
      height: 245,
    })
  })

  test('负原点上的矩形同样平移过去', () => {
    expect(imageRectToScreen(负原点, { x: 0, y: 0, width: 40, height: 30 })).toEqual({
      x: -1800,
      y: -100,
      width: 40,
      height: 30,
    })
  })

  /** 伸出图外的那一段按图的边界收窄，不把请求的矩形照抄回去。 */
  test('伸出图外的矩形按图的覆盖范围收窄', () => {
    expect(imageRectToScreen(原样, { x: 400, y: 400, width: 500, height: 500 })).toEqual({
      x: 487,
      y: 480,
      width: 106,
      height: 53,
    })
  })

  test('与这张图没有交集时返回 null', () => {
    expect(imageRectToScreen(原样, { x: 506, y: 0, width: 10, height: 10 })).toBeNull()
    expect(imageRectToScreen(原样, { x: 0, y: 453, width: 10, height: 10 })).toBeNull()
    expect(imageRectToScreen(原样, { x: -20, y: 0, width: 10, height: 10 })).toBeNull()
    expect(imageRectToScreen(原样, { x: 0, y: 0, width: 0, height: 10 })).toBeNull()
  })

  /** 缩图之后一个图像像素不足一个屏幕像素的方向上，宽高不能塌成 0。 */
  test('极小的矩形至少有一个像素', () => {
    const 放大 = { ...原样, imageWidth: 1012, imageHeight: 906 }
    const out = imageRectToScreen(放大, { x: 0, y: 0, width: 1, height: 1 })
    expect(out).not.toBeNull()
    expect(out?.width).toBeGreaterThanOrEqual(1)
    expect(out?.height).toBeGreaterThanOrEqual(1)
  })
})

/** 动作族换形状是一次不兼容改动，版本号必须跟着走。 */
test('协议版本随动作族一起推进', () => {
  expect(DESKTOP_PROTOCOL_VERSION).toBe(4)
})
