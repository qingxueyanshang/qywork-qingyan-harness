/** 覆盖图片预览的刷新位置、资源切换与加载失败恢复；实际布局由浏览器检查。 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

let dispose: (() => void) | undefined
let measure: (width: number, height: number) => void
let originalObserver: typeof ResizeObserver

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  originalObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      measure = (width, height) => {
        callback(
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        )
      }
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
})

afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})

afterAll(async () => {
  globalThis.ResizeObserver = originalObserver
  await GlobalRegistrator.unregister()
})

async function mount() {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { default: FileImageView } = await import('./FileImageView.tsx')
  const [preview, setPreview] = createSignal({ src: '/long.png' })
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <FileImageView src={preview().src} alt="图片" />, host)
  measure(800, 600)
  const image = host.querySelector('img')!
  const load = (width: number, height: number) => {
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: width },
      naturalHeight: { configurable: true, value: height },
    })
    image.dispatchEvent(new Event('load'))
  }
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent === label)!
  return { host, setPreview, image, load, button }
}

test('同一资源的预览结果刷新时保留缩放与长图阅读位置，仅在切换图片时重置', async () => {
  const { host, setPreview, image, load, button } = await mount()
  load(1000, 10000)
  button('适应宽度').click()
  const viewport = host.querySelector<HTMLElement>('.image-preview-viewport')!
  viewport.scrollTop = 3000
  const width = image.style.width
  setPreview({ src: '/long.png' })
  expect(button('适应宽度').getAttribute('aria-pressed')).toBe('true')
  expect(image.style.width).toBe(width)
  expect(viewport.scrollTop).toBe(3000)

  setPreview({ src: '/portrait.png' })
  expect(button('适应窗口').getAttribute('aria-pressed')).toBe('true')
  expect(viewport.scrollTop).toBe(0)
  expect(host.querySelector('fieldset')!.disabled).toBe(true)
  load(1080, 1920)
  expect(host.querySelector('fieldset')!.disabled).toBe(false)
  expect(image.style.visibility).toBe('visible')
})

test('加载失败时显示错误并禁用缩放，切换到有效图片后恢复', async () => {
  const { host, setPreview, image, load } = await mount()
  image.dispatchEvent(new Event('error'))
  expect(host.textContent).toContain('无法加载图片')
  expect(host.querySelector('fieldset')!.disabled).toBe(true)
  setPreview({ src: '/valid.png' })
  load(120, 80)
  expect(host.textContent).not.toContain('无法加载图片')
  expect(host.querySelector('fieldset')!.disabled).toBe(false)
  expect(image.style.width).toBe('120px')
  expect(image.style.height).toBe('80px')
})
