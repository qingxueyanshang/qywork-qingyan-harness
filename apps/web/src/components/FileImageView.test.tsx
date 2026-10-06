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

afterEach(async () => {
  dispose?.()
  document.body.replaceChildren()
  // 缩放模式与阅读位置在挂载之间保留（刷新恢复），每条用例从未记录的状态开始。
  const { flushSession } = await import('../lib/session.ts')
  flushSession()
  sessionStorage.clear()
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

/** 原始失败形状：整页刷新后图片回到「适应窗口」与顶部。刷新以 `flushSession` 后重新挂载模拟。 */
test('刷新后同一张图片恢复缩放模式与阅读位置', async () => {
  const { flushSession } = await import('../lib/session.ts')
  const first = await mount()
  first.load(1000, 10000)
  first.button('适应宽度').click()
  const before = first.host.querySelector<HTMLElement>('.image-preview-viewport')!
  before.scrollTop = 3000
  before.dispatchEvent(new Event('scroll'))
  dispose?.()
  document.body.replaceChildren()
  flushSession()

  const second = await mount()
  expect(second.button('适应宽度').getAttribute('aria-pressed')).toBe('true')
  second.load(1000, 10000)
  await new Promise((resolve) => requestAnimationFrame(resolve))
  expect(second.host.querySelector<HTMLElement>('.image-preview-viewport')!.scrollTop).toBe(3000)
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
