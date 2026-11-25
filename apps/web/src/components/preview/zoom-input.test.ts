/**
 * 覆盖 `zoom-input.ts` 的双指捏合：两指距离之比为缩放倍数，锚点为两指中点；`gestures` 为假时不处理。
 * 原始失败形状：手机上图片与代码预览不能双指缩放（只有 Ctrl+滚轮与快捷键），PDF 与 Office 预览可以。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

/** 带指定触点的触摸事件：happy-dom 的 TouchEvent 构造参数不接受触点坐标。 */
function touchEvent(type: string, points: [number, number][]): Event {
  const ev = new Event(type, { cancelable: true })
  Object.defineProperty(ev, 'touches', {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  })
  return ev
}

async function bind(gestures: boolean) {
  const { bindZoomInputs } = await import('./zoom-input.ts')
  const target = document.createElement('div')
  document.body.append(target)
  const calls: [number, { clientX: number; clientY: number } | undefined][] = []
  const unbind = bindZoomInputs(
    target,
    { ready: () => true, zoomBy: (factor, at) => calls.push([factor, at]), reset: () => {} },
    { gestures },
  )
  return { target, calls, unbind }
}

test('双指张开到两倍距离时放大两倍，以两指中点为锚点；逐次移动按与上一次之比缩放', async () => {
  const { target, calls, unbind } = await bind(true)
  target.dispatchEvent(
    touchEvent('touchstart', [
      [0, 0],
      [100, 0],
    ]),
  )
  const move = touchEvent('touchmove', [
    [0, 0],
    [200, 0],
  ])
  target.dispatchEvent(move)
  target.dispatchEvent(
    touchEvent('touchmove', [
      [0, 0],
      [100, 0],
    ]),
  )
  target.dispatchEvent(touchEvent('touchend', [[0, 0]]))
  target.dispatchEvent(
    touchEvent('touchmove', [
      [0, 0],
      [300, 0],
    ]),
  )
  expect(calls).toEqual([
    [2, { clientX: 100, clientY: 0 }],
    [0.5, { clientX: 50, clientY: 0 }],
  ])
  expect(move.defaultPrevented).toBe(true)
  unbind()
  target.remove()
})

test('gestures 为假时不处理捏合（Office 的滚动容器自行处理）', async () => {
  const { target, calls, unbind } = await bind(false)
  target.dispatchEvent(
    touchEvent('touchstart', [
      [0, 0],
      [100, 0],
    ]),
  )
  target.dispatchEvent(
    touchEvent('touchmove', [
      [0, 0],
      [200, 0],
    ]),
  )
  expect(calls).toEqual([])
  unbind()
  target.remove()
})
