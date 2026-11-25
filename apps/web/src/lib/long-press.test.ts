/**
 * 覆盖 `long-press.ts`：触屏单指按住达到时长时触发，移动、松开、第二根手指或鼠标不触发；触发后本次按压的 click 与
 * contextmenu 不交给元素。原始失败形状：手机上文件树的重命名、删除与画布节点的右键菜单只能经右键打开，触屏没有入口。
 */

import { afterAll, beforeAll, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function pointer(el: Element, type: string, x: number, y: number, extra: PointerEventInit = {}) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'touch',
      ...extra,
    }),
  )
}

async function setup() {
  const { attachLongPress } = await import('./long-press.ts')
  const el = document.createElement('button')
  document.body.append(el)
  const presses: [number, number][] = []
  const clicks: string[] = []
  attachLongPress(el, (x, y) => presses.push([x, y]))
  el.addEventListener('click', () => clicks.push('click'))
  el.addEventListener('contextmenu', () => clicks.push('contextmenu'))
  return { el, presses, clicks }
}

test('按住不动达到时长时在按下处触发；松开后的 click 与本次的 contextmenu 不交给元素，下一次轻点照常', async () => {
  const { el, presses, clicks } = await setup()
  jest.useFakeTimers()
  try {
    pointer(el, 'pointerdown', 40, 60)
    pointer(el, 'pointermove', 43, 62)
    jest.advanceTimersByTime(499)
    expect(presses).toEqual([])
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    jest.advanceTimersByTime(1)
    expect(presses).toEqual([[40, 60]])
    pointer(el, 'pointerup', 43, 62)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).toEqual([])

    pointer(el, 'pointerdown', 40, 60)
    pointer(el, 'pointerup', 40, 60)
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicks).toEqual(['click'])
  } finally {
    jest.useRealTimers()
    el.remove()
  }
})

test('移动超过容差、提前松开、第二根手指按下或鼠标按下时不触发', async () => {
  const { el, presses } = await setup()
  jest.useFakeTimers()
  try {
    pointer(el, 'pointerdown', 40, 60)
    pointer(el, 'pointermove', 50, 60)
    jest.advanceTimersByTime(600)

    pointer(el, 'pointerdown', 40, 60)
    pointer(el, 'pointerup', 40, 60)
    jest.advanceTimersByTime(600)

    pointer(el, 'pointerdown', 40, 60)
    pointer(el, 'pointerdown', 90, 60, { pointerId: 2 })
    jest.advanceTimersByTime(600)

    pointer(el, 'pointerup', 90, 60, { pointerId: 2 })
    pointer(el, 'pointerdown', 40, 60, { pointerType: 'mouse', pointerId: 3 })
    jest.advanceTimersByTime(600)
    expect(presses).toEqual([])
  } finally {
    jest.useRealTimers()
    el.remove()
  }
})
