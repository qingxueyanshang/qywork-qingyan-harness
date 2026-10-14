/** 覆盖菜单的边缘定位、移动跟随、尺寸约束与卸载清理。 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createComponent } from 'solid-js'
import { render } from 'solid-js/web'
import { AnchoredMenu, placeMenu } from './AnchoredMenu.tsx'

const view = { width: 1000, height: 800 }
const box = { width: 300, height: 200 }
const at = (top: number, left: number) => ({ top, bottom: top + 30, left, right: left + 100 })

describe('菜单定位', () => {
  test('above-start：上方、左边缘对齐按钮', () => {
    expect(placeMenu(at(500, 100), box, view, 'above-start')).toEqual({ top: 296, left: 100 })
  })

  test('above-start：上方空间不足时改为下方；超出窗口右边缘时向内收回', () => {
    expect(placeMenu(at(150, 100), box, view, 'above-start')).toEqual({ top: 184, left: 100 })
    expect(placeMenu(at(500, 900), box, view, 'above-start')).toEqual({ top: 296, left: 692 })
  })

  test('below-start：左上角位于锚点处；下方空间不足时改为上方，超出窗口右边缘时向内收回', () => {
    const point = (top: number, left: number) => ({ top, bottom: top, left, right: left })
    expect(placeMenu(point(300, 400), box, view, 'below-start')).toEqual({ top: 304, left: 400 })
    expect(placeMenu(point(700, 400), box, view, 'below-start')).toEqual({ top: 496, left: 400 })
    expect(placeMenu(point(300, 900), box, view, 'below-start')).toEqual({ top: 304, left: 692 })
  })

  test('below-end：下方、右边缘对齐按钮；下方空间不足时改为上方；超出窗口左边缘时向内收回', () => {
    expect(placeMenu(at(100, 500), box, view, 'below-end')).toEqual({ top: 134, left: 300 })
    expect(placeMenu(at(700, 500), box, view, 'below-end')).toEqual({ top: 496, left: 300 })
    expect(placeMenu(at(100, 100), box, view, 'below-end')).toEqual({ top: 134, left: 8 })
  })
})

describe('展开期间跟随锚点', () => {
  beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
  afterAll(() => GlobalRegistrator.unregister())
  const frames = new Map<number, FrameRequestCallback>()
  const restore: (() => void)[] = []
  let dispose: (() => void) | undefined
  afterEach(() => {
    dispose?.()
    dispose = undefined
    for (const undo of restore.splice(0)) undo()
    frames.clear()
    document.body.replaceChildren()
  })
  const nextFrame = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  }
  const mount = (matchWidth = false) => {
    let frameId = 0
    const request = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++frameId, callback)
      return frameId
    })
    const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const anchor = document.createElement('button')
    const host = document.createElement('div')
    document.body.append(anchor, host)
    const rect = { x: 100, y: 500, width: 100, height: 30 }
    const content = { height: 200 }
    const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        return this === anchor
          ? new DOMRect(rect.x, rect.y, rect.width, rect.height)
          : new DOMRect(
              0,
              0,
              Number.parseFloat(this.style.width) || 300,
              Number.parseFloat(this.style.height) || content.height,
            )
      },
    )
    restore.push(
      () => request.mockRestore(),
      () => cancel.mockRestore(),
      () => bounds.mockRestore(),
    )
    dispose = render(
      () =>
        createComponent(AnchoredMenu, {
          class: 'test-menu',
          anchor,
          placement: 'above-start',
          lockHeight: true,
          matchWidth,
          children: '选项',
        }),
      host,
    )
    return { menu: host.firstElementChild as HTMLDivElement, rect, content }
  }

  test('平移后保持锚点间距与初始高度，窗口边缘仍收回，卸载后停止跟随', () => {
    const { menu, rect, content } = mount()
    expect(menu.style.top).toBe('296px')
    expect(menu.style.left).toBe('100px')
    expect(menu.style.height).toBe('200px')
    rect.x += 120
    rect.y -= 50
    content.height = 320
    nextFrame()
    expect(menu.style.top).toBe('246px')
    expect(menu.style.left).toBe('220px')
    expect(menu.style.height).toBe('200px')
    rect.x = window.innerWidth - 20
    nextFrame()
    expect(menu.style.left).toBe(`${window.innerWidth - 308}px`)
    expect(frames.size).toBe(1)
    dispose!()
    dispose = undefined
    expect(frames.size).toBe(0)
  })

  test('锚点缩放后同步更新等宽菜单的位置与宽度', () => {
    const { menu, rect } = mount(true)
    expect(menu.style.width).toBe('100px')
    rect.x = 160
    rect.width = 240
    nextFrame()
    expect(menu.style.left).toBe('160px')
    expect(menu.style.width).toBe('240px')
    rect.width = window.innerWidth + 100
    nextFrame()
    expect(menu.style.left).toBe('8px')
    expect(menu.style.width).toBe(`${window.innerWidth - 16}px`)
  })
})
